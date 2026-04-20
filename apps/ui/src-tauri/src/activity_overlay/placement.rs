use super::{DesktopActivityOverlayAnchor, DesktopActivityOverlayPlacementMode};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Rect {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) width: f64,
    pub(crate) height: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OverlayPlacementRect {
    pub(crate) x: f64,
    pub(crate) y: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DesktopActivityOverlayMonitorSource {
    MainWindow,
    OverlayWindow,
    Primary,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ResolvedOverlayAnchorMonitorRect {
    pub(crate) source: DesktopActivityOverlayMonitorSource,
    pub(crate) rect: Rect,
}

pub(crate) fn resolve_overlay_anchor_monitor_resolution_for_placement_mode(
    placement_mode: DesktopActivityOverlayPlacementMode,
    main_window_monitor: Option<Rect>,
    overlay_window_monitor: Option<Rect>,
    primary_monitor: Option<Rect>,
) -> Result<ResolvedOverlayAnchorMonitorRect, String> {
    match placement_mode {
        DesktopActivityOverlayPlacementMode::Anchored => {
            if let Some(monitor) = main_window_monitor {
                return Ok(ResolvedOverlayAnchorMonitorRect {
                    source: DesktopActivityOverlayMonitorSource::MainWindow,
                    rect: monitor,
                });
            }
            if let Some(monitor) = overlay_window_monitor {
                return Ok(ResolvedOverlayAnchorMonitorRect {
                    source: DesktopActivityOverlayMonitorSource::OverlayWindow,
                    rect: monitor,
                });
            }
            if let Some(monitor) = primary_monitor {
                return Ok(ResolvedOverlayAnchorMonitorRect {
                    source: DesktopActivityOverlayMonitorSource::Primary,
                    rect: monitor,
                });
            }
        }
        DesktopActivityOverlayPlacementMode::Custom => {
            if let Some(monitor) = overlay_window_monitor {
                return Ok(ResolvedOverlayAnchorMonitorRect {
                    source: DesktopActivityOverlayMonitorSource::OverlayWindow,
                    rect: monitor,
                });
            }
            if let Some(monitor) = main_window_monitor {
                return Ok(ResolvedOverlayAnchorMonitorRect {
                    source: DesktopActivityOverlayMonitorSource::MainWindow,
                    rect: monitor,
                });
            }
            if let Some(monitor) = primary_monitor {
                return Ok(ResolvedOverlayAnchorMonitorRect {
                    source: DesktopActivityOverlayMonitorSource::Primary,
                    rect: monitor,
                });
            }
        }
    }

    Err("Unable to resolve a monitor for desktop activity overlay".to_string())
}

pub(crate) fn resolve_overlay_placement(
    monitor: Rect,
    overlay: Rect,
    anchor: DesktopActivityOverlayAnchor,
    offset_x: f64,
    offset_y: f64,
    padding: f64,
) -> OverlayPlacementRect {
    let offset_x = sanitize_offset(offset_x);
    let offset_y = sanitize_offset(offset_y);
    let center_x = monitor.x + (monitor.width - overlay.width) / 2.0;
    let center_y = monitor.y + (monitor.height - overlay.height) / 2.0;

    let (base_x, base_y) = match anchor {
        DesktopActivityOverlayAnchor::TopCenter => (center_x, monitor.y + padding),
        DesktopActivityOverlayAnchor::TopLeft => (monitor.x + padding, monitor.y + padding),
        DesktopActivityOverlayAnchor::TopRight => (
            monitor.x + monitor.width - overlay.width - padding,
            monitor.y + padding,
        ),
        DesktopActivityOverlayAnchor::BottomCenter => (
            center_x,
            monitor.y + monitor.height - overlay.height - padding,
        ),
        DesktopActivityOverlayAnchor::BottomLeft => (
            monitor.x + padding,
            monitor.y + monitor.height - overlay.height - padding,
        ),
        DesktopActivityOverlayAnchor::BottomRight => (
            monitor.x + monitor.width - overlay.width - padding,
            monitor.y + monitor.height - overlay.height - padding,
        ),
        DesktopActivityOverlayAnchor::LeftCenter => (monitor.x + padding, center_y),
        DesktopActivityOverlayAnchor::RightCenter => (
            monitor.x + monitor.width - overlay.width - padding,
            center_y,
        ),
    };

    let min_x = monitor.x + padding;
    let min_y = monitor.y + padding;
    let max_x = monitor.x + monitor.width - overlay.width - padding;
    let max_y = monitor.y + monitor.height - overlay.height - padding;

    OverlayPlacementRect {
        x: clamp(base_x + offset_x, min_x, max_x.max(min_x)),
        y: clamp(base_y + offset_y, min_y, max_y.max(min_y)),
    }
}

pub(crate) fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if !value.is_finite() {
        return min;
    }
    if value < min {
        return min;
    }
    if value > max {
        return max;
    }
    value
}

pub(crate) fn sanitize_offset(value: f64) -> f64 {
    if value.is_finite() {
        return value;
    }
    0.0
}

pub(crate) fn sanitize_dimension(value: f64, fallback: f64, min: f64, max: f64) -> f64 {
    let raw = if value.is_finite() { value } else { fallback };
    clamp(raw, min, max)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_top_center_overlay_placement() {
        let monitor = Rect {
            x: 0.0,
            y: 0.0,
            width: 1400.0,
            height: 900.0,
        };
        let overlay = Rect {
            x: 0.0,
            y: 0.0,
            width: 360.0,
            height: 72.0,
        };

        let placement = resolve_overlay_placement(
            monitor,
            overlay,
            DesktopActivityOverlayAnchor::TopCenter,
            12.0,
            8.0,
            10.0,
        );
        assert!((placement.x - 532.0).abs() < 0.001);
        assert!((placement.y - 18.0).abs() < 0.001);
    }

    #[test]
    fn clamps_overlay_placement_to_monitor_bounds() {
        let monitor = Rect {
            x: 100.0,
            y: 40.0,
            width: 800.0,
            height: 600.0,
        };
        let overlay = Rect {
            x: 0.0,
            y: 0.0,
            width: 520.0,
            height: 220.0,
        };

        let placement = resolve_overlay_placement(
            monitor,
            overlay,
            DesktopActivityOverlayAnchor::BottomRight,
            9999.0,
            9999.0,
            16.0,
        );
        assert!((placement.x - 364.0).abs() < 0.001);
        assert!((placement.y - 404.0).abs() < 0.001);
    }

    #[test]
    fn resolves_overlay_placement_with_non_finite_offsets() {
        let monitor = Rect {
            x: 0.0,
            y: 0.0,
            width: 1400.0,
            height: 900.0,
        };
        let overlay = Rect {
            x: 0.0,
            y: 0.0,
            width: 360.0,
            height: 72.0,
        };

        let placement = resolve_overlay_placement(
            monitor,
            overlay,
            DesktopActivityOverlayAnchor::TopCenter,
            f64::NAN,
            f64::INFINITY,
            10.0,
        );

        assert!(placement.x.is_finite());
        assert!(placement.y.is_finite());
        assert!((placement.x - 520.0).abs() < 0.001);
        assert!((placement.y - 10.0).abs() < 0.001);
    }

    #[test]
    fn resolves_overlay_top_center_on_a_non_zero_origin_monitor() {
        let monitor = Rect {
            x: 3000.0,
            y: 0.0,
            width: 1280.0,
            height: 800.0,
        };
        let overlay = Rect {
            x: 0.0,
            y: 0.0,
            width: 360.0,
            height: 72.0,
        };

        let placement = resolve_overlay_placement(
            monitor,
            overlay,
            DesktopActivityOverlayAnchor::TopCenter,
            0.0,
            0.0,
            10.0,
        );

        assert!((placement.x - 3460.0).abs() < 0.001);
        assert!((placement.y - 10.0).abs() < 0.001);
    }

    #[test]
    fn anchored_prefers_main_window_monitor_for_overlay_anchor_resolution() {
        let resolved = resolve_overlay_anchor_monitor_resolution_for_placement_mode(
            DesktopActivityOverlayPlacementMode::Anchored,
            Some(Rect {
                x: 200.0,
                y: 40.0,
                width: 1600.0,
                height: 1000.0,
            }),
            Some(Rect {
                x: 3000.0,
                y: 0.0,
                width: 1280.0,
                height: 800.0,
            }),
            Some(Rect {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            }),
        )
        .expect("expected a resolved monitor");

        assert_eq!(
            resolved.source,
            DesktopActivityOverlayMonitorSource::MainWindow
        );
        assert!((resolved.rect.x - 200.0).abs() < 0.001);
    }

    #[test]
    fn anchored_falls_back_to_overlay_window_monitor_when_the_main_window_monitor_is_unavailable() {
        let resolved = resolve_overlay_anchor_monitor_resolution_for_placement_mode(
            DesktopActivityOverlayPlacementMode::Anchored,
            None,
            Some(Rect {
                x: 3000.0,
                y: 0.0,
                width: 1280.0,
                height: 800.0,
            }),
            Some(Rect {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            }),
        )
        .expect("expected a resolved monitor");

        assert_eq!(
            resolved.source,
            DesktopActivityOverlayMonitorSource::OverlayWindow
        );
        assert!((resolved.rect.x - 3000.0).abs() < 0.001);
    }

    #[test]
    fn custom_prefers_overlay_window_monitor_for_overlay_anchor_resolution() {
        let resolved = resolve_overlay_anchor_monitor_resolution_for_placement_mode(
            DesktopActivityOverlayPlacementMode::Custom,
            Some(Rect {
                x: 200.0,
                y: 40.0,
                width: 1600.0,
                height: 1000.0,
            }),
            Some(Rect {
                x: 3000.0,
                y: 0.0,
                width: 1280.0,
                height: 800.0,
            }),
            Some(Rect {
                x: 0.0,
                y: 0.0,
                width: 1920.0,
                height: 1080.0,
            }),
        )
        .expect("expected a resolved monitor");

        assert_eq!(
            resolved.source,
            DesktopActivityOverlayMonitorSource::OverlayWindow
        );
        assert!((resolved.rect.x - 3000.0).abs() < 0.001);
    }
}
