mod hsetup_path;
mod json_lines;
mod protocol;
mod state;

pub use state::SystemTasksState;

use json_lines::{read_json_line, ReadJsonLine};
use protocol::{
    build_failure_result, parse_output_line, parse_system_task_spec_json, rewrite_event_task_id,
    rewrite_result_task_id, OutputPayload, SystemTaskResult,
};
use serde::Serialize;
use state::{SharedChild, SystemTaskSnapshot};
use std::io::{BufReader, ErrorKind, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter, State};

const MAX_STDOUT_LINE_BYTES: usize = 16 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartSystemTaskResponse {
    task_id: String,
}

#[tauri::command]
pub async fn start_system_task(
    app: AppHandle,
    state: State<'_, SystemTasksState>,
    spec_json: String,
) -> Result<StartSystemTaskResponse, String> {
    parse_system_task_spec_json(&spec_json)?;

    let task_id = state.allocate_task_id();
    let hsetup_path = hsetup_path::resolve_hsetup_path(&app)?;

    let mut child = spawn_hsetup_child(&hsetup_path, &spec_json)?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Failed to capture system task stdout.".to_string())?;

    let child = std::sync::Arc::new(std::sync::Mutex::new(child));
    state.insert_running_task(&task_id, child.clone())?;

    let system_tasks = state.inner().clone();
    monitor_child_output(app, system_tasks, task_id.clone(), child, stdout);

    Ok(StartSystemTaskResponse { task_id })
}

#[tauri::command]
pub async fn cancel_system_task(
    task_id: String,
    state: State<'_, SystemTasksState>,
) -> Result<(), String> {
    let Some(child) = state.request_cancel(&task_id)? else {
        return Ok(());
    };

    let mut child_guard = child
        .lock()
        .map_err(|_| "System task process mutex poisoned.".to_string())?;
    match request_child_cancel(&mut child_guard) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::InvalidInput => Ok(()),
        Err(error) => Err(format!("Failed to cancel system task: {error}")),
    }
}

#[tauri::command]
pub async fn get_system_task_snapshot(
    task_id: String,
    state: State<'_, SystemTasksState>,
) -> Result<SystemTaskSnapshot, String> {
    state.snapshot(&task_id)
}

#[tauri::command]
pub async fn system_tasks_open_log_path(path: String) -> Result<(), String> {
    let path = normalize_system_task_log_path(&path)?;
    open_system_task_log_path(&path)
}

#[tauri::command]
pub async fn respond_system_task_prompt(
    task_id: String,
    answer_json: String,
    state: State<'_, SystemTasksState>,
) -> Result<(), String> {
    send_prompt_answer_to_task(&state, &task_id, &answer_json)
}

fn send_prompt_answer_to_task(
    state: &SystemTasksState,
    task_id: &str,
    answer_json: &str,
) -> Result<(), String> {
    let Some(child) = state.running_child(task_id)? else {
        return Ok(());
    };

    let mut child_guard = child
        .lock()
        .map_err(|_| "System task process mutex poisoned.".to_string())?;
    let Some(stdin) = child_guard.stdin.as_mut() else {
        return Ok(());
    };

    let write_result = stdin
        .write_all(answer_json.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush());

    match write_result {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == ErrorKind::BrokenPipe => Ok(()),
        Err(error) if error.kind() == ErrorKind::InvalidInput => Ok(()),
        Err(error) => Err(format!(
            "Failed to send system task prompt response: {error}"
        )),
    }
}

fn monitor_child_output(
    app: AppHandle,
    state: SystemTasksState,
    task_id: String,
    child: SharedChild,
    stdout: std::process::ChildStdout,
) {
    let app_for_events = app.clone();
    let app_for_results = app;

    let emit_event_fn = Arc::new(move |task_id: &str, event: &protocol::SystemTaskEvent| {
        emit_event(&app_for_events, task_id, event);
    });
    let emit_result_fn = Arc::new(move |task_id: &str, result: &SystemTaskResult| {
        emit_result(&app_for_results, task_id, result);
    });

    monitor_child_output_with_emitters(
        state,
        task_id,
        child,
        stdout,
        emit_event_fn,
        emit_result_fn,
    );
}

fn monitor_child_output_with_emitters(
    state: SystemTasksState,
    task_id: String,
    child: SharedChild,
    stdout: std::process::ChildStdout,
    emit_event: Arc<dyn Fn(&str, &protocol::SystemTaskEvent) + Send + Sync>,
    emit_result: Arc<dyn Fn(&str, &SystemTaskResult) + Send + Sync>,
) {
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buffer = Vec::new();
        let mut emitted_final_result = false;
        let mut output_limit_exceeded = false;
        let stderr_handle = spawn_stderr_collector(&state, &task_id, &child);

        loop {
            match read_json_line(&mut reader, &mut buffer, MAX_STDOUT_LINE_BYTES) {
                Ok(ReadJsonLine::Eof) => break,
                Ok(ReadJsonLine::LimitExceeded) => {
                    output_limit_exceeded = true;
                    kill_child(&child);
                    break;
                }
                Ok(ReadJsonLine::Line(line)) => {
                    if line.trim().is_empty() {
                        continue;
                    }

                    match parse_output_line(&line) {
                        Some(OutputPayload::Event(event)) => {
                            let event = rewrite_event_task_id(event, &task_id);
                            let _ = state.append_event(&task_id, event.clone());
                            (emit_event)(&task_id, &event);
                        }
                        Some(OutputPayload::Result(result)) => {
                            let result = rewrite_result_task_id(result, &task_id);
                            emitted_final_result = complete_task_and_emit_result(
                                &state,
                                &task_id,
                                result,
                                &emit_result,
                            );
                            break;
                        }
                        None => {}
                    }
                }
                Err(_) => break,
            }
        }

        wait_for_child(&child);
        if let Some(handle) = stderr_handle {
            let _ = handle.join();
        }
        let _ = state.mark_finished(&task_id);

        if !emitted_final_result {
            let fallback = build_fallback_result(&state, &task_id, output_limit_exceeded);
            let _ = complete_task_and_emit_result(&state, &task_id, fallback, &emit_result);
        }
    });
}

fn spawn_stderr_collector(
    state: &SystemTasksState,
    task_id: &str,
    child: &SharedChild,
) -> Option<thread::JoinHandle<()>> {
    let stderr = {
        let mut child_guard = child.lock().ok()?;
        child_guard.stderr.take()
    }?;

    let state = state.clone();
    let task_id = task_id.to_string();

    Some(thread::spawn(move || {
        let mut reader = BufReader::new(stderr);
        let mut chunk = [0u8; 1024];

        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = state.append_stderr_preview_bytes(&task_id, &chunk[..n]);
                }
                Err(_) => break,
            }
        }
    }))
}

fn sanitize_stderr_preview(bytes: &[u8]) -> String {
    if bytes.is_empty() {
        return String::new();
    }

    let mut filtered = String::new();
    for ch in String::from_utf8_lossy(bytes).chars() {
        if ch == '\n' || ch == '\r' || ch == '\t' {
            filtered.push(ch);
            continue;
        }
        if ch.is_control() {
            continue;
        }
        filtered.push(ch);
    }

    let trimmed = filtered.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    const MAX_CHARS: usize = 800;
    let char_count = trimmed.chars().count();
    if char_count <= MAX_CHARS {
        return trimmed.to_string();
    }

    trimmed
        .chars()
        .skip(char_count - MAX_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

fn build_fallback_result(
    state: &SystemTasksState,
    task_id: &str,
    output_limit_exceeded: bool,
) -> SystemTaskResult {
    if output_limit_exceeded {
        return build_failure_result(
            task_id,
            "output_limit_exceeded",
            "System task executor exceeded the output limit.",
        );
    }

    if state.is_cancel_requested(task_id).unwrap_or(false) {
        return build_failure_result(task_id, "cancelled", "Task cancelled.");
    }

    let stderr_preview = state.read_stderr_preview_bytes(task_id).unwrap_or_default();
    let stderr_preview = sanitize_stderr_preview(&stderr_preview);
    if !stderr_preview.is_empty() {
        let message = format!(
            "System task executor exited without a final result.\n\nStderr (tail):\n{stderr_preview}"
        );
        return build_failure_result(task_id, "executor_ended_without_result", &message);
    }

    build_failure_result(
        task_id,
        "executor_ended_without_result",
        "System task executor exited without a final result.",
    )
}

fn complete_task_and_emit_result(
    state: &SystemTasksState,
    task_id: &str,
    result: SystemTaskResult,
    emit_result: &Arc<dyn Fn(&str, &SystemTaskResult) + Send + Sync>,
) -> bool {
    match state.complete_task(task_id, result.clone()) {
        Ok(true) => {
            (emit_result)(task_id, &result);
            true
        }
        _ => false,
    }
}

fn emit_event(app: &AppHandle, task_id: &str, event: &protocol::SystemTaskEvent) {
    let channel = format!("systemTasks://task/{task_id}/event");
    let _ = app.emit(&channel, event.clone());
}

fn emit_result(app: &AppHandle, task_id: &str, result: &SystemTaskResult) {
    let channel = format!("systemTasks://task/{task_id}/result");
    let _ = app.emit(&channel, result.clone());
}

fn normalize_system_task_log_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Log path is required.".to_string());
    }

    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("Log path must be an absolute path.".to_string());
    }

    let path = std::fs::canonicalize(&path)
        .map_err(|error| format!("Log path does not exist: {error}"))?;

    let allowed_root = resolve_happier_log_root_dir().ok_or_else(|| {
        "Unable to resolve the Happier log root directory for this platform.".to_string()
    })?;
    let allowed_root = std::fs::canonicalize(&allowed_root).unwrap_or(allowed_root);

    if !path.starts_with(&allowed_root) {
        return Err(format!(
            "Log path is outside the allowed root: {}",
            allowed_root.display()
        ));
    }

    if !path.exists() {
        return Err(format!("Log path does not exist: {}", path.display()));
    }

    Ok(path)
}

fn resolve_happier_log_root_dir() -> Option<PathBuf> {
    resolve_home_dir().map(|home_dir| home_dir.join(".happier"))
}

fn resolve_home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        if let Some(user_profile) = std::env::var_os("USERPROFILE") {
            return Some(PathBuf::from(user_profile));
        }
        let drive = std::env::var_os("HOMEDRIVE");
        let path = std::env::var_os("HOMEPATH");
        if let (Some(drive), Some(path)) = (drive, path) {
            return Some(PathBuf::from(drive).join(PathBuf::from(path)));
        }
        return None;
    }

    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

fn open_system_task_log_path(path: &Path) -> Result<(), String> {
    let status = Command::new(resolve_open_log_path_program())
        .arg(path)
        .status()
        .map_err(|error| format!("Failed to open log path: {error}"))?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("Failed to open log path: {status}"))
    }
}

fn resolve_open_log_path_program() -> &'static str {
    if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(target_os = "windows") {
        "explorer"
    } else {
        "xdg-open"
    }
}

fn kill_child(child: &SharedChild) {
    if let Ok(mut child_guard) = child.lock() {
        let _ = request_child_cancel(&mut child_guard);
    }
}

fn wait_for_child(child: &SharedChild) {
    if let Ok(mut child_guard) = child.lock() {
        let _ = child_guard.wait();
    }
}

fn request_child_cancel(child: &mut Child) -> Result<(), std::io::Error> {
    #[cfg(unix)]
    {
        let signal_result = unsafe { libc::kill(child.id() as libc::pid_t, libc::SIGTERM) };
        if signal_result == 0 {
            return Ok(());
        }

        let signal_error = std::io::Error::last_os_error();
        if signal_error.kind() != ErrorKind::InvalidInput {
            return Err(signal_error);
        }
    }

    child.kill()
}

fn spawn_hsetup_child(hsetup_path: &Path, spec_json: &str) -> Result<Child, String> {
    let mut child = create_hsetup_run_command(hsetup_path)
        .spawn()
        .map_err(|error| format!("Failed to start hsetup: {error}"))?;

    let Some(stdin) = child.stdin.as_mut() else {
        return Err("Failed to open hsetup stdin.".to_string());
    };
    stdin
        .write_all(spec_json.as_bytes())
        .and_then(|_| stdin.write_all(b"\n"))
        .and_then(|_| stdin.flush())
        .map_err(|error| format!("Failed to write task spec to hsetup stdin: {error}"))?;

    Ok(child)
}

fn create_hsetup_run_command(hsetup_path: &Path) -> Command {
    let mut command = Command::new(hsetup_path);
    command
        .arg("system-tasks")
        .arg("run")
        .stdin(Stdio::piped())
        .stderr(Stdio::piped())
        .stdout(Stdio::piped());
    command
}

#[cfg(test)]
mod tests {
    use super::{
        monitor_child_output_with_emitters, request_child_cancel, send_prompt_answer_to_task,
        spawn_hsetup_child,
    };
    use crate::system_tasks::SystemTasksState;
    use std::fs;
    use std::io::Read;
    use std::io::{BufRead, BufReader};
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::sync::{Mutex, OnceLock};
    use std::thread;
    use std::time::Duration;
    use std::time::Instant;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;

    #[cfg(unix)]
    #[test]
    fn spawned_hsetup_receives_spec_over_stdin_without_putting_it_in_argv() {
        let _env_guard = env_lock().lock().expect("env lock should not be poisoned");
        let temp_dir = create_temp_dir("system-task-stdin");
        let script_path = temp_dir.join("inspect-hsetup.sh");
        fs::write(
            &script_path,
            "#!/bin/sh\nprintf 'ARG:%s\\n' \"$@\"\nIFS= read -r stdin_payload\nprintf 'STDIN:%s\\n' \"$stdin_payload\"\n",
        )
        .expect("script should write");

        let permissions = fs::Permissions::from_mode(0o755);
        fs::set_permissions(&script_path, permissions).expect("script should be executable");

        let spec_json =
            r#"{"protocolVersion":1,"kind":"system.ping.v1","params":{"secret":"token"}}"#;
        let mut child =
            spawn_hsetup_child(&script_path, spec_json).expect("child should start successfully");
        let mut stdout = String::new();
        child
            .stdout
            .take()
            .expect("stdout should be piped")
            .read_to_string(&mut stdout)
            .expect("stdout should read");
        let status = child.wait().expect("child should exit");

        assert!(status.success());
        assert!(stdout.contains("ARG:system-tasks\n"));
        assert!(stdout.contains("ARG:run\n"));
        assert!(!stdout.contains("ARG:--spec-json\n"));
        assert!(stdout.contains(&format!("STDIN:{spec_json}")));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn request_child_cancel_does_not_depend_on_shell_path_resolution() {
        let _env_guard = env_lock().lock().expect("env lock should not be poisoned");
        let temp_dir = create_temp_dir("system-task-cancel");
        let script_path = temp_dir.join("trap-term.sh");
        fs::write(&script_path, "#!/bin/sh\nwhile :; do :; done\n").expect("script should write");

        let permissions = fs::Permissions::from_mode(0o755);
        fs::set_permissions(&script_path, permissions).expect("script should be executable");

        let previous_path = std::env::var("PATH").ok();
        std::env::set_var("PATH", "");

        let mut child = std::process::Command::new(&script_path)
            .spawn()
            .expect("child should spawn");
        thread::sleep(Duration::from_millis(100));

        let cancel_result = request_child_cancel(&mut child);

        match previous_path {
            Some(value) => std::env::set_var("PATH", value),
            None => std::env::remove_var("PATH"),
        }

        assert!(cancel_result.is_ok());
        let _status = child.wait().expect("child should exit");

        let _ = fs::remove_dir_all(temp_dir);
    }

    fn env_lock() -> &'static Mutex<()> {
        static ENV_LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        ENV_LOCK.get_or_init(|| Mutex::new(()))
    }

    fn create_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be valid")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("{prefix}-{unique}"));
        fs::create_dir_all(&path).expect("temp dir should create");
        path
    }

    #[cfg(unix)]
    #[test]
    fn prompt_answers_can_be_sent_to_running_hsetup_tasks_over_stdin() {
        let _env_guard = env_lock().lock().expect("env lock should not be poisoned");
        let temp_dir = create_temp_dir("system-task-prompt-answer");
        let script_path = temp_dir.join("prompt.sh");
        fs::write(
            &script_path,
            "#!/bin/sh\nIFS= read -r spec || exit 2\n# Emit a prompt event\nprintf '{\"protocolVersion\":1,\"taskId\":\"child-task\",\"tsMs\":1,\"type\":\"prompt\",\"stepId\":\"ssh.hostTrust\",\"message\":\"Trust?\",\"data\":{\"kind\":\"ssh.trustHost\"}}\\n'\n# Block until an answer arrives\nIFS= read -r answer || exit 3\n# Emit a completion result once the answer is received\nprintf '{\"protocolVersion\":1,\"taskId\":\"child-task\",\"ok\":true,\"data\":{\"received\":true}}\\n'\n",
        )
        .expect("script should write");

        let permissions = fs::Permissions::from_mode(0o755);
        fs::set_permissions(&script_path, permissions).expect("script should be executable");

        let spec_json =
            r#"{"protocolVersion":1,"kind":"remote.ssh.bootstrapMachine.v1","params":{}}"#;
        let mut child =
            spawn_hsetup_child(&script_path, spec_json).expect("child should start successfully");

        let stdout = child.stdout.take().expect("stdout should be piped");
        let reader = BufReader::new(stdout);
        let (tx, rx) = mpsc::channel::<String>();
        thread::spawn(move || {
            for line in reader.lines().flatten() {
                let _ = tx.send(line);
            }
        });

        let child = std::sync::Arc::new(std::sync::Mutex::new(child));
        let state = SystemTasksState::default();
        state
            .insert_running_task("task_1", child.clone())
            .expect("task should insert");

        let first_line = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("should receive prompt event");
        assert!(first_line.contains("\"type\":\"prompt\""));

        send_prompt_answer_to_task(&state, "task_1", r#"{"trusted":true}"#)
            .expect("answer should be sent");

        let start = Instant::now();
        let second_line = rx
            .recv_timeout(Duration::from_secs(1))
            .expect("should receive completion result after answering");
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(second_line.contains("\"ok\":true"));

        let status = child
            .lock()
            .expect("child mutex should not be poisoned")
            .wait()
            .expect("child should exit");
        assert!(status.success());

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn spawned_hsetup_exposes_stderr_pipe() {
        let temp_dir = create_temp_dir("system-task-stderr");
        let script_path = temp_dir.join("stderr.sh");
        fs::write(
            &script_path,
            "#!/bin/sh\nIFS= read -r _spec || exit 2\nprintf 'boom\\n' 1>&2\nexit 7\n",
        )
        .expect("script should write");

        let permissions = fs::Permissions::from_mode(0o755);
        fs::set_permissions(&script_path, permissions).expect("script should be executable");

        let spec_json = r#"{"protocolVersion":1,"kind":"system.ping.v1","params":{}}"#;
        let mut child = spawn_hsetup_child(&script_path, spec_json).expect("child should start");

        let mut stderr = String::new();
        child
            .stderr
            .take()
            .expect("stderr should be piped")
            .read_to_string(&mut stderr)
            .expect("stderr should read");

        let status = child.wait().expect("child should exit");
        assert_eq!(status.code(), Some(7));
        assert!(stderr.contains("boom"));

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[cfg(unix)]
    #[test]
    fn fallback_result_includes_stderr_preview_when_executor_exits_without_result() {
        let temp_dir = create_temp_dir("system-task-fallback-stderr");
        let script_path = temp_dir.join("no-result.sh");
        fs::write(
            &script_path,
            "#!/bin/sh\nIFS= read -r _spec || exit 2\nprintf 'stderr-preview: boom\\n' 1>&2\nexit 1\n",
        )
        .expect("script should write");

        let permissions = fs::Permissions::from_mode(0o755);
        fs::set_permissions(&script_path, permissions).expect("script should be executable");

        let spec_json = r#"{"protocolVersion":1,"kind":"system.ping.v1","params":{}}"#;
        let mut child = spawn_hsetup_child(&script_path, spec_json).expect("child should start");
        let stdout = child.stdout.take().expect("stdout should be piped");

        let child = std::sync::Arc::new(std::sync::Mutex::new(child));
        let state = SystemTasksState::default();
        state
            .insert_running_task("task_1", child.clone())
            .expect("task should insert");

        let emit_event = std::sync::Arc::new(
            |_task_id: &str, _event: &crate::system_tasks::protocol::SystemTaskEvent| {},
        );
        let emit_result = std::sync::Arc::new(
            |_task_id: &str, _result: &crate::system_tasks::protocol::SystemTaskResult| {},
        );
        monitor_child_output_with_emitters(
            state.clone(),
            "task_1".to_string(),
            child,
            stdout,
            emit_event,
            emit_result,
        );

        let start = Instant::now();
        loop {
            let snapshot = state.snapshot("task_1").expect("snapshot should load");
            if let Some(result) = snapshot.result {
                match result {
                    crate::system_tasks::protocol::SystemTaskResult::Failure(failure) => {
                        assert_eq!(failure.error.code, "executor_ended_without_result");
                        assert!(
                            failure.error.message.contains("stderr-preview: boom"),
                            "expected stderr preview in failure message, got: {}",
                            failure.error.message
                        );
                    }
                    _ => panic!("expected failure result"),
                }
                break;
            }
            assert!(
                start.elapsed() < Duration::from_secs(2),
                "timed out waiting for fallback result"
            );
            thread::sleep(Duration::from_millis(20));
        }

        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn resolve_open_log_path_program_uses_the_platform_file_manager() {
        let program = super::resolve_open_log_path_program();

        #[cfg(target_os = "macos")]
        assert_eq!(program, "open");

        #[cfg(target_os = "windows")]
        assert_eq!(program, "explorer");

        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        assert_eq!(program, "xdg-open");
    }

    #[test]
    fn normalize_system_task_log_path_rejects_blank_paths() {
        let error = super::normalize_system_task_log_path("   ")
            .expect_err("blank log paths should be rejected");
        assert!(error.contains("required"));
    }

    #[test]
    fn normalize_system_task_log_path_rejects_relative_paths() {
        let error = super::normalize_system_task_log_path("logs/output.log")
            .expect_err("relative log paths should be rejected");
        assert!(error.contains("absolute"));
    }

    #[test]
    fn normalize_system_task_log_path_accepts_paths_inside_happier_root() {
        let _env_guard = env_lock().lock().expect("env lock should not be poisoned");
        let temp_dir = create_temp_dir("system-task-log-path");
        let home_dir = temp_dir.join("home");
        let allowed_root = home_dir.join(".happier");
        let log_dir = allowed_root.join("logs");
        fs::create_dir_all(&log_dir).expect("log dir should create");
        let log_path = log_dir.join("daemon.log");
        fs::write(&log_path, "log").expect("log file should write");

        let previous_home = std::env::var_os("HOME");
        std::env::set_var("HOME", &home_dir);

        let normalized = super::normalize_system_task_log_path(&log_path.display().to_string())
            .expect("allowed log path should normalize");

        match previous_home {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }

        assert_eq!(
            normalized,
            std::fs::canonicalize(&log_path).expect("canonicalize should work")
        );
        let _ = fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn normalize_system_task_log_path_rejects_paths_outside_happier_root() {
        let _env_guard = env_lock().lock().expect("env lock should not be poisoned");
        let temp_dir = create_temp_dir("system-task-log-path-outside");
        let home_dir = temp_dir.join("home");
        let allowed_root = home_dir.join(".happier");
        fs::create_dir_all(&allowed_root).expect("allowed root should create");
        let outside_path = temp_dir.join("outside.log");
        fs::write(&outside_path, "log").expect("outside log file should write");

        let previous_home = std::env::var_os("HOME");
        std::env::set_var("HOME", &home_dir);

        let error = super::normalize_system_task_log_path(&outside_path.display().to_string())
            .expect_err("outside log path should be rejected");

        match previous_home {
            Some(value) => std::env::set_var("HOME", value),
            None => std::env::remove_var("HOME"),
        }

        assert!(error.contains("outside the allowed root"));
        let _ = fs::remove_dir_all(temp_dir);
    }
}
