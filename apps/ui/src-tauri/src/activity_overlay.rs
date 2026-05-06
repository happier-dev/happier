#[cfg(desktop)]
use serde::{Deserialize, Serialize};

#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(desktop)]
use std::sync::{Arc, Mutex};
#[cfg(target_os = "macos")]
use std::time::Duration;
#[cfg(desktop)]
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(target_os = "macos")]
use std::{ffi::c_void, sync::mpsc};

#[cfg(target_os = "macos")]
use objc2_app_kit::NSEvent;
#[cfg(target_os = "macos")]
use objc2_core_graphics::{
    CGDirectDisplayID, CGDisplayChangeSummaryFlags, CGDisplayRegisterReconfigurationCallback,
    CGError,
};
#[cfg(desktop)]
use tauri::{
    App, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, State, WebviewWindow,
};

#[cfg(desktop)]
mod diagnostics;
#[cfg(desktop)]
mod display_change;
#[cfg(desktop)]
mod display_identity;
#[cfg(desktop)]
mod host_mode;
#[cfg(desktop)]
mod host_window;
#[cfg(desktop)]
mod macos_display_context;
#[cfg(target_os = "macos")]
mod macos_event_repost;
#[cfg(desktop)]
mod monitor_resolution;
#[cfg(desktop)]
mod notch_native_geometry;
#[cfg(desktop)]
mod panel_host;
#[cfg(desktop)]
mod placement;
#[cfg(desktop)]
mod storage;
#[cfg(desktop)]
mod window_lifecycle;

#[cfg(desktop)]
use self::diagnostics::{
    build_overlay_placement_diagnostics, DesktopActivityOverlayHostFallbackReason,
    DesktopActivityOverlayNativeHostPath, DesktopActivityOverlayPlacementDiagnosticsPayload,
};
#[cfg(desktop)]
use self::display_change::{
    DesktopActivityOverlayDisplayChangeAction, DesktopActivityOverlayDisplayChangeDebounce,
    DesktopActivityOverlayOpenReason,
};
#[cfg(desktop)]
use self::host_mode::{
    resolve_desktop_activity_overlay_host_mode_resolution, resolve_overlay_placement_for_host_mode,
    DesktopActivityOverlayDisplayContext, DesktopActivityOverlayHostMode,
};
#[cfg(desktop)]
use self::host_window::{
    apply_macos_overlay_window_collection_behavior, resolve_macos_overlay_window_host_settings,
    should_apply_raw_macos_overlay_window_collection_behavior,
};
#[cfg(desktop)]
use self::macos_display_context::resolve_overlay_display_context_for_monitor;
#[cfg(target_os = "macos")]
use self::macos_event_repost::repost_macos_left_click_after_collapse;
#[cfg(desktop)]
use self::monitor_resolution::resolve_anchor_monitor_resolution;
#[cfg(desktop)]
use self::notch_native_geometry::{
    advance_expanded_notch_native_mouse_state, advance_notch_native_mouse_state,
    resolve_notch_integrated_hit_rect, resolve_notch_integrated_panel_rect,
    resolve_notch_integrated_window_dimensions, DesktopActivityOverlayNativeMouseEffect,
    DesktopActivityOverlayNativeMousePoint, DesktopActivityOverlayNativeMouseState,
};
#[cfg(desktop)]
use self::panel_host::{apply_macos_overlay_panel_host, apply_macos_overlay_panel_position};
#[cfg(desktop)]
use self::placement::{
    clamp, sanitize_dimension, sanitize_offset, DesktopActivityOverlayDisplayMode, Rect,
};
#[cfg(desktop)]
use self::storage::{
    clear_persisted_drag_offsets_for_display, migrate_persisted_drag_offsets_for_display_paths,
    persist_drag_offsets_for_display, read_persisted_drag_offsets,
    resolve_drag_offsets_legacy_storage_keys_for_display, resolve_drag_offsets_path,
    resolve_drag_offsets_path_for_display, resolve_drag_offsets_path_for_storage_key,
    sanitize_drag_offsets, PersistedOverlayDragOffsets,
};
#[cfg(desktop)]
use self::window_lifecycle::{
    ensure_overlay_window, park_overlay_window_offscreen, show_overlay_window_without_activation,
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
const OVERLAY_INTERACTION_EVENT: &str = "activityOverlay://interaction";
#[cfg(desktop)]
const OVERLAY_INTERACTION_RESULT_EVENT: &str = "activityOverlay://interaction-result";
#[cfg(desktop)]
const OVERLAY_INTERACTION_COMMAND_ALLOWED_LABELS: &[&str] =
    &[OVERLAY_WINDOW_LABEL, MAIN_WINDOW_LABEL];
#[cfg(desktop)]
const OVERLAY_SAFE_PADDING_PX: f64 = 12.0;
#[cfg(desktop)]
const NATIVE_NOTCH_MOUSE_POLL_INTERVAL_MS: u64 = 50;
#[cfg(desktop)]
const NATIVE_NOTCH_HOVER_EXPAND_DELAY_MS: u64 = 500;
#[cfg(desktop)]
const NATIVE_DISPLAY_CHANGE_DEBOUNCE_MS: u64 = 500;
#[cfg(desktop)]
const NATIVE_DISPLAY_CHANGE_POLL_INTERVAL_MS: u64 = 50;
#[cfg(desktop)]
const OVERLAY_INPUT_LOCK_HEARTBEAT_TIMEOUT_MS: u64 = 30_000;
#[cfg(desktop)]
const QA_PROOF_PIN_UNTIL_MODEL_KEY: &str = "__happierQaProofPinUntilEpochMs";
#[cfg(desktop)]
const PET_VELOCITY_MAX_MAGNITUDE_PX_PER_S: f64 = 1600.0;
#[cfg(desktop)]
const PET_MOMENTUM_TICK_MS: u64 = 16;
#[cfg(desktop)]
const PET_MOMENTUM_FRICTION: f64 = 0.88;
#[cfg(desktop)]
const PET_MOMENTUM_STOP_SPEED_PX_PER_S: f64 = 65.0;
#[cfg(desktop)]
const PET_MOMENTUM_MAX_DURATION_MS: u64 = 900;

// Keep the parked overlay far outside the monitor bounds so it remains "shown" (CDP target alive)
// without being user-visible.
#[cfg(desktop)]
const OVERLAY_PARK_OFFSCREEN_DISTANCE_PX: f64 = 10_000.0;

#[cfg(desktop)]
#[derive(Clone, Default)]
pub struct ActivityOverlayState(Arc<Mutex<ActivityOverlayRuntimeState>>);

#[cfg(desktop)]
#[derive(Clone, Default)]
struct ActivityOverlayRuntimeState {
    last_sync_payload: Option<DesktopActivityOverlaySyncPayload>,
    last_window_state: Option<DesktopActivityOverlayWindowStatePayload>,
    desired_expanded: Option<bool>,
    drag_offsets: PersistedOverlayDragOffsets,
    drag_offsets_loaded: bool,
    drag_offsets_storage_key: Option<String>,
    last_display_context: Option<DesktopActivityOverlayDisplayContext>,
    runtime_host_fallback: Option<ActivityOverlayRuntimeHostFallback>,
    display_change_debounce: DesktopActivityOverlayDisplayChangeDebounce,
    native_mouse_state: DesktopActivityOverlayNativeMouseState,
    input_locked: bool,
    input_lock_updated_at_epoch_ms: Option<u64>,
    qa_pinned_sync_payload: Option<ActivityOverlayQaPinnedSyncPayload>,
    momentum_generation: u64,
}

#[cfg(desktop)]
#[derive(Clone, Debug)]
struct ActivityOverlayQaPinnedSyncPayload {
    payload: DesktopActivityOverlaySyncPayload,
    expires_at_epoch_ms: u64,
}

#[cfg(desktop)]
#[derive(Clone, Debug, PartialEq)]
struct ActivityOverlayRuntimeHostFallback {
    display_context: DesktopActivityOverlayDisplayContext,
    reason: DesktopActivityOverlayHostFallbackReason,
}

#[cfg(desktop)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityOverlaySyncPayload {
    pub visible: bool,
    pub expanded: bool,
    pub model: serde_json::Value,
    pub policy: DesktopActivityOverlayPolicyPayload,
    pub window: DesktopActivityOverlayWindowDimensionsPayload,
}

#[cfg(desktop)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityOverlayWindowStatePayload {
    pub visible: bool,
    pub expanded: bool,
    pub model: serde_json::Value,
    pub policy: DesktopActivityOverlayPolicyPayload,
    pub window: DesktopActivityOverlayWindowDimensionsPayload,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub placement_diagnostics: Option<DesktopActivityOverlayPlacementDiagnosticsPayload>,
}

#[cfg(desktop)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityOverlayDragVelocityPayload {
    pub pointer_id: String,
    pub vx: f64,
    pub vy: f64,
    pub sample_window_ms: f64,
}

#[cfg(desktop)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityOverlayMomentumDeltaPayload {
    pub generation: u64,
    pub delta_x: f64,
    pub delta_y: f64,
}

#[cfg(desktop)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityOverlayScheduledMomentumDeltaPayload {
    pub delta_x: f64,
    pub delta_y: f64,
    pub delay_ms: u64,
}

#[cfg(desktop)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityOverlayMomentumPlanPayload {
    pub generation: u64,
    pub tick_ms: u64,
    pub deltas: Vec<DesktopActivityOverlayScheduledMomentumDeltaPayload>,
}

#[cfg(desktop)]
impl DesktopActivityOverlayWindowStatePayload {
    fn from_sync_payload(
        payload: &DesktopActivityOverlaySyncPayload,
        placement_diagnostics: Option<DesktopActivityOverlayPlacementDiagnosticsPayload>,
    ) -> Self {
        Self {
            visible: payload.visible,
            expanded: payload.expanded,
            model: payload.model.clone(),
            policy: payload.policy.clone(),
            window: payload.window.clone(),
            placement_diagnostics,
        }
    }
}

#[cfg(desktop)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityOverlayWindowDimensionsPayload {
    pub collapsed: DesktopActivityOverlayDimensionsPayload,
    pub expanded: DesktopActivityOverlayDimensionsPayload,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityOverlayDimensionsPayload {
    pub width: f64,
    pub height: f64,
}

#[cfg(desktop)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityOverlayPolicyPayload {
    pub enabled: bool,
    pub visibility_mode: DesktopActivityOverlayVisibilityMode,
    pub show_when_running: bool,
    pub show_when_attention_required: bool,
    pub show_when_ready: bool,
    pub always_on_top: bool,
    pub auto_hide_enabled: bool,
    pub auto_hide_delay_ms: i64,
    pub expanded_behavior: DesktopActivityOverlayExpandedBehavior,
    pub interactive_collapsed: bool,
    #[serde(default)]
    pub presentation_mode: DesktopActivityOverlayPresentationMode,
    pub click_action: DesktopActivityOverlayClickAction,
    pub density: DesktopActivityOverlayDensity,
    pub compact_style: DesktopActivityOverlayCompactStyle,
    pub show_session_count: bool,
    pub show_preview_text: bool,
    pub placement_mode: DesktopActivityOverlayPlacementMode,
    #[serde(default)]
    pub display_mode: DesktopActivityOverlayDisplayMode,
    pub anchor: DesktopActivityOverlayAnchor,
    pub offset_x: f64,
    pub offset_y: f64,
    pub enable_drag_reposition: bool,
    pub lock_position: bool,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DesktopActivityOverlayVisibilityMode {
    AttentionOnly,
    ActiveSessions,
    AlwaysWhenEnabled,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DesktopActivityOverlayClickAction {
    ExpandOverlay,
    OpenPrimarySession,
    OpenSessions,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DesktopActivityOverlayExpandedBehavior {
    Click,
    Hover,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DesktopActivityOverlayPresentationMode {
    #[default]
    Automatic,
    NotchIntegrated,
    FloatingOverlay,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DesktopActivityOverlayDensity {
    Compact,
    Comfortable,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DesktopActivityOverlayCompactStyle {
    Pill,
    Panel,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DesktopActivityOverlayPlacementMode {
    Anchored,
    Custom,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum DesktopActivityOverlayAnchor {
    TopCenter,
    TopLeft,
    TopRight,
    BottomCenter,
    BottomLeft,
    BottomRight,
    LeftCenter,
    RightCenter,
}

#[cfg(desktop)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityOverlayInteractionPayload {
    #[serde(default)]
    pub request_id: Option<String>,
    pub action_identifier: String,
    #[serde(default)]
    pub data: serde_json::Value,
}

#[cfg(desktop)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityOverlayInteractionResultPayload {
    pub request_id: String,
    pub ok: bool,
    #[serde(default)]
    pub error_code: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

#[cfg(desktop)]
fn validate_overlay_command_caller(
    command_name: &str,
    caller_label: &str,
    allowed_labels: &[&str],
) -> Result<(), String> {
    if allowed_labels.iter().any(|label| *label == caller_label) {
        return Ok(());
    }
    Err(format!(
        "Command `{command_name}` is not allowed from window `{caller_label}`"
    ))
}

#[cfg(desktop)]
fn ensure_overlay_command_caller<R: Runtime>(
    command_name: &str,
    caller_window: &WebviewWindow<R>,
    allowed_labels: &[&str],
) -> Result<(), String> {
    validate_overlay_command_caller(command_name, caller_window.label(), allowed_labels)
}

#[cfg(desktop)]
fn activity_overlay_allows_drag(state: &ActivityOverlayRuntimeState) -> bool {
    state
        .last_sync_payload
        .as_ref()
        .map(|payload| {
            payload.policy.enable_drag_reposition
                && !payload.policy.lock_position
                && matches!(
                    payload.policy.placement_mode,
                    DesktopActivityOverlayPlacementMode::Custom
                )
        })
        .unwrap_or(false)
}

#[cfg(desktop)]
fn cap_activity_overlay_velocity(vx: f64, vy: f64) -> (f64, f64) {
    let magnitude = vx.hypot(vy);
    if magnitude <= PET_VELOCITY_MAX_MAGNITUDE_PX_PER_S || magnitude <= 0.0 {
        return (vx, vy);
    }
    let scale = PET_VELOCITY_MAX_MAGNITUDE_PX_PER_S / magnitude;
    (vx * scale, vy * scale)
}

#[cfg(desktop)]
fn resolve_activity_overlay_momentum_deltas(vx: f64, vy: f64) -> Vec<(f64, f64)> {
    let (mut vx, mut vy) = cap_activity_overlay_velocity(vx, vy);
    let mut elapsed_ms = 0;
    let mut deltas = Vec::new();
    while elapsed_ms < PET_MOMENTUM_MAX_DURATION_MS
        && vx.hypot(vy) >= PET_MOMENTUM_STOP_SPEED_PX_PER_S
    {
        let seconds = PET_MOMENTUM_TICK_MS as f64 / 1_000.0;
        deltas.push((vx * seconds, vy * seconds));
        vx *= PET_MOMENTUM_FRICTION;
        vy *= PET_MOMENTUM_FRICTION;
        elapsed_ms += PET_MOMENTUM_TICK_MS;
    }
    deltas
}

#[cfg(desktop)]
pub fn register<R: Runtime + 'static>(app: &mut App<R>) -> tauri::Result<()> {
    let state = app.state::<ActivityOverlayState>();
    if let Ok(mut guard) = state.0.lock() {
        if !guard.drag_offsets_loaded {
            guard.drag_offsets = sanitize_drag_offsets(
                read_persisted_drag_offsets(resolve_drag_offsets_path(app).ok().as_deref())
                    .unwrap_or_default(),
            );
            guard.drag_offsets_loaded = true;
        }
    }
    start_native_notch_mouse_poll_loop(app.handle().clone(), state.inner().clone());
    #[cfg(target_os = "macos")]
    start_native_display_change_listener(app.handle().clone(), state.inner().clone());
    Ok(())
}

#[cfg(target_os = "macos")]
fn start_native_display_change_listener<R: Runtime + 'static>(
    app: AppHandle<R>,
    state: ActivityOverlayState,
) {
    let (tx, rx) = mpsc::channel();
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

#[cfg(target_os = "macos")]
fn run_native_display_change_listener<R: Runtime + 'static>(
    app: AppHandle<R>,
    state: ActivityOverlayState,
    rx: mpsc::Receiver<()>,
) {
    while rx.recv().is_ok() {
        let _ = record_native_display_change(&app, &state);
        loop {
            match rx.recv_timeout(Duration::from_millis(
                NATIVE_DISPLAY_CHANGE_POLL_INTERVAL_MS,
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

#[cfg(target_os = "macos")]
fn record_native_display_change<R: Runtime>(
    app: &AppHandle<R>,
    state: &ActivityOverlayState,
) -> Result<(), String> {
    let should_collapse_expanded = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        let was_expanded = guard
            .last_sync_payload
            .as_ref()
            .map(|payload| payload.expanded)
            .unwrap_or(false);
        guard
            .display_change_debounce
            .record_display_change(current_epoch_millis(), was_expanded);
        guard.last_display_context = None;
        guard.runtime_host_fallback = None;
        guard.drag_offsets_loaded = false;
        guard.drag_offsets_storage_key = None;
        if was_expanded {
            apply_expanded_override_to_runtime_state(&mut guard, false);
        }
        was_expanded
    };

    if should_collapse_expanded {
        apply_overlay_state(app, state)?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn resolve_native_display_change_action(
    state: &ActivityOverlayState,
) -> Result<Option<DesktopActivityOverlayDisplayChangeAction>, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
    Ok(guard
        .display_change_debounce
        .resolve_ready_action(current_epoch_millis(), NATIVE_DISPLAY_CHANGE_DEBOUNCE_MS))
}

#[cfg(target_os = "macos")]
fn apply_native_display_change_action<R: Runtime>(
    app: &AppHandle<R>,
    state: &ActivityOverlayState,
    action: DesktopActivityOverlayDisplayChangeAction,
) -> Result<(), String> {
    if action.reopen_expanded {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        apply_expanded_override_to_runtime_state(&mut guard, true);
    }

    apply_overlay_state(app, state)?;

    if action.reopen_expanded {
        app.emit_to(
            MAIN_WINDOW_LABEL,
            OVERLAY_INTERACTION_EVENT,
            DesktopActivityOverlayInteractionPayload {
                request_id: None,
                action_identifier: "overlay-set-expanded".to_string(),
                data: build_display_changed_set_expanded_interaction_data(true, action.open_reason),
            },
        )
        .map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy, Debug, PartialEq)]
struct NativeNotchMouseObservation {
    point: DesktopActivityOverlayNativeMousePoint,
    left_mouse_pressed: bool,
}

#[cfg(target_os = "macos")]
type NativeNotchMouseMainThreadTask = Box<dyn FnOnce() + Send + 'static>;

#[cfg(target_os = "macos")]
fn schedule_native_notch_mouse_task_if_idle(
    pending: &Arc<AtomicBool>,
    dispatch: impl FnOnce(NativeNotchMouseMainThreadTask) -> Result<(), String>,
    task: impl FnOnce() + Send + 'static,
) -> Result<bool, String> {
    if pending.swap(true, Ordering::AcqRel) {
        return Ok(false);
    }

    let pending_for_task = pending.clone();
    let wrapped_task: NativeNotchMouseMainThreadTask = Box::new(move || {
        task();
        pending_for_task.store(false, Ordering::Release);
    });

    match dispatch(wrapped_task) {
        Ok(()) => Ok(true),
        Err(error) => {
            pending.store(false, Ordering::Release);
            Err(error)
        }
    }
}

#[cfg(target_os = "macos")]
fn start_native_notch_mouse_poll_loop<R: Runtime + 'static>(
    app: AppHandle<R>,
    state: ActivityOverlayState,
) {
    let pending = Arc::new(AtomicBool::new(false));
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(NATIVE_NOTCH_MOUSE_POLL_INTERVAL_MS));
        let dispatch_app = app.clone();
        let task_app = app.clone();
        let task_state = state.clone();
        let result = schedule_native_notch_mouse_task_if_idle(
            &pending,
            move |task| {
                dispatch_app
                    .run_on_main_thread(task)
                    .map_err(|error| error.to_string())
            },
            move || {
                let observation = read_native_notch_mouse_observation_on_main_thread();
                let _ = handle_native_notch_mouse_observation(&task_app, &task_state, observation);
            },
        );
        if result.is_err() {
            break;
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn start_native_notch_mouse_poll_loop<R: Runtime>(
    _app: AppHandle<R>,
    _state: ActivityOverlayState,
) {
}

#[cfg(target_os = "macos")]
fn read_native_notch_mouse_observation_on_main_thread() -> NativeNotchMouseObservation {
    let _main_thread = objc2::MainThreadMarker::new()
        .expect("expected native notch mouse observation to run on the main thread");
    let location = unsafe { NSEvent::mouseLocation() };
    let pressed_buttons = unsafe { NSEvent::pressedMouseButtons() };

    NativeNotchMouseObservation {
        point: DesktopActivityOverlayNativeMousePoint {
            x: location.x,
            y: location.y,
        },
        left_mouse_pressed: pressed_buttons & 1 == 1,
    }
}

#[cfg(target_os = "macos")]
fn handle_native_notch_mouse_observation<R: Runtime>(
    app: &AppHandle<R>,
    state: &ActivityOverlayState,
    observation: NativeNotchMouseObservation,
) -> Result<(), String> {
    let now_ms = current_epoch_millis();
    let (effect, display_context) = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        let Some(window_state) = guard.last_window_state.clone() else {
            guard.native_mouse_state = DesktopActivityOverlayNativeMouseState::default();
            return Ok(());
        };
        let Some(diagnostics) = window_state.placement_diagnostics.clone() else {
            guard.native_mouse_state = DesktopActivityOverlayNativeMouseState::default();
            return Ok(());
        };
        let Some(display_context) = diagnostics.display_context else {
            guard.native_mouse_state = DesktopActivityOverlayNativeMouseState::default();
            return Ok(());
        };
        if !window_state.visible
            || !matches!(
                diagnostics.host_mode,
                DesktopActivityOverlayHostMode::NotchIntegrated
            )
        {
            guard.native_mouse_state = DesktopActivityOverlayNativeMouseState::default();
            return Ok(());
        }

        let effect = if window_state.expanded {
            let expanded_rect = resolve_notch_integrated_panel_rect(
                diagnostics.computed_position,
                window_state.window.expanded,
                display_context.clone(),
                diagnostics.applied_native_frame,
            );
            let expanded_effect = advance_expanded_notch_native_mouse_state(
                &mut guard.native_mouse_state,
                expanded_rect,
                observation.point,
                observation.left_mouse_pressed,
            );
            maybe_suppress_native_mouse_effect_for_input_lock(
                expanded_effect,
                is_overlay_input_lock_active(&guard, now_ms),
            )
        } else {
            let hit_rect = resolve_notch_integrated_hit_rect(
                diagnostics.computed_position,
                window_state.window.collapsed,
                display_context.clone(),
                diagnostics.applied_native_frame,
            );
            advance_notch_native_mouse_state(
                &mut guard.native_mouse_state,
                hit_rect,
                observation.point,
                observation.left_mouse_pressed,
                now_ms,
                NATIVE_NOTCH_HOVER_EXPAND_DELAY_MS,
            )
        };
        (effect, display_context)
    };

    match effect {
        DesktopActivityOverlayNativeMouseEffect::None => Ok(()),
        DesktopActivityOverlayNativeMouseEffect::ExpandFromClick
        | DesktopActivityOverlayNativeMouseEffect::ExpandFromHover => {
            set_overlay_expanded_from_native(app, state, true, effect)
        }
        DesktopActivityOverlayNativeMouseEffect::CollapseFromOutsideClick => {
            set_overlay_expanded_from_native(app, state, false, effect)?;
            repost_macos_left_click_after_collapse(observation.point, display_context);
            Ok(())
        }
    }
}

#[cfg(target_os = "macos")]
fn set_overlay_expanded_from_native<R: Runtime>(
    app: &AppHandle<R>,
    state: &ActivityOverlayState,
    expanded: bool,
    effect: DesktopActivityOverlayNativeMouseEffect,
) -> Result<(), String> {
    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        if let Some(payload) = guard.last_sync_payload.as_mut() {
            if payload.expanded == expanded {
                return Ok(());
            }
        }
        apply_expanded_override_to_runtime_state(&mut guard, expanded);
        guard.native_mouse_state = DesktopActivityOverlayNativeMouseState::default();
    }

    apply_overlay_state(app, state)?;
    app.emit_to(
        MAIN_WINDOW_LABEL,
        OVERLAY_INTERACTION_EVENT,
        DesktopActivityOverlayInteractionPayload {
            request_id: None,
            action_identifier: "overlay-set-expanded".to_string(),
            data: build_native_set_expanded_interaction_data(expanded, effect),
        },
    )
    .map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
fn build_native_set_expanded_interaction_data(
    expanded: bool,
    effect: DesktopActivityOverlayNativeMouseEffect,
) -> serde_json::Value {
    serde_json::json!({
        "expanded": expanded,
        "reason": native_mouse_effect_reason(effect),
        "openReason": native_mouse_effect_open_reason(effect),
    })
}

#[cfg(target_os = "macos")]
fn native_mouse_effect_reason(effect: DesktopActivityOverlayNativeMouseEffect) -> &'static str {
    match effect {
        DesktopActivityOverlayNativeMouseEffect::None => "none",
        DesktopActivityOverlayNativeMouseEffect::ExpandFromClick => "click",
        DesktopActivityOverlayNativeMouseEffect::ExpandFromHover => "hover",
        DesktopActivityOverlayNativeMouseEffect::CollapseFromOutsideClick => "outside_click",
    }
}

#[cfg(target_os = "macos")]
fn native_mouse_effect_open_reason(
    effect: DesktopActivityOverlayNativeMouseEffect,
) -> DesktopActivityOverlayOpenReason {
    match effect {
        DesktopActivityOverlayNativeMouseEffect::ExpandFromClick => {
            DesktopActivityOverlayOpenReason::Click
        }
        DesktopActivityOverlayNativeMouseEffect::ExpandFromHover => {
            DesktopActivityOverlayOpenReason::Hover
        }
        DesktopActivityOverlayNativeMouseEffect::None
        | DesktopActivityOverlayNativeMouseEffect::CollapseFromOutsideClick => {
            DesktopActivityOverlayOpenReason::Unknown
        }
    }
}

#[cfg(target_os = "macos")]
fn build_display_changed_set_expanded_interaction_data(
    expanded: bool,
    open_reason: DesktopActivityOverlayOpenReason,
) -> serde_json::Value {
    serde_json::json!({
        "expanded": expanded,
        "reason": open_reason,
        "openReason": open_reason,
    })
}

#[cfg(desktop)]
fn current_epoch_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .unwrap_or(0)
}

#[cfg(desktop)]
fn apply_input_lock_to_runtime_state(
    state: &mut ActivityOverlayRuntimeState,
    locked: bool,
    now_ms: u64,
) {
    state.input_locked = locked;
    state.input_lock_updated_at_epoch_ms = locked.then_some(now_ms);
}

#[cfg(desktop)]
fn is_overlay_input_lock_active(state: &ActivityOverlayRuntimeState, now_ms: u64) -> bool {
    state
        .input_lock_updated_at_epoch_ms
        .map(|updated_at_ms| {
            state.input_locked
                && now_ms.saturating_sub(updated_at_ms) <= OVERLAY_INPUT_LOCK_HEARTBEAT_TIMEOUT_MS
        })
        .unwrap_or(false)
}

#[cfg(target_os = "macos")]
fn maybe_suppress_native_mouse_effect_for_input_lock(
    effect: DesktopActivityOverlayNativeMouseEffect,
    input_lock_active: bool,
) -> DesktopActivityOverlayNativeMouseEffect {
    if input_lock_active
        && matches!(
            effect,
            DesktopActivityOverlayNativeMouseEffect::CollapseFromOutsideClick
        )
    {
        return DesktopActivityOverlayNativeMouseEffect::None;
    }

    effect
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_activity_overlay_sync<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ActivityOverlayState>,
    payload: DesktopActivityOverlaySyncPayload,
    caller_window: WebviewWindow<R>,
) -> Result<(), String> {
    ensure_overlay_command_caller(
        "desktop_activity_overlay_sync",
        &caller_window,
        &[MAIN_WINDOW_LABEL],
    )?;

    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        ensure_drag_offsets_loaded(&app, &mut guard);
        let mut next_payload =
            apply_qa_sync_pin_override(&mut guard, payload, current_epoch_millis());
        apply_desired_expanded_override(&mut guard, &mut next_payload);
        guard.last_sync_payload = Some(next_payload.clone());
    }

    apply_overlay_state(&app, state.inner())
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_activity_overlay_get_window_state<R: Runtime>(
    caller_window: WebviewWindow<R>,
    state: State<'_, ActivityOverlayState>,
) -> Result<Option<DesktopActivityOverlayWindowStatePayload>, String> {
    ensure_overlay_command_caller(
        "desktop_activity_overlay_get_window_state",
        &caller_window,
        &[MAIN_WINDOW_LABEL, OVERLAY_WINDOW_LABEL],
    )?;

    let guard = state
        .0
        .lock()
        .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
    Ok(guard.last_window_state.clone())
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_activity_overlay_set_expanded<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ActivityOverlayState>,
    expanded: bool,
    caller_window: WebviewWindow<R>,
) -> Result<(), String> {
    ensure_overlay_command_caller(
        "desktop_activity_overlay_set_expanded",
        &caller_window,
        &[MAIN_WINDOW_LABEL, OVERLAY_WINDOW_LABEL],
    )?;

    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        apply_expanded_override_to_runtime_state(&mut guard, expanded);
    }
    apply_overlay_state(&app, state.inner())
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_activity_overlay_set_input_locked<R: Runtime>(
    state: State<'_, ActivityOverlayState>,
    locked: bool,
    caller_window: WebviewWindow<R>,
) -> Result<(), String> {
    ensure_overlay_command_caller(
        "desktop_activity_overlay_set_input_locked",
        &caller_window,
        &[MAIN_WINDOW_LABEL, OVERLAY_WINDOW_LABEL],
    )?;

    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
    apply_input_lock_to_runtime_state(&mut guard, locked, current_epoch_millis());
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_activity_overlay_apply_drag_delta<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ActivityOverlayState>,
    delta_x: f64,
    delta_y: f64,
    caller_window: WebviewWindow<R>,
) -> Result<(), String> {
    ensure_overlay_command_caller(
        "desktop_activity_overlay_apply_drag_delta",
        &caller_window,
        &[OVERLAY_WINDOW_LABEL],
    )?;
    if !delta_x.is_finite() || !delta_y.is_finite() {
        return Err("Desktop activity overlay drag delta must be finite".to_string());
    }

    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        ensure_drag_offsets_loaded(&app, &mut guard);
        if !activity_overlay_allows_drag(&guard) {
            return Ok(());
        }

        guard.drag_offsets.offset_x = clamp(guard.drag_offsets.offset_x + delta_x, -4096.0, 4096.0);
        guard.drag_offsets.offset_y = clamp(guard.drag_offsets.offset_y + delta_y, -4096.0, 4096.0);
        let display_identity = guard
            .last_display_context
            .as_ref()
            .and_then(|context| context.display_identity.as_ref());
        persist_drag_offsets_for_display(&app, display_identity, guard.drag_offsets);
    }

    apply_overlay_state(&app, state.inner())
}

#[cfg(desktop)]
fn apply_activity_overlay_momentum_delta<R: Runtime>(
    app: &AppHandle<R>,
    state: &ActivityOverlayState,
    generation: u64,
    delta_x: f64,
    delta_y: f64,
) -> Result<bool, String> {
    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        if guard.momentum_generation != generation || !activity_overlay_allows_drag(&guard) {
            return Ok(false);
        }
        ensure_drag_offsets_loaded(app, &mut guard);
        guard.drag_offsets.offset_x = clamp(guard.drag_offsets.offset_x + delta_x, -4096.0, 4096.0);
        guard.drag_offsets.offset_y = clamp(guard.drag_offsets.offset_y + delta_y, -4096.0, 4096.0);
        let display_identity = guard
            .last_display_context
            .as_ref()
            .and_then(|context| context.display_identity.as_ref());
        persist_drag_offsets_for_display(app, display_identity, guard.drag_offsets);
    }

    apply_overlay_state(app, state)?;
    Ok(true)
}

#[cfg(desktop)]
fn resolve_activity_overlay_momentum_plan(
    generation: u64,
    velocity: (f64, f64),
) -> DesktopActivityOverlayMomentumPlanPayload {
    DesktopActivityOverlayMomentumPlanPayload {
        generation,
        tick_ms: PET_MOMENTUM_TICK_MS,
        deltas: resolve_activity_overlay_momentum_deltas(velocity.0, velocity.1)
            .into_iter()
            .map(|(delta_x, delta_y)| DesktopActivityOverlayScheduledMomentumDeltaPayload {
                delta_x,
                delta_y,
                delay_ms: PET_MOMENTUM_TICK_MS,
            })
            .collect(),
    }
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_activity_overlay_apply_momentum_delta<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ActivityOverlayState>,
    payload: DesktopActivityOverlayMomentumDeltaPayload,
    caller_window: WebviewWindow<R>,
) -> Result<(), String> {
    ensure_overlay_command_caller(
        "desktop_activity_overlay_apply_momentum_delta",
        &caller_window,
        &[OVERLAY_WINDOW_LABEL],
    )?;
    if !payload.delta_x.is_finite() || !payload.delta_y.is_finite() {
        return Err("Desktop activity overlay momentum delta must be finite".to_string());
    }

    apply_activity_overlay_momentum_delta(
        &app,
        state.inner(),
        payload.generation,
        payload.delta_x,
        payload.delta_y,
    )?;
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_activity_overlay_release_drag_velocity<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ActivityOverlayState>,
    payload: DesktopActivityOverlayDragVelocityPayload,
    caller_window: WebviewWindow<R>,
) -> Result<DesktopActivityOverlayMomentumPlanPayload, String> {
    ensure_overlay_command_caller(
        "desktop_activity_overlay_release_drag_velocity",
        &caller_window,
        &[OVERLAY_WINDOW_LABEL],
    )?;
    if payload.pointer_id.trim().is_empty() {
        return Err("Desktop activity overlay pointer id is required".to_string());
    }
    if !payload.vx.is_finite() || !payload.vy.is_finite() {
        return Err("Desktop activity overlay drag velocity must be finite".to_string());
    }
    if !payload.sample_window_ms.is_finite() || payload.sample_window_ms <= 0.0 {
        return Err("Desktop activity overlay velocity sample window must be positive".to_string());
    }

    let (generation, velocity) = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        ensure_drag_offsets_loaded(&app, &mut guard);
        if !activity_overlay_allows_drag(&guard) {
            return Ok(DesktopActivityOverlayMomentumPlanPayload {
                generation: guard.momentum_generation,
                tick_ms: PET_MOMENTUM_TICK_MS,
                deltas: Vec::new(),
            });
        }
        guard.momentum_generation = guard.momentum_generation.wrapping_add(1);
        (
            guard.momentum_generation,
            cap_activity_overlay_velocity(payload.vx, payload.vy),
        )
    };

    Ok(resolve_activity_overlay_momentum_plan(generation, velocity))
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_activity_overlay_reset_position<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, ActivityOverlayState>,
    caller_window: WebviewWindow<R>,
) -> Result<(), String> {
    ensure_overlay_command_caller(
        "desktop_activity_overlay_reset_position",
        &caller_window,
        &[MAIN_WINDOW_LABEL],
    )?;

    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        guard.drag_offsets = PersistedOverlayDragOffsets::default();
        guard.drag_offsets_loaded = true;
        guard.drag_offsets_storage_key = guard
            .last_display_context
            .as_ref()
            .and_then(|context| context.display_identity.as_ref())
            .map(|identity| identity.storage_key.clone());
    }
    let display_identity = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        guard
            .last_display_context
            .as_ref()
            .and_then(|context| context.display_identity.clone())
    };
    clear_persisted_drag_offsets_for_display(&app, display_identity.as_ref());

    apply_overlay_state(&app, state.inner())
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_activity_overlay_emit_interaction<R: Runtime>(
    app: AppHandle<R>,
    payload: DesktopActivityOverlayInteractionPayload,
    caller_window: WebviewWindow<R>,
) -> Result<(), String> {
    ensure_overlay_command_caller(
        "desktop_activity_overlay_emit_interaction",
        &caller_window,
        OVERLAY_INTERACTION_COMMAND_ALLOWED_LABELS,
    )?;

    app.emit_to(MAIN_WINDOW_LABEL, OVERLAY_INTERACTION_EVENT, payload)
        .map_err(|error| error.to_string())
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_activity_overlay_emit_interaction_result<R: Runtime>(
    app: AppHandle<R>,
    payload: DesktopActivityOverlayInteractionResultPayload,
    caller_window: WebviewWindow<R>,
) -> Result<(), String> {
    ensure_overlay_command_caller(
        "desktop_activity_overlay_emit_interaction_result",
        &caller_window,
        &[MAIN_WINDOW_LABEL],
    )?;

    app.emit_to(
        OVERLAY_WINDOW_LABEL,
        OVERLAY_INTERACTION_RESULT_EVENT,
        payload,
    )
    .map_err(|error| error.to_string())
}

#[cfg(desktop)]
fn apply_overlay_state<R: Runtime>(
    app: &AppHandle<R>,
    state: &ActivityOverlayState,
) -> Result<(), String> {
    let (payload, cached_display_context, runtime_host_fallback) = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        let payload = guard.last_sync_payload.clone();
        (
            payload,
            guard.last_display_context.clone(),
            guard.runtime_host_fallback.clone(),
        )
    };

    let Some(payload) = payload else {
        return Ok(());
    };

    let action = resolve_overlay_window_visibility_action(&payload);
    if action == OverlayWindowVisibilityAction::Hide {
        if let Some(window) = app.get_webview_window(OVERLAY_WINDOW_LABEL) {
            let _ = window.hide();
        }
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        guard.last_window_state = Some(
            DesktopActivityOverlayWindowStatePayload::from_sync_payload(&payload, None),
        );
        return Ok(());
    }

    let window = ensure_overlay_window(app, payload.policy.always_on_top)?;
    if action == OverlayWindowVisibilityAction::ParkOffscreen {
        park_overlay_window_offscreen(app, &window)?;
        let window_state =
            DesktopActivityOverlayWindowStatePayload::from_sync_payload(&payload, None);
        let _ = window.emit(OVERLAY_STATE_EVENT, window_state.clone());
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        guard.last_window_state = Some(window_state);
        return Ok(());
    }
    let monitor_resolution = resolve_anchor_monitor_resolution(
        app,
        &window,
        payload.policy.placement_mode,
        payload.policy.display_mode,
    )?;
    let monitor = monitor_resolution.rect;
    let display_context = resolve_effective_overlay_display_context(
        resolve_overlay_display_context_for_monitor(app, monitor),
        cached_display_context,
        monitor,
    );
    let drag_offsets = resolve_drag_offsets_for_display(app, state, display_context.as_ref())?;
    let (offset_x, offset_y) = resolve_effective_overlay_offsets(&payload.policy, drag_offsets);
    let mut host_mode_resolution = resolve_desktop_activity_overlay_host_mode_resolution(
        payload.policy.presentation_mode,
        payload.policy.placement_mode,
        payload.policy.anchor,
        display_context.clone(),
    );
    host_mode_resolution = resolve_host_mode_resolution_with_runtime_fallback(
        host_mode_resolution,
        runtime_host_fallback.as_ref(),
        display_context.as_ref(),
    );
    let mut host_mode = host_mode_resolution.effective_mode;
    let mut next_runtime_host_fallback = if matches!(
        host_mode_resolution.requested_mode,
        DesktopActivityOverlayHostMode::NotchIntegrated
    ) {
        runtime_host_fallback.filter(|fallback| {
            runtime_host_fallback_matches_display_context(fallback, display_context.as_ref())
        })
    } else {
        None
    };
    let mut native_host_path = match apply_overlay_host_window_settings(
        &window,
        host_mode,
        display_context.clone(),
        payload.expanded,
    ) {
        Ok(path) => path,
        Err(error) if matches!(host_mode, DesktopActivityOverlayHostMode::NotchIntegrated) => {
            let _ = error;
            host_mode_resolution = host_mode_resolution.with_runtime_fallback(
                DesktopActivityOverlayHostFallbackReason::PanelHostApplyFailed,
            );
            host_mode = host_mode_resolution.effective_mode;
            next_runtime_host_fallback = build_runtime_host_fallback(
                display_context.clone(),
                DesktopActivityOverlayHostFallbackReason::PanelHostApplyFailed,
            );
            apply_overlay_host_window_settings(
                &window,
                host_mode,
                display_context.clone(),
                payload.expanded,
            )?
        }
        Err(error) => return Err(error),
    };
    let dimensions = resolve_notch_integrated_window_dimensions(
        payload.window.clone(),
        payload.expanded,
        host_mode,
        display_context.clone(),
    );
    let effective_payload = build_overlay_payload_with_effective_dimensions(&payload, dimensions);
    let width = sanitize_dimension(dimensions.width, 340.0, 1.0, 4096.0);
    let height = sanitize_dimension(dimensions.height, 72.0, 1.0, 4096.0);

    let mut placement = resolve_overlay_placement_for_host_mode(
        monitor,
        Rect {
            x: 0.0,
            y: 0.0,
            width,
            height,
        },
        payload.policy.anchor,
        offset_x,
        offset_y,
        OVERLAY_SAFE_PADDING_PX,
        host_mode,
        display_context.clone(),
    );
    let mut applied_native_frame = None;

    if matches!(host_mode, DesktopActivityOverlayHostMode::NotchIntegrated) {
        match apply_macos_overlay_panel_position(
            &window,
            host_mode,
            display_context.clone(),
            placement,
            width,
            height,
        ) {
            Ok(frame) => {
                native_host_path = DesktopActivityOverlayNativeHostPath::Panel;
                applied_native_frame = Some(frame);
            }
            Err(_) => {
                host_mode_resolution = host_mode_resolution.with_runtime_fallback(
                    DesktopActivityOverlayHostFallbackReason::PanelPositionUnavailable,
                );
                host_mode = host_mode_resolution.effective_mode;
                next_runtime_host_fallback = build_runtime_host_fallback(
                    display_context.clone(),
                    DesktopActivityOverlayHostFallbackReason::PanelPositionUnavailable,
                );
                native_host_path = apply_overlay_host_window_settings(
                    &window,
                    host_mode,
                    display_context.clone(),
                    payload.expanded,
                )?;
                placement = resolve_overlay_placement_for_host_mode(
                    monitor,
                    Rect {
                        x: 0.0,
                        y: 0.0,
                        width,
                        height,
                    },
                    payload.policy.anchor,
                    offset_x,
                    offset_y,
                    OVERLAY_SAFE_PADDING_PX,
                    host_mode,
                    display_context.clone(),
                );
            }
        }
    }

    if should_apply_overlay_tauri_always_on_top(host_mode) {
        window
            .set_always_on_top(resolve_overlay_tauri_always_on_top(
                payload.policy.always_on_top,
                host_mode,
            ))
            .map_err(|error| error.to_string())?;
    }

    if applied_native_frame.is_none() {
        window
            .set_size(LogicalSize::new(width, height))
            .map_err(|error| error.to_string())?;
        window
            .set_position(LogicalPosition::new(placement.x, placement.y))
            .map_err(|error| error.to_string())?;
    }
    show_overlay_window_without_activation(&window)?;

    let window_state = DesktopActivityOverlayWindowStatePayload::from_sync_payload(
        &effective_payload,
        Some(build_overlay_placement_diagnostics(
            monitor_resolution,
            placement,
            payload.policy.anchor,
            payload.policy.placement_mode,
            host_mode_resolution.requested_mode,
            host_mode,
            host_mode_resolution.fallback_reason,
            display_context.clone(),
            offset_x,
            offset_y,
            native_host_path,
            applied_native_frame,
        )),
    );
    let _ = window.emit(OVERLAY_STATE_EVENT, window_state.clone());

    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
    if let Some(display_context) = display_context {
        guard.last_display_context = Some(display_context);
    }
    guard.runtime_host_fallback = next_runtime_host_fallback;
    guard.last_window_state = Some(window_state);
    Ok(())
}

#[cfg(desktop)]
fn apply_overlay_host_window_settings<R: Runtime>(
    window: &WebviewWindow<R>,
    host_mode: DesktopActivityOverlayHostMode,
    display_context: Option<DesktopActivityOverlayDisplayContext>,
    expanded: bool,
) -> Result<DesktopActivityOverlayNativeHostPath, String> {
    let Some(settings) =
        resolve_macos_overlay_window_host_settings(host_mode, display_context, expanded)
    else {
        return Ok(DesktopActivityOverlayNativeHostPath::Window);
    };

    window
        .set_visible_on_all_workspaces(settings.visible_on_all_workspaces)
        .map_err(|error| error.to_string())?;
    window
        .set_shadow(settings.shadow)
        .map_err(|error| error.to_string())?;
    apply_macos_overlay_panel_host(window, settings)?;
    if should_apply_raw_macos_overlay_window_collection_behavior(settings) {
        apply_macos_overlay_window_collection_behavior(window, settings)?;
        Ok(DesktopActivityOverlayNativeHostPath::Window)
    } else {
        Ok(DesktopActivityOverlayNativeHostPath::Panel)
    }
}

#[cfg(desktop)]
fn resolve_overlay_tauri_always_on_top(
    policy_always_on_top: bool,
    host_mode: DesktopActivityOverlayHostMode,
) -> bool {
    policy_always_on_top && !matches!(host_mode, DesktopActivityOverlayHostMode::NotchIntegrated)
}

#[cfg(desktop)]
fn should_apply_overlay_tauri_always_on_top(host_mode: DesktopActivityOverlayHostMode) -> bool {
    !matches!(host_mode, DesktopActivityOverlayHostMode::NotchIntegrated)
}

#[cfg(desktop)]
fn apply_desired_expanded_override(
    state: &mut ActivityOverlayRuntimeState,
    payload: &mut DesktopActivityOverlaySyncPayload,
) {
    let Some(desired) = state.desired_expanded else {
        return;
    };

    if payload.expanded == desired {
        state.desired_expanded = None;
        return;
    }

    payload.expanded = desired;
}

#[cfg(desktop)]
fn read_qa_sync_pin_until_epoch_ms(payload: &DesktopActivityOverlaySyncPayload) -> Option<u64> {
    payload
        .model
        .get(QA_PROOF_PIN_UNTIL_MODEL_KEY)
        .and_then(|value| value.as_u64())
}

#[cfg(desktop)]
fn apply_qa_sync_pin_override(
    state: &mut ActivityOverlayRuntimeState,
    payload: DesktopActivityOverlaySyncPayload,
    now_epoch_ms: u64,
) -> DesktopActivityOverlaySyncPayload {
    if let Some(pin_until_epoch_ms) = read_qa_sync_pin_until_epoch_ms(&payload) {
        if pin_until_epoch_ms > now_epoch_ms {
            state.qa_pinned_sync_payload = Some(ActivityOverlayQaPinnedSyncPayload {
                payload: payload.clone(),
                expires_at_epoch_ms: pin_until_epoch_ms,
            });
            state.desired_expanded = None;
            return payload;
        }
    }

    if let Some(pinned) = state.qa_pinned_sync_payload.clone() {
        if pinned.expires_at_epoch_ms > now_epoch_ms {
            state.desired_expanded = None;
            return pinned.payload;
        }
        state.qa_pinned_sync_payload = None;
    }

    payload
}

#[cfg(desktop)]
fn apply_expanded_override_to_runtime_state(
    state: &mut ActivityOverlayRuntimeState,
    expanded: bool,
) {
    if let Some(payload) = state.last_sync_payload.as_mut() {
        payload.expanded = expanded;
    }
    // Persist through the next main-window sync because the canonical React runtime may still
    // publish one stale expanded value before it processes the interaction event.
    state.desired_expanded = Some(expanded);
}

#[cfg(desktop)]
fn build_overlay_payload_with_effective_dimensions(
    payload: &DesktopActivityOverlaySyncPayload,
    dimensions: DesktopActivityOverlayDimensionsPayload,
) -> DesktopActivityOverlaySyncPayload {
    let mut next = payload.clone();
    if payload.expanded {
        next.window.expanded = dimensions;
        write_model_window_dimensions(&mut next.model, "expanded", dimensions);
    } else {
        next.window.collapsed = dimensions;
        write_model_window_dimensions(&mut next.model, "collapsed", dimensions);
    }
    next
}

#[cfg(desktop)]
fn write_model_window_dimensions(
    model: &mut serde_json::Value,
    key: &str,
    dimensions: DesktopActivityOverlayDimensionsPayload,
) {
    let Some(window) = model
        .get_mut("window")
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    let Some(target) = window
        .get_mut(key)
        .and_then(serde_json::Value::as_object_mut)
    else {
        return;
    };
    target.insert("width".to_string(), serde_json::json!(dimensions.width));
    target.insert("height".to_string(), serde_json::json!(dimensions.height));
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum OverlayWindowVisibilityAction {
    Hide,
    ParkOffscreen,
    Show,
}

#[cfg(desktop)]
fn resolve_overlay_window_visibility_action(
    payload: &DesktopActivityOverlaySyncPayload,
) -> OverlayWindowVisibilityAction {
    if !payload.policy.enabled {
        return OverlayWindowVisibilityAction::Hide;
    }
    if payload.visible {
        return OverlayWindowVisibilityAction::Show;
    }

    // Keep the webview alive (even when we don't want the overlay visible) so automation and state
    // transitions do not lose the overlay window's CDP target mid-run.
    OverlayWindowVisibilityAction::ParkOffscreen
}

#[cfg(desktop)]
fn ensure_drag_offsets_loaded<R: Runtime>(
    app: &AppHandle<R>,
    state: &mut ActivityOverlayRuntimeState,
) {
    if state.drag_offsets_loaded {
        return;
    }
    state.drag_offsets = sanitize_drag_offsets(
        read_persisted_drag_offsets(resolve_drag_offsets_path(app).ok().as_deref())
            .unwrap_or_default(),
    );
    state.drag_offsets_loaded = true;
    state.drag_offsets_storage_key = None;
}

#[cfg(desktop)]
fn resolve_drag_offsets_for_display<R: Runtime>(
    app: &AppHandle<R>,
    state: &ActivityOverlayState,
    display_context: Option<&DesktopActivityOverlayDisplayContext>,
) -> Result<PersistedOverlayDragOffsets, String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
    ensure_drag_offsets_loaded_for_display(app, &mut guard, display_context);
    Ok(guard.drag_offsets)
}

#[cfg(desktop)]
fn ensure_drag_offsets_loaded_for_display<R: Runtime>(
    app: &AppHandle<R>,
    state: &mut ActivityOverlayRuntimeState,
    display_context: Option<&DesktopActivityOverlayDisplayContext>,
) {
    let display_identity = display_context.and_then(|context| context.display_identity.as_ref());
    let next_storage_key = display_identity.map(|identity| identity.storage_key.clone());
    if state.drag_offsets_loaded && state.drag_offsets_storage_key == next_storage_key {
        return;
    }

    let offsets =
        if let Ok(display_path) = resolve_drag_offsets_path_for_display(app, display_identity) {
            let mut legacy_path_bufs: Vec<std::path::PathBuf> =
                resolve_drag_offsets_legacy_storage_keys_for_display(display_identity)
                    .into_iter()
                    .filter_map(|storage_key| {
                        resolve_drag_offsets_path_for_storage_key(app, &storage_key).ok()
                    })
                    .filter(|path| path != &display_path)
                    .collect();
            if let Ok(legacy_path) = resolve_drag_offsets_path(app) {
                if legacy_path != display_path {
                    legacy_path_bufs.push(legacy_path);
                }
            }
            let legacy_paths: Vec<&std::path::Path> = legacy_path_bufs
                .iter()
                .map(std::path::PathBuf::as_path)
                .collect();
            migrate_persisted_drag_offsets_for_display_paths(&display_path, &legacy_paths)
                .offsets
                .unwrap_or_default()
        } else {
            read_persisted_drag_offsets(resolve_drag_offsets_path(app).ok().as_deref())
                .unwrap_or_default()
        };

    state.drag_offsets = sanitize_drag_offsets(offsets);
    state.drag_offsets_loaded = true;
    state.drag_offsets_storage_key = next_storage_key;
}

#[cfg(desktop)]
fn resolve_effective_overlay_offsets(
    policy: &DesktopActivityOverlayPolicyPayload,
    drag_offsets: PersistedOverlayDragOffsets,
) -> (f64, f64) {
    if matches!(
        policy.placement_mode,
        DesktopActivityOverlayPlacementMode::Anchored
    ) {
        return (0.0, 0.0);
    }

    let persisted_custom_offset = sanitize_drag_offsets(drag_offsets);
    (
        sanitize_offset(policy.offset_x) + persisted_custom_offset.offset_x,
        sanitize_offset(policy.offset_y) + persisted_custom_offset.offset_y,
    )
}

#[cfg(desktop)]
fn resolve_effective_overlay_display_context(
    resolved_display_context: Option<DesktopActivityOverlayDisplayContext>,
    cached_display_context: Option<DesktopActivityOverlayDisplayContext>,
    monitor: Rect,
) -> Option<DesktopActivityOverlayDisplayContext> {
    if let Some(display_context) = resolved_display_context {
        return Some(display_context);
    }

    cached_display_context.filter(|display_context| {
        rect_matches_for_runtime_display_context(display_context.screen_frame, monitor)
    })
}

#[cfg(desktop)]
fn rect_matches_for_runtime_display_context(left: Rect, right: Rect) -> bool {
    (left.x - right.x).abs() <= 1.0
        && (left.y - right.y).abs() <= 1.0
        && (left.width - right.width).abs() <= 1.0
        && (left.height - right.height).abs() <= 1.0
}

#[cfg(desktop)]
fn resolve_host_mode_resolution_with_runtime_fallback(
    resolution: self::host_mode::DesktopActivityOverlayHostModeResolution,
    runtime_fallback: Option<&ActivityOverlayRuntimeHostFallback>,
    display_context: Option<&DesktopActivityOverlayDisplayContext>,
) -> self::host_mode::DesktopActivityOverlayHostModeResolution {
    if !matches!(
        resolution.effective_mode,
        DesktopActivityOverlayHostMode::NotchIntegrated
    ) {
        return resolution;
    }

    let Some(runtime_fallback) = runtime_fallback else {
        return resolution;
    };

    if !runtime_host_fallback_matches_display_context(runtime_fallback, display_context) {
        return resolution;
    }

    resolution.with_runtime_fallback(runtime_fallback.reason)
}

#[cfg(desktop)]
fn runtime_host_fallback_matches_display_context(
    runtime_fallback: &ActivityOverlayRuntimeHostFallback,
    display_context: Option<&DesktopActivityOverlayDisplayContext>,
) -> bool {
    let Some(display_context) = display_context else {
        return false;
    };

    rect_matches_for_runtime_display_context(
        runtime_fallback.display_context.screen_frame,
        display_context.screen_frame,
    ) && runtime_fallback.display_context.is_macos == display_context.is_macos
        && runtime_fallback.display_context.is_builtin_display == display_context.is_builtin_display
        && runtime_fallback.display_context.has_physical_notch == display_context.has_physical_notch
}

#[cfg(desktop)]
fn build_runtime_host_fallback(
    display_context: Option<DesktopActivityOverlayDisplayContext>,
    reason: DesktopActivityOverlayHostFallbackReason,
) -> Option<ActivityOverlayRuntimeHostFallback> {
    display_context.map(|display_context| ActivityOverlayRuntimeHostFallback {
        display_context,
        reason,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity_overlay::monitor_resolution::{
        logical_rect_from_physical_bounds, resolve_monitor_logical_scale_factor,
    };
    use crate::activity_overlay::placement::{
        DesktopActivityOverlayMonitorSource, OverlayPlacementRect, ResolvedOverlayAnchorMonitorRect,
    };
    use crate::activity_overlay::window_lifecycle::build_overlay_window_navigation_url;
    use serde_json::{json, Value};
    use std::{env, fs, path::PathBuf};

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

    fn read_activity_overlay_source_file() -> String {
        let source_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("activity_overlay.rs");
        fs::read_to_string(&source_path).unwrap_or_else(|error| {
            panic!(
                "failed to read activity overlay source {}: {error}",
                source_path.display()
            )
        })
    }

    #[test]
    fn validates_overlay_command_caller_against_allowed_labels() {
        let command_name = "desktop_activity_overlay_sync";
        assert!(validate_overlay_command_caller(command_name, "main", &["main"]).is_ok());
        assert!(
            validate_overlay_command_caller(command_name, "activity_overlay", &["main"]).is_err()
        );
    }

    #[test]
    fn overlay_interaction_command_can_sync_from_overlay_or_main_window() {
        let command_name = "desktop_activity_overlay_emit_interaction";
        assert!(validate_overlay_command_caller(
            command_name,
            OVERLAY_WINDOW_LABEL,
            OVERLAY_INTERACTION_COMMAND_ALLOWED_LABELS,
        )
        .is_ok());
        assert!(validate_overlay_command_caller(
            command_name,
            MAIN_WINDOW_LABEL,
            OVERLAY_INTERACTION_COMMAND_ALLOWED_LABELS,
        )
        .is_ok());
    }

    #[test]
    fn overlay_interaction_result_command_can_only_sync_from_main_window() {
        let command_name = "desktop_activity_overlay_emit_interaction_result";
        assert!(validate_overlay_command_caller(
            command_name,
            MAIN_WINDOW_LABEL,
            &[MAIN_WINDOW_LABEL]
        )
        .is_ok());
        assert!(validate_overlay_command_caller(
            command_name,
            OVERLAY_WINDOW_LABEL,
            &[MAIN_WINDOW_LABEL],
        )
        .is_err());
    }

    #[test]
    fn release_drag_velocity_command_can_only_sync_from_overlay_window() {
        let command_name = "desktop_activity_overlay_release_drag_velocity";
        assert!(validate_overlay_command_caller(
            command_name,
            OVERLAY_WINDOW_LABEL,
            &[OVERLAY_WINDOW_LABEL]
        )
        .is_ok());
        assert!(validate_overlay_command_caller(
            command_name,
            MAIN_WINDOW_LABEL,
            &[OVERLAY_WINDOW_LABEL]
        )
        .is_err());
    }

    #[test]
    fn apply_momentum_delta_command_can_only_sync_from_overlay_window() {
        let command_name = "desktop_activity_overlay_apply_momentum_delta";
        assert!(validate_overlay_command_caller(
            command_name,
            OVERLAY_WINDOW_LABEL,
            &[OVERLAY_WINDOW_LABEL]
        )
        .is_ok());
        assert!(validate_overlay_command_caller(
            command_name,
            MAIN_WINDOW_LABEL,
            &[OVERLAY_WINDOW_LABEL]
        )
        .is_err());
    }

    #[test]
    fn activity_overlay_uses_a_dedicated_capability_instead_of_the_main_default_scope() {
        let default_capability = read_capability_file("default.json");
        assert_eq!(default_capability["windows"], json!(["main"]));

        let overlay_capability = read_capability_file("overlay.json");
        assert_eq!(overlay_capability["windows"], json!(["activity_overlay"]));

        let permissions = overlay_capability["permissions"]
            .as_array()
            .expect("overlay capability permissions should be an array");

        assert!(permissions.contains(&Value::String("core:default".to_string())));
        for required_permission in [
            "allow-desktop-show-main-window",
            "allow-desktop-activity-overlay-get-window-state",
            "allow-desktop-activity-overlay-set-expanded",
            "allow-desktop-activity-overlay-set-input-locked",
            "allow-desktop-activity-overlay-apply-drag-delta",
            "allow-desktop-activity-overlay-release-drag-velocity",
            "allow-desktop-activity-overlay-apply-momentum-delta",
            "allow-desktop-activity-overlay-emit-interaction",
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
            "allow-desktop-set-autostart-enabled",
            "allow-start-system-task",
            "allow-cancel-system-task",
            "allow-respond-system-task-prompt",
            "allow-desktop-read-stack-boot-credentials",
            "allow-desktop-activity-overlay-sync",
            "allow-desktop-activity-overlay-reset-position",
            "allow-desktop-activity-overlay-emit-interaction-result",
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
            "allow-desktop-get-autostart-enabled",
            "allow-desktop-set-autostart-enabled",
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
            "allow-desktop-activity-overlay-get-window-state",
            "allow-desktop-activity-overlay-set-expanded",
            "allow-desktop-activity-overlay-set-input-locked",
            "allow-desktop-activity-overlay-reset-position",
            "allow-desktop-activity-overlay-emit-interaction",
            "allow-desktop-activity-overlay-emit-interaction-result",
        ] {
            assert!(
                default_permissions.contains(&Value::String(required_permission.to_string())),
                "default capability should include {required_permission}",
            );
        }
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
            "allow-desktop-activity-overlay-set-expanded",
            "allow-desktop-activity-overlay-set-input-locked",
            "allow-desktop-activity-overlay-apply-drag-delta",
            "allow-desktop-activity-overlay-release-drag-velocity",
            "allow-desktop-activity-overlay-apply-momentum-delta",
            "allow-desktop-activity-overlay-reset-position",
            "allow-desktop-activity-overlay-emit-interaction",
            "allow-desktop-activity-overlay-emit-interaction-result",
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
        }
    }

    #[test]
    fn caps_activity_overlay_release_velocity_to_the_native_momentum_limit() {
        let (vx, vy) = cap_activity_overlay_velocity(3_200.0, 0.0);

        assert_eq!(vx, PET_VELOCITY_MAX_MAGNITUDE_PX_PER_S);
        assert_eq!(vy, 0.0);
    }

    #[test]
    fn resolves_bounded_activity_overlay_momentum_deltas_from_the_native_constants() {
        let deltas = resolve_activity_overlay_momentum_deltas(3_200.0, 0.0);
        let max_ticks = PET_MOMENTUM_MAX_DURATION_MS / PET_MOMENTUM_TICK_MS;

        assert!(!deltas.is_empty());
        assert!(deltas.len() as u64 <= max_ticks);
        assert_eq!(
            deltas[0].0,
            PET_VELOCITY_MAX_MAGNITUDE_PX_PER_S * (PET_MOMENTUM_TICK_MS as f64 / 1_000.0),
        );
        assert_eq!(deltas[0].1, 0.0);
        assert!(deltas
            .windows(2)
            .all(|window| { window[1].0 <= (window[0].0 * PET_MOMENTUM_FRICTION) + 0.000_001 }));
    }

    #[test]
    fn resolves_activity_overlay_momentum_plan_from_the_native_constants() {
        let plan = resolve_activity_overlay_momentum_plan(17, (3_200.0, 0.0));

        assert_eq!(plan.generation, 17);
        assert_eq!(plan.tick_ms, PET_MOMENTUM_TICK_MS);
        assert!(!plan.deltas.is_empty());
        assert!(plan
            .deltas
            .iter()
            .all(|delta| delta.delay_ms == PET_MOMENTUM_TICK_MS));
    }

    #[test]
    fn release_velocity_returns_momentum_plan_instead_of_applying_all_ticks_synchronously() {
        let source = read_activity_overlay_source_file();
        let production_source = source
            .split("#[cfg(test)]")
            .next()
            .expect("activity overlay source should contain production code before tests");

        assert!(
            production_source.contains("resolve_activity_overlay_momentum_plan(generation, velocity)"),
            "release velocity should return a scheduled momentum plan",
        );
        assert!(
            !production_source.contains("apply_activity_overlay_momentum(&app, state.inner(), generation, velocity)"),
            "release velocity must not apply every momentum tick before returning",
        );
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

    #[cfg(target_os = "macos")]
    #[test]
    fn native_set_expanded_payload_serializes_expanded_flag_with_reason() {
        let cases = [
            (
                true,
                DesktopActivityOverlayNativeMouseEffect::ExpandFromClick,
                "click",
            ),
            (
                true,
                DesktopActivityOverlayNativeMouseEffect::ExpandFromHover,
                "hover",
            ),
            (
                false,
                DesktopActivityOverlayNativeMouseEffect::CollapseFromOutsideClick,
                "outside_click",
            ),
        ];

        for (expanded, effect, expected_reason) in cases {
            let data = build_native_set_expanded_interaction_data(expanded, effect);

            assert_eq!(
                data.get("expanded").and_then(serde_json::Value::as_bool),
                Some(expanded),
            );
            assert_eq!(
                data.get("reason").and_then(serde_json::Value::as_str),
                Some(expected_reason),
            );
            assert_eq!(
                data.get("openReason").and_then(serde_json::Value::as_str),
                Some(match effect {
                    DesktopActivityOverlayNativeMouseEffect::ExpandFromClick => "click",
                    DesktopActivityOverlayNativeMouseEffect::ExpandFromHover => "hover",
                    DesktopActivityOverlayNativeMouseEffect::CollapseFromOutsideClick => "unknown",
                    DesktopActivityOverlayNativeMouseEffect::None => "unknown",
                }),
            );
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_display_changed_payload_serializes_open_reason() {
        let data = build_display_changed_set_expanded_interaction_data(
            true,
            DesktopActivityOverlayOpenReason::DisplayChanged,
        );

        assert_eq!(
            data.get("expanded").and_then(serde_json::Value::as_bool),
            Some(true),
        );
        assert_eq!(
            data.get("reason").and_then(serde_json::Value::as_str),
            Some("displayChanged"),
        );
        assert_eq!(
            data.get("openReason").and_then(serde_json::Value::as_str),
            Some("displayChanged"),
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn native_notch_mouse_poll_task_runs_only_after_main_thread_dispatch_executes() {
        use std::sync::atomic::{AtomicBool, Ordering};

        let pending = Arc::new(AtomicBool::new(false));
        let captured_task = Arc::new(Mutex::new(None));
        let task_ran = Arc::new(AtomicBool::new(false));

        let result = schedule_native_notch_mouse_task_if_idle(
            &pending,
            {
                let captured_task = captured_task.clone();
                move |task| {
                    *captured_task
                        .lock()
                        .expect("expected captured task mutex to lock") = Some(task);
                    Ok(())
                }
            },
            {
                let task_ran = task_ran.clone();
                move || {
                    task_ran.store(true, Ordering::SeqCst);
                }
            },
        );

        assert_eq!(result, Ok(true));
        assert!(pending.load(Ordering::SeqCst));
        assert!(!task_ran.load(Ordering::SeqCst));

        let task = captured_task
            .lock()
            .expect("expected captured task mutex to lock")
            .take()
            .expect("expected task to be scheduled");
        task();

        assert!(!pending.load(Ordering::SeqCst));
        assert!(task_ran.load(Ordering::SeqCst));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn active_input_lock_suppresses_native_outside_click_collapse_effect() {
        assert_eq!(
            maybe_suppress_native_mouse_effect_for_input_lock(
                DesktopActivityOverlayNativeMouseEffect::CollapseFromOutsideClick,
                true,
            ),
            DesktopActivityOverlayNativeMouseEffect::None,
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn active_input_lock_does_not_suppress_native_expand_effects() {
        assert_eq!(
            maybe_suppress_native_mouse_effect_for_input_lock(
                DesktopActivityOverlayNativeMouseEffect::ExpandFromClick,
                true,
            ),
            DesktopActivityOverlayNativeMouseEffect::ExpandFromClick,
        );
    }

    #[test]
    fn input_lock_expires_without_a_heartbeat() {
        let mut state = ActivityOverlayRuntimeState::default();

        apply_input_lock_to_runtime_state(&mut state, true, 1_000);

        assert!(is_overlay_input_lock_active(&state, 1_000 + 30_000));
        assert!(!is_overlay_input_lock_active(&state, 1_000 + 30_001));
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
    fn keeps_the_overlay_window_alive_when_enabled_even_if_the_surface_is_hidden() {
        let payload = DesktopActivityOverlaySyncPayload {
            visible: false,
            expanded: false,
            model: serde_json::json!({}),
            policy: DesktopActivityOverlayPolicyPayload {
                enabled: true,
                visibility_mode: DesktopActivityOverlayVisibilityMode::ActiveSessions,
                show_when_running: true,
                show_when_attention_required: true,
                show_when_ready: true,
                always_on_top: true,
                auto_hide_enabled: true,
                auto_hide_delay_ms: 6_000,
                expanded_behavior: DesktopActivityOverlayExpandedBehavior::Click,
                interactive_collapsed: true,
                presentation_mode: DesktopActivityOverlayPresentationMode::Automatic,
                click_action: DesktopActivityOverlayClickAction::ExpandOverlay,
                density: DesktopActivityOverlayDensity::Compact,
                compact_style: DesktopActivityOverlayCompactStyle::Pill,
                show_session_count: true,
                show_preview_text: false,
                placement_mode: DesktopActivityOverlayPlacementMode::Anchored,
                display_mode: DesktopActivityOverlayDisplayMode::Automatic,
                anchor: DesktopActivityOverlayAnchor::TopCenter,
                offset_x: 0.0,
                offset_y: 0.0,
                enable_drag_reposition: false,
                lock_position: true,
            },
            window: DesktopActivityOverlayWindowDimensionsPayload {
                collapsed: DesktopActivityOverlayDimensionsPayload {
                    width: 320.0,
                    height: 72.0,
                },
                expanded: DesktopActivityOverlayDimensionsPayload {
                    width: 420.0,
                    height: 240.0,
                },
            },
        };

        assert_eq!(
            resolve_overlay_window_visibility_action(&payload),
            OverlayWindowVisibilityAction::ParkOffscreen
        );
    }

    #[test]
    fn does_not_keep_the_overlay_window_alive_when_disabled() {
        let payload = DesktopActivityOverlaySyncPayload {
            visible: true,
            expanded: false,
            model: serde_json::json!({}),
            policy: DesktopActivityOverlayPolicyPayload {
                enabled: false,
                visibility_mode: DesktopActivityOverlayVisibilityMode::ActiveSessions,
                show_when_running: true,
                show_when_attention_required: true,
                show_when_ready: true,
                always_on_top: true,
                auto_hide_enabled: true,
                auto_hide_delay_ms: 6_000,
                expanded_behavior: DesktopActivityOverlayExpandedBehavior::Click,
                interactive_collapsed: true,
                presentation_mode: DesktopActivityOverlayPresentationMode::Automatic,
                click_action: DesktopActivityOverlayClickAction::ExpandOverlay,
                density: DesktopActivityOverlayDensity::Compact,
                compact_style: DesktopActivityOverlayCompactStyle::Pill,
                show_session_count: true,
                show_preview_text: false,
                placement_mode: DesktopActivityOverlayPlacementMode::Anchored,
                display_mode: DesktopActivityOverlayDisplayMode::Automatic,
                anchor: DesktopActivityOverlayAnchor::TopCenter,
                offset_x: 0.0,
                offset_y: 0.0,
                enable_drag_reposition: false,
                lock_position: true,
            },
            window: DesktopActivityOverlayWindowDimensionsPayload {
                collapsed: DesktopActivityOverlayDimensionsPayload {
                    width: 320.0,
                    height: 72.0,
                },
                expanded: DesktopActivityOverlayDimensionsPayload {
                    width: 420.0,
                    height: 240.0,
                },
            },
        };

        assert_eq!(
            resolve_overlay_window_visibility_action(&payload),
            OverlayWindowVisibilityAction::Hide
        );
    }

    #[test]
    fn shows_the_overlay_window_when_enabled_and_visible() {
        let payload = DesktopActivityOverlaySyncPayload {
            visible: true,
            expanded: false,
            model: serde_json::json!({}),
            policy: DesktopActivityOverlayPolicyPayload {
                enabled: true,
                visibility_mode: DesktopActivityOverlayVisibilityMode::ActiveSessions,
                show_when_running: true,
                show_when_attention_required: true,
                show_when_ready: true,
                always_on_top: true,
                auto_hide_enabled: true,
                auto_hide_delay_ms: 6_000,
                expanded_behavior: DesktopActivityOverlayExpandedBehavior::Click,
                interactive_collapsed: true,
                presentation_mode: DesktopActivityOverlayPresentationMode::Automatic,
                click_action: DesktopActivityOverlayClickAction::ExpandOverlay,
                density: DesktopActivityOverlayDensity::Compact,
                compact_style: DesktopActivityOverlayCompactStyle::Pill,
                show_session_count: true,
                show_preview_text: false,
                placement_mode: DesktopActivityOverlayPlacementMode::Anchored,
                display_mode: DesktopActivityOverlayDisplayMode::Automatic,
                anchor: DesktopActivityOverlayAnchor::TopCenter,
                offset_x: 0.0,
                offset_y: 0.0,
                enable_drag_reposition: false,
                lock_position: true,
            },
            window: DesktopActivityOverlayWindowDimensionsPayload {
                collapsed: DesktopActivityOverlayDimensionsPayload {
                    width: 320.0,
                    height: 72.0,
                },
                expanded: DesktopActivityOverlayDimensionsPayload {
                    width: 420.0,
                    height: 240.0,
                },
            },
        };

        assert_eq!(
            resolve_overlay_window_visibility_action(&payload),
            OverlayWindowVisibilityAction::Show
        );
    }

    #[test]
    fn notch_integrated_mode_disables_tauri_always_on_top_in_favor_of_native_level_override() {
        assert!(!resolve_overlay_tauri_always_on_top(
            true,
            DesktopActivityOverlayHostMode::NotchIntegrated,
        ));
        assert!(!resolve_overlay_tauri_always_on_top(
            false,
            DesktopActivityOverlayHostMode::NotchIntegrated,
        ));
        assert!(!should_apply_overlay_tauri_always_on_top(
            DesktopActivityOverlayHostMode::NotchIntegrated,
        ));
    }

    #[test]
    fn floating_mode_preserves_the_existing_tauri_always_on_top_policy() {
        assert!(resolve_overlay_tauri_always_on_top(
            true,
            DesktopActivityOverlayHostMode::Floating,
        ));
        assert!(!resolve_overlay_tauri_always_on_top(
            false,
            DesktopActivityOverlayHostMode::Floating,
        ));
        assert!(should_apply_overlay_tauri_always_on_top(
            DesktopActivityOverlayHostMode::Floating,
        ));
    }

    #[test]
    fn ignores_stale_offsets_when_overlay_uses_anchored_placement() {
        let policy = DesktopActivityOverlayPolicyPayload {
            enabled: true,
            visibility_mode: DesktopActivityOverlayVisibilityMode::AttentionOnly,
            show_when_running: true,
            show_when_attention_required: true,
            show_when_ready: true,
            always_on_top: true,
            auto_hide_enabled: true,
            auto_hide_delay_ms: 6_000,
            expanded_behavior: DesktopActivityOverlayExpandedBehavior::Click,
            interactive_collapsed: true,
            presentation_mode: DesktopActivityOverlayPresentationMode::Automatic,
            click_action: DesktopActivityOverlayClickAction::ExpandOverlay,
            density: DesktopActivityOverlayDensity::Compact,
            compact_style: DesktopActivityOverlayCompactStyle::Pill,
            show_session_count: true,
            show_preview_text: false,
            placement_mode: DesktopActivityOverlayPlacementMode::Anchored,
            display_mode: DesktopActivityOverlayDisplayMode::Automatic,
            anchor: DesktopActivityOverlayAnchor::TopCenter,
            offset_x: 240.0,
            offset_y: -160.0,
            enable_drag_reposition: true,
            lock_position: false,
        };

        let offsets = resolve_effective_overlay_offsets(
            &policy,
            PersistedOverlayDragOffsets {
                offset_x: 96.0,
                offset_y: -48.0,
            },
        );

        assert_eq!(offsets, (0.0, 0.0));
    }

    #[test]
    fn combines_policy_and_persisted_offsets_in_custom_mode() {
        let policy = DesktopActivityOverlayPolicyPayload {
            enabled: true,
            visibility_mode: DesktopActivityOverlayVisibilityMode::AttentionOnly,
            show_when_running: true,
            show_when_attention_required: true,
            show_when_ready: true,
            always_on_top: true,
            auto_hide_enabled: true,
            auto_hide_delay_ms: 6_000,
            expanded_behavior: DesktopActivityOverlayExpandedBehavior::Click,
            interactive_collapsed: true,
            presentation_mode: DesktopActivityOverlayPresentationMode::Automatic,
            click_action: DesktopActivityOverlayClickAction::ExpandOverlay,
            density: DesktopActivityOverlayDensity::Compact,
            compact_style: DesktopActivityOverlayCompactStyle::Pill,
            show_session_count: true,
            show_preview_text: false,
            placement_mode: DesktopActivityOverlayPlacementMode::Custom,
            display_mode: DesktopActivityOverlayDisplayMode::Automatic,
            anchor: DesktopActivityOverlayAnchor::TopCenter,
            offset_x: 24.0,
            offset_y: -16.0,
            enable_drag_reposition: true,
            lock_position: false,
        };

        let offsets = resolve_effective_overlay_offsets(
            &policy,
            PersistedOverlayDragOffsets {
                offset_x: 96.0,
                offset_y: -48.0,
            },
        );

        assert_eq!(offsets, (120.0, -64.0));
    }

    #[test]
    fn builds_overlay_placement_diagnostics_for_the_effective_monitor_and_position() {
        let diagnostics = build_overlay_placement_diagnostics(
            ResolvedOverlayAnchorMonitorRect {
                source: DesktopActivityOverlayMonitorSource::OverlayWindow,
                rect: Rect {
                    x: 3000.0,
                    y: 0.0,
                    width: 1280.0,
                    height: 800.0,
                },
            },
            OverlayPlacementRect { x: 3120.0, y: 24.0 },
            DesktopActivityOverlayAnchor::TopCenter,
            DesktopActivityOverlayPlacementMode::Custom,
            DesktopActivityOverlayHostMode::Floating,
            DesktopActivityOverlayHostMode::Floating,
            None,
            None,
            12.0,
            -8.0,
            DesktopActivityOverlayNativeHostPath::Window,
            None,
        );

        assert_eq!(
            diagnostics.monitor_source,
            DesktopActivityOverlayMonitorSource::OverlayWindow
        );
        assert!((diagnostics.effective_monitor.x - 3000.0).abs() < 0.001);
        assert_eq!(diagnostics.anchor, DesktopActivityOverlayAnchor::TopCenter);
        assert_eq!(
            diagnostics.placement_mode,
            DesktopActivityOverlayPlacementMode::Custom
        );
        assert_eq!(
            diagnostics.host_mode,
            DesktopActivityOverlayHostMode::Floating
        );
        assert_eq!(diagnostics.display_context, None);
        assert!((diagnostics.effective_offset_x - 12.0).abs() < 0.001);
        assert!((diagnostics.effective_offset_y + 8.0).abs() < 0.001);
        assert!((diagnostics.computed_position.x - 3120.0).abs() < 0.001);
        assert_eq!(diagnostics.applied_native_frame, None);
    }

    #[test]
    fn carries_overlay_placement_diagnostics_into_window_state() {
        let payload = DesktopActivityOverlaySyncPayload {
            visible: true,
            expanded: false,
            model: serde_json::json!({}),
            policy: DesktopActivityOverlayPolicyPayload {
                enabled: true,
                visibility_mode: DesktopActivityOverlayVisibilityMode::AttentionOnly,
                show_when_running: true,
                show_when_attention_required: true,
                show_when_ready: true,
                always_on_top: true,
                auto_hide_enabled: true,
                auto_hide_delay_ms: 6_000,
                expanded_behavior: DesktopActivityOverlayExpandedBehavior::Click,
                interactive_collapsed: true,
                presentation_mode: DesktopActivityOverlayPresentationMode::Automatic,
                click_action: DesktopActivityOverlayClickAction::ExpandOverlay,
                density: DesktopActivityOverlayDensity::Compact,
                compact_style: DesktopActivityOverlayCompactStyle::Pill,
                show_session_count: true,
                show_preview_text: false,
                placement_mode: DesktopActivityOverlayPlacementMode::Anchored,
                display_mode: DesktopActivityOverlayDisplayMode::Automatic,
                anchor: DesktopActivityOverlayAnchor::TopCenter,
                offset_x: 0.0,
                offset_y: 0.0,
                enable_drag_reposition: false,
                lock_position: true,
            },
            window: DesktopActivityOverlayWindowDimensionsPayload {
                collapsed: DesktopActivityOverlayDimensionsPayload {
                    width: 320.0,
                    height: 72.0,
                },
                expanded: DesktopActivityOverlayDimensionsPayload {
                    width: 420.0,
                    height: 240.0,
                },
            },
        };
        let diagnostics = build_overlay_placement_diagnostics(
            ResolvedOverlayAnchorMonitorRect {
                source: DesktopActivityOverlayMonitorSource::MainWindow,
                rect: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 1400.0,
                    height: 900.0,
                },
            },
            OverlayPlacementRect { x: 540.0, y: 12.0 },
            DesktopActivityOverlayAnchor::TopCenter,
            DesktopActivityOverlayPlacementMode::Anchored,
            DesktopActivityOverlayHostMode::Floating,
            DesktopActivityOverlayHostMode::Floating,
            None,
            None,
            0.0,
            0.0,
            DesktopActivityOverlayNativeHostPath::Window,
            None,
        );

        let window_state = DesktopActivityOverlayWindowStatePayload::from_sync_payload(
            &payload,
            Some(diagnostics.clone()),
        );

        assert_eq!(window_state.placement_diagnostics, Some(diagnostics));
    }

    #[test]
    fn carries_notch_host_mode_and_display_context_into_window_state() {
        let display_context = DesktopActivityOverlayDisplayContext {
            is_macos: true,
            is_builtin_display: true,
            has_physical_notch: true,
            safe_area_top: 74.0,
            physical_notch_size: None,
            display_identity: None,
            screen_frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 982.0,
            },
            visible_frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 908.0,
            },
        };
        let payload = DesktopActivityOverlaySyncPayload {
            visible: true,
            expanded: false,
            model: serde_json::json!({}),
            policy: DesktopActivityOverlayPolicyPayload {
                enabled: true,
                visibility_mode: DesktopActivityOverlayVisibilityMode::AttentionOnly,
                show_when_running: true,
                show_when_attention_required: true,
                show_when_ready: true,
                always_on_top: true,
                auto_hide_enabled: true,
                auto_hide_delay_ms: 6_000,
                expanded_behavior: DesktopActivityOverlayExpandedBehavior::Click,
                interactive_collapsed: true,
                presentation_mode: DesktopActivityOverlayPresentationMode::Automatic,
                click_action: DesktopActivityOverlayClickAction::ExpandOverlay,
                density: DesktopActivityOverlayDensity::Compact,
                compact_style: DesktopActivityOverlayCompactStyle::Pill,
                show_session_count: true,
                show_preview_text: false,
                placement_mode: DesktopActivityOverlayPlacementMode::Anchored,
                display_mode: DesktopActivityOverlayDisplayMode::Automatic,
                anchor: DesktopActivityOverlayAnchor::TopCenter,
                offset_x: 0.0,
                offset_y: 0.0,
                enable_drag_reposition: false,
                lock_position: true,
            },
            window: DesktopActivityOverlayWindowDimensionsPayload {
                collapsed: DesktopActivityOverlayDimensionsPayload {
                    width: 320.0,
                    height: 72.0,
                },
                expanded: DesktopActivityOverlayDimensionsPayload {
                    width: 420.0,
                    height: 240.0,
                },
            },
        };
        let diagnostics = build_overlay_placement_diagnostics(
            ResolvedOverlayAnchorMonitorRect {
                source: DesktopActivityOverlayMonitorSource::Primary,
                rect: display_context.screen_frame,
            },
            OverlayPlacementRect { x: 576.0, y: 0.0 },
            DesktopActivityOverlayAnchor::TopCenter,
            DesktopActivityOverlayPlacementMode::Anchored,
            DesktopActivityOverlayHostMode::NotchIntegrated,
            DesktopActivityOverlayHostMode::NotchIntegrated,
            None,
            Some(display_context.clone()),
            0.0,
            0.0,
            DesktopActivityOverlayNativeHostPath::Panel,
            Some(Rect {
                x: 576.0,
                y: 914.0,
                width: 320.0,
                height: 72.0,
            }),
        );

        let window_state = DesktopActivityOverlayWindowStatePayload::from_sync_payload(
            &payload,
            Some(diagnostics.clone()),
        );

        assert_eq!(window_state.placement_diagnostics, Some(diagnostics));
        let placement_diagnostics = window_state
            .placement_diagnostics
            .expect("expected notch diagnostics to be present");
        assert_eq!(
            placement_diagnostics.host_mode,
            DesktopActivityOverlayHostMode::NotchIntegrated
        );
        assert_eq!(placement_diagnostics.display_context, Some(display_context));
        assert_eq!(
            placement_diagnostics.applied_native_frame,
            Some(Rect {
                x: 576.0,
                y: 914.0,
                width: 320.0,
                height: 72.0,
            }),
        );
    }

    #[test]
    fn carries_requested_host_mode_fallback_reason_and_native_host_path_into_diagnostics() {
        let display_context = DesktopActivityOverlayDisplayContext {
            is_macos: true,
            is_builtin_display: true,
            has_physical_notch: true,
            safe_area_top: 74.0,
            physical_notch_size: None,
            display_identity: None,
            screen_frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 982.0,
            },
            visible_frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 908.0,
            },
        };
        let diagnostics = build_overlay_placement_diagnostics(
            ResolvedOverlayAnchorMonitorRect {
                source: DesktopActivityOverlayMonitorSource::Primary,
                rect: display_context.screen_frame,
            },
            OverlayPlacementRect { x: 576.0, y: 12.0 },
            DesktopActivityOverlayAnchor::TopCenter,
            DesktopActivityOverlayPlacementMode::Anchored,
            DesktopActivityOverlayHostMode::NotchIntegrated,
            DesktopActivityOverlayHostMode::Floating,
            Some(DesktopActivityOverlayHostFallbackReason::PanelPositionUnavailable),
            Some(display_context.clone()),
            0.0,
            0.0,
            DesktopActivityOverlayNativeHostPath::Window,
            None,
        );

        assert_eq!(
            diagnostics.requested_host_mode,
            DesktopActivityOverlayHostMode::NotchIntegrated
        );
        assert_eq!(
            diagnostics.host_mode,
            DesktopActivityOverlayHostMode::Floating
        );
        assert_eq!(
            diagnostics.host_fallback_reason,
            Some(DesktopActivityOverlayHostFallbackReason::PanelPositionUnavailable)
        );
        assert_eq!(
            diagnostics.native_host_path,
            DesktopActivityOverlayNativeHostPath::Window
        );
    }

    #[test]
    fn reuses_last_display_context_when_resolution_is_temporarily_unavailable() {
        let display_context = DesktopActivityOverlayDisplayContext {
            is_macos: true,
            is_builtin_display: true,
            has_physical_notch: true,
            safe_area_top: 74.0,
            physical_notch_size: None,
            display_identity: None,
            screen_frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 982.0,
            },
            visible_frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 908.0,
            },
        };

        assert_eq!(
            resolve_effective_overlay_display_context(
                None,
                Some(display_context.clone()),
                display_context.screen_frame,
            ),
            Some(display_context.clone()),
        );
    }

    #[test]
    fn drops_last_display_context_when_monitor_changes() {
        let display_context = DesktopActivityOverlayDisplayContext {
            is_macos: true,
            is_builtin_display: true,
            has_physical_notch: true,
            safe_area_top: 74.0,
            physical_notch_size: None,
            display_identity: None,
            screen_frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 982.0,
            },
            visible_frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 908.0,
            },
        };

        assert_eq!(
            resolve_effective_overlay_display_context(
                None,
                Some(display_context),
                Rect {
                    x: 1512.0,
                    y: 0.0,
                    width: 1728.0,
                    height: 1117.0,
                },
            ),
            None,
        );
    }

    #[test]
    fn keeps_runtime_panel_fallback_sticky_for_the_same_display_context() {
        let display_context = DesktopActivityOverlayDisplayContext {
            is_macos: true,
            is_builtin_display: true,
            has_physical_notch: true,
            safe_area_top: 74.0,
            physical_notch_size: None,
            display_identity: None,
            screen_frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 982.0,
            },
            visible_frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 908.0,
            },
        };
        let resolution = resolve_desktop_activity_overlay_host_mode_resolution(
            DesktopActivityOverlayPresentationMode::Automatic,
            DesktopActivityOverlayPlacementMode::Anchored,
            DesktopActivityOverlayAnchor::TopCenter,
            Some(display_context.clone()),
        );
        let runtime_fallback = ActivityOverlayRuntimeHostFallback {
            display_context: display_context.clone(),
            reason: DesktopActivityOverlayHostFallbackReason::PanelPositionUnavailable,
        };

        let sticky_resolution = resolve_host_mode_resolution_with_runtime_fallback(
            resolution,
            Some(&runtime_fallback),
            Some(&display_context),
        );

        assert_eq!(
            sticky_resolution.requested_mode,
            DesktopActivityOverlayHostMode::NotchIntegrated,
        );
        assert_eq!(
            sticky_resolution.effective_mode,
            DesktopActivityOverlayHostMode::Floating,
        );
        assert_eq!(
            sticky_resolution.fallback_reason,
            Some(DesktopActivityOverlayHostFallbackReason::PanelPositionUnavailable),
        );
    }

    #[test]
    fn ignores_runtime_panel_fallback_after_display_context_changes() {
        let original_context = DesktopActivityOverlayDisplayContext {
            is_macos: true,
            is_builtin_display: true,
            has_physical_notch: true,
            safe_area_top: 74.0,
            physical_notch_size: None,
            display_identity: None,
            screen_frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 982.0,
            },
            visible_frame: Rect {
                x: 0.0,
                y: 0.0,
                width: 1512.0,
                height: 908.0,
            },
        };
        let next_context = DesktopActivityOverlayDisplayContext {
            screen_frame: Rect {
                x: 1512.0,
                y: 0.0,
                width: 1728.0,
                height: 1117.0,
            },
            visible_frame: Rect {
                x: 1512.0,
                y: 0.0,
                width: 1728.0,
                height: 1043.0,
            },
            ..original_context.clone()
        };
        let resolution = resolve_desktop_activity_overlay_host_mode_resolution(
            DesktopActivityOverlayPresentationMode::Automatic,
            DesktopActivityOverlayPlacementMode::Anchored,
            DesktopActivityOverlayAnchor::TopCenter,
            Some(next_context.clone()),
        );
        let runtime_fallback = ActivityOverlayRuntimeHostFallback {
            display_context: original_context,
            reason: DesktopActivityOverlayHostFallbackReason::PanelPositionUnavailable,
        };

        let sticky_resolution = resolve_host_mode_resolution_with_runtime_fallback(
            resolution,
            Some(&runtime_fallback),
            Some(&next_context),
        );

        assert_eq!(
            sticky_resolution.effective_mode,
            DesktopActivityOverlayHostMode::NotchIntegrated,
        );
        assert_eq!(sticky_resolution.fallback_reason, None);
    }

    #[test]
    fn applies_desired_expanded_override_until_main_sync_catches_up() {
        let mut state = ActivityOverlayRuntimeState {
            last_sync_payload: None,
            last_window_state: None,
            desired_expanded: Some(true),
            drag_offsets: PersistedOverlayDragOffsets::default(),
            drag_offsets_loaded: true,
            drag_offsets_storage_key: None,
            last_display_context: None,
            runtime_host_fallback: None,
            display_change_debounce: DesktopActivityOverlayDisplayChangeDebounce::default(),
            native_mouse_state: DesktopActivityOverlayNativeMouseState::default(),
            input_locked: false,
            input_lock_updated_at_epoch_ms: None,
            qa_pinned_sync_payload: None,
            momentum_generation: 0,
        };

        let mut payload = DesktopActivityOverlaySyncPayload {
            visible: true,
            expanded: false,
            model: serde_json::json!({}),
            policy: DesktopActivityOverlayPolicyPayload {
                enabled: true,
                visibility_mode: DesktopActivityOverlayVisibilityMode::ActiveSessions,
                show_when_running: true,
                show_when_attention_required: true,
                show_when_ready: true,
                always_on_top: true,
                auto_hide_enabled: true,
                auto_hide_delay_ms: 6_000,
                expanded_behavior: DesktopActivityOverlayExpandedBehavior::Click,
                interactive_collapsed: true,
                presentation_mode: DesktopActivityOverlayPresentationMode::Automatic,
                click_action: DesktopActivityOverlayClickAction::ExpandOverlay,
                density: DesktopActivityOverlayDensity::Compact,
                compact_style: DesktopActivityOverlayCompactStyle::Pill,
                show_session_count: true,
                show_preview_text: false,
                placement_mode: DesktopActivityOverlayPlacementMode::Anchored,
                display_mode: DesktopActivityOverlayDisplayMode::Automatic,
                anchor: DesktopActivityOverlayAnchor::TopCenter,
                offset_x: 0.0,
                offset_y: 0.0,
                enable_drag_reposition: false,
                lock_position: true,
            },
            window: DesktopActivityOverlayWindowDimensionsPayload {
                collapsed: DesktopActivityOverlayDimensionsPayload {
                    width: 320.0,
                    height: 72.0,
                },
                expanded: DesktopActivityOverlayDimensionsPayload {
                    width: 420.0,
                    height: 240.0,
                },
            },
        };

        apply_desired_expanded_override(&mut state, &mut payload);

        assert_eq!(payload.expanded, true);
        assert_eq!(state.desired_expanded, Some(true));

        let mut caught_up_payload = payload;
        apply_desired_expanded_override(&mut state, &mut caught_up_payload);

        assert_eq!(caught_up_payload.expanded, true);
        assert_eq!(state.desired_expanded, None);
    }

    #[test]
    fn expanded_override_survives_the_next_stale_main_sync() {
        let build_payload = |expanded| DesktopActivityOverlaySyncPayload {
            visible: true,
            expanded,
            model: serde_json::json!({}),
            policy: DesktopActivityOverlayPolicyPayload {
                enabled: true,
                visibility_mode: DesktopActivityOverlayVisibilityMode::ActiveSessions,
                show_when_running: true,
                show_when_attention_required: true,
                show_when_ready: true,
                always_on_top: true,
                auto_hide_enabled: true,
                auto_hide_delay_ms: 6_000,
                expanded_behavior: DesktopActivityOverlayExpandedBehavior::Click,
                interactive_collapsed: true,
                presentation_mode: DesktopActivityOverlayPresentationMode::Automatic,
                click_action: DesktopActivityOverlayClickAction::ExpandOverlay,
                density: DesktopActivityOverlayDensity::Compact,
                compact_style: DesktopActivityOverlayCompactStyle::Pill,
                show_session_count: true,
                show_preview_text: false,
                placement_mode: DesktopActivityOverlayPlacementMode::Anchored,
                display_mode: DesktopActivityOverlayDisplayMode::Automatic,
                anchor: DesktopActivityOverlayAnchor::TopCenter,
                offset_x: 0.0,
                offset_y: 0.0,
                enable_drag_reposition: false,
                lock_position: true,
            },
            window: DesktopActivityOverlayWindowDimensionsPayload {
                collapsed: DesktopActivityOverlayDimensionsPayload {
                    width: 320.0,
                    height: 72.0,
                },
                expanded: DesktopActivityOverlayDimensionsPayload {
                    width: 420.0,
                    height: 240.0,
                },
            },
        };
        let mut state = ActivityOverlayRuntimeState {
            last_sync_payload: Some(build_payload(false)),
            last_window_state: None,
            desired_expanded: None,
            drag_offsets: PersistedOverlayDragOffsets::default(),
            drag_offsets_loaded: true,
            drag_offsets_storage_key: None,
            last_display_context: None,
            runtime_host_fallback: None,
            display_change_debounce: DesktopActivityOverlayDisplayChangeDebounce::default(),
            native_mouse_state: DesktopActivityOverlayNativeMouseState::default(),
            input_locked: false,
            input_lock_updated_at_epoch_ms: None,
            qa_pinned_sync_payload: None,
            momentum_generation: 0,
        };

        apply_expanded_override_to_runtime_state(&mut state, true);

        assert_eq!(
            state
                .last_sync_payload
                .as_ref()
                .map(|payload| payload.expanded),
            Some(true),
        );
        assert_eq!(state.desired_expanded, Some(true));

        let mut stale_main_sync_payload = build_payload(false);
        apply_desired_expanded_override(&mut state, &mut stale_main_sync_payload);

        assert_eq!(stale_main_sync_payload.expanded, true);
        assert_eq!(state.desired_expanded, Some(true));

        let mut caught_up_main_sync_payload = build_payload(true);
        apply_desired_expanded_override(&mut state, &mut caught_up_main_sync_payload);

        assert_eq!(caught_up_main_sync_payload.expanded, true);
        assert_eq!(state.desired_expanded, None);
    }

    #[test]
    fn qa_pinned_sync_payload_ignores_unpinned_live_sync_until_expiry() {
        let build_payload = |kind: &str, pin_until: Option<u64>| {
            let mut model = serde_json::json!({ "kind": kind });
            if let Some(pin_until) = pin_until {
                model[QA_PROOF_PIN_UNTIL_MODEL_KEY] = serde_json::json!(pin_until);
            }
            DesktopActivityOverlaySyncPayload {
                visible: true,
                expanded: kind == "idle",
                model,
                policy: DesktopActivityOverlayPolicyPayload {
                    enabled: true,
                    visibility_mode: DesktopActivityOverlayVisibilityMode::ActiveSessions,
                    show_when_running: true,
                    show_when_attention_required: true,
                    show_when_ready: true,
                    always_on_top: true,
                    auto_hide_enabled: true,
                    auto_hide_delay_ms: 6_000,
                    expanded_behavior: DesktopActivityOverlayExpandedBehavior::Click,
                    interactive_collapsed: true,
                    presentation_mode: DesktopActivityOverlayPresentationMode::Automatic,
                    click_action: DesktopActivityOverlayClickAction::ExpandOverlay,
                    density: DesktopActivityOverlayDensity::Compact,
                    compact_style: DesktopActivityOverlayCompactStyle::Pill,
                    show_session_count: true,
                    show_preview_text: false,
                    placement_mode: DesktopActivityOverlayPlacementMode::Anchored,
                    display_mode: DesktopActivityOverlayDisplayMode::Automatic,
                    anchor: DesktopActivityOverlayAnchor::TopCenter,
                    offset_x: 0.0,
                    offset_y: 0.0,
                    enable_drag_reposition: false,
                    lock_position: true,
                },
                window: DesktopActivityOverlayWindowDimensionsPayload {
                    collapsed: DesktopActivityOverlayDimensionsPayload {
                        width: 320.0,
                        height: 72.0,
                    },
                    expanded: DesktopActivityOverlayDimensionsPayload {
                        width: 420.0,
                        height: 240.0,
                    },
                },
            }
        };
        let mut state = ActivityOverlayRuntimeState {
            last_sync_payload: None,
            last_window_state: None,
            desired_expanded: Some(false),
            drag_offsets: PersistedOverlayDragOffsets::default(),
            drag_offsets_loaded: true,
            drag_offsets_storage_key: None,
            last_display_context: None,
            runtime_host_fallback: None,
            display_change_debounce: DesktopActivityOverlayDisplayChangeDebounce::default(),
            native_mouse_state: DesktopActivityOverlayNativeMouseState::default(),
            input_locked: false,
            input_lock_updated_at_epoch_ms: None,
            qa_pinned_sync_payload: None,
            momentum_generation: 0,
        };

        let pinned =
            apply_qa_sync_pin_override(&mut state, build_payload("idle", Some(2_000)), 1_000);
        assert_eq!(pinned.model["kind"], "idle");
        assert_eq!(pinned.expanded, true);
        assert_eq!(state.desired_expanded, None);

        let live_before_expiry =
            apply_qa_sync_pin_override(&mut state, build_payload("live", None), 1_100);
        assert_eq!(live_before_expiry.model["kind"], "idle");
        assert_eq!(live_before_expiry.expanded, true);

        let live_after_expiry =
            apply_qa_sync_pin_override(&mut state, build_payload("live", None), 2_001);
        assert_eq!(live_after_expiry.model["kind"], "live");
        assert_eq!(live_after_expiry.expanded, false);
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
