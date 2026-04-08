#[cfg(desktop)]
use serde::{Deserialize, Serialize};

#[cfg(desktop)]
use std::sync::{Arc, Mutex};

#[cfg(desktop)]
use tauri::{
    App, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, State, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

#[cfg(desktop)]
mod placement;
#[cfg(desktop)]
mod host_mode;
#[cfg(desktop)]
mod host_window;
#[cfg(desktop)]
mod panel_host;
#[cfg(desktop)]
mod macos_display_context;
#[cfg(desktop)]
mod storage;

#[cfg(desktop)]
use self::host_mode::{
    resolve_desktop_activity_overlay_host_mode, resolve_overlay_placement_for_host_mode,
    DesktopActivityOverlayDisplayContext, DesktopActivityOverlayHostMode,
};
#[cfg(desktop)]
use self::host_window::{
    apply_macos_overlay_activation_policy,
    apply_macos_overlay_window_collection_behavior,
    resolve_macos_overlay_window_builder_defaults,
    resolve_macos_overlay_window_host_settings,
    should_apply_raw_macos_overlay_window_collection_behavior,
};
#[cfg(desktop)]
use self::panel_host::{apply_macos_overlay_panel_host, apply_macos_overlay_panel_position};
#[cfg(desktop)]
use self::macos_display_context::resolve_overlay_display_context_for_monitor;
#[cfg(desktop)]
use self::placement::{
    clamp, resolve_overlay_anchor_monitor_resolution_for_placement_mode, sanitize_dimension,
    sanitize_offset,
    DesktopActivityOverlayMonitorSource, OverlayPlacementRect, Rect,
    ResolvedOverlayAnchorMonitorRect,
};
#[cfg(desktop)]
use self::storage::{
    clear_persisted_drag_offsets, persist_drag_offsets, read_persisted_drag_offsets,
    resolve_drag_offsets_path, sanitize_drag_offsets, PersistedOverlayDragOffsets,
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
const OVERLAY_SAFE_PADDING_PX: f64 = 12.0;

// Keep the parked overlay far outside the monitor bounds so it remains "shown" (CDP target alive)
// without being user-visible.
#[cfg(desktop)]
const OVERLAY_PARK_OFFSCREEN_DISTANCE_PX: f64 = 10_000.0;

#[cfg(desktop)]
fn resolve_monitor_logical_scale_factor(monitor_scale_factor: f64, fallback_scale_factor: f64) -> f64 {
    let monitor_scale_factor = if monitor_scale_factor.is_finite() && monitor_scale_factor > 0.000_1 {
        monitor_scale_factor
    } else {
        fallback_scale_factor
    };
    monitor_scale_factor.max(0.000_1)
}

#[cfg(desktop)]
fn logical_rect_from_physical_bounds(
    position_x: i32,
    position_y: i32,
    width: u32,
    height: u32,
    scale_factor: f64,
) -> Rect {
    Rect {
        x: position_x as f64 / scale_factor,
        y: position_y as f64 / scale_factor,
        width: width as f64 / scale_factor,
        height: height as f64 / scale_factor,
    }
}

#[cfg(desktop)]
fn monitor_to_logical_rect(monitor: &tauri::Monitor, fallback_scale_factor: f64) -> Rect {
    logical_rect_from_physical_bounds(
        monitor.position().x,
        monitor.position().y,
        monitor.size().width,
        monitor.size().height,
        resolve_monitor_logical_scale_factor(monitor.scale_factor(), fallback_scale_factor),
    )
}

#[cfg(desktop)]
fn resolve_anchor_monitor_resolution<R: Runtime>(
    app: &AppHandle<R>,
    overlay_window: &WebviewWindow<R>,
    placement_mode: DesktopActivityOverlayPlacementMode,
) -> Result<ResolvedOverlayAnchorMonitorRect, String> {
    // Tauri monitor position/size are physical pixels; window position/size below is expressed in
    // logical pixels. If we don't normalize, the overlay anchor math will drift (notably on Retina),
    // making "top_center" look like "top_right".
    let overlay_scale_factor = overlay_window.scale_factor().unwrap_or(1.0).max(0.000_1);
    let main_window = app.get_webview_window(MAIN_WINDOW_LABEL);
    let main_scale_factor = main_window
        .as_ref()
        .and_then(|window| window.scale_factor().ok())
        .unwrap_or(overlay_scale_factor)
        .max(0.000_1);

    let main_window_monitor = main_window
        .and_then(|window| window.current_monitor().ok().flatten())
        .map(|monitor| monitor_to_logical_rect(&monitor, main_scale_factor));
    let overlay_window_monitor = overlay_window
        .current_monitor()
        .map_err(|error| error.to_string())?
        .map(|monitor| monitor_to_logical_rect(&monitor, overlay_scale_factor));
    let primary_monitor = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .and_then(|window| {
            let scale_factor = window.scale_factor().unwrap_or(overlay_scale_factor).max(0.000_1);
            window
                .primary_monitor()
                .ok()
                .flatten()
                .map(|monitor| monitor_to_logical_rect(&monitor, scale_factor))
        })
        .or_else(|| {
            overlay_window
                .primary_monitor()
                .ok()
                .flatten()
                .map(|monitor| monitor_to_logical_rect(&monitor, overlay_scale_factor))
        });

    resolve_overlay_anchor_monitor_resolution_for_placement_mode(
        placement_mode,
        main_window_monitor,
        overlay_window_monitor,
        primary_monitor,
    )
}

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
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityOverlayPlacementDiagnosticsPayload {
    pub monitor_source: DesktopActivityOverlayMonitorSource,
    pub effective_monitor: Rect,
    pub anchor: DesktopActivityOverlayAnchor,
    pub placement_mode: DesktopActivityOverlayPlacementMode,
    pub host_mode: DesktopActivityOverlayHostMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_context: Option<DesktopActivityOverlayDisplayContext>,
    pub effective_offset_x: f64,
    pub effective_offset_y: f64,
    pub computed_position: OverlayPlacementRect,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub applied_native_frame: Option<Rect>,
}

#[cfg(desktop)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopActivityOverlayWindowDimensionsPayload {
    pub collapsed: DesktopActivityOverlayDimensionsPayload,
    pub expanded: DesktopActivityOverlayDimensionsPayload,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
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
    pub action_identifier: String,
    #[serde(default)]
    pub data: serde_json::Value,
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
pub fn register<R: Runtime>(app: &mut App<R>) -> tauri::Result<()> {
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
    Ok(())
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
        let mut next_payload = payload;
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        ensure_drag_offsets_loaded(&app, &mut guard);
        apply_desired_expanded_override(&mut guard, &mut next_payload);
        guard.last_sync_payload = Some(next_payload.clone());
    }

    apply_overlay_state(&app, &state)
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
        if let Some(payload) = guard.last_sync_payload.as_mut() {
            payload.expanded = expanded;
        } else {
            // `set_expanded` can be invoked before the first sync payload arrives (for example via
            // hotkey or automated QA). Persist the desired state so the next sync can apply it.
            guard.desired_expanded = Some(expanded);
        }
    }
    apply_overlay_state(&app, &state)
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
        let allow_drag = guard
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
            .unwrap_or(false);
        if !allow_drag {
            return Ok(());
        }

        guard.drag_offsets.offset_x = clamp(guard.drag_offsets.offset_x + delta_x, -4096.0, 4096.0);
        guard.drag_offsets.offset_y = clamp(guard.drag_offsets.offset_y + delta_y, -4096.0, 4096.0);
        persist_drag_offsets(&app, guard.drag_offsets);
    }

    apply_overlay_state(&app, &state)
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
    }
    clear_persisted_drag_offsets(&app);

    apply_overlay_state(&app, &state)
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
        &[OVERLAY_WINDOW_LABEL],
    )?;

    app.emit_to(MAIN_WINDOW_LABEL, OVERLAY_INTERACTION_EVENT, payload)
        .map_err(|error| error.to_string())
}

#[cfg(desktop)]
fn apply_overlay_state<R: Runtime>(
    app: &AppHandle<R>,
    state: &State<'_, ActivityOverlayState>,
) -> Result<(), String> {
    let (payload, drag_offsets) = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        let payload = guard.last_sync_payload.clone();
        let drag_offsets = guard.drag_offsets;
        (payload, drag_offsets)
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
        guard.last_window_state = Some(DesktopActivityOverlayWindowStatePayload::from_sync_payload(
            &payload,
            None,
        ));
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
    let dimensions = if payload.expanded {
        payload.window.expanded
    } else {
        payload.window.collapsed
    };

    let width = sanitize_dimension(dimensions.width, 340.0, 1.0, 4096.0);
    let height = sanitize_dimension(dimensions.height, 72.0, 1.0, 4096.0);
    let monitor_resolution = resolve_anchor_monitor_resolution(app, &window, payload.policy.placement_mode)?;
    let monitor = monitor_resolution.rect;
    let (offset_x, offset_y) = resolve_effective_overlay_offsets(&payload.policy, drag_offsets);
    let display_context = resolve_overlay_display_context_for_monitor(&app, monitor);
    let host_mode = resolve_desktop_activity_overlay_host_mode(
        payload.policy.presentation_mode,
        payload.policy.placement_mode,
        payload.policy.anchor,
        display_context.clone(),
    );
    window
        .set_always_on_top(resolve_overlay_tauri_always_on_top(
            payload.policy.always_on_top,
            host_mode,
        ))
        .map_err(|error| error.to_string())?;
    apply_overlay_host_window_settings(&window, host_mode, display_context.clone())?;
    let placement = resolve_overlay_placement_for_host_mode(
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

    let applied_native_frame = apply_macos_overlay_panel_position(
        &window,
        host_mode,
        display_context.clone(),
        placement,
        width,
        height,
    )?;
    if applied_native_frame.is_none() {
        window
            .set_size(LogicalSize::new(width, height))
            .map_err(|error| error.to_string())?;
        window
            .set_position(LogicalPosition::new(placement.x, placement.y))
            .map_err(|error| error.to_string())?;
    }
    window.show().map_err(|error| error.to_string())?;

    let window_state = DesktopActivityOverlayWindowStatePayload::from_sync_payload(
        &payload,
        Some(build_overlay_placement_diagnostics(
            monitor_resolution,
            placement,
            payload.policy.anchor,
            payload.policy.placement_mode,
            host_mode,
            display_context,
            offset_x,
            offset_y,
            applied_native_frame,
        )),
    );
    let _ = window.emit(OVERLAY_STATE_EVENT, window_state.clone());

    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
    guard.last_window_state = Some(window_state);
    Ok(())
}

#[cfg(desktop)]
fn apply_overlay_host_window_settings<R: Runtime>(
    window: &WebviewWindow<R>,
    host_mode: DesktopActivityOverlayHostMode,
    display_context: Option<DesktopActivityOverlayDisplayContext>,
) -> Result<(), String> {
    let Some(settings) = resolve_macos_overlay_window_host_settings(host_mode, display_context)
    else {
        return Ok(());
    };

    apply_macos_overlay_activation_policy(window.app_handle(), settings)?;
    window
        .set_visible_on_all_workspaces(settings.visible_on_all_workspaces)
        .map_err(|error| error.to_string())?;
    window
        .set_shadow(settings.shadow)
        .map_err(|error| error.to_string())?;
    apply_macos_overlay_panel_host(window, settings)?;
    if should_apply_raw_macos_overlay_window_collection_behavior(settings) {
        apply_macos_overlay_window_collection_behavior(window, settings)?;
    }
    Ok(())
}

#[cfg(desktop)]
fn resolve_overlay_tauri_always_on_top(
    policy_always_on_top: bool,
    host_mode: DesktopActivityOverlayHostMode,
) -> bool {
    policy_always_on_top && !matches!(host_mode, DesktopActivityOverlayHostMode::NotchIntegrated)
}

#[cfg(desktop)]
fn apply_desired_expanded_override(
    state: &mut ActivityOverlayRuntimeState,
    payload: &mut DesktopActivityOverlaySyncPayload,
) {
    let Some(desired) = state.desired_expanded else {
        return;
    };

    payload.expanded = desired;
    // Apply once: subsequent sync updates already carry the real runtime expanded state.
    state.desired_expanded = None;
}

#[cfg(desktop)]
fn build_overlay_placement_diagnostics(
    monitor_resolution: ResolvedOverlayAnchorMonitorRect,
    placement: OverlayPlacementRect,
    anchor: DesktopActivityOverlayAnchor,
    placement_mode: DesktopActivityOverlayPlacementMode,
    host_mode: DesktopActivityOverlayHostMode,
    display_context: Option<DesktopActivityOverlayDisplayContext>,
    effective_offset_x: f64,
    effective_offset_y: f64,
    applied_native_frame: Option<Rect>,
) -> DesktopActivityOverlayPlacementDiagnosticsPayload {
    DesktopActivityOverlayPlacementDiagnosticsPayload {
        monitor_source: monitor_resolution.source,
        effective_monitor: monitor_resolution.rect,
        anchor,
        placement_mode,
        host_mode,
        display_context,
        effective_offset_x,
        effective_offset_y,
        computed_position: placement,
        applied_native_frame,
    }
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
fn park_overlay_window_offscreen<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    // Avoid failures when the OS temporarily can't resolve monitors (for example during startup).
    let monitor_rect = resolve_parking_monitor_rect(app, window);

    let base_x = if monitor_rect.width > 0.0 {
        monitor_rect.x + monitor_rect.width
    } else {
        monitor_rect.x
    };
    let base_y = if monitor_rect.height > 0.0 {
        monitor_rect.y + monitor_rect.height
    } else {
        monitor_rect.y
    };

    // Keep the window extremely small even if the OS clamps position back onto a visible monitor.
    window
        .set_size(LogicalSize::new(1.0, 1.0))
        .map_err(|error| error.to_string())?;
    window
        .set_position(LogicalPosition::new(
            base_x + OVERLAY_PARK_OFFSCREEN_DISTANCE_PX,
            base_y + OVERLAY_PARK_OFFSCREEN_DISTANCE_PX,
        ))
        .map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())
}

#[cfg(desktop)]
fn resolve_parking_monitor_rect<R: Runtime>(
    app: &AppHandle<R>,
    overlay_window: &WebviewWindow<R>,
) -> Rect {
    let overlay_scale_factor = overlay_window.scale_factor().unwrap_or(1.0).max(0.000_1);

    let from_overlay = overlay_window
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor_to_logical_rect(&monitor, overlay_scale_factor));

    let from_main = app
        .get_webview_window(MAIN_WINDOW_LABEL)
        .and_then(|main| {
            let main_scale_factor = main
                .scale_factor()
                .unwrap_or(overlay_scale_factor)
                .max(0.000_1);
            main.primary_monitor()
                .ok()
                .flatten()
                .map(|monitor| monitor_to_logical_rect(&monitor, main_scale_factor))
        });

    from_main
        .or(from_overlay)
        .unwrap_or(Rect {
            x: 0.0,
            y: 0.0,
            width: 0.0,
            height: 0.0,
        })
}

#[cfg(desktop)]
fn ensure_overlay_window<R: Runtime>(
    app: &AppHandle<R>,
    always_on_top: bool,
) -> Result<WebviewWindow<R>, String> {
    if let Some(window) = app.get_webview_window(OVERLAY_WINDOW_LABEL) {
        return Ok(window);
    }

    let builder = WebviewWindowBuilder::new(
        app,
        OVERLAY_WINDOW_LABEL,
        WebviewUrl::App(OVERLAY_WINDOW_ROUTE.into()),
    )
    .title("Happier Activity Overlay")
    .decorations(false)
    .resizable(false)
    .always_on_top(always_on_top)
    .transparent(true)
    .visible(false)
    .skip_taskbar(true);

    #[cfg(target_os = "macos")]
    let builder = if let Some(defaults) = resolve_macos_overlay_window_builder_defaults(true) {
        builder
            .accept_first_mouse(defaults.accept_first_mouse)
            .title_bar_style(defaults.title_bar_style)
            .hidden_title(defaults.hidden_title)
            .shadow(defaults.shadow)
    } else {
        builder
    };

    let window = builder.build().map_err(|error| error.to_string())?;
    navigate_overlay_window_to_route(&window)?;
    Ok(window)
}

#[cfg(desktop)]
fn build_overlay_window_navigation_url(current_url: &tauri::Url) -> Result<tauri::Url, String> {
    let mut next = current_url.clone();
    next.set_path("/desktop/activity-overlay");
    next.set_query(Some("desktopOverlayWindow=1"));
    Ok(next)
}

#[cfg(desktop)]
fn navigate_overlay_window_to_route<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let current_url = window.url().map_err(|error| error.to_string())?;
    let target_url = build_overlay_window_navigation_url(&current_url)?;
    if current_url.as_str() == target_url.as_str() {
        return Ok(());
    }

    window.navigate(target_url).map_err(|error| error.to_string())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_overlay_command_caller_against_allowed_labels() {
        let command_name = "desktop_activity_overlay_sync";
        assert!(validate_overlay_command_caller(command_name, "main", &["main"]).is_ok());
        assert!(
            validate_overlay_command_caller(command_name, "activity_overlay", &["main"]).is_err()
        );
    }

    #[test]
    fn builds_the_overlay_window_navigation_url_with_the_overlay_route_and_marker() {
        let current_url = tauri::Url::parse("http://localhost:8081/").expect("valid url");
        let next_url = build_overlay_window_navigation_url(&current_url).expect("expected overlay url");

        assert_eq!(
            next_url.as_str(),
            "http://localhost:8081/desktop/activity-overlay?desktopOverlayWindow=1"
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
            None,
            12.0,
            -8.0,
            None,
        );

        assert_eq!(diagnostics.monitor_source, DesktopActivityOverlayMonitorSource::OverlayWindow);
        assert!((diagnostics.effective_monitor.x - 3000.0).abs() < 0.001);
        assert_eq!(diagnostics.anchor, DesktopActivityOverlayAnchor::TopCenter);
        assert_eq!(diagnostics.placement_mode, DesktopActivityOverlayPlacementMode::Custom);
        assert_eq!(diagnostics.host_mode, DesktopActivityOverlayHostMode::Floating);
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
            None,
            0.0,
            0.0,
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
            Some(display_context),
            0.0,
            0.0,
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
    fn applies_desired_expanded_override_on_first_sync_and_clears_it() {
        let mut state = ActivityOverlayRuntimeState {
            last_sync_payload: None,
            last_window_state: None,
            desired_expanded: Some(true),
            drag_offsets: PersistedOverlayDragOffsets::default(),
            drag_offsets_loaded: true,
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
        assert_eq!(state.desired_expanded, None);
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
