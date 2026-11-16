//! Actionable notifications are a transport. Guard authority stays in the UI Action route.
use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::Mutex;

#[cfg(target_os = "linux")]
#[path = "desktop_notifications/linux.rs"]
mod platform;
#[cfg(target_os = "macos")]
#[path = "desktop_notifications/macos.rs"]
mod platform;
#[cfg(target_os = "windows")]
#[path = "desktop_notifications/windows.rs"]
mod platform;

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NotificationAction {
    pub id: String,
    // Presentation is already in the OS notification; launch payloads need routing only.
    #[serde(default, skip_serializing)]
    pub title: String,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DesktopNotification {
    pub identifier: String,
    #[serde(rename = "accountId")]
    pub account_id: String,
    #[serde(default, skip_serializing)]
    pub title: String,
    #[serde(default, skip_serializing)]
    pub body: String,
    pub data: serde_json::Map<String, Value>,
    pub actions: Vec<NotificationAction>,
}

impl DesktopNotification {
    fn validate(&self) -> Result<(), String> {
        if self.identifier.is_empty() || self.account_id.is_empty() {
            return Err("invalid_notification".into());
        }
        Ok(())
    }

    fn presented(&self) -> Value {
        json!({ "request": { "identifier": self.identifier, "content": { "data": self.data, "accountId": self.account_id } } })
    }

    fn response(&self, action: &str) -> Option<Value> {
        if action != "default" && !self.actions.iter().any(|candidate| candidate.id == action) {
            return None;
        }
        Some(json!({ "actionIdentifier": action, "notification": self.presented() }))
    }

    #[cfg(any(target_os = "windows", test))]
    fn activation_url(&self, action: &str, scheme: &str) -> Option<String> {
        self.response(action)?;
        let payload = serde_json::to_string(&(self, action)).ok()?;
        let mut url = url::Url::parse(&format!("{scheme}://notification-action")).ok()?;
        url.query_pairs_mut().append_pair("payload", &payload);
        Some(url.into())
    }
}

#[cfg(any(target_os = "windows", test))]
fn activation_schemes(config: &tauri::Config) -> impl Iterator<Item = &str> {
    config.plugins.0.get("deep-link")
        .and_then(|plugin| plugin.get("desktop"))
        .and_then(|desktop| desktop.get("schemes"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
}

#[cfg(any(target_os = "windows", test))]
fn decode_activation_url(value: &str, config: &tauri::Config) -> Option<(DesktopNotification, String)> {
    let url = url::Url::parse(value).ok()?;
    if !activation_schemes(config).any(|scheme| scheme == url.scheme())
        || url.host_str() != Some("notification-action")
        || !matches!(url.path(), "" | "/")
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
    {
        return None;
    }
    let mut pairs = url.query_pairs();
    let (key, payload) = pairs.next()?;
    if key != "payload" || pairs.next().is_some() {
        return None;
    }
    let (notification, action): (DesktopNotification, String) =
        serde_json::from_str(&payload).ok()?;
    notification.response(&action)?;
    Some((notification, action))
}

// Bridges native launch callbacks to the authenticated renderer. The OS notification,
// not a second disk store, retains the original envelope across process termination.
static PENDING_RESPONSES: std::sync::Mutex<Vec<Value>> = std::sync::Mutex::new(Vec::new());

pub(super) fn emit_action(
    app: Option<&AppHandle>,
    notification: &DesktopNotification,
    action: &str,
) {
    if let Some(response) = notification.response(action) {
        PENDING_RESPONSES.lock().unwrap().push(response);
        if let Some(app) = app {
            #[cfg(desktop)]
            // A notification click or action: the user asked.
            crate::window_chrome::request_show_main_window(app, crate::window_chrome::MainWindowRevealRequest::User);
            // Events wake the one consumer; draining also recovers pre-subscription arrivals.
            if let Err(error) = app.emit_to("main", "desktop-notification-action", ()) {
                log::warn!("Failed to wake desktop notification response consumer: {error}");
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn read_registered_activation(
    app: &AppHandle,
    value: &str,
) -> Option<(DesktopNotification, String)> {
    decode_activation_url(value, app.config())
}

#[cfg(target_os = "windows")]
pub fn handle_activation(app: &AppHandle, value: &str) {
    if let Some((notification, action)) = read_registered_activation(app, value) {
        emit_action(Some(app), &notification, &action);
    }
}

pub fn prepare() {
    #[cfg(target_os = "macos")]
    platform::prepare();
}

struct Presented {
    #[cfg(target_os = "linux")]
    notification: DesktopNotification,
    native: platform::Presented,
}

#[derive(Default)]
pub struct DesktopNotificationState {
    // Serializes OS acceptance and withdrawal: a removal cannot overtake an in-flight send.
    presented: Mutex<HashMap<String, Presented>>,
}

pub fn install(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    platform::install(app);
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    #[cfg(target_os = "windows")]
    for argument in std::env::args().skip(1) {
        if let Some((notification, action)) = read_registered_activation(app, &argument) {
            // Ready owns cold-launch window construction; this only preserves its input.
            emit_action(None, &notification, &action);
        }
    }
}

#[tauri::command]
pub fn desktop_notification_take_responses() -> Vec<Value> {
    std::mem::take(&mut *PENDING_RESPONSES.lock().unwrap())
}

#[tauri::command]
pub async fn desktop_notification_show(
    app: AppHandle,
    notification: DesktopNotification,
) -> Result<(), String> {
    notification.validate()?;
    let state = app.state::<DesktopNotificationState>();
    let mut presented = state.presented.lock().await;
    if presented.contains_key(&notification.identifier) {
        return Ok(());
    }
    let native = platform::show(&app, &notification).await?;
    presented.insert(
        notification.identifier.clone(),
        Presented {
            #[cfg(target_os = "linux")]
            notification,
            native,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn desktop_notification_remove(app: AppHandle, identifier: String) -> Result<(), String> {
    let state = app.state::<DesktopNotificationState>();
    let mut presented = state.presented.lock().await;
    if let Some(notification) = presented.get(&identifier) {
        notification.native.close(&app).await?;
        presented.remove(&identifier);
    } else {
        platform::remove(&app, &identifier).await?;
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_notification_list(app: AppHandle) -> Result<Vec<Value>, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        let state = app.state::<DesktopNotificationState>();
        let mut presented = state.presented.lock().await;
        let delivered = platform::list(&app).await?;
        let identifiers: std::collections::HashSet<_> = delivered
            .iter()
            .map(|notification| notification.identifier.as_str())
            .collect();
        presented.retain(|identifier, _| identifiers.contains(identifier.as_str()));
        return Ok(delivered
            .iter()
            .map(DesktopNotification::presented)
            .collect());
    }
    #[cfg(target_os = "linux")]
    Ok(app
        .state::<DesktopNotificationState>()
        .presented
        .lock()
        .await
        .values()
        .map(|notification| notification.notification.presented())
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app_config(schemes: &[&str]) -> tauri::Config {
        serde_json::from_value(json!({
            "identifier": "dev.happier.notification-test",
            "plugins": { "deep-link": { "desktop": { "schemes": schemes } } }
        })).unwrap()
    }

    #[test]
    fn click_only_notifications_preserve_the_bound_target_through_activation() {
        let notification: DesktopNotification = serde_json::from_value(json!({
            "identifier": "session-activity:home:s", "accountId": "owner", "title": "Ready", "body": "Finished",
            "data": { "kind": "session", "sessionId": "s", "serverUrl": "https://home.example", "accountId": "owner", "requestId": "request" },
            "actions": []
        })).unwrap();
        assert!(notification.validate().is_ok());
        let activation = notification.activation_url("default", "happier").unwrap();
        let (recovered, action) = decode_activation_url(&activation, &app_config(&["happier"])).unwrap();
        assert_eq!(recovered.response(&action), notification.response("default"));
        assert!(recovered.response("keep").is_none());
        let mut unbound = notification.clone();
        unbound.account_id.clear();
        assert!(unbound.validate().is_err());
        unbound.account_id = "owner".into();
        unbound.identifier.clear();
        assert!(unbound.validate().is_err());
    }

    #[test]
    fn only_an_envelope_action_or_the_default_click_carries_the_original_occurrence() {
        let notification: DesktopNotification = serde_json::from_value(json!({
            "identifier": "home:guard-stop:s:123", "accountId": "owner", "title": "Stopping", "body": "Finished",
            "data": { "stopAt": 123 }, "actions": [{ "id": "keep", "title": "Keep running" }]
        }))
        .unwrap();
        assert_eq!(
            notification.response("keep").unwrap()["notification"]["request"]["content"]["data"]
                ["stopAt"],
            123
        );
        assert_eq!(
            notification.response("default").unwrap()["actionIdentifier"],
            "default"
        );
        assert!(notification.response("arbitrary-action").is_none());
    }

    #[test]
    fn native_activation_roundtrips_each_app_channel_and_rejects_other_actions_and_urls() {
        let original: DesktopNotification = serde_json::from_value(json!({
            "identifier": "home:guard-stop:s:123", "accountId": "owner", "title": "Stopping <work>", "body": "Finished & ready",
            "data": { "serverId": "home", "accountId": "owner", "stopAt": 123 },
            "actions": [{ "id": "keep", "title": "Keep running" }]
        })).unwrap();
        for scheme in ["happier", "happier-preview", "happier-dev"] {
            let config = app_config(&[scheme]);
            let activation = original.activation_url("keep", scheme).unwrap();
            let (recovered, action) = decode_activation_url(&activation, &config).unwrap();
            assert_eq!(action, "keep");
            assert_eq!(recovered.response(&action), original.response("keep"));
            // Windows protocol dispatch normalizes an authority-only URL to a root path.
            let normalized = activation.replace("notification-action?", "notification-action/?");
            let (recovered, action) = decode_activation_url(&normalized, &config).unwrap();
            assert_eq!(recovered.response(&action), original.response("keep"));
            assert!(decode_activation_url(
                &activation.replace("notification-action?", "notification-action/unexpected?"), &config
            )
            .is_none());
            assert!(decode_activation_url(&format!("{activation}&payload=duplicate"), &config).is_none());
            assert!(
                decode_activation_url(&activation.replace("notification-action", "account"), &config)
                    .is_none()
            );
            assert!(decode_activation_url(&activation.replace(scheme, "https"), &config).is_none());
        }
        assert!(original.activation_url("unrecognized", "happier").is_none());
        let mut url = url::Url::parse("happier://notification-action").unwrap();
        url.query_pairs_mut().append_pair(
            "payload",
            &serde_json::to_string(&(&original, "unrecognized")).unwrap(),
        );
        assert!(decode_activation_url(url.as_str(), &app_config(&["happier"])).is_none());
    }

    #[test]
    fn activation_uses_the_apps_configured_scheme_instead_of_a_second_channel_list() {
        let config: tauri::Config = serde_json::from_value(json!({
            "identifier": "dev.happier.notification-test",
            "plugins": { "deep-link": { "desktop": { "schemes": ["happier-notification-test"] } } }
        })).unwrap();
        let notification: DesktopNotification = serde_json::from_value(json!({
            "identifier": "session-activity:home:s", "accountId": "owner",
            "data": { "sessionId": "s", "accountId": "owner" }, "actions": []
        })).unwrap();
        let scheme = config.plugins.0["deep-link"]["desktop"]["schemes"][0].as_str().unwrap();
        let activation = notification.activation_url("default", scheme).unwrap();
        let (recovered, action) = decode_activation_url(&activation, &config).unwrap();
        assert_eq!(recovered.response(&action), notification.response("default"));
        let unconfigured = notification.activation_url("default", "happier-dev").unwrap();
        assert!(decode_activation_url(&unconfigured, &config).is_none());
    }

    #[test]
    fn pre_renderer_arrival_is_consumed_once_without_an_app_handle() {
        let original: DesktopNotification = serde_json::from_value(json!({
            "identifier": "home:guard-stop:s:123", "accountId": "owner", "title": "Stopping", "body": "Finished",
            "data": { "stopAt": 123 }, "actions": [{ "id": "keep", "title": "Keep running" }]
        })).unwrap();
        emit_action(None, &original, "keep");
        assert_eq!(
            desktop_notification_take_responses(),
            vec![original.response("keep").unwrap()]
        );
        assert!(desktop_notification_take_responses().is_empty());
    }
}
