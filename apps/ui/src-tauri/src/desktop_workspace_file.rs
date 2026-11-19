use std::path::{Path, PathBuf};

fn resolve_workspace_file(workspace_root: &Path, file_path: &Path) -> std::io::Result<PathBuf> {
    use std::io::{Error, ErrorKind};

    if !workspace_root.is_absolute() || !file_path.is_absolute() {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "Expected absolute workspace and file paths",
        ));
    }

    let root = workspace_root.canonicalize()?;
    let file = file_path.canonicalize()?;
    if file == root || !file.starts_with(&root) {
        return Err(Error::new(
            ErrorKind::PermissionDenied,
            "This file is outside the session workspace",
        ));
    }
    if !file.metadata()?.is_file() {
        return Err(Error::new(
            ErrorKind::InvalidInput,
            "Expected a regular file",
        ));
    }
    Ok(file)
}

#[cfg(desktop)]
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum WorkspaceFileHandoff {
    Open,
    Reveal,
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_handoff_workspace_file(
    workspace_root: PathBuf,
    file_path: PathBuf,
    action: WorkspaceFileHandoff,
) -> Result<(), String> {
    let file =
        resolve_workspace_file(&workspace_root, &file_path).map_err(|error| error.to_string())?;
    match action {
        WorkspaceFileHandoff::Open => tauri_plugin_opener::open_path(&file, None::<&str>),
        WorkspaceFileHandoff::Reveal => tauri_plugin_opener::reveal_item_in_dir(&file),
    }
    .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn only_resolves_existing_regular_files_within_the_canonical_workspace() {
        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("workspace");
        let sibling = fixture.path().join("workspace-sibling");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&sibling).unwrap();
        let inside = root.join("inside.txt");
        let outside = sibling.join("outside.txt");
        fs::write(&inside, "inside").unwrap();
        fs::write(&outside, "outside").unwrap();

        assert_eq!(
            resolve_workspace_file(&root, &inside).unwrap(),
            inside.canonicalize().unwrap()
        );
        assert!(
            resolve_workspace_file(&root, &root.join("../workspace-sibling/outside.txt")).is_err()
        );
        let directory = root.join("folder");
        fs::create_dir(&directory).unwrap();
        assert!(resolve_workspace_file(&root, &directory).is_err());
        assert!(resolve_workspace_file(&root, &root.join("missing.txt")).is_err());
    }

    #[test]
    fn resolves_symlinks_before_checking_workspace_containment() {
        #[cfg(unix)]
        use std::os::unix::fs::symlink as symlink_file;
        #[cfg(windows)]
        use std::os::windows::fs::symlink_file;

        let fixture = tempfile::tempdir().unwrap();
        let root = fixture.path().join("workspace");
        fs::create_dir(&root).unwrap();
        let inside = root.join("inside.txt");
        let outside = fixture.path().join("outside.txt");
        fs::write(&inside, "inside").unwrap();
        fs::write(&outside, "outside").unwrap();
        let internal_link = root.join("internal-link.txt");
        symlink_file(&inside, &internal_link).unwrap();
        assert_eq!(
            resolve_workspace_file(&root, &internal_link).unwrap(),
            inside.canonicalize().unwrap()
        );
        let escaping_link = root.join("escaping-link.txt");
        symlink_file(&outside, &escaping_link).unwrap();
        assert!(resolve_workspace_file(&root, &escaping_link).is_err());
    }
}
