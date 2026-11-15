//! Windows toast notifications that can be clicked.
//!
//! `tauri-plugin-notification` has no click callback on desktop, so on Windows the toast is shown
//! here through WinRT with protocol activation. Both banners and retained Notification Center
//! items hand their data to the existing app-link/single-instance lifecycle.

#[cfg(any(target_os = "windows", test))]
fn activation_url(
    scheme: &str,
    data: &Option<serde_json::Map<String, serde_json::Value>>,
) -> Result<String, String> {
    let mut url = url::Url::parse(&format!("{scheme}://notification-action/"))
        .map_err(|error| error.to_string())?;
    let payload = serde_json::to_string(data).map_err(|error| error.to_string())?;
    url.query_pairs_mut().append_pair("payload", &payload);
    Ok(url.into())
}

// The outer option distinguishes an unrelated/malformed link from a valid focus-only click.
#[cfg(any(target_os = "windows", test))]
fn decode_activation_url(
    value: &str,
    scheme: &str,
) -> Option<Option<serde_json::Map<String, serde_json::Value>>> {
    let url = url::Url::parse(value).ok()?;
    if url.scheme() != scheme
        || url.host_str() != Some("notification-action")
        || !matches!(url.path(), "" | "/")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let mut pairs = url.query_pairs();
    let (key, payload) = pairs.next()?;
    if key != "payload" || pairs.next().is_some() {
        return None;
    }
    serde_json::from_str(&payload).ok()
}

#[cfg(target_os = "windows")]
fn registered_schemes(app: &tauri::AppHandle) -> impl Iterator<Item = &str> {
    app.config()
        .plugins
        .0
        .get("deep-link")
        .and_then(|config| config.get("desktop"))
        .and_then(|desktop| desktop.get("schemes"))
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
}

/// The existing single-instance and cold-launch owners pass their arguments here. Window
/// restoration remains with that lifecycle; the event only wakes the renderer's one consumer.
#[cfg(target_os = "windows")]
pub fn handle_activation(app: &tauri::AppHandle, value: &str) {
    use tauri::{Emitter, Manager};
    if let Some(data) =
        registered_schemes(app).find_map(|scheme| decode_activation_url(value, scheme))
    {
        if let Ok(mut pending) = app.state::<PendingNotificationData>().0.lock() {
            *pending = data;
        }
        if let Err(error) = app.emit(DESKTOP_NOTIFICATION_CLICKED_EVENT, ()) {
            log::warn!("failed to emit the notification click: {error}");
        }
    }
}

#[cfg(any(target_os = "windows", test))]
fn toast_xml(title: &str, body: &str, launch: &str) -> String {
    fn escape(value: &str) -> String {
        value
            .replace('&', "&amp;")
            .replace('<', "&lt;")
            .replace('>', "&gt;")
            .replace('"', "&quot;")
            .replace('\'', "&apos;")
    }
    format!(
        "<toast activationType=\"protocol\" launch=\"{}\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual></toast>",
        escape(launch), escape(title), escape(body),
    )
}

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
        use windows::{
            core::HSTRING,
            Data::Xml::Dom::XmlDocument,
            UI::Notifications::{ToastNotification, ToastNotificationManager},
        };

        let scheme = registered_schemes(&app)
            .next()
            .ok_or("missing desktop notification activation scheme")?;
        let launch = activation_url(scheme, &data)?;
        let document = XmlDocument::new().map_err(|error| error.to_string())?;
        document
            .LoadXml(&HSTRING::from(toast_xml(&title, &body, &launch)))
            .map_err(|error| error.to_string())?;
        let toast = ToastNotification::CreateToastNotification(&document)
            .map_err(|error| error.to_string())?;
        // Match the installed shortcut identity, including in isolated development QA.
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(
            &app.config().identifier,
        ))
        .and_then(|notifier| notifier.Show(&toast))
        .map_err(|error| error.to_string())?;
        Ok(true)
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (app, title, body, data);
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retained_activation_round_trips_original_data_and_windows_root_normalization() {
        let data = Some(
            serde_json::from_value(serde_json::json!({
                "sessionId": "session with & / Unicode 🦀",
                "serverUrl": "https://home.example/path?one=1&two=2",
                "accountId": "account", "requestId": "request", "future": {"enabled": true}
            }))
            .unwrap(),
        );
        for scheme in ["happier", "happier-preview", "happier-dev"] {
            let launch = activation_url(scheme, &data).unwrap();
            assert_eq!(decode_activation_url(&launch, scheme), Some(data.clone()));
            assert_eq!(
                decode_activation_url(
                    &launch.replace("notification-action/", "notification-action"),
                    scheme
                ),
                Some(data.clone())
            );
            assert_eq!(decode_activation_url(&launch, "another-channel"), None);
        }
        let launch = activation_url("happier-dev", &None).unwrap();
        assert_eq!(decode_activation_url(&launch, "happier-dev"), Some(None));
    }

    #[test]
    fn activation_rejects_other_routes_and_ambiguous_payloads() {
        let valid = activation_url("happier-dev", &None).unwrap();
        for invalid in [
            valid.replace("notification-action/", "notification-action/child"),
            valid.replace("notification-action", "other-route"),
            valid.replace("://", "://user@"),
            valid.replace("notification-action/", "notification-action:123/"),
            format!("{valid}#fragment"),
            format!("{valid}&payload=null"),
            format!("{valid}&other=value"),
            valid.replace("payload=null", "payload=[]"),
            valid.replace("payload=null", "payload=invalid"),
        ] {
            assert_eq!(
                decode_activation_url(&invalid, "happier-dev"),
                None,
                "{invalid}"
            );
        }
    }

    #[test]
    fn toast_uses_protocol_activation_and_escapes_xml_presentation() {
        let launch = activation_url("happier-dev", &None).unwrap();
        let xml = toast_xml("Title < & \" '", "Body >", &launch);
        assert!(xml.starts_with("<toast activationType=\"protocol\" launch=\"happier-dev://notification-action/?payload=null\">"));
        assert!(xml.contains("<text>Title &lt; &amp; &quot; &apos;</text>"));
        assert!(xml.contains("<text>Body &gt;</text>"));
    }
}
