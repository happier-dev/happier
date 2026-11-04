use super::dock::Dock;
use super::host_mode::DesktopActivityOverlayDisplayContext;
use super::placement::{DesktopActivityOverlayMonitorSource, OverlayPlacementRect, Rect};
use super::DesktopActivityOverlaySurface;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityOverlayPlacementDiagnosticsPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) display: Option<super::displays::DisplayResolution>,
    pub monitor_source: DesktopActivityOverlayMonitorSource,
    pub effective_monitor: Rect,
    pub(crate) dock: Dock,
    pub(crate) surface: DesktopActivityOverlaySurface,
    pub(crate) engaged: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_context: Option<DesktopActivityOverlayDisplayContext>,
    pub computed_position: OverlayPlacementRect,
    pub native_host_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_native_frame: Option<Rect>,
}
