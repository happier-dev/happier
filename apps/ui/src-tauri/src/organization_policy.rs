use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub(super) struct OrganizationPolicyReadError {
    pub path: String,
    pub code: &'static str,
}

fn read_policy_file(path: &Path) -> Result<Option<String>, OrganizationPolicyReadError> {
    let error = |code| OrganizationPolicyReadError {
        path: path.to_string_lossy().into_owned(),
        code,
    };
    match std::fs::read(path) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| error("organization_policy_invalid_utf8")),
        Err(cause) if cause.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(error("organization_policy_unreadable")),
    }
}

pub(super) fn read_machine_policy() -> Result<Option<String>, OrganizationPolicyReadError> {
    read_policy_file(&machine_policy_path()?)
}

#[cfg(target_os = "macos")]
fn machine_policy_path() -> Result<PathBuf, OrganizationPolicyReadError> {
    Ok(PathBuf::from(
        "/Library/Application Support/Happier/policy.json",
    ))
}

#[cfg(target_os = "linux")]
fn machine_policy_path() -> Result<PathBuf, OrganizationPolicyReadError> {
    Ok(PathBuf::from("/etc/happier/policy.json"))
}

#[cfg(target_os = "windows")]
fn machine_policy_path() -> Result<PathBuf, OrganizationPolicyReadError> {
    use std::os::windows::ffi::OsStringExt;

    // Shell KnownFolder lookup, without verifying directory existence. These Win32
    // ABI declarations also keep the source-only native tests independent of Tauri.
    #[repr(C)]
    struct Guid {
        data1: u32,
        data2: u16,
        data3: u16,
        data4: [u8; 8],
    }
    #[link(name = "shell32")]
    unsafe extern "system" {
        fn SHGetKnownFolderPath(
            folder: *const Guid,
            flags: u32,
            token: *mut std::ffi::c_void,
            path: *mut *mut u16,
        ) -> i32;
    }
    #[link(name = "ole32")]
    unsafe extern "system" {
        fn CoTaskMemFree(pointer: *const std::ffi::c_void);
    }
    const PROGRAM_FILES: Guid = Guid {
        data1: 0x905e63b6,
        data2: 0xc1bf,
        data3: 0x494e,
        data4: [0xb2, 0x9c, 0x65, 0xb7, 0x32, 0xd3, 0xd2, 0x1a],
    };
    const DONT_VERIFY: u32 = 0x4000;
    let mut pointer = std::ptr::null_mut();
    // The Shell allocates a nul-terminated UTF-16 string; its allocation is released
    // with CoTaskMemFree on both success and failure, as required by the native API.
    let result = unsafe {
        SHGetKnownFolderPath(
            &PROGRAM_FILES,
            DONT_VERIFY,
            std::ptr::null_mut(),
            &mut pointer,
        )
    };
    if result < 0 || pointer.is_null() {
        unsafe { CoTaskMemFree(pointer.cast()) };
        return Err(OrganizationPolicyReadError {
            path: "<KnownFolder ProgramFiles>/Happier/policy.json".to_string(),
            code: "organization_policy_path_unavailable",
        });
    }
    let path = unsafe {
        let mut length = 0;
        while *pointer.add(length) != 0 {
            length += 1;
        }
        let path = std::ffi::OsString::from_wide(std::slice::from_raw_parts(pointer, length));
        CoTaskMemFree(pointer.cast());
        path
    };
    Ok(PathBuf::from(path).join("Happier").join("policy.json"))
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
fn machine_policy_path() -> Result<PathBuf, OrganizationPolicyReadError> {
    Err(OrganizationPolicyReadError {
        path: "policy.json".to_string(),
        code: "organization_policy_path_unavailable",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_file_is_unmanaged() {
        let directory = tempfile::tempdir().unwrap();
        assert_eq!(
            read_policy_file(&directory.path().join("policy.json")),
            Ok(None)
        );
    }

    #[test]
    fn returns_raw_text_without_parsing_or_normalizing_it() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("policy.json");
        let raw = "  {\"futureOrInvalidSchema\":true}\n";
        std::fs::write(&path, raw).unwrap();
        assert_eq!(read_policy_file(&path), Ok(Some(raw.to_string())));
    }

    #[test]
    fn invalid_utf8_is_a_typed_error_without_content() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("policy.json");
        std::fs::write(&path, [b's', b'e', b'c', b'r', b'e', b't', 0xff]).unwrap();
        assert_eq!(
            read_policy_file(&path),
            Err(OrganizationPolicyReadError {
                path: path.to_string_lossy().into_owned(),
                code: "organization_policy_invalid_utf8",
            })
        );
    }

    #[test]
    fn unreadable_file_is_an_error_instead_of_unmanaged() {
        let directory = tempfile::tempdir().unwrap();
        // Opening a directory as policy content fails on all supported desktop OSs.
        let path = directory.path();
        assert_eq!(
            read_policy_file(path),
            Err(OrganizationPolicyReadError {
                path: path.to_string_lossy().into_owned(),
                code: "organization_policy_unreadable",
            })
        );
    }
}
