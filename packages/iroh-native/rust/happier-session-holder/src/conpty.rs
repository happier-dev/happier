//! Windows: the held Agent in the OS pseudoconsole (ConPTY, `CreatePseudoConsole`).
//!
//! The Agent is created with `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`, so its console is the
//! pseudoconsole: its input is the input pipe, the console's rendering (VT) is the output
//! pipe. The holder runs in its own kill-on-close Job, created outside the runner's Job by
//! the process-custody helper's `held-launch`, and the Agent inherits it. After the Agent exits, closing the
//! pseudoconsole flushes the remaining rendering and ends the output pipe.

use std::ffi::c_void;
use std::fs::File;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::FromRawHandle;
use std::ptr::{null, null_mut};

use serde_json::{json, Value};
use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::System::Console::{ClosePseudoConsole, CreatePseudoConsole, ResizePseudoConsole, COORD, HPCON};
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::{
    CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess, InitializeProcThreadAttributeList,
    UpdateProcThreadAttribute, WaitForSingleObject, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT, INFINITE,
    PROCESS_INFORMATION, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, STARTF_USESTDHANDLES, STARTUPINFOEXW,
};

/// A started pseudoconsole Agent.
pub struct ConptyAgent {
    pub pid: u32,
    process: SendHandle,
    pub console: HPCON,
    /// Keyboard input (the pseudoconsole's input pipe).
    pub input: File,
    /// The pseudoconsole's VT rendering of the Agent's console.
    pub output: File,
}

struct SendHandle(HANDLE);
unsafe impl Send for SendHandle {}

fn coord(cols: u16, rows: u16) -> COORD {
    COORD { X: cols.min(i16::MAX as u16) as i16, Y: rows.min(i16::MAX as u16) as i16 }
}

/// One argument quoted for `CommandLineToArgvW` / the MSVC runtime (as Rust's std does).
fn quote(arg: &str, out: &mut String) {
    if !arg.is_empty() && !arg.contains([' ', '\t', '\n', '\x0b', '"']) {
        out.push_str(arg);
        return;
    }
    out.push('"');
    let mut backslashes = 0usize;
    for ch in arg.chars() {
        if ch == '\\' {
            backslashes += 1;
            continue;
        }
        if ch == '"' {
            out.extend(std::iter::repeat('\\').take(backslashes * 2 + 1));
        } else {
            out.extend(std::iter::repeat('\\').take(backslashes));
        }
        backslashes = 0;
        out.push(ch);
    }
    out.extend(std::iter::repeat('\\').take(backslashes * 2));
    out.push('"');
}

/// The command line: the program quoted, then each argument quoted, or (verbatim) the
/// already rendered tail appended as is (Node's `windowsVerbatimArguments`).
pub fn command_line(argv: &[String], verbatim: bool) -> String {
    let mut line = String::new();
    quote(&argv[0], &mut line);
    for arg in &argv[1..] {
        line.push(' ');
        if verbatim { line.push_str(arg) } else { quote(arg, &mut line) }
    }
    line
}

pub fn spawn(argv: &[String], verbatim: bool, cols: u16, rows: u16) -> Result<ConptyAgent, String> {
    let fail = |what: &str| format!("{what}: {}", std::io::Error::last_os_error());
    unsafe {
        let (mut input_read, mut input_write, mut output_read, mut output_write): (HANDLE, HANDLE, HANDLE, HANDLE) =
            (null_mut(), null_mut(), null_mut(), null_mut());
        if CreatePipe(&mut input_read, &mut input_write, null(), 0) == 0 {
            return Err(fail("input pipe"));
        }
        if CreatePipe(&mut output_read, &mut output_write, null(), 0) == 0 {
            CloseHandle(input_read);
            CloseHandle(input_write);
            return Err(fail("output pipe"));
        }
        let mut console: HPCON = 0;
        let created = CreatePseudoConsole(coord(cols, rows), input_read, output_write, 0, &mut console);
        // The pseudoconsole holds its own references to its ends.
        CloseHandle(input_read);
        CloseHandle(output_write);
        if created != 0 {
            CloseHandle(input_write);
            CloseHandle(output_read);
            return Err(format!("CreatePseudoConsole: HRESULT {created:#x}"));
        }
        let close_all = |console: HPCON| {
            ClosePseudoConsole(console);
            CloseHandle(input_write);
            CloseHandle(output_read);
        };
        let mut size = 0usize;
        InitializeProcThreadAttributeList(null_mut(), 1, 0, &mut size);
        let mut attributes = vec![0u8; size];
        let list = attributes.as_mut_ptr().cast::<c_void>();
        if InitializeProcThreadAttributeList(list, 1, 0, &mut size) == 0 {
            let error = fail("attribute list");
            close_all(console);
            return Err(error);
        }
        if UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE as usize, console as *const c_void,
            std::mem::size_of::<HPCON>(), null_mut(), null()) == 0 {
            let error = fail("pseudoconsole attribute");
            DeleteProcThreadAttributeList(list);
            close_all(console);
            return Err(error);
        }
        let mut startup: STARTUPINFOEXW = std::mem::zeroed();
        startup.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        // No inherited standard handles: the Agent's console is the pseudoconsole, even when
        // the holder's own standard handles were redirected.
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = INVALID_HANDLE_VALUE;
        startup.StartupInfo.hStdOutput = INVALID_HANDLE_VALUE;
        startup.StartupInfo.hStdError = INVALID_HANDLE_VALUE;
        startup.lpAttributeList = list;
        let mut line: Vec<u16> = std::ffi::OsStr::new(&command_line(argv, verbatim)).encode_wide().chain(Some(0)).collect();
        let mut info: PROCESS_INFORMATION = std::mem::zeroed();
        let started = CreateProcessW(null(), line.as_mut_ptr(), null(), null(), 0,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, null(), null(), &startup.StartupInfo, &mut info);
        let error = (started == 0).then(|| std::io::Error::last_os_error());
        DeleteProcThreadAttributeList(list);
        if let Some(error) = error {
            close_all(console);
            return Err(match error.raw_os_error() {
                Some(2) | Some(3) => "ENOENT".to_string(),
                _ => format!("CreateProcessW: {error}"),
            });
        }
        CloseHandle(info.hThread);
        Ok(ConptyAgent {
            pid: info.dwProcessId,
            process: SendHandle(info.hProcess),
            console,
            input: File::from_raw_handle(input_write as _),
            output: File::from_raw_handle(output_read as _),
        })
    }
}

impl ConptyAgent {
    /// Waits for the Agent's exit; its status as the holder reports it.
    pub fn waiter(&self) -> Box<dyn FnOnce() -> Value + Send> {
        let process = SendHandle(self.process.0);
        Box::new(move || unsafe {
            let process = process;
            WaitForSingleObject(process.0, INFINITE);
            let mut code = 0u32;
            let status = if GetExitCodeProcess(process.0, &mut code) != 0 {
                json!({ "code": code as i32, "signal": null })
            } else {
                json!({ "code": null, "signal": null, "error": std::io::Error::last_os_error().to_string() })
            };
            CloseHandle(process.0);
            status
        })
    }
}

/// Flushes the remaining rendering and ends the output pipe (after the Agent exited).
pub fn close(console: HPCON) {
    unsafe { ClosePseudoConsole(console) }
}

pub fn resize(console: HPCON, cols: u16, rows: u16) -> Result<(), &'static str> {
    if unsafe { ResizePseudoConsole(console, coord(cols, rows)) } != 0 {
        return Err("resize_failed");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn command_line_quotes_like_the_msvc_runtime_or_appends_a_verbatim_tail() {
        let args = |items: &[&str]| items.iter().map(|item| item.to_string()).collect::<Vec<_>>();
        assert_eq!(command_line(&args(&["C:\\a b\\x.exe", "plain", "two words", "q\"uote", "tail\\"]), false),
            r#""C:\a b\x.exe" plain "two words" "q\"uote" tail\"#);
        assert_eq!(command_line(&args(&["x", "a\\ b\\"]), false), r#"x "a\ b\\""#);
        assert_eq!(command_line(&args(&["cmd.exe", "/d /s /c \"echo hi\""]), true), r#"cmd.exe /d /s /c "echo hi""#);
    }
}
