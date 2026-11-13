//! Terminals and change watches in the Session target, as numbered streams on the
//! holder channel (same `O`/`X` frames, sequence and replay as other streams).
//!
//! - `pty {argv, cwd, env, cols, rows}` -> `{stream}`: the process runs as the
//!   session leader of a new pseudo-terminal; `I` frames are keyboard input,
//!   `O` frames are terminal output; `resize {stream, cols, rows}`; `kill` signals
//!   its process group; `X` carries its exit.
//! - `watch {path, recursive}` -> `{stream}` (Linux, inotify): one JSON line per
//!   change on `O`, `{"path","kind","event"}` with root-relative paths; new
//!   directories join a recursive watch as they appear; `kill` ends it (`X`).
//!   Push only: the thread blocks in poll(2) on the inotify descriptor and a stop pipe.

use std::sync::Arc;

#[cfg(unix)]
use serde_json::json;
use serde_json::Value;

use crate::outbox::Outbox;
use crate::streams::Streams;

/// Wakes a blocked watch thread (the read end of a pipe it polls).
pub struct StopSignal {
    #[cfg(unix)]
    write: i32,
    #[cfg(unix)]
    pub(crate) read: i32,
}

impl StopSignal {
    #[cfg(unix)]
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    pub fn new() -> std::io::Result<Self> {
        let mut fds = [0i32; 2];
        if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        Ok(Self { read: fds[0], write: fds[1] })
    }

    pub fn stop(&self) {
        #[cfg(unix)]
        unsafe {
            libc::write(self.write, b"x".as_ptr().cast(), 1);
        }
    }
}

#[cfg(unix)]
impl Drop for StopSignal {
    fn drop(&mut self) {
        unsafe {
            libc::close(self.read);
            libc::close(self.write);
        }
    }
}

#[cfg(unix)]
fn argv_of(request: &Value) -> Vec<String> {
    request
        .get("argv")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(|item| item.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

#[cfg(unix)]
fn dimension(request: &Value, key: &str, fallback: u16) -> u16 {
    request.get(key).and_then(Value::as_u64).and_then(|value| u16::try_from(value).ok()).filter(|value| *value > 0).unwrap_or(fallback)
}

#[cfg(unix)]
pub fn spawn_pty(streams: &Arc<Streams>, request: &Value, outbox: &Arc<Outbox>) -> Result<Value, &'static str> {
    use std::fs::File;
    use std::io::Read;
    use std::os::fd::{FromRawFd, OwnedFd};
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::thread;

    let argv = argv_of(request);
    if argv.is_empty() {
        return Err("invalid_request");
    }
    let cwd = crate::streams::resolve_cwd(request.get("cwd").and_then(Value::as_str).unwrap_or(""))?;
    let size = libc::winsize { ws_row: dimension(request, "rows", 24), ws_col: dimension(request, "cols", 80), ws_xpixel: 0, ws_ypixel: 0 };
    // posix_openpt/grantpt/unlockpt/ptsname: libc proper on glibc and musl (no libutil).
    let master = unsafe { libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC) };
    if master < 0 || unsafe { libc::grantpt(master) } != 0 || unsafe { libc::unlockpt(master) } != 0 {
        return Err("pty_unavailable");
    }
    let mut name = [0 as libc::c_char; 128];
    if unsafe { ptsname_into(master, &mut name) } != 0 {
        unsafe { libc::close(master) };
        return Err("pty_unavailable");
    }
    let slave = unsafe { libc::open(name.as_ptr(), libc::O_RDWR | libc::O_NOCTTY | libc::O_CLOEXEC) };
    if slave < 0 {
        unsafe { libc::close(master) };
        return Err("pty_unavailable");
    }
    unsafe { libc::ioctl(master, libc::TIOCSWINSZ, &size) };
    let stdio = |fd: i32| -> Stdio { Stdio::from(unsafe { OwnedFd::from_raw_fd(libc::dup(fd)) }) };
    let mut command = Command::new(&argv[0]);
    command.args(&argv[1..]).current_dir(cwd).stdin(stdio(slave)).stdout(stdio(slave)).stderr(stdio(slave));
    if let Some(env) = request.get("env").and_then(Value::as_object) {
        for (key, value) in env {
            if let Some(value) = value.as_str() {
                command.env(key, value);
            }
        }
    }
    unsafe {
        command.pre_exec(|| {
            // Session leader with the terminal as its controlling tty: its own process group.
            if libc::setsid() < 0 || libc::ioctl(0, libc::TIOCSCTTY as _, 0) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let spawned = command.spawn();
    unsafe { libc::close(slave) };
    let mut child = match spawned {
        Ok(child) => child,
        Err(error) => {
            unsafe { libc::close(master) };
            return Err(if error.kind() == std::io::ErrorKind::NotFound { "ENOENT" } else { "spawn_failed" });
        }
    };
    let stream = streams.allocate();
    let mut reader = unsafe { File::from_raw_fd(libc::dup(master)) };
    let writer = unsafe { File::from_raw_fd(master) };
    let pump = {
        let outbox = outbox.clone();
        thread::spawn(move || {
            let mut buffer = vec![0u8; 64 * 1024];
            // EIO once the last slave holder is gone: the terminal ended.
            while let Ok(n) = reader.read(&mut buffer) {
                if n == 0 {
                    break;
                }
                outbox.send(b'O', &crate::streams::tagged(stream, &buffer[..n]));
            }
        })
    };
    streams.live.lock().unwrap().insert(stream, crate::streams::Stream {
        pid: Some(child.id()),
        stdin: Some(Box::new(writer)),
        stop: None,
        pty: Some(master),
    });
    let outbox = outbox.clone();
    let streams = streams.clone();
    thread::spawn(move || {
        let status = crate::platform::exit_json(child.wait());
        // The master stays open until the entry is removed, so read the rest first.
        let _ = pump.join();
        streams.live.lock().unwrap().remove(&stream);
        outbox.send(b'X', &crate::streams::tagged(stream, status.to_string().as_bytes()));
    });
    Ok(json!({ "stream": stream }))
}

#[cfg(target_os = "linux")]
unsafe fn ptsname_into(master: i32, name: &mut [libc::c_char; 128]) -> i32 {
    libc::ptsname_r(master, name.as_mut_ptr(), name.len())
}

#[cfg(all(unix, not(target_os = "linux")))]
unsafe fn ptsname_into(master: i32, name: &mut [libc::c_char; 128]) -> i32 {
    let pointer = libc::ptsname(master);
    if pointer.is_null() {
        return -1;
    }
    let bytes = std::ffi::CStr::from_ptr(pointer).to_bytes_with_nul();
    if bytes.len() > name.len() {
        return -1;
    }
    for (index, byte) in bytes.iter().enumerate() {
        name[index] = *byte as libc::c_char;
    }
    0
}

#[cfg(not(unix))]
pub fn spawn_pty(_: &Arc<Streams>, _: &Value, _: &Arc<Outbox>) -> Result<Value, &'static str> {
    Err("unsupported")
}

pub fn resize(streams: &Streams, request: &Value) -> Result<(), &'static str> {
    let stream = request.get("stream").and_then(Value::as_u64).and_then(|value| u32::try_from(value).ok()).ok_or("invalid_request")?;
    let master = streams.live.lock().unwrap().get(&stream).and_then(|entry| entry.pty).ok_or("stream_absent")?;
    #[cfg(unix)]
    {
        let size = libc::winsize { ws_row: dimension(request, "rows", 24), ws_col: dimension(request, "cols", 80), ws_xpixel: 0, ws_ypixel: 0 };
        if unsafe { libc::ioctl(master, libc::TIOCSWINSZ, &size) } != 0 {
            return Err("resize_failed");
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = master;
        Err("unsupported")
    }
}

#[cfg(target_os = "linux")]
pub fn spawn_watch(streams: &Arc<Streams>, request: &Value, outbox: &Arc<Outbox>) -> Result<Value, &'static str> {
    use std::collections::HashMap;
    use std::ffi::CString;
    use std::path::{Path, PathBuf};
    use std::thread;

    let root = std::env::current_dir().and_then(|root| root.canonicalize()).map_err(|_| "workspace_root_unsafe")?;
    let target = crate::streams::resolve_cwd(request.get("path").and_then(Value::as_str).unwrap_or(""))?;
    let recursive = request.get("recursive").and_then(Value::as_bool).unwrap_or(false);
    let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
    if fd < 0 {
        return Err("watch_unavailable");
    }
    let mask = libc::IN_CREATE | libc::IN_DELETE | libc::IN_MODIFY | libc::IN_CLOSE_WRITE | libc::IN_ATTRIB
        | libc::IN_MOVED_FROM | libc::IN_MOVED_TO | libc::IN_DELETE_SELF | libc::IN_MOVE_SELF | libc::IN_DONT_FOLLOW;
    let relative = move |path: &Path| path.strip_prefix(&root).map(|rel| rel.to_string_lossy().into_owned()).unwrap_or_default();
    let mut directories: HashMap<i32, PathBuf> = HashMap::new();
    fn add(fd: i32, mask: u32, path: &Path, recursive: bool, directories: &mut HashMap<i32, PathBuf>) {
        let Ok(name) = CString::new(path.as_os_str().to_string_lossy().as_bytes()) else { return };
        let wd = unsafe { libc::inotify_add_watch(fd, name.as_ptr(), mask) };
        if wd < 0 {
            return;
        }
        directories.insert(wd, path.to_path_buf());
        if !recursive {
            return;
        }
        if let Ok(entries) = std::fs::read_dir(path) {
            for entry in entries.flatten() {
                // file_type does not follow links: a linked directory is not entered.
                if entry.file_type().map(|kind| kind.is_dir()).unwrap_or(false) {
                    add(fd, mask, &entry.path(), true, directories);
                }
            }
        }
    }
    add(fd, mask, &target, recursive, &mut directories);
    if directories.is_empty() {
        unsafe { libc::close(fd) };
        return Err("watch_unavailable");
    }
    let stop = StopSignal::new().map_err(|_| "watch_unavailable")?;
    let stop_read = stop.read;
    let stream = streams.allocate();
    streams.live.lock().unwrap().insert(stream, crate::streams::Stream { pid: None, stdin: None, stop: Some(stop), pty: None });
    let outbox = outbox.clone();
    let streams = streams.clone();
    thread::spawn(move || {
        let mut buffer = vec![0u8; 64 * 1024];
        'watch: loop {
            let mut fds = [
                libc::pollfd { fd, events: libc::POLLIN, revents: 0 },
                libc::pollfd { fd: stop_read, events: libc::POLLIN, revents: 0 },
            ];
            if unsafe { libc::poll(fds.as_mut_ptr(), 2, -1) } < 0 {
                if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                break;
            }
            if fds[1].revents != 0 {
                break;
            }
            let n = unsafe { libc::read(fd, buffer.as_mut_ptr().cast(), buffer.len()) };
            if n <= 0 {
                continue;
            }
            let mut offset = 0usize;
            while offset + std::mem::size_of::<libc::inotify_event>() <= n as usize {
                let event = unsafe { &*(buffer.as_ptr().add(offset) as *const libc::inotify_event) };
                let name_start = offset + std::mem::size_of::<libc::inotify_event>();
                let name_bytes = &buffer[name_start..name_start + event.len as usize];
                let name = String::from_utf8_lossy(name_bytes.split(|byte| *byte == 0).next().unwrap_or_default()).into_owned();
                offset = name_start + event.len as usize;
                let Some(directory) = directories.get(&event.wd).cloned() else { continue };
                let path = if name.is_empty() { directory.clone() } else { directory.join(&name) };
                let is_dir = event.mask & libc::IN_ISDIR != 0;
                if recursive && is_dir && event.mask & (libc::IN_CREATE | libc::IN_MOVED_TO) != 0 {
                    add(fd, mask, &path, true, &mut directories);
                }
                if event.mask & libc::IN_IGNORED != 0 {
                    directories.remove(&event.wd);
                    if directories.is_empty() {
                        break 'watch;
                    }
                    continue;
                }
                let kind = if is_dir { "directory" } else if event.mask & (libc::IN_DELETE_SELF | libc::IN_MOVE_SELF) != 0 { "unknown" } else { "file" };
                let change = if event.mask & (libc::IN_CREATE | libc::IN_MOVED_TO) != 0 {
                    "create"
                } else if event.mask & (libc::IN_DELETE | libc::IN_MOVED_FROM | libc::IN_DELETE_SELF | libc::IN_MOVE_SELF) != 0 {
                    "delete"
                } else {
                    "change"
                };
                let line = format!("{}\n", json!({ "path": relative(&path), "kind": kind, "event": change }));
                outbox.send(b'O', &crate::streams::tagged(stream, line.as_bytes()));
            }
        }
        unsafe { libc::close(fd) };
        streams.live.lock().unwrap().remove(&stream);
        outbox.send(b'X', &crate::streams::tagged(stream, json!({ "code": 0, "signal": null }).to_string().as_bytes()));
    });
    Ok(json!({ "stream": stream }))
}

#[cfg(not(target_os = "linux"))]
pub fn spawn_watch(_: &Arc<Streams>, _: &Value, _: &Arc<Outbox>) -> Result<Value, &'static str> {
    Err("unsupported")
}
