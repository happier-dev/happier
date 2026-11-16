//! The placed custody helper is the Darwin OS proof boundary. No OS ABI or
//! process-table interpretation is repeated in the holder.

use std::collections::HashMap;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::Value;

#[derive(Debug, PartialEq)]
pub struct Peer { pub pid: u32, pub uid: u32 }

/// `ensureManagedGuestSessionHolder` places and digest-verifies this exact helper
/// beside the holder. This is only used by a target's `--session-mcp` path.
pub fn target_helper_path() -> Option<PathBuf> {
    Some(std::env::current_exe().ok()?.with_file_name("happier-process-custody"))
}

fn read_output(command: &mut Command) -> Option<Value> {
    let output = command.stdin(Stdio::null()).stderr(Stdio::null()).output().ok()?;
    if !output.status.success() { return None; }
    let value: Value = serde_json::from_slice(&output.stdout).ok()?;
    (value.get("v")?.as_u64()? == 1).then_some(value)
}

fn unsigned(value: &Value) -> Option<u32> { value.as_u64()?.try_into().ok() }
fn pid(value: &Value) -> Option<u32> { unsigned(value).filter(|pid| *pid > 0) }

/// The accepted connection itself is inherited as FD3, the existing helper API;
/// neither a socket path nor a peer-supplied PID can stand in for the OS proof.
pub fn peer_identity(helper: &Path, connection: &UnixStream) -> Option<Peer> {
    let mut command = Command::new(helper);
    command.arg("peer-identity");
    let fd = connection.as_raw_fd();
    unsafe {
        command.pre_exec(move || {
            if libc::dup2(fd, 3) < 0 || libc::fcntl(3, libc::F_SETFD, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let proof = read_output(&mut command);
    // The helper restores Node/libuv's nonblocking FD contract. This holder's
    // transport instead uses blocking std::io reads on the shared socket.
    connection.set_nonblocking(false).ok()?;
    let proof = proof?;
    if proof.get("t")?.as_str()? != "peer-identity" { return None; }
    Some(Peer { pid: pid(proof.get("pid")?)?, uid: unsigned(proof.get("uid")?)? })
}

pub struct ProcessSnapshot { rows: HashMap<u32, Value> }

impl ProcessSnapshot {
    pub fn stat(&self, process: u32) -> Option<(u32, u32)> {
        let row = self.rows.get(&process)?;
        Some((unsigned(row.get("ppid")?)?, unsigned(row.get("pgid")?)?))
    }
    pub fn executable(&self, process: u32) -> Option<PathBuf> {
        Some(PathBuf::from(self.rows.get(&process)?.get("executablePath")?.as_str()?))
    }
    pub fn args(&self, process: u32) -> Option<Vec<String>> {
        self.rows.get(&process)?.get("argv")?.as_array()?.iter().map(|arg| Some(arg.as_str()?.to_string())).collect()
    }
}

/// One projected snapshot at relay startup or connection admission, never per
/// byte/message and never a background sampler. Missing OS evidence fails closed.
pub fn process_snapshot(helper: &Path, process: u32, executable: bool) -> Option<ProcessSnapshot> {
    let value = read_output(Command::new(helper).args([
        "process-census", "--scope=own_principal", &format!("--pids={process}"),
        "--include-ancestors=true", if executable { "--fields=executablePath,argv" } else { "--fields=" },
    ]))?;
    let rows = value.get("rows")?.as_array()?.iter().map(|row| Some((pid(row.get("pid")?)?, row.clone())))
        .collect::<Option<HashMap<_, _>>>()?;
    Some(ProcessSnapshot { rows })
}

pub fn peer_in_agent_tree(helper: &Path, connection: &UnixStream, agent_pid: u32) -> bool {
    let Some(peer) = peer_identity(helper, connection) else { return false };
    if peer.uid != unsafe { libc::geteuid() } { return false; }
    let Some(census) = process_snapshot(helper, peer.pid, false) else { return false };
    crate::session_mcp::in_agent_tree(peer.pid, agent_pid, |pid| census.stat(pid))
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::net::UnixStream;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    struct Helper(PathBuf);
    impl Helper {
        fn new(script: &str) -> Self {
            static SEQUENCE: AtomicU64 = AtomicU64::new(0);
            let directory = std::env::temp_dir().join(format!("holder-custody-{}-{}", std::process::id(), SEQUENCE.fetch_add(1, Ordering::Relaxed)));
            std::fs::create_dir(&directory).unwrap();
            let path = directory.join("happier-process-custody");
            std::fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
            Self(path)
        }
    }
    impl Drop for Helper {
        fn drop(&mut self) { let _ = std::fs::remove_dir_all(self.0.parent().unwrap()); }
    }

    #[test]
    fn peer_identity_uses_the_inherited_socket_and_rejects_unproven_output() {
        use std::io::Write;
        let (accepted, mut client) = UnixStream::pair().unwrap();
        client.write_all(b"accepted-socket-witness\n").unwrap();
        let helper = Helper::new("test \"$1\" = peer-identity && test -S /dev/fd/3 || exit 3\nIFS= read -r witness <&3\ntest \"$witness\" = accepted-socket-witness || exit 3\nprintf '%s' '{\"v\":1,\"t\":\"peer-identity\",\"pid\":42,\"uid\":501}'");
        assert_eq!(peer_identity(&helper.0, &accepted), Some(Peer { pid: 42, uid: 501 }));
        for output in ["{}", "{\"v\":1,\"t\":\"peer-identity\",\"pid\":0,\"uid\":501}", "{\"v\":1,\"t\":\"peer-identity\",\"pid\":42}"] {
            let helper = Helper::new(&format!("printf '%s' '{output}'"));
            assert_eq!(peer_identity(&helper.0, &accepted), None);
        }
        let failed = Helper::new("printf '%s' '{\"v\":1,\"t\":\"peer-identity\",\"pid\":42,\"uid\":501}'; exit 3");
        assert_eq!(peer_identity(&failed.0, &accepted), None);
    }

    #[test]
    fn peer_identity_restores_blocking_transport_after_the_native_helper_boundary() {
        let (accepted, _client) = UnixStream::pair().unwrap();
        // The Go peer-identity boundary leaves inherited sockets nonblocking for
        // Node/libuv. Model that observable OS state at the external boundary.
        accepted.set_nonblocking(true).unwrap();
        let helper = Helper::new("printf '%s' '{\"v\":1,\"t\":\"peer-identity\",\"pid\":42,\"uid\":501}'");
        assert_eq!(peer_identity(&helper.0, &accepted), Some(Peer { pid: 42, uid: 501 }));
        let flags = unsafe { libc::fcntl(accepted.as_raw_fd(), libc::F_GETFL) };
        assert!(flags >= 0 && flags & libc::O_NONBLOCK == 0, "the holder transport must retain blocking reads");
    }

    #[test]
    fn connection_admission_needs_same_user_and_proven_agent_ancestry() {
        let (accepted, _client) = UnixStream::pair().unwrap();
        let uid = unsafe { libc::geteuid() };
        let script = |user, parent| format!("case \"$1\" in\npeer-identity) printf '%s' '{{\"v\":1,\"t\":\"peer-identity\",\"pid\":42,\"uid\":{user}}}';;\nprocess-census) printf '%s' '{{\"v\":1,\"rows\":[{{\"pid\":42,\"ppid\":{parent},\"pgid\":42}},{{\"pid\":20,\"ppid\":10,\"pgid\":20}}]}}';;\n*) exit 3;;\nesac");
        let child = Helper::new(&script(uid, 20));
        assert!(peer_in_agent_tree(&child.0, &accepted, 20));
        let stranger = Helper::new(&script(uid, 1));
        assert!(!peer_in_agent_tree(&stranger.0, &accepted, 20));
        let other_user = Helper::new(&script(uid + 1, 20));
        assert!(!peer_in_agent_tree(&other_user.0, &accepted, 20));
        let unavailable = Helper::new("exit 5");
        assert!(!peer_in_agent_tree(&unavailable.0, &accepted, 20));
    }

    #[test]
    fn projected_census_supplies_the_existing_holder_ancestry_and_agent_tree_predicates() {
        let helper = Helper::new("test \"$1\" = process-census || exit 3\nprintf '%s' '{\"v\":1,\"rows\":[{\"pid\":40,\"ppid\":30,\"pgid\":30},{\"pid\":30,\"ppid\":10,\"pgid\":30},{\"pid\":10,\"ppid\":1,\"pgid\":10,\"executablePath\":\"/target/holder\",\"argv\":[\"holder\",\"serve\",\"--socket\",\"/target/socket\",\"--session-mcp\",\"--\",\"agent\"]}]}'");
        let census = process_snapshot(&helper.0, 40, true).unwrap();
        assert!(crate::session_mcp::in_agent_tree(40, 30, |pid| census.stat(pid)));
        assert!(!crate::session_mcp::in_agent_tree(10, 30, |pid| census.stat(pid)));
        assert_eq!(crate::session_mcp::ancestor_holder_context(40, Path::new("/target/holder"),
            |pid| census.stat(pid).map(|(parent, _)| parent), |pid| census.executable(pid), |pid| census.args(pid)),
            Some("/target/socket.mcp.json".into()));
        let unavailable = Helper::new("printf '%s' '{\"v\":1,\"rows\":null}'");
        assert!(process_snapshot(&unavailable.0, 40, true).is_none());
    }
}
