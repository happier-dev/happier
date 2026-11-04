use super::display_identity::DesktopActivityOverlayDisplayIdentity;
use super::placement::Rect;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopActivityOverlayPhysicalNotchSize {
    pub(crate) width: f64,
    pub(crate) height: f64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DesktopActivityOverlayDisplayContext {
    pub(crate) is_macos: bool,
    pub(crate) is_builtin_display: bool,
    pub(crate) has_physical_notch: bool,
    pub(crate) safe_area_top: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) physical_notch_size: Option<DesktopActivityOverlayPhysicalNotchSize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) display_identity: Option<DesktopActivityOverlayDisplayIdentity>,
    pub(crate) screen_frame: Rect,
    pub(crate) visible_frame: Rect,
}
