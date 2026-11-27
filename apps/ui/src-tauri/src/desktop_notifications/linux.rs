use std::sync::Arc;

use notify_rust::{Hint, Notification, NotificationHandle, NotificationResponse};
use tauri::AppHandle;

use super::{emit_action, DesktopNotification};

pub struct Presented {
    handle: Arc<NotificationHandle>,
    response: tauri::async_runtime::JoinHandle<()>,
}

pub async fn show(
    app: &AppHandle,
    notification: &DesktopNotification,
) -> Result<Presented, String> {
    let mut native = Notification::new();
    native
        .appname("Happier")
        .summary(&notification.title)
        .body(&notification.body)
        .action("default", "");
    if notification.silent {
        native.hint(Hint::SuppressSound(true));
    }
    for action in &notification.actions {
        native.action(&action.id, &action.title);
    }
    let handle = Arc::new(
        native
            .show_async()
            .await
            .map_err(|error| error.to_string())?,
    );
    // Keep the sending connection alive (GNOME ties visibility to that connection).
    let receiver = Arc::clone(&handle);
    let app = app.clone();
    let notification = notification.clone();
    let response = tauri::async_runtime::spawn(async move {
        receiver
            .wait_for_action_async(|response| {
                let action = match response {
                    NotificationResponse::Default => "default",
                    NotificationResponse::Action(action) => action,
                    _ => return,
                };
                emit_action(Some(&app), &notification, action);
            })
            .await;
    });
    Ok(Presented { handle, response })
}

pub async fn remove(_app: &AppHandle, _identifier: &str) -> Result<(), String> {
    // XDG handles belong to the original sending connection; after exit no callback survives.
    Ok(())
}

impl Presented {
    pub async fn close(&self, _app: &AppHandle) -> Result<(), String> {
        self.handle.close_async().await;
        self.response.abort();
        Ok(())
    }
}
