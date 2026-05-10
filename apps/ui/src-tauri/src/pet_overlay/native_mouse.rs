use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct DesktopPetOverlayNativeMousePoint {
    pub(crate) x: f64,
    pub(crate) y: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct DesktopPetOverlayNativeWindowFrame {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopPetOverlayNativeMousePayload {
    pub(crate) inside: bool,
    pub(crate) x: f64,
    pub(crate) y: f64,
}

pub(crate) fn resolve_pet_overlay_native_mouse_payload(
    frame: DesktopPetOverlayNativeWindowFrame,
    point: DesktopPetOverlayNativeMousePoint,
) -> DesktopPetOverlayNativeMousePayload {
    let relative_x = point.x - frame.x;
    let relative_y_from_bottom = point.y - frame.y;
    let inside = relative_x >= 0.0
        && relative_x <= frame.width
        && relative_y_from_bottom >= 0.0
        && relative_y_from_bottom <= frame.height;

    if !inside {
        return DesktopPetOverlayNativeMousePayload {
            inside: false,
            x: 0.0,
            y: 0.0,
        };
    }

    DesktopPetOverlayNativeMousePayload {
        inside: true,
        x: relative_x,
        y: frame.height - relative_y_from_bottom,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_appkit_bottom_left_mouse_coordinates_to_overlay_top_left_coordinates() {
        let payload = resolve_pet_overlay_native_mouse_payload(
            DesktopPetOverlayNativeWindowFrame {
                x: 100.0,
                y: 200.0,
                width: 300.0,
                height: 160.0,
            },
            DesktopPetOverlayNativeMousePoint { x: 124.0, y: 328.0 },
        );

        assert_eq!(
            payload,
            DesktopPetOverlayNativeMousePayload {
                inside: true,
                x: 24.0,
                y: 32.0,
            },
        );
    }

    #[test]
    fn reports_outside_mouse_points_without_stale_coordinates() {
        let payload = resolve_pet_overlay_native_mouse_payload(
            DesktopPetOverlayNativeWindowFrame {
                x: 100.0,
                y: 200.0,
                width: 300.0,
                height: 160.0,
            },
            DesktopPetOverlayNativeMousePoint { x: 99.0, y: 328.0 },
        );

        assert_eq!(
            payload,
            DesktopPetOverlayNativeMousePayload {
                inside: false,
                x: 0.0,
                y: 0.0,
            },
        );
    }
}
