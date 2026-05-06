use super::display_identity::{resolve_display_identity, DisplayIdentityComponents};
use super::host_mode::{
    DesktopActivityOverlayDisplayContext, DesktopActivityOverlayPhysicalNotchSize,
};
use super::placement::Rect;

#[cfg(target_os = "macos")]
use objc2::rc::Retained;
#[cfg(target_os = "macos")]
use objc2::runtime::AnyObject;
#[cfg(target_os = "macos")]
use objc2::MainThreadMarker;
#[cfg(target_os = "macos")]
use objc2_app_kit::NSScreen;
#[cfg(target_os = "macos")]
use objc2_core_graphics::{
    CGDisplayIsBuiltin, CGDisplayModelNumber, CGDisplaySerialNumber, CGDisplayVendorNumber,
};
#[cfg(target_os = "macos")]
use objc2_foundation::{NSNumber, NSString};
use tauri::{AppHandle, Runtime};

#[cfg(target_os = "macos")]
const NSSCREEN_NUMBER_KEY: &str = "NSScreenNumber";

#[cfg(target_os = "macos")]
pub(crate) fn resolve_overlay_display_context_for_monitor<R: Runtime>(
    app: &AppHandle<R>,
    monitor: Rect,
) -> Option<DesktopActivityOverlayDisplayContext> {
    if MainThreadMarker::new().is_some() {
        return resolve_overlay_display_context_for_monitor_on_main_thread(monitor);
    }

    let (tx, rx) = std::sync::mpsc::channel();
    if app
        .run_on_main_thread(move || {
            let context = resolve_overlay_display_context_for_monitor_on_main_thread(monitor);
            let _ = tx.send(context);
        })
        .is_err()
    {
        return None;
    }

    rx.recv().ok().flatten()
}

#[cfg(not(target_os = "macos"))]
pub(crate) fn resolve_overlay_display_context_for_monitor<R: Runtime>(
    _app: &AppHandle<R>,
    _monitor: Rect,
) -> Option<DesktopActivityOverlayDisplayContext> {
    None
}

#[cfg(target_os = "macos")]
fn resolve_overlay_display_context_for_monitor_on_main_thread(
    monitor: Rect,
) -> Option<DesktopActivityOverlayDisplayContext> {
    let mtm = MainThreadMarker::new()
        .expect("expected overlay display context resolution to run on the main thread");
    let screens = NSScreen::screens(mtm);
    let screen_count = screens.count();
    let mut best_match: Option<(usize, Rect, f64)> = None;

    for index in 0..screen_count {
        let screen = screens.objectAtIndex(index);
        let screen_frame = rect_from_ns_rect(screen.frame());
        if !rects_match(screen_frame, monitor) {
            let distance = rect_match_distance(screen_frame, monitor);
            if best_match
                .as_ref()
                .map(|(_, _, best_distance)| distance < *best_distance)
                .unwrap_or(true)
            {
                best_match = Some((index, screen_frame, distance));
            }
            continue;
        }

        return build_display_context_for_screen(&screen, screen_frame);
    }

    if let Some((index, screen_frame, _)) = best_match {
        let screen = screens.objectAtIndex(index);
        return build_display_context_for_screen(&screen, screen_frame);
    }

    NSScreen::mainScreen(mtm).as_deref().and_then(|screen| {
        build_display_context_for_screen(screen, rect_from_ns_rect(screen.frame()))
    })
}

#[cfg(target_os = "macos")]
fn build_display_context_for_screen(
    screen: &NSScreen,
    screen_frame: Rect,
) -> Option<DesktopActivityOverlayDisplayContext> {
    let visible_frame = rect_from_ns_rect(screen.visibleFrame());
    let safe_area_top = unsafe { screen.safeAreaInsets() }.top;
    let auxiliary_top_left = rect_from_ns_rect(unsafe { screen.auxiliaryTopLeftArea() });
    let auxiliary_top_right = rect_from_ns_rect(unsafe { screen.auxiliaryTopRightArea() });
    let display_id = read_display_id(screen)?;
    let is_builtin_display = unsafe { CGDisplayIsBuiltin(display_id) };
    let display_identity = resolve_display_identity(DisplayIdentityComponents {
        cg_display_id: Some(display_id),
        vendor_id: Some(unsafe { CGDisplayVendorNumber(display_id) }),
        model_id: Some(unsafe { CGDisplayModelNumber(display_id) }),
        serial_number: Some(unsafe { CGDisplaySerialNumber(display_id) }),
    });
    let has_physical_notch = is_builtin_display
        && auxiliary_top_left.width > 0.0
        && auxiliary_top_right.width > 0.0
        && auxiliary_top_left.x < auxiliary_top_right.x;
    let physical_notch_size = derive_physical_notch_size(
        screen_frame,
        safe_area_top,
        auxiliary_top_left,
        auxiliary_top_right,
        has_physical_notch,
    );

    Some(DesktopActivityOverlayDisplayContext {
        is_macos: true,
        is_builtin_display,
        has_physical_notch,
        safe_area_top,
        physical_notch_size,
        display_identity: Some(display_identity),
        screen_frame,
        visible_frame,
    })
}

fn derive_physical_notch_size(
    screen_frame: Rect,
    safe_area_top: f64,
    auxiliary_top_left: Rect,
    auxiliary_top_right: Rect,
    has_physical_notch: bool,
) -> Option<DesktopActivityOverlayPhysicalNotchSize> {
    if !has_physical_notch || !safe_area_top.is_finite() || safe_area_top <= 0.0 {
        return None;
    }

    let auxiliary_width = auxiliary_top_left.width + auxiliary_top_right.width;
    let measured_width = screen_frame.width - auxiliary_width + 4.0;
    if !measured_width.is_finite() || measured_width <= 0.0 {
        return None;
    }

    Some(DesktopActivityOverlayPhysicalNotchSize {
        width: measured_width,
        height: safe_area_top,
    })
}

#[cfg(target_os = "macos")]
fn read_display_id(screen: &NSScreen) -> Option<u32> {
    let key = NSString::from_str(NSSCREEN_NUMBER_KEY);
    let device_description = screen.deviceDescription();
    let value: Option<Retained<AnyObject>> = device_description.objectForKey(&key);
    let number = value?.downcast::<NSNumber>().ok()?;
    Some(number.unsignedIntValue())
}

#[cfg(target_os = "macos")]
fn rect_from_ns_rect(rect: objc2_foundation::NSRect) -> Rect {
    Rect {
        x: rect.origin.x,
        y: rect.origin.y,
        width: rect.size.width,
        height: rect.size.height,
    }
}

fn rects_match(left: Rect, right: Rect) -> bool {
    (left.x - right.x).abs() < 0.5
        && (left.y - right.y).abs() < 0.5
        && (left.width - right.width).abs() < 0.5
        && (left.height - right.height).abs() < 0.5
}

fn rect_match_distance(left: Rect, right: Rect) -> f64 {
    let left_center_x = left.x + left.width / 2.0;
    let left_center_y = left.y + left.height / 2.0;
    let right_center_x = right.x + right.width / 2.0;
    let right_center_y = right.y + right.height / 2.0;

    (left_center_x - right_center_x).abs()
        + (left_center_y - right_center_y).abs()
        + (left.width - right.width).abs()
        + (left.height - right.height).abs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_equal_rects_with_a_small_tolerance() {
        let left = Rect {
            x: 0.0,
            y: 0.0,
            width: 1512.0,
            height: 982.0,
        };
        let right = Rect {
            x: 0.2,
            y: -0.2,
            width: 1511.7,
            height: 982.2,
        };

        assert!(rects_match(left, right));
    }

    #[test]
    fn prefers_the_closest_screen_rect_when_no_exact_monitor_match_exists() {
        let monitor = Rect {
            x: 0.0,
            y: 0.0,
            width: 1512.0,
            height: 982.0,
        };
        let builtin_like = Rect {
            x: 0.0,
            y: 0.0,
            width: 1511.6,
            height: 981.7,
        };
        let external = Rect {
            x: 1512.0,
            y: 120.0,
            width: 1728.0,
            height: 1117.0,
        };

        assert!(
            rect_match_distance(builtin_like, monitor) < rect_match_distance(external, monitor)
        );
    }

    #[test]
    fn derives_physical_notch_size_from_auxiliary_top_areas() {
        let size = derive_physical_notch_size(
            Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 982.0,
            },
            38.0,
            Rect {
                x: 0.0,
                y: 944.0,
                width: 644.0,
                height: 38.0,
            },
            Rect {
                x: 868.0,
                y: 944.0,
                width: 644.0,
                height: 38.0,
            },
            true,
        );

        assert_eq!(
            size,
            Some(DesktopActivityOverlayPhysicalNotchSize {
                width: 228.0,
                height: 38.0,
            }),
        );
    }

    #[test]
    fn omits_physical_notch_size_when_the_screen_has_no_notch() {
        let size = derive_physical_notch_size(
            Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 982.0,
            },
            0.0,
            Rect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
            },
            Rect {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 0.0,
            },
            false,
        );

        assert_eq!(size, None);
    }
}
