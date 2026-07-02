#[cfg(desktop)]
use serde::{Deserialize, Serialize};

#[cfg(desktop)]
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

#[cfg(desktop)]
use tauri::{
    path::BaseDirectory, App, AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition,
    PhysicalSize, Runtime, State, WindowEvent,
};

#[cfg(desktop)]
const DEFAULT_SCREEN_FRACTION: f64 = 0.85;

#[cfg(desktop)]
const MAX_WINDOW_WIDTH_PX: f64 = 1500.0;

#[cfg(desktop)]
const MAX_WINDOW_HEIGHT_PX: f64 = 860.0;

#[cfg(desktop)]
const MIN_WINDOW_WIDTH_PX: f64 = 520.0;

#[cfg(desktop)]
const MIN_WINDOW_HEIGHT_PX: f64 = 520.0;

#[cfg(desktop)]
const WRITE_DEBOUNCE: Duration = Duration::from_millis(400);

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, PartialEq)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[cfg(desktop)]
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PersistedWindowState {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    #[serde(default)]
    maximized: bool,
    #[serde(default)]
    units: PersistedWindowUnits,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum WindowMode {
    // Legacy serialized value. Pre-auth now uses the standard main-window sizing path.
    PreAuth,
    Main,
}

#[cfg(desktop)]
impl Default for WindowMode {
    fn default() -> Self {
        Self::Main
    }
}

#[cfg(desktop)]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedWindowMode {
    mode: WindowMode,
}

#[cfg(desktop)]
#[derive(Clone, Default)]
pub struct WindowSizingState {
    mode: Arc<Mutex<WindowMode>>,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
enum PersistedWindowUnits {
    Physical,
    Logical,
}

#[cfg(desktop)]
impl Default for PersistedWindowUnits {
    fn default() -> Self {
        Self::Physical
    }
}

#[cfg(desktop)]
fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if value < min {
        return min;
    }
    if value > max {
        return max;
    }
    value
}

#[cfg(desktop)]
fn compute_default_window_size(monitor: Rect) -> (f64, f64) {
    let target_width = monitor.width * DEFAULT_SCREEN_FRACTION;
    let target_height = monitor.height * DEFAULT_SCREEN_FRACTION;
    let max_width = MAX_WINDOW_WIDTH_PX.min(monitor.width).max(1.0);
    let max_height = MAX_WINDOW_HEIGHT_PX.min(monitor.height).max(1.0);
    let min_width = MIN_WINDOW_WIDTH_PX.min(max_width).min(target_width);
    let min_height = MIN_WINDOW_HEIGHT_PX.min(max_height).min(target_height);

    let width = clamp(target_width, min_width, max_width);
    let height = clamp(target_height, min_height, max_height);
    (width, height)
}

#[cfg(desktop)]
fn clamp_window_rect_to_monitor(mut rect: Rect, monitor: Rect) -> Rect {
    let max_width = MAX_WINDOW_WIDTH_PX.min(monitor.width).max(1.0);
    let max_height = MAX_WINDOW_HEIGHT_PX.min(monitor.height).max(1.0);
    let min_width = 1.0;
    let min_height = 1.0;

    rect.width = clamp(rect.width, min_width, max_width);
    rect.height = clamp(rect.height, min_height, max_height);

    let max_x = monitor.x + (monitor.width - rect.width).max(0.0);
    let max_y = monitor.y + (monitor.height - rect.height).max(0.0);

    rect.x = clamp(rect.x, monitor.x, max_x);
    rect.y = clamp(rect.y, monitor.y, max_y);
    rect
}

#[cfg(desktop)]
fn resolve_state_path<R: Runtime>(app: &App<R>) -> tauri::Result<PathBuf> {
    app.path()
        .resolve("window-state/main.json", BaseDirectory::AppConfig)
}

#[cfg(desktop)]
fn resolve_state_path_handle(app: &AppHandle) -> tauri::Result<PathBuf> {
    app.path()
        .resolve("window-state/main.json", BaseDirectory::AppConfig)
}

#[cfg(desktop)]
fn resolve_mode_path<R: Runtime>(app: &App<R>) -> tauri::Result<PathBuf> {
    app.path()
        .resolve("window-state/mode.json", BaseDirectory::AppConfig)
}

#[cfg(desktop)]
fn resolve_mode_path_handle(app: &AppHandle) -> tauri::Result<PathBuf> {
    app.path()
        .resolve("window-state/mode.json", BaseDirectory::AppConfig)
}

#[cfg(desktop)]
fn read_json(path: &Path) -> Option<PersistedWindowState> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice::<PersistedWindowState>(&bytes).ok()
}

#[cfg(desktop)]
fn read_mode(path: &Path) -> Option<WindowMode> {
    let bytes = fs::read(path).ok()?;
    let persisted = serde_json::from_slice::<PersistedWindowMode>(&bytes).ok()?;
    Some(persisted.mode)
}

#[cfg(desktop)]
fn write_json(path: &Path, state: &PersistedWindowState) {
    let parent = match path.parent() {
        Some(parent) => parent,
        None => return,
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }

    if let Ok(payload) = serde_json::to_vec_pretty(state) {
        let _ = fs::write(path, payload);
    }
}

#[cfg(desktop)]
fn write_mode(path: &Path, mode: WindowMode) {
    let parent = match path.parent() {
        Some(parent) => parent,
        None => return,
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }

    let state = PersistedWindowMode { mode };
    if let Ok(payload) = serde_json::to_vec_pretty(&state) {
        let _ = fs::write(path, payload);
    }
}

#[cfg(desktop)]
fn monitor_to_rect(monitor: &tauri::Monitor) -> Rect {
    let position = monitor.position();
    let size = monitor.size();
    Rect {
        x: position.x as f64,
        y: position.y as f64,
        width: size.width as f64,
        height: size.height as f64,
    }
}

#[cfg(desktop)]
fn physical_size_to_rect(pos: PhysicalPosition<i32>, size: PhysicalSize<u32>) -> Rect {
    Rect {
        x: pos.x as f64,
        y: pos.y as f64,
        width: size.width as f64,
        height: size.height as f64,
    }
}

#[cfg(desktop)]
fn normalize_persisted_rect_to_logical(
    persisted: &PersistedWindowState,
    scale_factor: f64,
) -> Rect {
    let scale = if scale_factor.is_finite() && scale_factor > 0.0 {
        scale_factor
    } else {
        1.0
    };
    match persisted.units {
        PersistedWindowUnits::Logical => Rect {
            x: persisted.x,
            y: persisted.y,
            width: persisted.width,
            height: persisted.height,
        },
        PersistedWindowUnits::Physical => Rect {
            x: persisted.x / scale,
            y: persisted.y / scale,
            width: persisted.width / scale,
            height: persisted.height / scale,
        },
    }
}

#[cfg(desktop)]
fn resolve_launch_window_rect(
    monitor_rect: Rect,
    persisted: Option<&PersistedWindowState>,
) -> Rect {
    if let Some(persisted) = persisted {
        return clamp_window_rect_to_monitor(
            Rect {
                x: persisted.x,
                y: persisted.y,
                width: persisted.width,
                height: persisted.height,
            },
            monitor_rect,
        );
    }

    let (width, height) = compute_default_window_size(monitor_rect);
    clamp_window_rect_to_monitor(
        Rect {
            x: monitor_rect.x + ((monitor_rect.width - width) / 2.0).max(0.0),
            y: monitor_rect.y + ((monitor_rect.height - height) / 2.0).max(0.0),
            width,
            height,
        },
        monitor_rect,
    )
}

#[cfg(desktop)]
fn resolve_initial_window_mode(
    persisted_mode: Option<WindowMode>,
    _has_main_state: bool,
) -> WindowMode {
    if let Some(mode) = persisted_mode {
        return normalize_window_mode(mode);
    }
    WindowMode::Main
}

#[cfg(desktop)]
fn normalize_window_mode(mode: WindowMode) -> WindowMode {
    match mode {
        WindowMode::Main | WindowMode::PreAuth => WindowMode::Main,
    }
}

#[cfg(desktop)]
fn apply_main_window_rect<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    monitor_logical: Rect,
    persisted: Option<PersistedWindowState>,
    scale_factor: f64,
) {
    let persisted_logical = persisted.as_ref().map(|state| {
        let rect = normalize_persisted_rect_to_logical(state, scale_factor);
        PersistedWindowState {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            maximized: state.maximized,
            units: PersistedWindowUnits::Logical,
        }
    });

    let clamped = resolve_launch_window_rect(monitor_logical, persisted_logical.as_ref());
    let _ = window.set_resizable(true);
    let _ = window.set_min_size(None::<LogicalSize<f64>>);
    let _ = window.set_max_size(None::<LogicalSize<f64>>);
    let _ = window.unmaximize();
    let _ = window.set_size(tauri::Size::Logical(LogicalSize {
        width: clamped.width.round().max(1.0),
        height: clamped.height.round().max(1.0),
    }));
    let _ = window.set_position(tauri::Position::Logical(LogicalPosition {
        x: clamped.x.round(),
        y: clamped.y.round(),
    }));

    if persisted.as_ref().is_some_and(|state| state.maximized) {
        let _ = window.maximize();
    }
}

pub fn register<R: Runtime>(app: &mut App<R>) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    let state_path = resolve_state_path(app)?;
    let mode_path = resolve_mode_path(app)?;
    let persisted = read_json(&state_path);
    let persisted_mode = read_mode(&mode_path);
    let initial_mode = resolve_initial_window_mode(persisted_mode, persisted.is_some());
    let scale_factor = window.scale_factor().unwrap_or(1.0);
    if let Ok(mut guard) = app.state::<WindowSizingState>().mode.lock() {
        *guard = initial_mode;
    }

    let monitor = window
        .current_monitor()?
        .or_else(|| window.primary_monitor().ok().flatten());

    if let Some(monitor) = monitor {
        let monitor_rect = monitor_to_rect(&monitor);

        let monitor_logical = Rect {
            x: monitor_rect.x / scale_factor,
            y: monitor_rect.y / scale_factor,
            width: monitor_rect.width / scale_factor,
            height: monitor_rect.height / scale_factor,
        };
        apply_main_window_rect(&window, monitor_logical, persisted.clone(), scale_factor);
    }

    let last_write = Arc::new(Mutex::new(Instant::now() - WRITE_DEBOUNCE));
    let state_path = Arc::new(state_path);
    let mode = app.state::<WindowSizingState>().mode.clone();
    let window_for_events = window.clone();
    window.on_window_event(move |event| {
        if !matches!(
            event,
            WindowEvent::Moved(_)
                | WindowEvent::Resized(_)
                | WindowEvent::ScaleFactorChanged { .. }
                | WindowEvent::CloseRequested { .. }
        ) {
            return;
        }

        let current_mode = match mode.lock() {
            Ok(guard) => *guard,
            Err(poisoned) => *poisoned.into_inner(),
        };
        if current_mode != WindowMode::Main {
            return;
        }

        let now = Instant::now();
        let mut guard = match last_write.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if now.duration_since(*guard) < WRITE_DEBOUNCE
            && !matches!(event, WindowEvent::CloseRequested { .. })
        {
            return;
        }
        *guard = now;

        let Ok(pos) = window_for_events.outer_position() else {
            return;
        };
        let Ok(size) = window_for_events.outer_size() else {
            return;
        };

        let rect = physical_size_to_rect(pos, size);
        let scale_factor = window_for_events.scale_factor().unwrap_or(1.0);
        let logical = Rect {
            x: rect.x / scale_factor,
            y: rect.y / scale_factor,
            width: rect.width / scale_factor,
            height: rect.height / scale_factor,
        };
        let maximized = window_for_events.is_maximized().unwrap_or(false);
        write_json(
            &state_path,
            &PersistedWindowState {
                x: logical.x,
                y: logical.y,
                width: logical.width,
                height: logical.height,
                maximized,
                units: PersistedWindowUnits::Logical,
            },
        );
    });

    // Persist the last known mode so the next launch can start at the right size with no visible jumps.
    write_mode(&mode_path, initial_mode);

    let _ = window.show();
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_set_window_mode(
    app: AppHandle,
    state: State<'_, WindowSizingState>,
    mode: WindowMode,
) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    let mode_path = resolve_mode_path_handle(&app).map_err(|e| e.to_string())?;
    let mode = normalize_window_mode(mode);
    write_mode(&mode_path, mode);

    {
        let mut guard = state
            .mode
            .lock()
            .map_err(|_| "WindowSizingState poisoned".to_string())?;
        *guard = mode;
    }

    let scale_factor = window.scale_factor().unwrap_or(1.0);
    let monitor = window
        .current_monitor()
        .map_err(|e| e.to_string())?
        .or_else(|| window.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let monitor_rect = monitor_to_rect(&monitor);
    let monitor_logical = Rect {
        x: monitor_rect.x / scale_factor,
        y: monitor_rect.y / scale_factor,
        width: monitor_rect.width / scale_factor,
        height: monitor_rect.height / scale_factor,
    };

    let state_path = resolve_state_path_handle(&app).map_err(|e| e.to_string())?;
    let persisted = read_json(&state_path);
    apply_main_window_rect(&window, monitor_logical, persisted, scale_factor);

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn resolve_initial_window_mode_ignores_legacy_preauth_persisted_value() {
        assert_eq!(
            resolve_initial_window_mode(Some(WindowMode::PreAuth), true),
            WindowMode::Main
        );
    }

    #[test]
    fn resolve_initial_window_mode_prefers_persisted_main_value() {
        assert_eq!(
            resolve_initial_window_mode(Some(WindowMode::Main), false),
            WindowMode::Main
        );
    }

    #[test]
    fn resolve_initial_window_mode_defaults_to_main_when_main_state_exists() {
        assert_eq!(resolve_initial_window_mode(None, true), WindowMode::Main);
    }

    #[test]
    fn resolve_initial_window_mode_defaults_to_main_when_no_state_exists() {
        assert_eq!(resolve_initial_window_mode(None, false), WindowMode::Main);
    }

    #[test]
    fn compute_default_window_size_respects_caps() {
        let monitor = Rect {
            x: 0.0,
            y: 0.0,
            width: 5000.0,
            height: 3000.0,
        };
        let (width, height) = compute_default_window_size(monitor);
        assert_eq!(width, MAX_WINDOW_WIDTH_PX);
        assert_eq!(height, MAX_WINDOW_HEIGHT_PX);
    }

    #[test]
    fn compute_default_window_size_prefers_screen_fraction_on_small_screens() {
        let monitor = Rect {
            x: 0.0,
            y: 0.0,
            width: 400.0,
            height: 400.0,
        };
        let (width, height) = compute_default_window_size(monitor);
        assert!((width - 340.0).abs() < 0.1, "width={width}");
        assert!((height - 340.0).abs() < 0.1, "height={height}");
    }

    #[test]
    fn compute_default_window_size_respects_minimums_on_small_screens() {
        let monitor = Rect {
            x: 0.0,
            y: 0.0,
            width: 400.0,
            height: 400.0,
        };
        let (width, height) = compute_default_window_size(monitor);
        assert!(width <= monitor.width);
        assert!(height <= monitor.height);
        assert!(width >= 1.0);
        assert!(height >= 1.0);
    }

    #[test]
    fn clamp_window_rect_to_monitor_does_not_expand_small_persisted_window() {
        let monitor = Rect {
            x: 0.0,
            y: 0.0,
            width: 1200.0,
            height: 800.0,
        };
        let rect = Rect {
            x: 10.0,
            y: 10.0,
            width: 300.0,
            height: 300.0,
        };
        let clamped = clamp_window_rect_to_monitor(rect, monitor);
        assert!(
            (clamped.width - 300.0).abs() < 0.1,
            "width={}",
            clamped.width
        );
        assert!(
            (clamped.height - 300.0).abs() < 0.1,
            "height={}",
            clamped.height
        );
    }

    #[test]
    fn clamp_window_rect_to_monitor_clamps_position_and_size() {
        let monitor = Rect {
            x: 100.0,
            y: 50.0,
            width: 800.0,
            height: 600.0,
        };
        let rect = Rect {
            x: -1000.0,
            y: 9999.0,
            width: 5000.0,
            height: 4000.0,
        };
        let clamped = clamp_window_rect_to_monitor(rect, monitor);
        assert!(clamped.width <= monitor.width);
        assert!(clamped.height <= monitor.height);
        assert!(clamped.x >= monitor.x);
        assert!(clamped.y >= monitor.y);
        assert!(clamped.x + clamped.width <= monitor.x + monitor.width + 0.01);
        assert!(clamped.y + clamped.height <= monitor.y + monitor.height + 0.01);
    }

    #[test]
    fn resolve_launch_window_rect_uses_default_size_for_fresh_launch() {
        let monitor = Rect {
            x: 20.0,
            y: 30.0,
            width: 2000.0,
            height: 1000.0,
        };
        let rect = resolve_launch_window_rect(monitor, None);
        assert!(
            (rect.width - MAX_WINDOW_WIDTH_PX).abs() < 0.1,
            "width={}",
            rect.width
        );
        assert!((rect.height - 850.0).abs() < 0.1, "height={}", rect.height);
        assert!(rect.x >= monitor.x);
        assert!(rect.y >= monitor.y);
        assert!(rect.x + rect.width <= monitor.x + monitor.width + 0.01);
        assert!(rect.y + rect.height <= monitor.y + monitor.height + 0.01);
    }

    #[test]
    fn resolve_launch_window_rect_clamps_persisted_state_to_current_monitor() {
        let monitor = Rect {
            x: 50.0,
            y: 75.0,
            width: 1200.0,
            height: 800.0,
        };
        let persisted = PersistedWindowState {
            x: -5000.0,
            y: 9999.0,
            width: 5000.0,
            height: 4000.0,
            maximized: false,
            units: PersistedWindowUnits::Logical,
        };
        let rect = resolve_launch_window_rect(monitor, Some(&persisted));
        assert!(rect.width <= monitor.width);
        assert!(rect.height <= monitor.height);
        assert!(rect.x >= monitor.x);
        assert!(rect.y >= monitor.y);
        assert!(rect.x + rect.width <= monitor.x + monitor.width + 0.01);
        assert!(rect.y + rect.height <= monitor.y + monitor.height + 0.01);
    }

    #[test]
    fn normalize_persisted_rect_to_logical_converts_physical_units() {
        let persisted: PersistedWindowState = serde_json::from_value(json!({
            "x": 200.0,
            "y": 100.0,
            "width": 2400.0,
            "height": 1600.0,
            "maximized": false
        }))
        .expect("deserialize persisted window state");

        assert_eq!(persisted.units, PersistedWindowUnits::Physical);
        let rect = normalize_persisted_rect_to_logical(&persisted, 2.0);
        assert!((rect.x - 100.0).abs() < 0.01, "x={}", rect.x);
        assert!((rect.y - 50.0).abs() < 0.01, "y={}", rect.y);
        assert!((rect.width - 1200.0).abs() < 0.01, "width={}", rect.width);
        assert!((rect.height - 800.0).abs() < 0.01, "height={}", rect.height);
    }

    #[test]
    fn normalize_persisted_rect_to_logical_keeps_logical_units() {
        let persisted: PersistedWindowState = serde_json::from_value(json!({
            "x": 100.0,
            "y": 50.0,
            "width": 1200.0,
            "height": 800.0,
            "maximized": false,
            "units": "logical"
        }))
        .expect("deserialize persisted window state");

        assert_eq!(persisted.units, PersistedWindowUnits::Logical);
        let rect = normalize_persisted_rect_to_logical(&persisted, 2.0);
        assert!((rect.x - 100.0).abs() < 0.01, "x={}", rect.x);
        assert!((rect.y - 50.0).abs() < 0.01, "y={}", rect.y);
        assert!((rect.width - 1200.0).abs() < 0.01, "width={}", rect.width);
        assert!((rect.height - 800.0).abs() < 0.01, "height={}", rect.height);
    }
}
