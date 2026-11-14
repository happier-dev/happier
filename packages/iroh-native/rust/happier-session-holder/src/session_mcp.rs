//! `serve --session-mcp`: Session MCP for an Agent held in a target (container,
//! sandbox), where the Session's MCP endpoint is a socket on another Machine.
//!
//! The holder binds `<socket>.mcp` (0600, like its other sockets) and writes the
//! relay's context file `<socket>.mcp.json` (`{"v":1,"socketPath":"<socket>.mcp"}`,
//! the closed shape `mcp_relay.rs` reads), so the Agent launches the same
//! `mcp-relay` it launches on a Machine. A relay is admitted only from this holder's
//! Agent tree: the kernel-proven peer (SO_PEERCRED) runs as the holder's user and is
//! in the Agent's process group or descends from the Agent (`/proc` ancestry). The
//! holder answers the relay's upgrade itself and carries the connection on its own
//! client channel as one numbered stream (no listener but this socket, no second
//! relay):
//! - holder -> client `M` `[seq][stream u32]` + JSON `{"toolNameMaxLength"?}`: a relay
//!   connected; then `O` `[seq][stream][bytes]` (relay -> endpoint) and `X` at its end.
//! - client -> holder `I` `[stream][bytes]` (endpoint -> relay), `C` `[stream]` (close).
//!
//! The client serves the stream as one MCP session of the Session's endpoint. Other
//! platforms have no peer proof here: nothing is bound, and the relay reports
//! `mcp_socket_access_unavailable` as it does without a context.

pub fn socket_path(socket: &str) -> String {
    format!("{socket}.mcp")
}

pub fn context_path(socket: &str) -> String {
    format!("{socket}.mcp.json")
}

/// The context of the nearest ancestor that is this executable serving Session MCP
/// (`serve --socket <s> --session-mcp`): every Agent held in a target (the Session's
/// primary and any other) reaches the Session's MCP through its own holder, which
/// admits only its own Agent tree. The walk ends at init.
pub fn ancestor_holder_context(
    start: u32,
    own_executable: &std::path::Path,
    read_parent: impl Fn(u32) -> Option<u32>,
    read_executable: impl Fn(u32) -> Option<std::path::PathBuf>,
    read_args: impl Fn(u32) -> Option<Vec<String>>,
) -> Option<String> {
    let mut current = start;
    loop {
        let parent = read_parent(current)?;
        if parent <= 1 || parent == current {
            return None;
        }
        current = parent;
        if read_executable(current).as_deref() != Some(own_executable) {
            continue;
        }
        let Some(args) = read_args(current) else { continue };
        if args.get(1).map(String::as_str) != Some("serve") {
            continue;
        }
        if let Some(serve) = args.get(2..).and_then(crate::parse_serve) {
            if serve.session_mcp {
                return Some(context_path(&serve.socket));
            }
        }
    }
}

/// `ancestor_holder_context` for this process, read from `/proc` (targets are Linux).
#[cfg(target_os = "linux")]
pub fn holder_context_from_ancestry() -> Option<String> {
    let own = std::fs::read_link("/proc/self/exe").ok()?;
    ancestor_holder_context(
        std::process::id(),
        &own,
        |pid| linux::parse_stat(&std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?).map(|(parent, _)| parent),
        |pid| std::fs::read_link(format!("/proc/{pid}/exe")).ok(),
        |pid| {
            let raw = std::fs::read(format!("/proc/{pid}/cmdline")).ok()?;
            Some(raw.split(|byte| *byte == 0).filter(|part| !part.is_empty()).map(|part| String::from_utf8_lossy(part).into_owned()).collect())
        },
    )
}

#[cfg(not(target_os = "linux"))]
pub fn holder_context_from_ancestry() -> Option<String> {
    None
}

/// The relay's upgrade head (`mcp_relay::upgrade_request`): the tool-name budget when
/// valid, and the bytes after the head. `None` refuses the connection.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub fn parse_upgrade_head(head: &[u8]) -> Option<Option<u32>> {
    let text = std::str::from_utf8(head).ok()?;
    let mut lines = text.split("\r\n");
    if !lines.next()?.starts_with("GET ") {
        return None;
    }
    let (mut upgrade, mut budget) = (false, None);
    for line in lines {
        let Some((name, value)) = line.split_once(':') else { continue };
        let (name, value) = (name.trim().to_ascii_lowercase(), value.trim());
        if name == "upgrade" {
            upgrade = value.eq_ignore_ascii_case(crate::mcp_relay::UPGRADE);
        } else if name == "x-happier-tool-name-max-length" {
            let valid = !value.is_empty() && value.len() <= 6 && value.bytes().all(|b| b.is_ascii_digit());
            let parsed: u32 = if valid { value.parse().ok()? } else { return None };
            if parsed == 0 {
                return None;
            }
            budget = Some(parsed);
        }
    }
    upgrade.then_some(budget)
}

#[cfg(target_os = "linux")]
pub use linux::{bind, serve};

#[cfg(not(target_os = "linux"))]
pub fn bind(_socket: &str) -> Option<()> {
    None
}

#[cfg(not(target_os = "linux"))]
pub fn serve(_listener: (), _agent_pid: u32, _outbox: std::sync::Arc<crate::outbox::Outbox>, _streams: std::sync::Arc<crate::streams::Streams>) {}

#[cfg(target_os = "linux")]
mod linux {
    use std::io::{self, Read, Write};
    use std::os::fd::AsRawFd;
    use std::os::unix::net::{UnixListener, UnixStream};
    use std::sync::Arc;
    use std::thread;

    use serde_json::json;

    use crate::outbox::Outbox;
    use crate::streams::{tagged, Stream, Streams};

    /// Protocol boundary: the relay's upgrade head is a few short lines (`mcp_relay.rs`).
    const HEAD_MAX_BYTES: usize = 4096;

    /// Binds `<socket>.mcp` and writes its context file, both owner-only (umask 0177).
    pub fn bind(socket: &str) -> Option<UnixListener> {
        let path = super::socket_path(socket);
        let _ = std::fs::remove_file(&path);
        let previous = unsafe { libc::umask(0o177) };
        let bound = UnixListener::bind(&path).ok().and_then(|listener| {
            let context = json!({ "v": 1, "socketPath": path }).to_string();
            std::fs::write(super::context_path(socket), context).ok().map(|_| listener)
        });
        unsafe {
            libc::umask(previous);
        }
        bound
    }

    pub fn serve(listener: UnixListener, agent_pid: u32, outbox: Arc<Outbox>, streams: Arc<Streams>) {
        thread::spawn(move || loop {
            let Ok((connection, _)) = listener.accept() else { continue };
            let outbox = outbox.clone();
            let streams = streams.clone();
            thread::spawn(move || relay(connection, agent_pid, &outbox, &streams));
        });
    }

    fn relay(mut connection: UnixStream, agent_pid: u32, outbox: &Arc<Outbox>, streams: &Arc<Streams>) {
        if !peer_in_agent_tree(&connection, agent_pid) {
            return;
        }
        let Some((budget, early)) = read_head(&mut connection) else { return };
        let switched = format!("HTTP/1.1 101 Switching Protocols\r\nUpgrade: {}\r\nConnection: Upgrade\r\n\r\n", crate::mcp_relay::UPGRADE);
        let Ok(writer) = connection.try_clone() else { return };
        if connection.write_all(switched.as_bytes()).is_err() {
            return;
        }
        let stream = streams.allocate();
        streams.live.lock().unwrap().insert(stream, Stream { pid: None, stdin: Some(Box::new(ToRelay(writer))), stop: None, pty: None });
        let opened = match budget {
            Some(max) => json!({ "toolNameMaxLength": max }),
            None => json!({}),
        };
        outbox.send(b'M', &tagged(stream, opened.to_string().as_bytes()));
        if !early.is_empty() {
            outbox.send(b'O', &tagged(stream, &early));
        }
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            match connection.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => outbox.send(b'O', &tagged(stream, &buffer[..n])),
            }
        }
        streams.live.lock().unwrap().remove(&stream);
        outbox.send(b'X', &tagged(stream, br#"{"code":0,"signal":null}"#));
    }

    /// Endpoint -> relay bytes; dropping it (the client's `C`, or the stream's end)
    /// half-closes the connection so the relay sees its endpoint close and exits.
    struct ToRelay(UnixStream);

    impl Write for ToRelay {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.write(buf)
        }
        fn flush(&mut self) -> io::Result<()> {
            self.0.flush()
        }
    }

    impl Drop for ToRelay {
        fn drop(&mut self) {
            let _ = self.0.shutdown(std::net::Shutdown::Write);
        }
    }

    fn read_head(connection: &mut UnixStream) -> Option<(Option<u32>, Vec<u8>)> {
        let mut head = Vec::new();
        let mut buffer = [0u8; 1024];
        loop {
            let n = connection.read(&mut buffer).ok()?;
            if n == 0 {
                return None;
            }
            head.extend_from_slice(&buffer[..n]);
            if let Some(end) = head.windows(4).position(|window| window == b"\r\n\r\n") {
                let budget = super::parse_upgrade_head(&head[..end])?;
                return Some((budget, head[end + 4..].to_vec()));
            }
            if head.len() > HEAD_MAX_BYTES {
                return None;
            }
        }
    }

    fn peer_in_agent_tree(connection: &UnixStream, agent_pid: u32) -> bool {
        let mut credentials = libc::ucred { pid: 0, uid: 0, gid: 0 };
        let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
        let read = unsafe {
            libc::getsockopt(connection.as_raw_fd(), libc::SOL_SOCKET, libc::SO_PEERCRED,
                &mut credentials as *mut libc::ucred as *mut libc::c_void, &mut length)
        };
        if read != 0 || credentials.pid <= 0 || credentials.uid != unsafe { libc::geteuid() } {
            return false;
        }
        in_agent_tree(credentials.pid as u32, agent_pid, |pid| {
            let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
            parse_stat(&stat)
        })
    }

    /// `(ppid, pgrp)` from `/proc/<pid>/stat` (the fields after the parenthesised name).
    pub(super) fn parse_stat(stat: &str) -> Option<(u32, u32)> {
        let mut fields = stat.get(stat.rfind(')')? + 1..)?.split_whitespace();
        let _state = fields.next()?;
        Some((fields.next()?.parse().ok()?, fields.next()?.parse().ok()?))
    }

    /// The Agent, a process in its group, or a descendant of it; the walk ends at init.
    pub(super) fn in_agent_tree(pid: u32, agent_pid: u32, read_stat: impl Fn(u32) -> Option<(u32, u32)>) -> bool {
        let mut current = pid;
        loop {
            if current == agent_pid {
                return true;
            }
            let Some((parent, group)) = read_stat(current) else { return false };
            if group == agent_pid {
                return true;
            }
            if parent <= 1 || parent == current {
                return false;
            }
            current = parent;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upgrade_head_needs_the_relay_upgrade_and_a_valid_budget() {
        let head = |extra: &str| format!("GET /mcp-relay HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: happier-mcp-relay\r\n{extra}");
        assert_eq!(parse_upgrade_head(head("").trim_end().as_bytes()), Some(None));
        assert_eq!(parse_upgrade_head(head("X-Happier-Tool-Name-Max-Length: 64").as_bytes()), Some(Some(64)));
        assert_eq!(parse_upgrade_head(head("X-Happier-Tool-Name-Max-Length: 0").as_bytes()), None);
        assert_eq!(parse_upgrade_head(head("X-Happier-Tool-Name-Max-Length: 1234567").as_bytes()), None);
        assert_eq!(parse_upgrade_head(b"GET /mcp HTTP/1.1\r\nUpgrade: websocket"), None);
        assert_eq!(parse_upgrade_head(b"POST /mcp-relay HTTP/1.1\r\nUpgrade: happier-mcp-relay"), None);
        // The relay builds exactly what the holder accepts.
        let request = crate::mcp_relay::upgrade_request(None, Some(12));
        let end = request.windows(4).position(|window| window == b"\r\n\r\n").unwrap();
        assert_eq!(parse_upgrade_head(&request[..end]), Some(Some(12)));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn agent_tree_is_the_agent_its_group_and_its_descendants() {
        use std::collections::HashMap;
        // pid -> (ppid, pgrp): init 1; holder 10; Agent 20 (own group); relay 30 under the Agent;
        // a grandchild 40 that left the group; an unrelated process 50 under the holder.
        let table: HashMap<u32, (u32, u32)> = [(10, (1, 10)), (20, (10, 20)), (30, (20, 20)), (40, (30, 40)), (50, (10, 50))].into();
        let read = |pid: u32| table.get(&pid).copied();
        assert!(linux::in_agent_tree(20, 20, read));
        assert!(linux::in_agent_tree(30, 20, read));
        assert!(linux::in_agent_tree(40, 20, read));
        assert!(!linux::in_agent_tree(50, 20, read));
        assert!(!linux::in_agent_tree(10, 20, read));
        assert!(!linux::in_agent_tree(99, 20, read));
        assert_eq!(linux::parse_stat("123 (a b) c) S 45 67 67 0"), Some((45, 67)));
    }

    #[test]
    fn a_relay_finds_its_own_session_mcp_holder_among_its_ancestors() {
        use std::collections::HashMap;
        use std::path::{Path, PathBuf};
        let holder = Path::new("/home/u/.happier/holder/v/happier-session-holder");
        // pid -> (ppid, exe, args): relay 40 <- Agent 30 <- flock 20 <- holder 10 (`serve --session-mcp`) <- init.
        // A second holder 11 without `--session-mcp` (local Agent) and a stranger 12 named like a holder.
        let table: HashMap<u32, (u32, PathBuf, Vec<String>)> = [
            (40, (30, holder.into(), vec!["holder".into(), "mcp-relay".into()])),
            (30, (20, "/usr/bin/codex".into(), vec!["codex".into()])),
            (20, (10, "/usr/bin/flock".into(), vec!["flock".into(), "-s".into(), "l".into(), "codex".into()])),
            (10, (1, holder.into(), ["holder", "serve", "--socket", "/run/a.sock", "--session-mcp", "--", "flock"].map(String::from).to_vec())),
            (41, (11, holder.into(), vec!["holder".into(), "mcp-relay".into()])),
            (11, (1, holder.into(), ["holder", "serve", "--socket", "/run/b.sock", "--", "agent"].map(String::from).to_vec())),
            (42, (12, holder.into(), vec!["holder".into(), "mcp-relay".into()])),
            (12, (1, "/tmp/other".into(), ["holder", "serve", "--socket", "/run/c.sock", "--session-mcp", "--", "x"].map(String::from).to_vec())),
        ].into();
        let find = |start: u32| ancestor_holder_context(start, holder,
            |pid| table.get(&pid).map(|row| row.0), |pid| table.get(&pid).map(|row| row.1.clone()), |pid| table.get(&pid).map(|row| row.2.clone()));
        assert_eq!(find(40), Some("/run/a.sock.mcp.json".into()));
        assert_eq!(find(41), None);
        assert_eq!(find(42), None);
        assert_eq!(find(99), None);
    }
}
