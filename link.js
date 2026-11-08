/* Web Bluetooth link to the Farah board for the Bluefy probe.
 *
 * Owns one connection at a time. Every async step is guarded by a generation number, so a late
 * completion after Disconnect, link loss or page hide can never revive old state. All browser
 * objects (navigator.bluetooth, clock, timers, random source) are injected for the Node tests. */
(function (root, factory) {
  'use strict';
  const P = root.FarahBLE || (typeof require === 'function' ? require('./ble.js') : null);
  const api = factory(P);
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.FarahLink = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (P) {
  'use strict';

  const C = P.C;
  /* After this long without a write completing, the page hints at the iOS pairing prompt. */
  const STALL_HINT_MS = 5000;
  /* Two consecutive write failures stop all automatic sending until the user presses Resend. */
  const MAX_CONSECUTIVE_WRITE_FAILURES = 2;
  /* hello/bat/err arriving while the subscription completes are held, at most this many. */
  const MAX_EARLY_MESSAGES = 4;

  function clean(s, max) {
    return String(s === undefined || s === null ? '' : s).replace(/[^\x20-\x7e]/g, '?').slice(0, max);
  }

  function errInfo(e) {
    return { name: clean(e && e.name ? e.name : 'Error', 40), message: clean(e && e.message, 120) };
  }

  function zeroStats() {
    return {
      framesIn: 0,
      framesDropped: 0,
      messagesIn: 0,
      malformed: 0,
      btnIgnored: 0,
      acksQueued: 0,
      sent: 0,
      syncCoalesced: 0,
      queueDropped: 0,
      writeErrors: 0,
      earlyDropped: 0,
    };
  }

  class BleLink {
    constructor(opts) {
      this.bt = opts.bluetooth || null;
      this.now = opts.now;
      this.timers = opts.timers;
      this.randomFill = opts.randomFill;
      this.onEvent = opts.onEvent || function () {};
      this.gen = 0;
      this.state = 'idle';
      this.device = null;
      this.ctl = null;
      this.evt = null;
      this.writeMode = null;
      this.epoch = 0;
      this.prevEpoch = 0;
      this.n = 0;
      this.msgNo = 0;
      this.queue = [];
      this.sending = false;
      this.halted = false;
      this.failures = 0;
      this.lastSendAt = -Infinity;
      this.heartbeat = null;
      this.stallTimer = null;
      this.att = null; // the current connection attempt (see connect)
      this.gate = null;
      this.stats = zeroStats();
    }

    _emit(type, data) {
      try {
        this.onEvent(type, data || {});
      } catch (_) {
        /* a UI error must not break the link */
      }
    }

    _set(state) {
      this.state = state;
      this._emit('state', { state });
    }

    /* Must be called from a user gesture (Web Bluetooth requires it for requestDevice).
     *
     * Each attempt owns its listeners and its reassembly state (`att`). Only the current attempt
     * (`this.att`) may act; a late completion of an older attempt can release only what that
     * attempt itself attached, even when the browser hands back the same BluetoothDevice object. */
    async connect() {
      if (this.state !== 'idle') return false;
      if (!this.bt || typeof this.bt.requestDevice !== 'function') {
        this._emit('unsupported', { step: 'navigator.bluetooth.requestDevice' });
        return false;
      }
      const gen = ++this.gen;
      const att = { gen, device: null, evt: null, reasm: new P.Reassembler(), early: [] };
      att.onDisconnected = (ev) => this._onGattDisconnected(att, ev);
      att.onValue = (ev) => this._onValue(att, ev);
      this.att = att;
      this._set('requesting');
      let device;
      try {
        device = await this.bt.requestDevice({ filters: [{ services: [C.SERVICE] }] });
      } catch (e) {
        if (gen === this.gen) {
          this.att = null;
          this._set('idle');
          this._emit('error', Object.assign({ step: 'requestDevice' }, errInfo(e)));
        }
        return false;
      }
      if (gen !== this.gen) return false;
      att.device = device;
      this.device = device;
      device.addEventListener('gattserverdisconnected', att.onDisconnected);
      this._set('connecting');
      let step = 'gatt.connect';
      let ctl;
      try {
        const server = await device.gatt.connect();
        if (gen !== this.gen) return this._abandon(att);
        step = 'getPrimaryService';
        const svc = await server.getPrimaryService(C.SERVICE);
        if (gen !== this.gen) return this._abandon(att);
        step = 'getCharacteristic(ctl)';
        ctl = await svc.getCharacteristic(C.CTL);
        if (gen !== this.gen) return this._abandon(att);
        step = 'getCharacteristic(evt)';
        const evt = await svc.getCharacteristic(C.EVT);
        if (gen !== this.gen) return this._abandon(att);
        step = 'startNotifications';
        /* The board sends hello as soon as it sees the subscription, possibly before
         * startNotifications() resolves: receive state is ready before subscribing and is not
         * reset afterwards. */
        att.evt = evt;
        this.evt = evt;
        evt.addEventListener('characteristicvaluechanged', att.onValue);
        await evt.startNotifications();
        if (gen !== this.gen) return this._abandon(att);
      } catch (e) {
        if (gen !== this.gen) return this._abandon(att);
        this._emit('error', Object.assign({ step }, errInfo(e)));
        this.gen += 1;
        this._teardown('connect_failed');
        return false;
      }
      if (typeof ctl.writeValueWithResponse === 'function') {
        this.writeMode = 'writeValueWithResponse';
      } else if (typeof ctl.writeValue === 'function') {
        this.writeMode = 'writeValue';
        this._emit('unsupported', { step: 'characteristic.writeValueWithResponse', fallback: 'writeValue' });
      } else {
        this._emit('unsupported', { step: 'characteristic.writeValueWithResponse' });
        this.gen += 1;
        this._teardown('connect_failed');
        return false;
      }
      this.ctl = ctl;
      this.epoch = P.randomEpoch(this.randomFill, this.prevEpoch);
      this.n = 0;
      this.msgNo = 0;
      this.lastSendAt = -Infinity;
      this.queue = [];
      this.sending = false;
      this.halted = false;
      this.failures = 0;
      this.gate = new P.BtnGate(this.epoch);
      this._set('connected');
      this._emit('connected', { epoch: this.epoch, writeMode: this.writeMode });
      const early = att.early;
      att.early = [];
      for (const m of early) this._emit('device', { msg: m, early: true });
      this.enqueueSync('connect');
      this.heartbeat = this.timers.setInterval(() => this.enqueueSync('heartbeat'), C.HEARTBEAT_MS);
      return true;
    }

    /* An older attempt finished after Disconnect / link loss: release only what it attached, and
     * never disconnect a device object that the current attempt is using. */
    _abandon(att) {
      try {
        if (att.device) att.device.removeEventListener('gattserverdisconnected', att.onDisconnected);
      } catch (_) {
        /* ignore */
      }
      try {
        if (att.evt) att.evt.removeEventListener('characteristicvaluechanged', att.onValue);
      } catch (_) {
        /* ignore */
      }
      const cur = this.att;
      if (att.device && !(cur && cur.device === att.device)) {
        try {
          if (att.device.gatt && att.device.gatt.connected) att.device.gatt.disconnect();
        } catch (_) {
          /* ignore */
        }
      }
      att.early = [];
      this._emit('late', { what: 'connect step finished after cancel; released' });
      return false;
    }

    disconnect(reason) {
      if (this.state === 'idle') return;
      this.gen += 1;
      this._teardown(reason || 'user');
    }

    _onGattDisconnected(att, ev) {
      if (att !== this.att || !ev || ev.target !== att.device) return;
      this.gen += 1;
      this._teardown('link_lost');
    }

    /* Tears down the current attempt only. */
    _teardown(reason) {
      const att = this.att;
      this.att = null;
      if (this.heartbeat !== null) this.timers.clearInterval(this.heartbeat);
      this.heartbeat = null;
      this._disarmStall();
      this.queue = [];
      this.sending = false;
      this.halted = false;
      this.failures = 0;
      this.gate = null;
      if (att) {
        att.early = [];
        att.reasm.clear();
        if (att.evt) {
          try {
            att.evt.removeEventListener('characteristicvaluechanged', att.onValue);
          } catch (_) {
            /* ignore */
          }
        }
        if (att.device) {
          try {
            att.device.removeEventListener('gattserverdisconnected', att.onDisconnected);
          } catch (_) {
            /* ignore */
          }
          try {
            if (att.device.gatt && att.device.gatt.connected) att.device.gatt.disconnect();
          } catch (_) {
            /* ignore */
          }
        }
      }
      this.device = null;
      this.ctl = null;
      this.evt = null;
      this.writeMode = null;
      if (this.epoch) this.prevEpoch = this.epoch;
      this.epoch = 0;
      if (this.state !== 'idle') {
        this._set('idle');
        this._emit('disconnected', { reason });
      }
    }

    /* ---- Sending: bounded queue, one message per 20 ms, write with response, no retry loop ---- */

    enqueueSync(reason) {
      if (this.state !== 'connected' || this.halted) return;
      if (this.queue.some((q) => q.kind === 'sync')) {
        this.stats.syncCoalesced += 1; // a newer sync replaces the queued one (built at send time)
      } else {
        this._push({ kind: 'sync', reason });
      }
      this._pump();
    }

    _push(item) {
      if (this.queue.length >= C.MAX_QUEUE) {
        let i = this.queue.findIndex((q) => q.kind === 'cap');
        if (i < 0) i = this.queue.findIndex((q) => q.kind === 'ack');
        if (i < 0) {
          this.stats.queueDropped += 1;
          this._emit('queueDrop', { kind: item.kind });
          return;
        }
        const [old] = this.queue.splice(i, 1);
        this.stats.queueDropped += 1;
        this._emit('queueDrop', { kind: old.kind });
      }
      this.queue.push(item);
    }

    /* User-initiated only: re-enable sending after repeated write failures. */
    resume() {
      if (this.state !== 'connected' || !this.halted) return;
      this.halted = false;
      this.failures = 0;
      this._emit('resumed', {});
      this.enqueueSync('user_resend');
    }

    _sleep(ms) {
      return new Promise((resolve) => this.timers.setTimeout(resolve, ms));
    }

    async _pump() {
      if (this.sending) return;
      const gen = this.gen;
      this.sending = true;
      try {
        while (gen === this.gen && this.state === 'connected' && !this.halted && this.queue.length) {
          const wait = this.lastSendAt + C.MIN_SEND_INTERVAL_MS - this.now();
          if (wait > 0) {
            await this._sleep(wait);
            continue;
          }
          const item = this.queue.shift();
          this.n = (this.n + 1) >>> 0;
          const obj = item.kind === 'sync'
            ? P.buildSync(this.epoch, this.n)
            : P.buildAck(this.epoch, this.n, item.ref, item.why);
          let frames;
          try {
            frames = P.fragment(P.encodeMessage(obj), this.msgNo, C.MIN_MTU);
          } catch (e) {
            this._emit('error', Object.assign({ step: 'encode ' + obj.t }, errInfo(e))); // dropped, never sent partially
            continue;
          }
          this.msgNo = (this.msgNo + 1) & 0xff;
          this.lastSendAt = this.now();
          const ok = await this._writeFrames(gen, frames, obj);
          if (gen !== this.gen) return;
          if (ok) {
            this.failures = 0;
            this.stats.sent += 1;
            this._emit('sent', { t: obj.t, n: obj.n, ref: obj.ref, why: obj.why, frames: frames.length });
          }
        }
      } finally {
        if (gen === this.gen) this.sending = false;
      }
    }

    _write(frame) {
      return this.writeMode === 'writeValueWithResponse'
        ? this.ctl.writeValueWithResponse(frame)
        : this.ctl.writeValue(frame);
    }

    async _writeFrames(gen, frames, obj) {
      for (let i = 0; i < frames.length; i++) {
        this._armStall(gen, obj);
        try {
          await this._write(frames[i]);
        } catch (e) {
          this._disarmStall();
          if (gen !== this.gen) return false;
          this.stats.writeErrors += 1;
          this.failures += 1;
          this._emit('writeError', Object.assign({ t: obj.t, n: obj.n, fragment: i, consecutive: this.failures }, errInfo(e)));
          if (this.failures >= MAX_CONSECUTIVE_WRITE_FAILURES) {
            this.halted = true;
            this.queue = [];
            this._emit('halted', { failures: this.failures });
          } else if (!this.queue.some((q) => q.kind === 'sync')) {
            // Protocol: a failed message is dropped and a full sync of the current state is re-sent.
            this.queue.unshift({ kind: 'sync', reason: 'after_write_error' });
          }
          return false;
        }
        this._disarmStall();
        if (gen !== this.gen) return false;
      }
      return true;
    }

    _armStall(gen, obj) {
      this._disarmStall();
      this.stallTimer = this.timers.setTimeout(() => {
        this.stallTimer = null;
        if (gen === this.gen) this._emit('writeStalled', { t: obj.t, n: obj.n, afterMs: STALL_HINT_MS });
      }, STALL_HINT_MS);
    }

    _disarmStall() {
      if (this.stallTimer !== null) this.timers.clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }

    /* ---- Receiving ---- */

    _onValue(att, ev) {
      if (att !== this.att) return; // a listener of an older attempt
      if (this.state !== 'connecting' && this.state !== 'connected') return;
      const ch = ev && ev.target;
      if (!ch || ch !== att.evt || !ch.value) return;
      const dv = ch.value;
      const bytes = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
      this.stats.framesIn += 1;
      const before = att.reasm.dropped;
      const message = att.reasm.feed(bytes, this.now());
      if (att.reasm.dropped !== before) {
        this.stats.framesDropped += att.reasm.dropped - before;
        this._emit('frameDrop', { total: this.stats.framesDropped });
      }
      if (!message) return;
      this.stats.messagesIn += 1;
      const r = P.parseDeviceMessage(message);
      if (!r.ok) {
        this.stats.malformed += 1;
        this._emit('malformed', { reason: r.reason });
        return;
      }
      const m = r.msg;
      if (this.state !== 'connected') {
        /* Subscription still completing: no epoch, no gate, nothing may be sent yet. */
        if (m.t === 'btn') {
          this.stats.btnIgnored += 1;
          this._emit('btn', { msg: m, decision: { ack: false, reason: 'not_ready' } });
        } else if (att.early.length < MAX_EARLY_MESSAGES) {
          att.early.push(m); // delivered right after 'connected'
        } else {
          this.stats.earlyDropped += 1;
        }
        return;
      }
      if (m.t === 'btn') {
        const d = this.gate.evaluate(m);
        this._emit('btn', { msg: m, decision: d });
        if (!d.ack) {
          this.stats.btnIgnored += 1;
          return;
        }
        this.stats.acksQueued += 1;
        this._push({ kind: 'ack', ref: d.ref, why: d.why });
        this._pump();
        return;
      }
      this._emit('device', { msg: m });
    }

    snapshot() {
      return {
        state: this.state,
        writeMode: this.writeMode,
        halted: this.halted,
        queued: this.queue.length,
        stats: Object.assign({}, this.stats),
      };
    }
  }

  return { BleLink, STALL_HINT_MS, MAX_CONSECUTIVE_WRITE_FAILURES, MAX_EARLY_MESSAGES };
});
