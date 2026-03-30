use std::fs;
use std::io;
use std::path::Path;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SidecarSnapshot {
    pub bytes: Vec<u8>,
    pub unix_mode: Option<u32>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidecarUpdateAction {
    Noop,
    Copy,
    PermissionsOnly,
    CopyAndPermissions,
}

impl SidecarSnapshot {
    #[allow(dead_code)]
    pub fn from_path(path: &Path) -> io::Result<Self> {
        let bytes = fs::read(path)?;
        Ok(Self {
            unix_mode: read_unix_mode(&fs::metadata(path)?),
            bytes,
        })
    }
}

pub fn resolve_sidecar_update_action(
    source: &SidecarSnapshot,
    destination: Option<&SidecarSnapshot>,
) -> SidecarUpdateAction {
    let Some(destination) = destination else {
        return if source.unix_mode.is_some() {
            SidecarUpdateAction::CopyAndPermissions
        } else {
            SidecarUpdateAction::Copy
        };
    };

    let content_differs = source.bytes != destination.bytes;
    let permissions_differs = source.unix_mode != destination.unix_mode;

    match (content_differs, permissions_differs) {
        (false, false) => SidecarUpdateAction::Noop,
        (true, false) => SidecarUpdateAction::Copy,
        (false, true) => SidecarUpdateAction::PermissionsOnly,
        (true, true) => SidecarUpdateAction::CopyAndPermissions,
    }
}

#[cfg(unix)]
#[allow(dead_code)]
fn read_unix_mode(metadata: &fs::Metadata) -> Option<u32> {
    Some(metadata.permissions().mode())
}

#[cfg(not(unix))]
#[allow(dead_code)]
fn read_unix_mode(_metadata: &fs::Metadata) -> Option<u32> {
    None
}
