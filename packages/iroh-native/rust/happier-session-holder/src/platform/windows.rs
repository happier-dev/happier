//! Windows: a local named pipe with an owner-only DACL (`OW` owner rights plus
//! SYSTEM) that rejects remote clients. Pipe handles are overlapped so one reader
//! thread and one writer thread can use a connection at the same time (synchronous
//! handles serialize all I/O on a file object). The Agent starts in a new process
//! group; tree custody is the holder's own kill-on-close Job, which the process-custody
//! helper's `held-launch` creates outside the runner's Job and the Agent inherits.

use std::ffi::c_void;
use std::io::{self, Read, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
use std::os::windows::process::CommandExt;
use std::process::{Command, ExitStatus};
use std::ptr::{null, null_mut};
use std::sync::Arc;

use serde_json::{json, Value};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, LocalFree, ERROR_IO_PENDING, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, HANDLE, INVALID_HANDLE_VALUE,
};
use windows_sys::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
use windows_sys::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, ReadFile, WriteFile, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_FLAG_OVERLAPPED, FILE_GENERIC_READ,
    FILE_GENERIC_WRITE, OPEN_EXISTING, PIPE_ACCESS_DUPLEX,
};
use windows_sys::Win32::System::IO::{GetOverlappedResult, OVERLAPPED};
use windows_sys::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, WaitNamedPipeW, NMPWAIT_WAIT_FOREVER, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows_sys::Win32::System::Threading::{
    CreateEventW, OpenProcess, TerminateProcess, CREATE_NEW_PROCESS_GROUP, CREATE_NO_WINDOW, PROCESS_TERMINATE,
};

use crate::outbox::ClientWriter;

const OWNER_ONLY_PIPE_SDDL: &str = "D:P(A;;GA;;;OW)(A;;GA;;;SY)";

fn wide(value: &str) -> Vec<u16> {
    std::ffi::OsStr::new(value).encode_wide().chain(std::iter::once(0)).collect()
}

pub fn become_session_leader() {}

pub fn add_agent_args(command: &mut Command, args: &[String], verbatim: bool) {
    if verbatim {
        for arg in args {
            command.raw_arg(arg);
        }
    } else {
        command.args(args);
    }
}

pub fn configure_agent_command(command: &mut Command) {
    command.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

pub fn detach_standard_streams() {
    // The spawner's pipes are closed by dropping them; later writes are ignored.
    unsafe {
        use windows_sys::Win32::System::Console::{GetStdHandle, SetStdHandle, STD_ERROR_HANDLE, STD_OUTPUT_HANDLE};
        for which in [STD_OUTPUT_HANDLE, STD_ERROR_HANDLE] {
            let handle = GetStdHandle(which);
            if !handle.is_null() && handle != INVALID_HANDLE_VALUE {
                CloseHandle(handle);
            }
            SetStdHandle(which, null_mut());
        }
    }
}

pub fn exit_json(status: io::Result<ExitStatus>) -> Value {
    match status {
        Ok(status) => json!({ "code": status.code(), "signal": null }),
        Err(error) => json!({ "code": null, "signal": null, "error": error.to_string() }),
    }
}

/// Windows has no process-group signal. KILL/TERM end the Agent root; its
/// descendants end with the holder's kill-on-close Job (created by `held-launch`).
pub fn signal_agent_group(agent_pid: u32, signal: &str) -> Result<(), String> {
    if !matches!(signal, "TERM" | "SIGTERM" | "KILL" | "SIGKILL") {
        return Err("unsupported_signal".into());
    }
    unsafe {
        let process = OpenProcess(PROCESS_TERMINATE, 0, agent_pid);
        if process.is_null() {
            return Err("agent_group_absent".into());
        }
        let ok = TerminateProcess(process, 1);
        CloseHandle(process);
        if ok == 0 {
            return Err(io::Error::last_os_error().to_string());
        }
    }
    Ok(())
}

/// One overlapped pipe handle shared by a reader and a writer half.
struct PipeHandle(OwnedHandle);
unsafe impl Send for PipeHandle {}
unsafe impl Sync for PipeHandle {}

impl PipeHandle {
    fn raw(&self) -> HANDLE {
        self.0.as_raw_handle() as HANDLE
    }

    fn overlapped_io(&self, read: bool, buffer: *mut u8, len: u32) -> io::Result<usize> {
        unsafe {
            let event = CreateEventW(null(), 1, 0, null());
            if event.is_null() {
                return Err(io::Error::last_os_error());
            }
            let mut overlapped: OVERLAPPED = std::mem::zeroed();
            overlapped.hEvent = event;
            let mut transferred = 0u32;
            let started = if read {
                ReadFile(self.raw(), buffer, len, null_mut(), &mut overlapped)
            } else {
                WriteFile(self.raw(), buffer, len, null_mut(), &mut overlapped)
            };
            let result = if started != 0 || GetLastError() == ERROR_IO_PENDING {
                if GetOverlappedResult(self.raw(), &overlapped, &mut transferred, 1) != 0 {
                    Ok(transferred as usize)
                } else {
                    Err(io::Error::last_os_error())
                }
            } else {
                Err(io::Error::last_os_error())
            };
            CloseHandle(event);
            match result {
                // A broken pipe is a clean end of stream for the reader.
                Err(error) if read && error.raw_os_error() == Some(109) => Ok(0),
                other => other,
            }
        }
    }
}

struct PipeReader(Arc<PipeHandle>);
struct PipeWriter(Arc<PipeHandle>);

impl Read for PipeReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.0.overlapped_io(true, buf.as_mut_ptr(), buf.len() as u32)
    }
}

impl Write for PipeWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.overlapped_io(false, buf.as_ptr() as *mut u8, buf.len() as u32)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl ClientWriter for PipeWriter {
    fn close(&mut self) {
        unsafe {
            DisconnectNamedPipe(self.0.raw());
        }
    }
}

/// Like a bound Unix socket, a bound listener always has a listening pipe instance: one is
/// created at `bind` and the next before `accept` returns a connection, so a client that
/// connects right after the readiness line (or between two accepts) finds the pipe. A
/// named pipe with no listening instance does not exist for `CreateFileW`.
pub struct Listener {
    path: Vec<u16>,
    security: PSECURITY_DESCRIPTOR,
    first: std::sync::atomic::AtomicBool,
    listening: std::sync::Mutex<Option<PipeHandle>>,
}
unsafe impl Send for Listener {}
unsafe impl Sync for Listener {}

impl Listener {
    pub fn bind(path: &str) -> io::Result<Self> {
        if !path.starts_with(r"\\.\pipe\") {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "holder pipe path must be local"));
        }
        let mut security: PSECURITY_DESCRIPTOR = null_mut();
        let ok = unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                wide(OWNER_ONLY_PIPE_SDDL).as_ptr(),
                SDDL_REVISION_1,
                &mut security,
                null_mut(),
            )
        };
        if ok == 0 {
            return Err(io::Error::last_os_error());
        }
        let listener = Self { path: wide(path), security, first: std::sync::atomic::AtomicBool::new(true),
            listening: std::sync::Mutex::new(None) };
        let instance = listener.create_instance()?;
        *listener.listening.lock().unwrap() = Some(instance);
        Ok(listener)
    }

    fn create_instance(&self) -> io::Result<PipeHandle> {
        let attributes = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.security as *mut c_void,
            bInheritHandle: 0,
        };
        let first = self.first.swap(false, std::sync::atomic::Ordering::SeqCst);
        let handle = unsafe {
            CreateNamedPipeW(
                self.path.as_ptr(),
                PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED | if first { FILE_FLAG_FIRST_PIPE_INSTANCE } else { 0 },
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                PIPE_UNLIMITED_INSTANCES,
                64 * 1024,
                64 * 1024,
                0,
                &attributes,
            )
        };
        if handle == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        Ok(PipeHandle(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) }))
    }

    pub fn accept(&self) -> io::Result<(Box<dyn Read + Send>, Box<dyn ClientWriter>)> {
        let listening = self.listening.lock().unwrap().take();
        let pipe = match listening {
            Some(pipe) => pipe,
            None => self.create_instance()?,
        };
        unsafe {
            let event = CreateEventW(null(), 1, 0, null());
            let mut overlapped: OVERLAPPED = std::mem::zeroed();
            overlapped.hEvent = event;
            let connected = ConnectNamedPipe(pipe.raw(), &mut overlapped);
            let error = GetLastError();
            let mut ignored = 0u32;
            let ok = connected != 0
                || error == ERROR_PIPE_CONNECTED
                || (error == ERROR_IO_PENDING && GetOverlappedResult(pipe.raw(), &overlapped, &mut ignored, 1) != 0);
            CloseHandle(event);
            if !ok {
                return Err(io::Error::last_os_error());
            }
        }
        // The next client finds a listening instance while this one is served; when it cannot
        // be created now, the next `accept` creates it.
        *self.listening.lock().unwrap() = self.create_instance().ok();
        let shared = Arc::new(pipe);
        Ok((Box::new(PipeReader(shared.clone())), Box::new(PipeWriter(shared))))
    }

    pub fn remove(&self) {}
}

impl Drop for Listener {
    fn drop(&mut self) {
        unsafe {
            LocalFree(self.security as _);
        }
    }
}

pub fn remove_socket_path(_path: &str) {}

pub fn connect(path: &str) -> io::Result<(Box<dyn Read + Send>, Box<dyn ClientWriter>)> {
    let handle = unsafe {
        CreateFileW(
            wide(path).as_ptr(),
            FILE_GENERIC_READ | FILE_GENERIC_WRITE,
            0,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OVERLAPPED,
            null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        let error = io::Error::last_os_error();
        // Every instance is serving a client (the holder is between two accepts): the named-pipe
        // client contract is to wait for an instance, then open again (libuv does the same).
        if error.raw_os_error() == Some(ERROR_PIPE_BUSY as i32) && unsafe { WaitNamedPipeW(wide(path).as_ptr(), NMPWAIT_WAIT_FOREVER) } != 0 {
            return connect(path);
        }
        return Err(error);
    }
    let shared = Arc::new(PipeHandle(unsafe { OwnedHandle::from_raw_handle(handle as RawHandle) }));
    Ok((Box::new(PipeReader(shared.clone())), Box::new(PipeWriter(shared))))
}
