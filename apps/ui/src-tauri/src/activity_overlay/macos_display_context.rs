use super::host_mode::{
    DesktopActivityOverlayDisplayContext, DesktopActivityOverlayPhysicalNotchSize,
};
use super::placement::Rect;

use tauri::{AppHandle, Runtime};

pub(crate) fn resolve_overlay_display_context_for_monitor<R: Runtime>(
    app: &AppHandle<R>, monitor: Rect,
) -> Option<DesktopActivityOverlayDisplayContext> {
    use tauri::Manager;
    let state=app.try_state::<super::ActivityOverlayState>()?;
    super::displays::inventory(app,&state,false).ok()?.into_iter()
        .find(|display|rects_match(display.rect,monitor)).and_then(|display|display.display_context)
}

#[cfg(target_os = "macos")]
pub(crate) fn build_display_context_for_screen(
    screen: &happier_desktop_native::display::Display,
    screen_frame: Rect,
) -> Option<DesktopActivityOverlayDisplayContext> {
    // Preserve the overlay's existing missing-native-identity behavior.
    screen.cg_display_id?;

    Some(DesktopActivityOverlayDisplayContext {
        is_macos: true,
        is_builtin_display: screen.is_builtin,
        has_physical_notch: screen.has_physical_notch,
        safe_area_top: screen.safe_area_top,
        physical_notch_size: screen.physical_notch_size.map(|size| {
            DesktopActivityOverlayPhysicalNotchSize {
                width: size.width,
                height: size.height,
            }
        }),
        display_identity: Some(screen.identity.clone().into()),
        screen_frame,
        visible_frame: rect_from_core(screen.visible_frame),
    })
}

#[cfg(test)]
fn derive_physical_notch_size(
    screen_frame: Rect,
    safe_area_top: f64,
    auxiliary_top_left: Rect,
    auxiliary_top_right: Rect,
    has_physical_notch: bool,
) -> Option<DesktopActivityOverlayPhysicalNotchSize> {
    happier_desktop_native::geometry::derive_physical_notch_size(
        core_rect(screen_frame),
        safe_area_top,
        core_rect(auxiliary_top_left),
        core_rect(auxiliary_top_right),
        has_physical_notch,
    )
    .map(|size| DesktopActivityOverlayPhysicalNotchSize {
        width: size.width,
        height: size.height,
    })
}

#[cfg(test)]
fn core_rect(rect: Rect) -> happier_desktop_native::geometry::Rect {
    happier_desktop_native::geometry::Rect {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
    }
}

#[cfg(target_os = "macos")]
fn rect_from_core(rect: happier_desktop_native::geometry::Rect) -> Rect {
    Rect {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
    }
}

fn rects_match(left: Rect, right: Rect) -> bool {
    (left.x - right.x).abs() < 0.5
        && (left.y - right.y).abs() < 0.5
        && (left.width - right.width).abs() < 0.5
        && (left.height - right.height).abs() < 0.5
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
