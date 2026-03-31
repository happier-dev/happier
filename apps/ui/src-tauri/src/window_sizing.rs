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
    path::BaseDirectory,
    App,
    Manager,
    PhysicalPosition,
    PhysicalSize,
    Runtime,
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
#[derive(Clone, Copy, Debug, PartialEq)]
struct Rect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[cfg(desktop)]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PersistedWindowState {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    #[serde(default)]
    maximized: bool,
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
fn read_json(path: &Path) -> Option<PersistedWindowState> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice::<PersistedWindowState>(&bytes).ok()
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
pub fn register<R: Runtime>(app: &mut App<R>) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };

    let state_path = resolve_state_path(app)?;
    let persisted = read_json(&state_path);

    let monitor = window
        .current_monitor()?
        .or_else(|| window.primary_monitor().ok().flatten());

    if let Some(monitor) = monitor {
        let monitor_rect = monitor_to_rect(&monitor);

        let desired_rect = if let Some(persisted) = &persisted {
            Rect {
                x: persisted.x,
                y: persisted.y,
                width: persisted.width,
                height: persisted.height,
            }
        } else {
            let (width, height) = compute_default_window_size(monitor_rect);
            Rect {
                x: monitor_rect.x + ((monitor_rect.width - width) / 2.0).max(0.0),
                y: monitor_rect.y + ((monitor_rect.height - height) / 2.0).max(0.0),
                width,
                height,
            }
        };

        let clamped = clamp_window_rect_to_monitor(desired_rect, monitor_rect);
        let _ = window.set_size(tauri::Size::Physical(PhysicalSize {
            width: clamped.width.round().max(1.0) as u32,
            height: clamped.height.round().max(1.0) as u32,
        }));
        let _ = window.set_position(tauri::Position::Physical(PhysicalPosition {
            x: clamped.x.round() as i32,
            y: clamped.y.round() as i32,
        }));
    }

    if persisted.as_ref().is_some_and(|state| state.maximized) {
        let _ = window.maximize();
    }

    let last_write = Arc::new(Mutex::new(Instant::now() - WRITE_DEBOUNCE));
    let state_path = Arc::new(state_path);
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

        let now = Instant::now();
        let mut guard = match last_write.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if now.duration_since(*guard) < WRITE_DEBOUNCE && !matches!(event, WindowEvent::CloseRequested { .. }) {
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
        let maximized = window_for_events.is_maximized().unwrap_or(false);
        write_json(
            &state_path,
            &PersistedWindowState {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                maximized,
            },
        );
    });

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!((clamped.width - 300.0).abs() < 0.1, "width={}", clamped.width);
        assert!((clamped.height - 300.0).abs() < 0.1, "height={}", clamped.height);
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
}
