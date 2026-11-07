//! "Open in new window", "Open in…" and "Open file location" for session files.
//!
//! File windows are ordinary app webviews on the `/file-window` route (see
//! `sources/components/sessions/files/window/sessionFileWindowRoute.ts`). Their labels share the
//! `file-window-` prefix so `capabilities/file_window.json` can grant them a narrow permission set,
//! and `window_chrome` treats them like any non-main window: native frame, closed for real.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};

const FILE_WINDOW_ROUTE_PREFIX: &str = "/file-window?";
const FILE_WINDOW_LABEL_PREFIX: &str = "file-window-";
const FALLBACK_TITLE: &str = "Happier";
/// Share of the monitor a new file window covers: wide enough to read a document comfortably.
const FILE_WINDOW_MONITOR_FRACTION: (f64, f64) = (0.6, 0.8);
const FILE_WINDOW_FALLBACK_SIZE: (f64, f64) = (1100.0, 800.0);
const FILE_WINDOW_MIN_SIZE: (f64, f64) = (420.0, 320.0);

static NEXT_FILE_WINDOW_ID: AtomicU64 = AtomicU64::new(1);

/// Only the file-window route may be opened, so the command cannot load an arbitrary page.
fn validate_file_window_route(route: &str) -> Result<&str, String> {
    if !route.starts_with(FILE_WINDOW_ROUTE_PREFIX) {
        return Err("Only the file window route can be opened in a new window.".to_string());
    }
    if route.chars().any(char::is_control) {
        return Err("The file window route contains control characters.".to_string());
    }
    Ok(route)
}

fn resolve_file_window_title(title: &str) -> String {
    let trimmed: String = title.chars().filter(|c| !c.is_control()).collect();
    let trimmed = trimmed.trim();
    if trimmed.is_empty() {
        FALLBACK_TITLE.to_string()
    } else {
        trimmed.to_string()
    }
}

/// Logical size for a new file window on a monitor of `monitor_logical_size`.
fn resolve_file_window_size(monitor_logical_size: Option<(f64, f64)>) -> (f64, f64) {
    match monitor_logical_size {
        Some((width, height)) if width > 0.0 && height > 0.0 => (
            (width * FILE_WINDOW_MONITOR_FRACTION.0).max(FILE_WINDOW_MIN_SIZE.0),
            (height * FILE_WINDOW_MONITOR_FRACTION.1).max(FILE_WINDOW_MIN_SIZE.1),
        ),
        _ => FILE_WINDOW_FALLBACK_SIZE,
    }
}

fn read_monitor_logical_size<R: Runtime>(app: &AppHandle<R>) -> Option<(f64, f64)> {
    let monitor = app
        .get_webview_window("main")
        .and_then(|window| window.current_monitor().ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten())?;
    let size = monitor.size().to_logical::<f64>(monitor.scale_factor());
    Some((size.width, size.height))
}

/// A path the OS can open: absolute and an existing file (never a folder or a program argument).
fn validate_local_file_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("No file path was given.".to_string());
    }
    let path = Path::new(trimmed);
    if !path.is_absolute() {
        return Err(format!("{trimmed} is not an absolute path."));
    }
    match std::fs::metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(path.to_path_buf()),
        Ok(_) => Err(format!("{trimmed} is not a file.")),
        Err(error) => Err(format!("{trimmed} cannot be reached from this computer: {error}")),
    }
}

#[tauri::command]
pub async fn desktop_open_file_window<R: Runtime>(
    app: AppHandle<R>,
    route: String,
    title: String,
) -> Result<(), String> {
    let route = validate_file_window_route(&route)?;
    let label = format!(
        "{FILE_WINDOW_LABEL_PREFIX}{}",
        NEXT_FILE_WINDOW_ID.fetch_add(1, Ordering::Relaxed)
    );
    let (width, height) = resolve_file_window_size(read_monitor_logical_size(&app));
    let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::App(route.into()))
        .title(resolve_file_window_title(&title))
        .inner_size(width, height)
        .min_inner_size(FILE_WINDOW_MIN_SIZE.0, FILE_WINDOW_MIN_SIZE.1)
        .resizable(true)
        .decorations(true)
        .center()
        .build()
        .map_err(|error| format!("Failed to open the file window: {error}"))?;
    let _ = window.set_focus();
    Ok(())
}

#[tauri::command]
pub async fn desktop_open_path_with_default_app(path: String) -> Result<(), String> {
    let path = validate_local_file_path(&path)?;
    tauri_plugin_opener::open_path(&path, None::<&str>)
        .map_err(|error| format!("Failed to open {}: {error}", path.display()))
}

#[tauri::command]
pub async fn desktop_reveal_path_in_file_manager(path: String) -> Result<(), String> {
    let path = validate_local_file_path(&path)?;
    tauri_plugin_opener::reveal_item_in_dir(&path)
        .map_err(|error| format!("Failed to show {}: {error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_the_file_window_route() {
        assert!(validate_file_window_route("/file-window?sessionId=s1&path=a.md").is_ok());
        assert!(validate_file_window_route("/session/s1").is_err());
        assert!(validate_file_window_route("https://example.com/file-window?x=1").is_err());
        assert!(validate_file_window_route("/file-window-evil?x=1").is_err());
        assert!(validate_file_window_route("/file-window?path=a\n.md").is_err());
    }

    #[test]
    fn titles_fall_back_and_drop_control_characters() {
        assert_eq!(resolve_file_window_title("  notes.md "), "notes.md");
        assert_eq!(resolve_file_window_title("a\u{0007}b.md"), "ab.md");
        assert_eq!(resolve_file_window_title("   "), FALLBACK_TITLE);
    }

    #[test]
    fn window_size_follows_the_monitor_with_a_floor() {
        assert_eq!(resolve_file_window_size(Some((2000.0, 1000.0))), (1200.0, 800.0));
        assert_eq!(resolve_file_window_size(Some((400.0, 300.0))), FILE_WINDOW_MIN_SIZE);
        assert_eq!(resolve_file_window_size(None), FILE_WINDOW_FALLBACK_SIZE);
    }

    #[test]
    fn local_paths_must_be_existing_absolute_files() {
        let dir = std::env::temp_dir().join(format!("happier-file-window-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("note.md");
        std::fs::write(&file, b"# note").unwrap();

        assert_eq!(validate_local_file_path(file.to_str().unwrap()).unwrap(), file);
        assert!(validate_local_file_path(dir.to_str().unwrap()).is_err());
        assert!(validate_local_file_path(dir.join("missing.md").to_str().unwrap()).is_err());
        assert!(validate_local_file_path("relative/note.md").is_err());
        assert!(validate_local_file_path("  ").is_err());

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
