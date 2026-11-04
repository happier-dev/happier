//! Recent capture demand belongs to the presenting window, not app startup.
use super::{commands::{bind_events, blocking, library_folder}, CaptureState};
use happier_desktop_native::capture::{recents::{destinations, RecentCaptures, RecentSnapshot}, CaptureError, CaptureResult};
use std::{path::PathBuf, sync::Arc};
use tauri::{AppHandle, Emitter, State, WebviewWindow};

pub const RECENT_CAPTURE_EVENT: &str = "desktopCapture://recents";

#[derive(Default)]
pub(super) struct RecentState {
    native: RecentCaptures,
    window: Option<String>,
    selected_folder: Option<PathBuf>,
}

/// Called by the existing global window lifecycle handler, including hide.
pub fn close_recents_for_window(state: &CaptureState, label: &str) {
    let mut recent = state.0.recents.lock().unwrap();
    if recent.window.as_deref() == Some(label) {
        recent.native.close(); recent.window = None; recent.selected_folder = None;
    }
}

/// A changed library preference affects only current demand. Resolving known
/// folders, statting or creating watchers while closed is deliberately absent.
pub fn refresh_recent_folders(app: &AppHandle, state: &CaptureState) -> Result<(), CaptureError> {
    if !state.0.recents.lock().unwrap().native.is_open() { return Ok(()); }
    let library = library_folder(app, state)?;
    let mut recent = state.0.recents.lock().unwrap();
    let roots = destinations(library, recent.selected_folder.clone());
    recent.native.replace_folders(roots);
    Ok(())
}

#[tauri::command]
pub async fn desktop_capture_recent_list(app: AppHandle, state: State<'_, CaptureState>) -> Result<RecentSnapshot, CaptureError> {
    let state = state.inner().clone();
    blocking(move || {
        let recent = state.0.recents.lock().unwrap();
        if recent.native.is_open() { return Ok(recent.native.snapshot()); }
        drop(recent);
        Ok(RecentCaptures::list(destinations(library_folder(&app, &state)?, None)))
    }).await
}

#[tauri::command]
pub async fn desktop_capture_recent_open(app: AppHandle, window: WebviewWindow, state: State<'_, CaptureState>, selected_folder: Option<PathBuf>) -> Result<RecentSnapshot, CaptureError> {
    let state = state.inner().clone();
    blocking(move || {
        let roots = destinations(library_folder(&app, &state)?, selected_folder.clone());
        let mut recent = state.0.recents.lock().unwrap();
        if recent.window.as_deref().is_some_and(|label| label != window.label()) { recent.native.close(); }
        recent.window = Some(window.label().into());
        recent.selected_folder = selected_folder;
        Ok(recent.native.open(roots, Arc::new(move |changes| { let _ = window.emit(RECENT_CAPTURE_EVENT, changes); })))
    }).await
}

#[tauri::command]
pub async fn desktop_capture_recent_refresh(window: WebviewWindow, state: State<'_, CaptureState>) -> Result<RecentSnapshot, CaptureError> {
    let state = state.inner().clone();
    blocking(move || {
        let mut recent = state.0.recents.lock().unwrap();
        if recent.window.as_deref() != Some(window.label()) { return Err(CaptureError::OperationUnavailable); }
        Ok(recent.native.refresh())
    }).await
}

#[tauri::command]
pub async fn desktop_capture_recent_close(window: WebviewWindow, state: State<'_, CaptureState>) -> Result<(), CaptureError> {
    let state = state.inner().clone();
    blocking(move || { close_recents_for_window(&state, window.label()); Ok(()) }).await
}

/// A visible tile's bytes, raw over IPC. Only what the listed recents show can be read.
#[tauri::command]
pub async fn desktop_capture_recent_read(state: State<'_, CaptureState>, path: PathBuf) -> Result<tauri::ipc::Response, CaptureError> {
    let state = state.inner().clone();
    blocking(move || {
        let listed = state.0.recents.lock().unwrap().native.snapshot().entries.iter().any(|entry| entry.path == path);
        if !listed { return Err(CaptureError::OperationUnavailable); }
        std::fs::read(&path).map(tauri::ipc::Response::new).map_err(|_| CaptureError::FileIo)
    }).await
}

#[tauri::command]
pub async fn desktop_capture_recent_open_media(app: AppHandle, state: State<'_, CaptureState>, path: PathBuf) -> Result<CaptureResult, CaptureError> {
    let state = state.inner().clone(); bind_events(&app, &state);
    blocking(move || {
        let folder = library_folder(&app, &state)?;
        crate::capture_window::ensure_capture_window(&app).map_err(|_| CaptureError::NativeFailure)?;
        state.open_file(|files| files.open_media(&folder, &path))
    }).await
}
