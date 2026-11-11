//! Windows toast notifications that can be clicked.
//!
//! `tauri-plugin-notification` has no click callback on desktop, so on Windows the toast is shown
//! here (through the same WinRT crate the plugin uses) with an activation handler. A click brings
//! the main window to the front and tells the UI which session the notification was about.

#[cfg(desktop)]
pub const DESKTOP_NOTIFICATION_CLICKED_EVENT: &str = "desktop-notification-clicked";

#[cfg(desktop)]
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopNotificationClickedPayload {
    pub session_id: Option<String>,
}

/// Returns `true` when this platform showed the toast itself (Windows). Other platforms return
/// `false` and the UI falls back to the notification plugin.
#[cfg(desktop)]
#[tauri::command]
pub fn desktop_show_clickable_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
    session_id: Option<String>,
) -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        use tauri::Emitter;

        let app_id = app.config().identifier.clone();
        // An un-installed dev build has no registered AUMID, so Windows would drop the toast.
        let app_id = if cfg!(debug_assertions) {
            tauri_winrt_notification::Toast::POWERSHELL_APP_ID.to_string()
        } else {
            app_id
        };
        let handle = app.clone();
        tauri_winrt_notification::Toast::new(&app_id)
            .title(&title)
            .text1(&body)
            .on_activated(move |_action| {
                crate::window_chrome::request_show_main_window(&handle);
                if let Err(error) = handle.emit(
                    DESKTOP_NOTIFICATION_CLICKED_EVENT,
                    DesktopNotificationClickedPayload {
                        session_id: session_id.clone(),
                    },
                ) {
                    log::warn!("failed to emit the notification click: {error}");
                }
                Ok(())
            })
            .show()
            .map_err(|error| error.to_string())?;
        Ok(true)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, title, body, session_id);
        Ok(false)
    }
}
