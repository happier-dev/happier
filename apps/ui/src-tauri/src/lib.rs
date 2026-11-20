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
mod desktop_startup;
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
mod first_open;

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
mod desktop_notifications;

#[cfg(desktop)]
mod iroh;

#[cfg(any(desktop, test))]
mod secure_storage;

#[cfg(any(desktop, test))]
mod desktop_http;

#[cfg(any(desktop, test))]
mod desktop_downloads;

#[cfg(any(desktop, test))]
mod desktop_workspace_file;

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
    let context = tauri::generate_context!();
    #[cfg(target_os = "linux")]
    linux_webkit_env::apply_before_gtk_init();

    #[cfg(desktop)]
    if std::env::args_os().skip(1).any(|arg| arg == "--uninstall-desktop-components") {
        #[cfg(target_os = "windows")]
        if let Err(error) = single_instance::ensure_no_running_desktop(&context.config().identifier) {
            eprintln!("{error}");
            std::process::exit(1);
        }
        // No single-instance forwarding, webviews, tray, or setup acquisition.
        // Windows installers wait for this process before removing its bundled helper.
        let result = tauri::Builder::default()
            // Register the existing login-item adapter so cleanup can remove this app's
            // registration. Registering the adapter never enables a login item.
            .setup(|app| {
                autostart::register(app)?;
                Ok(())
            })
            .build(context)
            .map_err(|error| format!("Unable to initialize desktop cleanup: {error}"))
            .and_then(|app| system_tasks::uninstall_desktop_components(app.handle()));
        if let Err(error) = result {
            eprintln!("{error}");
            std::process::exit(1);
        }
        std::process::exit(0);
    }

    #[cfg(desktop)]
    desktop_notifications::prepare();

    #[cfg(target_os = "macos")]
    happier_desktop_native::capture::macos::initialize_frontmost_tracking();
    let builder = tauri::Builder::default();
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
        #[cfg(target_os = "windows")]
        for argument in &args {
            desktop_notifications::handle_activation(app, argument);
        }
        menu_bar::on_second_launch(app, args);
    }));
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_deep_link::init());
    let mut builder = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init());

    #[cfg(desktop)]
    {
        builder = builder.append_invoke_initialization_script(
            browser::desktop_browser_availability_init_script(),
        );
    }

    #[cfg(desktop)]
    if let Some(init_script) =
        web_runtime_config::build_desktop_web_runtime_config_init_script_from_env()
    {
        // Plugin scripts run at document start after Tauri publishes the native window label.
        builder = builder.plugin(
            tauri::plugin::Builder::<_, ()>::new("desktop-web-runtime-config")
                .js_init_script(init_script)
                .build(),
        );
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
            .manage(first_open::FirstOpenState::default())
            .manage(app_window::AppWindowState::default())
            .manage(activity_overlay::ActivityOverlayState::default())
            .manage(pet_overlay::DesktopPetOverlayState::default())
            .manage(browser::DesktopBrowserState::default())
            .manage(desktop_notifications::DesktopNotificationState::default())
            .manage(hosted_artifact_desktop::DesktopHostedArtifactState::default())
            .manage(secure_storage::DesktopSecureStorage::for_build(&context.config().identifier))
            .manage(desktop_http::DesktopHttp::default())
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
                system_tasks::set_desktop_context(app.handle())?;
                menu_bar::prepare_launch(app.handle());
                let unavailable = desktop_startup::setup(
                    tray::model::MenuPlatform::current(),
                    menu_bar::launched_in_menu_bar_mode(app.handle()),
                    cfg!(debug_assertions),
                    |step| match step {
                        desktop_startup::Step::Autostart => autostart::register(app),
                        desktop_startup::Step::Tray => tray::register(app),
                        desktop_startup::Step::MainWindow => {
                            menu_bar::register(app.handle());
                            window_chrome::register(app)?;
                            capture::shortcuts::install(app.handle());
                            capture::triggers::install_deep_links(app.handle());
                            if !menu_bar::is_active(app.handle()) {
                                dock_icon::apply();
                            }
                            Ok(())
                        }
                        desktop_startup::Step::ActivityOverlay => activity_overlay::register(app),
                        desktop_startup::Step::Updater => app.handle()
                            .plugin(tauri_plugin_updater::Builder::new().build()),
                        desktop_startup::Step::DebugLog => app.handle().plugin(
                            tauri_plugin_log::Builder::default()
                                .level(log::LevelFilter::Info)
                                .build(),
                        ),
                    },
                )?;
                for failure in &unavailable {
                    log::warn!("desktop {:?} unavailable: {}", failure.capability, failure.reason);
                    if failure.capability == desktop_startup::Step::Updater {
                        use tauri::Manager;
                        app.state::<app_updates::PendingUpdate>()
                            .record_setup_failure(failure.reason.clone());
                    }
                }
                if !unavailable.is_empty() {
                    tray::update_model(app.handle(), |model| {
                        model.notice = Some(
                            unavailable.iter()
                                .map(|failure| failure.reason.clone())
                                .collect::<Vec<_>>()
                                .join("; "),
                        );
                    });
                }
                desktop_notifications::install(app.handle());
            }

            #[cfg(not(desktop))]
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .build(context)
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            #[cfg(desktop)]
            if let tauri::RunEvent::WindowEvent { label, event, .. } = &event {
                first_open::on_window_event(app_handle, label, event);
            }
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
                        window_sizing::preserve_for_quit(app_handle);
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
                    window_sizing::flush_window_frames(app_handle);
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
        setup_error: Option<String>,
        /// The update the last check offered.
        offered: Option<Update>,
        /// The verified package for `offered`, kept until it is installed.
        downloaded: Option<(Update, Vec<u8>)>,
    }

    #[derive(Default)]
    pub struct PendingUpdate(pub Mutex<PendingUpdateState>);

    impl PendingUpdate {
        pub(super) fn record_setup_failure(&self, reason: String) {
            if let Ok(mut state) = self.0.lock() {
                state.setup_error = Some(reason);
            }
        }
    }

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
        // UpdaterExt assumes successful plugin registration and panics on missing state.
        if let Some(reason) = pending_update.0.lock().map_err(|_| poisoned())?.setup_error.clone() {
            return Err(reason);
        }
        let updater = app.updater_builder();
        #[cfg(target_os = "windows")]
        let updater = {
            let app = app.clone();
            updater.on_before_exit(move || {
                // Windows installation exits without the ordinary Tauri exit events.
                crate::window_sizing::preserve_for_quit(&app);
                app.cleanup_before_exit();
            })
        };
        let update = updater
            .build()
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

#[cfg(any(target_os = "windows", test))]
mod single_instance;
