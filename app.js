/* Page wiring for the Bluefy probe. Holds no protocol or audio logic of its own (see ble.js,
 * link.js, audio.js). Nothing runs until the user presses a button; nothing is uploaded or
 * stored; results and the event log live in this page only. */
(function () {
  'use strict';

  const P = window.FarahBLE;
  const L = window.FarahLink;
  const A = window.FarahAudio;
  const $ = (id) => document.getElementById(id);
  const t0 = performance.now();
  const now = () => performance.now();
  const timers = {
    setTimeout: (f, ms) => window.setTimeout(f, ms),
    clearTimeout: (h) => window.clearTimeout(h),
    setInterval: (f, ms) => window.setInterval(f, ms),
    clearInterval: (h) => window.clearInterval(h),
  };
  const LOG_MAX = 200;
  const logLines = [];
  let audioDisconnects = 0;
  const context = { tone: null, playback: null };

  function stamp() {
    return ((now() - t0) / 1000).toFixed(1).padStart(6, ' ');
  }

  function addLog(kind, text) {
    const line = stamp() + 's ' + kind + ': ' + String(text).slice(0, 200);
    logLines.push(line);
    const ol = $('log');
    const li = document.createElement('li');
    li.textContent = line;
    ol.appendChild(li);
    while (logLines.length > LOG_MAX) {
      logLines.shift();
      if (ol.firstChild) ol.removeChild(ol.firstChild);
    }
  }

  function setText(id, text) {
    $(id).textContent = text;
  }

  /* ---- Capabilities ---- */

  const AudioCtx = window.AudioContext || window.webkitAudioContext || null;
  const bt = navigator.bluetooth || null;
  const md = navigator.mediaDevices || null;
  const Rec = window.MediaRecorder || null;

  function capRows() {
    const isType = (t) => {
      try {
        return !!(Rec && typeof Rec.isTypeSupported === 'function' && Rec.isTypeSupported(t));
      } catch (_) {
        return false;
      }
    };
    return [
      ['Secure context (HTTPS or localhost)', window.isSecureContext === true],
      ['navigator.bluetooth', !!bt],
      ['bluetooth.requestDevice', !!(bt && typeof bt.requestDevice === 'function')],
      ['mediaDevices.getUserMedia', !!(md && typeof md.getUserMedia === 'function')],
      ['MediaRecorder', !!Rec],
      ['MediaRecorder audio/mp4', isType('audio/mp4')],
      ['MediaRecorder audio/webm', isType('audio/webm')],
      ['AudioContext (WebAudio)', !!AudioCtx],
      ['URL.createObjectURL', typeof URL.createObjectURL === 'function'],
    ];
  }

  function renderCaps() {
    const ul = $('caps');
    ul.textContent = '';
    for (const [name, ok] of capRows()) {
      const li = document.createElement('li');
      li.className = ok ? 'yes' : 'no';
      li.textContent = (ok ? 'yes  ' : 'NO   ') + name;
      ul.appendChild(li);
    }
    setText('ua', navigator.userAgent);
    if (bt && typeof bt.getAvailability === 'function') {
      bt.getAvailability().then(
        (v) => addLog('env', 'bluetooth.getAvailability: ' + (v ? 'adapter available' : 'no adapter reported')),
        () => addLog('env', 'bluetooth.getAvailability failed')
      );
    }
  }

  /* ---- Controls ---- */

  let link;
  let audio;

  function refresh() {
    const ls = link.state;
    $('connect').disabled = ls !== 'idle';
    $('disconnect').disabled = ls === 'idle';
    $('resend').hidden = !(ls === 'connected' && link.halted);
    setText('bleState', ls);
    const s = link.stats;
    setText(
      'bleStats',
      'sent ' + s.sent + ' | write errors ' + s.writeErrors + ' | frames in ' + s.framesIn +
        ' | frames dropped ' + s.framesDropped + ' | messages in ' + s.messagesIn +
        ' | malformed ' + s.malformed + ' | btn ignored ' + s.btnIgnored + ' | acks ' + s.acksQueued +
        ' | queue drops ' + s.queueDropped + ' | sync coalesced ' + s.syncCoalesced +
        ' | early dropped ' + s.earlyDropped
    );
    const as = audio.state;
    setText('audioState', as);
    $('tone').disabled = as !== 'idle';
    $('record').disabled = as !== 'idle';
    $('stop').disabled = as === 'idle' || as === 'finalizing';
    $('play').disabled = as !== 'idle' || !audio.clip;
    $('clear').disabled = as === 'idle' && !audio.clip;
    const c = audio.clip;
    setText(
      'clipInfo',
      c ? 'Recording in memory: ' + (c.mime || 'unknown type') + ', ' + Math.round(c.bytes / 1024) + ' KB, about ' +
        (c.ms / 1000).toFixed(1) + ' s' : 'No recording in memory.'
    );
  }

  /* ---- BLE events ---- */

  function describeDecision(m, d) {
    if (!d.ack && d.reason === 'not_ready') return 'arrived before the connection finished: dropped, no ack';
    if (!d.ack) return 'other epoch: dropped, no ack';
    if (d.why === 'stale') return 'not newer than the last press: answered ok=false why=stale';
    return 'answered ok=false why=' + d.why + ' (probe has no backend session; nothing started)';
  }

  function onLink(type, d) {
    switch (type) {
      case 'connected':
        addLog('ble', 'connected; notifications on; new random epoch; sending sync (idle, no Farah, no session, headset not verified) via ' + d.writeMode);
        setText('bleHint', 'If iOS shows a Bluetooth pairing request, tap Pair. The first write needs it.');
        break;
      case 'sent':
        addLog('ble', 'sent ' + d.t + ' n=' + d.n + (d.t === 'ack' ? ' ref=' + d.ref + ' why=' + d.why : '') + ' (' + d.frames + ' frames)');
        setText('bleHint', '');
        break;
      case 'writeStalled':
        setText('bleHint', 'A write has waited ' + d.afterMs / 1000 + ' s. Check for an iOS pairing prompt.');
        addLog('ble', 'write pending ' + d.afterMs + ' ms (' + d.t + ' n=' + d.n + ')');
        break;
      case 'writeError':
        addLog('ble', 'write failed ' + d.t + ' n=' + d.n + ' fragment ' + d.fragment + ': ' + d.name + ' ' + d.message);
        setText('bleHint', 'Write failed (' + d.name + '). If pairing was declined, disconnect and connect again.');
        break;
      case 'halted':
        addLog('ble', 'sending stopped after ' + d.failures + ' failed writes in a row (no automatic retry)');
        setText('bleHint', 'Sending stopped. The board shows phone/offline after 15 s. Press Resend sync to try once.');
        break;
      case 'resumed':
        addLog('ble', 'user pressed Resend sync');
        break;
      case 'device': {
        const m = d.msg;
        if (d.early) addLog('dev', '(received while subscribing)');
        if (m.t === 'hello') addLog('dev', 'hello fw=' + m.fw + ' proto=' + m.proto + (m.proto === 1 ? '' : ' (UNSUPPORTED proto)'));
        else if (m.t === 'bat') addLog('dev', 'bat ' + ['pct', 'mv', 'chg', 'usb'].filter((k) => k in m).map((k) => k + '=' + m[k]).join(' '));
        else if (m.t === 'err') addLog('dev', 'err ' + m.c);
        break;
      }
      case 'btn':
        addLog('dev', 'button ' + d.msg.a + ' n=' + d.msg.n + ': ' + describeDecision(d.msg, d.decision));
        break;
      case 'malformed':
        addLog('ble', 'dropped malformed device message: ' + d.reason);
        break;
      case 'frameDrop':
        addLog('ble', 'discarded irregular fragment(s); total ' + d.total);
        break;
      case 'queueDrop':
        addLog('ble', 'send queue full; dropped a queued ' + d.kind);
        break;
      case 'late':
        addLog('ble', d.what);
        break;
      case 'unsupported':
        addLog('ble', 'UNSUPPORTED step: ' + d.step + (d.fallback ? ' (using ' + d.fallback + ')' : ''));
        setText('bleHint', 'Unsupported: ' + d.step);
        break;
      case 'error':
        addLog('ble', 'failed at ' + d.step + ': ' + d.name + ' ' + d.message);
        setText('bleHint', 'Failed at ' + d.step + ' (' + d.name + ').');
        break;
      case 'disconnected':
        addLog('ble', 'disconnected (' + d.reason + ')');
        if (audio.state !== 'idle') {
          audioDisconnects += 1;
          addLog('audio', 'BLE disconnected during an audio test; stopping audio');
        }
        audio.cleanup('ble_disconnected', false);
        break;
      default:
        break;
    }
    refresh();
  }

  /* ---- Audio events ---- */

  function onAudio(type, d) {
    switch (type) {
      case 'toneStarted':
        context.tone = { bleConnected: link.state === 'connected' };
        addLog('audio', 'tone ' + d.hz + ' Hz, gain ' + d.gain + ', ' + d.ms + ' ms (BLE ' + link.state + ')');
        break;
      case 'toneStopped':
        addLog('audio', 'tone stopped (' + d.reason + ')');
        break;
      case 'recordStarted':
        addLog('audio', 'recording (cap ' + d.capMs / 1000 + ' s, ' + (d.mimeType || 'type not reported') + ', BLE ' + link.state + ')');
        break;
      case 'recordStopping':
        addLog('audio', 'recording stopped (' + d.reason + '); microphone tracks stopped: ' + d.tracksStopped);
        break;
      case 'clipReady':
        addLog('audio', 'recording ready in memory (' + (d.mime || 'unknown type') + ', ' + d.bytes + ' bytes)');
        break;
      case 'playStarted':
        context.playback = { bleConnected: link.state === 'connected' };
        addLog('audio', 'playback started (BLE ' + link.state + ')');
        break;
      case 'playStopped':
        addLog('audio', 'playback stopped (' + d.reason + ')');
        break;
      case 'cancelled':
        addLog('audio', d.what + ' cancelled');
        break;
      case 'late':
        addLog('audio', d.what + ' (tracks stopped: ' + d.tracksStopped + ')');
        break;
      case 'clipCleared':
        addLog('audio', 'recording cleared from memory');
        break;
      case 'cleanup':
        if (d.reason !== 'ble_disconnected' || d.tracksStopped) {
          addLog('audio', 'cleanup (' + d.reason + '); microphone tracks stopped: ' + d.tracksStopped);
        }
        break;
      case 'refused':
        addLog('audio', d.action + ' ignored (' + d.state + ')');
        break;
      case 'unsupported':
        addLog('audio', 'UNSUPPORTED step: ' + d.step);
        setText('audioNote', 'Unsupported: ' + d.step);
        break;
      case 'error':
        addLog('audio', 'failed at ' + d.step + ': ' + d.name + ' ' + d.message);
        setText('audioNote', 'Failed at ' + d.step + ' (' + d.name + ').');
        break;
      default:
        break;
    }
    refresh();
  }

  /* ---- Results and export (no audio, credentials or device identifiers) ---- */

  function choice(id) {
    const el = $(id);
    return el.options[el.selectedIndex].text;
  }

  function buildExport() {
    const s = link.snapshot();
    const a = audio.snapshot();
    const lines = [
      'Farah Pocket Bluefy probe diagnostics',
      'Contains no audio, credentials, Bluetooth device ids or names.',
      'seconds since page load: ' + ((now() - t0) / 1000).toFixed(1),
      'user agent: ' + navigator.userAgent,
      'capabilities: ' + capRows().map(([n, ok]) => n + '=' + (ok ? 'yes' : 'no')).join('; '),
      'ble: state=' + s.state + ' writeMode=' + (s.writeMode || '-') + ' halted=' + s.halted + ' queued=' + s.queued,
      'ble stats: ' + Object.keys(s.stats).map((k) => k + '=' + s.stats[k]).join(' '),
      'audio: state=' + a.state + ' clip=' + (a.clip ? a.clip.mime + ' ' + a.clip.bytes + 'B ' + a.clip.ms + 'ms' : 'none') +
        ' micTracksHeld=' + a.micTracksHeld,
      'BLE disconnects during audio tests: ' + audioDisconnects,
      'user-observed results (the page cannot detect or verify audio routes):',
      '  tone heard: ' + choice('resTone') + (context.tone ? ' (BLE connected at start: ' + context.tone.bleConnected + ')' : ''),
      '  playback heard: ' + choice('resPlayback') + (context.playback ? ' (BLE connected at start: ' + context.playback.bleConnected + ')' : ''),
      '  recording quality: ' + choice('resQuality'),
      '  board screen after connect: ' + choice('resBoard'),
      '  board face button (idle): ' + choice('resButton'),
      'event log (last ' + LOG_MAX + ' lines):',
    ].concat(logLines);
    return lines.join('\n');
  }

  function init() {
    link = new L.BleLink({
      bluetooth: bt,
      now,
      timers,
      randomFill: (arr) => crypto.getRandomValues(arr),
      onEvent: onLink,
    });
    audio = new A.AudioProbe({
      mediaDevices: md,
      MediaRecorder: Rec,
      AudioContext: AudioCtx,
      createAudio: () => new Audio(),
      URL,
      timers,
      now,
      onEvent: onAudio,
    });
    $('connect').addEventListener('click', () => {
      link.connect().catch((e) => addLog('ble', 'connect error ' + (e && e.name)));
    });
    $('disconnect').addEventListener('click', () => link.disconnect('user'));
    $('resend').addEventListener('click', () => link.resume());
    $('tone').addEventListener('click', () => audio.playTone());
    $('record').addEventListener('click', () => {
      setText('audioNote', '');
      audio.record().catch((e) => addLog('audio', 'record error ' + (e && e.name)));
    });
    $('stop').addEventListener('click', () => audio.stop());
    $('play').addEventListener('click', () => audio.play());
    $('clear').addEventListener('click', () => audio.clear());
    $('buildExport').addEventListener('click', () => {
      $('exportText').value = buildExport();
    });
    $('copyExport').addEventListener('click', () => {
      const ta = $('exportText');
      if (!ta.value) ta.value = buildExport();
      const fallback = () => {
        ta.focus();
        ta.select();
        addLog('page', 'clipboard unavailable; text selected for manual copy');
      };
      if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
        navigator.clipboard.writeText(ta.value).then(() => addLog('page', 'diagnostics copied'), fallback);
      } else {
        fallback();
      }
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        audio.cleanup('page_hidden', true);
        addLog('page', 'hidden: audio stopped, recording cleared; timers may pause (no background guarantee)');
      } else {
        addLog('page', 'visible again (BLE state ' + link.state + ')');
      }
    });
    window.addEventListener('pagehide', () => {
      audio.cleanup('pagehide', true);
      link.disconnect('pagehide');
    });
    renderCaps();
    refresh();
    addLog('page', 'loaded; nothing starts until you press a button');
  }

  init();
})();
