#[cfg(desktop)]
use serde::{Deserialize, Serialize};

#[cfg(desktop)]
use std::sync::{Arc, Mutex};
#[cfg(desktop)]
use std::time::Duration;
#[cfg(desktop)]
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(desktop)]
use std::sync::mpsc;
#[cfg(target_os = "macos")]
use std::ffi::c_void;

#[cfg(target_os = "macos")]
use objc2_core_graphics::{
    CGDirectDisplayID, CGDisplayChangeSummaryFlags, CGDisplayRegisterReconfigurationCallback,
    CGError,
};
#[cfg(desktop)]
use tauri::{
    App, AppHandle, Emitter, Manager, Runtime, State, WebviewWindow,
};

#[cfg(desktop)]
mod diagnostics;
#[cfg(desktop)]
mod dock;
#[cfg(desktop)]
mod display_change;
#[cfg(desktop)]
mod display_choice;
#[cfg(desktop)]
mod displays;
#[cfg(desktop)]
mod native_display;
#[cfg(desktop)]
mod display_identity;
#[cfg(desktop)]
mod host_mode;
#[cfg(desktop)]
mod host_window;
#[cfg(desktop)]
mod macos_display_context;
#[cfg(desktop)]
pub(crate) mod monitor_resolution;
#[cfg(desktop)]
mod panel_host;
#[cfg(desktop)]
pub(crate) mod pointer;
#[cfg(target_os = "macos")]
mod macos_pointer;
#[cfg(target_os = "linux")]
mod linux_pointer;
#[cfg(target_os = "linux")]
mod linux_layer;
#[cfg(target_os = "windows")]
mod windows_pointer;
#[cfg(any(target_os = "windows", test))]
mod windows_fullscreen;
#[cfg(desktop)]
mod placement;
#[cfg(desktop)]
mod storage;
#[cfg(desktop)]
mod movement;
#[cfg(desktop)]
pub use movement::*;
#[cfg(desktop)]
mod window_lifecycle;
#[cfg(desktop)]
mod presentation_request;
#[cfg(desktop)]
pub use presentation_request::*;

/// Native subscriptions are installed only when capture metadata is requested.
/// The platform adapter owns signal resources, CaptureState owns invalidation.
#[cfg(any(target_os = "linux", target_os = "windows"))]
pub(crate) fn watch_capture_display_changes(app: &AppHandle) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    { native_display::watch_linux(app) }
    #[cfg(target_os = "windows")]
    {
        for window in app.webview_windows().values() {
            if window.label() == crate::desktop_window::MAIN_WINDOW_LABEL || crate::desktop_window::is_capture_window(window.label()) {
                watch_native_display_window(window)?;
            }
        }
        Ok(())
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn watch_native_display_window(window: &WebviewWindow) -> Result<(), String> {
    native_display::watch_window(window)
}

#[cfg(desktop)]
use self::diagnostics::DesktopActivityOverlayPlacementDiagnosticsPayload;
#[cfg(desktop)]
use self::dock::{Dock, FrameInput, FramePresentation};
#[cfg(desktop)]
use self::display_change::DesktopActivityOverlayDisplayChangeDebounce;
#[cfg(desktop)]
use self::host_mode::DesktopActivityOverlayDisplayContext;
#[cfg(desktop)]
use self::placement::{OverlayPlacementRect, Rect};
#[cfg(desktop)]
use self::window_lifecycle::{
    apply_overlay_state, publish_overlay_state,
};

#[cfg(desktop)]
const OVERLAY_WINDOW_LABEL: &str = "activity_overlay";
#[cfg(desktop)]
const MAIN_WINDOW_LABEL: &str = "main";
#[cfg(desktop)]
const OVERLAY_WINDOW_ROUTE: &str = "/desktop/activity-overlay?desktopOverlayWindow=1";
#[cfg(desktop)]
const OVERLAY_STATE_EVENT: &str = "activityOverlay://state";
#[cfg(desktop)]
const NATIVE_DISPLAY_CHANGE_DEBOUNCE_MS: u64 = 500;
#[cfg(desktop)]
const OVERLAY_POINTER_EVENT: &str = "activityOverlay://pointer";

#[cfg(desktop)]
#[derive(Clone, Default)]
pub struct ActivityOverlayState(Arc<Mutex<ActivityOverlayRuntimeState>>);

#[cfg(desktop)]
#[derive(Clone, Default)]
struct ActivityOverlayRuntimeState {
    presentation_request: Option<presentation_request::PresentationRequest>,
    last_sync_payload: Option<DesktopActivityOverlaySyncPayload>,
    last_window_state: Option<DesktopActivityOverlayWindowStatePayload>,
    present: Option<DesktopActivityOverlayPresentPayload>,
    rest_extent: Option<DesktopActivityOverlayExtent>,
    envelope: Option<Rect>,
    last_host_settings: Option<(Dock, bool, bool)>,
    native_visible: bool,
    host_failure: Option<String>,
    last_display_context: Option<DesktopActivityOverlayDisplayContext>,
    display_change_debounce: DesktopActivityOverlayDisplayChangeDebounce,
    display_inventory: Option<Vec<monitor_resolution::MonitorFacts>>,
    display_change_sender: Option<std::sync::mpsc::Sender<()>>,
    resolved_display_key: Option<String>,
    notch_positions: storage::NotchPositions,
}

#[cfg(desktop)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityOverlaySyncPayload {
    pub visible: bool,
    pub model: serde_json::Value,
    pub policy: DesktopActivityOverlayPolicyPayload,
}

#[cfg(desktop)]
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityOverlayWindowStatePayload {
    pub visible: bool,
    pub model: serde_json::Value,
    pub policy: DesktopActivityOverlayPolicyPayload,
    pub surface: DesktopActivityOverlaySurface,
    pub engaged: bool,
    pub availability: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame: Option<FramePresentation>,
    #[serde(skip)]
    pub frame_rect: Option<Rect>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placement_diagnostics: Option<DesktopActivityOverlayPlacementDiagnosticsPayload>,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DesktopActivityOverlaySurface {
    #[default]
    Hidden, Tip, CameraTip, Collapsed, Peek, Expanded, Pinned,
}

#[cfg(desktop)]
impl DesktopActivityOverlaySurface {
    fn is_open(self) -> bool { matches!(self, Self::Expanded | Self::Pinned) }
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityOverlayExtent {
    pub width: f64,
    pub height: f64,
    #[serde(default)]
    pub camera_offset: f64,
    /// Additional measured layer bounds in logical screen coordinates.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub screen_bounds: Option<Rect>,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityOverlayPresentPayload {
    pub surface: DesktopActivityOverlaySurface,
    pub engaged: bool,
    pub extent: DesktopActivityOverlayExtent,
    #[serde(default)]
    pub settled: bool,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DesktopActivityOverlayIdle {
    #[default]
    Tip, Full, Hidden,
}

#[cfg(desktop)]
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityOverlayPolicyPayload {
    pub enabled: bool,
    pub always_on_top: bool,
    #[serde(default)]
    pub dock: Dock,
    #[serde(default)]
    pub idle: DesktopActivityOverlayIdle,
    #[serde(default = "automatic_display_mode")]
    pub display_mode: String,
    #[serde(flatten)]
    pub content: serde_json::Map<String, serde_json::Value>,
}

#[cfg(desktop)]
fn automatic_display_mode() -> String { "automatic".into() }

#[cfg(desktop)]
pub(crate) fn release_for_menu_bar(app: &AppHandle) {
    let _ = pointer::set_visible(app, OVERLAY_WINDOW_LABEL, false);
    let Some(state) = app.try_state::<ActivityOverlayState>() else {
        return;
    };
    if let Ok(mut guard) = state.0.lock() {
        guard.last_sync_payload = None;
        guard.last_window_state = None;
        guard.present = None;
        guard.envelope = None;
        guard.last_host_settings = None;
        guard.display_change_debounce = Default::default();
    };
}

#[cfg(desktop)]
pub fn register<R: Runtime + 'static>(app: &mut App<R>) -> tauri::Result<()> {
    let state = app.state::<ActivityOverlayState>();
    if let Ok(mut guard) = state.0.lock() {
        guard.notch_positions = storage::read_notch_positions(app);
    }
    start_native_display_change_listener(app.handle().clone(), state.inner().clone());
    if let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        let handle=app.handle().clone();
        let owner=state.inner().clone();
        main.on_window_event(move |event| {
            if matches!(event,tauri::WindowEvent::Moved(_)) {
                let handle=handle.clone(); let owner=owner.clone();
                tauri::async_runtime::spawn_blocking(move || { let _=displays::main_moved(&handle,&owner); });
            }
        });
        #[cfg(target_os="windows")]
        native_display::watch_window(&main).map_err(std::io::Error::other)?;
    }
    #[cfg(target_os="linux")]
    if let Err(error)=native_display::watch_linux(app.handle()) {
        log::warn!("Display change subscription unavailable: {error}");
    }
    Ok(())
}

#[cfg(desktop)]
fn start_native_display_change_listener<R: Runtime + 'static>(
    app: AppHandle<R>,
    state: ActivityOverlayState,
) {
    let (tx, rx) = mpsc::channel();
    state.0.lock().expect("display state").display_change_sender=Some(tx.clone());
    #[cfg(target_os="macos")]
    {
    let user_info = Box::into_raw(Box::new(tx)) as *mut c_void;
    let registration_error = unsafe {
        CGDisplayRegisterReconfigurationCallback(
            Some(activity_overlay_display_reconfiguration_callback),
            user_info,
        )
    };
    if registration_error != CGError::Success {
        unsafe {
            drop(Box::from_raw(user_info.cast::<mpsc::Sender<()>>()));
        }
        return;
    }

    }
    std::thread::spawn(move || run_native_display_change_listener(app, state, rx));
}

#[cfg(target_os = "macos")]
unsafe extern "C-unwind" fn activity_overlay_display_reconfiguration_callback(
    _display_id: CGDirectDisplayID,
    flags: CGDisplayChangeSummaryFlags,
    user_info: *mut c_void,
) {
    if !native_display_change_flags_should_refresh(flags) {
        return;
    }

    let Some(sender) = (unsafe { (user_info as *const mpsc::Sender<()>).as_ref() }) else {
        return;
    };
    let _ = sender.send(());
}

#[cfg(target_os = "macos")]
fn native_display_change_flags_should_refresh(flags: CGDisplayChangeSummaryFlags) -> bool {
    !flags.contains(CGDisplayChangeSummaryFlags::BeginConfigurationFlag)
        && flags.intersects(
            CGDisplayChangeSummaryFlags::MovedFlag
                | CGDisplayChangeSummaryFlags::SetMainFlag
                | CGDisplayChangeSummaryFlags::SetModeFlag
                | CGDisplayChangeSummaryFlags::AddFlag
                | CGDisplayChangeSummaryFlags::RemoveFlag
                | CGDisplayChangeSummaryFlags::EnabledFlag
                | CGDisplayChangeSummaryFlags::DisabledFlag
                | CGDisplayChangeSummaryFlags::MirrorFlag
                | CGDisplayChangeSummaryFlags::UnMirrorFlag
                | CGDisplayChangeSummaryFlags::DesktopShapeChangedFlag,
        )
}

#[cfg(desktop)]
pub(super) fn request_display_refresh<R:Runtime>(app:&AppHandle<R>) {
    if let Some(state)=app.try_state::<ActivityOverlayState>() {
        if let Ok(guard)=state.0.lock() {
            if let Some(sender)=&guard.display_change_sender { let _=sender.send(()); }
        };
    }
}

#[cfg(desktop)]
fn run_native_display_change_listener<R: Runtime + 'static>(
    app: AppHandle<R>,
    state: ActivityOverlayState,
    rx: mpsc::Receiver<()>,
) {
    while rx.recv().is_ok() {
        let _ = record_native_display_change(&app, &state);
        loop {
            match rx.recv_timeout(Duration::from_millis(
                NATIVE_DISPLAY_CHANGE_DEBOUNCE_MS,
            )) {
                Ok(()) => {
                    let _ = record_native_display_change(&app, &state);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let Ok(action) = resolve_native_display_change_action(&state) else {
                        break;
                    };
                    if let Some(action) = action {
                        let _ = apply_native_display_change_action(&app, &state, action);
                        break;
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            }
        }
    }
}

#[cfg(desktop)]
fn record_native_display_change<R: Runtime>(
    app: &AppHandle<R>,
    state: &ActivityOverlayState,
) -> Result<(), String> {
    let capture = app.try_state::<crate::capture::CaptureState>();
    record_native_display_change_in_state(state, capture.as_deref())?;
    Ok(())
}

#[cfg(desktop)]
fn record_native_display_change_in_state(
    state: &ActivityOverlayState,
    capture: Option<&crate::capture::CaptureState>,
) -> Result<(), String> {
    // One completed native topology signal serves both consumers. Retire
    // capture's display-bound inventory before activity's visual debounce;
    // inactive capture performs no discovery, window work or publication.
    if let Some(capture) = capture {
        capture.invalidate_selection(None);
    }
    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        guard
            .display_change_debounce
            .record_display_change(current_epoch_millis());
        displays::invalidate_projection(&mut guard);
    }

    Ok(())
}

#[cfg(desktop)]
fn resolve_native_display_change_action(
    state: &ActivityOverlayState,
) -> Result<Option<()>, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
    Ok(guard
        .display_change_debounce
        .resolve_ready_action(current_epoch_millis(), NATIVE_DISPLAY_CHANGE_DEBOUNCE_MS))
}

#[cfg(desktop)]
fn apply_native_display_change_action<R: Runtime>(
    app: &AppHandle<R>,
    state: &ActivityOverlayState,
    _action: (),
) -> Result<(), String> {
    apply_overlay_state(app, state)
}

#[cfg(desktop)]
fn current_epoch_millis() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|value| value.as_millis() as u64).unwrap_or(0)
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_displays_list<R:Runtime>(app:AppHandle<R>, state:State<'_,ActivityOverlayState>) -> Result<displays::DesktopDisplaysList,String> {
    displays::list(&app,&state)
}


#[cfg(desktop)]
#[tauri::command]
pub fn desktop_activity_overlay_sync<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ActivityOverlayState>,
    payload: DesktopActivityOverlaySyncPayload,
) -> Result<(), String> {

    let reframe = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        let changed = sync_requires_frame(guard.last_sync_payload.as_ref(), &payload, guard.present);
        if changed { guard.envelope = None; }
        guard.last_sync_payload = Some(payload);
        changed
    };

    if reframe { apply_overlay_state(&app, state.inner())?; } else { publish_overlay_state(&app, state.inner())?; }
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_activity_overlay_get_window_state(
    state: State<'_, ActivityOverlayState>,
) -> Result<Option<DesktopActivityOverlayWindowStatePayload>, String> {

    let guard = state
        .0
        .lock()
        .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
    Ok(guard.last_window_state.clone())
}

#[cfg(desktop)]
fn sync_requires_frame(previous: Option<&DesktopActivityOverlaySyncPayload>, next: &DesktopActivityOverlaySyncPayload, present: Option<DesktopActivityOverlayPresentPayload>) -> bool {
    let Some(previous) = previous else { return true; };
    let (a, b) = (&previous.policy, &next.policy);
    let bootstrap_changed = present.is_none() && (previous.visible || a.idle != DesktopActivityOverlayIdle::Hidden)
        != (next.visible || b.idle != DesktopActivityOverlayIdle::Hidden);
    bootstrap_changed || a.enabled != b.enabled || a.always_on_top != b.always_on_top || a.dock != b.dock
        || a.display_mode != b.display_mode
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_activity_overlay_present<R: Runtime>(
    app: AppHandle<R>, state: State<'_, ActivityOverlayState>,
    payload: DesktopActivityOverlayPresentPayload,
) -> Result<(), String> {
    let extent = payload.extent;
    if !extent.width.is_finite() || !extent.height.is_finite() || !extent.camera_offset.is_finite()
        || extent.screen_bounds.is_some_and(|rect| !rect.x.is_finite() || !rect.y.is_finite()
            || !rect.width.is_finite() || !rect.height.is_finite() || rect.width <= 0. || rect.height <= 0.)
        || (payload.surface != DesktopActivityOverlaySurface::Hidden && (extent.width <= 0. || extent.height <= 0.)) {
        return Err("Desktop activity overlay extent must be finite and positive".to_string());
    }
    {
        let mut guard = state.0.lock().map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        if guard.present == Some(payload) { return Ok(()); }
        if payload.surface != DesktopActivityOverlaySurface::Hidden && (!payload.surface.is_open() || guard.rest_extent.is_none()) { guard.rest_extent = Some(extent); }
        guard.present = Some(payload);
    }
    apply_overlay_state(&app, state.inner())
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_activity_overlay_pointer_enter<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    pointer::enter(&app, OVERLAY_WINDOW_LABEL)
}

#[cfg(desktop)]
pub(crate) fn host_availability<R: Runtime>(app: &AppHandle<R>) -> serde_json::Value {
    let reason = app.try_state::<ActivityOverlayState>().and_then(|state| state.0.lock().ok().and_then(|guard| guard.host_failure.clone()));
    availability_for_failure(reason.as_deref())
}

#[cfg(desktop)]
fn availability_for_failure(reason: Option<&str>) -> serde_json::Value {
    match reason {
        Some(reason) => serde_json::json!({"kind":"unavailable", "reason":reason}),
        None => serde_json::json!({"kind":"available"}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::monitor_resolution::{logical_rect_from_physical_bounds, resolve_monitor_logical_scale_factor};
    use super::placement::DesktopActivityOverlayMonitorSource;
    use super::window_lifecycle::build_overlay_window_navigation_url;
    use serde_json::{json, Value};
    use std::{env, fs, path::PathBuf};
    #[test]
    fn sync_accepts_content_without_main_window_presentation() {
        let payload = serde_json::json!({
            "visible": true, "model": { "word": "Ready" },
            "policy": { "enabled": true, "visibilityMode": "active_sessions", "showWhenRunning": true,
                "showWhenAttentionRequired": true, "showWhenReady": true, "alwaysOnTop": true,
                "autoHideEnabled": false, "autoHideDelayMs": 6000, "expandedBehavior": "click",
                "interactiveCollapsed": true, "clickAction": "expand_overlay", "density": "compact",
                "compactStyle": "pill", "showSessionCount": true, "showPreviewText": false,
                "placementMode": "anchored", "displayMode": "automatic", "anchor": "top_center",
                "offsetX": 0, "offsetY": 0, "enableDragReposition": false, "lockPosition": true,
                "dock": "top", "idle": "tip" }
        });
        let parsed: DesktopActivityOverlaySyncPayload = serde_json::from_value(payload).unwrap();
        let published = serde_json::to_value(parsed).unwrap();
        assert!(published.get("expanded").is_none());
        assert!(published.get("window").is_none());
    }

    fn sync_payload(visible: bool) -> DesktopActivityOverlaySyncPayload {
        serde_json::from_value(json!({"visible":visible,"model":{"word":"Ready"},
            "policy":{"enabled":true,"alwaysOnTop":true,"dock":"top","idle":"hidden"}})).unwrap()
    }

    #[test]
    fn first_visible_content_bootstraps_an_idle_hidden_route() {
        let hidden = sync_payload(false);
        let visible = sync_payload(true);
        assert!(sync_requires_frame(Some(&hidden), &visible, None));
    }



    #[test]
    fn content_changes_do_not_schedule_native_geometry() {
        let previous = sync_payload(true);
        let mut next = previous.clone();
        next.model = json!({"word":"Working","sessionCount":3});
        next.policy.content.insert("showPreviewText".into(), json!(true));
        assert!(!sync_requires_frame(Some(&previous), &next, None));
        next.policy.dock = Dock::Left;
        assert!(sync_requires_frame(Some(&previous), &next, None));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_display_change_signal_includes_same_scale_changes_and_display_removal() {
        use happier_desktop_native::capture::{CaptureBackend, CaptureError, CaptureTarget, Inventory, RgbaFrame, CancelSignal};
        struct NativeDisplays;
        impl CaptureBackend for NativeDisplays {
            fn discover(&self) -> Result<Inventory, CaptureError> { Ok(Inventory { displays: vec![], windows: vec![] }) }
            fn capture_display(&self, _: u32, _: &CancelSignal) -> Result<RgbaFrame, CaptureError> { panic!("a display signal cannot read pixels") }
            fn capture_window(&self, _: u32, _include_shadow: bool, _: &CancelSignal) -> Result<RgbaFrame, CaptureError> { panic!("a display signal cannot read pixels") }
        }
        for flags in [CGDisplayChangeSummaryFlags::MovedFlag, CGDisplayChangeSummaryFlags::SetModeFlag,
            CGDisplayChangeSummaryFlags::RemoveFlag] {
            let capture = crate::capture::CaptureState::default();
            let activity = ActivityOverlayState::default();
            let snapshot = capture.begin(crate::capture::CaptureMode::Still, || Ok(Arc::new(NativeDisplays))).unwrap();
            let (tx, rx) = mpsc::channel::<()>();
            unsafe { activity_overlay_display_reconfiguration_callback(7, flags,
                (&tx as *const mpsc::Sender<()>).cast_mut().cast()); }
            assert_eq!(rx.try_recv(), Ok(()), "the existing activity signal must also reach capture");
            record_native_display_change_in_state(&activity, Some(&capture)).unwrap();
            assert_eq!(capture.snapshot(), crate::capture::CaptureSnapshot::Failed { reason: CaptureError::TargetUnavailable });
            assert!(activity.0.lock().unwrap().display_change_debounce.resolve_ready_action(u64::MAX,
                NATIVE_DISPLAY_CHANGE_DEBOUNCE_MS).is_some(), "capture invalidation cannot suppress activity's existing display change");
            assert_eq!(capture.commit(snapshot.operation_ref().unwrap(), CaptureTarget::Display { display_id: 7 },
                std::path::Path::new("unused"), || panic!("retired selection must not acquire pixels")), Err(CaptureError::OperationUnavailable));
            assert_eq!(rx.try_recv(), Err(mpsc::TryRecvError::Empty));
        }
        let (tx, rx) = mpsc::channel::<()>();
        unsafe { activity_overlay_display_reconfiguration_callback(7,
            CGDisplayChangeSummaryFlags::BeginConfigurationFlag | CGDisplayChangeSummaryFlags::SetModeFlag,
            (&tx as *const mpsc::Sender<()>).cast_mut().cast()); }
        assert_eq!(rx.try_recv(), Err(mpsc::TryRecvError::Empty), "an unfinished topology is not a completed change");
    }

    fn read_capability_file(name: &str) -> Value {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("capabilities")
            .join(name);
        let content = fs::read_to_string(&path).unwrap_or_else(|error| {
            panic!("failed to read capability {}: {error}", path.display())
        });
        serde_json::from_str(&content).unwrap_or_else(|error| {
            panic!("failed to parse capability {}: {error}", path.display())
        })
    }

    fn read_generated_acl_manifest_file() -> Value {
        let path = PathBuf::from(env!("OUT_DIR")).join("acl-manifests.json");
        let content = fs::read_to_string(&path).unwrap_or_else(|error| {
            panic!(
                "failed to read generated acl manifest {}: {error}",
                path.display()
            )
        });
        serde_json::from_str(&content).unwrap_or_else(|error| {
            panic!(
                "failed to parse generated acl manifest {}: {error}",
                path.display()
            )
        })
    }

    fn read_tauri_config_file(name: &str) -> Value {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(name);
        let content = fs::read_to_string(&path).unwrap_or_else(|error| {
            panic!("failed to read tauri config {}: {error}", path.display())
        });
        serde_json::from_str(&content).unwrap_or_else(|error| {
            panic!("failed to parse tauri config {}: {error}", path.display())
        })
    }

    #[test]
    fn activity_overlay_uses_a_dedicated_capability_instead_of_the_main_default_scope() {
        let default_capability = read_capability_file("default.json");
        let main_windows = default_capability["windows"].as_array().unwrap();
        assert!(main_windows.contains(&json!("main")));
        assert!(!main_windows.contains(&json!(OVERLAY_WINDOW_LABEL)));

        let overlay_capability = read_capability_file("overlay.json");
        assert_eq!(overlay_capability["windows"], json!(["activity_overlay"]));

        let permissions = overlay_capability["permissions"]
            .as_array()
            .expect("overlay capability permissions should be an array");

        assert!(permissions.contains(&Value::String("core:default".to_string())));
        for required_permission in [
            "allow-desktop-show-main-window",
            "allow-desktop-activity-overlay-get-window-state",
            "allow-desktop-activity-overlay-present",
            "allow-desktop-activity-overlay-take-presentation-request",
            "allow-desktop-activity-overlay-set-keyboard-wanted",
            "allow-desktop-activity-overlay-pointer-enter",
            "allow-desktop-activity-overlay-move",
            "allow-desktop-window-emit-action",
        ] {
            assert!(
                permissions.contains(&Value::String(required_permission.to_string())),
                "overlay capability should include {required_permission}",
            );
        }
        for forbidden_permission in [
            "http:default",
            "notification:default",
            "dialog:allow-open",
            "core:window:allow-set-badge-count",
            "core:window:allow-set-badge-label",
            "allow-desktop-fetch-update",
            "allow-desktop-install-update",
            "allow-desktop-finish-shutdown",
            "allow-start-system-task",
            "allow-cancel-system-task",
            "allow-respond-system-task-prompt",
            "allow-desktop-read-stack-boot-credentials",
            "allow-desktop-activity-overlay-sync",
            "allow-desktop-displays-list",
            "allow-desktop-window-emit-action-result",
        ] {
            assert!(
                !permissions.contains(&Value::String(forbidden_permission.to_string())),
                "overlay capability should not include {forbidden_permission}",
            );
        }

        let default_permissions = default_capability["permissions"]
            .as_array()
            .expect("default capability permissions should be an array");

        for required_permission in [
            "allow-desktop-fetch-update",
            "allow-desktop-install-update",
            "allow-desktop-pick-ssh-identity-file",
            "allow-desktop-set-tray-state",
            "allow-desktop-finish-shutdown",
            "allow-desktop-set-tray-state",
            "allow-start-system-task",
            "allow-cancel-system-task",
            "allow-get-system-task-snapshot",
            "allow-system-tasks-open-log-path",
            "allow-respond-system-task-prompt",
            "allow-desktop-get-window-chrome-policy",
            "allow-desktop-get-window-state",
            "allow-desktop-minimize-window",
            "allow-desktop-toggle-window-maximize",
            "allow-desktop-close-window",
            "allow-desktop-show-main-window",
            "allow-desktop-start-window-dragging",
            "allow-desktop-set-window-mode",
            "allow-desktop-read-stack-boot-credentials",
            "allow-desktop-activity-overlay-sync",
            "allow-desktop-displays-list",
            "allow-desktop-activity-overlay-get-window-state",
            "allow-desktop-activity-overlay-move",
            "allow-desktop-host-get-availability",
            "allow-desktop-window-emit-action-result",
        ] {
            assert!(
                default_permissions.contains(&Value::String(required_permission.to_string())),
                "default capability should include {required_permission}",
            );
        }
        let presentation = read_capability_file("notch-presentation.json");
        assert_eq!(presentation["windows"], json!(["main", "activity_overlay"]));
        assert_eq!(presentation["permissions"], json!(["allow-desktop-activity-overlay-request-presentation"]));
    }

    #[test]
    fn generated_acl_manifest_includes_app_command_permissions_for_overlay_partition() {
        let manifest = read_generated_acl_manifest_file();
        let app_acl = manifest["__app-acl__"]
            .as_object()
            .expect("generated acl manifest should include the app command manifest");
        let permissions = app_acl["permissions"]
            .as_object()
            .expect("generated app acl manifest should include app command permissions");

        for permission in [
            "allow-desktop-fetch-update",
            "allow-desktop-show-main-window",
            "allow-desktop-read-stack-boot-credentials",
            "allow-desktop-activity-overlay-sync",
            "allow-desktop-activity-overlay-get-window-state",
            "allow-desktop-activity-overlay-present",
            "allow-desktop-activity-overlay-request-presentation",
            "allow-desktop-activity-overlay-take-presentation-request",
            "allow-desktop-activity-overlay-set-keyboard-wanted",
            "allow-desktop-activity-overlay-pointer-enter",
            "allow-desktop-activity-overlay-move",
            "allow-desktop-host-get-availability",
            "allow-desktop-window-emit-action",
            "allow-desktop-window-emit-action-result",
        ] {
            assert!(
                permissions.contains_key(permission),
                "generated app acl manifest should include {permission}",
            );
        }
    }

    #[test]
    fn stable_and_publicdev_tauri_configs_include_the_overlay_capability() {
        for config_name in ["tauri.conf.json", "tauri.publicdev.conf.json"] {
            let config = read_tauri_config_file(config_name);
            assert_eq!(
                config["app"]["macOSPrivateApi"], true,
                "{config_name} should keep macOSPrivateApi enabled for overlay transparency",
            );

            let capabilities = config["app"]["security"]["capabilities"]
                .as_array()
                .unwrap_or_else(|| {
                    panic!("{config_name} should declare app.security.capabilities")
                });

            assert!(
                capabilities.contains(&Value::String("default".to_string())),
                "{config_name} should keep the default capability",
            );
            assert!(
                capabilities.contains(&Value::String("overlay".to_string())),
                "{config_name} should include the overlay capability for the overlay window",
            );
            assert!(capabilities.contains(&json!("notch-presentation")),
                "{config_name} should include the notch presentation capability");
        }
    }

    #[test]
    fn builds_the_overlay_window_navigation_url_with_the_overlay_route_and_marker() {
        let current_url = tauri::Url::parse("http://localhost:8081/").expect("valid url");
        let next_url =
            build_overlay_window_navigation_url(&current_url).expect("expected overlay url");

        assert_eq!(
            next_url.as_str(),
            "http://localhost:8081/desktop/activity-overlay?desktopOverlayWindow=1"
        );
    }

    #[test]
    fn builds_the_overlay_window_navigation_url_preserving_existing_server_scope() {
        let current_url =
            tauri::Url::parse("http://localhost:8081/?server=http%3A%2F%2F127.0.0.1%3A3009")
                .expect("valid url");
        let next_url =
            build_overlay_window_navigation_url(&current_url).expect("expected overlay url");

        assert_eq!(
            next_url.as_str(),
            "http://localhost:8081/desktop/activity-overlay?desktopOverlayWindow=1&server=http%3A%2F%2F127.0.0.1%3A3009"
        );
    }

    #[test]
    fn builds_the_overlay_window_navigation_url_normalizing_existing_overlay_marker() {
        let current_url = tauri::Url::parse(
            "http://localhost:8081/settings?desktopOverlayWindow=0&server=http%3A%2F%2F127.0.0.1%3A3009",
        )
        .expect("valid url");
        let next_url =
            build_overlay_window_navigation_url(&current_url).expect("expected overlay url");

        assert_eq!(
            next_url.as_str(),
            "http://localhost:8081/desktop/activity-overlay?desktopOverlayWindow=1&server=http%3A%2F%2F127.0.0.1%3A3009"
        );
    }

    #[test]
    fn logical_rect_conversion_prefers_monitor_scale_factor_over_window_fallback() {
        let rect = logical_rect_from_physical_bounds(
            0,
            0,
            3024,
            1964,
            resolve_monitor_logical_scale_factor(2.0, 1.0),
        );

        assert_eq!(
            rect,
            Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 982.0,
            },
        );
    }

    #[test]
    fn logical_rect_conversion_falls_back_when_monitor_scale_factor_is_invalid() {
        let rect = logical_rect_from_physical_bounds(
            2880,
            0,
            1920,
            1080,
            resolve_monitor_logical_scale_factor(0.0, 1.25),
        );

        assert_eq!(
            rect,
            Rect {
                x: 2304.0,
                y: 0.0,
                width: 1536.0,
                height: 864.0,
            },
        );
    }
}
