# Farah Pocket Bluefy probe

A static test page for the Bluefy browser on iPhone. It checks whether a Farah Pocket board can be
reached over Bluetooth LE while the phone plays and records audio.

It is a test page only. It tells the board that it is idle, and it never starts a voice session,
approves anything or runs tools.

Privacy:
- The page makes no network requests (Content-Security-Policy `connect-src 'none'`) and stores
  nothing.
- A test recording stays in memory until Clear or until you leave the page.
- Results stay on the page unless you copy the diagnostic text yourself.

Files: index.html, probe.css, ble.js, link.js, audio.js, app.js. There is no build step.
