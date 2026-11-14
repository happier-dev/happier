//! Remembers the main window's size, position and maximized state between launches on
//! Windows and Linux (macOS has its own frame autosave in `macos_window_frame.rs`).
//!
//! Values are physical pixels. A saved frame is only applied when it still overlaps a connected
//! monitor, so unplugging a screen never strands the window off-screen.

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::PathBuf,
    sync::{mpsc, Arc, Mutex},
    time::Duration,
};
use tauri::{PhysicalPosition, PhysicalSize, WebviewWindow, WindowEvent};

/// Writes are debounced so dragging or resizing does not hit the disk on every event.
const SAVE_DEBOUNCE: Duration = Duration::from_millis(400);
/// Part of the window (in pixels) that must lie on a monitor for the saved position to be used.
const MIN_VISIBLE_PX: i64 = 64;
const MIN_SIZE_PX: u32 = 200;
/// Height of the top strip (title bar and window controls) that must stay on a monitor, so the
/// user can always grab and close the window.
const TITLE_BAR_PX: i64 = 40;
const MIN_TITLE_BAR_VISIBLE_PX: i64 = 24;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub(crate) struct SavedFrame {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub maximized: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct MonitorArea {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

pub(crate) fn load(path: &PathBuf) -> Option<SavedFrame> {
    let bytes = fs::read(path).ok()?;
    match serde_json::from_slice::<SavedFrame>(&bytes) {
        Ok(frame) => Some(frame),
        Err(error) => {
            log::warn!("could not read saved main-window frame: {error}");
            None
        }
    }
}

fn save(path: &PathBuf, frame: &SavedFrame) -> bool {
    let result = (|| -> Result<(), String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let bytes = serde_json::to_vec(frame).map_err(|error| error.to_string())?;
        fs::write(path, bytes).map_err(|error| error.to_string())
    })();
    match result {
        Ok(()) => true,
        Err(error) => {
            log::warn!("could not save main-window frame: {error}");
            false
        }
    }
}

fn overlap(a_start: i64, a_len: i64, b_start: i64, b_len: i64) -> i64 {
    (a_start + a_len).min(b_start + b_len) - a_start.max(b_start)
}

/// Returns the frame to apply, or `None` when it is unusable (too small, or off every monitor).
pub(crate) fn usable_frame(saved: SavedFrame, monitors: &[MonitorArea]) -> Option<SavedFrame> {
    if saved.width < MIN_SIZE_PX || saved.height < MIN_SIZE_PX {
        return None;
    }
    let visible = monitors.iter().any(|monitor| {
        overlap(
            saved.x as i64,
            saved.width as i64,
            monitor.x as i64,
            monitor.width as i64,
        ) >= MIN_VISIBLE_PX
            && overlap(
                saved.y as i64,
                TITLE_BAR_PX,
                monitor.y as i64,
                monitor.height as i64,
            ) >= MIN_TITLE_BAR_VISIBLE_PX
    });
    visible.then_some(saved)
}

/// Applies the saved frame to a window that has not been shown yet. Returns the frame that was
/// applied, or `None` when there was nothing usable to restore.
fn restore(window: &WebviewWindow, saved: SavedFrame) -> Option<SavedFrame> {
    let monitors: Vec<MonitorArea> = window
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|monitor| MonitorArea {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
        })
        .collect();
    let frame = usable_frame(saved, &monitors)?;
    // On Windows, moving first selects the destination monitor's DPI before restoring size.
    if let Err(error) = window.set_position(PhysicalPosition::new(frame.x, frame.y)) {
        log::warn!("failed to restore main-window position: {error}");
    }
    if let Err(error) = window.set_size(PhysicalSize::new(frame.width, frame.height)) {
        log::warn!("failed to restore main-window size: {error}");
    }
    if frame.maximized {
        if let Err(error) = window.maximize() {
            log::warn!("failed to restore maximized main window: {error}");
        }
    }
    Some(frame)
}

struct Shared {
    path: PathBuf,
    /// The latest frame and whether it still has to be written.
    state: Mutex<(SavedFrame, bool)>,
}

impl Shared {
    fn initialize(&self, frame: SavedFrame) {
        if let Ok(mut state) = self.state.lock() {
            // A failed flush can still be pending when a replacement window is attached.
            state.0 = frame;
        }
    }

    fn record(&self, normal: Option<SavedFrame>, maximized: bool) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return false;
        };
        let mut frame = normal.unwrap_or(state.0);
        if frame.width < MIN_SIZE_PX || frame.height < MIN_SIZE_PX {
            return false;
        }
        frame.maximized = maximized;
        if frame == state.0 {
            return false;
        }
        *state = (frame, true);
        true
    }

    fn flush(&self) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.1 && save(&self.path, &state.0) {
            state.1 = false;
        }
    }
}

/// One app-lifetime owner survives main-window destruction and recreation in tray mode.
pub(crate) struct FrameTracker {
    shared: Arc<Shared>,
    wake: mpsc::Sender<()>,
}

impl FrameTracker {
    pub(crate) fn new(path: PathBuf) -> Self {
        let initial = load(&path).unwrap_or_default();
        let shared = Arc::new(Shared {
            path,
            state: Mutex::new((initial, false)),
        });
        // The app and every attached window share one worker and the same pending frame.
        let (wake, events) = mpsc::channel::<()>();
        let worker = Arc::clone(&shared);
        std::thread::spawn(move || {
            while events.recv().is_ok() {
                while events.recv_timeout(SAVE_DEBOUNCE).is_ok() {}
                worker.flush();
            }
        });
        Self { shared, wake }
    }

    /// Restores and attaches a newly created, still hidden main window to the existing owner.
    pub(crate) fn track(&self, window: &WebviewWindow) {
        let saved = self.shared.state.lock().ok().map(|state| state.0);
        if saved.and_then(|frame| restore(window, frame)).is_none() {
            // This window's default geometry is the initial normal frame when saved geometry
            // is absent or its monitor is disconnected. Never initialize from a maximized rect.
            if let (Ok(position), Ok(size)) = (window.outer_position(), window.inner_size()) {
                self.shared.initialize(SavedFrame {
                    x: position.x,
                    y: position.y,
                    width: size.width,
                    height: size.height,
                    maximized: false,
                });
            }
        }

        let shared = Arc::clone(&self.shared);
        let wake = self.wake.clone();
        let window_for_events = window.clone();
        window.on_window_event(move |event| {
            if matches!(event, WindowEvent::Destroyed) {
                shared.flush();
                return;
            }
            if !matches!(event, WindowEvent::Moved(_) | WindowEvent::Resized(_)) {
                return;
            }
            let window = &window_for_events;
            // These are temporary presentation modes, not a new normal or maximized frame.
            if window.is_minimized().unwrap_or(false) || window.is_fullscreen().unwrap_or(false) {
                return;
            }
            let maximized = window.is_maximized().unwrap_or(false);
            let normal = if maximized {
                None
            } else {
                match (window.outer_position(), window.inner_size()) {
                    (Ok(position), Ok(size)) => Some(SavedFrame {
                        x: position.x,
                        y: position.y,
                        width: size.width,
                        height: size.height,
                        maximized: false,
                    }),
                    _ => return,
                }
            };
            if shared.record(normal, maximized) {
                let _ = wake.send(());
            }
        });
    }

    /// Flushes the same owner on actual app exit, including after window recreation.
    pub(crate) fn flush(&self) {
        self.shared.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREEN: MonitorArea = MonitorArea {
        x: 0,
        y: 0,
        width: 1920,
        height: 1080,
    };

    fn frame(x: i32, y: i32, width: u32, height: u32) -> SavedFrame {
        SavedFrame {
            x,
            y,
            width,
            height,
            maximized: false,
        }
    }

    #[test]
    fn frame_on_a_connected_monitor_is_kept() {
        let saved = frame(100, 80, 1200, 800);
        assert_eq!(usable_frame(saved, &[SCREEN]), Some(saved));
    }

    #[test]
    fn frame_on_a_secondary_monitor_with_negative_origin_is_kept() {
        let left = MonitorArea { x: -1920, ..SCREEN };
        let saved = frame(-1800, 50, 1000, 700);
        assert_eq!(usable_frame(saved, &[left, SCREEN]), Some(saved));
    }

    #[test]
    fn frame_left_on_a_disconnected_monitor_is_dropped() {
        assert_eq!(usable_frame(frame(-1800, 50, 1000, 700), &[SCREEN]), None);
        assert_eq!(usable_frame(frame(5000, 0, 800, 600), &[SCREEN]), None);
    }

    #[test]
    fn frame_whose_title_bar_is_off_screen_is_dropped() {
        // Bottom edge still overlaps the monitor, but the controls are unreachable.
        assert_eq!(usable_frame(frame(100, -700, 1000, 800), &[SCREEN]), None);
        assert_eq!(usable_frame(frame(100, 1070, 1000, 800), &[SCREEN]), None);
    }

    #[test]
    fn minimized_sentinel_position_and_tiny_sizes_are_dropped() {
        assert_eq!(
            usable_frame(frame(-32000, -32000, 800, 600), &[SCREEN]),
            None
        );
        assert_eq!(usable_frame(frame(0, 0, 10, 10), &[SCREEN]), None);
        assert_eq!(usable_frame(SavedFrame::default(), &[SCREEN]), None);
    }

    #[test]
    fn maximized_state_preserves_the_normal_frame_and_equal_events_do_not_write() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("frame.json");
        let normal = frame(10, 20, 900, 700);
        let shared = Shared {
            path: path.clone(),
            state: Mutex::new((normal, false)),
        };
        assert!(!shared.record(Some(normal), false));
        shared.flush();
        assert!(!path.exists());

        assert!(shared.record(None, true));
        shared.flush();
        assert_eq!(
            load(&path),
            Some(SavedFrame {
                maximized: true,
                ..normal
            })
        );

        let restored = frame(30, 40, 1000, 750);
        assert!(shared.record(Some(restored), false));
        shared.flush();
        assert_eq!(load(&path), Some(restored));
    }

    #[test]
    fn failed_flush_is_retried_after_storage_recovers() {
        let dir = tempfile::tempdir().unwrap();
        let parent = dir.path().join("window-state");
        fs::write(&parent, b"blocks the state directory").unwrap();
        let path = parent.join("main-window-frame.json");
        let saved = frame(10, 20, 900, 700);
        let shared = Shared {
            path: path.clone(),
            state: Mutex::new((saved, true)),
        };

        shared.flush();
        // Recreating the window after its monitor disconnects replaces the normal geometry.
        let fallback = frame(40, 50, 1000, 750);
        shared.initialize(fallback);
        fs::remove_file(&parent).unwrap();
        shared.flush();

        assert_eq!(load(&path), Some(fallback));
    }

    #[test]
    fn frame_round_trips_through_disk_and_bad_files_are_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("window-state/main-window-frame.json");
        assert_eq!(load(&path), None);
        let saved = SavedFrame {
            maximized: true,
            ..frame(10, 20, 900, 700)
        };
        save(&path, &saved);
        assert_eq!(load(&path), Some(saved));
        fs::write(&path, b"not json").unwrap();
        assert_eq!(load(&path), None);
    }
}
