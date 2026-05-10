use serde::{Deserialize, Serialize};

use super::placement::{
    resolve_pet_overlay_placement, DesktopPetOverlayAnchor, DesktopPetOverlayPosition, Rect, Size,
};
use super::storage::PersistedPetOverlayDragOffset;

const MEASURED_LAYOUT_MIN_AXIS_PX: f64 = 1.0;
const MEASURED_LAYOUT_MAX_AXIS_PX: f64 = 2_048.0;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetOverlayMeasuredSizePayload {
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetOverlayRelativeRectPayload {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetOverlayMeasuredContentMetricsPayload {
    pub is_tray_visible: bool,
    pub mascot: DesktopPetOverlayRelativeRectPayload,
    pub tray: Option<DesktopPetOverlayRelativeRectPayload>,
    pub controls: Option<DesktopPetOverlayRelativeRectPayload>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct DesktopPetOverlayMeasuredLayoutInput {
    pub expanded: bool,
    pub anchor: DesktopPetOverlayAnchor,
    pub monitor: Rect,
    pub drag_offset: PersistedPetOverlayDragOffset,
    pub placement_padding: f64,
    pub metrics: DesktopPetOverlayMeasuredContentMetricsPayload,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetOverlayMeasuredLayoutPayload {
    pub window: DesktopPetOverlayRelativeRectPayload,
    pub mascot: DesktopPetOverlayRelativeRectPayload,
    pub tray: Option<DesktopPetOverlayRelativeRectPayload>,
    pub controls: Option<DesktopPetOverlayRelativeRectPayload>,
    pub placement: DesktopPetOverlayMeasuredLayoutPlacement,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DesktopPetOverlayMeasuredLayoutPlacement {
    Compact,
    TopStart,
    TopEnd,
    BottomStart,
    BottomEnd,
}

pub(crate) fn resolve_desktop_pet_overlay_measured_layout(
    input: DesktopPetOverlayMeasuredLayoutInput,
) -> DesktopPetOverlayMeasuredLayoutPayload {
    let mascot = sanitize_required_measured_rect(input.metrics.mascot);
    let tray = if input.expanded && input.metrics.is_tray_visible {
        input.metrics.tray.and_then(sanitize_optional_measured_rect)
    } else {
        None
    };
    let controls = input
        .metrics
        .controls
        .and_then(sanitize_optional_measured_rect);
    let tray_size = tray.map(rect_size);

    let tray_above_mascot = matches!(
        input.anchor,
        DesktopPetOverlayAnchor::BottomRight | DesktopPetOverlayAnchor::BottomLeft
    );
    let normalized = normalize_relative_layout(mascot, tray, controls);
    let window_size = normalized.window_size;
    let position = resolve_pet_overlay_placement(
        input.monitor,
        Size {
            width: window_size.width,
            height: window_size.height,
        },
        input.anchor,
        input.drag_offset.x,
        input.drag_offset.y,
        input.placement_padding,
    );

    DesktopPetOverlayMeasuredLayoutPayload {
        window: position_to_window_bounds(position, window_size),
        mascot: normalized.mascot,
        tray: normalized.tray,
        controls: normalized.controls,
        placement: resolve_layout_placement(input.anchor, tray_size, tray_above_mascot),
    }
}

fn resolve_layout_placement(
    anchor: DesktopPetOverlayAnchor,
    tray_size: Option<DesktopPetOverlayMeasuredSizePayload>,
    tray_above_mascot: bool,
) -> DesktopPetOverlayMeasuredLayoutPlacement {
    if tray_size.is_none() {
        return DesktopPetOverlayMeasuredLayoutPlacement::Compact;
    }

    match (anchor, tray_above_mascot) {
        (DesktopPetOverlayAnchor::BottomLeft | DesktopPetOverlayAnchor::TopLeft, true) => {
            DesktopPetOverlayMeasuredLayoutPlacement::TopStart
        }
        (DesktopPetOverlayAnchor::BottomRight | DesktopPetOverlayAnchor::TopRight, true) => {
            DesktopPetOverlayMeasuredLayoutPlacement::TopEnd
        }
        (DesktopPetOverlayAnchor::BottomLeft | DesktopPetOverlayAnchor::TopLeft, false) => {
            DesktopPetOverlayMeasuredLayoutPlacement::BottomStart
        }
        (DesktopPetOverlayAnchor::BottomRight | DesktopPetOverlayAnchor::TopRight, false) => {
            DesktopPetOverlayMeasuredLayoutPlacement::BottomEnd
        }
    }
}

struct NormalizedRelativeLayout {
    window_size: DesktopPetOverlayMeasuredSizePayload,
    mascot: DesktopPetOverlayRelativeRectPayload,
    tray: Option<DesktopPetOverlayRelativeRectPayload>,
    controls: Option<DesktopPetOverlayRelativeRectPayload>,
}

fn normalize_relative_layout(
    mascot: DesktopPetOverlayRelativeRectPayload,
    tray: Option<DesktopPetOverlayRelativeRectPayload>,
    controls: Option<DesktopPetOverlayRelativeRectPayload>,
) -> NormalizedRelativeLayout {
    let rects = [Some(mascot), tray, controls];
    let mut min_x = mascot.x;
    let mut min_y = mascot.y;
    let mut max_x = mascot.x + mascot.width;
    let mut max_y = mascot.y + mascot.height;
    for rect in rects.into_iter().flatten() {
        min_x = min_x.min(rect.x);
        min_y = min_y.min(rect.y);
        max_x = max_x.max(rect.x + rect.width);
        max_y = max_y.max(rect.y + rect.height);
    }

    let shift_x = -min_x;
    let shift_y = -min_y;
    NormalizedRelativeLayout {
        window_size: DesktopPetOverlayMeasuredSizePayload {
            width: (max_x - min_x).max(MEASURED_LAYOUT_MIN_AXIS_PX),
            height: (max_y - min_y).max(MEASURED_LAYOUT_MIN_AXIS_PX),
        },
        mascot: shift_rect(mascot, shift_x, shift_y),
        tray: tray.map(|rect| shift_rect(rect, shift_x, shift_y)),
        controls: controls.map(|rect| shift_rect(rect, shift_x, shift_y)),
    }
}

fn shift_rect(
    rect: DesktopPetOverlayRelativeRectPayload,
    shift_x: f64,
    shift_y: f64,
) -> DesktopPetOverlayRelativeRectPayload {
    DesktopPetOverlayRelativeRectPayload {
        x: rect.x + shift_x,
        y: rect.y + shift_y,
        width: rect.width,
        height: rect.height,
    }
}

fn sanitize_required_measured_rect(
    rect: DesktopPetOverlayRelativeRectPayload,
) -> DesktopPetOverlayRelativeRectPayload {
    DesktopPetOverlayRelativeRectPayload {
        x: sanitize_required_measured_position(rect.x),
        y: sanitize_required_measured_position(rect.y),
        width: sanitize_required_measured_axis(rect.width),
        height: sanitize_required_measured_axis(rect.height),
    }
}

fn rect_size(rect: DesktopPetOverlayRelativeRectPayload) -> DesktopPetOverlayMeasuredSizePayload {
    DesktopPetOverlayMeasuredSizePayload {
        width: rect.width,
        height: rect.height,
    }
}

fn sanitize_optional_measured_rect(
    rect: DesktopPetOverlayRelativeRectPayload,
) -> Option<DesktopPetOverlayRelativeRectPayload> {
    if !rect.x.is_finite()
        || !rect.y.is_finite()
        || !rect.width.is_finite()
        || !rect.height.is_finite()
        || rect.width <= 0.0
        || rect.height <= 0.0
    {
        return None;
    }
    Some(DesktopPetOverlayRelativeRectPayload {
        x: sanitize_required_measured_position(rect.x),
        y: sanitize_required_measured_position(rect.y),
        width: rect.width.min(MEASURED_LAYOUT_MAX_AXIS_PX),
        height: rect.height.min(MEASURED_LAYOUT_MAX_AXIS_PX),
    })
}

fn sanitize_required_measured_position(value: f64) -> f64 {
    if !value.is_finite() {
        return 0.0;
    }
    value.clamp(-MEASURED_LAYOUT_MAX_AXIS_PX, MEASURED_LAYOUT_MAX_AXIS_PX)
}

fn sanitize_required_measured_axis(value: f64) -> f64 {
    if !value.is_finite() {
        return MEASURED_LAYOUT_MIN_AXIS_PX;
    }
    value.clamp(MEASURED_LAYOUT_MIN_AXIS_PX, MEASURED_LAYOUT_MAX_AXIS_PX)
}

fn position_to_window_bounds(
    position: DesktopPetOverlayPosition,
    size: DesktopPetOverlayMeasuredSizePayload,
) -> DesktopPetOverlayRelativeRectPayload {
    DesktopPetOverlayRelativeRectPayload {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pet_overlay::placement::{DesktopPetOverlayAnchor, Rect};
    use crate::pet_overlay::storage::PersistedPetOverlayDragOffset;

    fn base_input(
        anchor: DesktopPetOverlayAnchor,
        expanded: bool,
        metrics: DesktopPetOverlayMeasuredContentMetricsPayload,
    ) -> DesktopPetOverlayMeasuredLayoutInput {
        DesktopPetOverlayMeasuredLayoutInput {
            expanded,
            anchor,
            monitor: Rect {
                x: 0.0,
                y: 0.0,
                width: 800.0,
                height: 600.0,
            },
            drag_offset: PersistedPetOverlayDragOffset::default(),
            placement_padding: 12.0,
            metrics,
        }
    }

    fn rect(width: f64, height: f64) -> DesktopPetOverlayRelativeRectPayload {
        DesktopPetOverlayRelativeRectPayload {
            x: 0.0,
            y: 0.0,
            width,
            height,
        }
    }

    fn rect_at(x: f64, y: f64, width: f64, height: f64) -> DesktopPetOverlayRelativeRectPayload {
        DesktopPetOverlayRelativeRectPayload {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn metrics_payload_preserves_the_renderer_rect_contract() {
        let payload: DesktopPetOverlayMeasuredContentMetricsPayload =
            serde_json::from_value(serde_json::json!({
                "isTrayVisible": true,
                "mascot": { "x": 240.0, "y": 188.0, "width": 116.0, "height": 124.0 },
                "tray": { "x": 24.0, "y": 28.0, "width": 276.0, "height": 112.0 },
                "controls": { "x": 310.0, "y": 176.0, "width": 30.0, "height": 30.0 }
            }))
            .expect("renderer metrics payload should deserialize");

        assert_eq!(
            serde_json::to_value(payload).expect("metrics should serialize"),
            serde_json::json!({
                "isTrayVisible": true,
                "mascot": { "x": 240.0, "y": 188.0, "width": 116.0, "height": 124.0 },
                "tray": { "x": 24.0, "y": 28.0, "width": 276.0, "height": 112.0 },
                "controls": { "x": 310.0, "y": 176.0, "width": 30.0, "height": 30.0 }
            }),
        );
    }

    #[test]
    fn compact_layout_uses_measured_mascot_as_the_native_window() {
        let layout = resolve_desktop_pet_overlay_measured_layout(base_input(
            DesktopPetOverlayAnchor::BottomRight,
            false,
            DesktopPetOverlayMeasuredContentMetricsPayload {
                is_tray_visible: false,
                mascot: rect(96.0, 80.0),
                tray: None,
                controls: None,
            },
        ));

        assert_eq!(layout.window.x, 692.0);
        assert_eq!(layout.window.y, 508.0);
        assert_eq!(
            layout.window,
            DesktopPetOverlayRelativeRectPayload {
                x: 692.0,
                y: 508.0,
                width: 96.0,
                height: 80.0,
            },
        );
        assert_eq!(
            layout.mascot,
            DesktopPetOverlayRelativeRectPayload {
                x: 0.0,
                y: 0.0,
                width: 96.0,
                height: 80.0,
            },
        );
        assert_eq!(layout.tray, None);
        assert_eq!(layout.controls, None);
        assert_eq!(
            layout.placement,
            DesktopPetOverlayMeasuredLayoutPlacement::Compact,
        );
    }

    #[test]
    fn bottom_edge_tray_layout_places_tray_above_the_mascot() {
        let layout = resolve_desktop_pet_overlay_measured_layout(base_input(
            DesktopPetOverlayAnchor::BottomRight,
            true,
            DesktopPetOverlayMeasuredContentMetricsPayload {
                is_tray_visible: true,
                mascot: rect_at(166.0, 112.0, 96.0, 80.0),
                tray: Some(rect_at(0.0, 0.0, 240.0, 100.0)),
                controls: Some(rect_at(218.0, 112.0, 44.0, 32.0)),
            },
        ));

        assert_eq!(layout.window.y, 396.0);
        assert_eq!(layout.window.width, 262.0);
        assert_eq!(
            layout.mascot.x,
            166.0,
            "expanded overlays should right-align the mascot under the tray with the same shoulder bias as the React surfaces",
        );
        assert_eq!(
            layout.tray,
            Some(DesktopPetOverlayRelativeRectPayload {
                x: 0.0,
                y: 0.0,
                width: 240.0,
                height: 100.0,
            }),
        );
        assert_eq!(layout.mascot.y, 112.0);
        assert_eq!(
            layout.controls.expect("controls should be laid out").y,
            112.0
        );
        assert_eq!(
            layout.placement,
            DesktopPetOverlayMeasuredLayoutPlacement::TopEnd,
        );
    }

    #[test]
    fn expanded_layout_uses_renderer_measured_rect_positions_for_window_bounds() {
        let layout = resolve_desktop_pet_overlay_measured_layout(base_input(
            DesktopPetOverlayAnchor::BottomRight,
            true,
            DesktopPetOverlayMeasuredContentMetricsPayload {
                is_tray_visible: true,
                mascot: rect_at(220.0, 178.0, 116.0, 124.0),
                tray: Some(rect_at(22.0, 44.0, 276.0, 132.0)),
                controls: Some(rect_at(284.0, 150.0, 30.0, 30.0)),
            },
        ));

        assert_eq!(
            layout.window,
            DesktopPetOverlayRelativeRectPayload {
                x: 474.0,
                y: 330.0,
                width: 314.0,
                height: 258.0,
            },
        );
        assert_eq!(
            layout.tray,
            Some(DesktopPetOverlayRelativeRectPayload {
                x: 0.0,
                y: 0.0,
                width: 276.0,
                height: 132.0,
            }),
        );
        assert_eq!(
            layout.mascot,
            DesktopPetOverlayRelativeRectPayload {
                x: 198.0,
                y: 134.0,
                width: 116.0,
                height: 124.0,
            },
        );
        assert_eq!(
            layout.controls,
            Some(DesktopPetOverlayRelativeRectPayload {
                x: 262.0,
                y: 106.0,
                width: 30.0,
                height: 30.0,
            }),
        );
    }

    #[test]
    fn top_edge_tray_layout_places_tray_below_the_mascot() {
        let layout = resolve_desktop_pet_overlay_measured_layout(base_input(
            DesktopPetOverlayAnchor::TopRight,
            true,
            DesktopPetOverlayMeasuredContentMetricsPayload {
                is_tray_visible: true,
                mascot: rect_at(166.0, 0.0, 96.0, 80.0),
                tray: Some(rect_at(0.0, 92.0, 240.0, 100.0)),
                controls: None,
            },
        ));

        assert_eq!(layout.window.y, 12.0);
        assert_eq!(layout.mascot.y, 0.0);
        assert_eq!(
            layout.tray,
            Some(DesktopPetOverlayRelativeRectPayload {
                x: 0.0,
                y: 92.0,
                width: 240.0,
                height: 100.0,
            }),
        );
        assert_eq!(
            layout.placement,
            DesktopPetOverlayMeasuredLayoutPlacement::BottomEnd,
        );
    }

    #[test]
    fn measured_layout_clamps_dragged_window_to_monitor_bounds() {
        let layout =
            resolve_desktop_pet_overlay_measured_layout(DesktopPetOverlayMeasuredLayoutInput {
                expanded: false,
                anchor: DesktopPetOverlayAnchor::BottomRight,
                monitor: Rect {
                    x: 100.0,
                    y: 50.0,
                    width: 640.0,
                    height: 480.0,
                },
                drag_offset: PersistedPetOverlayDragOffset {
                    x: 10_000.0,
                    y: 10_000.0,
                    monitor_id: None,
                },
                placement_padding: 12.0,
                metrics: DesktopPetOverlayMeasuredContentMetricsPayload {
                    is_tray_visible: false,
                    mascot: rect(96.0, 80.0),
                    tray: None,
                    controls: None,
                },
            });

        assert_eq!(layout.window.x, 632.0);
        assert_eq!(layout.window.y, 438.0);
    }

    #[test]
    fn invalid_measured_metrics_are_sanitized_before_layout() {
        let layout = resolve_desktop_pet_overlay_measured_layout(base_input(
            DesktopPetOverlayAnchor::BottomRight,
            true,
            DesktopPetOverlayMeasuredContentMetricsPayload {
                is_tray_visible: true,
                mascot: rect(f64::NAN, -20.0),
                tray: Some(rect(f64::INFINITY, 40.0)),
                controls: Some(rect(32.0, f64::NAN)),
            },
        ));

        assert_eq!(
            layout.window,
            DesktopPetOverlayRelativeRectPayload {
                x: 787.0,
                y: 587.0,
                width: 1.0,
                height: 1.0,
            },
        );
        assert_eq!(layout.mascot.width, 1.0);
        assert_eq!(layout.mascot.height, 1.0);
        assert_eq!(layout.tray, None);
        assert_eq!(layout.controls, None);
    }
}
