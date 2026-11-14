#[cfg(desktop)]
use serde::{Deserialize, Serialize};

#[cfg(desktop)]
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};

#[cfg(desktop)]
use tauri::{
    path::BaseDirectory, AppHandle, LogicalSize, Manager, PhysicalPosition, Runtime, State,
    WindowEvent,
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
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum InitialWindowVisibility {
    Visible,
    Hidden,
}

#[cfg(desktop)]
fn present_initial_main_window(visibility: InitialWindowVisibility, show: impl FnOnce()) {
    if matches!(visibility, InitialWindowVisibility::Visible) {
        show();
    }
}

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
    #[serde(default, skip_serializing_if = "Option::is_none")]
    monitor_name: Option<String>,
}

/// Logical outer geometry shared by Capture and app-window placement.
#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WindowFrame {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[cfg(desktop)]
pub(crate) fn window_frame(window: &tauri::WebviewWindow) -> Result<WindowFrame, String> {
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let position = window
        .outer_position()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale);
    let size = window
        .outer_size()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale);
    Ok(WindowFrame {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

#[cfg(desktop)]
fn apply_window_frame<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    frame: WindowFrame,
    target_scale: f64,
) -> tauri::Result<()> {
    // Logical saved coordinates belong to the target monitor, not the window's initial DPI.
    window.set_position(PhysicalPosition::new(
        (frame.x * target_scale).round() as i32,
        (frame.y * target_scale).round() as i32,
    ))?;
    // Persisted Linux windows use custom chrome, established on the builder before restoration.
    // Their outer and inner dimensions match; Tao's outer cache is invalid until Configure.
    // Other platforms still need native extents, including undecorated Windows shadow borders.
    let (decoration_width, decoration_height) =
        if cfg!(target_os = "linux") && !window.is_decorated()? {
            (0.0, 0.0)
        } else {
            let scale = window.scale_factor()?;
            let outer = window.outer_size()?.to_logical::<f64>(scale);
            let inner = window.inner_size()?.to_logical::<f64>(scale);
            (outer.width - inner.width, outer.height - inner.height)
        };
    window.set_size(LogicalSize::new(
        (frame.width - decoration_width).max(1.0),
        (frame.height - decoration_height).max(1.0),
    ))
}

#[cfg(desktop)]
pub(crate) fn previous_visible_window_frame(
    app: &AppHandle,
    excluded: &str,
    preferred: Option<&str>,
) -> Option<WindowFrame> {
    let windows = app.webview_windows();
    let previous = app
        .state::<WindowSizingState>()
        .previous_work_window
        .lock()
        .ok()
        .and_then(|previous| previous.clone());
    let eligible = |window: &&tauri::WebviewWindow| {
        window.label() != excluded
            && (window.label() == "main"
                || crate::desktop_window::is_app_window(window.label())
                || crate::desktop_window::is_capture_window(window.label()))
            && window.is_visible().unwrap_or(false)
    };
    preferred
        .and_then(|label| windows.get(label))
        .filter(eligible)
        .or_else(|| {
            previous
                .as_ref()
                .and_then(|label| windows.get(label))
                .filter(eligible)
        })
        .or_else(|| {
            windows
                .values()
                .filter(eligible)
                .find(|window| window.is_focused().unwrap_or(false))
        })
        .or_else(|| windows.values().find(eligible))
        .and_then(|window| window_frame(window).ok())
}

#[cfg(desktop)]
pub(crate) fn note_presented_work_window(window: &tauri::WebviewWindow) {
    if let Ok(mut previous) = window
        .app_handle()
        .state::<WindowSizingState>()
        .previous_work_window
        .lock()
    {
        *previous = Some(window.label().into());
    }
}

#[cfg(desktop)]
fn frame_path(app: &AppHandle, label: &str) -> tauri::Result<PathBuf> {
    app.path().resolve(
        format!("window-state/{label}.json"),
        BaseDirectory::AppConfig,
    )
}

#[cfg(desktop)]
fn saved_window_state(app: &AppHandle, label: &str) -> Option<PersistedWindowState> {
    let path = frame_path(app, label).ok()?;
    app.state::<WindowSizingState>().frames.saved(&path)
}

#[cfg(desktop)]
pub(crate) fn app_window_saved_frame(app: &AppHandle, label: &str) -> Option<WindowFrame> {
    let saved = saved_window_state(app, label)?;
    // Existing app-window state is logical; physical predecessor state is normalized by its
    // destination monitor in configure_app_window, where the scale is available.
    Some(WindowFrame {
        x: saved.x,
        y: saved.y,
        width: saved.width,
        height: saved.height,
    })
}

#[cfg(desktop)]
fn restoration_monitor<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    saved: Option<&PersistedWindowState>,
) -> tauri::Result<Option<tauri::Monitor>> {
    let monitors = window.available_monitors()?;
    let remembered = saved.and_then(|saved| {
        if let Some(name) = &saved.monitor_name {
            return monitors
                .iter()
                .find(|monitor| monitor.name().is_some_and(|candidate| candidate == name));
        }
        monitors.iter().find(|monitor| {
            let rect = normalize_persisted_rect_to_logical(saved, monitor.scale_factor());
            let area = monitor_to_rect(monitor);
            let scale = monitor.scale_factor();
            rect.x >= area.x / scale
                && rect.x < (area.x + area.width) / scale
                && rect.y >= area.y / scale
                && rect.y < (area.y + area.height) / scale
        })
    });
    Ok(remembered
        .cloned()
        .or(window.current_monitor()?)
        .or_else(|| window.primary_monitor().ok().flatten()))
}

#[cfg(desktop)]
pub(crate) fn app_window_work_area(
    window: &tauri::WebviewWindow,
) -> Result<Option<WindowFrame>, String> {
    let saved = saved_window_state(window.app_handle(), window.label());
    let monitor = restoration_monitor(window, saved.as_ref()).map_err(|error| error.to_string())?;
    Ok(monitor.as_ref().map(monitor_work_area))
}

#[cfg(desktop)]
fn monitor_work_area(monitor: &tauri::Monitor) -> WindowFrame {
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    WindowFrame {
        x: area.position.x as f64 / scale,
        y: area.position.y as f64 / scale,
        width: area.size.width as f64 / scale,
        height: area.size.height as f64 / scale,
    }
}

#[cfg(desktop)]
pub(crate) fn recover_app_window_frame(window: &tauri::WebviewWindow) -> Result<(), String> {
    // Recovery must not turn temporary presentation geometry into a normal frame or unmaximize
    // a window merely because Reveal was requested.
    let presentation =
        crate::window_chrome::read_native_window_presentation(&window.as_ref().window())?;
    if presentation.minimized || presentation.maximized || presentation.fullscreen {
        return Ok(());
    }
    recover_normal_app_frame(window, None).map(|_| ())
}

#[cfg(desktop)]
fn recover_normal_app_frame(
    window: &tauri::WebviewWindow,
    requested: Option<WindowFrame>,
) -> Result<WindowFrame, String> {
    let frame = match requested {
        Some(frame) => frame,
        None => window_frame(window)?,
    };
    let saved = saved_window_state(window.app_handle(), window.label()).or_else(|| {
        requested.map(|frame| PersistedWindowState {
            x: frame.x,
            y: frame.y,
            width: frame.width,
            height: frame.height,
            maximized: false,
            units: PersistedWindowUnits::Logical,
            monitor_name: None,
        })
    });
    let monitor = restoration_monitor(window, saved.as_ref()).map_err(|error| error.to_string())?;
    let recovered = if let Some(area) = monitor.as_ref().map(monitor_work_area) {
        // App windows have no content-size cap; only the selected monitor's work area constrains them.
        let width = frame.width.min(area.width).max(1.0);
        let height = frame.height.min(area.height).max(1.0);
        WindowFrame {
            x: frame
                .x
                .clamp(area.x, area.x + (area.width - width).max(0.0)),
            y: frame
                .y
                .clamp(area.y, area.y + (area.height - height).max(0.0)),
            width,
            height,
        }
    } else {
        frame
    };
    if requested.is_some() || recovered != frame {
        let scale = match monitor {
            Some(monitor) => monitor.scale_factor(),
            None => window.scale_factor().map_err(|error| error.to_string())?,
        };
        apply_window_frame(window, recovered, scale).map_err(|error| error.to_string())?;
    }
    Ok(recovered)
}

#[cfg(desktop)]
pub(crate) fn configure_app_window(
    window: &tauri::WebviewWindow,
    initial: Option<WindowFrame>,
) -> Result<(), String> {
    let app = window.app_handle();
    let saved = saved_window_state(app, window.label());
    let scale = restoration_monitor(window, saved.as_ref())
        .map_err(|error| error.to_string())?
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(1.0);
    let frame = saved
        .as_ref()
        .map(|saved| {
            let rect = normalize_persisted_rect_to_logical(saved, scale);
            WindowFrame {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
            }
        })
        .or(initial);
    let normal = recover_normal_app_frame(window, frame)?;
    track_window_frame(
        window,
        normal,
        saved.as_ref().is_some_and(|saved| saved.maximized),
    )?;
    if saved.as_ref().is_some_and(|saved| saved.maximized) {
        window.maximize().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Records the native normal frame through the single persistence owner. Presentation-only
/// minimized/fullscreen geometry is ignored; maximize only changes the saved presentation bit.
#[cfg(desktop)]
fn record_window_frame(window: &tauri::WebviewWindow) {
    let presentation =
        match crate::window_chrome::read_native_window_presentation(&window.as_ref().window()) {
            Ok(presentation) => presentation,
            Err(error) => {
                log::warn!(
                    "could not read native window presentation for frame persistence: {error}"
                );
                return;
            }
        };
    if presentation.minimized || presentation.fullscreen {
        return;
    }
    let Ok(path) = frame_path(window.app_handle(), window.label()) else {
        return;
    };
    let owner = window.app_handle().state::<WindowSizingState>();
    let maximized = presentation.maximized;
    let saved = owner.frames.saved(&path);
    let observation = if maximized {
        FrameObservation::Maximized
    } else {
        let Ok(frame) = window_frame(window) else {
            return;
        };
        let saved_name = saved.and_then(|saved| saved.monitor_name);
        // Retain a disconnected monitor's identity until it returns, as before.
        let monitor_name = match saved_name {
            Some(name)
                if !window
                    .available_monitors()
                    .unwrap_or_default()
                    .iter()
                    .any(|monitor| monitor.name().is_some_and(|candidate| candidate == &name)) =>
            {
                Some(name)
            }
            _ => window
                .current_monitor()
                .ok()
                .flatten()
                .and_then(|monitor| monitor.name().cloned()),
        };
        FrameObservation::Normal(PersistedWindowState {
            x: frame.x,
            y: frame.y,
            width: frame.width,
            height: frame.height,
            maximized: false,
            units: PersistedWindowUnits::Logical,
            monitor_name,
        })
    };
    owner.frames.record(path, observation);
}

#[cfg(desktop)]
fn initialize_window_frame(
    window: &tauri::WebviewWindow,
    frame: WindowFrame,
    maximized: bool,
) -> Result<(), String> {
    let path =
        frame_path(window.app_handle(), window.label()).map_err(|error| error.to_string())?;
    let saved = saved_window_state(window.app_handle(), window.label());
    let mut value = PersistedWindowState {
        x: frame.x,
        y: frame.y,
        width: frame.width,
        height: frame.height,
        maximized,
        units: PersistedWindowUnits::Logical,
        monitor_name: saved.and_then(|saved| saved.monitor_name),
    };
    if value.monitor_name.is_none() {
        // A queued Linux move may not yet have updated current_monitor. Select from the known
        // normal rect through the same restoration owner used at launch.
        value.monitor_name = restoration_monitor(window, Some(&value))
            .map_err(|error| error.to_string())?
            .and_then(|monitor| monitor.name().cloned());
    }
    window
        .app_handle()
        .state::<WindowSizingState>()
        .frames
        .initialize(path, value);
    Ok(())
}

#[cfg(desktop)]
fn track_window_frame(
    window: &tauri::WebviewWindow,
    normal: WindowFrame,
    maximized: bool,
) -> Result<(), String> {
    initialize_window_frame(window, normal, maximized)?;
    let frames = window
        .app_handle()
        .state::<WindowSizingState>()
        .frames
        .clone();
    let retained = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_)
        | WindowEvent::Resized(_)
        | WindowEvent::ScaleFactorChanged { .. } => {
            record_window_frame(&retained);
        }
        WindowEvent::CloseRequested { .. } => persist_window_frame(&retained),
        WindowEvent::Destroyed => frames.flush(),
        _ => {}
    });
    Ok(())
}

#[cfg(desktop)]
pub(crate) fn persist_window_frame(window: &tauri::WebviewWindow) {
    record_window_frame(window);
    window
        .app_handle()
        .state::<WindowSizingState>()
        .frames
        .flush();
}

#[cfg(desktop)]
pub(crate) fn preserve_for_quit(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label == "main" || crate::desktop_window::is_app_window(&label) {
            record_window_frame(&window);
        }
    }
    flush_window_frames(app);
}

#[cfg(desktop)]
pub(crate) fn flush_window_frames(app: &AppHandle) {
    app.state::<WindowSizingState>().frames.flush();
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
    previous_work_window: Arc<Mutex<Option<String>>>,
    frames: FramePersistence,
}

/// App-lifetime normal-frame state shared by main and app windows, including recreated windows.
#[cfg(desktop)]
#[derive(Clone)]
struct FramePersistence {
    frames: Arc<Mutex<HashMap<PathBuf, PendingFrame>>>,
    wake: mpsc::Sender<()>,
}

#[cfg(desktop)]
struct PendingFrame {
    value: PersistedWindowState,
    dirty: bool,
}

#[cfg(desktop)]
enum FrameObservation {
    Normal(PersistedWindowState),
    Maximized,
}

#[cfg(desktop)]
impl Default for FramePersistence {
    fn default() -> Self {
        let frames = Arc::new(Mutex::new(HashMap::new()));
        let (wake, events) = mpsc::channel();
        let worker = Arc::clone(&frames);
        std::thread::spawn(move || {
            while events.recv().is_ok() {
                while events.recv_timeout(WRITE_DEBOUNCE).is_ok() {}
                flush_frames(&worker);
            }
        });
        Self { frames, wake }
    }
}

#[cfg(desktop)]
impl FramePersistence {
    fn saved(&self, path: &Path) -> Option<PersistedWindowState> {
        self.frames
            .lock()
            .ok()?
            .get(path)
            .map(|frame| frame.value.clone())
            .or_else(|| read_json(path))
    }

    fn initialize(&self, path: PathBuf, value: PersistedWindowState) {
        if let Ok(mut frames) = self.frames.lock() {
            frames
                .entry(path)
                .and_modify(|frame| frame.value = value.clone())
                .or_insert(PendingFrame {
                    value,
                    dirty: false,
                });
        }
    }

    fn record(&self, path: PathBuf, observation: FrameObservation) {
        {
            let Ok(mut frames) = self.frames.lock() else {
                return;
            };
            let value = match observation {
                FrameObservation::Maximized => {
                    let Some(previous) = frames.get(&path) else {
                        return;
                    };
                    PersistedWindowState {
                        maximized: true,
                        ..previous.value.clone()
                    }
                }
                FrameObservation::Normal(value) => value,
            };
            if frames.get(&path).is_some_and(|frame| frame.value == value) {
                return;
            }
            frames.insert(path, PendingFrame { value, dirty: true });
        }
        if let Err(error) = self.wake.send(()) {
            log::warn!("could not schedule window-frame persistence: {error}");
        }
    }

    fn flush(&self) {
        flush_frames(&self.frames);
    }
}

#[cfg(desktop)]
fn flush_frames(frames: &Mutex<HashMap<PathBuf, PendingFrame>>) {
    let Ok(mut frames) = frames.lock() else {
        return;
    };
    for (path, frame) in frames.iter_mut() {
        if frame.dirty && write_json(path, &frame.value) {
            frame.dirty = false;
        }
    }
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
fn resolve_state_path_handle(app: &AppHandle) -> tauri::Result<PathBuf> {
    frame_path(app, "main")
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
fn write_json(path: &Path, state: &PersistedWindowState) -> bool {
    let result = (|| -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let payload = serde_json::to_vec_pretty(state).map_err(|error| error.to_string())?;
        fs::write(path, payload).map_err(|error| error.to_string())
    })();
    match result {
        Ok(()) => true,
        Err(error) => {
            log::warn!("could not save desktop window frame: {error}");
            false
        }
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
) -> WindowFrame {
    let persisted_logical = persisted.as_ref().map(|state| {
        let rect = normalize_persisted_rect_to_logical(state, scale_factor);
        PersistedWindowState {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
            maximized: state.maximized,
            units: PersistedWindowUnits::Logical,
            monitor_name: state.monitor_name.clone(),
        }
    });

    let clamped = resolve_launch_window_rect(monitor_logical, persisted_logical.as_ref());
    let _ = window.set_resizable(true);
    let _ = window.set_min_size(None::<LogicalSize<f64>>);
    let _ = window.set_max_size(None::<LogicalSize<f64>>);
    let _ = window.unmaximize();
    let normal = WindowFrame {
        x: clamped.x.round(),
        y: clamped.y.round(),
        width: clamped.width.round().max(1.0),
        height: clamped.height.round().max(1.0),
    };
    if let Err(error) = apply_window_frame(window, normal, scale_factor) {
        log::warn!("could not restore main-window frame: {error}");
    }
    normal
}

pub(crate) fn configure_main_window(
    app: &AppHandle,
    window: &tauri::WebviewWindow,
    initial_visibility: InitialWindowVisibility,
) -> tauri::Result<()> {
    let state_path = resolve_state_path_handle(app)?;
    let mode_path = resolve_mode_path_handle(app)?;
    let persisted = app.state::<WindowSizingState>().frames.saved(&state_path);
    let persisted_mode = read_mode(&mode_path);
    let initial_mode = resolve_initial_window_mode(persisted_mode, persisted.is_some());
    if let Ok(mut guard) = app.state::<WindowSizingState>().mode.lock() {
        *guard = initial_mode;
    }

    let monitor = restoration_monitor(window, persisted.as_ref())?;

    let normal = if let Some(monitor) = monitor {
        let scale_factor = monitor.scale_factor();
        let monitor_rect = monitor_to_rect(&monitor);

        let monitor_logical = Rect {
            x: monitor_rect.x / scale_factor,
            y: monitor_rect.y / scale_factor,
            width: monitor_rect.width / scale_factor,
            height: monitor_rect.height / scale_factor,
        };
        apply_main_window_rect(&window, monitor_logical, persisted.clone(), scale_factor)
    } else {
        window_frame(window).map_err(|error| tauri::Error::Io(std::io::Error::other(error)))?
    };

    track_window_frame(
        window,
        normal,
        persisted.as_ref().is_some_and(|state| state.maximized),
    )
    .map_err(|error| tauri::Error::Io(std::io::Error::other(error)))?;
    if persisted.as_ref().is_some_and(|state| state.maximized) {
        window.maximize()?;
    }

    // Persist the last known mode so the next launch can start at the right size with no visible jumps.
    write_mode(&mode_path, initial_mode);

    present_initial_main_window(initial_visibility, || {
        let _ = window.show();
    });
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

    let mode = normalize_window_mode(mode);
    {
        let mut guard = state
            .mode
            .lock()
            .map_err(|_| "WindowSizingState poisoned".to_string())?;
        // The UI can repeat Main on mount. Equal mode does not restore geometry or disturb
        // maximized/fullscreen presentation.
        if *guard == mode {
            return Ok(());
        }
        *guard = mode;
    }
    let mode_path = resolve_mode_path_handle(&app).map_err(|e| e.to_string())?;
    write_mode(&mode_path, mode);

    let state_path = resolve_state_path_handle(&app).map_err(|e| e.to_string())?;
    let persisted = state.frames.saved(&state_path);
    let monitor =
        restoration_monitor(&window, persisted.as_ref()).map_err(|error| error.to_string())?;
    let Some(monitor) = monitor else {
        return Ok(());
    };
    let scale_factor = monitor.scale_factor();
    let monitor_rect = monitor_to_rect(&monitor);
    let monitor_logical = Rect {
        x: monitor_rect.x / scale_factor,
        y: monitor_rect.y / scale_factor,
        width: monitor_rect.width / scale_factor,
        height: monitor_rect.height / scale_factor,
    };

    let normal = apply_main_window_rect(&window, monitor_logical, persisted.clone(), scale_factor);
    initialize_window_frame(
        &window,
        normal,
        persisted.as_ref().is_some_and(|state| state.maximized),
    )?;
    if persisted.as_ref().is_some_and(|state| state.maximized) {
        window.maximize().map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn persistence_keeps_normal_geometry_when_maximized_and_saves_the_latest_change() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("main.json");
        let frames = FramePersistence::default();
        let normal = PersistedWindowState {
            x: -1400.0,
            y: 50.0,
            width: 1000.0,
            height: 700.0,
            maximized: false,
            units: PersistedWindowUnits::Logical,
            monitor_name: Some("secondary".into()),
        };
        frames.initialize(path.clone(), normal.clone());
        frames.record(path.clone(), FrameObservation::Normal(normal.clone()));
        frames.flush();
        assert!(!path.exists());
        frames.record(path.clone(), FrameObservation::Maximized);
        frames.flush();
        assert_eq!(
            read_json(&path),
            Some(PersistedWindowState {
                maximized: true,
                ..normal.clone()
            })
        );

        let moved = PersistedWindowState {
            x: -1200.0,
            width: 1100.0,
            ..normal
        };
        frames.record(path.clone(), FrameObservation::Normal(moved.clone()));
        frames.flush();
        assert_eq!(read_json(&path), Some(moved));
    }

    #[test]
    fn failed_frame_write_remains_pending_across_window_recreation() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("window-state");
        fs::write(&parent, b"blocks the state directory").unwrap();
        let path = parent.join("main.json");
        let frames = FramePersistence::default();
        let saved = PersistedWindowState {
            x: 30.0,
            y: 40.0,
            width: 900.0,
            height: 700.0,
            maximized: false,
            units: PersistedWindowUnits::Logical,
            monitor_name: None,
        };
        frames.record(path.clone(), FrameObservation::Normal(saved.clone()));
        frames.flush();
        // A disconnected monitor can replace the normal rect during recreation. The latest
        // replacement must remain pending after the preceding destruction flush failed.
        let replacement = PersistedWindowState {
            x: 60.0,
            y: 70.0,
            ..saved
        };
        frames.initialize(path.clone(), replacement.clone());
        fs::remove_file(&parent).unwrap();
        frames.flush();
        assert_eq!(read_json(&path), Some(replacement));
    }

    #[test]
    fn hidden_main_window_configuration_never_presents_the_native_window() {
        let mut presentations = 0;
        // Only the native show operation is substituted at the OS boundary.
        present_initial_main_window(InitialWindowVisibility::Hidden, || presentations += 1);
        assert_eq!(presentations, 0);
        present_initial_main_window(InitialWindowVisibility::Visible, || presentations += 1);
        assert_eq!(presentations, 1);
    }

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
            monitor_name: None,
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
