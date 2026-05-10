use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{path::BaseDirectory, Manager, Runtime};

use super::placement::{clamp, sanitize_offset, PET_OVERLAY_DRAG_OFFSET_LIMIT_PX};

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersistedPetOverlayDragOffset {
    pub x: f64,
    pub y: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub monitor_id: Option<String>,
}

pub(crate) fn sanitize_drag_offset(
    offset: PersistedPetOverlayDragOffset,
) -> PersistedPetOverlayDragOffset {
    PersistedPetOverlayDragOffset {
        x: clamp(
            sanitize_offset(offset.x),
            -PET_OVERLAY_DRAG_OFFSET_LIMIT_PX,
            PET_OVERLAY_DRAG_OFFSET_LIMIT_PX,
        ),
        y: clamp(
            sanitize_offset(offset.y),
            -PET_OVERLAY_DRAG_OFFSET_LIMIT_PX,
            PET_OVERLAY_DRAG_OFFSET_LIMIT_PX,
        ),
        monitor_id: sanitize_monitor_id(offset.monitor_id),
    }
}

fn sanitize_monitor_id(monitor_id: Option<String>) -> Option<String> {
    let monitor_id = monitor_id?.trim().to_string();
    if monitor_id.is_empty() {
        return None;
    }
    Some(monitor_id.chars().take(256).collect())
}

pub(crate) fn resolve_pet_overlay_drag_offset_path<R: Runtime>(
    app: &impl Manager<R>,
) -> tauri::Result<PathBuf> {
    app.path().resolve(
        "window-state/pet-overlay-position.json",
        BaseDirectory::AppConfig,
    )
}

pub(crate) fn read_persisted_drag_offset(path: Option<&Path>) -> PersistedPetOverlayDragOffset {
    let Some(path) = path else {
        return PersistedPetOverlayDragOffset::default();
    };
    let Ok(bytes) = fs::read(path) else {
        return PersistedPetOverlayDragOffset::default();
    };
    let Ok(offset) = serde_json::from_slice::<PersistedPetOverlayDragOffset>(&bytes) else {
        return PersistedPetOverlayDragOffset::default();
    };

    sanitize_drag_offset(offset)
}

pub(crate) fn persist_drag_offset_to_path(path: &Path, offset: PersistedPetOverlayDragOffset) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let Ok(payload) = serde_json::to_vec_pretty(&sanitize_drag_offset(offset)) else {
        return;
    };
    let _ = fs::write(path, payload);
}

pub(crate) fn clear_persisted_drag_offset_path(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn persists_and_reads_drag_offset_from_storage_path() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("desktop-pet-overlay-position.json");

        persist_drag_offset_to_path(
            &path,
            PersistedPetOverlayDragOffset {
                x: 24.0,
                y: -16.0,
                monitor_id: Some("display-1".to_string()),
            },
        );

        assert_eq!(
            read_persisted_drag_offset(Some(&path)),
            PersistedPetOverlayDragOffset {
                x: 24.0,
                y: -16.0,
                monitor_id: Some("display-1".to_string()),
            },
        );
    }

    #[test]
    fn reads_legacy_drag_offset_without_monitor_identity() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("desktop-pet-overlay-position.json");
        fs::write(&path, br#"{"x":24,"y":-16}"#).expect("write legacy payload");

        assert_eq!(
            read_persisted_drag_offset(Some(&path)),
            PersistedPetOverlayDragOffset {
                x: 24.0,
                y: -16.0,
                monitor_id: None,
            },
        );
    }

    #[test]
    fn reset_removes_persisted_drag_offset_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("desktop-pet-overlay-position.json");
        persist_drag_offset_to_path(
            &path,
            PersistedPetOverlayDragOffset {
                x: 24.0,
                y: -16.0,
                monitor_id: Some("display-1".to_string()),
            },
        );

        clear_persisted_drag_offset_path(&path).expect("clear should succeed");

        assert!(!path.exists());
        assert_eq!(
            read_persisted_drag_offset(Some(&path)),
            PersistedPetOverlayDragOffset::default(),
        );
    }
}
