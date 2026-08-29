# Android Termux Terminal Renderer

This directory records the Android native renderer source and compliance contract. Materialized Termux source remains ignored and is accepted only when repository checks prove the pinned revision, copied Apache license and attribution, allowed module set, and absence of forbidden GPL-module references.

The intended native renderer source is Termux `terminal-view` plus `terminal-emulator` from `termux/termux-app`. The root Termux app is GPL-3.0-only, but upstream documents `terminal-view` and `terminal-emulator` as Apache-2.0 exceptions inherited from Terminal Emulator for Android. Happier consumes only those terminal libraries and never the full Termux app or `termux-shared` in this implementation.

Happier does not embed Termux's process-backed `TerminalView` widget directly. `TerminalView` requires a final `TerminalSession` that starts a local Android subprocess, while Happier terminals receive bytes from the remote daemon PTY. The native path therefore uses Termux `TerminalEmulator` and `TerminalRenderer` behind `TermuxBackedRemoteSession`, and Happier owns the remote interaction adapter.

The adapter currently implements IME committed text, hardware-key escape mapping via Termux `KeyHandler`, mouse tracking, scroll wheel handling, alternate-screen scroll-as-arrow behavior, local scrollback rendering, safe HTTP(S) link-tap routing through Happier's shared host link policy, long-press drag range selection, selected-range rendering/copy, output-driven accessibility-summary refresh, and default-deny handling for remote OSC 52 clipboard writes. It still requires device QA before release and does not expose a per-cell native accessibility tree; xterm WebView remains the accessible fallback.

Approved source is extracted into ignored `android/termux/vendor/` with:

```bash
HAPPIER_TERMINAL_NATIVE_TERMUX_SOURCE_ROOT=/path/to/termux-app \
HAPPIER_TERMINAL_NATIVE_TERMUX_COMMIT=401bbe54b8f4e68302b1ff70678015a24628fb1d \
yarn workspace @happier-dev/terminal-native fetch:termux:android
```

The source checkout must be clean and exactly at that pinned revision. The extractor copies only `terminal-view` and `terminal-emulator`, rejects `app` and `termux-shared`, copies the root upstream `LICENSE.md` plus an upstream `NOTICE` when present, and writes the matching provenance and license-closure fields to `android/termux/vendor/TERMUX-SOURCE.json`. Gradle consumes the ignored source tree only when its module set, pin, policy metadata, package notice, and copied license closure all match.

Before updating source or artifacts here, verify:

- pinned upstream commit;
- exact copied modules/artifacts;
- Apache-2.0 NOTICE obligations;
- local patches, if any;
- Gradle/AAR build proof;
- binary-size delta;
- ABI smoke result;
- crash-to-WebView fallback proof;
- IME/hardware-key/mouse device smoke;
- accessibility model or accepted xterm WebView fallback policy.

Runtime gate env/properties:

- `HAPPIER_TERMINAL_NATIVE_ANDROID_DEPENDENCY_CLOSURE_APPROVED=1`
- `HAPPIER_TERMINAL_NATIVE_ANDROID_GRADLE_BUILD_PROVEN=1`
- `HAPPIER_TERMINAL_NATIVE_ANDROID_ABI_SMOKE_PASSED=1`
- `HAPPIER_TERMINAL_NATIVE_ANDROID_CRASH_FALLBACK_PROVEN=1`
- `HAPPIER_TERMINAL_NATIVE_ANDROID_ACCESSIBILITY_NATIVE=1`

The first four are hard technical availability gates. `HAPPIER_TERMINAL_NATIVE_ANDROID_ACCESSIBILITY_NATIVE` only controls whether availability reports `accessibility: "native"` instead of `accessibility: "fallback-required"`; xterm WebView remains the accessible fallback until this is proven.

Static APK size and ABI evidence is generated with:

```bash
HAPPIER_TERMINAL_NATIVE_ANDROID_CANDIDATE_APK=/path/to/native-enabled.apk \
HAPPIER_TERMINAL_NATIVE_ANDROID_EXPECT_TERMUX_INCLUDED=1 \
HAPPIER_TERMINAL_NATIVE_ANDROID_BASELINE_APK=/path/to/native-disabled.apk \
HAPPIER_TERMINAL_NATIVE_ANDROID_REQUIRED_ABIS=arm64-v8a,x86_64 \
yarn workspace @happier-dev/terminal-native evidence:android:artifact
```

This command does not satisfy `HAPPIER_TERMINAL_NATIVE_ANDROID_ABI_SMOKE_PASSED`: that gate additionally requires install/load evidence on every supported ABI.
