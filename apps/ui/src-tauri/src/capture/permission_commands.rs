//! Thin Tauri adaptation of this desktop process's permission owner.
use super::CaptureState;
use happier_desktop_native::capture::{CaptureError, permissions::{NativePermissions,
    PermissionOwner, PermissionRequest, PermissionSnapshot, PermissionSubject, RecoveryAction}};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
#[cfg(target_os = "macos")]
use tauri_plugin_opener::OpenerExt;

const PERMISSION_EVENT: &str = "desktopCapture://permissions";

fn backend(app: &AppHandle) -> NativePermissions {
    #[cfg(target_os = "linux")]
    { NativePermissions::for_session(super::session::read(app).ok()) }
    #[cfg(not(target_os = "linux"))]
    { let _ = app; NativePermissions }
}

fn publish(app: &AppHandle, owner: &PermissionOwner, snapshot: PermissionSnapshot) {
    for label in owner.consuming_windows() { let _ = app.emit_to(label, PERMISSION_EVENT, snapshot); }
}

pub fn refresh_consumed_permissions(app: &AppHandle) {
    let state = app.state::<CaptureState>();
    let mut owner = state.0.permissions.lock().unwrap();
    if let Some(snapshot) = owner.refresh_consumed(&backend(app)) { publish(app, &owner, snapshot); }
}

pub fn remove_permission_window(app: &AppHandle, label: &str) {
    app.state::<CaptureState>().0.permissions.lock().unwrap().remove_window(label);
}

fn read(app: &AppHandle, state: &CaptureState) -> PermissionSnapshot {
    let mut owner = state.0.permissions.lock().unwrap();
    let observed = owner.read(&backend(app));
    if observed.changed { publish(app, &owner, observed.snapshot); }
    observed.snapshot
}

#[tauri::command]
pub fn desktop_capture_permissions(app: AppHandle, state: State<'_, CaptureState>) -> PermissionSnapshot {
    read(&app, &state)
}

#[tauri::command]
pub fn desktop_capture_permissions_watch(app: AppHandle, window: WebviewWindow,
    state: State<'_, CaptureState>, subscription_ref: u64, consumed: bool) -> Option<PermissionSnapshot> {
    state.0.permissions.lock().unwrap().set_consumed(window.label().to_owned(), subscription_ref, consumed);
    consumed.then(|| read(&app, &state))
}

fn open_settings(app: &AppHandle, subject: PermissionSubject) -> Result<(), CaptureError> {
    #[cfg(target_os = "macos")]
    {
        let pane = match subject { PermissionSubject::Screen => "Privacy_ScreenCapture",
            PermissionSubject::WindowText => "Privacy_Accessibility" };
        app.opener().open_url(format!("x-apple.systempreferences:com.apple.preference.security?{pane}"),
            None::<String>).map_err(|_| CaptureError::NativeFailure)?;
        app.state::<CaptureState>().0.permissions.lock().unwrap().settings_opened(subject);
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    { let _ = (app, subject); Err(CaptureError::UnsupportedPlatform) }
}

/// macOS applies a Screen Recording grant only to a new process.
#[tauri::command]
pub fn desktop_capture_relaunch(app: AppHandle) { app.restart() }

#[tauri::command]
pub fn desktop_capture_open_permission_settings(app: AppHandle, subject: PermissionSubject) -> Result<(), CaptureError> {
    open_settings(&app, subject)
}

/// Explicit helper presentation only; grant ownership stays with its app/driver.
#[tauri::command]
pub fn desktop_capture_place_permission_helper(window: WebviewWindow) -> Result<bool, CaptureError> {
    super::permission_placement::beside_system_settings(&window)
}

fn request_permission(app: &AppHandle, state: CaptureState,
    subject: PermissionSubject) -> Result<PermissionRequest, CaptureError> {
    let handle = app.clone();
    let request = move || -> Result<PermissionRequest, CaptureError> {
        let mut owner = state.0.permissions.lock().unwrap();
        let result = owner.request(&backend(&handle), subject);
        if result.changed { publish(&handle, &owner, result.snapshot); }
        Ok(result)
    };
    #[cfg(target_os = "macos")]
    let result = crate::desktop_panel::run_on_main_thread(app, request,
        "Capture permission request did not return").map_err(|_| CaptureError::NativeFailure)??;
    #[cfg(not(target_os = "macos"))]
    let result: PermissionRequest = request()?;
    Ok(result)
}

#[tauri::command]
pub async fn desktop_capture_request_permission(app: AppHandle, state: State<'_, CaptureState>,
    subject: PermissionSubject) -> Result<PermissionRequest, CaptureError> {
    let state = state.inner().clone();
    let handle = app.clone();
    let result = super::commands::blocking(move || request_permission(&handle, state, subject)).await?;
    if result.recovery == RecoveryAction::OpenSettings {
        // The first OS request is never repeated as a recovery strategy.
        open_settings(&app, subject)?;
    }
    Ok(result)
}

#[tauri::command]
pub async fn desktop_capture_window_text(app: AppHandle, window: WebviewWindow,
    state: State<'_, CaptureState>, capture_ref: String)
    -> Result<happier_desktop_native::capture::window_text::WindowTextOutcome, CaptureError> {
    let state = state.inner().clone();
    let capture_preview = crate::desktop_window::is_capture_window(window.label())
        && state.window_label_for_capture(&capture_ref).as_deref() == Some(window.label());
    super::commands::blocking(move || {
        // Clone the per-capture owner, then release the files lock before any
        // AX/AT-SPI/UIA work. Only this capture's read is serialized.
        let text = state.window_text_for_read(&capture_ref, capture_preview)?;
        let outcome = text.lock().unwrap().read_with(|| {
            #[cfg(target_os = "macos")]
            {
                use happier_desktop_native::capture::{permissions::PermissionState, window_text::WindowTextUnavailable};
                let permission = request_permission(&app, state.clone(), PermissionSubject::WindowText)
                    .map_err(|_| WindowTextUnavailable::ProviderUnavailable)?;
                if permission.snapshot.window_text != PermissionState::Granted {
                    return Err(WindowTextUnavailable::PermissionRequired);
                }
            }
            #[cfg(not(target_os = "macos"))]
            let _ = &app;
            happier_desktop_native::capture::window_text::native_accessibility()
        });
        Ok(outcome)
    }).await
}
