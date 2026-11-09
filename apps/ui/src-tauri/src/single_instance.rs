//! Cleanup reads the existing single-instance owner's Windows mutex without forwarding argv.

use std::io;

fn ensure_no_running_desktop_with_probe(
    identifier: &str,
    probe: impl FnOnce(&str) -> io::Result<bool>,
) -> Result<(), String> {
    // tauri-plugin-single-instance 2.3.6, windows.rs: identifier + "-sim".
    // Its optional semver feature is disabled in this app. Read its existing
    // mutex directly: initializing the plugin would forward argv and exit 0.
    match probe(&format!("{identifier}-sim")) {
        Ok(false) => Ok(()),
        Ok(true) => Err("Quit Happier Desktop before removing its components, then retry uninstall.".into()),
        Err(error) => Err(format!("Unable to check whether Happier Desktop is running: {error}. Quit the app and retry uninstall.")),
    }
}

#[cfg(target_os = "windows")]
pub(crate) fn ensure_no_running_desktop(identifier: &str) -> Result<(), String> {
    use windows_sys::Win32::{
        Foundation::{CloseHandle, ERROR_FILE_NOT_FOUND},
        System::Threading::{OpenMutexW, SYNCHRONIZATION_SYNCHRONIZE},
    };
    ensure_no_running_desktop_with_probe(identifier, |name| {
        let name: Vec<u16> = name.encode_utf16().chain(Some(0)).collect();
        // OpenMutexW does not create or acquire the plugin's mutex.
        let handle = unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, 0, name.as_ptr()) };
        if !handle.is_null() {
            unsafe { CloseHandle(handle) };
            return Ok(true);
        }
        let error = io::Error::last_os_error();
        if error.raw_os_error() == Some(ERROR_FILE_NOT_FOUND as i32) {
            Ok(false)
        } else {
            Err(error)
        }
    })
}

#[cfg(test)]
mod tests {
    use super::ensure_no_running_desktop_with_probe;
    use std::io;

    #[test]
    fn running_desktop_blocks_external_cleanup() {
        let result = ensure_no_running_desktop_with_probe("dev.happier.app", |name| {
            // The named-mutex adapter is the OS boundary, using the pinned plugin protocol.
            assert_eq!(name, "dev.happier.app-sim");
            Ok(true)
        });
        assert!(result.is_err());
    }

    #[test]
    fn absent_desktop_allows_cleanup_but_probe_failure_blocks_it() {
        assert!(ensure_no_running_desktop_with_probe("dev.happier.preview", |_| Ok(false)).is_ok());
        let result = ensure_no_running_desktop_with_probe("dev.happier.preview", |_| {
            Err(io::Error::from(io::ErrorKind::PermissionDenied))
        });
        assert!(result.is_err());
    }
}
