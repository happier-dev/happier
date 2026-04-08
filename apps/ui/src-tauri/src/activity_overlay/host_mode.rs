use super::{
    DesktopActivityOverlayAnchor, DesktopActivityOverlayPlacementMode,
    DesktopActivityOverlayPresentationMode,
};
use super::placement::{
    clamp, resolve_overlay_placement, sanitize_offset, OverlayPlacementRect, Rect,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DesktopActivityOverlayHostMode {
    Floating,
    NotchIntegrated,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopActivityOverlayDisplayContext {
    pub(crate) is_macos: bool,
    pub(crate) is_builtin_display: bool,
    pub(crate) has_physical_notch: bool,
    pub(crate) safe_area_top: f64,
    pub(crate) screen_frame: Rect,
    pub(crate) visible_frame: Rect,
}

pub(crate) fn resolve_desktop_activity_overlay_host_mode(
    presentation_mode: DesktopActivityOverlayPresentationMode,
    _placement_mode: DesktopActivityOverlayPlacementMode,
    _anchor: DesktopActivityOverlayAnchor,
    display_context: Option<DesktopActivityOverlayDisplayContext>,
) -> DesktopActivityOverlayHostMode {
    let Some(display_context) = display_context else {
        return DesktopActivityOverlayHostMode::Floating;
    };

    let supports_notch_integrated_mode = display_context.is_macos
        && display_context.is_builtin_display
        && display_context.has_physical_notch;

    match presentation_mode {
        DesktopActivityOverlayPresentationMode::FloatingOverlay => {
            DesktopActivityOverlayHostMode::Floating
        }
        DesktopActivityOverlayPresentationMode::NotchIntegrated => {
            if supports_notch_integrated_mode {
                DesktopActivityOverlayHostMode::NotchIntegrated
            } else {
                DesktopActivityOverlayHostMode::Floating
            }
        }
        DesktopActivityOverlayPresentationMode::Automatic => {
            if supports_notch_integrated_mode {
                DesktopActivityOverlayHostMode::NotchIntegrated
            } else {
                DesktopActivityOverlayHostMode::Floating
            }
        }
    }
}

pub(crate) fn resolve_overlay_placement_for_host_mode(
    monitor: Rect,
    overlay: Rect,
    anchor: DesktopActivityOverlayAnchor,
    offset_x: f64,
    offset_y: f64,
    padding: f64,
    host_mode: DesktopActivityOverlayHostMode,
    display_context: Option<DesktopActivityOverlayDisplayContext>,
) -> OverlayPlacementRect {
    match (host_mode, display_context) {
        (
            DesktopActivityOverlayHostMode::NotchIntegrated,
            Some(display_context),
        ) => resolve_notch_integrated_top_center_placement(
            monitor,
            overlay,
            offset_x,
            offset_y,
            display_context.safe_area_top,
        ),
        _ => resolve_overlay_placement(monitor, overlay, anchor, offset_x, offset_y, padding),
    }
}

fn resolve_notch_integrated_top_center_placement(
    monitor: Rect,
    overlay: Rect,
    offset_x: f64,
    offset_y: f64,
    safe_area_top: f64,
) -> OverlayPlacementRect {
    let offset_x = sanitize_offset(offset_x);
    let offset_y = sanitize_offset(offset_y);
    let center_x = monitor.x + (monitor.width - overlay.width) / 2.0;
    let max_x = monitor.x + (monitor.width - overlay.width).max(0.0);
    let max_top_band = if safe_area_top.is_finite() && safe_area_top > 0.0 {
        (safe_area_top - overlay.height).max(0.0)
    } else {
        0.0
    };
    let top_band = clamp(offset_y, 0.0, max_top_band);

    OverlayPlacementRect {
        x: clamp(center_x + offset_x, monitor.x, max_x),
        y: monitor.y + top_band,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display_context(has_notch: bool) -> DesktopActivityOverlayDisplayContext {
        DesktopActivityOverlayDisplayContext {
            is_macos: true,
            is_builtin_display: true,
            has_physical_notch: has_notch,
            safe_area_top: 74.0,
            screen_frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 982.0,
            },
            visible_frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 908.0,
            },
        }
    }

    #[test]
    fn resolves_notch_integrated_host_mode_for_macos_builtin_notched_top_center() {
        let host_mode = resolve_desktop_activity_overlay_host_mode(
            DesktopActivityOverlayPresentationMode::Automatic,
            DesktopActivityOverlayPlacementMode::Anchored,
            DesktopActivityOverlayAnchor::TopCenter,
            Some(display_context(true)),
        );

        assert_eq!(host_mode, DesktopActivityOverlayHostMode::NotchIntegrated);
    }

    #[test]
    fn automatic_mode_still_resolves_notch_integrated_for_supported_displays_even_with_stale_custom_placement() {
        let host_mode = resolve_desktop_activity_overlay_host_mode(
            DesktopActivityOverlayPresentationMode::Automatic,
            DesktopActivityOverlayPlacementMode::Custom,
            DesktopActivityOverlayAnchor::BottomRight,
            Some(display_context(true)),
        );

        assert_eq!(host_mode, DesktopActivityOverlayHostMode::NotchIntegrated);
    }

    #[test]
    fn respects_explicit_floating_overlay_mode_even_on_notched_builtin_displays() {
        let host_mode = resolve_desktop_activity_overlay_host_mode(
            DesktopActivityOverlayPresentationMode::FloatingOverlay,
            DesktopActivityOverlayPlacementMode::Anchored,
            DesktopActivityOverlayAnchor::TopCenter,
            Some(display_context(true)),
        );

        assert_eq!(host_mode, DesktopActivityOverlayHostMode::Floating);
    }

    #[test]
    fn respects_explicit_notch_integrated_mode_even_when_saved_floating_placement_values_exist() {
        let host_mode = resolve_desktop_activity_overlay_host_mode(
            DesktopActivityOverlayPresentationMode::NotchIntegrated,
            DesktopActivityOverlayPlacementMode::Custom,
            DesktopActivityOverlayAnchor::BottomRight,
            Some(display_context(true)),
        );

        assert_eq!(host_mode, DesktopActivityOverlayHostMode::NotchIntegrated);
    }

    #[test]
    fn falls_back_to_floating_host_mode_for_external_displays() {
        let host_mode_for_external = resolve_desktop_activity_overlay_host_mode(
            DesktopActivityOverlayPresentationMode::Automatic,
            DesktopActivityOverlayPlacementMode::Anchored,
            DesktopActivityOverlayAnchor::TopCenter,
            Some(DesktopActivityOverlayDisplayContext {
                is_macos: true,
                is_builtin_display: false,
                has_physical_notch: true,
                safe_area_top: 74.0,
                screen_frame: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 1920.0,
                    height: 1080.0,
                },
                visible_frame: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 1920.0,
                    height: 1056.0,
                },
            }),
        );

        assert_eq!(host_mode_for_external, DesktopActivityOverlayHostMode::Floating);
    }

    #[test]
    fn notch_integrated_top_center_placement_uses_the_safe_area_band() {
        let placement = resolve_overlay_placement_for_host_mode(
            Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 982.0,
            },
            Rect {
                x: 0.0,
                y: 0.0,
                width: 360.0,
                height: 68.0,
            },
            DesktopActivityOverlayAnchor::TopCenter,
            0.0,
            0.0,
            12.0,
            DesktopActivityOverlayHostMode::NotchIntegrated,
            Some(display_context(true)),
        );

        assert!((placement.x - 576.0).abs() < 0.001);
        assert!((placement.y - 0.0).abs() < 0.001);
    }

    #[test]
    fn notch_integrated_placement_ignores_stale_saved_anchor_values() {
        let placement = resolve_overlay_placement_for_host_mode(
            Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 982.0,
            },
            Rect {
                x: 0.0,
                y: 0.0,
                width: 360.0,
                height: 68.0,
            },
            DesktopActivityOverlayAnchor::BottomRight,
            0.0,
            0.0,
            12.0,
            DesktopActivityOverlayHostMode::NotchIntegrated,
            Some(display_context(true)),
        );

        assert!((placement.x - 576.0).abs() < 0.001);
        assert!((placement.y - 0.0).abs() < 0.001);
    }

    #[test]
    fn floating_mode_keeps_the_existing_anchor_padding_behavior() {
        let placement = resolve_overlay_placement_for_host_mode(
            Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 982.0,
            },
            Rect {
                x: 0.0,
                y: 0.0,
                width: 360.0,
                height: 68.0,
            },
            DesktopActivityOverlayAnchor::TopCenter,
            0.0,
            0.0,
            12.0,
            DesktopActivityOverlayHostMode::Floating,
            Some(display_context(true)),
        );

        assert!((placement.x - 576.0).abs() < 0.001);
        assert!((placement.y - 12.0).abs() < 0.001);
    }
}
