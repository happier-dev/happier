#[cfg(desktop)]
use serde::{Deserialize, Serialize};

#[cfg(desktop)]
use std::sync::{Arc, Mutex};

#[cfg(desktop)]
use tauri::{
    App, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, State, WebviewWindow,
};

#[cfg(desktop)]
mod diagnostics;
#[cfg(desktop)]
mod host_mode;
#[cfg(desktop)]
mod host_window;
#[cfg(desktop)]
mod macos_display_context;
#[cfg(desktop)]
mod monitor_resolution;
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
use self::host_mode::{
    resolve_desktop_activity_overlay_host_mode_resolution, resolve_overlay_placement_for_host_mode,
    DesktopActivityOverlayDisplayContext, DesktopActivityOverlayHostMode,
};
#[cfg(desktop)]
use self::host_window::{
    apply_macos_overlay_activation_policy, apply_macos_overlay_window_collection_behavior,
    resolve_macos_overlay_window_host_settings,
    should_apply_raw_macos_overlay_window_collection_behavior,
};
#[cfg(desktop)]
use self::macos_display_context::resolve_overlay_display_context_for_monitor;
#[cfg(desktop)]
use self::monitor_resolution::resolve_anchor_monitor_resolution;
#[cfg(desktop)]
use self::panel_host::{apply_macos_overlay_panel_host, apply_macos_overlay_panel_position};
#[cfg(desktop)]
use self::placement::{clamp, sanitize_dimension, sanitize_offset, Rect};
#[cfg(desktop)]
use self::storage::{
    clear_persisted_drag_offsets, persist_drag_offsets, read_persisted_drag_offsets,
    resolve_drag_offsets_path, sanitize_drag_offsets, PersistedOverlayDragOffsets,
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
const OVERLAY_SAFE_PADDING_PX: f64 = 12.0;

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
    last_display_context: Option<DesktopActivityOverlayDisplayContext>,
    runtime_host_fallback: Option<ActivityOverlayRuntimeHostFallback>,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, PartialEq)]
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
    let (payload, drag_offsets, cached_display_context, runtime_host_fallback) = {
        let guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        let payload = guard.last_sync_payload.clone();
        let drag_offsets = guard.drag_offsets;
        (
            payload,
            drag_offsets,
            guard.last_display_context,
            guard.runtime_host_fallback,
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
    let dimensions = if payload.expanded {
        payload.window.expanded
    } else {
        payload.window.collapsed
    };

    let width = sanitize_dimension(dimensions.width, 340.0, 1.0, 4096.0);
    let height = sanitize_dimension(dimensions.height, 72.0, 1.0, 4096.0);
    let monitor_resolution =
        resolve_anchor_monitor_resolution(app, &window, payload.policy.placement_mode)?;
    let monitor = monitor_resolution.rect;
    let (offset_x, offset_y) = resolve_effective_overlay_offsets(&payload.policy, drag_offsets);
    let display_context = resolve_effective_overlay_display_context(
        resolve_overlay_display_context_for_monitor(app, monitor),
        cached_display_context,
        monitor,
    );
    let mut host_mode_resolution = resolve_desktop_activity_overlay_host_mode_resolution(
        payload.policy.presentation_mode,
        payload.policy.placement_mode,
        payload.policy.anchor,
        display_context.clone(),
    );
    host_mode_resolution = resolve_host_mode_resolution_with_runtime_fallback(
        host_mode_resolution,
        runtime_host_fallback,
        display_context,
    );
    let mut host_mode = host_mode_resolution.effective_mode;
    let mut next_runtime_host_fallback =
        if matches!(
            host_mode_resolution.requested_mode,
            DesktopActivityOverlayHostMode::NotchIntegrated
        ) {
            runtime_host_fallback.filter(|fallback| {
                runtime_host_fallback_matches_display_context(*fallback, display_context)
            })
        } else {
            None
        };
    let mut native_host_path =
        match apply_overlay_host_window_settings(&window, host_mode, display_context.clone()) {
            Ok(path) => path,
            Err(error) if matches!(host_mode, DesktopActivityOverlayHostMode::NotchIntegrated) => {
                let _ = error;
                host_mode_resolution = host_mode_resolution.with_runtime_fallback(
                    DesktopActivityOverlayHostFallbackReason::PanelHostApplyFailed,
                );
                host_mode = host_mode_resolution.effective_mode;
                next_runtime_host_fallback = build_runtime_host_fallback(
                    display_context,
                    DesktopActivityOverlayHostFallbackReason::PanelHostApplyFailed,
                );
                apply_overlay_host_window_settings(&window, host_mode, display_context.clone())?
            }
            Err(error) => return Err(error),
        };

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
                    display_context,
                    DesktopActivityOverlayHostFallbackReason::PanelPositionUnavailable,
                );
                native_host_path = apply_overlay_host_window_settings(
                    &window,
                    host_mode,
                    display_context.clone(),
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
        &payload,
        Some(build_overlay_placement_diagnostics(
            monitor_resolution,
            placement,
            payload.policy.anchor,
            payload.policy.placement_mode,
            host_mode_resolution.requested_mode,
            host_mode,
            host_mode_resolution.fallback_reason,
            display_context,
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
) -> Result<DesktopActivityOverlayNativeHostPath, String> {
    let Some(settings) = resolve_macos_overlay_window_host_settings(host_mode, display_context)
    else {
        return Ok(DesktopActivityOverlayNativeHostPath::Window);
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

    payload.expanded = desired;
    // Apply once: subsequent sync updates already carry the real runtime expanded state.
    state.desired_expanded = None;
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
    runtime_fallback: Option<ActivityOverlayRuntimeHostFallback>,
    display_context: Option<DesktopActivityOverlayDisplayContext>,
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
    runtime_fallback: ActivityOverlayRuntimeHostFallback,
    display_context: Option<DesktopActivityOverlayDisplayContext>,
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
        let next_url =
            build_overlay_window_navigation_url(&current_url).expect("expected overlay url");

        assert_eq!(
            next_url.as_str(),
            "http://localhost:8081/desktop/activity-overlay?desktopOverlayWindow=1"
        );
    }

    #[test]
    fn builds_the_overlay_window_navigation_url_preserving_existing_server_scope() {
        let current_url = tauri::Url::parse(
            "http://localhost:8081/?server=http%3A%2F%2F127.0.0.1%3A3009",
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
            DesktopActivityOverlayHostMode::NotchIntegrated,
            None,
            Some(display_context),
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
            Some(display_context),
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
                display_context.screen_frame,
            ),
            Some(display_context),
        );
    }

    #[test]
    fn drops_last_display_context_when_monitor_changes() {
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
            Some(display_context),
        );
        let runtime_fallback = ActivityOverlayRuntimeHostFallback {
            display_context,
            reason: DesktopActivityOverlayHostFallbackReason::PanelPositionUnavailable,
        };

        let sticky_resolution = resolve_host_mode_resolution_with_runtime_fallback(
            resolution,
            Some(runtime_fallback),
            Some(display_context),
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
            ..original_context
        };
        let resolution = resolve_desktop_activity_overlay_host_mode_resolution(
            DesktopActivityOverlayPresentationMode::Automatic,
            DesktopActivityOverlayPlacementMode::Anchored,
            DesktopActivityOverlayAnchor::TopCenter,
            Some(next_context),
        );
        let runtime_fallback = ActivityOverlayRuntimeHostFallback {
            display_context: original_context,
            reason: DesktopActivityOverlayHostFallbackReason::PanelPositionUnavailable,
        };

        let sticky_resolution = resolve_host_mode_resolution_with_runtime_fallback(
            resolution,
            Some(runtime_fallback),
            Some(next_context),
        );

        assert_eq!(
            sticky_resolution.effective_mode,
            DesktopActivityOverlayHostMode::NotchIntegrated,
        );
        assert_eq!(sticky_resolution.fallback_reason, None);
    }

    #[test]
    fn applies_desired_expanded_override_on_first_sync_and_clears_it() {
        let mut state = ActivityOverlayRuntimeState {
            last_sync_payload: None,
            last_window_state: None,
            desired_expanded: Some(true),
            drag_offsets: PersistedOverlayDragOffsets::default(),
            drag_offsets_loaded: true,
            last_display_context: None,
            runtime_host_fallback: None,
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
