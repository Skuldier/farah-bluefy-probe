/* Audio coexistence probe: quiet tone, capped recording, local playback.
 *
 * Nothing starts automatically. Audio never leaves the page: the clip lives in memory only (no
 * upload, storage or logging) until Clear or cleanup. A generation number guards every async
 * completion, so a permission prompt that resolves after Stop or page hide releases the stream at
 * once instead of starting capture. Browser APIs are injected for the Node tests. */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.FarahAudio = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const RECORD_CAP_MS = 5000;
  const TONE_MS = 1500;
  const TONE_HZ = 440;
  const TONE_GAIN = 0.05;
  const FINALIZE_TIMEOUT_MS = 2000;
  const PLAYBACK_CAP_MS = RECORD_CAP_MS + 3000;

  function clean(s, max) {
    return String(s === undefined || s === null ? '' : s).replace(/[^\x20-\x7e]/g, '?').slice(0, max);
  }

  function errInfo(e) {
    return { name: clean(e && e.name ? e.name : 'Error', 40), message: clean(e && e.message, 120) };
  }

  function stopTracks(stream) {
    if (!stream || typeof stream.getTracks !== 'function') return 0;
    let n = 0;
    for (const t of stream.getTracks()) {
      try {
        t.stop();
        n += 1;
      } catch (_) {
        /* ignore */
      }
    }
    return n;
  }

  class AudioProbe {
    constructor(opts) {
      this.md = opts.mediaDevices || null;
      this.Recorder = opts.MediaRecorder || null;
      this.AudioCtx = opts.AudioContext || null;
      this.createAudio = opts.createAudio || null;
      this.URL = opts.URL || null;
      this.timers = opts.timers;
      this.now = opts.now;
      this.onEvent = opts.onEvent || function () {};
      this.recordCapMs = opts.recordCapMs || RECORD_CAP_MS;
      this.gen = 0;
      this.state = 'idle';
      this.stream = null;
      this.recorder = null;
      this.recToken = null;
      this.recStart = 0;
      this.capTimer = null;
      this.finalizeTimer = null;
      this.ctx = null;
      this.osc = null;
      this.toneTimer = null;
      this.audio = null;
      this.playToken = null;
      this.playTimer = null;
      this.clip = null;
      this.clipUrl = null;
    }

    _emit(type, data) {
      try {
        this.onEvent(type, data || {});
      } catch (_) {
        /* a UI error must not break cleanup */
      }
    }

    _set(state) {
      this.state = state;
      this._emit('state', { state });
    }

    _busy(action) {
      this._emit('refused', { action, state: this.state });
      return false;
    }

    capabilities() {
      const R = this.Recorder;
      const types = {};
      for (const t of ['audio/mp4', 'audio/webm', 'audio/aac']) {
        try {
          types[t] = !!(R && typeof R.isTypeSupported === 'function' && R.isTypeSupported(t));
        } catch (_) {
          types[t] = false;
        }
      }
      return {
        getUserMedia: !!(this.md && typeof this.md.getUserMedia === 'function'),
        MediaRecorder: !!R,
        AudioContext: !!this.AudioCtx,
        audioElement: !!this.createAudio,
        objectURL: !!(this.URL && typeof this.URL.createObjectURL === 'function'),
        recorderTypes: types,
      };
    }

    /* ---- Quiet test tone (WebAudio) ---- */

    playTone() {
      if (this.state !== 'idle') return this._busy('tone');
      if (!this.AudioCtx) {
        this._emit('unsupported', { step: 'AudioContext' });
        return false;
      }
      const gen = ++this.gen;
      let ctx = null;
      try {
        ctx = new this.AudioCtx();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = TONE_HZ;
        gain.gain.value = TONE_GAIN;
        osc.connect(gain);
        gain.connect(ctx.destination);
        this.ctx = ctx;
        this.osc = osc;
        osc.start();
        if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
          const p = ctx.resume(); // called inside the click so iOS allows it
          if (p && typeof p.catch === 'function') {
            p.catch((e) => {
              if (gen !== this.gen) return;
              this._emit('error', Object.assign({ step: 'AudioContext.resume' }, errInfo(e)));
              this._stopTone('error');
            });
          }
        }
      } catch (e) {
        this.osc = null;
        this.ctx = null;
        this._closeCtx(ctx);
        this._emit('error', Object.assign({ step: 'WebAudio tone setup' }, errInfo(e)));
        return false;
      }
      this._set('tone');
      this._emit('toneStarted', { hz: TONE_HZ, gain: TONE_GAIN, ms: TONE_MS });
      this.toneTimer = this.timers.setTimeout(() => {
        this.toneTimer = null;
        if (gen === this.gen && this.state === 'tone') this._stopTone('done');
      }, TONE_MS);
      return true;
    }

    _closeCtx(ctx) {
      if (!ctx || typeof ctx.close !== 'function') return;
      try {
        const p = ctx.close();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_) {
        /* ignore */
      }
    }

    _stopTone(reason) {
      if (this.toneTimer !== null) this.timers.clearTimeout(this.toneTimer);
      this.toneTimer = null;
      const osc = this.osc;
      const ctx = this.ctx;
      this.osc = null;
      this.ctx = null;
      if (osc) {
        try {
          osc.stop();
        } catch (_) {
          /* already stopped */
        }
      }
      this._closeCtx(ctx);
      if (this.state === 'tone') this._set('idle');
      if (osc || ctx) this._emit('toneStopped', { reason });
    }

    /* ---- Recording: hard cap, Stop keeps the clip, cleanup discards it ---- */

    async record() {
      if (this.state !== 'idle') return this._busy('record');
      if (!this.md || typeof this.md.getUserMedia !== 'function') {
        this._emit('unsupported', { step: 'navigator.mediaDevices.getUserMedia' });
        return false;
      }
      if (!this.Recorder) {
        this._emit('unsupported', { step: 'MediaRecorder' });
        return false;
      }
      this._dropClip(); // a new recording replaces the previous clip
      const gen = ++this.gen;
      this._set('requesting');
      let stream;
      try {
        stream = await this.md.getUserMedia({ audio: true, video: false });
      } catch (e) {
        if (gen === this.gen) {
          this._set('idle');
          this._emit('error', Object.assign({ step: 'getUserMedia' }, errInfo(e)));
        }
        return false;
      }
      if (gen !== this.gen) {
        const n = stopTracks(stream);
        this._emit('late', { what: 'microphone permission resolved after cancel; stream released', tracksStopped: n });
        return false;
      }
      this.stream = stream;
      let rec;
      try {
        rec = new this.Recorder(stream);
      } catch (e) {
        this._releaseStream();
        this._set('idle');
        this._emit('error', Object.assign({ step: 'new MediaRecorder' }, errInfo(e)));
        return false;
      }
      const token = { gen, chunks: [] };
      this.recToken = token;
      this.recorder = rec;
      rec.ondataavailable = (ev) => {
        if (this.recToken === token && ev && ev.data && ev.data.size > 0) token.chunks.push(ev.data);
      };
      rec.onstop = () => this._onRecorderStop(token, rec);
      rec.onerror = (ev) => {
        if (this.recToken !== token) return;
        this._emit('error', Object.assign({ step: 'MediaRecorder' }, errInfo(ev && ev.error)));
        if (this.state === 'recording') this._finishRecording('recorder_error');
      };
      try {
        rec.start();
      } catch (e) {
        this.recToken = null;
        this.recorder = null;
        this._releaseStream();
        this._set('idle');
        this._emit('error', Object.assign({ step: 'MediaRecorder.start' }, errInfo(e)));
        return false;
      }
      this.recStart = this.now();
      this._set('recording');
      this._emit('recordStarted', { capMs: this.recordCapMs, mimeType: clean(rec.mimeType, 40) });
      this.capTimer = this.timers.setTimeout(() => {
        this.capTimer = null;
        if (this.recToken === token && this.state === 'recording') this._finishRecording('cap');
      }, this.recordCapMs);
      return true;
    }

    _finishRecording(reason) {
      const rec = this.recorder;
      const token = this.recToken;
      if (this.capTimer !== null) this.timers.clearTimeout(this.capTimer);
      this.capTimer = null;
      this._set('finalizing');
      try {
        if (rec && rec.state !== 'inactive') rec.stop();
      } catch (_) {
        /* the stop event or the finalize timeout settles the state */
      }
      const n = this._releaseStream();
      this._emit('recordStopping', { reason, tracksStopped: n });
      this.finalizeTimer = this.timers.setTimeout(() => {
        this.finalizeTimer = null;
        if (this.recToken !== token || this.state !== 'finalizing') return;
        this.recToken = null;
        this.recorder = null;
        this._set('idle');
        this._emit('error', { step: 'MediaRecorder stop event', name: 'Timeout', message: 'no stop event within 2 s' });
      }, FINALIZE_TIMEOUT_MS);
    }

    _onRecorderStop(token, rec) {
      if (this.recToken !== token) return; // discarded by cleanup or Clear
      if (this.finalizeTimer !== null) this.timers.clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
      if (this.capTimer !== null) this.timers.clearTimeout(this.capTimer);
      this.capTimer = null;
      const unexpected = this.state === 'recording';
      this.recToken = null;
      this.recorder = null;
      const n = this._releaseStream();
      if (unexpected) this._emit('recordStopping', { reason: 'recorder_stopped_itself', tracksStopped: n });
      const first = token.chunks[0];
      const mime = clean(rec.mimeType || (first && first.type) || '', 40);
      if (!token.chunks.length) {
        this._set('idle');
        this._emit('error', { step: 'MediaRecorder data', name: 'NoData', message: 'recording produced no data' });
        return;
      }
      const blob = new Blob(token.chunks, mime ? { type: mime } : undefined);
      this.clip = { blob, mime, bytes: blob.size, ms: Math.max(0, this.now() - this.recStart) };
      this._set('idle');
      this._emit('clipReady', { mime, bytes: blob.size, ms: this.clip.ms });
    }

    _releaseStream() {
      const n = stopTracks(this.stream);
      this.stream = null;
      return n;
    }

    /* ---- Playback of the in-memory clip ---- */

    play() {
      if (this.state !== 'idle') return this._busy('play');
      if (!this.clip) {
        this._emit('refused', { action: 'play', state: 'no recording' });
        return false;
      }
      if (!this.createAudio) {
        this._emit('unsupported', { step: 'HTMLAudioElement' });
        return false;
      }
      if (!this.URL || typeof this.URL.createObjectURL !== 'function') {
        this._emit('unsupported', { step: 'URL.createObjectURL' });
        return false;
      }
      const gen = ++this.gen;
      let el;
      try {
        if (!this.clipUrl) this.clipUrl = this.URL.createObjectURL(this.clip.blob);
        el = this.createAudio();
      } catch (e) {
        this._emit('error', Object.assign({ step: 'audio element setup' }, errInfo(e)));
        return false;
      }
      const token = { gen };
      this.playToken = token;
      this.audio = el;
      el.onended = () => {
        if (this.playToken === token) this._stopPlayback('ended');
      };
      el.onerror = () => {
        if (this.playToken !== token) return;
        const code = el.error && el.error.code;
        this._emit('error', { step: 'audio element playback', name: 'MediaError', message: 'code ' + clean(code, 4) });
        this._stopPlayback('error');
      };
      el.src = this.clipUrl;
      this._set('playing');
      this.playTimer = this.timers.setTimeout(() => {
        this.playTimer = null;
        if (this.playToken === token) this._stopPlayback('cap');
      }, PLAYBACK_CAP_MS);
      let p;
      try {
        p = el.play();
      } catch (e) {
        this._emit('error', Object.assign({ step: 'audio.play' }, errInfo(e)));
        this._stopPlayback('error');
        return false;
      }
      if (p && typeof p.then === 'function') {
        p.then(
          () => {
            if (this.playToken === token) this._emit('playStarted', {});
          },
          (e) => {
            if (this.playToken !== token) return;
            this._emit('error', Object.assign({ step: 'audio.play' }, errInfo(e)));
            this._stopPlayback('error');
          }
        );
      }
      return true;
    }

    _stopPlayback(reason) {
      const el = this.audio;
      this.audio = null;
      this.playToken = null;
      if (this.playTimer !== null) this.timers.clearTimeout(this.playTimer);
      this.playTimer = null;
      if (el) {
        el.onended = null;
        el.onerror = null;
        try {
          el.pause();
        } catch (_) {
          /* ignore */
        }
        try {
          el.removeAttribute('src');
          el.load();
        } catch (_) {
          /* ignore */
        }
      }
      if (this.state === 'playing') this._set('idle');
      if (el) this._emit('playStopped', { reason });
    }

    /* ---- Controls and lifecycle ---- */

    /* User Stop: ends whatever is active. A recording stopped here keeps its clip. */
    stop() {
      switch (this.state) {
        case 'tone':
          this._stopTone('stop');
          break;
        case 'requesting':
          this.gen += 1; // the pending permission promise will release its stream on arrival
          this._set('idle');
          this._emit('cancelled', { what: 'microphone request' });
          break;
        case 'recording':
          this._finishRecording('stop');
          break;
        case 'playing':
          this._stopPlayback('stop');
          break;
        default:
          break;
      }
    }

    clear() {
      this.cleanup('clear', true);
    }

    /* Stops every owned track, capture, tone and playback; invalidates pending completions.
     * clearClip also drops the recording and revokes its object URL. */
    cleanup(reason, clearClip) {
      this.gen += 1;
      this.recToken = null;
      if (this.capTimer !== null) this.timers.clearTimeout(this.capTimer);
      this.capTimer = null;
      if (this.finalizeTimer !== null) this.timers.clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
      const rec = this.recorder;
      this.recorder = null;
      if (rec) {
        try {
          if (rec.state !== 'inactive') rec.stop();
        } catch (_) {
          /* ignore */
        }
      }
      const tracks = this._releaseStream();
      this._stopTone(reason);
      this._stopPlayback(reason);
      if (this.state !== 'idle') this._set('idle');
      if (clearClip) this._dropClip();
      this._emit('cleanup', { reason, tracksStopped: tracks, clipKept: !!this.clip });
    }

    _dropClip() {
      if (this.clipUrl && this.URL && typeof this.URL.revokeObjectURL === 'function') {
        try {
          this.URL.revokeObjectURL(this.clipUrl);
        } catch (_) {
          /* ignore */
        }
      }
      this.clipUrl = null;
      const had = !!this.clip;
      this.clip = null;
      if (had) this._emit('clipCleared', {});
    }

    snapshot() {
      return {
        state: this.state,
        clip: this.clip ? { mime: this.clip.mime, bytes: this.clip.bytes, ms: this.clip.ms } : null,
        micTracksHeld: this.stream ? this.stream.getTracks().length : 0,
      };
    }
  }

  return { AudioProbe, RECORD_CAP_MS, TONE_MS, TONE_GAIN, FINALIZE_TIMEOUT_MS, PLAYBACK_CAP_MS };
});
