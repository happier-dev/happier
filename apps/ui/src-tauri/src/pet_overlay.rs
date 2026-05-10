pub(crate) mod diagnostics;
pub(crate) mod measured_layout;
pub(crate) mod native_mouse;
pub(crate) mod placement;
pub(crate) mod storage;
pub(crate) mod window_lifecycle;

use serde::{Deserialize, Serialize};
#[cfg(target_os = "macos")]
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
#[cfg(target_os = "macos")]
use std::time::Duration;
use tauri::{App, AppHandle, Emitter, Manager, Runtime, State, WebviewWindow};

use self::diagnostics::DesktopPetOverlayPlacementDiagnosticsPayload;
use self::measured_layout::{
    resolve_desktop_pet_overlay_measured_layout, DesktopPetOverlayMeasuredContentMetricsPayload,
    DesktopPetOverlayMeasuredLayoutInput, DesktopPetOverlayMeasuredLayoutPayload,
};
#[cfg(target_os = "macos")]
use self::native_mouse::{
    resolve_pet_overlay_native_mouse_payload, DesktopPetOverlayNativeMousePayload,
    DesktopPetOverlayNativeMousePoint, DesktopPetOverlayNativeWindowFrame,
};
use self::placement::{
    normalize_pet_overlay_drag_offset, resolve_pet_overlay_monitor_for_position,
    resolve_pet_overlay_offset_from_position, resolve_pet_overlay_placement,
    DesktopPetOverlayMonitorRect, DesktopPetOverlayPosition, Rect, Size,
};
use self::storage::{
    clear_persisted_drag_offset_path, persist_drag_offset_to_path, read_persisted_drag_offset,
    resolve_pet_overlay_drag_offset_path, sanitize_drag_offset, PersistedPetOverlayDragOffset,
};
use self::window_lifecycle::{
    ensure_pet_overlay_window, park_pet_overlay_window_offscreen,
    resolve_pet_overlay_available_monitor_rects, resolve_pet_overlay_ignore_cursor_events,
    resolve_pet_overlay_monitor_rect_with_id, set_pet_overlay_window_frame,
};

pub(crate) const PET_OVERLAY_WINDOW_LABEL: &str = "pet_overlay";
pub(crate) const PET_OVERLAY_WINDOW_ROUTE: &str = "/desktop/pet-overlay?desktopPetOverlayWindow=1";
pub(crate) const PET_OVERLAY_STATE_EVENT: &str = "desktop_pet_overlay_window_state_changed";
pub(crate) const PET_OVERLAY_INTERACTION_RESULT_EVENT: &str =
    "desktop_pet_overlay_interaction_result";
pub(crate) const PET_OVERLAY_SHOW_MAIN_WINDOW_REQUESTED_EVENT: &str =
    "desktop_pet_overlay_show_main_window_requested";
pub(crate) const PET_OVERLAY_NATIVE_MOUSE_EVENT: &str = "desktop_pet_overlay_native_mouse_changed";
pub(crate) const PET_MOMENTUM_TICK_MS: u64 = 16;
pub(crate) const PET_MOMENTUM_FRICTION: f64 = 0.88;
pub(crate) const PET_MOMENTUM_STOP_SPEED_PX_PER_S: f64 = 65.0;
pub(crate) const PET_MOMENTUM_MAX_DURATION_MS: u64 = 900;
const PET_VELOCITY_MAX_MAGNITUDE_PX_PER_S: f64 = 1_600.0;
const PET_OVERLAY_PLACEMENT_PADDING_PX: f64 = 0.0;
const PET_OVERLAY_MIN_WINDOW_SIZE_PX: f64 = 1.0;
const PET_OVERLAY_MAX_WINDOW_SIZE_PX: f64 = 2_048.0;
#[cfg(target_os = "macos")]
const PET_OVERLAY_NATIVE_MOUSE_POLL_INTERVAL_MS: u64 = 50;
const MAIN_WINDOW_LABEL: &str = "main";

#[derive(Clone)]
pub struct DesktopPetOverlayState(Arc<Mutex<DesktopPetOverlayRuntimeState>>);

#[derive(Clone, Debug, Default)]
struct DesktopPetOverlayRuntimeState {
    last_sync_payload: Option<DesktopPetOverlaySyncPayload>,
    window_state: Option<DesktopPetOverlayWindowStatePayload>,
    element_metrics: Option<DesktopPetOverlayMeasuredContentMetricsPayload>,
    drag_offset: PersistedPetOverlayDragOffset,
    drag_offset_loaded: bool,
    active_pointer_id: Option<String>,
    momentum_generation: u64,
    #[cfg(target_os = "macos")]
    last_native_mouse_payload: Option<DesktopPetOverlayNativeMousePayload>,
}

struct AppliedDesktopPetOverlayPayload {
    window_state: DesktopPetOverlayWindowStatePayload,
    drag_offset: PersistedPetOverlayDragOffset,
}

impl Default for DesktopPetOverlayState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(DesktopPetOverlayRuntimeState::default())))
    }
}

pub fn register<R: Runtime + 'static>(app: &mut App<R>) -> tauri::Result<()> {
    start_pet_overlay_native_mouse_poll_loop(app.handle().clone(), app.state::<DesktopPetOverlayState>().inner().clone());
    Ok(())
}

#[cfg(target_os = "macos")]
fn start_pet_overlay_native_mouse_poll_loop<R: Runtime + 'static>(
    app: AppHandle<R>,
    state: DesktopPetOverlayState,
) {
    let pending = std::sync::Arc::new(AtomicBool::new(false));
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(PET_OVERLAY_NATIVE_MOUSE_POLL_INTERVAL_MS));
        if pending.swap(true, Ordering::AcqRel) {
            continue;
        }
        let dispatch_app = app.clone();
        let task_app = app.clone();
        let task_state = state.clone();
        let task_pending = pending.clone();
        let result = dispatch_app.run_on_main_thread(move || {
            let _ = publish_pet_overlay_native_mouse_payload(&task_app, &task_state);
            task_pending.store(false, Ordering::Release);
        });
        if result.is_err() {
            break;
        }
    });
}

#[cfg(not(target_os = "macos"))]
fn start_pet_overlay_native_mouse_poll_loop<R: Runtime + 'static>(
    _app: AppHandle<R>,
    _state: DesktopPetOverlayState,
) {
}

#[cfg(target_os = "macos")]
fn publish_pet_overlay_native_mouse_payload<R: Runtime>(
    app: &AppHandle<R>,
    state: &DesktopPetOverlayState,
) -> Result<(), String> {
    let payload = read_pet_overlay_native_mouse_payload_on_main_thread(app, state)?;
    let should_emit = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "DesktopPetOverlayState poisoned".to_string())?;
        if guard.last_native_mouse_payload == Some(payload) {
            false
        } else {
            guard.last_native_mouse_payload = Some(payload);
            true
        }
    };
    if should_emit {
        app.emit_to(PET_OVERLAY_WINDOW_LABEL, PET_OVERLAY_NATIVE_MOUSE_EVENT, payload)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn read_pet_overlay_native_mouse_payload_on_main_thread<R: Runtime>(
    app: &AppHandle<R>,
    state: &DesktopPetOverlayState,
) -> Result<DesktopPetOverlayNativeMousePayload, String> {
    let visible_and_interactive = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "DesktopPetOverlayState poisoned".to_string())?;
        guard
            .window_state
            .as_ref()
            .map(|window_state| window_state.visible && !window_state.input_locked)
            .unwrap_or(false)
    };
    if !visible_and_interactive {
        return Ok(DesktopPetOverlayNativeMousePayload {
            inside: false,
            x: 0.0,
            y: 0.0,
        });
    }

    let Some(window) = app.get_webview_window(PET_OVERLAY_WINDOW_LABEL) else {
        return Ok(DesktopPetOverlayNativeMousePayload {
            inside: false,
            x: 0.0,
            y: 0.0,
        });
    };
    let ns_window_ptr = window.ns_window().map_err(|error| error.to_string())?;
    let ns_window: &objc2_app_kit::NSWindow = unsafe { &*ns_window_ptr.cast() };
    let frame = ns_window.frame();
    let location = unsafe { objc2_app_kit::NSEvent::mouseLocation() };

    Ok(resolve_pet_overlay_native_mouse_payload(
        DesktopPetOverlayNativeWindowFrame {
            x: frame.origin.x,
            y: frame.origin.y,
            width: frame.size.width,
            height: frame.size.height,
        },
        DesktopPetOverlayNativeMousePoint {
            x: location.x,
            y: location.y,
        },
    ))
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetOverlaySizePayload {
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetOverlayPolicyPayload {
    pub enabled: bool,
    pub always_on_top: bool,
    pub anchor: placement::DesktopPetOverlayAnchor,
    pub input_locked: bool,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetOverlaySyncPayload {
    pub visible: bool,
    pub expanded: bool,
    pub window: DesktopPetOverlaySizePayload,
    pub policy: DesktopPetOverlayPolicyPayload,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetOverlayWindowStatePayload {
    pub visible: bool,
    pub input_locked: bool,
    pub monitor_id: Option<String>,
    pub logical_position: LogicalPointPayload,
    pub logical_size: DesktopPetOverlaySizePayload,
    pub scale_factor: f64,
    pub last_placement_recovery_code: Option<String>,
    pub placement_diagnostics: Option<DesktopPetOverlayPlacementDiagnosticsPayload>,
    pub layout: Option<DesktopPetOverlayMeasuredLayoutPayload>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogicalPointPayload {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetOverlayInputLockedPayload {
    pub locked: bool,
    pub reason: DesktopPetOverlayInputLockReason,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopPetOverlayInputLockReason {
    Disabled,
    Hidden,
    Dragging,
    TrayOpen,
    RouteUnmount,
    FeatureDisabled,
    Shutdown,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetOverlayDragStartPayload {
    pub pointer_id: String,
    pub screen_x: f64,
    pub screen_y: f64,
    pub started_at_ms: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetOverlayDragDeltaPayload {
    pub pointer_id: String,
    pub dx: f64,
    pub dy: f64,
    pub coordinate_space: DesktopPetOverlayCoordinateSpace,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetOverlayDragEndPayload {
    pub pointer_id: String,
    pub cancelled: bool,
    pub screen_x: f64,
    pub screen_y: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetOverlayDragVelocityPayload {
    pub pointer_id: String,
    pub vx: f64,
    pub vy: f64,
    pub sample_window_ms: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetOverlayMomentumDeltaPayload {
    pub generation: u64,
    pub dx: f64,
    pub dy: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetOverlayScheduledMomentumDeltaPayload {
    pub dx: f64,
    pub dy: f64,
    pub delay_ms: u64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetOverlayMomentumPlanPayload {
    pub generation: u64,
    pub tick_ms: u64,
    pub deltas: Vec<DesktopPetOverlayScheduledMomentumDeltaPayload>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DesktopPetOverlayCoordinateSpace {
    Screen,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetOverlayShowMainWindowPayload {
    pub reason: DesktopPetOverlayShowMainWindowReason,
    pub target_session_id: Option<String>,
    pub target_thread_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopPetOverlayShowMainWindowReason {
    MascotClick,
    TrayAction,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopPetOverlayInteractionResultPayload {
    pub request_id: String,
    pub ok: bool,
    pub error_code: Option<String>,
    pub error: Option<String>,
}

#[tauri::command]
pub fn sync_desktop_pet_overlay_state<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DesktopPetOverlayState>,
    payload: DesktopPetOverlaySyncPayload,
    caller_window: WebviewWindow<R>,
) -> Result<(), String> {
    validate_pet_overlay_command_caller_for_command(
        "sync_desktop_pet_overlay_state",
        caller_window.label(),
    )?;

    let (drag_offset, element_metrics) = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "DesktopPetOverlayState poisoned".to_string())?;
        ensure_drag_offset_loaded(&app, &mut guard);
        guard.last_sync_payload = Some(payload.clone());
        (guard.drag_offset.clone(), guard.element_metrics.clone())
    };

    let applied =
        apply_desktop_pet_overlay_payload(&app, &payload, drag_offset, element_metrics.as_ref())?;

    let window_state = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "DesktopPetOverlayState poisoned".to_string())?;
        apply_runtime_overlay_payload_result(&app, &mut guard, applied)
    };

    app.emit(PET_OVERLAY_STATE_EVENT, window_state)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn desktop_pet_overlay_read_window_state<R: Runtime>(
    state: State<'_, DesktopPetOverlayState>,
    caller_window: WebviewWindow<R>,
) -> Result<Option<DesktopPetOverlayWindowStatePayload>, String> {
    validate_pet_overlay_command_caller_for_command(
        "desktop_pet_overlay_read_window_state",
        caller_window.label(),
    )?;

    state
        .0
        .lock()
        .map(|guard| guard.window_state.clone())
        .map_err(|_| "DesktopPetOverlayState poisoned".to_string())
}

#[tauri::command]
pub fn desktop_pet_overlay_sync_element_metrics<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DesktopPetOverlayState>,
    payload: DesktopPetOverlayMeasuredContentMetricsPayload,
    caller_window: WebviewWindow<R>,
) -> Result<(), String> {
    validate_pet_overlay_command_caller_for_command(
        "desktop_pet_overlay_sync_element_metrics",
        caller_window.label(),
    )?;

    let (sync_payload, drag_offset, element_metrics) = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "DesktopPetOverlayState poisoned".to_string())?;
        ensure_drag_offset_loaded(&app, &mut guard);
        guard.element_metrics = Some(payload);
        (
            guard.last_sync_payload.clone(),
            guard.drag_offset.clone(),
            guard.element_metrics.clone(),
        )
    };

    let Some(sync_payload) = sync_payload else {
        return Ok(());
    };

    let applied = apply_desktop_pet_overlay_payload(
        &app,
        &sync_payload,
        drag_offset,
        element_metrics.as_ref(),
    )?;
    let window_state = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "DesktopPetOverlayState poisoned".to_string())?;
        apply_runtime_overlay_payload_result(&app, &mut guard, applied)
    };
    app.emit(PET_OVERLAY_STATE_EVENT, window_state)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn desktop_pet_overlay_set_input_locked<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DesktopPetOverlayState>,
    input: DesktopPetOverlayInputLockedPayload,
    caller_window: WebviewWindow<R>,
) -> Result<(), String> {
    validate_pet_overlay_command_caller_for_command(
        "desktop_pet_overlay_set_input_locked",
        caller_window.label(),
    )?;

    let mut guard = state
        .0
        .lock()
        .map_err(|_| "DesktopPetOverlayState poisoned".to_string())?;
    require_visible_enabled_overlay_state(&guard)?;
    if let Some(window_state) = guard.window_state.as_mut() {
        window_state.input_locked = input.locked;
    }
    if let Some(payload) = guard.last_sync_payload.as_mut() {
        payload.policy.input_locked = input.locked;
    }
    if input.locked {
        guard.active_pointer_id = None;
        guard.momentum_generation = guard.momentum_generation.wrapping_add(1);
    }
    if let Some(window) = app.get_webview_window(PET_OVERLAY_WINDOW_LABEL) {
        let _ =
            window.set_ignore_cursor_events(resolve_pet_overlay_ignore_cursor_events(input.locked));
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_pet_overlay_start_drag_session<R: Runtime>(
    state: State<'_, DesktopPetOverlayState>,
    payload: DesktopPetOverlayDragStartPayload,
    caller_window: WebviewWindow<R>,
) -> Result<(), String> {
    validate_pet_overlay_command_caller_for_command(
        "desktop_pet_overlay_start_drag_session",
        caller_window.label(),
    )?;
    validate_pointer_id(&payload.pointer_id)?;
    validate_finite("screenX", payload.screen_x)?;
    validate_finite("screenY", payload.screen_y)?;
    validate_finite("startedAtMs", payload.started_at_ms)?;

    let mut guard = state
        .0
        .lock()
        .map_err(|_| "DesktopPetOverlayState poisoned".to_string())?;
    require_enabled_overlay_interaction(&guard)?;
    guard.active_pointer_id = Some(payload.pointer_id);
    guard.momentum_generation = guard.momentum_generation.wrapping_add(1);
    Ok(())
}

#[tauri::command]
pub fn desktop_pet_overlay_apply_drag_delta<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DesktopPetOverlayState>,
    payload: DesktopPetOverlayDragDeltaPayload,
    caller_window: WebviewWindow<R>,
) -> Result<(), String> {
    validate_pet_overlay_command_caller_for_command(
        "desktop_pet_overlay_apply_drag_delta",
        caller_window.label(),
    )?;

    validate_pointer_id(&payload.pointer_id)?;
    validate_finite("dx", payload.dx)?;
    validate_finite("dy", payload.dy)?;

    let (payload, drag_offset, element_metrics) = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "DesktopPetOverlayState poisoned".to_string())?;
        ensure_drag_offset_loaded(&app, &mut guard);
        require_enabled_overlay_interaction(&guard)?;
        require_active_pointer(&guard, &payload.pointer_id)?;
        let current_drag_offset = guard
            .last_sync_payload
            .as_ref()
            .map(|sync_payload| {
                normalize_drag_offset_from_window_state(
                    sync_payload,
                    guard.window_state.as_ref(),
                    guard.drag_offset.clone(),
                )
            })
            .unwrap_or_else(|| guard.drag_offset.clone());
        guard.drag_offset = guard
            .last_sync_payload
            .as_ref()
            .map(|sync_payload| {
                resolve_drag_offset_after_window_delta(
                    &app,
                    sync_payload,
                    guard.window_state.as_ref(),
                    current_drag_offset.clone(),
                    payload.dx,
                    payload.dy,
                )
            })
            .unwrap_or_else(|| {
                sanitize_drag_offset(PersistedPetOverlayDragOffset {
                    x: current_drag_offset.x + payload.dx,
                    y: current_drag_offset.y + payload.dy,
                    monitor_id: current_drag_offset.monitor_id,
                })
            });
        persist_drag_offset_if_possible(&app, guard.drag_offset.clone());
        (
            guard.last_sync_payload.clone(),
            guard.drag_offset.clone(),
            guard.element_metrics.clone(),
        )
    };

    if let Some(payload) = payload {
        let applied = apply_desktop_pet_overlay_payload(
            &app,
            &payload,
            drag_offset,
            element_metrics.as_ref(),
        )?;
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "DesktopPetOverlayState poisoned".to_string())?;
        let _ = apply_runtime_overlay_payload_result(&app, &mut guard, applied);
    }
    Ok(())
}

#[tauri::command]
pub fn desktop_pet_overlay_release_drag_velocity<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DesktopPetOverlayState>,
    payload: DesktopPetOverlayDragVelocityPayload,
    caller_window: WebviewWindow<R>,
) -> Result<DesktopPetOverlayMomentumPlanPayload, String> {
    validate_pet_overlay_command_caller_for_command(
        "desktop_pet_overlay_release_drag_velocity",
        caller_window.label(),
    )?;
    validate_pointer_id(&payload.pointer_id)?;
    validate_finite("vx", payload.vx)?;
    validate_finite("vy", payload.vy)?;
    validate_finite("sampleWindowMs", payload.sample_window_ms)?;
    if payload.sample_window_ms <= 0.0 {
        return Err("Desktop pet overlay velocity sample window must be positive".to_string());
    }

    let (generation, velocity) = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "DesktopPetOverlayState poisoned".to_string())?;
        ensure_drag_offset_loaded(&app, &mut guard);
        require_enabled_overlay_interaction(&guard)?;
        require_active_pointer(&guard, &payload.pointer_id)?;
        guard.momentum_generation = guard.momentum_generation.wrapping_add(1);
        (
            guard.momentum_generation,
            cap_velocity(payload.vx, payload.vy),
        )
    };
    Ok(resolve_pet_overlay_momentum_plan(generation, velocity))
}

#[tauri::command]
pub fn desktop_pet_overlay_apply_momentum_delta<R: Runtime>(
    app: AppHandle<R>,
    payload: DesktopPetOverlayMomentumDeltaPayload,
    caller_window: WebviewWindow<R>,
) -> Result<(), String> {
    validate_pet_overlay_command_caller_for_command(
        "desktop_pet_overlay_apply_momentum_delta",
        caller_window.label(),
    )?;
    validate_finite("dx", payload.dx)?;
    validate_finite("dy", payload.dy)?;

    apply_pet_overlay_momentum_delta(&app, payload.generation, payload.dx, payload.dy)?;
    Ok(())
}

#[tauri::command]
pub fn desktop_pet_overlay_end_drag_session<R: Runtime>(
    state: State<'_, DesktopPetOverlayState>,
    payload: DesktopPetOverlayDragEndPayload,
    caller_window: WebviewWindow<R>,
) -> Result<(), String> {
    validate_pet_overlay_command_caller_for_command(
        "desktop_pet_overlay_end_drag_session",
        caller_window.label(),
    )?;
    validate_pointer_id(&payload.pointer_id)?;
    validate_finite("screenX", payload.screen_x)?;
    validate_finite("screenY", payload.screen_y)?;

    let mut guard = state
        .0
        .lock()
        .map_err(|_| "DesktopPetOverlayState poisoned".to_string())?;
    require_enabled_overlay_interaction(&guard)?;
    require_active_pointer(&guard, &payload.pointer_id)?;
    guard.active_pointer_id = None;
    Ok(())
}

#[tauri::command]
pub fn desktop_pet_overlay_reset_position<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DesktopPetOverlayState>,
    caller_window: WebviewWindow<R>,
) -> Result<(), String> {
    validate_pet_overlay_command_caller_for_command(
        "desktop_pet_overlay_reset_position",
        caller_window.label(),
    )?;

    let (payload, element_metrics) = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "DesktopPetOverlayState poisoned".to_string())?;
        guard.drag_offset = PersistedPetOverlayDragOffset::default();
        guard.drag_offset_loaded = true;
        if let Ok(path) = resolve_pet_overlay_drag_offset_path(&app) {
            clear_persisted_drag_offset_path(&path).map_err(|error| error.to_string())?;
        }
        (
            guard.last_sync_payload.clone(),
            guard.element_metrics.clone(),
        )
    };

    if let Some(payload) = payload {
        let applied = apply_desktop_pet_overlay_payload(
            &app,
            &payload,
            PersistedPetOverlayDragOffset::default(),
            element_metrics.as_ref(),
        )?;
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "DesktopPetOverlayState poisoned".to_string())?;
        let _ = apply_runtime_overlay_payload_result(&app, &mut guard, applied);
    }
    Ok(())
}

#[tauri::command]
pub fn emit_desktop_pet_overlay_interaction_result<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, DesktopPetOverlayState>,
    payload: DesktopPetOverlayInteractionResultPayload,
    caller_window: WebviewWindow<R>,
) -> Result<(), String> {
    validate_pet_overlay_command_caller_for_command(
        "emit_desktop_pet_overlay_interaction_result",
        caller_window.label(),
    )?;

    let guard = state
        .0
        .lock()
        .map_err(|_| "DesktopPetOverlayState poisoned".to_string())?;
    require_visible_enabled_overlay_state(&guard)?;
    app.emit(PET_OVERLAY_INTERACTION_RESULT_EVENT, payload)
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub fn desktop_pet_overlay_show_main_window<R: Runtime>(
    app: AppHandle<R>,
    payload: DesktopPetOverlayShowMainWindowPayload,
    caller_window: WebviewWindow<R>,
) -> Result<(), String> {
    validate_pet_overlay_command_caller_for_command(
        "desktop_pet_overlay_show_main_window",
        caller_window.label(),
    )?;
    if let Some(window) = app.get_webview_window("main") {
        window
            .emit(
                PET_OVERLAY_SHOW_MAIN_WINDOW_REQUESTED_EVENT,
                payload.clone(),
            )
            .map_err(|error| error.to_string())?;
        window.unminimize().map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn ensure_drag_offset_loaded<R: Runtime>(
    app: &AppHandle<R>,
    state: &mut DesktopPetOverlayRuntimeState,
) {
    if state.drag_offset_loaded {
        return;
    }

    state.drag_offset = sanitize_drag_offset(read_persisted_drag_offset(
        resolve_pet_overlay_drag_offset_path(app).ok().as_deref(),
    ));
    state.drag_offset_loaded = true;
}

fn persist_drag_offset_if_possible<R: Runtime>(
    app: &AppHandle<R>,
    offset: PersistedPetOverlayDragOffset,
) {
    if let Ok(path) = resolve_pet_overlay_drag_offset_path(app) {
        persist_drag_offset_to_path(&path, offset);
    }
}

fn apply_runtime_overlay_payload_result<R: Runtime>(
    app: &AppHandle<R>,
    state: &mut DesktopPetOverlayRuntimeState,
    applied: AppliedDesktopPetOverlayPayload,
) -> DesktopPetOverlayWindowStatePayload {
    state.drag_offset = applied.drag_offset.clone();
    persist_drag_offset_if_possible(app, applied.drag_offset.clone());
    state.window_state = Some(applied.window_state.clone());
    applied.window_state
}

fn normalize_drag_offset_from_window_state(
    payload: &DesktopPetOverlaySyncPayload,
    window_state: Option<&DesktopPetOverlayWindowStatePayload>,
    drag_offset: PersistedPetOverlayDragOffset,
) -> PersistedPetOverlayDragOffset {
    let Some(window_state) = window_state else {
        return drag_offset;
    };
    let Some(diagnostics) = window_state.placement_diagnostics.as_ref() else {
        return drag_offset;
    };
    let normalized = normalize_pet_overlay_drag_offset(
        Rect {
            x: diagnostics.effective_monitor.x,
            y: diagnostics.effective_monitor.y,
            width: diagnostics.effective_monitor.width,
            height: diagnostics.effective_monitor.height,
        },
        Size {
            width: window_state.logical_size.width,
            height: window_state.logical_size.height,
        },
        payload.policy.anchor,
        drag_offset.x,
        drag_offset.y,
        PET_OVERLAY_PLACEMENT_PADDING_PX,
    );
    PersistedPetOverlayDragOffset {
        x: normalized.x,
        y: normalized.y,
        monitor_id: window_state.monitor_id.clone(),
    }
}

fn resolve_drag_offset_after_window_delta_for_monitors(
    monitors: &[DesktopPetOverlayMonitorRect],
    payload: &DesktopPetOverlaySyncPayload,
    window_state: Option<&DesktopPetOverlayWindowStatePayload>,
    dx: f64,
    dy: f64,
) -> Option<PersistedPetOverlayDragOffset> {
    let window_state = window_state?;
    let window = Size {
        width: window_state.logical_size.width,
        height: window_state.logical_size.height,
    };
    let desired_position = DesktopPetOverlayPosition {
        x: window_state.logical_position.x + dx,
        y: window_state.logical_position.y + dy,
    };
    let target_monitor =
        resolve_pet_overlay_monitor_for_position(monitors, None, desired_position, window)?;
    let offset = resolve_pet_overlay_offset_from_position(
        target_monitor.rect,
        window,
        payload.policy.anchor,
        desired_position,
        PET_OVERLAY_PLACEMENT_PADDING_PX,
    );

    Some(sanitize_drag_offset(PersistedPetOverlayDragOffset {
        x: offset.x,
        y: offset.y,
        monitor_id: Some(target_monitor.id.clone()),
    }))
}

fn resolve_drag_offset_after_window_delta<R: Runtime>(
    app: &AppHandle<R>,
    payload: &DesktopPetOverlaySyncPayload,
    window_state: Option<&DesktopPetOverlayWindowStatePayload>,
    current_drag_offset: PersistedPetOverlayDragOffset,
    dx: f64,
    dy: f64,
) -> PersistedPetOverlayDragOffset {
    let Some(window) = app.get_webview_window(PET_OVERLAY_WINDOW_LABEL) else {
        return sanitize_drag_offset(PersistedPetOverlayDragOffset {
            x: current_drag_offset.x + dx,
            y: current_drag_offset.y + dy,
            monitor_id: current_drag_offset.monitor_id,
        });
    };
    resolve_drag_offset_after_window_delta_for_monitors(
        &resolve_pet_overlay_available_monitor_rects(app, &window),
        payload,
        window_state,
        dx,
        dy,
    )
    .unwrap_or_else(|| {
        sanitize_drag_offset(PersistedPetOverlayDragOffset {
            x: current_drag_offset.x + dx,
            y: current_drag_offset.y + dy,
            monitor_id: current_drag_offset.monitor_id,
        })
    })
}

fn validate_pet_overlay_command_caller(
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

fn validate_pet_overlay_command_caller_for_command(
    command_name: &str,
    caller_label: &str,
) -> Result<(), String> {
    let allowed_labels: &[&str] = match command_name {
        "sync_desktop_pet_overlay_state"
        | "desktop_pet_overlay_set_input_locked"
        | "desktop_pet_overlay_reset_position"
        | "emit_desktop_pet_overlay_interaction_result" => &[MAIN_WINDOW_LABEL],
        "desktop_pet_overlay_start_drag_session"
        | "desktop_pet_overlay_apply_drag_delta"
        | "desktop_pet_overlay_release_drag_velocity"
        | "desktop_pet_overlay_apply_momentum_delta"
        | "desktop_pet_overlay_end_drag_session"
        | "desktop_pet_overlay_sync_element_metrics"
        | "desktop_pet_overlay_show_main_window" => &[PET_OVERLAY_WINDOW_LABEL],
        "desktop_pet_overlay_read_window_state" => &[MAIN_WINDOW_LABEL, PET_OVERLAY_WINDOW_LABEL],
        _ => {
            return Err(format!(
                "Unknown desktop pet overlay command `{command_name}`"
            ))
        }
    };

    validate_pet_overlay_command_caller(command_name, caller_label, allowed_labels)
}

fn validate_pointer_id(pointer_id: &str) -> Result<(), String> {
    if pointer_id.trim().is_empty() {
        return Err("Desktop pet overlay pointer id must be non-empty".to_string());
    }
    Ok(())
}

fn validate_finite(name: &str, value: f64) -> Result<(), String> {
    if value.is_finite() {
        return Ok(());
    }
    Err(format!("Desktop pet overlay `{name}` must be finite"))
}

fn require_active_pointer(
    state: &DesktopPetOverlayRuntimeState,
    pointer_id: &str,
) -> Result<(), String> {
    match state.active_pointer_id.as_deref() {
        Some(active_pointer_id) if active_pointer_id == pointer_id => Ok(()),
        _ => Err("Desktop pet overlay drag pointer is not active".to_string()),
    }
}

fn require_enabled_overlay_interaction(
    state: &DesktopPetOverlayRuntimeState,
) -> Result<(), String> {
    let payload = require_visible_enabled_overlay_state(state)?;
    if payload.policy.input_locked {
        return Err("Desktop pet overlay drag interaction is locked".to_string());
    }
    Ok(())
}

fn require_visible_enabled_overlay_state(
    state: &DesktopPetOverlayRuntimeState,
) -> Result<&DesktopPetOverlaySyncPayload, String> {
    match state.last_sync_payload.as_ref() {
        Some(payload) if payload.visible && payload.policy.enabled => Ok(payload),
        _ => Err("Desktop pet overlay is disabled".to_string()),
    }
}

fn apply_desktop_pet_overlay_payload<R: Runtime>(
    app: &AppHandle<R>,
    payload: &DesktopPetOverlaySyncPayload,
    drag_offset: PersistedPetOverlayDragOffset,
    element_metrics: Option<&DesktopPetOverlayMeasuredContentMetricsPayload>,
) -> Result<AppliedDesktopPetOverlayPayload, String> {
    let window_size = sanitize_pet_overlay_window_size(payload.window.clone());
    if !payload.visible || !payload.policy.enabled {
        if let Some(window) = app.get_webview_window(PET_OVERLAY_WINDOW_LABEL) {
            park_pet_overlay_window_offscreen(app, &window)?;
        }
        return Ok(AppliedDesktopPetOverlayPayload {
            drag_offset,
            window_state: DesktopPetOverlayWindowStatePayload {
                visible: false,
                input_locked: payload.policy.input_locked,
                monitor_id: None,
                logical_position: LogicalPointPayload { x: 0.0, y: 0.0 },
                logical_size: window_size,
                scale_factor: 1.0,
                last_placement_recovery_code: None,
                placement_diagnostics: None,
                layout: None,
            },
        });
    }

    let window = ensure_pet_overlay_window(app, payload.policy.always_on_top)?;
    let target_monitor =
        resolve_pet_overlay_monitor_rect_with_id(app, &window, drag_offset.monitor_id.as_deref());
    let monitor = target_monitor.rect;
    let normalized_drag_offset = if let Some(metrics) = element_metrics {
        let layout =
            resolve_desktop_pet_overlay_measured_layout(DesktopPetOverlayMeasuredLayoutInput {
                expanded: payload.expanded,
                anchor: payload.policy.anchor,
                monitor,
                drag_offset: drag_offset.clone(),
                placement_padding: PET_OVERLAY_PLACEMENT_PADDING_PX,
                metrics: metrics.clone(),
            });
        let normalized = normalize_pet_overlay_drag_offset(
            monitor,
            Size {
                width: layout.window.width,
                height: layout.window.height,
            },
            payload.policy.anchor,
            drag_offset.x,
            drag_offset.y,
            PET_OVERLAY_PLACEMENT_PADDING_PX,
        );
        PersistedPetOverlayDragOffset {
            x: normalized.x,
            y: normalized.y,
            monitor_id: Some(target_monitor.id.clone()),
        }
    } else {
        let normalized = normalize_pet_overlay_drag_offset(
            monitor,
            Size {
                width: window_size.width,
                height: window_size.height,
            },
            payload.policy.anchor,
            drag_offset.x,
            drag_offset.y,
            PET_OVERLAY_PLACEMENT_PADDING_PX,
        );
        PersistedPetOverlayDragOffset {
            x: normalized.x,
            y: normalized.y,
            monitor_id: Some(target_monitor.id.clone()),
        }
    };
    let layout = element_metrics.map(|metrics| {
        resolve_desktop_pet_overlay_measured_layout(DesktopPetOverlayMeasuredLayoutInput {
            expanded: payload.expanded,
            anchor: payload.policy.anchor,
            monitor,
            drag_offset: normalized_drag_offset.clone(),
            placement_padding: PET_OVERLAY_PLACEMENT_PADDING_PX,
            metrics: metrics.clone(),
        })
    });
    let (position, effective_window_size) = if let Some(layout) = layout.as_ref() {
        (
            placement::DesktopPetOverlayPosition {
                x: layout.window.x,
                y: layout.window.y,
            },
            DesktopPetOverlaySizePayload {
                width: layout.window.width,
                height: layout.window.height,
            },
        )
    } else {
        (
            resolve_pet_overlay_placement(
                monitor,
                Size {
                    width: window_size.width,
                    height: window_size.height,
                },
                payload.policy.anchor,
                normalized_drag_offset.x,
                normalized_drag_offset.y,
                PET_OVERLAY_PLACEMENT_PADDING_PX,
            ),
            window_size,
        )
    };

    set_pet_overlay_window_frame(
        &window,
        position,
        effective_window_size.width,
        effective_window_size.height,
    )?;
    let _ = window.set_always_on_top(payload.policy.always_on_top);
    let _ = window.set_ignore_cursor_events(resolve_pet_overlay_ignore_cursor_events(
        payload.policy.input_locked,
    ));
    window.show().map_err(|error| error.to_string())?;

    Ok(AppliedDesktopPetOverlayPayload {
        drag_offset: normalized_drag_offset,
        window_state: DesktopPetOverlayWindowStatePayload {
            visible: true,
            input_locked: payload.policy.input_locked,
            monitor_id: Some(target_monitor.id),
            logical_position: LogicalPointPayload {
                x: position.x,
                y: position.y,
            },
            logical_size: effective_window_size,
            scale_factor: window.scale_factor().unwrap_or(1.0).max(0.000_1),
            last_placement_recovery_code: None,
            placement_diagnostics: Some(diagnostics::build_pet_overlay_placement_diagnostics(
                monitor,
                payload.policy.anchor,
                position,
            )),
            layout,
        },
    })
}

fn sanitize_pet_overlay_window_size(
    size: DesktopPetOverlaySizePayload,
) -> DesktopPetOverlaySizePayload {
    DesktopPetOverlaySizePayload {
        width: sanitize_pet_overlay_window_axis(size.width),
        height: sanitize_pet_overlay_window_axis(size.height),
    }
}

fn sanitize_pet_overlay_window_axis(value: f64) -> f64 {
    if !value.is_finite() {
        return PET_OVERLAY_MIN_WINDOW_SIZE_PX;
    }
    value.clamp(
        PET_OVERLAY_MIN_WINDOW_SIZE_PX,
        PET_OVERLAY_MAX_WINDOW_SIZE_PX,
    )
}

fn cap_velocity(vx: f64, vy: f64) -> (f64, f64) {
    let magnitude = vx.hypot(vy);
    if magnitude <= PET_VELOCITY_MAX_MAGNITUDE_PX_PER_S || magnitude <= 0.0 {
        return (vx, vy);
    }
    let scale = PET_VELOCITY_MAX_MAGNITUDE_PX_PER_S / magnitude;
    (vx * scale, vy * scale)
}

fn resolve_pet_overlay_momentum_deltas(vx: f64, vy: f64) -> Vec<(f64, f64)> {
    let (mut vx, mut vy) = cap_velocity(vx, vy);
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

fn resolve_pet_overlay_momentum_plan(
    generation: u64,
    velocity: (f64, f64),
) -> DesktopPetOverlayMomentumPlanPayload {
    DesktopPetOverlayMomentumPlanPayload {
        generation,
        tick_ms: PET_MOMENTUM_TICK_MS,
        deltas: resolve_pet_overlay_momentum_deltas(velocity.0, velocity.1)
            .into_iter()
            .map(|(dx, dy)| DesktopPetOverlayScheduledMomentumDeltaPayload {
                dx,
                dy,
                delay_ms: PET_MOMENTUM_TICK_MS,
            })
            .collect(),
    }
}

fn apply_pet_overlay_momentum_delta<R: Runtime>(
    app: &AppHandle<R>,
    generation: u64,
    dx: f64,
    dy: f64,
) -> Result<bool, String> {
    let state = app.state::<DesktopPetOverlayState>();
    let (payload, drag_offset, element_metrics) = {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "DesktopPetOverlayState poisoned".to_string())?;
        if guard.momentum_generation != generation {
            return Ok(false);
        }
        ensure_drag_offset_loaded(app, &mut guard);
        if require_enabled_overlay_interaction(&guard).is_err() {
            return Ok(false);
        }
        let current_drag_offset = guard
            .last_sync_payload
            .as_ref()
            .map(|sync_payload| {
                normalize_drag_offset_from_window_state(
                    sync_payload,
                    guard.window_state.as_ref(),
                    guard.drag_offset.clone(),
                )
            })
            .unwrap_or_else(|| guard.drag_offset.clone());
        guard.drag_offset = guard
            .last_sync_payload
            .as_ref()
            .map(|sync_payload| {
                resolve_drag_offset_after_window_delta(
                    app,
                    sync_payload,
                    guard.window_state.as_ref(),
                    current_drag_offset.clone(),
                    dx,
                    dy,
                )
            })
            .unwrap_or_else(|| {
                sanitize_drag_offset(PersistedPetOverlayDragOffset {
                    x: current_drag_offset.x + dx,
                    y: current_drag_offset.y + dy,
                    monitor_id: current_drag_offset.monitor_id,
                })
            });
        persist_drag_offset_if_possible(app, guard.drag_offset.clone());
        (
            guard.last_sync_payload.clone(),
            guard.drag_offset.clone(),
            guard.element_metrics.clone(),
        )
    };
    let Some(payload) = payload else {
        return Ok(false);
    };
    let applied =
        apply_desktop_pet_overlay_payload(app, &payload, drag_offset, element_metrics.as_ref())?;
    let mut guard = state
        .0
        .lock()
        .map_err(|_| "DesktopPetOverlayState poisoned".to_string())?;
    let window_state = apply_runtime_overlay_payload_result(app, &mut guard, applied);
    let _ = app.emit(PET_OVERLAY_STATE_EVENT, window_state);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::{fs, path::PathBuf};

    fn read_capability_file(name: &str) -> Value {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("capabilities")
            .join(name);
        let contents = fs::read_to_string(&path).unwrap_or_else(|error| {
            panic!("failed to read capability {}: {error}", path.display())
        });
        serde_json::from_str(&contents).unwrap_or_else(|error| {
            panic!("failed to parse capability {}: {error}", path.display())
        })
    }

    fn read_tauri_config_file(name: &str) -> Value {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join(name);
        let contents = fs::read_to_string(&path).unwrap_or_else(|error| {
            panic!("failed to read tauri config {}: {error}", path.display())
        });
        serde_json::from_str(&contents).unwrap_or_else(|error| {
            panic!("failed to parse tauri config {}: {error}", path.display())
        })
    }

    fn read_pet_overlay_source_file() -> String {
        let source_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("pet_overlay.rs");
        fs::read_to_string(&source_path).unwrap_or_else(|error| {
            panic!(
                "failed to read pet overlay source {}: {error}",
                source_path.display()
            )
        })
    }

    fn read_generated_acl_manifest_file() -> Value {
        let path = PathBuf::from(env!("OUT_DIR")).join("acl-manifests.json");
        let contents = fs::read_to_string(&path).unwrap_or_else(|error| {
            panic!(
                "failed to read generated acl manifest {}: {error}",
                path.display()
            )
        });
        serde_json::from_str(&contents).unwrap_or_else(|error| {
            panic!(
                "failed to parse generated acl manifest {}: {error}",
                path.display()
            )
        })
    }

    fn sync_payload_with_input_lock(input_locked: bool) -> DesktopPetOverlaySyncPayload {
        DesktopPetOverlaySyncPayload {
            visible: true,
            expanded: false,
            window: DesktopPetOverlaySizePayload {
                width: 192.0,
                height: 208.0,
            },
            policy: DesktopPetOverlayPolicyPayload {
                enabled: true,
                always_on_top: true,
                anchor: placement::DesktopPetOverlayAnchor::BottomRight,
                input_locked,
            },
        }
    }

    #[test]
    fn serializes_sync_payload_with_camel_case_policy_fields() {
        let payload = DesktopPetOverlaySyncPayload {
            visible: true,
            expanded: false,
            window: DesktopPetOverlaySizePayload {
                width: 192.0,
                height: 208.0,
            },
            policy: DesktopPetOverlayPolicyPayload {
                enabled: true,
                always_on_top: true,
                anchor: placement::DesktopPetOverlayAnchor::BottomRight,
                input_locked: false,
            },
        };

        let json = serde_json::to_value(payload).expect("payload should serialize");

        assert_eq!(json["policy"]["alwaysOnTop"], true);
        assert_eq!(json["policy"]["inputLocked"], false);
        assert_eq!(json["window"]["width"], 192.0);
    }

    #[test]
    fn sanitizes_overlay_window_size_before_native_placement() {
        assert_eq!(
            sanitize_pet_overlay_window_size(DesktopPetOverlaySizePayload {
                width: 0.0,
                height: -20.0,
            }),
            DesktopPetOverlaySizePayload {
                width: 1.0,
                height: 1.0,
            },
        );
        assert_eq!(
            sanitize_pet_overlay_window_size(DesktopPetOverlaySizePayload {
                width: 4_096.0,
                height: f64::INFINITY,
            }),
            DesktopPetOverlaySizePayload {
                width: 2_048.0,
                height: 1.0,
            },
        );
    }

    #[test]
    fn desktop_pet_overlay_places_the_visual_window_flush_to_the_monitor_edge() {
        assert_eq!(PET_OVERLAY_PLACEMENT_PADDING_PX, 0.0);
    }

    #[test]
    fn declares_expected_pet_overlay_event_names() {
        assert_eq!(
            PET_OVERLAY_STATE_EVENT,
            "desktop_pet_overlay_window_state_changed",
        );
        assert_eq!(
            PET_OVERLAY_INTERACTION_RESULT_EVENT,
            "desktop_pet_overlay_interaction_result",
        );
        assert_eq!(
            PET_OVERLAY_SHOW_MAIN_WINDOW_REQUESTED_EVENT,
            "desktop_pet_overlay_show_main_window_requested",
        );
        assert_eq!(
            PET_OVERLAY_NATIVE_MOUSE_EVENT,
            "desktop_pet_overlay_native_mouse_changed",
        );
    }

    #[test]
    fn validates_pet_overlay_command_caller_against_allowed_labels() {
        let command_name = "sync_desktop_pet_overlay_state";

        assert!(validate_pet_overlay_command_caller(command_name, "main", &["main"]).is_ok());
        assert!(validate_pet_overlay_command_caller(
            command_name,
            PET_OVERLAY_WINDOW_LABEL,
            &["main"]
        )
        .is_err());
    }

    #[test]
    fn validates_pet_overlay_commands_against_their_owner_windows() {
        assert!(validate_pet_overlay_command_caller_for_command(
            "sync_desktop_pet_overlay_state",
            "main",
        )
        .is_ok());
        assert!(validate_pet_overlay_command_caller_for_command(
            "sync_desktop_pet_overlay_state",
            PET_OVERLAY_WINDOW_LABEL,
        )
        .is_err());
        assert!(validate_pet_overlay_command_caller_for_command(
            "desktop_pet_overlay_set_input_locked",
            "main",
        )
        .is_ok());
        assert!(validate_pet_overlay_command_caller_for_command(
            "desktop_pet_overlay_set_input_locked",
            PET_OVERLAY_WINDOW_LABEL,
        )
        .is_err());
        assert!(validate_pet_overlay_command_caller_for_command(
            "desktop_pet_overlay_sync_element_metrics",
            PET_OVERLAY_WINDOW_LABEL,
        )
        .is_ok());
        assert!(validate_pet_overlay_command_caller_for_command(
            "desktop_pet_overlay_sync_element_metrics",
            "main",
        )
        .is_err());
        assert!(validate_pet_overlay_command_caller_for_command(
            "desktop_pet_overlay_start_drag_session",
            PET_OVERLAY_WINDOW_LABEL,
        )
        .is_ok());
        assert!(validate_pet_overlay_command_caller_for_command(
            "desktop_pet_overlay_start_drag_session",
            "main",
        )
        .is_err());
        assert!(validate_pet_overlay_command_caller_for_command(
            "desktop_pet_overlay_apply_drag_delta",
            PET_OVERLAY_WINDOW_LABEL,
        )
        .is_ok());
        assert!(validate_pet_overlay_command_caller_for_command(
            "desktop_pet_overlay_apply_drag_delta",
            "main",
        )
        .is_err());
        assert!(validate_pet_overlay_command_caller_for_command(
            "desktop_pet_overlay_release_drag_velocity",
            PET_OVERLAY_WINDOW_LABEL,
        )
        .is_ok());
        assert!(validate_pet_overlay_command_caller_for_command(
            "desktop_pet_overlay_apply_momentum_delta",
            PET_OVERLAY_WINDOW_LABEL,
        )
        .is_ok());
        assert!(validate_pet_overlay_command_caller_for_command(
            "desktop_pet_overlay_apply_momentum_delta",
            "main",
        )
        .is_err());
        assert!(validate_pet_overlay_command_caller_for_command(
            "desktop_pet_overlay_end_drag_session",
            PET_OVERLAY_WINDOW_LABEL,
        )
        .is_ok());
        assert!(validate_pet_overlay_command_caller_for_command(
            "desktop_pet_overlay_reset_position",
            "main",
        )
        .is_ok());
        assert!(validate_pet_overlay_command_caller_for_command(
            "desktop_pet_overlay_reset_position",
            PET_OVERLAY_WINDOW_LABEL,
        )
        .is_err());
        assert!(validate_pet_overlay_command_caller_for_command(
            "emit_desktop_pet_overlay_interaction_result",
            "main",
        )
        .is_ok());
        assert!(validate_pet_overlay_command_caller_for_command(
            "emit_desktop_pet_overlay_interaction_result",
            PET_OVERLAY_WINDOW_LABEL,
        )
        .is_err());
        assert!(validate_pet_overlay_command_caller_for_command(
            "desktop_pet_overlay_show_main_window",
            PET_OVERLAY_WINDOW_LABEL,
        )
        .is_ok());
        assert!(validate_pet_overlay_command_caller_for_command(
            "desktop_pet_overlay_show_main_window",
            "main",
        )
        .is_err());
    }

    #[test]
    fn pet_overlay_uses_a_dedicated_capability_instead_of_the_main_default_scope() {
        let default_capability = read_capability_file("default.json");
        assert_eq!(default_capability["windows"], json!(["main"]));

        let overlay_capability = read_capability_file("pet_overlay.json");
        assert_eq!(overlay_capability["windows"], json!(["pet_overlay"]));

        let permissions = overlay_capability["permissions"]
            .as_array()
            .expect("overlay capability permissions should be an array");

        assert!(permissions.contains(&Value::String("core:default".to_string())));
        for required_permission in [
            "allow-desktop-pet-overlay-read-window-state",
            "allow-desktop-pet-overlay-start-drag-session",
            "allow-desktop-pet-overlay-apply-drag-delta",
            "allow-desktop-pet-overlay-release-drag-velocity",
            "allow-desktop-pet-overlay-apply-momentum-delta",
            "allow-desktop-pet-overlay-end-drag-session",
            "allow-desktop-pet-overlay-sync-element-metrics",
            "allow-desktop-pet-overlay-show-main-window",
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
            "allow-desktop-install-update",
            "allow-desktop-pick-ssh-identity-file",
            "allow-desktop-set-autostart-enabled",
            "allow-start-system-task",
            "allow-cancel-system-task",
            "allow-respond-system-task-prompt",
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
            "allow-sync-desktop-pet-overlay-state",
            "allow-desktop-pet-overlay-read-window-state",
            "allow-desktop-pet-overlay-set-input-locked",
            "allow-desktop-pet-overlay-reset-position",
            "allow-emit-desktop-pet-overlay-interaction-result",
            "allow-start-system-task",
            "allow-cancel-system-task",
            "allow-get-system-task-snapshot",
            "allow-system-tasks-open-log-path",
            "allow-respond-system-task-prompt",
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
            "allow-desktop-install-update",
            "allow-desktop-pick-ssh-identity-file",
            "allow-desktop-set-autostart-enabled",
            "allow-sync-desktop-pet-overlay-state",
            "allow-desktop-pet-overlay-sync-element-metrics",
            "allow-desktop-pet-overlay-apply-momentum-delta",
            "allow-desktop-pet-overlay-show-main-window",
            "allow-start-system-task",
            "allow-respond-system-task-prompt",
        ] {
            assert!(
                permissions.contains_key(permission),
                "generated app acl manifest should include {permission}",
            );
        }
    }

    #[test]
    fn stable_and_publicdev_tauri_configs_include_the_pet_overlay_capability() {
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
                capabilities.contains(&Value::String("pet_overlay".to_string())),
                "{config_name} should include the pet_overlay capability for the overlay window",
            );
        }
    }

    #[test]
    fn caps_release_velocity_to_the_native_momentum_limit() {
        let (vx, vy) = cap_velocity(3_200.0, 0.0);

        assert_eq!(vx, PET_VELOCITY_MAX_MAGNITUDE_PX_PER_S);
        assert_eq!(vy, 0.0);
    }

    #[test]
    fn resolves_bounded_momentum_deltas_from_the_native_constants() {
        let deltas = resolve_pet_overlay_momentum_deltas(3_200.0, 0.0);
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
    fn resolves_momentum_plan_from_the_native_constants() {
        let plan = resolve_pet_overlay_momentum_plan(17, (3_200.0, 0.0));

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
        let source = read_pet_overlay_source_file();
        let production_source = source
            .split("#[cfg(test)]")
            .next()
            .expect("pet overlay source should contain production code before tests");

        assert!(
            production_source.contains("resolve_pet_overlay_momentum_plan(generation, velocity)"),
            "release velocity should return a scheduled momentum plan",
        );
        assert!(
            !production_source.contains("spawn_pet_overlay_momentum"),
            "release velocity must not spawn native momentum work with non-Send Tauri handles",
        );
    }

    #[test]
    fn overlay_interaction_commands_require_a_visible_enabled_payload() {
        let mut runtime_state = DesktopPetOverlayRuntimeState::default();

        runtime_state.last_sync_payload = Some(DesktopPetOverlaySyncPayload {
            visible: false,
            expanded: false,
            window: DesktopPetOverlaySizePayload {
                width: 192.0,
                height: 208.0,
            },
            policy: DesktopPetOverlayPolicyPayload {
                enabled: true,
                always_on_top: true,
                anchor: placement::DesktopPetOverlayAnchor::BottomRight,
                input_locked: false,
            },
        });
        assert_eq!(
            require_enabled_overlay_interaction(&runtime_state),
            Err("Desktop pet overlay is disabled".to_string()),
        );

        runtime_state.last_sync_payload = Some(DesktopPetOverlaySyncPayload {
            visible: true,
            expanded: false,
            window: DesktopPetOverlaySizePayload {
                width: 192.0,
                height: 208.0,
            },
            policy: DesktopPetOverlayPolicyPayload {
                enabled: false,
                always_on_top: true,
                anchor: placement::DesktopPetOverlayAnchor::BottomRight,
                input_locked: false,
            },
        });
        assert_eq!(
            require_enabled_overlay_interaction(&runtime_state),
            Err("Desktop pet overlay is disabled".to_string()),
        );

        runtime_state.last_sync_payload = Some(DesktopPetOverlaySyncPayload {
            visible: true,
            expanded: false,
            window: DesktopPetOverlaySizePayload {
                width: 192.0,
                height: 208.0,
            },
            policy: DesktopPetOverlayPolicyPayload {
                enabled: true,
                always_on_top: true,
                anchor: placement::DesktopPetOverlayAnchor::BottomRight,
                input_locked: false,
            },
        });
        assert_eq!(require_enabled_overlay_interaction(&runtime_state), Ok(()));
    }

    #[test]
    fn drag_delta_retargets_monitor_from_desired_window_position() {
        let payload = sync_payload_with_input_lock(false);
        let window_state = DesktopPetOverlayWindowStatePayload {
            visible: true,
            input_locked: false,
            monitor_id: Some("left".to_string()),
            logical_position: LogicalPointPayload { x: 688.0, y: 488.0 },
            logical_size: DesktopPetOverlaySizePayload {
                width: 100.0,
                height: 100.0,
            },
            scale_factor: 1.0,
            last_placement_recovery_code: None,
            placement_diagnostics: None,
            layout: None,
        };
        let monitors = vec![
            DesktopPetOverlayMonitorRect {
                id: "left".to_string(),
                rect: Rect {
                    x: 0.0,
                    y: 0.0,
                    width: 800.0,
                    height: 600.0,
                },
            },
            DesktopPetOverlayMonitorRect {
                id: "right".to_string(),
                rect: Rect {
                    x: 800.0,
                    y: 0.0,
                    width: 800.0,
                    height: 600.0,
                },
            },
        ];

        let next = resolve_drag_offset_after_window_delta_for_monitors(
            &monitors,
            &payload,
            Some(&window_state),
            160.0,
            -108.0,
        )
        .expect("drag should resolve a target monitor");

        assert_eq!(next.monitor_id, Some("right".to_string()));
        assert_eq!(next.x, -652.0);
        assert_eq!(next.y, -120.0);
    }

    #[test]
    fn drag_interaction_commands_reject_locked_overlay_input() {
        let mut runtime_state = DesktopPetOverlayRuntimeState::default();
        runtime_state.last_sync_payload = Some(sync_payload_with_input_lock(true));

        assert_eq!(
            require_enabled_overlay_interaction(&runtime_state),
            Err("Desktop pet overlay drag interaction is locked".to_string()),
        );

        runtime_state.last_sync_payload = Some(sync_payload_with_input_lock(false));
        assert_eq!(require_enabled_overlay_interaction(&runtime_state), Ok(()));
    }

    #[test]
    fn show_main_window_preserves_focus_payload_through_the_native_layer() {
        let source_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("src")
            .join("pet_overlay.rs");
        let source = fs::read_to_string(&source_path).unwrap_or_else(|error| {
            panic!(
                "failed to read pet overlay source {}: {error}",
                source_path.display()
            )
        });

        assert!(
            source.contains("desktop_pet_overlay_show_main_window_requested"),
            "native show-main-window handler should expose a dedicated focus-request event for the main window",
        );
        assert!(
            source.contains(".emit(PET_OVERLAY_SHOW_MAIN_WINDOW_REQUESTED_EVENT, payload.clone())")
                || source.contains(".emit(\"desktop_pet_overlay_show_main_window_requested\", payload.clone())")
                || source.contains(".emit_to(MAIN_WINDOW_LABEL, \"desktop_pet_overlay_show_main_window_requested\", payload.clone())"),
            "native show-main-window handler should forward the original payload instead of discarding it",
        );
    }
}
