use super::host_mode::DesktopActivityOverlayDisplayContext;
use super::notch_native_geometry::DesktopActivityOverlayNativeMousePoint;

#[cfg(target_os = "macos")]
use objc2_core_graphics::{
    CGAssociateMouseAndMouseCursorPosition, CGEvent, CGEventTapLocation, CGEventType,
    CGMouseButton, CGWarpMouseCursorPosition,
};
#[cfg(target_os = "macos")]
use objc2_foundation::NSPoint;

#[cfg(target_os = "macos")]
const OUTSIDE_CLICK_REPOST_DELAY_MS: u64 = 50;

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq)]
struct RepostLeftClickPlan {
    click_point: NSPoint,
    restore_cursor_position: NSPoint,
}

#[cfg(target_os = "macos")]
pub(crate) fn repost_macos_left_click_after_collapse(
    point: DesktopActivityOverlayNativeMousePoint,
    display_context: DesktopActivityOverlayDisplayContext,
) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(
            OUTSIDE_CLICK_REPOST_DELAY_MS,
        ));
        repost_macos_left_click(point, display_context);
    });
}

#[cfg(target_os = "macos")]
fn repost_macos_left_click(
    point: DesktopActivityOverlayNativeMousePoint,
    display_context: DesktopActivityOverlayDisplayContext,
) {
    let saved_cursor_position =
        unsafe { CGEvent::new(None).map(|event| CGEvent::location(Some(&event))) };
    let Some(saved_cursor_position) = saved_cursor_position else {
        return;
    };
    let plan = build_repost_left_click_plan(point, display_context, saved_cursor_position);

    post_mouse_event(CGEventType::LeftMouseDown, plan.click_point);
    post_mouse_event(CGEventType::LeftMouseUp, plan.click_point);

    unsafe {
        let _ = CGWarpMouseCursorPosition(plan.restore_cursor_position);
        let _ = CGAssociateMouseAndMouseCursorPosition(true);
    }
}

#[cfg(target_os = "macos")]
fn build_repost_left_click_plan(
    point: DesktopActivityOverlayNativeMousePoint,
    display_context: DesktopActivityOverlayDisplayContext,
    saved_cursor_position: NSPoint,
) -> RepostLeftClickPlan {
    RepostLeftClickPlan {
        click_point: NSPoint::new(
            point.x,
            display_context.screen_frame.y + display_context.screen_frame.height - point.y,
        ),
        restore_cursor_position: saved_cursor_position,
    }
}

#[cfg(target_os = "macos")]
fn post_mouse_event(mouse_type: CGEventType, point: NSPoint) {
    let Some(event) =
        (unsafe { CGEvent::new_mouse_event(None, mouse_type, point, CGMouseButton::Left) })
    else {
        return;
    };

    unsafe {
        CGEvent::post(CGEventTapLocation::HIDEventTap, Some(&event));
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::activity_overlay::host_mode::DesktopActivityOverlayDisplayContext;
    use crate::activity_overlay::placement::Rect;

    #[test]
    fn repost_plan_converts_appkit_mouse_point_and_keeps_cursor_restore_point() {
        let display_context = DesktopActivityOverlayDisplayContext {
            is_macos: true,
            is_builtin_display: true,
            has_physical_notch: true,
            safe_area_top: 38.0,
            physical_notch_size: None,
            display_identity: None,
            screen_frame: Rect {
                x: 0.0,
                y: 120.0,
                width: 1512.0,
                height: 982.0,
            },
            visible_frame: Rect {
                x: 0.0,
                y: 120.0,
                width: 1512.0,
                height: 944.0,
            },
        };

        let plan = build_repost_left_click_plan(
            DesktopActivityOverlayNativeMousePoint {
                x: 700.0,
                y: 1040.0,
            },
            display_context,
            NSPoint::new(444.0, 555.0),
        );

        assert_eq!(plan.click_point, NSPoint::new(700.0, 62.0));
        assert_eq!(plan.restore_cursor_position, NSPoint::new(444.0, 555.0));
    }
}
