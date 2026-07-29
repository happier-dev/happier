#[cfg(desktop)]
mod autostart;

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

#[cfg(any(desktop, test))]
mod browser;

#[cfg(debug_assertions)]
mod mcp_bridge;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init());

    #[cfg(desktop)]
    if let Some(init_script) =
        web_runtime_config::build_desktop_web_runtime_config_init_script_from_env()
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
            .manage(app_updates::PendingUpdate::default())
            .manage(system_tasks::SystemTasksState::default())
            .manage(window_sizing::WindowSizingState::default())
            .manage(activity_overlay::ActivityOverlayState::default())
            .manage(pet_overlay::DesktopPetOverlayState::default())
            .manage(browser::DesktopBrowserState::default())
            .invoke_handler(tauri::generate_handler![
                app_updates::desktop_fetch_update,
                app_updates::desktop_install_update,
                desktop_dialog::desktop_pick_ssh_identity_file,
                autostart::desktop_get_autostart_enabled,
                autostart::desktop_set_autostart_enabled,
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
                window_chrome::desktop_get_window_state,
                window_chrome::desktop_minimize_window,
                window_chrome::desktop_toggle_window_maximize,
                window_chrome::desktop_close_window,
                window_chrome::desktop_show_main_window,
                window_chrome::desktop_start_window_dragging,
                window_sizing::desktop_set_window_mode,
                desktop_boot_credentials::desktop_read_stack_boot_credentials,
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

    builder
        .setup(|app| {
            #[cfg(desktop)]
            {
                autostart::register(app)?;
                tray::register(app)?;
                window_chrome::register(app)?;
                window_sizing::register(app)?;
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
    use serde::Serialize;
    use std::sync::Mutex;
    use tauri::{AppHandle, State};
    use tauri_plugin_updater::{Update, UpdaterExt};

    #[derive(Default)]
    pub struct PendingUpdate(pub Mutex<Option<Update>>);

    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct UpdateMetadata {
        pub version: String,
        pub current_version: String,
        pub notes: Option<String>,
        pub pub_date: Option<String>,
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

        let metadata = update.as_ref().map(|u| UpdateMetadata {
            version: u.version.clone(),
            current_version: u.current_version.clone(),
            notes: u.body.clone(),
            pub_date: u.date.map(|d| d.to_string()),
        });

        *pending_update
            .0
            .lock()
            .map_err(|_| "PendingUpdate poisoned".to_string())? = update;
        Ok(metadata)
    }

    #[tauri::command]
    pub async fn desktop_install_update(
        app: AppHandle,
        pending_update: State<'_, PendingUpdate>,
    ) -> Result<bool, String> {
        let update = match pending_update
            .0
            .lock()
            .map_err(|_| "PendingUpdate poisoned".to_string())?
            .take()
        {
            Some(update) => update,
            None => return Ok(false),
        };

        update
            .download_and_install(|_chunk_len, _content_len| {}, || {})
            .await
            .map_err(|e| e.to_string())?;

        app.restart()
    }
}
