#[cfg(desktop)]
mod autostart;

#[cfg(desktop)]
mod background_command;

#[cfg(desktop)]
mod dock_icon;

#[cfg(desktop)]
mod menu;

#[cfg(desktop)]
mod menu_bar;

#[cfg(desktop)]
mod tray;

#[cfg(desktop)]
mod pet_overlay;

#[cfg(desktop)]
mod system_tasks;

#[cfg(desktop)]
mod window_chrome;

#[cfg(desktop)]
mod startup;

#[cfg(desktop)]
mod shutdown;

#[cfg(target_os = "linux")]
mod linux_webkit_env;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
// The main-thread native test harness reuses these modules with its own isolated setup.
// Embed the product Info.plist only in the product entrypoint, not in that test executable.
#[cfg(not(test))]
pub fn run() {
    #[cfg(target_os = "linux")]
    linux_webkit_env::apply_before_gtk_init();

    let mut builder = tauri::Builder::default();

    // First, as the plugin requires: a second launch hands its arguments to this process and exits
    // before it creates anything (R16 — one app and one tray per channel).
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            menu_bar::on_second_launch(app, args);
        }));
        builder = builder.plugin(tauri_plugin_deep_link::init());
    }

    builder = builder
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_mcp_bridge::init());
    }

    #[cfg(desktop)]
    {
        // One global router for every menu command; muda delivers the tray menu and the macOS app
        // menu through the same channel, and registering it twice would double every Quit.
        builder = builder.on_menu_event(menu::handle_menu_event);

        // tauri's default macOS menu quits through the predefined item's native `terminate:`, which
        // never reaches `RunEvent::ExitRequested` and so would skip the shutdown handoff entirely.
        #[cfg(target_os = "macos")]
        {
            builder = builder.menu(menu::build_app_menu);
        }

        builder = builder
            .manage(app_updates::PendingUpdate::default())
            .manage(pet_overlay::DesktopPetOverlayState::default())
            .manage(system_tasks::SystemTasksState::default())
            .manage(shutdown::DesktopShutdownState::default())
            .manage(menu_bar::MenuBarState::default())
            .invoke_handler(tauri::generate_handler![
                app_updates::desktop_fetch_update,
                app_updates::desktop_download_update,
                app_updates::desktop_install_update,
                desktop_dialog::desktop_pick_ssh_identity_file,
                tray::desktop_set_tray_state,
                pet_overlay::sync_desktop_pet_overlay_state,
                pet_overlay::desktop_pet_overlay_read_window_state,
                pet_overlay::desktop_pet_overlay_set_input_locked,
                pet_overlay::desktop_pet_overlay_sync_element_metrics,
                pet_overlay::desktop_pet_overlay_start_drag_session,
                pet_overlay::desktop_pet_overlay_apply_drag_delta,
                pet_overlay::desktop_pet_overlay_release_drag_velocity,
                pet_overlay::desktop_pet_overlay_apply_momentum_delta,
                pet_overlay::desktop_pet_overlay_end_drag_session,
                pet_overlay::desktop_pet_overlay_reset_position,
                pet_overlay::emit_desktop_pet_overlay_interaction_result,
                pet_overlay::desktop_pet_overlay_show_main_window,
                system_tasks::start_system_task,
                system_tasks::cancel_system_task,
                system_tasks::get_system_task_snapshot,
                system_tasks::system_tasks_open_log_path,
                system_tasks::respond_system_task_prompt,
                window_chrome::desktop_get_window_chrome_policy,
                window_chrome::desktop_set_native_title_bar,
                window_chrome::desktop_get_window_state,
                window_chrome::desktop_minimize_window,
                window_chrome::desktop_toggle_window_maximize,
                window_chrome::desktop_close_window,
                window_chrome::desktop_show_main_window,
                window_chrome::desktop_start_window_dragging,
                shutdown::desktop_finish_shutdown
            ]);
    }

    builder
        .setup(|app| {
            #[cfg(desktop)]
            {
                // Windows/Linux already present the window through the single-instance callback.
                #[cfg(target_os = "macos")]
                {
                    use tauri_plugin_deep_link::DeepLinkExt;
                    let handle = app.handle().clone();
                    app.deep_link().on_open_url(move |_event| {
                        window_chrome::request_show_main_window(&handle);
                    });
                }
                system_tasks::set_desktop_bundle_id(&app.config().identifier);
                autostart::register(app)?;
                menu_bar::prepare_launch(app.handle());
                // The main window first (unless this is a login start in menu-bar mode), so the
                // tray can follow its theme events on Windows.
                window_chrome::register(app)?;
                tray::register(app)?;
                pet_overlay::register(app)?;
                dock_icon::apply();
                menu_bar::register(app.handle());
            }

            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;

            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            #[cfg(desktop)]
            match event {
                tauri::RunEvent::ExitRequested { code, ref api, .. } => {
                    if shutdown::handle_exit_requested(app_handle, code) {
                        api.prevent_exit();
                    }
                }
                tauri::RunEvent::Ready => {
                    startup::emit_ready(app_handle);
                    window_chrome::present_main_window_for_lifecycle_event(
                        app_handle,
                        window_chrome::DesktopMainWindowLifecycleEvent::AppReady,
                    );
                }
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Reopen {
                    has_visible_windows,
                    ..
                } => {
                    window_chrome::present_main_window_for_lifecycle_event(
                        app_handle,
                        window_chrome::DesktopMainWindowLifecycleEvent::MacOsReopen {
                            has_visible_windows,
                        },
                    );
                }
                _ => {}
            }
        });
}

#[cfg(desktop)]
mod desktop_dialog {
    use tauri::AppHandle;
    use tauri_plugin_dialog::DialogExt;
    use tokio::sync::oneshot;

    #[tauri::command]
    pub async fn desktop_pick_ssh_identity_file(app: AppHandle) -> Result<Option<String>, String> {
        let (tx, rx) = oneshot::channel::<Option<String>>();

        app.dialog().file().pick_file(move |path| {
            let _ = tx.send(path.map(|p| p.to_string()));
        });

        rx.await
            .map_err(|_| "Failed to receive dialog selection".to_string())
    }
}

#[cfg(desktop)]
mod app_updates {
    //! The desktop app's one updater adapter. Checking, downloading and installing are three
    //! separate steps so the app can show a real download percentage and let the person choose
    //! when to restart ("Restart to update"): a download never restarts anything.
    pub mod relaunch;

    use serde::Serialize;
    use std::sync::Mutex;
    use tauri::{AppHandle, Emitter, Manager, State};
    use tauri_plugin_updater::{Update, UpdaterExt};

    /// Emitted while `desktop_download_update` runs, once per whole percent (only when the server
    /// sent a length — an unknown length stays indeterminate rather than guessed).
    pub const DOWNLOAD_PROGRESS_EVENT: &str = "desktop_update_download_progress";

    #[derive(Default)]
    pub struct PendingUpdateState {
        /// The update the last check offered.
        offered: Option<Update>,
        /// The verified package for `offered`, kept until it is installed.
        downloaded: Option<(Update, Vec<u8>)>,
    }

    #[derive(Default)]
    pub struct PendingUpdate(pub Mutex<PendingUpdateState>);

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct UpdateMetadata {
        pub version: String,
        pub current_version: String,
        pub notes: Option<String>,
        pub pub_date: Option<String>,
        /// The offered version is already downloaded and verified: only a restart is left.
        pub downloaded: bool,
    }

    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct DownloadProgress {
        pub version: String,
        pub downloaded_bytes: u64,
        pub total_bytes: u64,
    }

    fn poisoned() -> String {
        "PendingUpdate poisoned".to_string()
    }

    /// Whole percent of `downloaded` out of `total`, `None` when the length is unknown.
    pub(crate) fn whole_percent(downloaded: u64, total: Option<u64>) -> Option<u64> {
        match total {
            Some(total) if total > 0 => Some(downloaded.min(total).saturating_mul(100) / total),
            _ => None,
        }
    }

    #[tauri::command]
    pub async fn desktop_fetch_update(
        app: AppHandle,
        pending_update: State<'_, PendingUpdate>,
    ) -> Result<Option<UpdateMetadata>, String> {
        let update = app
            .updater()
            .map_err(|e| e.to_string())?
            .check()
            .await
            .map_err(|e| e.to_string())?;

        let mut state = pending_update.0.lock().map_err(|_| poisoned())?;
        // A package already downloaded for the version still on offer stays ready to install.
        let keep_download = matches!(
            (&state.downloaded, &update),
            (Some((downloaded, _)), Some(offered)) if downloaded.version == offered.version
        );
        if !keep_download {
            state.downloaded = None;
        }
        let metadata = update.as_ref().map(|u| UpdateMetadata {
            version: u.version.clone(),
            current_version: u.current_version.clone(),
            notes: u.body.clone(),
            pub_date: u.date.map(|d| d.to_string()),
            downloaded: keep_download,
        });
        state.offered = update;
        Ok(metadata)
    }

    /// Downloads and verifies the offered update without installing it. `false` when nothing is
    /// on offer (the check has to run first).
    #[tauri::command]
    pub async fn desktop_download_update(
        app: AppHandle,
        pending_update: State<'_, PendingUpdate>,
    ) -> Result<bool, String> {
        let update = {
            let state = pending_update.0.lock().map_err(|_| poisoned())?;
            if let Some((downloaded, _)) = &state.downloaded {
                if state
                    .offered
                    .as_ref()
                    .is_some_and(|offered| offered.version == downloaded.version)
                {
                    return Ok(true);
                }
            }
            match &state.offered {
                Some(update) => update.clone(),
                None => return Ok(false),
            }
        };

        let version = update.version.clone();
        let mut downloaded_bytes: u64 = 0;
        let mut last_percent: Option<u64> = None;
        let bytes = update
            .download(
                |chunk_len, content_len| {
                    downloaded_bytes = downloaded_bytes.saturating_add(chunk_len as u64);
                    let percent = whole_percent(downloaded_bytes, content_len);
                    if percent.is_some() && percent != last_percent {
                        last_percent = percent;
                        let _ = app.emit(
                            DOWNLOAD_PROGRESS_EVENT,
                            DownloadProgress {
                                version: version.clone(),
                                downloaded_bytes,
                                total_bytes: content_len.unwrap_or(0),
                            },
                        );
                    }
                },
                || {},
            )
            .await
            .map_err(|e| e.to_string())?;

        let mut state = pending_update.0.lock().map_err(|_| poisoned())?;
        state.downloaded = Some((update, bytes));
        Ok(true)
    }

    /// Installs the downloaded update and restarts the app. `false` when nothing was downloaded.
    /// A failed install keeps the package, so Retry does not download it again.
    #[tauri::command]
    pub async fn desktop_install_update(
        app: AppHandle,
        pending_update: State<'_, PendingUpdate>,
    ) -> Result<bool, String> {
        let downloaded = pending_update
            .0
            .lock()
            .map_err(|_| poisoned())?
            .downloaded
            .take();
        let (update, bytes) = match downloaded {
            Some(downloaded) => downloaded,
            None => return Ok(false),
        };

        let install_result = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())
            .and_then(|dir| {
                relaunch::install_with_relaunch_marker(
                    &dir,
                    &app.package_info().version.to_string(),
                    || update.install(&bytes).map_err(|error| error.to_string()),
                )
            });
        if let Err(error) = install_result {
            if let Ok(mut state) = pending_update.0.lock() {
                state.downloaded = Some((update, bytes));
            }
            return Err(error);
        }

        // On Windows the plugin already exited; other platforms reuse the args on this restart.
        app.restart()
    }

    #[cfg(test)]
    mod tests {
        use super::whole_percent;

        #[test]
        fn download_progress_is_a_whole_percent_only_when_the_length_is_known() {
            assert_eq!(whole_percent(0, Some(200)), Some(0));
            assert_eq!(whole_percent(99, Some(200)), Some(49));
            assert_eq!(whole_percent(200, Some(200)), Some(100));
            assert_eq!(whole_percent(250, Some(200)), Some(100));
            assert_eq!(whole_percent(10, None), None);
            assert_eq!(whole_percent(10, Some(0)), None);
        }
    }
}
