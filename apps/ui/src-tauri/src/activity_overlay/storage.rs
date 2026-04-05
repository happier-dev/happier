use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{path::BaseDirectory, AppHandle, Manager, Runtime};

use super::placement::{clamp, sanitize_offset};

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersistedOverlayDragOffsets {
    pub(crate) offset_x: f64,
    pub(crate) offset_y: f64,
}

pub(crate) fn sanitize_drag_offsets(
    offsets: PersistedOverlayDragOffsets,
) -> PersistedOverlayDragOffsets {
    PersistedOverlayDragOffsets {
        offset_x: clamp(sanitize_offset(offsets.offset_x), -4096.0, 4096.0),
        offset_y: clamp(sanitize_offset(offsets.offset_y), -4096.0, 4096.0),
    }
}

pub(crate) fn resolve_drag_offsets_path<R: Runtime>(
    app: &impl Manager<R>,
) -> tauri::Result<PathBuf> {
    app.path().resolve(
        "window-state/activity-overlay-position.json",
        BaseDirectory::AppConfig,
    )
}

pub(crate) fn read_persisted_drag_offsets(
    path: Option<&Path>,
) -> Option<PersistedOverlayDragOffsets> {
    let path = path?;
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice::<PersistedOverlayDragOffsets>(&bytes).ok()
}

pub(crate) fn persist_drag_offsets<R: Runtime>(
    app: &AppHandle<R>,
    offsets: PersistedOverlayDragOffsets,
) {
    let Ok(path) = resolve_drag_offsets_path(app) else {
        return;
    };
    persist_drag_offsets_to_path(&path, offsets);
}

fn persist_drag_offsets_to_path(path: &Path, offsets: PersistedOverlayDragOffsets) {
    let Some(parent) = path.parent() else {
        return;
    };
    if fs::create_dir_all(parent).is_err() {
        return;
    }
    let Ok(payload) = serde_json::to_vec_pretty(&sanitize_drag_offsets(offsets)) else {
        return;
    };
    let _ = fs::write(path, payload);
}

pub(crate) fn clear_persisted_drag_offsets<R: Runtime>(app: &AppHandle<R>) {
    let Ok(path) = resolve_drag_offsets_path(app) else {
        return;
    };
    let _ = clear_persisted_drag_offsets_path(&path);
}

fn clear_persisted_drag_offsets_path(path: &Path) -> std::io::Result<()> {
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
    fn clears_persisted_drag_offsets_path_without_error_when_file_missing() {
        let unique = format!(
            "activity-overlay-position-{}-missing.json",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time should be after unix epoch")
                .as_nanos()
        );
        let path = std::env::temp_dir().join(unique);

        clear_persisted_drag_offsets_path(&path)
            .expect("clearing a missing drag-offset file should succeed");
    }

    #[test]
    fn clears_persisted_drag_offsets_path_when_file_exists() {
        let unique = format!(
            "activity-overlay-position-{}.json",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time should be after unix epoch")
                .as_nanos()
        );
        let path = std::env::temp_dir().join(unique);

        persist_drag_offsets_to_path(
            &path,
            PersistedOverlayDragOffsets {
                offset_x: 18.0,
                offset_y: -24.0,
            },
        );
        assert!(path.exists());

        clear_persisted_drag_offsets_path(&path)
            .expect("existing drag-offset file should be removed");

        assert!(!path.exists());
    }
}
