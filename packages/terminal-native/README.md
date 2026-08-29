# @happier-dev/terminal-native

Optional native terminal renderer package for Happier.

Strict TERM-7b device evidence uses `device-evidence-capture-authorities.json` to control keys allowed to attest loaded-device captures and embedded build identities. Capture policy schema v2 binds every authority to exact renderer/build IDs and an inclusive validity window; the internal `internal-term-device-qa-20260828` authority is limited to the two listed QA builds from `2026-08-28T11:30:00Z` through `2026-08-30T23:59:59Z`. Its private key is an external local operational secret at `/home/leeroy.guest/.happier/term-qa-authority-20260828/private.pem`; never copy it into the repository, evidence, logs, or reports.

Evidence builds receive `HAPPIER_TERMINAL_NATIVE_CAPTURE_AUTHORITY_ID` and `HAPPIER_TERMINAL_NATIVE_CAPTURE_PRIVATE_KEY_PATH` only in the controlled build environment and embed the signed identity in the retained app ZIP/APK; ordinary development builds remove stale generated identities.

This package is a proof-gated Expo Module used by every canonical EAS build profile. Ad hoc local builds may still omit it by leaving `HAPPIER_ENABLE_TERMINAL_NATIVE` unset; when included, it reports native renderers as unavailable until GhosttyKit or Termux packaging, licensing, crash fallback, size, and platform proof gates are accepted. Accessibility is reported separately as `native` or `fallback-required` so `auto` can keep xterm WebView as the accessible renderer while users can explicitly select the native renderer after every non-accessibility hard gate passes.

## iOS Ghostty shape

The iOS implementation target is an Expo native view backed by a pinned `GhosttyKit.xcframework` at `ios/Vendor/GhosttyKit.xcframework`.

The selected and implemented iOS v1 supply path is `libghostty-spm`: Happier vendors a pinned/checksummed GhosttyKit artifact through this package's Expo module and owns the Swift/Expo wrapper code around it. A direct Ghostty source build is not implemented; if `libghostty-spm` becomes stale, divergent, unavailable, or release-blocking, stop release and open a separately reviewed direct-build packet rather than claiming an unavailable fallback.

The currently verified upstream artifact is `libghostty-spm` commit `c069f05e0a4ef50143e943e954ed75e52e947009`, release `storage.1.2.4`, zip checksum `f1484a5411559bf4a5b665b82a5bb91cb8a3ca2065467dc15202fb191d7a5c9d`, and expanded installed XCFramework checksum `f59c864108a9ef3002f6dcaaa00f87e5b56ce4966fb6c90d5ad744cc7aef37c7`, with `ios-arm64` and `ios-arm64_x86_64-simulator` slices. `scripts/buildGhosttyKitIos.mjs` accepts either an expanded `GhosttyKit.xcframework` or the upstream `.xcframework.zip`, but explicit artifacts must always provide `HAPPIER_TERMINAL_NATIVE_GHOSTTYKIT_SHA256`.

When the artifact is linked, the Swift bridge imports the `libghostty` module behind `HAPPIER_TERMINAL_NATIVE_HAS_GHOSTTY`, creates a host-managed Ghostty surface, feeds daemon bytes with `ghostty_surface_write_buffer`, and emits input, resize, ready, copy, crash, and write-ACK events through the Expo module. Artifact-free builds keep the same package surface but report `artifact-missing`.

The artifact is acceptable only after an explicit supply-chain decision, exact version/revision pin, checksum pin, wrapper source/patch provenance review, license/NOTICE review, size budget, ABI smoke, crash fallback proof, and accessibility acceptance.

Remodex is a useful reference implementation for the Swift/Ghostty C API lifecycle: it vendors `GhosttyKit.xcframework` into an iOS Xcode project and wraps runtime/app/surface creation, byte feed, write callbacks, resize, draw, selection, text extraction, and clipboard in Swift. Happier should use Remodex as implementation reference only, not as the production binary source.

## Android Termux shape

The Android implementation target is an Expo native view backed by Termux `terminal-emulator` plus `terminal-view` rendering primitives through a Happier remote-session adapter.

Only those terminal libraries are in scope. The full Termux app is GPL-3.0-only and must not be bundled by this package under the Stage A plan. Upstream documents `terminal-view` and `terminal-emulator` as Apache-2.0 exceptions; Happier mechanically enforces NOTICE handling, the pinned terminal-only source closure, forbidden GPL-module absence, AAR/Gradle proof, size budget, crash fallback, and accessibility behavior.

The source extractor and package probes provide reproducible engineering evidence about the exact pinned Apache-2.0 source closure. There is no separate legal-approval record or build flag; canonical builds include the renderer when those objective compliance and technical checks pass.

`yarn workspace @happier-dev/terminal-native evidence:android:artifact` compares candidate and optional baseline APK sizes and verifies the packaged ABI directories requested by `HAPPIER_TERMINAL_NATIVE_ANDROID_REQUIRED_ABIS`. Set `HAPPIER_TERMINAL_NATIVE_ANDROID_EXPECT_TERMUX_INCLUDED=1` for native-enabled artifacts; the inspector verifies Termux class inclusion and requires the complete Apache license plus attribution assets whenever those classes are present. This is static package evidence only; TERM-7b still requires installing and loading the candidate on each supported device ABI.

The process-backed Termux `TerminalView` widget is not embedded directly because it requires a `TerminalSession` that spawns a local Android subprocess. Happier uses Termux `TerminalEmulator`/`TerminalRenderer` to consume the remote daemon byte stream without local PTY spawning. The Happier adapter owns IME committed text, hardware-key escape mapping, mouse tracking, wheel/alternate-screen scrolling, local scrollback rendering, safe HTTP(S) link-tap routing through the shared host link policy, long-press drag range selection, and selected-range rendering/copy. Native accessibility and the remaining device smoke are release gates for automatic selection, while explicit native selection retains xterm WebView as its crash/unavailable fallback.

## Fallback invariant

The xterm WebView renderer remains the native fallback and accessible baseline. Native renderer availability must be additive: missing artifacts, unsupported builds, module load failures, crash recovery, or failed technical/package checks must keep returning structured unavailable states instead of disabling the terminal. If all hard gates pass but native accessibility is not proven, the native module returns `available: true` with `accessibility: "fallback-required"`; `auto` selects native normally and keeps xterm WebView only while a screen reader is active, while an explicit `native` preference remains an informed override.

## Internal crash-fallback QA

`HAPPIER_TERMINAL_NATIVE_QA_CRASH_INJECTION=1` enables a native-build-only renderer crash injection capability only for the same explicit internal `APP_ENV` allowlist. The terminal pane exposes a small QA control only when the loaded native module confirms that capability; pressing it targets the currently mounted `surfaceId` and emits `rendererCrash` through the real Ghostty view or Termux remote-session event path.

Ordinary builds compile with the capability disabled, do not render the control, and reject direct injection calls. A passing device run must observe the native surface disappear, the matching xterm WebView surface appear without replacing the terminal session, and the same renderer remain quarantined after app relaunch.
