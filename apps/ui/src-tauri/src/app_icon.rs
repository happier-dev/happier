//! The running app's icon: Happier's own, or the one chosen in Appearance › App icon.
//!
//! macOS: since macOS 26 every bundled app icon is drawn on the system's square tile, so the
//! notch in Happier's mark shows the tile colour instead of the Dock behind it. An image set at
//! runtime through `NSApplication.applicationIconImage` is drawn as-is, which keeps the notch
//! transparent while the app runs. Tauri already does this for dev builds only (`#[cfg(dev)]` in
//! tauri's `app.rs`); this applies the same artwork in every build, or the chosen icon.
//!
//! Windows and Linux: the main window's icon (title bar and taskbar) follows the choice.
//!
//! Finder, Launchpad, shortcuts and the Dock before launch still show the bundled icon. Neither OS
//! keeps a runtime icon, so the choice is stored on this device and applied at launch before the
//! main window exists (plan 04, device-local desktop icon).

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};
use tauri::{AppHandle, Manager, Runtime};

pub const DEFAULT_ICON_ID: &str = "default";
const SAVED_FILE: &str = "app-icon.json";

/// The desktop artwork for a catalog id (`apps/ui/sources/components/settings/appearance/appIcon/appIcons.json`):
/// the macOS icon grid, 824 of 1024 with the system icon shadow, on a transparent canvas, so it sits
/// the same size as every bundled icon. The default is the mark itself (`scripts/generateDesktopIcons.mjs`).
fn icon_png(icon_id: &str) -> Option<&'static [u8]> {
    Some(match icon_id {
        DEFAULT_ICON_ID => include_bytes!("../icons/dock/dock-icon.png"),
        "night" => include_bytes!("../../sources/assets/images/app-icons/night/desktop.png"),
        "paper" => include_bytes!("../../sources/assets/images/app-icons/paper/desktop.png"),
        "gold" => include_bytes!("../../sources/assets/images/app-icons/gold/desktop.png"),
        "aurora" => include_bytes!("../../sources/assets/images/app-icons/aurora/desktop.png"),
        "sunrise" => include_bytes!("../../sources/assets/images/app-icons/sunrise/desktop.png"),
        "blueprint" => include_bytes!("../../sources/assets/images/app-icons/blueprint/desktop.png"),
        "pixel" => include_bytes!("../../sources/assets/images/app-icons/pixel/desktop.png"),
        _ => return None,
    })
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct SavedAppIcon {
    icon_id: String,
}

/// The chosen icon and where it is kept. Managed state; read by the main window at creation.
pub struct AppIconChoice {
    path: Option<PathBuf>,
    icon_id: Mutex<String>,
}

impl AppIconChoice {
    fn load(path: Option<PathBuf>) -> Self {
        let icon_id = path
            .as_deref()
            .map(read_saved_icon_id)
            .unwrap_or_else(|| DEFAULT_ICON_ID.to_string());
        Self {
            path,
            icon_id: Mutex::new(icon_id),
        }
    }

    fn current(&self) -> String {
        self.icon_id
            .lock()
            .map(|id| id.clone())
            .unwrap_or_else(|_| DEFAULT_ICON_ID.to_string())
    }

    fn save(&self, icon_id: &str) -> Result<(), String> {
        let path = self
            .path
            .as_ref()
            .ok_or_else(|| "app icon storage unavailable".to_string())?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let bytes = serde_json::to_vec(&SavedAppIcon {
            icon_id: icon_id.to_string(),
        })
        .map_err(|error| error.to_string())?;
        fs::write(path, bytes).map_err(|error| error.to_string())?;
        if let Ok(mut current) = self.icon_id.lock() {
            *current = icon_id.to_string();
        }
        Ok(())
    }
}

/// A missing file is the default. An unreadable one, or an id this build does not have, falls back
/// to the default loudly: the icon is cosmetic and picking again repairs it.
fn read_saved_icon_id(path: &Path) -> String {
    match fs::read(path) {
        Ok(bytes) => match serde_json::from_slice::<SavedAppIcon>(&bytes) {
            Ok(saved) if icon_png(&saved.icon_id).is_some() => saved.icon_id,
            Ok(saved) => {
                log::warn!("unknown saved app icon {:?}; using the default", saved.icon_id);
                DEFAULT_ICON_ID.to_string()
            }
            Err(error) => {
                log::warn!("could not read the saved app icon: {error}");
                DEFAULT_ICON_ID.to_string()
            }
        },
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => DEFAULT_ICON_ID.to_string(),
        Err(error) => {
            log::warn!("could not read the saved app icon: {error}");
            DEFAULT_ICON_ID.to_string()
        }
    }
}

/// Loads the saved choice and applies it. Runs in `setup` (main thread), before the main window.
pub fn register(app: &tauri::App) {
    let path = match app.path().app_config_dir() {
        Ok(dir) => Some(dir.join(SAVED_FILE)),
        Err(error) => {
            log::warn!("could not resolve app icon storage: {error}");
            None
        }
    };
    let choice = AppIconChoice::load(path);
    apply_app_icon(&choice.current());
    app.manage(choice);
}

/// macOS: re-applies the chosen Dock icon, e.g. after leaving menu-bar mode. Main thread only.
#[cfg(target_os = "macos")]
pub fn reapply<R: Runtime>(app: &AppHandle<R>) {
    let icon_id = app
        .try_state::<AppIconChoice>()
        .map(|choice| choice.current())
        .unwrap_or_else(|| DEFAULT_ICON_ID.to_string());
    apply_app_icon(&icon_id);
}

/// Windows and Linux: gives a newly built main window the chosen icon. The default keeps the bundle's.
#[cfg(not(target_os = "macos"))]
pub fn apply_to_window<R: Runtime>(app: &AppHandle<R>, window: &tauri::WebviewWindow<R>) {
    let Some(choice) = app.try_state::<AppIconChoice>() else {
        return;
    };
    let icon_id = choice.current();
    if icon_id == DEFAULT_ICON_ID {
        return;
    }
    if let Err(error) = set_window_icon(window, &icon_id) {
        log::warn!("could not apply the app icon to the main window: {error}");
    }
}

/// macOS sets the application icon instead (`register`, `reapply`).
#[cfg(target_os = "macos")]
pub fn apply_to_window<R: Runtime>(_app: &AppHandle<R>, _window: &tauri::WebviewWindow<R>) {}

/// The window icon fills its canvas: the artwork's 824 pt tile without the macOS shadow margin.
#[cfg(not(target_os = "macos"))]
fn set_window_icon<R: Runtime>(window: &tauri::WebviewWindow<R>, icon_id: &str) -> Result<(), String> {
    use tauri::image::Image;
    let image = match icon_id {
        DEFAULT_ICON_ID => window
            .app_handle()
            .default_window_icon()
            .cloned()
            .ok_or_else(|| "no bundled window icon".to_string())?,
        _ => {
            let png = icon_png(icon_id).ok_or_else(|| format!("unknown app icon {icon_id}"))?;
            let full = Image::from_bytes(png).map_err(|error| error.to_string())?;
            crop_to_tile(&full)
        }
    };
    window.set_icon(image).map_err(|error| error.to_string())
}

#[cfg(not(target_os = "macos"))]
fn crop_to_tile(full: &tauri::image::Image<'_>) -> tauri::image::Image<'static> {
    let (width, height) = (full.width(), full.height());
    // The macOS grid: 100 px margin around an 824 px tile on a 1024 canvas, scaled to the image.
    let margin = width * 100 / 1024;
    let side = width.saturating_sub(margin * 2).min(height.saturating_sub(margin * 2));
    let rgba = full.rgba();
    let mut out = Vec::with_capacity((side * side * 4) as usize);
    for row in margin..margin + side {
        let start = ((row * width + margin) * 4) as usize;
        out.extend_from_slice(&rgba[start..start + (side * 4) as usize]);
    }
    tauri::image::Image::new_owned(out, side, side)
}

#[cfg(target_os = "macos")]
fn apply_app_icon(icon_id: &str) {
    use objc2::AllocAnyThread;
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::{MainThreadMarker, NSData};

    let Some(mtm) = MainThreadMarker::new() else {
        log::warn!("app_icon applied off the main thread; keeping the bundle icon");
        return;
    };
    let Some(png) = icon_png(icon_id) else {
        log::warn!("unknown app icon {icon_id:?}; keeping the bundle icon");
        return;
    };
    let data = NSData::with_bytes(png);
    let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) else {
        log::warn!("could not decode the {icon_id} app icon; keeping the bundle icon");
        return;
    };
    let app = NSApplication::sharedApplication(mtm);
    unsafe { app.setApplicationIconImage(Some(&image)) };
}

/// Windows and Linux apply to the main window as it is built (`apply_to_window`).
#[cfg(not(target_os = "macos"))]
fn apply_app_icon(_icon_id: &str) {}

#[tauri::command]
pub fn desktop_get_app_icon<R: Runtime>(app: AppHandle<R>) -> String {
    app.try_state::<AppIconChoice>()
        .map(|choice| choice.current())
        .unwrap_or_else(|| DEFAULT_ICON_ID.to_string())
}

/// Applies the icon now and keeps it for the next launch. The Supporter rule is the app's
/// (`resolveAppIconAvailability`); the shell only refuses an icon it does not have.
#[tauri::command]
pub async fn desktop_set_app_icon<R: Runtime>(app: AppHandle<R>, icon_id: String) -> Result<(), String> {
    if icon_png(&icon_id).is_none() {
        return Err(format!("unknown app icon {icon_id}"));
    }
    let choice = app
        .try_state::<AppIconChoice>()
        .ok_or_else(|| "app icon state unavailable".to_string())?;
    #[cfg(target_os = "macos")]
    {
        let applied_id = icon_id.clone();
        app.run_on_main_thread(move || apply_app_icon(&applied_id))
            .map_err(|error| error.to_string())?;
    }
    #[cfg(not(target_os = "macos"))]
    if let Some(window) = app.get_webview_window("main") {
        set_window_icon(&window, &icon_id)?;
    }
    choice.save(&icon_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    const CATALOG: &str = include_str!("../../sources/components/settings/appearance/appIcon/appIcons.json");

    #[test]
    fn every_catalog_icon_has_desktop_artwork() {
        let catalog: serde_json::Value = serde_json::from_str(CATALOG).unwrap();
        let ids: Vec<&str> = catalog["icons"]
            .as_array()
            .unwrap()
            .iter()
            .map(|icon| icon["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids.len(), 8);
        for id in ids {
            assert!(icon_png(id).is_some(), "no desktop artwork for {id}");
        }
        assert!(icon_png("neon").is_none());
    }

    #[test]
    fn the_choice_survives_a_relaunch_and_unknown_or_damaged_files_read_as_the_default() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/app-icon.json");
        let choice = AppIconChoice::load(Some(path.clone()));
        assert_eq!(choice.current(), DEFAULT_ICON_ID);
        choice.save("aurora").unwrap();
        assert_eq!(choice.current(), "aurora");
        assert_eq!(AppIconChoice::load(Some(path.clone())).current(), "aurora");

        fs::write(&path, br#"{"iconId":"neon"}"#).unwrap();
        assert_eq!(AppIconChoice::load(Some(path.clone())).current(), DEFAULT_ICON_ID);
        fs::write(&path, b"not json").unwrap();
        assert_eq!(AppIconChoice::load(Some(path)).current(), DEFAULT_ICON_ID);
    }
}
