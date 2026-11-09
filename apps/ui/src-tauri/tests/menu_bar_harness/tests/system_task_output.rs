#[path = "../../../src/system_tasks/json_lines.rs"]
mod json_lines;
#[path = "../../../src/system_tasks/protocol.rs"]
mod protocol;

#[test]
fn a_large_first_party_result_reaches_the_protocol_consumer_without_truncation() {
    let result = protocol::SystemTaskResult::Success(protocol::SystemTaskSuccessResult {
        protocol_version: protocol::SYSTEM_TASK_PROTOCOL_VERSION,
        task_id: "desktop-large-result".into(),
        ok: true,
        data: Some(serde_json::json!({"inventory": "x".repeat(16 * 1024 + 1)})),
    });
    let line = serde_json::to_string(&result).unwrap();
    let mut reader = std::io::Cursor::new(format!("{line}\n"));
    let mut buffer = Vec::new();
    let json_lines::ReadJsonLine::Line(actual) =
        json_lines::read_json_line(&mut reader, &mut buffer).unwrap()
    else {
        panic!("a valid hsetup result must reach the protocol consumer");
    };
    assert_eq!(
        protocol::parse_output_line(&actual),
        Some(protocol::OutputPayload::Result(result))
    );
}
