# @happier-dev/terminal-native

Optional native terminal renderer package for Happier.

This package is a proof-gated Expo Module shell. It is excluded from app builds by default through `HAPPIER_ENABLE_TERMINAL_NATIVE=0` and reports native renderers as unavailable until GhosttyKit or Termux packaging, licensing, crash fallback, size, and platform proof gates are accepted. Accessibility is reported separately as `native` or `fallback-required` so the app can keep xterm WebView as the default accessible renderer while allowing explicit native experiments.

## iOS Ghostty shape

The iOS implementation target is an Expo native view backed by a pinned `GhosttyKit.xcframework` at `ios/Vendor/GhosttyKit.xcframework`.

The selected iOS v1 substrate is `libghostty-spm`: Happier vendors a pinned/checksummed GhosttyKit artifact through this package's Expo module and owns the Swift/Expo wrapper code around it. Direct Ghostty source builds remain the escape hatch if `libghostty-spm` becomes stale, divergent, unavailable, or release-blocking.

The currently verified upstream artifact is `libghostty-spm` commit `c069f05e0a4ef50143e943e954ed75e52e947009`, release `storage.1.2.4`, zip checksum `f1484a5411559bf4a5b665b82a5bb91cb8a3ca2065467dc15202fb191d7a5c9d`, and expanded installed XCFramework checksum `f59c864108a9ef3002f6dcaaa00f87e5b56ce4966fb6c90d5ad744cc7aef37c7`, with `ios-arm64` and `ios-arm64_x86_64-simulator` slices. `scripts/buildGhosttyKitIos.mjs` accepts either an expanded `GhosttyKit.xcframework` or the upstream `.xcframework.zip`, but explicit artifacts must always provide `HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_SHA256`.

When the artifact is linked, the Swift bridge imports the `libghostty` module behind `HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY`, creates a host-managed Ghostty surface, feeds daemon bytes with `ghostty_surface_write_buffer`, and emits input, resize, ready, copy, crash, and write-ACK events through the Expo module. Artifact-free builds keep the same package surface but report `artifact-missing`.

The artifact is acceptable only after an explicit supply-chain decision, exact version/revision pin, checksum pin, wrapper source/patch provenance review, license/NOTICE review, size budget, ABI smoke, crash fallback proof, and accessibility acceptance.

Remodex is a useful reference implementation for the Swift/Ghostty C API lifecycle: it vendors `GhosttyKit.xcframework` into an iOS Xcode project and wraps runtime/app/surface creation, byte feed, write callbacks, resize, draw, selection, text extraction, and clipboard in Swift. Happier should use Remodex as implementation reference only, not as the production binary source.

## Android Termux shape

The Android implementation target is an Expo native view backed by Termux `terminal-emulator` plus `terminal-view` rendering primitives through a Happier remote-session adapter.

Only those terminal libraries are in scope. The full Termux app is GPL-3.0-only and must not be bundled by this package under the Stage A plan. Upstream documents `terminal-view` and `terminal-emulator` as Apache-2.0 exceptions; legal/product approval, NOTICE handling, pinned revision, AAR/Gradle proof, size budget, crash fallback, and accessibility acceptance are still required before release use.

The process-backed Termux `TerminalView` widget is not embedded directly because it requires a `TerminalSession` that spawns a local Android subprocess. Happier uses Termux `TerminalEmulator`/`TerminalRenderer` to consume the remote daemon byte stream without local PTY spawning. The Happier adapter now owns IME committed text, hardware-key escape mapping, mouse tracking, wheel/alternate-screen scrolling, local scrollback rendering, and safe HTTP(S) link-tap routing through the shared host link policy; selection handles, native accessibility, crash fallback, and device smoke remain release gates before default native selection.

## Fallback invariant

The xterm WebView renderer remains the native fallback and accessible baseline. Native renderer availability must be additive: missing artifacts, unsupported builds, module load failures, crash recovery, or unaccepted legal/package gates must keep returning structured unavailable states instead of disabling the terminal. If all hard gates pass but native accessibility is not proven, the native module returns `available: true` with `accessibility: "fallback-required"`; the UI keeps `auto` on xterm WebView and permits an explicit `native` preference.
