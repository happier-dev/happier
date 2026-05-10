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
    BuiltIn,
    Focused,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ResolvedOverlayAnchorMonitorRect {
    pub(crate) source: DesktopActivityOverlayMonitorSource,
    pub(crate) rect: Rect,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DesktopActivityOverlayDisplayMode {
    #[default]
    Automatic,
    Focused,
    Main,
    BuiltIn,
}

pub(crate) fn resolve_overlay_anchor_monitor_resolution(
    display_mode: DesktopActivityOverlayDisplayMode,
    placement_mode: DesktopActivityOverlayPlacementMode,
    main_window_monitor: Option<Rect>,
    overlay_window_monitor: Option<Rect>,
    primary_monitor: Option<Rect>,
    built_in_monitor: Option<Rect>,
    focused_monitor: Option<Rect>,
) -> Result<ResolvedOverlayAnchorMonitorRect, String> {
    match display_mode {
        DesktopActivityOverlayDisplayMode::Automatic => {
            resolve_overlay_anchor_monitor_resolution_for_placement_mode(
                placement_mode,
                main_window_monitor,
                overlay_window_monitor,
                primary_monitor,
            )
        }
        DesktopActivityOverlayDisplayMode::Focused => first_monitor([
            (
                DesktopActivityOverlayMonitorSource::Focused,
                focused_monitor,
            ),
            (
                DesktopActivityOverlayMonitorSource::MainWindow,
                main_window_monitor,
            ),
            (
                DesktopActivityOverlayMonitorSource::OverlayWindow,
                overlay_window_monitor,
            ),
            (
                DesktopActivityOverlayMonitorSource::Primary,
                primary_monitor,
            ),
        ]),
        DesktopActivityOverlayDisplayMode::Main => first_monitor([
            (
                DesktopActivityOverlayMonitorSource::MainWindow,
                main_window_monitor,
            ),
            (
                DesktopActivityOverlayMonitorSource::Focused,
                focused_monitor,
            ),
            (
                DesktopActivityOverlayMonitorSource::OverlayWindow,
                overlay_window_monitor,
            ),
            (
                DesktopActivityOverlayMonitorSource::Primary,
                primary_monitor,
            ),
        ]),
        DesktopActivityOverlayDisplayMode::BuiltIn => first_monitor([
            (
                DesktopActivityOverlayMonitorSource::BuiltIn,
                built_in_monitor,
            ),
            (
                DesktopActivityOverlayMonitorSource::MainWindow,
                main_window_monitor,
            ),
            (
                DesktopActivityOverlayMonitorSource::OverlayWindow,
                overlay_window_monitor,
            ),
            (
                DesktopActivityOverlayMonitorSource::Primary,
                primary_monitor,
            ),
        ]),
    }
}

fn first_monitor<const N: usize>(
    candidates: [(DesktopActivityOverlayMonitorSource, Option<Rect>); N],
) -> Result<ResolvedOverlayAnchorMonitorRect, String> {
    for (source, rect) in candidates {
        if let Some(rect) = rect {
            return Ok(ResolvedOverlayAnchorMonitorRect { source, rect });
        }
    }

    Err("Unable to resolve a monitor for desktop activity overlay".to_string())
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

fn point_inside_rect(x: f64, y: f64, rect: Rect) -> bool {
    x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height
}

fn distance_from_point_to_rect(x: f64, y: f64, rect: Rect) -> f64 {
    let clamped_x = clamp(x, rect.x, rect.x + rect.width);
    let clamped_y = clamp(y, rect.y, rect.y + rect.height);
    (x - clamped_x).hypot(y - clamped_y)
}

pub(crate) fn resolve_overlay_monitor_for_position(
    monitors: &[Rect],
    fallback_monitor: Rect,
    position: OverlayPlacementRect,
    overlay: Rect,
) -> Rect {
    let center_x = position.x + overlay.width / 2.0;
    let center_y = position.y + overlay.height / 2.0;

    monitors
        .iter()
        .copied()
        .find(|monitor| point_inside_rect(center_x, center_y, *monitor))
        .or_else(|| {
            monitors.iter().copied().min_by(|left, right| {
                distance_from_point_to_rect(center_x, center_y, *left)
                    .partial_cmp(&distance_from_point_to_rect(center_x, center_y, *right))
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
        })
        .unwrap_or(fallback_monitor)
}

pub(crate) fn resolve_overlay_offsets_from_absolute_position(
    monitor: Rect,
    overlay: Rect,
    anchor: DesktopActivityOverlayAnchor,
    policy_offset_x: f64,
    policy_offset_y: f64,
    position: OverlayPlacementRect,
    padding: f64,
) -> (f64, f64) {
    let base = resolve_overlay_placement(
        monitor,
        overlay,
        anchor,
        policy_offset_x,
        policy_offset_y,
        padding,
    );

    (
        sanitize_offset(position.x - base.x),
        sanitize_offset(position.y - base.y),
    )
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
    fn placement_clamp_boundary_fuzz_stays_inside_monitor() {
        let monitors = [
            Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 982.0,
            },
            Rect {
                x: -1440.0,
                y: 80.0,
                width: 1440.0,
                height: 900.0,
            },
        ];
        let overlays = [
            Rect {
                x: 0.0,
                y: 0.0,
                width: 320.0,
                height: 72.0,
            },
            Rect {
                x: 0.0,
                y: 0.0,
                width: 2400.0,
                height: 1200.0,
            },
        ];
        let offsets = [
            -10_000.0,
            -4096.0,
            0.0,
            4096.0,
            10_000.0,
            f64::INFINITY,
            f64::NAN,
        ];
        let anchors = [
            DesktopActivityOverlayAnchor::TopCenter,
            DesktopActivityOverlayAnchor::TopLeft,
            DesktopActivityOverlayAnchor::TopRight,
            DesktopActivityOverlayAnchor::BottomCenter,
            DesktopActivityOverlayAnchor::BottomLeft,
            DesktopActivityOverlayAnchor::BottomRight,
            DesktopActivityOverlayAnchor::LeftCenter,
            DesktopActivityOverlayAnchor::RightCenter,
        ];

        for monitor in monitors {
            for overlay in overlays {
                for anchor in anchors {
                    for offset_x in offsets {
                        for offset_y in offsets {
                            let placement = resolve_overlay_placement(
                                monitor, overlay, anchor, offset_x, offset_y, 12.0,
                            );
                            let min_x = monitor.x + 12.0;
                            let min_y = monitor.y + 12.0;
                            let max_x =
                                (monitor.x + monitor.width - overlay.width - 12.0).max(min_x);
                            let max_y =
                                (monitor.y + monitor.height - overlay.height - 12.0).max(min_y);

                            assert!(placement.x.is_finite());
                            assert!(placement.y.is_finite());
                            assert!(placement.x >= min_x - 0.001);
                            assert!(placement.x <= max_x + 0.001);
                            assert!(placement.y >= min_y - 0.001);
                            assert!(placement.y <= max_y + 0.001);
                        }
                    }
                }
            }
        }
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
    fn drag_target_monitor_switches_when_overlay_center_crosses_display_boundary() {
        let left = Rect {
            x: 0.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
        };
        let right = Rect {
            x: 800.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
        };
        let overlay = Rect {
            x: 0.0,
            y: 0.0,
            width: 160.0,
            height: 96.0,
        };

        let target = resolve_overlay_monitor_for_position(
            &[left, right],
            left,
            OverlayPlacementRect { x: 760.0, y: 250.0 },
            overlay,
        );

        assert_eq!(target, right);
    }

    #[test]
    fn drag_offsets_from_absolute_position_preserve_cross_monitor_window_position() {
        let monitor = Rect {
            x: 800.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
        };
        let overlay = Rect {
            x: 0.0,
            y: 0.0,
            width: 160.0,
            height: 96.0,
        };

        let offsets = resolve_overlay_offsets_from_absolute_position(
            monitor,
            overlay,
            DesktopActivityOverlayAnchor::BottomRight,
            0.0,
            0.0,
            OverlayPlacementRect { x: 860.0, y: 420.0 },
            16.0,
        );

        assert_eq!(offsets, (-564.0, -68.0));
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

    #[test]
    fn display_mode_can_prefer_the_builtin_monitor_without_relying_on_react_geometry() {
        let resolved = resolve_overlay_anchor_monitor_resolution(
            DesktopActivityOverlayDisplayMode::BuiltIn,
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
                x: 3000.0,
                y: 0.0,
                width: 1280.0,
                height: 800.0,
            }),
            Some(Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 982.0,
            }),
            None,
        )
        .expect("expected a resolved monitor");

        assert_eq!(
            resolved.source,
            DesktopActivityOverlayMonitorSource::BuiltIn
        );
        assert_eq!(resolved.rect.width, 1512.0);
    }

    #[test]
    fn display_mode_can_follow_the_focused_monitor_when_available() {
        let resolved = resolve_overlay_anchor_monitor_resolution(
            DesktopActivityOverlayDisplayMode::Focused,
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
                width: 1512.0,
                height: 982.0,
            }),
            None,
            Some(Rect {
                x: 3000.0,
                y: 0.0,
                width: 1280.0,
                height: 800.0,
            }),
        )
        .expect("expected a resolved monitor");

        assert_eq!(
            resolved.source,
            DesktopActivityOverlayMonitorSource::Focused
        );
        assert_eq!(resolved.rect.x, 3000.0);
    }
}
