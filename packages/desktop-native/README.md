# @happier-dev/desktop-native

Host-agnostic window, display and capture primitives for Happier's desktop shells.
The Rust core has no Node dependency by default; the existing napi-rs addon is an
optional `node-bindings` adapter.

Happier's desktop target is being built twice on purpose right now — the shipping
Tauri shell and an in-tree Electron shell — so the macOS-native logic has to stop
belonging to either of them. This package is where that logic lands: it depends on
no shell. Its window configuration takes the host content view's native handle,
making those primitives drivable from Electron
(`BrowserWindow.getNativeWindowHandle()`, which yields an `NSView *`) and from
Tauri (`WebviewWindow::ns_view()`, the same pointer) with no branch in the crate.

## What it owns

Display geometry (`listDisplays`), per display, in `NSScreen.screens` order:

- `frame`, `visibleFrame`, `backingScaleFactor`, `maximumFramesPerSecond`
- `safeAreaInsets`, `auxiliaryTopLeftArea`, `auxiliaryTopRightArea`
- `isBuiltin`, `hasPhysicalNotch`, and the notch size derived from the gap AppKit
  leaves between the two auxiliary menu-bar areas
- a stable `identity` (`edid-<vendor>-<model>-<serial>`, else
  `display-<cgDisplayId>`, else `display-unknown`) suitable for keying persisted
  per-display placement

Window configuration from a raw handle (`inspectWindow`, `configureWindow`):

- collection behaviour, including `Stationary` and `IgnoresCycle`
- arbitrary integer `NSWindow.level`
- `hidesOnDeactivate`
- the key/main split: `canBecomeKeyWindow == true` together with
  `canBecomeMainWindow == false`

## Why the key/main split needs a runtime subclass

Electron drives both `canBecomeKeyWindow` and `canBecomeMainWindow` from one
`focusable` boolean and cannot express the combination Happier's overlay needs.
`configureWindow({ splitKeyAndMain: true })` therefore allocates a subclass of the
window's **live** class with `objc_allocateClassPair(liveClass, name, 0)` — zero
extra instance bytes — overrides exactly those two methods, and isa-swizzles the
instance into it. Zero extra bytes is what makes the swizzle sound: instance size
is unchanged, so the shell's own ivars and AppKit hooks stay where the window
expects them. Each base class gets one cached subclass named
`HappierDesktopKeyMainSplit_<BaseClass>`, and re-applying is a no-op.

Re-classing a window into an *unrelated* `NSPanel` subclass — the technique
`tauri-nspanel` uses on a Tauri window — is deliberately **not** done here,
because on an Electron window it would orphan Chromium's ivars.

## Handle safety

`decodeWindowHandle`, and every entry point that takes a handle, rejects a buffer
shorter than one pointer, a null pointer and a misaligned pointer as typed errors
before anything is dereferenced, then verifies the pointer is an `NSView` through
the Objective-C runtime. Those guards are pure and unit tested headlessly. A
pointer that is well-formed but stale cannot be detected; keeping the handle live
for the duration of the call remains the host's contract. Every window and display
entry point must run on the process main thread and returns a typed error
otherwise. Tauri's shared `desktop_panel` host uses its NSPanel mechanics, not
the Node adapter's runtime subclass, on Tauri windows.

## Build and verify

```sh
pnpm --filter @happier-dev/desktop-native run build:native     # cargo build + place native/*.node
pnpm --filter @happier-dev/desktop-native run verify:native    # headless load check
pnpm --filter @happier-dev/desktop-native run test             # TypeScript surface
./apps/stack/bin/hstack-exec --target=mac-host -- cargo test --locked --manifest-path packages/desktop-native/rust/happier-desktop-native/Cargo.toml
./apps/stack/bin/hstack-exec --target=mac-host -- cargo build --locked --manifest-path packages/desktop-native/rust/happier-desktop-native/Cargo.toml --example core_link
```

`native/` holds the built addon and is not committed. `rust/happier-desktop-native/.cargo/config.toml`
extends the flat-namespace `napi_*` lookup to host-target binaries so the `cargo test`
harness links when testing the optional Node feature; `napi_build::setup()` only
covers the cdylib and now runs only with `node-bindings`. `build:native` selects
that feature explicitly. The standalone `core_link` check runs without it.

## Development consumers

`apps/ui/src-tauri` consumes the plain Rust core. Its activity overlay projects
shared display/identity/notch facts into the existing serialized shape, retaining
its monitor matching and placement policies. Electron keeps the existing Node
API. These are host adapters, not competing display derivations.

The optional `capture` feature supplies native media contracts and the macOS
ScreenCaptureKit still backend: macOS 14+ uses the screenshot API; macOS 13 takes
the first complete stream frame and stops. Display-local geometry lives in
`geometry`; cancellation and errors are typed. The Tauri capture owner exposes
one active operation and lazy commands through
`apps/ui/sources/desktop/capture/nativeCapture.ts`.

`capture::files::CaptureFiles` keeps sources and complete prepared PNGs under an
opaque `captureRef`; dropping the owner deletes nothing. Prepared reads never
fall back to source bytes. Tauri owns the folder override (default
Pictures/Happier), and recording and import consumers use the same reader.
Only settled discard removes the owned files. These interfaces describe
development source, not released desktop-capture availability; graphical capture
and marked-image delivery require the integrated selector/editor surface.
