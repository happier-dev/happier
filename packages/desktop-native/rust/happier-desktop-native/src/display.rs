//! macOS display enumeration: every `NSScreen` / Core Graphics fact a desktop
//! shell needs to place a notch-integrated or floating overlay.
//!
//! Electron exposes none of `safeAreaInsets`, `auxiliaryTopLeftArea`,
//! `auxiliaryTopRightArea`, `maximumFramesPerSecond` or the Core Graphics
//! display identity, which is the reason this module exists.

use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_app_kit::NSScreen;
use objc2_core_graphics::{
    CGDisplayIsBuiltin, CGDisplayModelNumber, CGDisplaySerialNumber, CGDisplayVendorNumber,
};
use objc2_foundation::{NSNumber, NSRect, NSString};

use crate::geometry::{
    derive_physical_notch_size, has_physical_notch, resolve_display_identity, DisplayIdentity,
    DisplayIdentityComponents, NotchSize, Rect,
};

const NS_SCREEN_NUMBER_KEY: &str = "NSScreenNumber";

/// Everything read off one `NSScreen`.
pub struct Display {
    pub localized_name: String,
    pub frame: Rect,
    pub visible_frame: Rect,
    pub safe_area_top: f64,
    pub safe_area_left: f64,
    pub safe_area_bottom: f64,
    pub safe_area_right: f64,
    pub auxiliary_top_left_area: Rect,
    pub auxiliary_top_right_area: Rect,
    pub backing_scale_factor: f64,
    pub maximum_frames_per_second: i64,
    pub is_builtin: bool,
    pub has_physical_notch: bool,
    pub physical_notch_size: Option<NotchSize>,
    pub identity: DisplayIdentity,
}

fn rect_from(rect: NSRect) -> Rect {
    Rect {
        x: rect.origin.x,
        y: rect.origin.y,
        width: rect.size.width,
        height: rect.size.height,
    }
}

fn read_display_id(screen: &NSScreen) -> Option<u32> {
    let key = NSString::from_str(NS_SCREEN_NUMBER_KEY);
    let description = screen.deviceDescription();
    let value: Option<Retained<AnyObject>> = description.objectForKey(&key);
    let number = value?.downcast::<NSNumber>().ok()?;
    Some(number.unsignedIntValue())
}

fn read_display(screen: &NSScreen) -> Display {
    let frame = rect_from(screen.frame());
    let visible_frame = rect_from(screen.visibleFrame());
    // SAFETY: read-only AppKit accessors on a live `NSScreen`, on the main thread.
    let insets = unsafe { screen.safeAreaInsets() };
    let auxiliary_top_left = rect_from(unsafe { screen.auxiliaryTopLeftArea() });
    let auxiliary_top_right = rect_from(unsafe { screen.auxiliaryTopRightArea() });
    let localized_name = unsafe { screen.localizedName() }.to_string();
    let maximum_frames_per_second = unsafe { screen.maximumFramesPerSecond() } as i64;

    let display_id = read_display_id(screen);
    // SAFETY: Core Graphics display queries take a display id by value and are
    // documented to tolerate an unknown id by returning zero / false.
    let is_builtin = display_id.is_some_and(|id| unsafe { CGDisplayIsBuiltin(id) });
    let identity = resolve_display_identity(DisplayIdentityComponents {
        cg_display_id: display_id,
        vendor_id: display_id.map(|id| unsafe { CGDisplayVendorNumber(id) }),
        model_id: display_id.map(|id| unsafe { CGDisplayModelNumber(id) }),
        serial_number: display_id.map(|id| unsafe { CGDisplaySerialNumber(id) }),
    });

    let notched = has_physical_notch(is_builtin, auxiliary_top_left, auxiliary_top_right);

    Display {
        localized_name,
        frame,
        visible_frame,
        safe_area_top: insets.top,
        safe_area_left: insets.left,
        safe_area_bottom: insets.bottom,
        safe_area_right: insets.right,
        auxiliary_top_left_area: auxiliary_top_left,
        auxiliary_top_right_area: auxiliary_top_right,
        backing_scale_factor: screen.backingScaleFactor(),
        maximum_frames_per_second,
        is_builtin,
        has_physical_notch: notched,
        physical_notch_size: derive_physical_notch_size(
            frame,
            insets.top,
            auxiliary_top_left,
            auxiliary_top_right,
            notched,
        ),
        identity,
    }
}

/// Enumerate every attached display in `NSScreen.screens` order.
pub fn list_displays(mtm: MainThreadMarker) -> Vec<Display> {
    NSScreen::screens(mtm)
        .iter()
        .map(|screen| read_display(&screen))
        .collect()
}
