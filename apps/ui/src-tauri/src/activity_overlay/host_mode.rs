use super::diagnostics::DesktopActivityOverlayHostFallbackReason;
use super::placement::{clamp, resolve_overlay_placement, OverlayPlacementRect, Rect};
use super::{
    DesktopActivityOverlayAnchor, DesktopActivityOverlayPlacementMode,
    DesktopActivityOverlayPresentationMode,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
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

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct DesktopActivityOverlayHostModeResolution {
    pub(crate) requested_mode: DesktopActivityOverlayHostMode,
    pub(crate) effective_mode: DesktopActivityOverlayHostMode,
    pub(crate) fallback_reason: Option<DesktopActivityOverlayHostFallbackReason>,
}

impl DesktopActivityOverlayHostModeResolution {
    pub(crate) fn with_runtime_fallback(
        self,
        fallback_reason: DesktopActivityOverlayHostFallbackReason,
    ) -> Self {
        Self {
            requested_mode: self.requested_mode,
            effective_mode: DesktopActivityOverlayHostMode::Floating,
            fallback_reason: Some(fallback_reason),
        }
    }
}

pub(crate) fn resolve_desktop_activity_overlay_host_mode_resolution(
    presentation_mode: DesktopActivityOverlayPresentationMode,
    _placement_mode: DesktopActivityOverlayPlacementMode,
    _anchor: DesktopActivityOverlayAnchor,
    display_context: Option<DesktopActivityOverlayDisplayContext>,
) -> DesktopActivityOverlayHostModeResolution {
    let requested_mode =
        resolve_requested_desktop_activity_overlay_host_mode(presentation_mode, display_context);
    let fallback_reason = resolve_requested_host_mode_fallback_reason(
        presentation_mode,
        requested_mode,
        display_context,
    );

    DesktopActivityOverlayHostModeResolution {
        requested_mode,
        effective_mode: if requested_mode == DesktopActivityOverlayHostMode::NotchIntegrated
            && fallback_reason.is_none()
        {
            DesktopActivityOverlayHostMode::NotchIntegrated
        } else {
            DesktopActivityOverlayHostMode::Floating
        },
        fallback_reason,
    }
}

fn resolve_requested_desktop_activity_overlay_host_mode(
    presentation_mode: DesktopActivityOverlayPresentationMode,
    display_context: Option<DesktopActivityOverlayDisplayContext>,
) -> DesktopActivityOverlayHostMode {
    match presentation_mode {
        DesktopActivityOverlayPresentationMode::FloatingOverlay => {
            DesktopActivityOverlayHostMode::Floating
        }
        DesktopActivityOverlayPresentationMode::NotchIntegrated => {
            DesktopActivityOverlayHostMode::NotchIntegrated
        }
        DesktopActivityOverlayPresentationMode::Automatic => {
            if supports_notch_integrated_mode(display_context) {
                DesktopActivityOverlayHostMode::NotchIntegrated
            } else {
                DesktopActivityOverlayHostMode::Floating
            }
        }
    }
}

fn resolve_requested_host_mode_fallback_reason(
    presentation_mode: DesktopActivityOverlayPresentationMode,
    requested_mode: DesktopActivityOverlayHostMode,
    display_context: Option<DesktopActivityOverlayDisplayContext>,
) -> Option<DesktopActivityOverlayHostFallbackReason> {
    if presentation_mode != DesktopActivityOverlayPresentationMode::NotchIntegrated
        || requested_mode != DesktopActivityOverlayHostMode::NotchIntegrated
    {
        return None;
    }

    resolve_notch_integrated_host_fallback_reason(display_context)
}

fn resolve_notch_integrated_host_fallback_reason(
    display_context: Option<DesktopActivityOverlayDisplayContext>,
) -> Option<DesktopActivityOverlayHostFallbackReason> {
    let Some(display_context) = display_context else {
        return Some(DesktopActivityOverlayHostFallbackReason::MissingDisplayContext);
    };

    if !display_context.is_macos {
        return Some(DesktopActivityOverlayHostFallbackReason::UnsupportedPlatform);
    }
    if !display_context.is_builtin_display {
        return Some(DesktopActivityOverlayHostFallbackReason::ExternalDisplay);
    }
    if !display_context.has_physical_notch {
        return Some(DesktopActivityOverlayHostFallbackReason::DisplayHasNoPhysicalNotch);
    }

    None
}

fn supports_notch_integrated_mode(
    display_context: Option<DesktopActivityOverlayDisplayContext>,
) -> bool {
    display_context
        .map(|context| context.is_macos && context.is_builtin_display && context.has_physical_notch)
        .unwrap_or(false)
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
        (DesktopActivityOverlayHostMode::NotchIntegrated, Some(display_context)) => {
            resolve_notch_integrated_top_center_placement(
                monitor,
                overlay,
                offset_x,
                offset_y,
                display_context.safe_area_top,
            )
        }
        _ => resolve_overlay_placement(monitor, overlay, anchor, offset_x, offset_y, padding),
    }
}

fn resolve_notch_integrated_top_center_placement(
    monitor: Rect,
    overlay: Rect,
    _offset_x: f64,
    _offset_y: f64,
    safe_area_top: f64,
) -> OverlayPlacementRect {
    let center_x = monitor.x + (monitor.width - overlay.width) / 2.0;
    let max_x = monitor.x + (monitor.width - overlay.width).max(0.0);
    let max_top_band = if safe_area_top.is_finite() && safe_area_top > 0.0 {
        (safe_area_top - overlay.height).max(0.0)
    } else {
        0.0
    };
    let top_band = clamp(0.0, 0.0, max_top_band);

    OverlayPlacementRect {
        x: clamp(center_x, monitor.x, max_x),
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
        let host_mode = resolve_desktop_activity_overlay_host_mode_resolution(
            DesktopActivityOverlayPresentationMode::Automatic,
            DesktopActivityOverlayPlacementMode::Anchored,
            DesktopActivityOverlayAnchor::TopCenter,
            Some(display_context(true)),
        )
        .effective_mode;

        assert_eq!(host_mode, DesktopActivityOverlayHostMode::NotchIntegrated);
    }

    #[test]
    fn automatic_mode_still_resolves_notch_integrated_for_supported_displays_even_with_stale_custom_placement(
    ) {
        let host_mode = resolve_desktop_activity_overlay_host_mode_resolution(
            DesktopActivityOverlayPresentationMode::Automatic,
            DesktopActivityOverlayPlacementMode::Custom,
            DesktopActivityOverlayAnchor::BottomRight,
            Some(display_context(true)),
        )
        .effective_mode;

        assert_eq!(host_mode, DesktopActivityOverlayHostMode::NotchIntegrated);
    }

    #[test]
    fn respects_explicit_floating_overlay_mode_even_on_notched_builtin_displays() {
        let host_mode = resolve_desktop_activity_overlay_host_mode_resolution(
            DesktopActivityOverlayPresentationMode::FloatingOverlay,
            DesktopActivityOverlayPlacementMode::Anchored,
            DesktopActivityOverlayAnchor::TopCenter,
            Some(display_context(true)),
        )
        .effective_mode;

        assert_eq!(host_mode, DesktopActivityOverlayHostMode::Floating);
    }

    #[test]
    fn respects_explicit_notch_integrated_mode_even_when_saved_floating_placement_values_exist() {
        let host_mode = resolve_desktop_activity_overlay_host_mode_resolution(
            DesktopActivityOverlayPresentationMode::NotchIntegrated,
            DesktopActivityOverlayPlacementMode::Custom,
            DesktopActivityOverlayAnchor::BottomRight,
            Some(display_context(true)),
        )
        .effective_mode;

        assert_eq!(host_mode, DesktopActivityOverlayHostMode::NotchIntegrated);
    }

    #[test]
    fn falls_back_to_floating_host_mode_for_external_displays() {
        let host_mode_for_external = resolve_desktop_activity_overlay_host_mode_resolution(
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
        )
        .effective_mode;

        assert_eq!(
            host_mode_for_external,
            DesktopActivityOverlayHostMode::Floating
        );
    }

    #[test]
    fn explicit_notch_mode_reports_missing_display_context_as_a_fallback_reason() {
        let resolution = resolve_desktop_activity_overlay_host_mode_resolution(
            DesktopActivityOverlayPresentationMode::NotchIntegrated,
            DesktopActivityOverlayPlacementMode::Anchored,
            DesktopActivityOverlayAnchor::TopCenter,
            None,
        );

        assert_eq!(
            resolution.requested_mode,
            DesktopActivityOverlayHostMode::NotchIntegrated,
        );
        assert_eq!(
            resolution.effective_mode,
            DesktopActivityOverlayHostMode::Floating,
        );
        assert_eq!(
            resolution.fallback_reason,
            Some(DesktopActivityOverlayHostFallbackReason::MissingDisplayContext),
        );
    }

    #[test]
    fn automatic_mode_keeps_floating_as_the_requested_mode_on_external_displays() {
        let resolution = resolve_desktop_activity_overlay_host_mode_resolution(
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

        assert_eq!(
            resolution.requested_mode,
            DesktopActivityOverlayHostMode::Floating
        );
        assert_eq!(
            resolution.effective_mode,
            DesktopActivityOverlayHostMode::Floating,
        );
        assert_eq!(resolution.fallback_reason, None);
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
    fn notch_integrated_placement_ignores_stale_saved_offsets() {
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
            124.0,
            48.0,
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
