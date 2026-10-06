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
mod web_runtime_config;

#[cfg(desktop)]
mod desktop_boot_credentials;

#[cfg(desktop)]
mod iroh;

#[cfg(any(desktop, test))]
mod secure_storage;

#[cfg(any(desktop, test))]
mod browser;

#[cfg(any(desktop, test))]
mod hosted_artifact_desktop;

#[cfg(debug_assertions)]
mod mcp_bridge;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
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
            .manage(window_sizing::WindowSizingState::default())
            .manage(activity_overlay::ActivityOverlayState::default())
            .manage(pet_overlay::DesktopPetOverlayState::default())
            .manage(browser::DesktopBrowserState::default())
            .manage(hosted_artifact_desktop::DesktopHostedArtifactState::default())
            .invoke_handler(tauri::generate_handler![
                app_updates::desktop_fetch_update,
                app_updates::desktop_download_update,
                app_updates::desktop_install_update,
                desktop_dialog::desktop_pick_ssh_identity_file,
                desktop_dialog::desktop_pick_personal_home_backup_archive,
                desktop_dialog::desktop_save_personal_home_backup_archive,
                desktop_lifecycle::desktop_finish_shutdown,
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
                system_tasks::system_tasks_reveal_output_path,
                system_tasks::respond_system_task_prompt,
                window_chrome::desktop_get_window_chrome_policy,
                window_chrome::desktop_get_window_state,
                window_chrome::desktop_get_glass_state,
                window_chrome::desktop_apply_glass_material,
                window_chrome::desktop_open_reduce_transparency_settings,
                window_chrome::desktop_minimize_window,
                window_chrome::desktop_toggle_window_maximize,
                window_chrome::desktop_close_window,
                window_chrome::desktop_show_main_window,
                window_chrome::desktop_start_window_dragging,
                window_sizing::desktop_set_window_mode,
                desktop_boot_credentials::desktop_read_stack_boot_credentials,
                iroh::iroh_ensure_home_tunnel,
                iroh::iroh_release_home_tunnel,
                iroh::iroh_get_tunnel_status,
                iroh::iroh_get_availability,
                iroh::iroh_get_application_endpoint,
                iroh::iroh_start_machine_tunnel,
                iroh::iroh_start_machine_http_tunnel,
                iroh::iroh_stop_machine_tunnel,
                secure_storage::desktop_secure_storage_read,
                secure_storage::desktop_secure_storage_write,
                secure_storage::desktop_secure_storage_remove,
                browser::desktop_browser_get_availability,
                browser::desktop_browser_open_view,
                browser::desktop_browser_navigate,
                browser::desktop_browser_set_bounds,
                browser::desktop_browser_set_pointer_passthrough,
                browser::desktop_browser_close_view,
                browser::desktop_browser_open_devtools,
                browser::desktop_browser_get_page_info,
                browser::desktop_browser_capture_snapshot,
                browser::desktop_browser_capture_recording_frame,
                browser::desktop_browser_drain_diagnostics,
                browser::desktop_browser_eval_script,
                browser::desktop_browser_dispatch_navigation,
                hosted_artifact_desktop::desktop_hosted_artifact_get_frame_capability,
                hosted_artifact_desktop::desktop_hosted_artifact_register,
                hosted_artifact_desktop::desktop_hosted_artifact_unregister,
                hosted_artifact_desktop::desktop_hosted_artifact_cache_read,
                hosted_artifact_desktop::desktop_hosted_artifact_cache_write,
                hosted_artifact_desktop::desktop_hosted_artifact_cache_describe,
                hosted_artifact_desktop::desktop_hosted_artifact_cache_remove,
                hosted_artifact_desktop::desktop_hosted_artifact_cache_remove_account,
                hosted_artifact_desktop::desktop_hosted_artifact_open_view,
                hosted_artifact_desktop::desktop_hosted_artifact_set_bounds,
                hosted_artifact_desktop::desktop_hosted_artifact_post_message,
                hosted_artifact_desktop::desktop_hosted_artifact_go_back,
                hosted_artifact_desktop::desktop_hosted_artifact_close_view,
                activity_overlay::desktop_activity_overlay_sync,
                activity_overlay::desktop_activity_overlay_get_window_state,
                activity_overlay::desktop_activity_overlay_set_expanded,
                activity_overlay::desktop_activity_overlay_set_input_locked,
                activity_overlay::desktop_activity_overlay_apply_drag_delta,
                activity_overlay::desktop_activity_overlay_release_drag_velocity,
                activity_overlay::desktop_activity_overlay_apply_momentum_delta,
                activity_overlay::desktop_activity_overlay_reset_position,
                activity_overlay::desktop_activity_overlay_emit_interaction,
                activity_overlay::desktop_activity_overlay_emit_interaction_result,
            ]);
    }

    #[cfg(target_os = "macos")]
    {
        builder = builder.menu(menu::build_app_menu);
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
                tray::register(app)?;
                menu_bar::prepare_launch(app.handle());
                menu_bar::register(app.handle());
                window_chrome::register(app)?;
                if !menu_bar::is_active(app.handle()) {
                    dock_icon::apply();
                }
                activity_overlay::register(app)?;
                pet_overlay::register(app)?;
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
                tauri::RunEvent::ExitRequested { api, code, .. } => {
                    if desktop_lifecycle::handle_exit_requested(app_handle, code) {
                        api.prevent_exit();
                    }
                }
                // Best-effort teardown of the shared Iroh process endpoint on
                // final application shutdown; the persistent identity key is
                // retained so restarts reuse the same endpoint identity.
                tauri::RunEvent::Exit => {
                    iroh::shutdown_process_endpoint(app_handle);
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

    #[tauri::command]
    pub async fn desktop_pick_personal_home_backup_archive(
        app: AppHandle,
    ) -> Result<Option<String>, String> {
        let (tx, rx) = oneshot::channel::<Option<String>>();

        app.dialog()
            .file()
            .set_title("Choose a Personal Home backup")
            .add_filter("Happier Personal Home backup", &["tar"])
            .pick_file(move |path| {
                let _ = tx.send(path.map(|p| p.to_string()));
            });

        rx.await
            .map_err(|_| "Failed to receive backup archive selection".to_string())
    }

    #[tauri::command]
    pub async fn desktop_save_personal_home_backup_archive(
        app: AppHandle,
    ) -> Result<Option<String>, String> {
        let (tx, rx) = oneshot::channel::<Option<String>>();

        app.dialog()
            .file()
            .set_title("Export Personal Home backup")
            .set_file_name("personal-home-backup.tar")
            .add_filter("Happier Personal Home backup", &["tar"])
            .save_file(move |path| {
                let _ = tx.send(path.map(|p| p.to_string()));
            });

        rx.await
            .map_err(|_| "Failed to receive backup destination selection".to_string())
    }
}

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
mod desktop_lifecycle {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    use serde::Serialize;
    use tauri::{AppHandle, Emitter, Manager, State};

    use crate::desktop_exit_policy as policy;

    pub use crate::desktop_exit_policy::QuitIntent;
    use policy::{
        parse_shutdown_outcome, resolve_desktop_exit_action, DesktopExitAction, DesktopExitRequest,
        ShutdownOutcome,
    };

    /// Emitted to the webview when the app is quitting and the handoff is still available.
    pub const APP_EXIT_REQUESTED_EVENT: &str = "desktop_app_exit_requested";

    /// The handoff's payload: which Quit the person chose.
    #[derive(Clone, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct AppExitRequestedPayload {
        /// "Stop background services and quit" — stop them whatever the login-start setting says.
        stop_services: bool,
        /// Last proven mode survives a fresh webview's pending first status read.
        #[serde(skip_serializing_if = "Option::is_none")]
        service_autostart: Option<crate::tray::model::AutostartMode>,
    }

    #[derive(Default)]
    pub struct DesktopShutdownState {
        handoff_used: AtomicBool,
        intent: Mutex<QuitIntent>,
    }

    /// Asks the app to quit the way the person chose; the exit handler hands the choice to the
    /// webview with the one handoff.
    pub fn request_quit(app: &AppHandle, intent: QuitIntent) {
        let state: State<'_, DesktopShutdownState> = app.state();
        if let Ok(mut current) = state.intent.lock() {
            *current = intent;
        }
        app.exit(0);
    }

    /// Called by the webview once it has done whatever the user's answer asked for. `menuBar` keeps a
    /// tray-only process with the services running (R16 a); anything else exits, re-entering the
    /// handler, which now finds the handoff used and lets the app go.
    #[tauri::command]
    pub fn desktop_finish_shutdown(app: AppHandle, outcome: Option<String>) -> Result<(), String> {
        match parse_shutdown_outcome(outcome.as_deref()) {
            ShutdownOutcome::MenuBar => {
                let state: State<'_, DesktopShutdownState> = app.state();
                // The quit is over; the next one (from the tray, or after reopening) starts afresh.
                state.handoff_used.store(false, Ordering::SeqCst);
                crate::menu_bar::enter(&app);
            }
            ShutdownOutcome::Exit => app.exit(0),
        }
        Ok(())
    }

    /// Handles `RunEvent::ExitRequested`. Returns `true` when the caller must hold the exit.
    pub fn handle_exit_requested(app: &AppHandle, code: Option<i32>) -> bool {
        let state: State<'_, DesktopShutdownState> = app.state();
        let request = DesktopExitRequest {
            webview_present: app.get_webview_window("main").is_some(),
            handoff_used: state.handoff_used.load(Ordering::SeqCst),
            is_restart: code == Some(tauri::RESTART_EXIT_CODE),
            menu_bar_mode: crate::menu_bar::is_active(app),
            explicit: code.is_some(),
        };

        match resolve_desktop_exit_action(request) {
            DesktopExitAction::Exit => false,
            DesktopExitAction::StayInMenuBar => true,
            DesktopExitAction::HandOffToWebview => {
                state.handoff_used.store(true, Ordering::SeqCst);
                let intent = state
                    .intent
                    .lock()
                    .map(|mut intent| std::mem::take(&mut *intent))
                    .unwrap_or_default();
                let payload = AppExitRequestedPayload {
                    stop_services: intent == QuitIntent::StopServices,
                    service_autostart: crate::tray::persisted_service_autostart(app),
                };
                // `emit` reports success with zero listeners, so this only fires when the event could
                // not be published at all — never as "nobody is listening". A quit that beats the
                // webview's listener is still held, and is finished by pressing Quit again.
                if app.emit(APP_EXIT_REQUESTED_EVENT, payload).is_err() {
                    return false;
                }
                true
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn quit_handoff_carries_the_last_proven_login_mode_but_omits_unknown_mode() {
            let known = serde_json::to_value(AppExitRequestedPayload {
                stop_services: false,
                service_autostart: Some(crate::tray::model::AutostartMode::AtLogin),
            })
            .unwrap();
            assert_eq!(
                known,
                serde_json::json!({"stopServices": false, "serviceAutostart": "at-login"})
            );
            let unknown = serde_json::to_value(AppExitRequestedPayload {
                stop_services: true,
                service_autostart: None,
            })
            .unwrap();
            assert_eq!(unknown, serde_json::json!({"stopServices": true}));
        }
    }
}
