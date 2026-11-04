pub(crate) const MAIN_WINDOW_LABEL: &str = "main";
pub(crate) const ACTIVITY_WINDOW_LABEL: &str = "activity_overlay";
pub(crate) const CAPTURE_WINDOW_LABEL: &str = "capture";

pub(crate) fn is_app_window(label: &str) -> bool {
    label.strip_prefix("destination_").is_some_and(|id| !id.is_empty()
        && id.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'))
}

fn action_result_target<'a>(caller_label: &str, window_label: &'a str) -> Result<&'a str, String> {
    validate_action_result_destination(caller_label, window_label)?;
    Ok(if is_app_window(caller_label) && !is_app_window(window_label) { MAIN_WINDOW_LABEL } else { window_label })
}

pub(crate) fn is_capture_window(label: &str) -> bool {
    label == CAPTURE_WINDOW_LABEL || label.strip_prefix("capture_")
        .is_some_and(|suffix| !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit()))
}

pub(crate) fn window_allows_dragging(window_label: &str) -> bool {
    window_label == MAIN_WINDOW_LABEL || is_capture_window(window_label) || is_app_window(window_label)
}

fn validate_action_source(
    caller_label: &str,
    window_label: &str,
    is_retry: bool,
) -> Result<(), String> {
    if (caller_label == ACTIVITY_WINDOW_LABEL || is_capture_window(caller_label) || is_app_window(caller_label))
        && caller_label == window_label
        && (!is_retry || is_capture_window(caller_label))
    {
        return Ok(());
    }
    Err("desktop_window_action_source_refused".into())
}

#[cfg(desktop)]
use serde::{Deserialize, Serialize};
#[cfg(desktop)]
use tauri::{AppHandle, Emitter, Runtime, WebviewWindow};

#[cfg(desktop)]
pub(crate) const ACTION_EVENT: &str = "desktopWindow://action";
#[cfg(desktop)]
const ACTION_RESULT_EVENT: &str = "desktopWindow://action-result";

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_host_get_availability<R: Runtime>(app: AppHandle<R>) -> serde_json::Value {
    serde_json::json!({
        "activity": crate::activity_overlay::host_availability(&app),
        "pet": crate::pet_overlay::host_availability(&app),
        "windows": { "kind": "available" }
    })
}

#[cfg(desktop)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWindowActionPayload {
    pub window_label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_window_label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub action_identifier: String,
    #[serde(default)]
    pub data: serde_json::Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<DesktopWindowActionIntent>,
}

#[cfg(desktop)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DesktopWindowActionIntent {
    Retry,
    ChooseSession,
}

#[cfg(desktop)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum DesktopWindowActionResultPhase {
    Admitted,
    Settled,
}

#[cfg(desktop)]
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWindowActionResultPayload {
    pub window_label: String,
    pub request_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub phase: Option<DesktopWindowActionResultPhase>,
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_window_emit_action<R: Runtime>(
    app: AppHandle<R>,
    mut payload: DesktopWindowActionPayload,
    caller_window: WebviewWindow<R>,
) -> Result<(), String> {
    if let Some(target) = payload.target_window_label.take() {
        if !is_app_window(&target)
            || !(caller_window.label() == MAIN_WINDOW_LABEL
                || (is_app_window(caller_window.label()) && payload.window_label == caller_window.label()))
        {
            return Err("desktop_window_action_source_refused".into());
        }
        return app.emit_to(target, ACTION_EVENT, payload).map_err(|error| error.to_string());
    }
    validate_action_source(
        caller_window.label(),
        &payload.window_label,
        matches!(payload.intent, Some(DesktopWindowActionIntent::Retry)),
    )?;
    app.emit_to(MAIN_WINDOW_LABEL, ACTION_EVENT, payload)
        .map_err(|error| error.to_string())
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_window_emit_action_result<R: Runtime>(
    app: AppHandle<R>,
    payload: DesktopWindowActionResultPayload,
    caller_window: WebviewWindow<R>,
) -> Result<(), String> {
    let target = action_result_target(caller_window.label(), &payload.window_label)?.to_owned();
    if caller_window.label() == MAIN_WINDOW_LABEL && is_capture_window(&payload.window_label)
        && !matches!(&payload.phase, Some(DesktopWindowActionResultPhase::Admitted)) {
        app.emit_to(MAIN_WINDOW_LABEL, ACTION_RESULT_EVENT, &payload)
            .map_err(|error| error.to_string())?;
    }
    app.emit_to(target, ACTION_RESULT_EVENT, payload)
        .map_err(|error| error.to_string())
}

fn validate_action_result_destination(
    caller_label: &str,
    window_label: &str,
) -> Result<(), String> {
    if (caller_label == MAIN_WINDOW_LABEL
        && (window_label == ACTIVITY_WINDOW_LABEL || is_capture_window(window_label) || is_app_window(window_label)))
        || (is_app_window(caller_label)
            && (window_label == MAIN_WINDOW_LABEL || window_label == ACTIVITY_WINDOW_LABEL
                || is_capture_window(window_label) || is_app_window(window_label)))
    {
        return Ok(());
    }
    Err("desktop_window_action_destination_refused".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn destination_requests_and_results_keep_actual_caller_identity() {
        assert!(validate_action_source("destination_abc", "destination_abc", false).is_ok());
        assert!(validate_action_source("destination_abc", "destination_def", false).is_err());
        assert!(validate_action_result_destination(MAIN_WINDOW_LABEL, "destination_abc").is_ok());
        assert!(validate_action_result_destination("destination_abc", MAIN_WINDOW_LABEL).is_ok());
        assert!(validate_action_result_destination("destination_abc", "capture_42").is_ok());
        assert!(validate_action_result_destination("unknown", "destination_abc").is_err());
        assert!(window_allows_dragging("destination_abc"));
        assert_eq!(action_result_target("destination_abc", "capture_42").unwrap(), MAIN_WINDOW_LABEL);
        assert_eq!(action_result_target(MAIN_WINDOW_LABEL, "capture_42").unwrap(), "capture_42");
        assert_eq!(action_result_target(MAIN_WINDOW_LABEL, "destination_abc").unwrap(), "destination_abc");
        assert_eq!(action_result_target("destination_target", "destination_source").unwrap(), "destination_source");
        assert!(action_result_target("unknown", "destination_abc").is_err());
    }

    #[cfg(desktop)]
    #[test]
    fn explicit_session_choice_round_trips_without_changing_retry_admission() {
        let payload: DesktopWindowActionPayload = serde_json::from_value(serde_json::json!({
            "windowLabel": "capture_42",
            "actionIdentifier": "screenCapture.open",
            "intent": "chooseSession"
        })).expect("the existing bridge carries explicit Session choice intent");
        assert_eq!(serde_json::to_value(payload).unwrap()["intent"], "chooseSession");
        assert!(validate_action_source("capture_42", "capture_42", false).is_ok());
        assert!(validate_action_source(ACTIVITY_WINDOW_LABEL, ACTIVITY_WINDOW_LABEL, true).is_err());
    }

    #[test]
    fn separate_capture_windows_keep_the_real_caller_and_result_destination() {
        for label in ["capture_1", "capture_42"] {
            assert!(window_allows_dragging(label));
            assert!(validate_action_source(label, label, true).is_ok());
            assert!(validate_action_result_destination(MAIN_WINDOW_LABEL, label).is_ok());
        }
        assert!(validate_action_source("capture_1", "capture_42", false).is_err());
        assert!(validate_action_source("capture_selection_1", "capture_selection_1", false).is_err());
        assert!(validate_action_result_destination(MAIN_WINDOW_LABEL, "capture_selection_1").is_err());
    }

    #[test]
    fn native_dragging_is_available_to_main_and_capture_only() {
        assert!(window_allows_dragging(MAIN_WINDOW_LABEL));
        assert!(window_allows_dragging(CAPTURE_WINDOW_LABEL));
        assert!(!window_allows_dragging(ACTIVITY_WINDOW_LABEL));
        assert!(!window_allows_dragging("unknown"));
    }

    #[test]
    fn requests_accept_both_real_auxiliary_windows_and_refuse_impersonation() {
        for label in [ACTIVITY_WINDOW_LABEL, CAPTURE_WINDOW_LABEL] {
            assert!(validate_action_source(label, label, false).is_ok());
        }
        for (caller, claimed) in [
            ("unknown", CAPTURE_WINDOW_LABEL),
            (MAIN_WINDOW_LABEL, CAPTURE_WINDOW_LABEL),
            (ACTIVITY_WINDOW_LABEL, CAPTURE_WINDOW_LABEL),
            (CAPTURE_WINDOW_LABEL, ACTIVITY_WINDOW_LABEL),
        ] {
            assert!(validate_action_source(caller, claimed, false).is_err());
        }
    }

    #[test]
    fn retry_intent_is_available_only_to_the_capture_caller() {
        assert!(validate_action_source(CAPTURE_WINDOW_LABEL, CAPTURE_WINDOW_LABEL, true).is_ok());
        assert!(
            validate_action_source(ACTIVITY_WINDOW_LABEL, ACTIVITY_WINDOW_LABEL, true).is_err()
        );
    }

    #[test]
    fn results_require_main_and_a_known_auxiliary_destination() {
        for label in [ACTIVITY_WINDOW_LABEL, CAPTURE_WINDOW_LABEL] {
            assert!(validate_action_result_destination(MAIN_WINDOW_LABEL, label).is_ok());
            assert!(validate_action_result_destination(label, label).is_err());
        }
        assert!(validate_action_result_destination(MAIN_WINDOW_LABEL, "unknown").is_err());
    }
}
