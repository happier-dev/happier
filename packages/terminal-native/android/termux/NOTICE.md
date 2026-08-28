# Android Termux terminal libraries notice

This package may extract only `terminal-view` and `terminal-emulator` from the pinned `termux/termux-app` revision recorded in `native-renderers.json`.

- Upstream commit: `401bbe54b8f4e68302b1ff70678015a24628fb1d`
- Source archive: `https://github.com/termux/termux-app/archive/401bbe54b8f4e68302b1ff70678015a24628fb1d.tar.gz`
- Source archive SHA-256: `fa9000bc04faebb57de2c3e7b4264b1531f7898b47f08675730007bbfbaab6f6`
- Extracted modules: `terminal-view`, `terminal-emulator` (Apache-2.0)

Termux's upstream `LICENSE.md` identifies the Terminal Emulator for Android code used by those libraries as Apache License 2.0 code. The complete upstream license and any upstream notice are copied into the ignored vendor closure as `TERMUX-UPSTREAM-LICENSE.md` and `TERMUX-UPSTREAM-NOTICE.md` when source is installed.

The GPL-3.0-only Termux app and `termux-shared` are excluded from this package. This notice and the repository probes are attribution and engineering source-closure metadata only; they do not constitute legal advice or product approval to enable the renderer. The `HAPPIER_TERMINAL_NATIVE_ANDROID_LEGAL_ACCEPTED` build flag is an authorized release-owner assertion, not approval evidence by itself.
