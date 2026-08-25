# Android Termux terminal libraries notice

This package may extract only `terminal-view` and `terminal-emulator` from the pinned `termux/termux-app` revision recorded in `native-renderers.json`.

Termux's upstream `LICENSE.md` identifies the Terminal Emulator for Android code used by those libraries as Apache License 2.0 code. The complete upstream license and any upstream notice are copied into the ignored vendor closure as `TERMUX-UPSTREAM-LICENSE.md` and `TERMUX-UPSTREAM-NOTICE.md` when source is installed.

The GPL-3.0-only Termux app and `termux-shared` are excluded from this package. This notice is attribution and source-closure metadata only; it does not constitute legal or product approval to enable the renderer.
