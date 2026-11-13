//! Extra processes started in the Session target on the client's request (Git,
//! search, language servers): one numbered stream each, multiplexed on the same
//! channel and replayed under the same acknowledgement rule as the Agent.
//!
//! Frames (payload after the shared `[seq u64]` prefix for sequenced kinds):
//! - holder -> client `O` / `E` `[stream u32][bytes]`, `X` `[stream u32]` + JSON `{"code","signal"}`.
//! - client -> holder `I` `[stream u32][bytes]`, `C` `[stream u32]` (stdin EOF).
//! Ops: `spawn {argv, cwd, env}` -> `{stream}`; `kill {stream, signal}`; `which {command}` -> path | null.
//! Confined file operations are not here: they belong to the process-custody helper.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;

use serde_json::{json, Value};

use crate::outbox::Outbox;
use crate::platform;

pub(crate) struct Stream {
    /// The process group to signal; `None` for a watch.
    pub(crate) pid: Option<u32>,
    /// Stdin of a pipe process, or the master side of a terminal.
    pub(crate) stdin: Option<Box<dyn Write + Send>>,
    /// Ends a watch (its thread polls this with the inotify descriptor).
    pub(crate) stop: Option<crate::terminal::StopSignal>,
    /// The terminal master, for `resize`.
    pub(crate) pty: Option<i32>,
}

#[derive(Default)]
pub struct Streams {
    next: Mutex<u32>,
    pub(crate) live: Mutex<HashMap<u32, Stream>>,
}

impl Streams {
    pub(crate) fn allocate(&self) -> u32 {
        let mut next = self.next.lock().unwrap();
        *next += 1;
        *next
    }
}

pub(crate) fn tagged(stream: u32, data: &[u8]) -> Vec<u8> {
    let mut payload = Vec::with_capacity(4 + data.len());
    payload.extend_from_slice(&stream.to_be_bytes());
    payload.extend_from_slice(data);
    payload
}

fn stream_id(request: &Value) -> Option<u32> {
    request.get("stream").and_then(Value::as_u64).and_then(|value| u32::try_from(value).ok())
}

impl Streams {
    /// `cwd` is relative to the holder's working directory (the Session root) and
    /// must stay inside it; the process runs as the holder's own user, like the Agent.
    pub fn spawn(self: &Arc<Self>, request: &Value, outbox: &Arc<Outbox>) -> Result<Value, &'static str> {
        let argv: Vec<String> = request
            .get("argv")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        if argv.is_empty() {
            return Err("invalid_request");
        }
        let cwd = resolve_cwd(request.get("cwd").and_then(Value::as_str).unwrap_or(""))?;
        let mut command = Command::new(&argv[0]);
        command.args(&argv[1..]).current_dir(cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        if let Some(env) = request.get("env").and_then(Value::as_object) {
            for (key, value) in env {
                if let Some(value) = value.as_str() {
                    command.env(key, value);
                }
            }
        }
        platform::configure_agent_command(&mut command);
        let mut child = command.spawn().map_err(|error| match error.kind() {
            std::io::ErrorKind::NotFound => "ENOENT",
            std::io::ErrorKind::PermissionDenied => "EACCES",
            _ => "spawn_failed",
        })?;
        let stream = self.allocate();
        let pumps: Vec<_> = [(child.stdout.take().map(|r| Box::new(r) as Box<dyn Read + Send>), b'O'),
            (child.stderr.take().map(|r| Box::new(r) as Box<dyn Read + Send>), b'E')]
            .into_iter()
            .filter_map(|(reader, kind)| reader.map(|reader| (reader, kind)))
            .map(|(mut reader, kind)| {
                let outbox = outbox.clone();
                thread::spawn(move || {
                    let mut buffer = vec![0u8; 64 * 1024];
                    loop {
                        match reader.read(&mut buffer) {
                            Ok(0) | Err(_) => break,
                            Ok(n) => outbox.send(kind, &tagged(stream, &buffer[..n])),
                        }
                    }
                })
            })
            .collect();
        let stdin = child.stdin.take().map(|pipe| Box::new(pipe) as Box<dyn Write + Send>);
        self.live.lock().unwrap().insert(stream, Stream { pid: Some(child.id()), stdin, stop: None, pty: None });
        let outbox = outbox.clone();
        let streams = self.clone();
        thread::spawn(move || {
            let status = platform::exit_json(child.wait());
            for pump in pumps {
                let _ = pump.join();
            }
            streams.live.lock().unwrap().remove(&stream);
            outbox.send(b'X', &tagged(stream, status.to_string().as_bytes()));
        });
        Ok(json!({ "stream": stream }))
    }

    pub fn write(&self, payload: &[u8]) {
        if payload.len() < 4 {
            return;
        }
        let stream = u32::from_be_bytes(payload[..4].try_into().unwrap());
        if let Some(entry) = self.live.lock().unwrap().get_mut(&stream) {
            if let Some(pipe) = entry.stdin.as_mut() {
                let _ = pipe.write_all(&payload[4..]).and_then(|_| pipe.flush());
            }
        }
    }

    pub fn close_stdin(&self, payload: &[u8]) {
        if payload.len() < 4 {
            return;
        }
        let stream = u32::from_be_bytes(payload[..4].try_into().unwrap());
        if let Some(entry) = self.live.lock().unwrap().get_mut(&stream) {
            entry.stdin.take();
        }
    }

    pub fn kill(&self, request: &Value) -> Result<(), String> {
        let stream = stream_id(request).ok_or_else(|| "invalid_request".to_string())?;
        let live = self.live.lock().unwrap();
        let entry = live.get(&stream).ok_or_else(|| "stream_absent".to_string())?;
        if let Some(stop) = &entry.stop {
            stop.stop();
            return Ok(());
        }
        let pid = entry.pid.ok_or_else(|| "stream_absent".to_string())?;
        platform::signal_agent_group(pid, request.get("signal").and_then(Value::as_str).unwrap_or("TERM"))
    }

    /// Ends every stream's process group: the holder is leaving with the Agent.
    pub fn terminate_all(&self) {
        for entry in self.live.lock().unwrap().values() {
            if let Some(stop) = &entry.stop {
                stop.stop();
            }
            if let Some(pid) = entry.pid {
                let _ = platform::signal_agent_group(pid, "KILL");
            }
        }
    }
}

pub(crate) fn resolve_cwd(relative: &str) -> Result<PathBuf, &'static str> {
    let root = std::env::current_dir().and_then(|root| root.canonicalize()).map_err(|_| "workspace_root_unsafe")?;
    if relative.is_empty() {
        return Ok(root);
    }
    if Path::new(relative).is_absolute() {
        return Err("workspace_root_unsafe");
    }
    let resolved = root.join(relative).canonicalize().map_err(|_| "workspace_root_unsafe")?;
    if resolved.starts_with(&root) {
        Ok(resolved)
    } else {
        Err("workspace_root_unsafe")
    }
}

/// The absolute path `command` resolves to on the holder's PATH, if any.
pub fn which(command: &str) -> Option<String> {
    if command.is_empty() || command.contains('/') || command.contains('\\') {
        return None;
    }
    let path = std::env::var_os("PATH")?;
    let extensions: Vec<String> = if cfg!(windows) {
        std::env::var("PATHEXT").unwrap_or_else(|_| ".EXE;.CMD;.BAT".into()).split(';').map(str::to_string).collect()
    } else {
        vec![String::new()]
    };
    for directory in std::env::split_paths(&path) {
        for extension in &extensions {
            let candidate = directory.join(format!("{command}{extension}"));
            if is_executable(&candidate) {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

#[cfg(unix)]
fn is_executable(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    path.metadata().map(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0).unwrap_or(false)
}

#[cfg(windows)]
fn is_executable(path: &Path) -> bool {
    path.is_file()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn which_finds_a_path_executable_and_refuses_paths() {
        assert!(which("sh").is_some_and(|path| path.ends_with("/sh")));
        assert_eq!(which("./sh"), None);
        assert_eq!(which("definitely-not-a-command-happier"), None);
    }

    #[test]
    fn cwd_stays_inside_the_session_root() {
        assert!(resolve_cwd("").is_ok());
        assert_eq!(resolve_cwd("/etc"), Err("workspace_root_unsafe"));
        assert_eq!(resolve_cwd("../../.."), Err("workspace_root_unsafe"));
    }
}
