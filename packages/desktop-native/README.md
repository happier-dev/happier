# @happier-dev/desktop-native

Host-agnostic macOS window and display primitives for Happier's desktop shells,
packaged as a napi-rs N-API addon.

Happier's desktop target is being built twice on purpose right now — the shipping
Tauri shell and an in-tree Electron shell — so the macOS-native logic has to stop
belonging to either of them. This package is where that logic lands: it depends on
no shell, and the only thing it takes from a host is the content view's native
handle. That makes it drivable from Electron
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
otherwise.

## Build and verify

```sh
yarn workspace @happier-dev/desktop-native build:native     # cargo build + place native/*.node
yarn workspace @happier-dev/desktop-native verify:native    # headless load check
yarn workspace @happier-dev/desktop-native test             # TypeScript surface
cd rust/happier-desktop-native && cargo test --target aarch64-apple-darwin
```

`native/` holds the built addon and is not committed. `rust/happier-desktop-native/.cargo/config.toml`
extends the flat-namespace `napi_*` lookup to host-target binaries so the `cargo test`
harness links; `napi_build::setup()` only covers the cdylib.

## Status: `src-tauri` has NOT been migrated onto this package

Nothing consumes this package yet. `apps/ui/src-tauri` still carries its own copy
of all of the above, and this package was built beside it rather than extracted
from it because a Tauri/wry upgrade was in flight in that tree. The two are
byte-compatible by construction: the crate pins the same
`objc2` / `objc2-app-kit` / `objc2-foundation` / `objc2-core-graphics` versions
`src-tauri` resolves, and `geometry.rs` reproduces the existing derivation rules
exactly, so the logic can move verbatim.

The follow-up that completes the extraction:

1. Delete `resolve_display_identity` from
   `apps/ui/src-tauri/src/activity_overlay/display_identity.rs` and the notch
   derivation from `macos_display_context.rs`, and have both call this crate's
   `geometry` module. Depending on `happier-desktop-native` as a path dependency
   from `src-tauri/Cargo.toml` keeps one owner for the rules; the crate's `rlib`
   target exists for exactly that.
2. Replace the raw `NSScreen` reads in
   `apps/ui/src-tauri/src/activity_overlay/macos_display_context.rs` — the only
   place in `src-tauri` that reads them — with `display::list_displays`, keeping
   that module's monitor-matching logic, which stays Tauri-specific because it
   matches against a `tauri::Monitor` rect.
3. Replace the collection-behaviour / style-mask / level writes in
   `apps/ui/src-tauri/src/activity_overlay/host_window.rs` with
   `window::configure`, passing `WebviewWindow::ns_view()` instead of
   `ns_window()`.
4. Decide the fate of `apps/ui/src-tauri/src/activity_overlay/panel_host.rs` and
   its `tauri-nspanel` dependency. `window::configure`'s key/main split covers the
   panel behaviour Happier actually relies on; if `panel_host.rs` is retired, the
   `tauri-nspanel` git dependency in `apps/ui/src-tauri/Cargo.toml` goes with it.
   Until then `panel_host.rs` and this crate are two owners of the same concept
   and must not both be live on the same window.
5. Add `packages/desktop-native` to the desktop build pipelines so the addon is
   present for the Electron shell and, once step 1 lands, so `src-tauri`'s build
   resolves the path dependency.

Steps 1-4 touch `apps/ui/src-tauri/**` and step 5 touches the build pipeline;
both were out of scope when this package was created.
