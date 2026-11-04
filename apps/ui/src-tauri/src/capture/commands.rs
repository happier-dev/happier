//! Tauri transport for the native capture owner.
use super::*;
use happier_desktop_native::capture::{PreparedPng, ScreenPermission, SelectionFacts, WindowDescriptor};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

pub(super) async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T, CaptureError> + Send + 'static) -> Result<T, CaptureError> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|_| CaptureError::NativeFailure)?
}

pub(super) fn with_preferences<T>(app: &AppHandle, state: &CaptureState,
    read: impl FnOnce(&mut preferences::CapturePreferences) -> Result<T, CaptureError>) -> Result<T, CaptureError> {
    let mut current = state.0.preferences.lock().unwrap();
    if current.is_none() {
        let path = app.path().app_config_dir().map_err(|_| CaptureError::FileIo)?.join("capture-preferences.json");
        *current = Some(preferences::CapturePreferences::load(path)?);
    }
    read(current.as_mut().unwrap())
}
pub(crate) fn library_folder(app: &AppHandle, state: &CaptureState) -> Result<PathBuf, CaptureError> {
    match with_preferences(app, state, |p| Ok(p.library_folder()))? {
        Some(folder) => Ok(folder),
        None => app.path().picture_dir().map(|p| p.join("Happier")).map_err(|_| CaptureError::FileIo),
    }
}
pub(super) fn bind_events(app: &AppHandle, state: &CaptureState) {
    let app = app.clone();
    state.set_publisher(Arc::new(move |snapshot, present, presentation_start, window_label, current_operation| {
        if let Err(error) = prepare_window(snapshot, present, window_label, |label|
            crate::capture_window::ensure_capture_window_with_label(&app, label).map(|_| ())) {
            log::warn!("failed to prepare the Capture host: {error}");
        }
        if presentation_start { let _ = crate::capture_window::start_presentation(&app, window_label); }
        if current_operation {
        match snapshot {
            CaptureSnapshot::Recording { recording, .. } => {
                crate::tray::recording_changed(&app, recording);
                super::selection_host::recording_marks_changed(&app, recording.phase);
            },
            CaptureSnapshot::Completed { result, .. } if result.kind == happier_desktop_native::capture::MediaKind::Video => {
                use happier_desktop_native::capture::recording::{Phase, Snapshot, Timing};
                crate::tray::recording_changed(&app, &Snapshot { phase: Phase::Ready,
                    timing: Timing { duration_ms: 0, active_since_ms: None }, result: Some(result.clone()), error: None,
                    source_ref: Some(result.capture_ref.clone()) });
            },
            _ => {},
        }
        if matches!(snapshot, CaptureSnapshot::Completed { .. } | CaptureSnapshot::Idle | CaptureSnapshot::Cancelled
            | CaptureSnapshot::Failed { .. } | CaptureSnapshot::Unavailable { .. }) {
            super::selection_host::release_recording_marks(&app);
        }
        let _ = app.emit_to(crate::desktop_window::MAIN_WINDOW_LABEL, CAPTURE_EVENT, snapshot);
        }
        if present || matches!(snapshot, CaptureSnapshot::SystemSelection { .. }) {
            let _ = app.emit_to(window_label, CAPTURE_EVENT, snapshot);
        }
        if matches!(snapshot, CaptureSnapshot::Selecting { .. }) {
            for label in app.webview_windows().keys().filter(|label| label.starts_with("capture_selection_")) {
                let _ = app.emit_to(label, CAPTURE_EVENT, snapshot);
            }
        }
    }));
}

pub(super) fn prepare_window(snapshot: &CaptureSnapshot, present: bool, label: &str,
    ensure: impl FnOnce(&str) -> Result<(), String>) -> Result<(), String> {
    if present && matches!(snapshot, CaptureSnapshot::Selecting { .. } | CaptureSnapshot::Acquiring { .. }) {
        ensure(label)?;
    }
    Ok(())
}

fn backend(app: &AppHandle) -> Result<Arc<dyn CaptureBackend>, CaptureError> {
    #[cfg(target_os = "windows")]
    crate::activity_overlay::watch_capture_display_changes(app).map_err(|_| CaptureError::NativeFailure)?;
    #[cfg(target_os = "macos")]
    {
        let displays = super::displays::source_displays(app)?;
        Ok(Arc::new(happier_desktop_native::capture::macos::MacCaptureBackend::new(displays)?))
    }
    #[cfg(target_os = "windows")]
    { Ok(Arc::new(happier_desktop_native::capture::windows::WindowsCaptureBackend::new(super::displays::monitor_scales(app)?)?)) }
    #[cfg(target_os = "linux")]
    {
        use happier_desktop_native::capture::linux::{DesktopSession, X11CaptureBackend};
        match super::session::read(app)? {
            DesktopSession::X11 => {
                crate::activity_overlay::watch_capture_display_changes(app).map_err(|_| CaptureError::NativeFailure)?;
                Ok(Arc::new(X11CaptureBackend::new(super::displays::monitor_scales(app)?)?))
            },
            DesktopSession::Wayland => Err(CaptureError::UnsupportedTarget),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    { let _ = app; Err(CaptureError::UnsupportedPlatform) }
}

pub(super) fn hide_selection(app: &AppHandle, capture_window: Option<&str>) -> Result<(), CaptureError> {
    // Helpers are hidden before any native acquisition; no guessed delay.
    // SCK/WGC additionally exclude this process at their native frame boundary.
    for (label, window) in app.webview_windows() {
        if label.starts_with("capture_selection_") || capture_window == Some(label.as_str()) {
            window.hide().map_err(|_| CaptureError::NativeFailure)?;
            if crate::desktop_window::is_capture_window(&label) { crate::capture_window::end_presentation(app, &label); }
        }
    }
    #[cfg(target_os = "linux")]
    if matches!(super::session::read(app), Ok(happier_desktop_native::capture::linux::DesktopSession::X11)) {
        use gtk::prelude::*;
        let sync = || gtk::gdk::Display::default().ok_or(CaptureError::NativeFailure)
            .map(|display| display.sync());
        if gtk::is_initialized_main_thread() { sync()?; }
        else {
            let (tx, rx) = std::sync::mpsc::channel();
            app.run_on_main_thread(move || { let _ = tx.send(sync()); }).map_err(|_| CaptureError::NativeFailure)?;
            rx.recv().map_err(|_| CaptureError::NativeFailure)??;
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_capture_start(app: AppHandle, state: State<'_, CaptureState>,
    mode: CaptureMode, target: Option<CaptureTarget>, target_session: Option<CaptureSessionTarget>,
    present_capture_window: Option<bool>) -> Result<CaptureSnapshot, CaptureError> {
    let state = state.inner().clone(); bind_events(&app, &state);
    // One device preference read at admission; selection/commit consume this request.
    let include_window_shadow = with_preferences(&app, &state, |preferences|
        Ok(preferences.include_window_shadow()))? && happier_desktop_native::capture::window_shadow_supported();
    let options = CaptureStartOptions { target_session, present_capture_window: present_capture_window.unwrap_or(true), include_window_shadow };
    let retry_state = state.clone();
    let request = CaptureStartRequest { mode, target: target.clone(), options: options.clone() };
    if let Some(snapshot) = blocking(move || {
        retry_state.recover_matching_start(&request)
    }).await? {
        if options.present_capture_window && matches!(snapshot, CaptureSnapshot::Completed { .. } | CaptureSnapshot::Recording { .. }
            | CaptureSnapshot::SystemSelection { .. } | CaptureSnapshot::Failed { .. } | CaptureSnapshot::Unavailable { .. }) {
            let label = state.current_window_label();
            crate::capture_window::start_presentation(&app, &label).map_err(|_| CaptureError::NativeFailure)?;
        }
        return Ok(snapshot);
    }
    let start_state = state.clone(); let start_app = app.clone();
    let snapshot = blocking(move || {
        let state = start_state; let app = start_app;
        state.remember_start(mode, target.clone(), options.clone());
        #[cfg(target_os = "linux")]
        if super::session::read(&app)? == happier_desktop_native::capture::linux::DesktopSession::Wayland {
            if target.is_some() { return Err(CaptureError::UnsupportedTarget); }
            let folder = library_folder(&app, &state)?;
            if mode == CaptureMode::Recording {
                // Agent capture still needs the person's system-picker scope
                // note, even when the eventual review will stay headless.
                return state.select_system_recording(options);
            }
            return state.start_portal(&folder, options,
                happier_desktop_native::capture::window_text::native_frontmost_context, |cancel| {
                hide_selection(&app, None)?;
                happier_desktop_native::capture::linux::screenshot(cancel)
            });
        }
        let folder = if mode == CaptureMode::Still && target.is_some() { library_folder(&app, &state)? } else { PathBuf::new() };
        state.start_with_target(mode, target, options, || backend(&app), &folder, || hide_selection(&app, None),
            |operation_ref, inventory| super::selection_host::show(&app, operation_ref, inventory))
    }).await?;
    super::recording::start_selected(&state, &app, snapshot).await
}
#[tauri::command]
pub fn desktop_capture_read_state(state: State<'_, CaptureState>, window: tauri::WebviewWindow,
    capture_ref: Option<String>) -> CaptureSnapshot {
    if let Some(capture_ref) = capture_ref { return state.snapshot_for_capture(&capture_ref).unwrap_or(CaptureSnapshot::Idle); }
    if crate::desktop_window::is_capture_window(window.label()) { state.snapshot_for_window(window.label()) }
    else { state.snapshot() }
}

#[tauri::command]
pub async fn desktop_capture_open(app: AppHandle, state: State<'_, CaptureState>, capture_ref: String,
    target_session: Option<CaptureSessionTarget>) -> Result<CaptureSnapshot, CaptureError> {
    let state = state.inner().clone(); bind_events(&app, &state);
    blocking(move || {
        let snapshot = state.open(&capture_ref, target_session)?;
        // Explicit open is demand, including a retained window whose current ref did not change.
        let label = state.window_label_for_capture(&capture_ref).ok_or(CaptureError::OperationUnavailable)?;
        crate::capture_window::start_presentation(&app, &label)
            .map_err(|_| CaptureError::NativeFailure)?;
        Ok(snapshot)
    }).await
}

#[tauri::command]
pub fn desktop_capture_settle(state: State<'_, CaptureState>, capture_ref: String) -> Result<CaptureSnapshot, CaptureError> {
    state.settle(&capture_ref)
}

#[tauri::command]
pub fn desktop_capture_read_delivery_state(state: State<'_, CaptureState>, capture_ref: String) -> Result<CaptureDeliveryState, CaptureError> {
    state.delivery_state(&capture_ref)
}

#[tauri::command]
pub fn desktop_capture_hit_test(state: State<'_, CaptureState>, operation_ref: u64, display_id: u32,
    local_x: f64, local_y: f64) -> Result<Option<WindowDescriptor>, CaptureError> {
    let op = state.0.operation.lock().unwrap();
    let active = op.active.as_ref().filter(|active| active.id == operation_ref).ok_or(CaptureError::OperationUnavailable)?;
    active.inventory.hit_test_local(display_id, local_x, local_y)
}

#[tauri::command]
pub fn desktop_capture_selection_facts(app: AppHandle, state: State<'_, CaptureState>, operation_ref: u64, display_id: u32) -> Result<NativeSelectionFacts, CaptureError> {
    let facts = {
        let op = state.0.operation.lock().unwrap();
        let active = op.active.as_ref().filter(|active| active.id == operation_ref).ok_or(CaptureError::OperationUnavailable)?;
        active.inventory.selection_facts(display_id)?
    };
    // Read once from this display's actual native host, not renderer screen
    // coordinates or a main-window/global DPI guess. No pointer listener/poll.
    let initial_pointer = app.get_webview_window(&super::selection_host::label(operation_ref, display_id))
        .and_then(|window| selection_pointer(window.cursor_position().ok()?, window.inner_position().ok()?,
            window.scale_factor().ok()?, facts.display.frame));
    Ok(NativeSelectionFacts { facts, initial_pointer })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSelectionFacts {
    #[serde(flatten)]
    facts: SelectionFacts,
    initial_pointer: Option<tauri::LogicalPosition<f64>>,
}

fn selection_pointer(cursor: tauri::PhysicalPosition<f64>, origin: tauri::PhysicalPosition<i32>,
    scale: f64, display: happier_desktop_native::geometry::Rect) -> Option<tauri::LogicalPosition<f64>> {
    use happier_desktop_native::geometry::{desktop_rect_to_display_local, Rect};
    let local = desktop_rect_to_display_local(
        Rect { x: origin.x as f64, y: origin.y as f64, width: 0., height: 0. }, scale,
        Rect { x: cursor.x, y: cursor.y, width: 0., height: 0. });
    (local.x >= 0. && local.y >= 0. && local.x < display.width && local.y < display.height)
        .then_some(tauri::LogicalPosition::new(local.x, local.y))
}

#[tauri::command]
pub fn desktop_capture_set_mode(window: tauri::WebviewWindow, state: State<'_, CaptureState>,
    operation_ref: u64, mode: CaptureMode) -> Result<CaptureSnapshot, CaptureError> {
    state.set_selection_mode(operation_ref, window.label(), mode)
}

#[tauri::command]
pub async fn desktop_capture_commit(app: AppHandle, state: State<'_, CaptureState>,
    operation_ref: u64, target: Option<CaptureTarget>) -> Result<CaptureSnapshot, CaptureError> {
    let state = state.inner().clone();
    let start_state = state.clone(); let start_app = app.clone();
    let snapshot = blocking(move || {
        let state = start_state; let app = start_app;
        let capture_window = state.current_window_label();
        let Some(target) = target else {
            #[cfg(target_os = "linux")]
            if super::session::read(&app)? == happier_desktop_native::capture::linux::DesktopSession::Wayland {
                return state.start_system_recording(operation_ref, &library_folder(&app, &state)?, |path, timeline, failed, cancel| {
                    hide_selection(&app, Some(&capture_window))?;
                    happier_desktop_native::capture::recording::linux::prepare_wayland(path, timeline, failed, cancel)
                });
            }
            return Err(CaptureError::UnsupportedTarget);
        };
        let snapshot = state.commit_with_folder(operation_ref, target,
            || library_folder(&app, &state), || hide_selection(&app, Some(&capture_window)))?;
        super::selection_host::settle_after_commit(&app, operation_ref, &snapshot);
        Ok(snapshot)
    }).await?;
    super::recording::start_selected(&state, &app, snapshot).await
}
#[tauri::command]
pub async fn desktop_capture_cancel(app: AppHandle, state: State<'_, CaptureState>, operation_ref: u64) -> Result<CaptureSnapshot, CaptureError> {
    let state = state.inner().clone();
    let result = blocking(move || state.cancel(operation_ref)).await?;
    if matches!(result, CaptureSnapshot::Cancelled) {
        hide_selection(&app, None)?;
        super::selection_host::release(&app);
    }
    Ok(result)
}

#[tauri::command]
pub async fn desktop_capture_targets(app: AppHandle, state: State<'_, CaptureState>) -> Result<Inventory, CaptureError> {
    let state = state.inner().clone(); bind_events(&app, &state);
    blocking(move || {
        state.targets(|| backend(&app))
    }).await
}
#[tauri::command]
pub async fn desktop_capture_display_facts(app: AppHandle, state: State<'_, CaptureState>, window: tauri::WebviewWindow) -> Result<Vec<super::displays::CaptureWindowDisplay>, CaptureError> {
    let state = state.inner().clone();
    blocking(move || super::displays::read(&app, &state, window.label())).await
}

#[tauri::command]
pub async fn desktop_capture_import_png(app: AppHandle, state: State<'_, CaptureState>, path: PathBuf) -> Result<CaptureResult, CaptureError> {
    let state = state.inner().clone(); bind_events(&app, &state);
    blocking(move || state.open_file(|files| files.import_png(&library_folder(&app, &state)?, &path))).await
}
#[tauri::command]
pub async fn desktop_capture_open_library_png(app: AppHandle, state: State<'_, CaptureState>, path: PathBuf) -> Result<CaptureResult, CaptureError> {
    let state = state.inner().clone(); bind_events(&app, &state);
    blocking(move || state.open_file(|files| files.open_library_png(&library_folder(&app, &state)?, &path))).await
}
#[tauri::command]
pub fn desktop_capture_read_result(state: State<'_, CaptureState>, capture_ref: String) -> Result<CaptureResult, CaptureError> {
    state.0.files.lock().unwrap().describe(&capture_ref)
}
#[tauri::command]
pub async fn desktop_capture_read_source_png(state: State<'_, CaptureState>, capture_ref: String) -> Result<Vec<u8>, CaptureError> {
    let state = state.inner().clone(); blocking(move || state.read_source(&capture_ref)).await
}
#[tauri::command]
pub async fn desktop_capture_write_prepared_png(state: State<'_, CaptureState>, capture_ref: String, bytes: Vec<u8>, disclosure: CaptureDisclosure) -> Result<PreparedPng, CaptureError> {
    let state = state.inner().clone(); blocking(move || state.0.files.lock().unwrap().write_prepared_png(&capture_ref, &bytes, disclosure)).await
}
#[tauri::command]
pub async fn desktop_capture_retain_prepared_png(state: State<'_, CaptureState>, capture_ref: String) -> Result<CaptureResult, CaptureError> {
    let state = state.inner().clone(); blocking(move || state.0.files.lock().unwrap().retain_prepared_png(&capture_ref)).await
}
#[tauri::command]
pub async fn desktop_capture_read_prepared_png(state: State<'_, CaptureState>, capture_ref: String) -> Result<Vec<u8>, CaptureError> {
    let state = state.inner().clone(); blocking(move || state.0.files.lock().unwrap().read_prepared_png(&capture_ref)).await
}
#[tauri::command]
pub async fn desktop_capture_discard(app: AppHandle, window: tauri::WebviewWindow,
    state: State<'_, CaptureState>, capture_ref: String) -> Result<(), CaptureError> {
    let label = state.window_label_for_capture(&capture_ref);
    let state = state.inner().clone();
    blocking(move || state.discard(&capture_ref)).await?;
    if let Some(label) = label.filter(|label| label != window.label()) {
        crate::capture_window::destroy_settled_window(&app, &label).map_err(|_| CaptureError::NativeFailure)?;
    }
    Ok(())
}
#[tauri::command]
pub fn desktop_capture_show_in_folder(app: AppHandle, state: State<'_, CaptureState>, capture_ref: String) -> Result<(), CaptureError> {
    let result = state.0.files.lock().unwrap().describe(&capture_ref)?;
    app.opener().reveal_item_in_dir(result.path).map_err(|_| CaptureError::FileIo)
}
#[tauri::command]
pub async fn desktop_capture_show_library_folder(app: AppHandle, state: State<'_, CaptureState>) -> Result<(), CaptureError> {
    let state = state.inner().clone();
    blocking(move || {
        let folder = library_folder(&app, &state)?;
        app.opener().open_path(folder.to_string_lossy(), None::<&str>).map_err(|_| CaptureError::FileIo)
    }).await
}
#[tauri::command]
pub async fn desktop_capture_library_folder(app: AppHandle, state: State<'_, CaptureState>) -> Result<PathBuf, CaptureError> {
    let state = state.inner().clone(); blocking(move || library_folder(&app, &state)).await
}
#[tauri::command]
pub async fn desktop_capture_set_library_folder(app: AppHandle, state: State<'_, CaptureState>, path: Option<PathBuf>) -> Result<(), CaptureError> {
    let state = state.inner().clone();
    blocking(move || {
        let changed = with_preferences(&app, &state, |p| p.set_library_folder(path.clone()))?;
        if changed {
            super::preference_commands::publish_preference(&app, "libraryFolder", path.as_ref().and_then(|p| p.to_str()));
            super::refresh_recent_folders(&app, &state)?;
        }
        Ok(())
    }).await
}
#[tauri::command]
pub fn desktop_capture_screen_permission(app: AppHandle, state: State<'_, CaptureState>) -> Result<ScreenPermission, CaptureError> {
    Ok(super::permission_commands::desktop_capture_permissions(app, state).screen)
}
#[tauri::command]
pub async fn desktop_capture_request_screen_permission(app: AppHandle, state: State<'_, CaptureState>) -> Result<ScreenPermission, CaptureError> {
    super::permission_commands::desktop_capture_request_permission(app, state,
        happier_desktop_native::capture::permissions::PermissionSubject::Screen)
        .await.map(|request| request.snapshot.screen)
}

#[cfg(test)]
mod selection_pointer_tests {
    use super::*;
    #[test]
    fn selector_capability_allows_registered_binding_read_but_not_mutation_or_media() {
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));
        let manifest: serde_json::Value = serde_json::from_slice(&std::fs::read(std::path::Path::new(env!("OUT_DIR")).join("acl-manifests.json")).unwrap()).unwrap();
        let capability: serde_json::Value = serde_json::from_slice(&std::fs::read(root.join("capabilities/capture-selection.json")).unwrap()).unwrap();
        let permissions = capability["permissions"].as_array().unwrap();
        assert!(permissions.contains(&serde_json::json!("allow-desktop-capture-selection")));
        assert!(!permissions.contains(&serde_json::json!("allow-desktop-capture")));
        let allowed = manifest["__app-acl__"]["permissions"]["allow-desktop-capture-selection"]["commands"]["allow"].as_array().unwrap();
        assert!(allowed.contains(&serde_json::json!("desktop_capture_shortcuts")), "selector must read its registered chord");
        for private in ["desktop_capture_set_shortcut", "desktop_capture_read_source_png", "desktop_capture_write_prepared_png"] {
            assert!(!allowed.contains(&serde_json::json!(private)));
        }
    }
    #[test]
    fn initial_pointer_is_local_to_its_host_at_native_scale_and_absent_on_other_displays() {
        let frame = happier_desktop_native::geometry::Rect { x: -250., y: 25., width: 150., height: 100. };
        let origin = tauri::PhysicalPosition::new(-500, 50);
        let point = selection_pointer(tauri::PhysicalPosition::new(-300., 100.), origin, 2., frame).unwrap();
        assert_eq!((point.x, point.y), (100., 25.));
        assert!(selection_pointer(tauri::PhysicalPosition::new(-501., 50.), origin, 2., frame).is_none());
        assert!(selection_pointer(tauri::PhysicalPosition::new(-200., 50.), origin, 2., frame).is_none());
    }
}
