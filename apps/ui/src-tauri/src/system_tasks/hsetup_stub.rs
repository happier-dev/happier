use std::env;
use std::io::{self, Read, Write};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const CHILD_TASK_ID: &str = "hsetup-child-task";

fn main() {
    if let Err(error) = run() {
        let _ = writeln!(io::stderr(), "{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let args = env::args().skip(1).collect::<Vec<_>>();
    if args.first().map(String::as_str) != Some("system-tasks")
        || args.get(1).map(String::as_str) != Some("run")
    {
        return Err("usage: hsetup system-tasks run [--spec-json <json>]".to_string());
    }

    let spec_json = read_spec_json(&args)?;
    let _ = spec_json;

    emit_event("step", Some("task.step.prepare"), Some("Preparing task"), None)?;
    thread::sleep(Duration::from_millis(30));
    emit_event(
        "progress",
        Some("task.step.installRuntime"),
        Some("Installing runtime"),
        Some(r#"{"percent":50}"#),
    )?;
    thread::sleep(Duration::from_millis(30));
    emit_event("progress", Some("task.step.finish"), Some("Finishing setup"), None)?;
    thread::sleep(Duration::from_millis(30));

    let mut stdout = io::stdout().lock();
    writeln!(
        stdout,
        "{{\"protocolVersion\":1,\"taskId\":\"{CHILD_TASK_ID}\",\"ok\":true,\"data\":{{\"simulated\":true}}}}"
    )
    .map_err(|error| error.to_string())?;
    stdout.flush().map_err(|error| error.to_string())
}

fn read_spec_json(args: &[String]) -> Result<String, String> {
    if let Some(flag_index) = args.iter().position(|arg| arg == "--spec-json") {
        let spec_json = args.get(flag_index + 1).cloned().unwrap_or_default();
        if spec_json.trim().is_empty() {
            return Err("--spec-json requires a JSON string value.".to_string());
        }
        return Ok(spec_json);
    }

    let mut stdin = String::new();
    io::stdin()
        .read_to_string(&mut stdin)
        .map_err(|error| error.to_string())?;
    if stdin.trim().is_empty() {
        return Err("expected a SystemTaskSpec JSON document on stdin.".to_string());
    }
    Ok(stdin)
}

fn emit_event(
    event_type: &str,
    step_id: Option<&str>,
    message: Option<&str>,
    data_json: Option<&str>,
) -> Result<(), String> {
    let ts_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();

    let mut line = format!(
        "{{\"protocolVersion\":1,\"taskId\":\"{CHILD_TASK_ID}\",\"tsMs\":{ts_ms},\"type\":\"{event_type}\""
    );
    if let Some(step_id) = step_id {
        line.push_str(&format!(",\"stepId\":\"{step_id}\""));
    }
    if let Some(message) = message {
        line.push_str(&format!(",\"message\":\"{message}\""));
    }
    if let Some(data_json) = data_json {
        line.push_str(&format!(",\"data\":{data_json}"));
    }
    line.push('}');

    let mut stdout = io::stdout().lock();
    writeln!(stdout, "{line}").map_err(|error| error.to_string())?;
    stdout.flush().map_err(|error| error.to_string())
}
