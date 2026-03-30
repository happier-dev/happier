use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const HSETUP_FILENAME: &str = env!("HAPPIER_HSETUP_SIDECAR_FILENAME");

pub fn resolve_hsetup_path(app: &AppHandle) -> Result<PathBuf, String> {
    let base_filename = if HSETUP_FILENAME.ends_with(".exe") {
        "hsetup.exe"
    } else {
        "hsetup"
    };

    let mut candidates = vec![PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("binaries")
        .join(HSETUP_FILENAME)];
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("binaries")
            .join(base_filename),
    );

    if let Ok(resource_dir) = app.path().resource_dir() {
        candidates.push(resource_dir.join(HSETUP_FILENAME));
        candidates.push(resource_dir.join(base_filename));
    }

    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            candidates.push(parent.join(HSETUP_FILENAME));
            candidates.push(parent.join(base_filename));
            candidates.push(parent.join("../Resources").join(HSETUP_FILENAME));
            candidates.push(parent.join("../Resources").join(base_filename));
        }
    }

    let checked_paths = candidates
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");

    for candidate in candidates {
        if candidate.is_file() {
            return std::fs::canonicalize(candidate).map_err(|error| error.to_string());
        }
    }

    Err(format!(
        "Unable to resolve bundled hsetup executor. Checked: {checked_paths}"
    ))
}
