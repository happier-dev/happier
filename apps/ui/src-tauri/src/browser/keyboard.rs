#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct BrowserKeyboardEvent {
    key: String,
    code: String,
    repeat: bool,
    is_editable_target: bool,
    modifiers: BrowserKeyboardModifiers,
}

#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
struct BrowserKeyboardModifiers { shift: bool, ctrl: bool, meta: bool, alt: bool }

#[derive(serde::Deserialize)]
#[serde(deny_unknown_fields)]
struct KeyboardMessage { kind: String, event: BrowserKeyboardEvent }

pub(super) fn parse_keyboard_message(message: &str) -> Option<BrowserKeyboardEvent> {
    let message = serde_json::from_str::<KeyboardMessage>(message).ok()?;
    (message.kind == "happier:browser-key").then_some(message.event)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_keyboard_metadata() {
        let valid = r#"{"kind":"happier:browser-key","event":{"key":"l","code":"KeyL","repeat":false,"isEditableTarget":true,"modifiers":{"shift":false,"ctrl":false,"meta":true,"alt":false}}}"#;
        assert!(parse_keyboard_message(valid).is_some());
        assert!(parse_keyboard_message(&valid.replace("false", "\"false\"")).is_none());
        assert!(parse_keyboard_message(&valid.replace("happier:browser-key", "other")).is_none());
    }
}
