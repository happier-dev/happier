use std::path::PathBuf;
use tauri::{AppHandle, Manager};

const HSETUP_FILENAME: &str = env!("HAPPIER_HSETUP_SIDECAR_FILENAME");

fn has_gzip_header(bytes: &[u8]) -> bool {
    bytes.len() >= 2 && bytes[0] == 0x1f && bytes[1] == 0x8b
}

fn is_gzip_file(path: &std::path::Path) -> Result<bool, String> {
    let bytes = std::fs::read(path).map_err(|error| error.to_string())?;
    Ok(has_gzip_header(&bytes))
}

fn extend_candidates_with_resource_dir(
    candidates: &mut Vec<PathBuf>,
    resource_dir: &std::path::Path,
    hsetup_filename: &str,
    base_filename: &str,
) {
    candidates.push(resource_dir.join(hsetup_filename));
    candidates.push(resource_dir.join(base_filename));

    // When bundled as a "resource" (not as an externalBin in usr/bin), Tauri preserves the
    // relative resource path, so binaries land under `<resource_dir>/binaries/`.
    candidates.push(resource_dir.join("binaries").join(hsetup_filename));
    candidates.push(resource_dir.join("binaries").join(base_filename));
}

fn materialize_hsetup_candidate(
    source_path: &std::path::Path,
    cache_dir: &std::path::Path,
) -> Result<PathBuf, String> {
    if !is_gzip_file(source_path)? {
        return std::fs::canonicalize(source_path).map_err(|error| error.to_string());
    }

    let base_filename = if HSETUP_FILENAME.ends_with(".exe") {
        "hsetup.exe"
    } else {
        "hsetup"
    };

    let metadata = std::fs::metadata(source_path).map_err(|error| error.to_string())?;
    let len = metadata.len();
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);

    let out_path = cache_dir.join(format!("{base_filename}-materialized-{len}-{modified}"));
    if out_path.is_file() {
        return std::fs::canonicalize(out_path).map_err(|error| error.to_string());
    }

    let gz_bytes = std::fs::read(source_path).map_err(|error| error.to_string())?;
    let mut decoder = flate2::read::GzDecoder::new(&gz_bytes[..]);
    let mut decoded = Vec::new();
    use std::io::Read;
    decoder
        .read_to_end(&mut decoded)
        .map_err(|error| error.to_string())?;

    let tmp_path = cache_dir.join(format!(
        ".{base_filename}-materialized-{len}-{modified}.tmp"
    ));
    std::fs::write(&tmp_path, decoded).map_err(|error| error.to_string())?;

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| error.to_string())?;
    }

    std::fs::rename(&tmp_path, &out_path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&out_path, std::fs::Permissions::from_mode(0o755))
            .map_err(|error| error.to_string())?;
    }

    std::fs::canonicalize(out_path).map_err(|error| error.to_string())
}

fn resolve_candidate_variants(path: &std::path::Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    out.push(path.to_path_buf());
    if let Some(path_str) = path.to_str() {
        out.push(PathBuf::from(format!("{path_str}.gz")));
    }
    out
}

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
        extend_candidates_with_resource_dir(
            &mut candidates,
            &resource_dir,
            HSETUP_FILENAME,
            base_filename,
        );
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
        for candidate in resolve_candidate_variants(&candidate) {
            if !candidate.is_file() {
                continue;
            }
            let cache_dir = app
                .path()
                .app_cache_dir()
                .map_err(|error| error.to_string())?;
            let cache_dir = cache_dir.join("systemTasks");
            std::fs::create_dir_all(&cache_dir).map_err(|error| error.to_string())?;
            return materialize_hsetup_candidate(&candidate, &cache_dir);
        }
    }

    Err(format!(
        "Unable to resolve bundled hsetup executor. Checked: {checked_paths}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::{write::GzEncoder, Compression};
    use std::io::Write;
    use tempfile::TempDir;

    #[test]
    fn extend_candidates_with_resource_dir_includes_binaries_subdir() {
        let resource_dir = std::path::PathBuf::from("/tmp/resources");
        let mut candidates = Vec::new();
        extend_candidates_with_resource_dir(
            &mut candidates,
            &resource_dir,
            "hsetup-x86_64-unknown-linux-gnu",
            "hsetup",
        );
        assert!(candidates.iter().any(|path| path
            == &resource_dir
                .join("binaries")
                .join("hsetup-x86_64-unknown-linux-gnu")));
        assert!(candidates
            .iter()
            .any(|path| path == &resource_dir.join("binaries").join("hsetup")));
    }

    #[test]
    fn materialize_hsetup_candidate_extracts_gzip_to_cache_dir() {
        let tmp = TempDir::new().unwrap();
        let cache_dir = tmp.path().join("cache");
        std::fs::create_dir_all(&cache_dir).unwrap();

        let archive_path = tmp.path().join("hsetup.gz");
        let expected = b"#!/bin/sh\necho hi\n";
        let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(expected).unwrap();
        let gz = encoder.finish().unwrap();
        std::fs::write(&archive_path, &gz).unwrap();

        assert!(is_gzip_file(&archive_path).unwrap());

        let extracted = materialize_hsetup_candidate(&archive_path, &cache_dir).unwrap();

        // We expect archive extraction to materialize a runnable file outside of the archive path.
        assert_ne!(extracted, std::fs::canonicalize(&archive_path).unwrap());
        assert_eq!(std::fs::read(&extracted).unwrap(), expected);
    }
}
