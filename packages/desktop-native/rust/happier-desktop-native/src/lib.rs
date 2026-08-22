//! Host-agnostic macOS desktop-window primitives for Happier.
//!
//! This crate owns the AppKit / Core Graphics surface that a desktop shell needs
//! but cannot express itself, and it deliberately depends on no shell: the only
//! thing it takes from the host is the content view's native handle. That makes
//! it drivable from Electron (`BrowserWindow.getNativeWindowHandle()`) and from
//! Tauri (`WebviewWindow::ns_view()`) alike.
//!
//! Thread contract: every AppKit entry point below must be called on the process
//! main thread. Being off the main thread is reported as a typed error rather
//! than a panic or a data race.

use napi::bindgen_prelude::Buffer;
use napi_derive::napi;

pub mod geometry;
pub mod handle;

#[cfg(target_os = "macos")]
pub mod display;
#[cfg(target_os = "macos")]
pub mod window;

/// A rectangle in AppKit's bottom-left-origin screen coordinate space, in points.
#[napi(object)]
pub struct ScreenRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl From<geometry::Rect> for ScreenRect {
    fn from(value: geometry::Rect) -> Self {
        ScreenRect {
            x: value.x,
            y: value.y,
            width: value.width,
            height: value.height,
        }
    }
}

/// `NSEdgeInsets`, in points.
#[napi(object)]
pub struct ScreenInsets {
    pub top: f64,
    pub left: f64,
    pub bottom: f64,
    pub right: f64,
}

/// Physical notch extents, in points.
#[napi(object)]
pub struct NotchSize {
    pub width: f64,
    pub height: f64,
}

/// A display identity stable enough to key persisted per-display placement.
#[napi(object)]
pub struct DisplayIdentity {
    pub storage_key: String,
    /// One of `edidComposite`, `cgDisplayId`, `unknown`.
    pub source: String,
    pub cg_display_id: Option<u32>,
    pub vendor_id: Option<u32>,
    pub model_id: Option<u32>,
    pub serial_number: Option<u32>,
}

/// Everything this crate reads off one attached display.
#[napi(object)]
pub struct DisplayGeometry {
    pub localized_name: String,
    pub frame: ScreenRect,
    pub visible_frame: ScreenRect,
    pub safe_area_insets: ScreenInsets,
    pub auxiliary_top_left_area: ScreenRect,
    pub auxiliary_top_right_area: ScreenRect,
    pub backing_scale_factor: f64,
    pub maximum_frames_per_second: i64,
    pub is_builtin: bool,
    pub has_physical_notch: bool,
    pub physical_notch_size: Option<NotchSize>,
    pub identity: DisplayIdentity,
}

/// Read-back of the window state this crate can influence.
///
/// `collectionBehavior` and `styleMask` are `NSUInteger` bit masks; they are
/// returned as hexadecimal strings because they exceed the range JavaScript
/// numbers represent exactly.
#[napi(object)]
pub struct WindowFacts {
    pub view_class: String,
    pub window_class: String,
    pub level: i64,
    pub collection_behavior: String,
    pub style_mask: String,
    pub is_panel: bool,
    pub opaque: bool,
    pub has_shadow: bool,
    pub hides_on_deactivate: bool,
    pub can_become_key_window: bool,
    pub can_become_main_window: bool,
    pub has_key_main_split: bool,
}

/// Requested window configuration. Omitted fields leave the current value alone.
#[napi(object)]
pub struct WindowConfiguration {
    pub can_join_all_spaces: Option<bool>,
    pub full_screen_auxiliary: Option<bool>,
    pub stationary: Option<bool>,
    pub ignores_cycle: Option<bool>,
    /// Arbitrary integer `NSWindow.level`.
    pub level: Option<i64>,
    pub hides_on_deactivate: Option<bool>,
    /// Install the runtime subclass that reports `canBecomeKeyWindow == true`
    /// while `canBecomeMainWindow == false`.
    pub split_key_and_main: Option<bool>,
}

/// Decode a native window handle and return its address, without touching
/// AppKit. Safe to call from any thread and on any platform; used to validate a
/// handle and to prove the addon loaded.
#[napi]
pub fn decode_window_handle(handle: Buffer) -> napi::Result<String> {
    handle::decode_view_address(handle.as_ref())
        .map(|address| format!("0x{:x}", address.as_ptr() as usize))
        .map_err(|error| napi::Error::from_reason(error.message()))
}

#[cfg(target_os = "macos")]
fn main_thread() -> napi::Result<objc2::MainThreadMarker> {
    objc2::MainThreadMarker::new().ok_or_else(|| {
        napi::Error::from_reason(
            "@happier-dev/desktop-native must be called on the process main thread",
        )
    })
}

#[cfg(target_os = "macos")]
impl From<display::Display> for DisplayGeometry {
    fn from(value: display::Display) -> Self {
        DisplayGeometry {
            localized_name: value.localized_name,
            frame: value.frame.into(),
            visible_frame: value.visible_frame.into(),
            safe_area_insets: ScreenInsets {
                top: value.safe_area_top,
                left: value.safe_area_left,
                bottom: value.safe_area_bottom,
                right: value.safe_area_right,
            },
            auxiliary_top_left_area: value.auxiliary_top_left_area.into(),
            auxiliary_top_right_area: value.auxiliary_top_right_area.into(),
            backing_scale_factor: value.backing_scale_factor,
            maximum_frames_per_second: value.maximum_frames_per_second,
            is_builtin: value.is_builtin,
            has_physical_notch: value.has_physical_notch,
            physical_notch_size: value.physical_notch_size.map(|size| NotchSize {
                width: size.width,
                height: size.height,
            }),
            identity: DisplayIdentity {
                storage_key: value.identity.storage_key,
                source: value.identity.source.as_str().to_owned(),
                cg_display_id: value.identity.cg_display_id,
                vendor_id: value.identity.vendor_id,
                model_id: value.identity.model_id,
                serial_number: value.identity.serial_number,
            },
        }
    }
}

#[cfg(target_os = "macos")]
impl From<window::WindowFacts> for WindowFacts {
    fn from(value: window::WindowFacts) -> Self {
        WindowFacts {
            view_class: value.view_class,
            window_class: value.window_class,
            level: value.level,
            collection_behavior: format!("0x{:x}", value.collection_behavior),
            style_mask: format!("0x{:x}", value.style_mask),
            is_panel: value.is_panel,
            opaque: value.opaque,
            has_shadow: value.has_shadow,
            hides_on_deactivate: value.hides_on_deactivate,
            can_become_key_window: value.can_become_key_window,
            can_become_main_window: value.can_become_main_window,
            has_key_main_split: value.has_key_main_split,
        }
    }
}

#[cfg(not(target_os = "macos"))]
const UNSUPPORTED_PLATFORM: &str =
    "@happier-dev/desktop-native exposes macOS window primitives and is unavailable on this platform";

/// Enumerate every attached display, in `NSScreen.screens` order. Main thread only.
#[napi]
pub fn list_displays() -> napi::Result<Vec<DisplayGeometry>> {
    #[cfg(target_os = "macos")]
    {
        let mtm = main_thread()?;
        Ok(display::list_displays(mtm)
            .into_iter()
            .map(DisplayGeometry::from)
            .collect())
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err(napi::Error::from_reason(UNSUPPORTED_PLATFORM))
    }
}

/// Read the state of the window that owns `handle`'s content view, without
/// changing it. Main thread only.
#[napi]
pub fn inspect_window(handle: Buffer) -> napi::Result<WindowFacts> {
    #[cfg(target_os = "macos")]
    {
        let _mtm = main_thread()?;
        // SAFETY: `handle` is the shell-owned content-view handle, and the main
        // thread marker above proves the AppKit thread requirement.
        unsafe { window::inspect(handle.as_ref()) }
            .map(WindowFacts::from)
            .map_err(napi::Error::from_reason)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = handle;
        Err(napi::Error::from_reason(UNSUPPORTED_PLATFORM))
    }
}

/// Apply `configuration` to the window that owns `handle`'s content view and
/// return the resulting state. Main thread only.
#[napi]
pub fn configure_window(
    handle: Buffer,
    configuration: WindowConfiguration,
) -> napi::Result<WindowFacts> {
    #[cfg(target_os = "macos")]
    {
        let _mtm = main_thread()?;
        let requested = window::WindowConfiguration {
            can_join_all_spaces: configuration.can_join_all_spaces,
            full_screen_auxiliary: configuration.full_screen_auxiliary,
            stationary: configuration.stationary,
            ignores_cycle: configuration.ignores_cycle,
            level: configuration.level,
            hides_on_deactivate: configuration.hides_on_deactivate,
            split_key_and_main: configuration.split_key_and_main,
        };
        // SAFETY: as in `inspect_window`.
        unsafe { window::configure(handle.as_ref(), &requested) }
            .map(WindowFacts::from)
            .map_err(napi::Error::from_reason)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (handle, configuration);
        Err(napi::Error::from_reason(UNSUPPORTED_PLATFORM))
    }
}
