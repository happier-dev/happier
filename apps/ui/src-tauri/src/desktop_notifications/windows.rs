use sha2::{Digest, Sha256};
use tauri::AppHandle;
use windows::{
    core::HSTRING,
    Data::Xml::Dom::XmlDocument,
    UI::Notifications::{ToastNotification, ToastNotificationManager},
};

use super::DesktopNotification;

pub struct Presented {
    toast: ToastNotification,
    tag: HSTRING,
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn toast_xml(notification: &DesktopNotification, scheme: &str) -> Result<String, String> {
    let launch = notification
        .activation_url("default", scheme)
        .ok_or("invalid_notification_action")?;
    let actions = notification
        .actions
        .iter()
        .map(|action| {
            let url = notification
                .activation_url(&action.id, scheme)
                .ok_or("invalid_notification_action")?;
            Ok(format!(
                "<action content=\"{}\" arguments=\"{}\" activationType=\"protocol\"/>",
                xml(&action.title),
                xml(&url)
            ))
        })
        .collect::<Result<Vec<_>, String>>()?
        .join("");
    // Protocol activation carries the occurrence through the registered app handler,
    // including when the process that originally presented the toast has exited.
    Ok(format!(
        "<toast activationType=\"protocol\" launch=\"{}\"><visual><binding template=\"ToastGeneric\"><text>{}</text><text>{}</text></binding></visual><actions>{}</actions></toast>",
        xml(&launch), xml(&notification.title), xml(&notification.body), actions
    ))
}

fn tag(identifier: &str) -> HSTRING {
    // Windows limits a toast tag to 16 characters. The occurrence remains in its payload.
    let digest = Sha256::digest(identifier.as_bytes());
    HSTRING::from(
        digest[..8]
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>(),
    )
}

pub async fn show(
    app: &AppHandle,
    notification: &DesktopNotification,
) -> Result<Presented, String> {
    let scheme = app
        .config()
        .plugins
        .0
        .get("deep-link")
        .and_then(|config| config.get("desktop"))
        .and_then(|desktop| desktop.get("schemes"))
        .and_then(serde_json::Value::as_array)
        .and_then(|schemes| schemes.first())
        .and_then(serde_json::Value::as_str)
        .ok_or("notification_activation_unavailable")?;
    let content = toast_xml(notification, scheme)?;
    let result = (|| -> windows::core::Result<Presented> {
        let document = XmlDocument::new()?;
        document.LoadXml(&HSTRING::from(&content))?;
        let toast = ToastNotification::CreateToastNotification(&document)?;
        let tag = tag(&notification.identifier);
        toast.SetTag(&tag)?;
        toast.SetGroup(&HSTRING::from("guard"))?;
        // The installed Start-menu shortcut must carry this same AppUserModelID.
        // Unpackaged apps also require a stub ToastActivatorCLSID on the shortcut
        // for Action Center persistence; protocol activation needs no COM server.
        ToastNotificationManager::CreateToastNotifierWithId(&HSTRING::from(
            &app.config().identifier,
        ))?
        .Show(&toast)?;
        Ok(Presented { toast, tag })
    })();
    result.map_err(|error| error.to_string())
}

pub async fn list(app: &AppHandle) -> Result<Vec<DesktopNotification>, String> {
    let result = (|| -> windows::core::Result<Vec<DesktopNotification>> {
        let history = ToastNotificationManager::History()?
            .GetHistoryWithId(&HSTRING::from(&app.config().identifier))?;
        let mut notifications = Vec::new();
        for index in 0..history.Size()? {
            let toast = history.GetAt(index)?;
            if toast.Group()? != HSTRING::from("guard") {
                continue;
            }
            let launch = toast
                .Content()?
                .DocumentElement()?
                .GetAttribute(&HSTRING::from("launch"))?;
            if let Some((notification, _)) = super::decode_activation_url(&launch.to_string()) {
                notifications.push(notification);
            }
        }
        Ok(notifications)
    })();
    result.map_err(|error| error.to_string())
}

pub async fn remove(app: &AppHandle, identifier: &str) -> Result<(), String> {
    ToastNotificationManager::History()
        .and_then(|history| {
            history.RemoveGroupedTagWithId(
                &tag(identifier),
                &HSTRING::from("guard"),
                &HSTRING::from(&app.config().identifier),
            )
        })
        .map_err(|error| error.to_string())
}

impl Presented {
    pub async fn close(&self, app: &AppHandle) -> Result<(), String> {
        let result = (|| -> windows::core::Result<()> {
            let app_id = HSTRING::from(&app.config().identifier);
            ToastNotificationManager::CreateToastNotifierWithId(&app_id)?.Hide(&self.toast)?;
            ToastNotificationManager::History()?.RemoveGroupedTagWithId(
                &self.tag,
                &HSTRING::from("guard"),
                &app_id,
            )?;
            Ok(())
        })();
        result.map_err(|error| error.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::{core::Interface, Data::Xml::Dom::XmlElement};

    #[test]
    fn notification_text_cannot_add_xml_elements_or_action_attributes() {
        assert_eq!(
            super::xml("<b a='x'>&\""),
            "&lt;b a=&apos;x&apos;&gt;&amp;&quot;"
        );
    }

    #[test]
    fn toast_body_and_buttons_protocol_activate_with_the_original_occurrence() {
        let notification: DesktopNotification = serde_json::from_value(serde_json::json!({
            "identifier": "home:guard-stop:session:123",
            "accountId": "owner",
            "title": "Stopping <session>",
            "body": "Keep \"work\" & continue",
            "data": { "homeId": "home", "accountId": "account", "stopAt": 123 },
            "actions": [
                { "id": "keep", "title": "Keep & continue" },
                { "id": "stop", "title": "Stop now" }
            ]
        }))
        .unwrap();
        for scheme in ["happier", "happier-preview", "happier-dev"] {
            let document = XmlDocument::new().unwrap();
            document
                .LoadXml(&HSTRING::from(toast_xml(&notification, scheme).unwrap()))
                .unwrap();
            let root = document.DocumentElement().unwrap();
            assert_eq!(
                root.GetAttribute(&HSTRING::from("activationType")).unwrap(),
                HSTRING::from("protocol")
            );
            assert_eq!(
                root.GetAttribute(&HSTRING::from("launch")).unwrap(),
                HSTRING::from(notification.activation_url("default", scheme).unwrap())
            );
            let actions = document
                .SelectNodes(&HSTRING::from("/toast/actions/action"))
                .unwrap();
            assert_eq!(actions.Length().unwrap(), 2);
            for (index, action) in notification.actions.iter().enumerate() {
                let element = actions
                    .Item(index as u32)
                    .unwrap()
                    .cast::<XmlElement>()
                    .unwrap();
                assert_eq!(
                    element
                        .GetAttribute(&HSTRING::from("activationType"))
                        .unwrap(),
                    HSTRING::from("protocol")
                );
                assert_eq!(
                    element.GetAttribute(&HSTRING::from("arguments")).unwrap(),
                    HSTRING::from(notification.activation_url(&action.id, scheme).unwrap())
                );
                assert_eq!(
                    element.GetAttribute(&HSTRING::from("content")).unwrap(),
                    HSTRING::from(&action.title)
                );
            }
        }
    }
}
