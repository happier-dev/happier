//! Requests are inputs for the renderer's presentation reducer, never native presentation decisions.
use super::{ActivityOverlayState, OVERLAY_WINDOW_LABEL};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum RequestedState { Rest, Open, Pinned }
#[derive(Clone, Copy, Debug, Serialize)]
pub struct PresentationRequest { state: RequestedState, focus: bool }

#[tauri::command]
pub fn desktop_activity_overlay_request_presentation<R: Runtime>(app: AppHandle<R>, state: State<'_, ActivityOverlayState>,
    requested_state: RequestedState) -> Result<(), String> {
    let requested = requested_state;
    let always_on_top = state.0.lock().map_err(|_| "Overlay state poisoned")?.last_sync_payload.as_ref()
        .map(|payload| payload.policy.always_on_top).unwrap_or(true);
    super::window_lifecycle::ensure_overlay_window(&app, always_on_top)?;
    let request = PresentationRequest { state: requested, focus: requested != RequestedState::Rest };
    // The hidden webview can still be loading when an Action first opens it. Its listener drains
    // the same pending input on startup, so the first request is not lost before React mounts.
    state.0.lock().map_err(|_| "Overlay state poisoned")?.presentation_request = Some(request);
    app.emit_to(OVERLAY_WINDOW_LABEL, "activityOverlay://presentation", request).map_err(|error| error.to_string())
}

#[tauri::command]
pub fn desktop_activity_overlay_take_presentation_request(state: State<'_, ActivityOverlayState>) -> Result<Option<PresentationRequest>, String> {
    Ok(state.0.lock().map_err(|_| "Overlay state poisoned")?.presentation_request.take())
}

#[tauri::command]
pub fn desktop_activity_overlay_set_keyboard_wanted<R: Runtime>(app: AppHandle<R>, wanted: bool) -> Result<(), String> {
    if let Some(window) = app.get_webview_window(OVERLAY_WINDOW_LABEL) {
        super::window_lifecycle::set_keyboard_wanted(&window, wanted)?;
    }
    Ok(())
}
