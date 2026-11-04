//! Permission-free window placement facts, separate from capture source discovery.
use super::{CaptureError, CaptureState};
use happier_desktop_native::{capture::DisplayDescriptor, geometry::{NotchSize, Rect}};
use serde::Serialize;
use tauri::AppHandle;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureWindowDisplay {
    /// System window-placement monitors have no capture-source identity.
    pub display_id: Option<u32>,
    pub frame: Rect,
    pub scale: f64,
    pub desktop_scale: f64,
    pub storage_key: Option<String>,
    pub localized_name: Option<String>,
    pub safe_area_top: f64,
    pub physical_notch_size: Option<NotchSize>,
}
impl From<DisplayDescriptor> for CaptureWindowDisplay {
    fn from(display: DisplayDescriptor) -> Self {
        Self { display_id: Some(display.display_id), frame: display.frame, scale: display.scale,
            desktop_scale: display.desktop_scale, storage_key: display.storage_key,
            localized_name: display.localized_name, safe_area_top: display.safe_area_top,
            physical_notch_size: display.physical_notch_size }
    }
}

#[cfg(target_os = "macos")]
pub(super) fn source_displays(app: &AppHandle) -> Result<Vec<DisplayDescriptor>, CaptureError> {
    crate::desktop_panel::run_on_main_thread(app, || {
        happier_desktop_native::capture::macos::display_facts(objc2::MainThreadMarker::new().unwrap())
    }, "Capture display discovery did not return").map_err(|_| CaptureError::NativeFailure)
}

#[cfg(any(target_os = "windows", target_os = "linux"))]
pub(super) fn monitor_scales(app: &AppHandle) -> Result<Vec<(Rect, f64)>, CaptureError> {
    Ok(crate::activity_overlay::monitor_resolution::read_monitor_facts(app)
        .map_err(|_| CaptureError::NativeFailure)?.into_iter().map(|monitor| {
            (Rect { x: monitor.rect.x * monitor.scale, y: monitor.rect.y * monitor.scale,
                width: monitor.rect.width * monitor.scale, height: monitor.rect.height * monitor.scale }, monitor.scale)
        }).collect())
}

pub(super) fn read(app: &AppHandle, state: &CaptureState, label: &str) -> Result<Vec<CaptureWindowDisplay>, CaptureError> {
    // Selection owns these real source ids. Keeping only its display geometry
    // allows review placement without retaining native sources or windows.
    let displays = {
        let operation = state.0.operation.lock().unwrap();
        operation.completed.values().find(|completed| completed.window_label.as_deref() == Some(label))
            .and_then(|completed| completed.active.as_ref()).or(operation.active.as_ref())
            .map(|active| active.inventory.displays.clone()).unwrap_or_default()
    };
    if !displays.is_empty() { return Ok(displays.into_iter().map(Into::into).collect()); }
    #[cfg(target_os = "macos")]
    { source_displays(app).map(|displays| displays.into_iter().map(Into::into).collect()) }
    #[cfg(any(target_os = "windows", target_os = "linux"))]
    { Ok(crate::activity_overlay::monitor_resolution::read_monitor_facts(app)
        .map_err(|_| CaptureError::NativeFailure)?.into_iter().map(|monitor| CaptureWindowDisplay {
        // Capture windows take a physical desktop origin and logical extent.
        display_id: None, frame: Rect { x: monitor.rect.x * monitor.scale, y: monitor.rect.y * monitor.scale,
            width: monitor.rect.width, height: monitor.rect.height }, scale: monitor.scale,
        desktop_scale: monitor.scale, storage_key: Some(monitor.storage_key), localized_name: Some(monitor.name),
        safe_area_top: 0., physical_notch_size: None,
    }).collect()) }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    { let _ = app; Err(CaptureError::UnsupportedPlatform) }
}
