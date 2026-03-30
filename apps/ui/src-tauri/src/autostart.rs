#[cfg(desktop)]
use tauri::{App, AppHandle, Runtime};

#[cfg(desktop)]
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartManagerExt};

#[cfg(desktop)]
pub fn register<R: Runtime>(app: &mut App<R>) -> tauri::Result<()> {
    app.handle().plugin(tauri_plugin_autostart::init(
        MacosLauncher::LaunchAgent,
        None::<Vec<&str>>,
    ))?;
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_get_autostart_enabled<R: Runtime>(app: AppHandle<R>) -> Result<bool, String> {
    app.autolaunch()
        .is_enabled()
        .map_err(|error| error.to_string())
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_set_autostart_enabled<R: Runtime>(
    app: AppHandle<R>,
    enabled: bool,
) -> Result<bool, String> {
    let autolaunch = app.autolaunch();
    if enabled {
        autolaunch.enable().map_err(|error| error.to_string())?;
    } else {
        autolaunch.disable().map_err(|error| error.to_string())?;
    }

    autolaunch.is_enabled().map_err(|error| error.to_string())
}
