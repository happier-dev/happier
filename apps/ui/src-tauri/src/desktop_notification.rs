//! Windows toast notifications that can be clicked.
//!
//! `tauri-plugin-notification` has no click callback on desktop, so on Windows the toast is shown
//! here (through the same WinRT crate the plugin uses) with an activation handler. A click brings
//! the main window to the front and tells the UI which session the notification was about.

#[cfg(desktop)]
pub const DESKTOP_NOTIFICATION_CLICKED_EVENT: &str = "desktop-notification-clicked";

/// The data of the last clicked toast that the UI has not yet taken. A click can recreate the
/// main window (menu-bar mode), whose page is not listening yet when the event fires; the UI asks
/// for this on start-up instead. The UI owns the notification schema; the shell preserves it.
#[cfg(desktop)]
#[derive(Default)]
pub struct PendingNotificationData(
    std::sync::Mutex<Option<serde_json::Map<String, serde_json::Value>>>,
);

/// Returns and clears the data of a clicked toast the UI has not handled yet.
#[cfg(desktop)]
#[tauri::command]
pub fn desktop_take_pending_notification_data(
    state: tauri::State<'_, PendingNotificationData>,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    state.0.lock().ok().and_then(|mut pending| pending.take())
}

/// Returns `true` when this platform showed the toast itself (Windows). Other platforms return
/// `false` and the UI falls back to the notification plugin.
#[cfg(desktop)]
#[tauri::command]
pub fn desktop_show_clickable_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
    data: Option<serde_json::Map<String, serde_json::Value>>,
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
                {
                    // Cleared by the UI once it has handled the click.
                    use tauri::Manager;
                    if let Ok(mut pending) = handle.state::<PendingNotificationData>().0.lock() {
                        *pending = data.clone();
                    }
                }
                crate::window_chrome::request_show_main_window(&handle);
                // The event only wakes the UI; taking pending data is the sole delivery path.
                if let Err(error) = handle.emit(DESKTOP_NOTIFICATION_CLICKED_EVENT, ()) {
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
        let _ = (app, title, body, data);
        Ok(false)
    }
}
