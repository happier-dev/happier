use serde::{Deserialize, Serialize};

use super::placement::{DesktopPetOverlayAnchor, DesktopPetOverlayPosition, Rect};

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetOverlayPlacementDiagnosticsPayload {
    pub effective_monitor: RectPayload,
    pub anchor: DesktopPetOverlayAnchor,
    pub computed_position: PositionPayload,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RectPayload {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PositionPayload {
    pub x: f64,
    pub y: f64,
}

pub(crate) fn build_pet_overlay_placement_diagnostics(
    monitor: Rect,
    anchor: DesktopPetOverlayAnchor,
    position: DesktopPetOverlayPosition,
) -> DesktopPetOverlayPlacementDiagnosticsPayload {
    DesktopPetOverlayPlacementDiagnosticsPayload {
        effective_monitor: RectPayload {
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        },
        anchor,
        computed_position: PositionPayload {
            x: position.x,
            y: position.y,
        },
    }
}
