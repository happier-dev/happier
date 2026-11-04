#[cfg(desktop)]
include!("../desktop_commands.rs");

#[cfg(desktop)]
macro_rules! desktop_invoke_handler {
    ($($commands:tt)*) => {
        tauri::generate_handler![$($commands)*]
    };
}

#[cfg(desktop)]
mod autostart;

#[cfg(desktop)]
mod background_command;

#[cfg(desktop)]
mod dock_icon;

#[cfg(desktop)]
mod desktop_exit_policy;
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
mod window_sizing;

#[cfg(desktop)]
mod window_chrome;

#[cfg(desktop)]
mod activity_overlay;

#[cfg(desktop)]
mod desktop_panel;

#[cfg(desktop)]
mod desktop_window;

#[cfg(desktop)]
mod capture_window;

#[cfg(desktop)]
mod app_window;

#[cfg(desktop)]
mod capture;

#[cfg(desktop)]
mod web_runtime_config;

#[cfg(desktop)]
mod desktop_boot_credentials;

#[cfg(desktop)]
mod iroh;

#[cfg(any(desktop, test))]
mod secure_storage;

#[cfg(any(desktop, test))]
mod desktop_downloads;

#[cfg(any(desktop, test))]
mod browser;

#[cfg(any(desktop, test))]
mod hosted_artifact_desktop;

#[cfg(all(debug_assertions, not(target_os = "windows")))]
mod mcp_bridge;

#[cfg(target_os = "linux")]
mod linux_webkit_env;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    linux_webkit_env::apply_before_gtk_init();

    #[cfg(target_os = "macos")]
    happier_desktop_native::capture::macos::initialize_frontmost_tracking();
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        menu_bar::on_second_launch(app, args);
    }));
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_deep_link::init());
    let mut builder = builder
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(desktop)]
    if let Some(init_script) =
        web_runtime_config::build_desktop_web_runtime_config_init_script_from_env()
    {
        builder = builder.append_invoke_initialization_script(init_script);
    }

    #[cfg(desktop)]
    if let Some(init_script) =
        web_runtime_config::build_personal_home_qa_observer_init_script_from_env()
    {
        builder = builder.append_invoke_initialization_script(init_script);
    }

    #[cfg(debug_assertions)]
    {
        if std::env::var("HAPPIER_TAURI_QA_BOOT_OBSERVER").as_deref() == Ok("1") {
            builder = builder.append_invoke_initialization_script(
                include_str!("desktop_boot_observer.js").to_string(),
            );
        }
    }

    #[cfg(all(debug_assertions, not(target_os = "windows")))]
    {
        builder = builder.plugin(mcp_bridge::build_debug_mcp_bridge_plugin());
    }

    #[cfg(target_os = "macos")]
    {
        builder = builder.plugin(tauri_nspanel::init());
    }

    #[cfg(desktop)]
    {
        builder = builder
            .on_menu_event(menu::handle_menu_event)
            .manage(menu_bar::MenuBarState::default())
            .manage(desktop_lifecycle::DesktopShutdownState::default())
            .manage(app_updates::PendingUpdate::default())
            .manage(system_tasks::SystemTasksState::default())
            .manage(desktop_downloads::DesktopDownloadsState::default())
            .manage(capture::CaptureState::default())
            .manage(window_sizing::WindowSizingState::default())
            .manage(app_window::AppWindowState::default())
            .manage(activity_overlay::ActivityOverlayState::default())
            .manage(pet_overlay::DesktopPetOverlayState::default())
            .manage(browser::DesktopBrowserState::default())
            .manage(hosted_artifact_desktop::DesktopHostedArtifactState::default())
            .invoke_handler(with_desktop_commands!(desktop_invoke_handler));
    }

    #[cfg(target_os = "macos")]
    {
        builder = builder.menu(menu::build_app_menu);
    }
    builder
        .setup(|app| {
            #[cfg(target_os = "macos")]
            desktop_lifecycle::install_native_quit(app.handle());
            #[cfg(desktop)]
            {
                system_tasks::set_desktop_bundle_id(&app.config().identifier);
                autostart::register(app)?;
                tray::register(app)?;
                menu_bar::prepare_launch(app.handle());
                menu_bar::register(app.handle());
                window_chrome::register(app)?;
                capture::shortcuts::install(app.handle());
                capture::triggers::install_deep_links(app.handle());
                if !menu_bar::is_active(app.handle()) {
                    dock_icon::apply();
                }
                activity_overlay::register(app)?;
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
                tauri::RunEvent::Ready => {
                    if !capture::triggers::cold_launch_is_capture_only(app_handle) {
                        window_chrome::present_main_window_for_lifecycle_event(
                            app_handle,
                            window_chrome::DesktopMainWindowLifecycleEvent::AppReady,
                        );
                    }
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
                tauri::RunEvent::ExitRequested { api, code, .. } => {
                    if desktop_lifecycle::handle_exit_requested(app_handle, code) {
                        api.prevent_exit();
                    } else {
                        app_window::preserve_for_quit(app_handle);
                    }
                }
                tauri::RunEvent::WindowEvent { event: tauri::WindowEvent::Focused(true), .. } => {
                    capture::refresh_consumed_permissions(app_handle);
                }
                tauri::RunEvent::WindowEvent { label, event: tauri::WindowEvent::Destroyed, .. } => {
                    capture::remove_permission_window(app_handle, &label);
                    capture::close_recents_for_window(&tauri::Manager::state::<capture::CaptureState>(app_handle), &label);
                }
                // Best-effort teardown of the shared Iroh process endpoint on
                // final application shutdown; the persistent identity key is
                // retained so restarts reuse the same endpoint identity.
                tauri::RunEvent::Exit => {
                    capture::shortcuts::shutdown(app_handle);
                    iroh::shutdown_process_endpoint(app_handle);
                }
                _ => {}
            }
        });
}

#[cfg(desktop)]
mod desktop_dialog;

#[cfg(desktop)]
mod app_updates {
    //! The desktop app's one updater adapter. Checking, downloading and installing are three
    //! separate steps so the app can show a real download percentage and let the person choose
    //! when to restart ("Restart to update"): a download never restarts anything.
    pub(crate) mod relaunch;
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

        let installed = app
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
        if let Err(error) = installed {
            if let Ok(mut state) = pending_update.0.lock() {
                state.downloaded = Some((update, bytes));
            }
            return Err(error.to_string());
        }

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

#[cfg(desktop)]
mod desktop_lifecycle;
