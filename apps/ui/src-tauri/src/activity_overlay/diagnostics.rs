use super::host_mode::{DesktopActivityOverlayDisplayContext, DesktopActivityOverlayHostMode};
use super::placement::{
    DesktopActivityOverlayMonitorSource, OverlayPlacementRect, Rect,
    ResolvedOverlayAnchorMonitorRect,
};
use super::{DesktopActivityOverlayAnchor, DesktopActivityOverlayPlacementMode};
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DesktopActivityOverlayHostFallbackReason {
    MissingDisplayContext,
    UnsupportedPlatform,
    ExternalDisplay,
    DisplayHasNoPhysicalNotch,
    PanelHostApplyFailed,
    PanelPositionUnavailable,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DesktopActivityOverlayNativeHostPath {
    Window,
    Panel,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityOverlayPlacementDiagnosticsPayload {
    pub monitor_source: DesktopActivityOverlayMonitorSource,
    pub effective_monitor: Rect,
    pub anchor: DesktopActivityOverlayAnchor,
    pub placement_mode: DesktopActivityOverlayPlacementMode,
    pub requested_host_mode: DesktopActivityOverlayHostMode,
    pub host_mode: DesktopActivityOverlayHostMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_fallback_reason: Option<DesktopActivityOverlayHostFallbackReason>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_context: Option<DesktopActivityOverlayDisplayContext>,
    pub effective_offset_x: f64,
    pub effective_offset_y: f64,
    pub computed_position: OverlayPlacementRect,
    pub native_host_path: DesktopActivityOverlayNativeHostPath,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_native_frame: Option<Rect>,
}

pub(crate) fn build_overlay_placement_diagnostics(
    monitor_resolution: ResolvedOverlayAnchorMonitorRect,
    placement: OverlayPlacementRect,
    anchor: DesktopActivityOverlayAnchor,
    placement_mode: DesktopActivityOverlayPlacementMode,
    requested_host_mode: DesktopActivityOverlayHostMode,
    host_mode: DesktopActivityOverlayHostMode,
    host_fallback_reason: Option<DesktopActivityOverlayHostFallbackReason>,
    display_context: Option<DesktopActivityOverlayDisplayContext>,
    effective_offset_x: f64,
    effective_offset_y: f64,
    native_host_path: DesktopActivityOverlayNativeHostPath,
    applied_native_frame: Option<Rect>,
) -> DesktopActivityOverlayPlacementDiagnosticsPayload {
    DesktopActivityOverlayPlacementDiagnosticsPayload {
        monitor_source: monitor_resolution.source,
        effective_monitor: monitor_resolution.rect,
        anchor,
        placement_mode,
        requested_host_mode,
        host_mode,
        host_fallback_reason,
        display_context,
        effective_offset_x,
        effective_offset_y,
        computed_position: placement,
        native_host_path,
        applied_native_frame,
    }
}
