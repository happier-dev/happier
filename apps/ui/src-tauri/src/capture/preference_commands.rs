//! Thin preference and shortcut transport; the native record owns persistence.
use super::{commands, preferences::CaptureBindingKey, shortcuts, CaptureState};
use happier_desktop_native::capture::CaptureError;
use tauri::{AppHandle, State};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowShadowPreference { enabled: bool, supported: bool }

/// The native preference is shared by Settings Actions, shortcuts, tray and renderer requests.
#[tauri::command]
pub async fn desktop_capture_window_shadow(app: AppHandle, state: State<'_, CaptureState>, enabled: Option<bool>) -> Result<WindowShadowPreference, CaptureError> {
    let state = state.inner().clone();
    commands::blocking(move || {
        let supported = happier_desktop_native::capture::window_shadow_supported();
        let (enabled, changed) = commands::with_preferences(&app, &state, |preferences| {
            let changed = if let Some(enabled) = enabled {
                if enabled && !supported { return Err(CaptureError::UnsupportedPlatform); }
                preferences.set_include_window_shadow(enabled)?
            } else { false };
            Ok((preferences.include_window_shadow(), changed))
        })?;
        let snapshot = WindowShadowPreference { enabled, supported };
        if changed {
            use tauri::Emitter;
            let _ = app.emit("desktopCapture://preference/includeWindowShadow", &snapshot);
        }
        Ok(snapshot)
    }).await
}

#[tauri::command]
pub async fn desktop_capture_preference(app: AppHandle, state: State<'_, CaptureState>, key: CapturePreferenceKey) -> Result<Option<String>, CaptureError> {
    let state = state.inner().clone();
    commands::blocking(move || commands::with_preferences(&app, &state, |p| Ok(match key {
        CapturePreferenceKey::LibraryFolder => p.library_folder().map(|path| path.to_string_lossy().into_owned()),
        CapturePreferenceKey::CaptureShortcut => p.bindings().capture_shortcut,
        CapturePreferenceKey::InstantWindowShortcut => p.bindings().instant_window_shortcut,
        CapturePreferenceKey::RecordingShortcut => p.bindings().recording_shortcut,
    }))).await
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CapturePreferenceKey { CaptureShortcut, InstantWindowShortcut, RecordingShortcut, LibraryFolder }

pub(super) fn publish_preference(app: &AppHandle, key: &str, value: Option<&str>) {
    use tauri::Emitter;
    let _ = app.emit(&format!("desktopCapture://preference/{key}"), value);
}

#[tauri::command]
pub fn desktop_capture_shortcuts(app: AppHandle) -> shortcuts::ShortcutSnapshot { shortcuts::snapshot(&app) }
#[tauri::command]
pub async fn desktop_capture_set_shortcut(app: AppHandle, key: CaptureBindingKey, binding: Option<String>) -> Result<shortcuts::ShortcutSnapshot, CaptureError> {
    commands::blocking(move || shortcuts::update_binding(&app, key, binding)).await
}
#[tauri::command]
pub async fn desktop_capture_shortcut_editing(app: AppHandle, editing: bool) -> Result<(), CaptureError> {
    commands::blocking(move || shortcuts::set_editing(&app, editing).map(|_| ()) ).await
}
#[tauri::command]
pub async fn desktop_capture_configure_shortcuts(app: AppHandle) -> Result<shortcuts::ShortcutSnapshot, CaptureError> {
    commands::blocking(move || shortcuts::configure(&app)).await
}
