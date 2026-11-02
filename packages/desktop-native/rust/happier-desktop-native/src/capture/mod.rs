//! Native capture facts and effects; shells own their operation and windows.
pub mod files;
pub mod recording;
pub mod permissions;
pub mod window_text;
pub mod recents;
mod acquisition;
pub use acquisition::*;
#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "linux")]
pub mod linux;
#[cfg(target_os = "windows")]
pub mod windows;

use crate::geometry::Rect;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub fn window_shadow_supported() -> bool {
    #[cfg(target_os = "macos")]
    { macos::window_shadow_supported() }
    #[cfg(not(target_os = "macos"))]
    { false }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureError {
    UnsupportedPlatform,
    ScreenPermissionRequired,
    TargetUnavailable,
    InvalidSelection,
    Cancelled,
    InvalidPng,
    InvalidMedia,
    UnknownCapture,
    PreparedMissing,
    CaptureInUse,
    BlurredCapture,
    FileIo,
    NativeFailure,
    OperationUnavailable,
    PortalUnavailable,
    PortalDenied,
    UnsupportedTarget,
    InvalidPortalUri,
    PipewireUnavailable,
    VideoEncoderUnavailable,
    VideoMuxerUnavailable,
    VideoDecoderUnavailable,
    VideoPipelineUnavailable,
    CursorUnavailable,
}

impl std::fmt::Display for CaptureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}
impl std::error::Error for CaptureError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PixelSize { pub width: u32, pub height: u32 }

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureOrigin {
    pub display_id: u32,
    /// Display-local logical points, with a top-left origin.
    pub rect: Rect,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSource {
    pub app_name: Option<String>,
    pub window_title: Option<String>,
    pub window_id: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    pub capture_ref: String,
    pub kind: MediaKind,
    pub path: PathBuf,
    pub mime_type: String,
    pub byte_size: u64,
    pub pixel_size: PixelSize,
    /// None for imported media whose desktop scale is unknown.
    pub scale: Option<f64>,
    pub origin: Option<CaptureOrigin>,
    pub source: Option<CaptureSource>,
    pub window_text_ref: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MediaKind { Still, Video }

pub use permissions::PermissionState as ScreenPermission;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedPng {
    pub capture_ref: String,
    pub path: PathBuf,
    pub pixel_size: PixelSize,
    pub byte_size: u64,
    pub mime_type: String,
}

/// The person's disclosure decision committed with the current prepared pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureDisclosure {
    pub has_marks: bool,
    pub include_window_text: bool,
}
