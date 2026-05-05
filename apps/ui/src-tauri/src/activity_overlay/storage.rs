use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};
use tauri::{path::BaseDirectory, AppHandle, Manager, Runtime};

use super::display_identity::DesktopActivityOverlayDisplayIdentity;
use super::placement::{clamp, sanitize_offset};

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PersistedOverlayDragOffsets {
    pub(crate) offset_x: f64,
    pub(crate) offset_y: f64,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct PersistedOverlayDragOffsetsRead {
    pub(crate) offsets: Option<PersistedOverlayDragOffsets>,
    pub(crate) migrated_from: Option<PathBuf>,
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

pub(crate) fn resolve_drag_offsets_path_for_display<R: Runtime>(
    app: &impl Manager<R>,
    identity: Option<&DesktopActivityOverlayDisplayIdentity>,
) -> tauri::Result<PathBuf> {
    let Some(identity) = identity else {
        return resolve_drag_offsets_path(app);
    };

    resolve_drag_offsets_path_for_storage_key(app, &identity.storage_key)
}

pub(crate) fn resolve_drag_offsets_path_for_storage_key<R: Runtime>(
    app: &impl Manager<R>,
    storage_key: &str,
) -> tauri::Result<PathBuf> {
    app.path().resolve(
        format!(
            "window-state/activity-overlay-position/{}.json",
            sanitize_storage_key(storage_key)
        ),
        BaseDirectory::AppConfig,
    )
}

pub(crate) fn resolve_drag_offsets_legacy_storage_keys_for_display(
    identity: Option<&DesktopActivityOverlayDisplayIdentity>,
) -> Vec<String> {
    let Some(identity) = identity else {
        return Vec::new();
    };
    let Some(cg_display_id) = identity.cg_display_id.filter(|value| *value > 0) else {
        return Vec::new();
    };

    let display_id_storage_key = format!("display-{cg_display_id}");
    if display_id_storage_key == identity.storage_key {
        Vec::new()
    } else {
        vec![display_id_storage_key]
    }
}

pub(crate) fn read_persisted_drag_offsets(
    path: Option<&Path>,
) -> Option<PersistedOverlayDragOffsets> {
    let path = path?;
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice::<PersistedOverlayDragOffsets>(&bytes).ok()
}

pub(crate) fn read_persisted_drag_offsets_for_display_paths(
    display_path: Option<&Path>,
    legacy_paths: &[&Path],
) -> PersistedOverlayDragOffsetsRead {
    if let Some(display_path) = display_path {
        if let Some(offsets) = read_persisted_drag_offsets(Some(display_path)) {
            return PersistedOverlayDragOffsetsRead {
                offsets: Some(sanitize_drag_offsets(offsets)),
                migrated_from: None,
            };
        }
    }

    for legacy_path in legacy_paths {
        if let Some(offsets) = read_persisted_drag_offsets(Some(legacy_path)) {
            return PersistedOverlayDragOffsetsRead {
                offsets: Some(sanitize_drag_offsets(offsets)),
                migrated_from: Some((*legacy_path).to_path_buf()),
            };
        }
    }

    PersistedOverlayDragOffsetsRead {
        offsets: None,
        migrated_from: None,
    }
}

pub(crate) fn migrate_persisted_drag_offsets_for_display_paths(
    display_path: &Path,
    legacy_paths: &[&Path],
) -> PersistedOverlayDragOffsetsRead {
    let loaded = read_persisted_drag_offsets_for_display_paths(Some(display_path), legacy_paths);
    if loaded.migrated_from.is_some() {
        if let Some(offsets) = loaded.offsets {
            persist_drag_offsets_to_path(display_path, offsets);
        }
    }
    loaded
}

pub(crate) fn persist_drag_offsets_for_display<R: Runtime>(
    app: &AppHandle<R>,
    identity: Option<&DesktopActivityOverlayDisplayIdentity>,
    offsets: PersistedOverlayDragOffsets,
) {
    let Ok(path) = resolve_drag_offsets_path_for_display(app, identity) else {
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

pub(crate) fn clear_persisted_drag_offsets_for_display<R: Runtime>(
    app: &AppHandle<R>,
    identity: Option<&DesktopActivityOverlayDisplayIdentity>,
) {
    let Ok(path) = resolve_drag_offsets_path_for_display(app, identity) else {
        return;
    };
    let _ = clear_persisted_drag_offsets_path(&path);
    for legacy_storage_key in resolve_drag_offsets_legacy_storage_keys_for_display(identity) {
        let Ok(legacy_display_path) =
            resolve_drag_offsets_path_for_storage_key(app, &legacy_storage_key)
        else {
            continue;
        };
        let _ = clear_persisted_drag_offsets_path(&legacy_display_path);
    }
    let Ok(legacy_path) = resolve_drag_offsets_path(app) else {
        return;
    };
    let _ = clear_persisted_drag_offsets_path(&legacy_path);
}

fn clear_persisted_drag_offsets_path(path: &Path) -> std::io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

fn sanitize_storage_key(key: &str) -> String {
    let sanitized: String = key
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '-' || character == '_' {
                character
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = sanitized.trim_matches('-');
    if trimmed.is_empty() {
        "display-unknown".to_string()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity_overlay::display_identity::{
        DesktopActivityOverlayDisplayIdentity, DisplayIdentitySource,
    };

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

    #[test]
    fn reads_display_scoped_drag_offsets_before_legacy_offsets() {
        let unique = format!(
            "activity-overlay-position-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time should be after unix epoch")
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(unique);
        let display_path = directory.join("edid-610-41056-12345678.json");
        let legacy_path = directory.join("activity-overlay-position.json");
        persist_drag_offsets_to_path(
            &display_path,
            PersistedOverlayDragOffsets {
                offset_x: 12.0,
                offset_y: -16.0,
            },
        );
        persist_drag_offsets_to_path(
            &legacy_path,
            PersistedOverlayDragOffsets {
                offset_x: 999.0,
                offset_y: 999.0,
            },
        );

        let loaded = read_persisted_drag_offsets_for_display_paths(
            Some(&display_path),
            &[legacy_path.as_path()],
        );

        assert_eq!(
            loaded.offsets,
            Some(PersistedOverlayDragOffsets {
                offset_x: 12.0,
                offset_y: -16.0,
            }),
        );
        assert_eq!(loaded.migrated_from, None);
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn migrates_legacy_drag_offsets_to_the_display_scoped_path() {
        let unique = format!(
            "activity-overlay-position-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time should be after unix epoch")
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(unique);
        let display_path = directory.join("display-72110592.json");
        let legacy_path = directory.join("activity-overlay-position.json");
        persist_drag_offsets_to_path(
            &legacy_path,
            PersistedOverlayDragOffsets {
                offset_x: 18.0,
                offset_y: -24.0,
            },
        );

        let loaded = migrate_persisted_drag_offsets_for_display_paths(
            &display_path,
            &[legacy_path.as_path()],
        );

        assert_eq!(
            loaded.offsets,
            Some(PersistedOverlayDragOffsets {
                offset_x: 18.0,
                offset_y: -24.0,
            }),
        );
        assert_eq!(loaded.migrated_from, Some(legacy_path));
        assert_eq!(
            read_persisted_drag_offsets(Some(&display_path)),
            Some(PersistedOverlayDragOffsets {
                offset_x: 18.0,
                offset_y: -24.0,
            }),
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn edid_scoped_drag_offsets_consider_the_previous_display_id_storage_key() {
        let identity = DesktopActivityOverlayDisplayIdentity {
            storage_key: "edid-610-41056-12345678".to_string(),
            source: DisplayIdentitySource::EdidComposite,
            cg_display_id: Some(72_110_592),
            vendor_id: Some(610),
            model_id: Some(41_056),
            serial_number: Some(12_345_678),
        };

        assert_eq!(
            resolve_drag_offsets_legacy_storage_keys_for_display(Some(&identity)),
            vec!["display-72110592".to_string()],
        );
    }

    #[test]
    fn migrates_display_id_drag_offsets_to_the_edid_scoped_path() {
        let unique = format!(
            "activity-overlay-position-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .expect("system time should be after unix epoch")
                .as_nanos()
        );
        let directory = std::env::temp_dir().join(unique);
        let identity = DesktopActivityOverlayDisplayIdentity {
            storage_key: "edid-610-41056-12345678".to_string(),
            source: DisplayIdentitySource::EdidComposite,
            cg_display_id: Some(72_110_592),
            vendor_id: Some(610),
            model_id: Some(41_056),
            serial_number: Some(12_345_678),
        };
        let display_path = directory.join(format!("{}.json", identity.storage_key));
        let legacy_display_id_path = directory.join(format!(
            "{}.json",
            resolve_drag_offsets_legacy_storage_keys_for_display(Some(&identity))
                .first()
                .expect("expected display-id fallback storage key")
        ));
        let legacy_global_path = directory.join("activity-overlay-position.json");
        persist_drag_offsets_to_path(
            &legacy_display_id_path,
            PersistedOverlayDragOffsets {
                offset_x: 32.0,
                offset_y: -28.0,
            },
        );
        persist_drag_offsets_to_path(
            &legacy_global_path,
            PersistedOverlayDragOffsets {
                offset_x: 999.0,
                offset_y: 999.0,
            },
        );

        let loaded = migrate_persisted_drag_offsets_for_display_paths(
            &display_path,
            &[
                legacy_display_id_path.as_path(),
                legacy_global_path.as_path(),
            ],
        );

        assert_eq!(
            loaded.offsets,
            Some(PersistedOverlayDragOffsets {
                offset_x: 32.0,
                offset_y: -28.0,
            }),
        );
        assert_eq!(loaded.migrated_from, Some(legacy_display_id_path));
        assert_eq!(
            read_persisted_drag_offsets(Some(&display_path)),
            Some(PersistedOverlayDragOffsets {
                offset_x: 32.0,
                offset_y: -28.0,
            }),
        );
        let _ = fs::remove_dir_all(directory);
    }
}
