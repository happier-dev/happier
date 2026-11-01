//! The app's own login item, which follows the one login-start setting (R16 b).
//!
//! There is no separate "launch Happier at login" setting any more: when this computer's
//! background service starts at login, the app starts at login too — in menu-bar mode
//! (`--menu-bar`: tray only, no window, no web UI) — and when the service is on-demand it does not.
//! Whoever learns the setting (the web UI's push, a native status read, the tray's own check item)
//! hands it to [`follow_login_start_setting`], the only writer of the login item.
//!
//! Migration: a login item an earlier version created (the old toggle, no arguments) is rewritten
//! with `--menu-bar` the first time the setting is seen on, and removed the first time it is seen
//! off. While the setting is unknown the login item is left exactly as it is.

#[cfg(desktop)]
use std::sync::Mutex;

#[cfg(desktop)]
use tauri::{App, AppHandle, Manager};

#[cfg(desktop)]
use tauri_plugin_autostart::{MacosLauncher, ManagerExt as AutostartManagerExt};

#[cfg(desktop)]
use crate::menu_bar::policy::{app_autostart_target, MENU_BAR_ARG};
#[cfg(desktop)]
use crate::tray::model::AutostartMode;

/// The login-item state this process last wrote, so a push that repeats the setting writes nothing.
#[cfg(desktop)]
#[derive(Default)]
pub struct AppAutostartState(Mutex<Option<bool>>);

#[cfg(desktop)]
pub fn register(app: &mut App) -> tauri::Result<()> {
    app.handle().plugin(tauri_plugin_autostart::init(
        MacosLauncher::LaunchAgent,
        Some(vec![MENU_BAR_ARG]),
    ))?;
    app.manage(AppAutostartState::default());
    Ok(())
}

#[cfg(desktop)]
pub fn follow_login_start_setting(app: &AppHandle, mode: Option<AutostartMode>) {
    let Some(start_at_login) = app_autostart_target(mode) else {
        return;
    };
    // A development build must not register its own debug binary as a login item every time it
    // sees the setting on; packaged builds are the ones people log in to.
    if cfg!(debug_assertions) {
        log::info!("debug build: leaving the app login item as it is (setting: {start_at_login})");
        return;
    }
    let Some(state) = app.try_state::<AppAutostartState>() else {
        return;
    };
    {
        let Ok(mut applied) = state.0.lock() else {
            return;
        };
        if *applied == Some(start_at_login) {
            return;
        }
        *applied = Some(start_at_login);
    }

    let autolaunch = app.autolaunch();
    // `enable` rewrites the login item, which is also what migrates one written without
    // `--menu-bar` or with an older executable name. Keep the channel's product name (the
    // plugin's login-item key) stable so this replaces the old path in place.
    let result = if start_at_login {
        autolaunch.enable()
    } else {
        match autolaunch.is_enabled() {
            Ok(true) => autolaunch.disable(),
            Ok(false) => Ok(()),
            Err(error) => Err(error),
        }
    };
    if let Err(error) = result {
        log::warn!("failed to make the app login item follow the login-start setting: {error}");
        // Said in the tray menu too: release builds keep no log.
        crate::tray::update_model(app, |model| {
            model.notice = Some(format!("{}: {error}", model.labels.login_item_failed))
        });
        // Try again on the next observation of the setting.
        if let Ok(mut applied) = state.0.lock() {
            *applied = None;
        }
    }
}
