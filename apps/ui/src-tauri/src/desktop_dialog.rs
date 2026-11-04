//! Native chooser transport; selected media is validated/imported by CaptureFiles.
use std::path::PathBuf;
use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, FilePath};
use tokio::sync::oneshot;

#[tauri::command]
pub async fn desktop_pick_folder(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = oneshot::channel::<Option<String>>();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path.map(|p| p.to_string()));
    });
    rx.await.map_err(|_| "Failed to receive dialog selection".to_string())
}

async fn pick_file(app: AppHandle) -> Result<Option<FilePath>, String> {
    let (tx, rx) = oneshot::channel();
    app.dialog().file().pick_file(move |path| { let _ = tx.send(path); });
    rx.await.map_err(|_| "Failed to receive dialog selection".to_string())
}

#[tauri::command]
pub async fn desktop_pick_ssh_identity_file(app: AppHandle) -> Result<Option<String>, String> {
    pick_file(app).await.map(|path| path.map(|path| path.to_string()))
}

#[tauri::command]
pub async fn desktop_capture_recent_choose_file(app: AppHandle) -> Result<Option<RecentCaptureFileChoice>, happier_desktop_native::capture::CaptureError> {
    use happier_desktop_native::capture::CaptureError;
    pick_file(app).await.map_err(|_| CaptureError::FileIo)?
        .map(|path| {
            let path = path.into_path().map_err(|_| CaptureError::FileIo)?
                .canonicalize().map_err(|_| CaptureError::FileIo)?;
            let folder = path.parent().ok_or(CaptureError::InvalidMedia)?.to_path_buf();
            Ok(RecentCaptureFileChoice { path, folder })
        }).transpose()
}

#[derive(serde::Serialize)]
pub struct RecentCaptureFileChoice {
    path: PathBuf,
    folder: PathBuf,
}

#[tauri::command]
pub async fn desktop_pick_personal_home_backup_archive(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = oneshot::channel::<Option<String>>();
    app.dialog().file().set_title("Choose a Personal Home backup")
        .add_filter("Happier Personal Home backup", &["tar"])
        .pick_file(move |path| { let _ = tx.send(path.map(|p| p.to_string())); });
    rx.await.map_err(|_| "Failed to receive backup archive selection".to_string())
}

#[tauri::command]
pub async fn desktop_save_personal_home_backup_archive(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = oneshot::channel::<Option<String>>();
    app.dialog().file().set_title("Export Personal Home backup")
        .set_file_name("personal-home-backup.tar")
        .add_filter("Happier Personal Home backup", &["tar"])
        .save_file(move |path| { let _ = tx.send(path.map(|p| p.to_string())); });
    rx.await.map_err(|_| "Failed to receive backup destination selection".to_string())
}
