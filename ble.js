/* Farah Pocket BLE protocol for the Bluefy probe (docs/pocket/PROTOCOL.md section 2).
 *
 * Pure functions only: no DOM, no Bluetooth, no timers. Loaded as a classic script in the page
 * (window.FarahBLE) and with require() by the Node tests. Mirrors pocket/protocol/ble_frame.py,
 * whose golden vectors (pocket/protocol/ble_vectors.json) the tests replay. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.FarahBLE = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const C = Object.freeze({
    VERSION: 1,
    SERVICE: '6a4e0001-6f0b-4b8e-9c55-3b1a2d6f0a01',
    CTL: '6a4e0002-6f0b-4b8e-9c55-3b1a2d6f0a01',
    EVT: '6a4e0003-6f0b-4b8e-9c55-3b1a2d6f0a01',
    LOCAL_NAME: 'Farah',
    HEADER: 4,
    ATT_OVERHEAD: 3,
    MIN_MTU: 23,
    MAX_FRAGMENTS: 32,
    MAX_MESSAGE: 512,
    REASSEMBLY_TIMEOUT_MS: 2000,
    MIN_SEND_INTERVAL_MS: 20,
    MAX_QUEUE: 8,
    MAX_CAPTION_CHARS: 120,
    MAX_CAPTION_BYTES: 160,
    MAX_ERR_CODE_CHARS: 24,
    BTN_ACK_TIMEOUT_MS: 3000,
    HEARTBEAT_MS: 5000,
    SYNC_STALE_MS: 15000,
  });

  /* What this probe truthfully reports: no Farah backend, no voice session, and no verified
   * private headset route (the page cannot verify audio routing). */
  const PROBE_STATE = 'idle';
  const PROBE_CAPTION = 'Bluefy connection test';
  const PROBE_ACK_WHY = 'offline';
  const ELLIPSIS = '\u2026';

  const encoder = new TextEncoder();

  function utf8(s) {
    return encoder.encode(s);
  }

  function isU32(x) {
    return Number.isInteger(x) && x >= 0 && x <= 0xffffffff;
  }

  function chunkSize(mtu) {
    if (!Number.isInteger(mtu) || mtu < C.MIN_MTU) throw new Error('mtu_below_minimum');
    return mtu - C.ATT_OVERHEAD - C.HEADER;
  }

  /* Split one serialized message into ATT values. Throws on oversize input. */
  function fragment(message, msgNo, mtu) {
    if (!(message instanceof Uint8Array) || message.length === 0 || message.length > C.MAX_MESSAGE) {
      throw new Error('message_size');
    }
    if (!Number.isInteger(msgNo) || msgNo < 0 || msgNo > 255) throw new Error('msg_no');
    const size = chunkSize(mtu === undefined ? C.MIN_MTU : mtu);
    const count = Math.ceil(message.length / size);
    if (count > C.MAX_FRAGMENTS) throw new Error('too_many_fragments');
    const frames = [];
    for (let i = 0; i < count; i++) {
      const chunk = message.subarray(i * size, Math.min(message.length, (i + 1) * size));
      const frame = new Uint8Array(C.HEADER + chunk.length);
      frame[0] = C.VERSION;
      frame[1] = msgNo;
      frame[2] = i;
      frame[3] = count;
      frame.set(chunk, C.HEADER);
      frames.push(frame);
    }
    return frames;
  }

  /* At most one partial message; any irregularity discards the whole partial message.
   * feed(value, nowMs) returns a complete message (Uint8Array) or null. */
  class Reassembler {
    constructor(timeoutMs) {
      this.timeoutMs = timeoutMs === undefined ? C.REASSEMBLY_TIMEOUT_MS : timeoutMs;
      this.dropped = 0;
      this._reset();
    }

    _reset() {
      this._msgNo = null;
      this._count = 0;
      this._next = 0;
      this._parts = [];
      this._size = 0;
      this._last = 0;
    }

    _drop() {
      if (this._msgNo !== null) this.dropped += 1;
      this._reset();
    }

    get partial() {
      return this._msgNo !== null;
    }

    clear() {
      this._reset();
    }

    feed(value, nowMs) {
      if (this._msgNo !== null && nowMs - this._last > this.timeoutMs) this._drop();
      if (!(value instanceof Uint8Array) || value.length < C.HEADER + 1) {
        this._drop();
        this.dropped += 1;
        return null;
      }
      const version = value[0];
      const msgNo = value[1];
      const index = value[2];
      const count = value[3];
      if (version !== C.VERSION || count < 1 || count > C.MAX_FRAGMENTS || index >= count) {
        this._drop();
        this.dropped += 1;
        return null;
      }
      if (index === 0) {
        if (this._msgNo !== null) this._drop();
        this._msgNo = msgNo;
        this._count = count;
        this._next = 0;
      } else if (msgNo !== this._msgNo || count !== this._count || index !== this._next) {
        this._drop();
        this.dropped += 1;
        return null;
      }
      const chunk = value.slice(C.HEADER);
      this._parts.push(chunk);
      this._size += chunk.length;
      this._next += 1;
      this._last = nowMs;
      if (this._size > C.MAX_MESSAGE) {
        this._drop();
        return null;
      }
      if (this._next < this._count) return null;
      const out = new Uint8Array(this._size);
      let off = 0;
      for (const p of this._parts) {
        out.set(p, off);
        off += p.length;
      }
      this._reset();
      return out;
    }
  }

  /* ---- Captions (same rules as ble_frame.caption) ---- */

  const JOINERS = new Set(['\u200d', '\ufe0e', '\ufe0f']);
  const CONTROL = /^[\p{Cc}\p{Cf}]$/u;
  /* Python uses unicodedata.combining() (canonical combining class > 0); nonspacing marks are
   * the closest regex class available in JavaScript. */
  const COMBINING = /^\p{Mn}$/u;

  function cpLen(s) {
    return Array.from(s).length;
  }

  function isRegional(cp) {
    return cp >= 0x1f1e6 && cp <= 0x1f1ff;
  }

  function cutOk(cps, i) {
    if (i <= 0 || i >= cps.length) return true;
    const nxt = cps[i];
    const prev = cps[i - 1];
    if (COMBINING.test(nxt) || JOINERS.has(nxt) || prev === '\u200d') return false;
    const n = nxt.codePointAt(0);
    if ((n >= 0xe0020 && n <= 0xe007f) || (n >= 0x1f3fb && n <= 0x1f3ff)) return false;
    if (isRegional(n) && isRegional(prev.codePointAt(0))) {
      let run = 0;
      let j = i - 1;
      while (j >= 0 && isRegional(cps[j].codePointAt(0))) {
        run += 1;
        j -= 1;
      }
      return run % 2 === 0;
    }
    return true;
  }

  function caption(text, maxChars, maxBytes) {
    const mc = maxChars === undefined ? C.MAX_CAPTION_CHARS : maxChars;
    const mb = maxBytes === undefined ? C.MAX_CAPTION_BYTES : maxBytes;
    let clean = '';
    for (const ch of String(text)) clean += CONTROL.test(ch) && !JOINERS.has(ch) ? ' ' : ch;
    clean = clean.replace(/\s+/gu, ' ').trim();
    const fits = (s) => cpLen(s) <= mc && utf8(s).length <= mb;
    if (fits(clean)) return clean;
    const cps = Array.from(clean);
    const head = (i) => cps.slice(0, i).join('').trimEnd();
    let i = Math.min(cps.length, mc - 1);
    while (i > 0 && (!fits(head(i) + ELLIPSIS) || !cutOk(cps, i))) i -= 1;
    return head(i) + ELLIPSIS;
  }

  /* Compact JSON; a sync `cap` or cap `txt` is shortened until the message fits 512 bytes. */
  function encodeMessage(obj) {
    const o = Object.assign({}, obj);
    const key = 'cap' in o ? 'cap' : o.t === 'cap' ? 'txt' : null;
    if (key) o[key] = caption(o[key]);
    for (;;) {
      const data = utf8(JSON.stringify(o));
      if (data.length <= C.MAX_MESSAGE) return data;
      if (!key || !o[key]) throw new Error('message_size');
      o[key] = caption(o[key], Math.max(1, cpLen(o[key]) - 8));
    }
  }

  /* ---- Epochs ---- */

  /* Random non-zero uint32, different from `avoid`. randomFill(Uint32Array) defaults to
   * crypto.getRandomValues. */
  function randomEpoch(randomFill, avoid) {
    const fill = randomFill || ((a) => globalThis.crypto.getRandomValues(a));
    const a = new Uint32Array(1);
    for (let tries = 0; tries < 64; tries++) {
      fill(a);
      const e = a[0] >>> 0;
      if (e !== 0 && e !== avoid) return e;
    }
    throw new Error('random_source_unusable');
  }

  /* Serial uint32 comparison the device applies to sync epochs. */
  function epochIsNewer(e, cur) {
    const d = (e - cur) >>> 0;
    return d >= 1 && d <= 0x7fffffff;
  }

  /* ---- Phone to device messages built by the probe ---- */

  function buildSync(e, n) {
    return {
      t: 'sync',
      e,
      n,
      s: PROBE_STATE,
      conn: { farah: false, session: false, headset: false },
      cap: PROBE_CAPTION,
    };
  }

  function buildAck(e, n, ref, why) {
    return { t: 'ack', e, n, ref, ok: false, why };
  }

  /* ---- Device to phone messages: strict parse into sanitized copies ---- */

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const ERR_CODE = /^[A-Za-z0-9_.:-]+$/;
  const MAX_FW_CHARS = 32;

  function printableAscii(s, max) {
    return s.replace(/[^\x20-\x7e]/g, '?').slice(0, max);
  }

  function isObject(x) {
    return x !== null && typeof x === 'object' && !Array.isArray(x);
  }

  /* Returns {ok: true, msg} holding only known, validated fields, or {ok: false, reason}. */
  function parseDeviceMessage(bytes) {
    let obj;
    try {
      obj = JSON.parse(decoder.decode(bytes));
    } catch (_) {
      return { ok: false, reason: 'bad_json' };
    }
    if (!isObject(obj) || typeof obj.t !== 'string') return { ok: false, reason: 'bad_envelope' };
    if (!isU32(obj.n)) return { ok: false, reason: 'bad_n' };
    const n = obj.n;
    switch (obj.t) {
      case 'hello': {
        if (typeof obj.fw !== 'string' || !Number.isInteger(obj.proto)) {
          return { ok: false, reason: 'bad_hello' };
        }
        return { ok: true, msg: { t: 'hello', n, fw: printableAscii(obj.fw, MAX_FW_CHARS), proto: obj.proto } };
      }
      case 'btn': {
        if (!isU32(obj.e)) return { ok: false, reason: 'bad_btn' };
        if (obj.a !== 'talk' && obj.a !== 'stop') return { ok: false, reason: 'bad_btn' };
        return { ok: true, msg: { t: 'btn', e: obj.e, n, a: obj.a } };
      }
      case 'bat': {
        const msg = { t: 'bat', n };
        if ('pct' in obj) {
          if (!Number.isInteger(obj.pct) || obj.pct < 0 || obj.pct > 100) return { ok: false, reason: 'bad_bat' };
          msg.pct = obj.pct;
        }
        if ('mv' in obj) {
          if (!Number.isInteger(obj.mv) || obj.mv < 0 || obj.mv > 20000) return { ok: false, reason: 'bad_bat' };
          msg.mv = obj.mv;
        }
        for (const k of ['chg', 'usb']) {
          if (k in obj) {
            if (typeof obj[k] !== 'boolean') return { ok: false, reason: 'bad_bat' };
            msg[k] = obj[k];
          }
        }
        return { ok: true, msg };
      }
      case 'err': {
        const c = obj.c;
        if (typeof c !== 'string' || c.length < 1 || c.length > C.MAX_ERR_CODE_CHARS || !ERR_CODE.test(c)) {
          return { ok: false, reason: 'bad_err' };
        }
        return { ok: true, msg: { t: 'err', n, c } };
      }
      default:
        return { ok: false, reason: 'unknown_type' };
    }
  }

  /* Phone-side btn rule: current epoch only, strictly increasing n. Every btn of the current
   * epoch is acked and none is accepted (the probe never has a backend session). A btn of
   * another epoch is dropped without an ack. */
  class BtnGate {
    constructor(epoch) {
      this.epoch = epoch;
      this.lastN = null;
    }

    evaluate(btn) {
      if (btn.e !== this.epoch) return { ack: false, reason: 'other_epoch' };
      if (this.lastN !== null && btn.n <= this.lastN) {
        return { ack: true, ok: false, why: 'stale', ref: btn.n, reason: 'not_increasing' };
      }
      this.lastN = btn.n;
      return { ack: true, ok: false, why: PROBE_ACK_WHY, ref: btn.n, reason: 'no_backend_session' };
    }
  }

  function hex(bytes) {
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function fromHex(s) {
    const out = new Uint8Array(s.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
    return out;
  }

  return {
    C,
    PROBE_STATE,
    PROBE_CAPTION,
    PROBE_ACK_WHY,
    isU32,
    chunkSize,
    fragment,
    Reassembler,
    caption,
    encodeMessage,
    randomEpoch,
    epochIsNewer,
    buildSync,
    buildAck,
    parseDeviceMessage,
    BtnGate,
    hex,
    fromHex,
  };
});
