use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const SYSTEM_TASK_PROTOCOL_VERSION: u8 = 1;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemTaskSpec {
    pub protocol_version: u8,
    pub kind: String,
    pub params: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemTaskEvent {
    pub protocol_version: u8,
    pub task_id: String,
    pub ts_ms: u64,
    #[serde(rename = "type")]
    pub event_type: String,
    pub step_id: Option<String>,
    pub message: Option<String>,
    pub data: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemTaskResultError {
    pub code: String,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemTaskSuccessResult {
    pub protocol_version: u8,
    pub task_id: String,
    pub ok: bool,
    pub data: Option<Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SystemTaskFailureResult {
    pub protocol_version: u8,
    pub task_id: String,
    pub ok: bool,
    pub error: SystemTaskResultError,
}

#[derive(Clone, Debug, PartialEq)]
pub enum SystemTaskResult {
    Success(SystemTaskSuccessResult),
    Failure(SystemTaskFailureResult),
}

#[derive(Clone, Debug, PartialEq)]
pub enum OutputPayload {
    Event(SystemTaskEvent),
    Result(SystemTaskResult),
}

impl Serialize for SystemTaskResult {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        match self {
            Self::Success(value) => value.serialize(serializer),
            Self::Failure(value) => value.serialize(serializer),
        }
    }
}

pub fn parse_system_task_spec_json(spec_json: &str) -> Result<SystemTaskSpec, String> {
    let spec: SystemTaskSpec = serde_json::from_str(spec_json)
        .map_err(|_| "Invalid system task specification JSON.".to_string())?;
    validate_spec(&spec)?;
    Ok(spec)
}

pub fn parse_output_line(line: &str) -> Option<OutputPayload> {
    let value: Value = serde_json::from_str(line).ok()?;
    let object = value.as_object()?;

    if object.contains_key("ok") {
        let result = parse_result_value(Value::Object(object.clone()))?;
        return Some(OutputPayload::Result(result));
    }

    let event: SystemTaskEvent = serde_json::from_value(Value::Object(object.clone())).ok()?;
    validate_event(&event).then_some(OutputPayload::Event(event))
}

pub fn rewrite_event_task_id(mut event: SystemTaskEvent, task_id: &str) -> SystemTaskEvent {
    event.task_id = task_id.to_string();
    event
}

pub fn rewrite_result_task_id(result: SystemTaskResult, task_id: &str) -> SystemTaskResult {
    match result {
        SystemTaskResult::Success(mut value) => {
            value.task_id = task_id.to_string();
            SystemTaskResult::Success(value)
        }
        SystemTaskResult::Failure(mut value) => {
            value.task_id = task_id.to_string();
            SystemTaskResult::Failure(value)
        }
    }
}

pub fn build_failure_result(task_id: &str, code: &str, message: &str) -> SystemTaskResult {
    SystemTaskResult::Failure(SystemTaskFailureResult {
        protocol_version: SYSTEM_TASK_PROTOCOL_VERSION,
        task_id: task_id.to_string(),
        ok: false,
        error: SystemTaskResultError {
            code: code.to_string(),
            message: message.to_string(),
        },
    })
}

fn validate_spec(spec: &SystemTaskSpec) -> Result<(), String> {
    if spec.protocol_version != SYSTEM_TASK_PROTOCOL_VERSION {
        return Err("Unsupported system task protocol version.".to_string());
    }
    if spec.kind.trim().is_empty() {
        return Err("System task kind is required.".to_string());
    }
    let _ = &spec.params;
    Ok(())
}

fn validate_event(event: &SystemTaskEvent) -> bool {
    event.protocol_version == SYSTEM_TASK_PROTOCOL_VERSION
        && !event.task_id.trim().is_empty()
        && !event.event_type.trim().is_empty()
        && event
            .step_id
            .as_ref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(true)
        && event
            .message
            .as_ref()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(true)
}

fn parse_result_value(value: Value) -> Option<SystemTaskResult> {
    let ok = value.get("ok")?.as_bool()?;
    if ok {
        let result: SystemTaskSuccessResult = serde_json::from_value(value).ok()?;
        return validate_success_result(&result).then_some(SystemTaskResult::Success(result));
    }

    let result: SystemTaskFailureResult = serde_json::from_value(value).ok()?;
    validate_failure_result(&result).then_some(SystemTaskResult::Failure(result))
}

fn validate_success_result(result: &SystemTaskSuccessResult) -> bool {
    result.protocol_version == SYSTEM_TASK_PROTOCOL_VERSION
        && result.ok
        && !result.task_id.trim().is_empty()
}

fn validate_failure_result(result: &SystemTaskFailureResult) -> bool {
    result.protocol_version == SYSTEM_TASK_PROTOCOL_VERSION
        && !result.task_id.trim().is_empty()
        && !result.ok
        && !result.error.code.trim().is_empty()
        && !result.error.message.trim().is_empty()
}

#[cfg(test)]
mod tests {
    use super::{
        build_failure_result, parse_output_line, parse_system_task_spec_json,
        rewrite_event_task_id, rewrite_result_task_id, OutputPayload, SystemTaskResult,
    };

    #[test]
    fn rejects_specs_with_unknown_fields() {
        let parsed = parse_system_task_spec_json(
            r#"{"protocolVersion":1,"kind":"setup.thisComputer.v1","params":{},"extra":true}"#,
        );

        assert!(parsed.is_err());
    }

    #[test]
    fn parses_valid_event_payloads() {
        let payload = r#"{"protocolVersion":1,"taskId":"child-task","tsMs":12,"type":"progress","stepId":"install","message":"Installing"}"#;

        match parse_output_line(payload) {
            Some(OutputPayload::Event(event)) => {
                assert_eq!(event.event_type, "progress");
                assert_eq!(event.step_id.as_deref(), Some("install"));
            }
            _ => panic!("expected event payload"),
        }
    }

    #[test]
    fn rejects_results_with_unknown_fields() {
        let payload = r#"{"protocolVersion":1,"taskId":"child-task","ok":true,"data":{},"error":{"code":"x","message":"y"}}"#;
        assert!(parse_output_line(payload).is_none());
    }

    #[test]
    fn rewrites_child_task_ids_to_bridge_owned_ids() {
        let event = match parse_output_line(
            r#"{"protocolVersion":1,"taskId":"child-task","tsMs":12,"type":"progress"}"#,
        ) {
            Some(OutputPayload::Event(event)) => event,
            _ => panic!("expected event payload"),
        };
        let result = match parse_output_line(
            r#"{"protocolVersion":1,"taskId":"child-task","ok":true,"data":{"done":true}}"#,
        ) {
            Some(OutputPayload::Result(result)) => result,
            _ => panic!("expected result payload"),
        };

        let rewritten_event = rewrite_event_task_id(event, "system_task_7");
        let rewritten_result = rewrite_result_task_id(result, "system_task_7");

        assert_eq!(rewritten_event.task_id, "system_task_7");
        match rewritten_result {
            SystemTaskResult::Success(success) => assert_eq!(success.task_id, "system_task_7"),
            _ => panic!("expected success result"),
        }
    }

    #[test]
    fn builds_stable_failure_results() {
        let result = build_failure_result("task_1", "cancelled", "Task cancelled.");
        match result {
            SystemTaskResult::Failure(failure) => {
                assert_eq!(failure.task_id, "task_1");
                assert_eq!(failure.error.code, "cancelled");
            }
            _ => panic!("expected failure result"),
        }
    }
}
