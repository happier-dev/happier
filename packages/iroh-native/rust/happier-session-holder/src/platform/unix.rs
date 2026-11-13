//! Unix: a 0600 Unix socket (bound under umask 0177 inside the client's 0700
//! directory), the holder as its own session leader, the Agent as the leader of its
//! own process group.

use std::io::{self, Read};
use std::os::unix::net::{UnixListener, UnixStream};
use std::os::unix::process::{CommandExt, ExitStatusExt};
use std::process::{Command, ExitStatus};

use serde_json::{json, Value};

use crate::outbox::ClientWriter;

pub fn become_session_leader() {
    // Detached from the spawner's session and terminal: a runner crash or a closed
    // terminal sends the holder no SIGHUP. Fails harmlessly if already a leader.
    unsafe {
        libc::setsid();
    }
}

/// Verbatim command lines exist only on Windows; POSIX argv is already exact.
pub fn add_agent_args(command: &mut Command, args: &[String], _verbatim: bool) {
    command.args(args);
}

pub fn configure_agent_command(command: &mut Command) {
    command.process_group(0);
}

pub fn detach_standard_streams() {
    let null = std::fs::OpenOptions::new().read(true).write(true).open("/dev/null");
    if let Ok(null) = null {
        use std::os::fd::AsRawFd;
        unsafe {
            libc::dup2(null.as_raw_fd(), 0);
            libc::dup2(null.as_raw_fd(), 1);
            libc::dup2(null.as_raw_fd(), 2);
        }
    }
}

pub fn exit_json(status: io::Result<ExitStatus>) -> Value {
    match status {
        Ok(status) => json!({ "code": status.code(), "signal": status.signal() }),
        Err(error) => json!({ "code": null, "signal": null, "error": error.to_string() }),
    }
}

fn signal_number(name: &str) -> Option<i32> {
    Some(match name {
        "TERM" | "SIGTERM" => libc::SIGTERM,
        "KILL" | "SIGKILL" => libc::SIGKILL,
        "INT" | "SIGINT" => libc::SIGINT,
        "HUP" | "SIGHUP" => libc::SIGHUP,
        "QUIT" | "SIGQUIT" => libc::SIGQUIT,
        _ => return None,
    })
}

pub fn signal_agent_group(agent_pid: u32, signal: &str) -> Result<(), String> {
    let number = signal_number(signal).ok_or_else(|| "unsupported_signal".to_string())?;
    let result = unsafe { libc::kill(-(agent_pid as i32), number) };
    if result == 0 {
        return Ok(());
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(libc::ESRCH) {
        return Err("agent_group_absent".into());
    }
    Err(error.to_string())
}

pub struct Listener {
    listener: UnixListener,
    path: String,
}

struct UnixClient(UnixStream);

impl io::Write for UnixClient {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.0.flush()
    }
}

impl ClientWriter for UnixClient {
    fn close(&mut self) {
        let _ = self.0.shutdown(std::net::Shutdown::Both);
    }
}

impl Listener {
    pub fn bind(path: &str) -> io::Result<Self> {
        // A stale socket from a holder that died without cleanup would block bind.
        // The client chose this per-Session path and owns its directory.
        let _ = std::fs::remove_file(path);
        let previous = unsafe { libc::umask(0o177) };
        let bound = UnixListener::bind(path);
        unsafe {
            libc::umask(previous);
        }
        Ok(Self { listener: bound?, path: path.to_string() })
    }

    pub fn accept(&self) -> io::Result<(Box<dyn Read + Send>, Box<dyn ClientWriter>)> {
        let (stream, _) = self.listener.accept()?;
        let writer = stream.try_clone()?;
        Ok((Box::new(stream), Box::new(UnixClient(writer))))
    }

    pub fn remove(&self) {
        remove_socket_path(&self.path);
    }
}

pub fn remove_socket_path(path: &str) {
    let _ = std::fs::remove_file(path);
}

pub fn connect(path: &str) -> io::Result<(Box<dyn Read + Send>, Box<dyn ClientWriter>)> {
    let stream = UnixStream::connect(path)?;
    let writer = stream.try_clone()?;
    Ok((Box::new(stream), Box::new(UnixClient(writer))))
}
