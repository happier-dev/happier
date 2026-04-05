#[cfg(desktop)]
use serde::{Deserialize, Serialize};

#[cfg(desktop)]
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[cfg(desktop)]
use tauri::{
    path::BaseDirectory,
    App,
    AppHandle,
    Emitter,
    LogicalPosition,
    LogicalSize,
    Manager,
    Runtime,
    State,
    WebviewUrl,
    WebviewWindow,
    WebviewWindowBuilder,
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

#[cfg(desktop)]
#[derive(Clone, Default)]
pub struct ActivityOverlayState(Arc<Mutex<ActivityOverlayRuntimeState>>);

#[cfg(desktop)]
#[derive(Clone, Default)]
struct ActivityOverlayRuntimeState {
    last_sync_payload: Option<DesktopActivityOverlaySyncPayload>,
    last_window_state: Option<DesktopActivityOverlayWindowStatePayload>,
    drag_offsets: PersistedOverlayDragOffsets,
    drag_offsets_loaded: bool,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedOverlayDragOffsets {
    offset_x: f64,
    offset_y: f64,
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
}

#[cfg(desktop)]
impl DesktopActivityOverlayWindowStatePayload {
    fn from_sync_payload(payload: &DesktopActivityOverlaySyncPayload) -> Self {
        Self {
            visible: payload.visible,
            expanded: payload.expanded,
            model: payload.model.clone(),
            policy: payload.policy.clone(),
            window: payload.window.clone(),
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
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopActivityOverlayVisibilityMode {
    AttentionOnly,
    ActiveSessions,
    AlwaysWhenEnabled,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopActivityOverlayClickAction {
    ExpandOverlay,
    OpenPrimarySession,
    OpenSessions,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopActivityOverlayExpandedBehavior {
    Click,
    Hover,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopActivityOverlayDensity {
    Compact,
    Comfortable,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopActivityOverlayCompactStyle {
    Pill,
    Panel,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DesktopActivityOverlayPlacementMode {
    Anchored,
    Custom,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
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
#[derive(Clone, Copy, Debug)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug)]
struct OverlayPlacementRect {
    x: f64,
    y: f64,
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
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        ensure_drag_offsets_loaded(&app, &mut guard);
        guard.last_sync_payload = Some(payload.clone());
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

    if !payload.policy.enabled || !payload.visible {
        if let Some(window) = app.get_webview_window(OVERLAY_WINDOW_LABEL) {
            let _ = window.hide();
        }
        let mut guard = state
            .0
            .lock()
            .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
        guard.last_window_state = Some(DesktopActivityOverlayWindowStatePayload::from_sync_payload(&payload));
        return Ok(());
    }

    let window = ensure_overlay_window(app, payload.policy.always_on_top)?;
    window
        .set_always_on_top(payload.policy.always_on_top)
        .map_err(|error| error.to_string())?;

    let dimensions = if payload.expanded {
        payload.window.expanded
    } else {
        payload.window.collapsed
    };

    let width = sanitize_dimension(dimensions.width, 340.0, 1.0, 4096.0);
    let height = sanitize_dimension(dimensions.height, 72.0, 1.0, 4096.0);
    window
        .set_size(LogicalSize::new(width, height))
        .map_err(|error| error.to_string())?;

    let monitor = resolve_overlay_monitor_rect(&window)?;
    let persisted_custom_offset = if matches!(
        payload.policy.placement_mode,
        DesktopActivityOverlayPlacementMode::Custom
    ) {
        sanitize_drag_offsets(drag_offsets)
    } else {
        PersistedOverlayDragOffsets::default()
    };
    let policy_offset_x = sanitize_offset(payload.policy.offset_x);
    let policy_offset_y = sanitize_offset(payload.policy.offset_y);
    let placement = resolve_overlay_placement(
        monitor,
        Rect {
            x: 0.0,
            y: 0.0,
            width,
            height,
        },
        payload.policy.anchor,
        policy_offset_x + persisted_custom_offset.offset_x,
        policy_offset_y + persisted_custom_offset.offset_y,
        OVERLAY_SAFE_PADDING_PX,
    );

    window
        .set_position(LogicalPosition::new(placement.x, placement.y))
        .map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;

    let window_state = DesktopActivityOverlayWindowStatePayload::from_sync_payload(&payload);
    let _ = window.emit(OVERLAY_STATE_EVENT, window_state.clone());

    let mut guard = state
        .0
        .lock()
        .map_err(|_| "Desktop activity overlay state mutex poisoned".to_string())?;
    guard.last_window_state = Some(window_state);
    Ok(())
}

#[cfg(desktop)]
fn resolve_overlay_monitor_rect<R: Runtime>(window: &WebviewWindow<R>) -> Result<Rect, String> {
    if let Some(monitor) = window
        .current_monitor()
        .map_err(|error| error.to_string())?
    {
        return Ok(Rect {
            x: monitor.position().x as f64,
            y: monitor.position().y as f64,
            width: monitor.size().width as f64,
            height: monitor.size().height as f64,
        });
    }

    if let Some(monitor) = window
        .primary_monitor()
        .map_err(|error| error.to_string())?
    {
        return Ok(Rect {
            x: monitor.position().x as f64,
            y: monitor.position().y as f64,
            width: monitor.size().width as f64,
            height: monitor.size().height as f64,
        });
    }

    Err("Unable to resolve a monitor for desktop activity overlay".to_string())
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

    let window = builder.build().map_err(|error| error.to_string())?;
    Ok(window)
}

#[cfg(desktop)]
fn resolve_overlay_placement(
    monitor: Rect,
    overlay: Rect,
    anchor: DesktopActivityOverlayAnchor,
    offset_x: f64,
    offset_y: f64,
    padding: f64,
) -> OverlayPlacementRect {
    let offset_x = sanitize_offset(offset_x);
    let offset_y = sanitize_offset(offset_y);
    let center_x = monitor.x + (monitor.width - overlay.width) / 2.0;
    let center_y = monitor.y + (monitor.height - overlay.height) / 2.0;

    let (base_x, base_y) = match anchor {
        DesktopActivityOverlayAnchor::TopCenter => (center_x, monitor.y + padding),
        DesktopActivityOverlayAnchor::TopLeft => (monitor.x + padding, monitor.y + padding),
        DesktopActivityOverlayAnchor::TopRight => (
            monitor.x + monitor.width - overlay.width - padding,
            monitor.y + padding,
        ),
        DesktopActivityOverlayAnchor::BottomCenter => (
            center_x,
            monitor.y + monitor.height - overlay.height - padding,
        ),
        DesktopActivityOverlayAnchor::BottomLeft => (
            monitor.x + padding,
            monitor.y + monitor.height - overlay.height - padding,
        ),
        DesktopActivityOverlayAnchor::BottomRight => (
            monitor.x + monitor.width - overlay.width - padding,
            monitor.y + monitor.height - overlay.height - padding,
        ),
        DesktopActivityOverlayAnchor::LeftCenter => (monitor.x + padding, center_y),
        DesktopActivityOverlayAnchor::RightCenter => (
            monitor.x + monitor.width - overlay.width - padding,
            center_y,
        ),
    };

    let min_x = monitor.x + padding;
    let min_y = monitor.y + padding;
    let max_x = monitor.x + monitor.width - overlay.width - padding;
    let max_y = monitor.y + monitor.height - overlay.height - padding;

    OverlayPlacementRect {
        x: clamp(base_x + offset_x, min_x, max_x.max(min_x)),
        y: clamp(base_y + offset_y, min_y, max_y.max(min_y)),
    }
}

#[cfg(desktop)]
fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if !value.is_finite() {
        return min;
    }
    if value < min {
        return min;
    }
    if value > max {
        return max;
    }
    value
}

#[cfg(desktop)]
fn sanitize_offset(value: f64) -> f64 {
    if value.is_finite() {
        return value;
    }
    0.0
}

#[cfg(desktop)]
fn sanitize_dimension(value: f64, fallback: f64, min: f64, max: f64) -> f64 {
    let raw = if value.is_finite() { value } else { fallback };
    clamp(raw, min, max)
}

#[cfg(desktop)]
fn sanitize_drag_offsets(offsets: PersistedOverlayDragOffsets) -> PersistedOverlayDragOffsets {
    PersistedOverlayDragOffsets {
        offset_x: clamp(sanitize_offset(offsets.offset_x), -4096.0, 4096.0),
        offset_y: clamp(sanitize_offset(offsets.offset_y), -4096.0, 4096.0),
    }
}

#[cfg(desktop)]
fn resolve_drag_offsets_path<R: Runtime>(app: &impl Manager<R>) -> tauri::Result<PathBuf> {
    app.path()
        .resolve("window-state/activity-overlay-position.json", BaseDirectory::AppConfig)
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
fn read_persisted_drag_offsets(path: Option<&Path>) -> Option<PersistedOverlayDragOffsets> {
    let path = path?;
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice::<PersistedOverlayDragOffsets>(&bytes).ok()
}

#[cfg(desktop)]
fn persist_drag_offsets<R: Runtime>(app: &AppHandle<R>, offsets: PersistedOverlayDragOffsets) {
    let Ok(path) = resolve_drag_offsets_path(app) else {
        return;
    };
    persist_drag_offsets_to_path(&path, offsets);
}

#[cfg(desktop)]
fn persist_drag_offsets_to_path(path: &Path, offsets: PersistedOverlayDragOffsets) {
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let Ok(payload) = serde_json::to_vec_pretty(&sanitize_drag_offsets(offsets)) else {
        return;
    };
    let _ = fs::write(path, payload);
}

#[cfg(desktop)]
fn clear_persisted_drag_offsets<R: Runtime>(app: &AppHandle<R>) {
    let Ok(path) = resolve_drag_offsets_path(app) else {
        return;
    };
    let _ = clear_persisted_drag_offsets_path(&path);
}

#[cfg(desktop)]
fn clear_persisted_drag_offsets_path(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_top_center_overlay_placement() {
        let monitor = Rect {
            x: 0.0,
            y: 0.0,
            width: 1400.0,
            height: 900.0,
        };
        let overlay = Rect {
            x: 0.0,
            y: 0.0,
            width: 360.0,
            height: 72.0,
        };

        let placement = resolve_overlay_placement(
            monitor,
            overlay,
            DesktopActivityOverlayAnchor::TopCenter,
            12.0,
            8.0,
            10.0,
        );
        assert!((placement.x - 532.0).abs() < 0.001);
        assert!((placement.y - 18.0).abs() < 0.001);
    }

    #[test]
    fn clamps_overlay_placement_to_monitor_bounds() {
        let monitor = Rect {
            x: 100.0,
            y: 40.0,
            width: 800.0,
            height: 600.0,
        };
        let overlay = Rect {
            x: 0.0,
            y: 0.0,
            width: 520.0,
            height: 220.0,
        };

        let placement = resolve_overlay_placement(
            monitor,
            overlay,
            DesktopActivityOverlayAnchor::BottomRight,
            9999.0,
            9999.0,
            16.0,
        );
        assert!((placement.x - 364.0).abs() < 0.001);
        assert!((placement.y - 404.0).abs() < 0.001);
    }

    #[test]
    fn resolves_overlay_placement_with_non_finite_offsets() {
        let monitor = Rect {
            x: 0.0,
            y: 0.0,
            width: 1400.0,
            height: 900.0,
        };
        let overlay = Rect {
            x: 0.0,
            y: 0.0,
            width: 360.0,
            height: 72.0,
        };

        let placement = resolve_overlay_placement(
            monitor,
            overlay,
            DesktopActivityOverlayAnchor::TopCenter,
            f64::NAN,
            f64::INFINITY,
            10.0,
        );

        assert!(placement.x.is_finite());
        assert!(placement.y.is_finite());
        assert!((placement.x - 520.0).abs() < 0.001);
        assert!((placement.y - 10.0).abs() < 0.001);
    }

    #[test]
    fn validates_overlay_command_caller_against_allowed_labels() {
        let command_name = "desktop_activity_overlay_sync";
        assert!(validate_overlay_command_caller(command_name, "main", &["main"]).is_ok());
        assert!(validate_overlay_command_caller(command_name, "activity_overlay", &["main"]).is_err());
    }

    #[test]
    fn clears_persisted_drag_offsets_path_without_error_when_file_missing() {
        let unique = format!(
            "activity-overlay-position-{}-missing.json",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time should be after unix epoch")
                .as_nanos()
        );
        let path = std::env::temp_dir().join(unique);

        clear_persisted_drag_offsets_path(&path)
            .expect("clearing a missing drag-offset file should succeed");
    }

    #[test]
    fn clears_persisted_drag_offsets_path_when_file_exists() {
        let unique = format!(
            "activity-overlay-position-{}.json",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time should be after unix epoch")
                .as_nanos()
        );
        let path = std::env::temp_dir().join(unique);

        persist_drag_offsets_to_path(
            &path,
            PersistedOverlayDragOffsets {
                offset_x: 18.0,
                offset_y: -24.0,
            },
        );
        assert!(path.exists());

        clear_persisted_drag_offsets_path(&path)
            .expect("existing drag-offset file should be removed");

        assert!(!path.exists());
    }
}
