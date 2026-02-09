#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let mut builder = tauri::Builder::default()
    .plugin(tauri_plugin_http::init());

  #[cfg(desktop)]
  {
    builder = builder
      .manage(app_updates::PendingUpdate::default())
      .invoke_handler(tauri::generate_handler![
        app_updates::desktop_fetch_update,
        app_updates::desktop_install_update
      ]);
  }

  builder
    .setup(|app| {
      #[cfg(desktop)]
      app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[cfg(desktop)]
mod app_updates {
  use serde::Serialize;
  use std::sync::Mutex;
  use tauri::{AppHandle, State};
  use tauri_plugin_updater::{Update, UpdaterExt};

  #[derive(Default)]
  pub struct PendingUpdate(pub Mutex<Option<Update>>);

  #[derive(Serialize)]
  #[serde(rename_all = "camelCase")]
  pub struct UpdateMetadata {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    pub pub_date: Option<String>,
  }

  #[tauri::command]
  pub async fn desktop_fetch_update(
    app: AppHandle,
    pending_update: State<'_, PendingUpdate>,
  ) -> Result<Option<UpdateMetadata>, String> {
    let update = app
      .updater()
      .map_err(|e| e.to_string())?
      .check()
      .await
      .map_err(|e| e.to_string())?;

    let metadata = update.as_ref().map(|u| UpdateMetadata {
      version: u.version.clone(),
      current_version: u.current_version.clone(),
      notes: u.body.clone(),
      pub_date: u.date.map(|d| d.to_string()),
    });

    *pending_update.0.lock().map_err(|_| "PendingUpdate poisoned".to_string())? = update;
    Ok(metadata)
  }

  #[tauri::command]
  pub async fn desktop_install_update(
    app: AppHandle,
    pending_update: State<'_, PendingUpdate>,
  ) -> Result<bool, String> {
    let update = match pending_update
      .0
      .lock()
      .map_err(|_| "PendingUpdate poisoned".to_string())?
      .take() {
      Some(update) => update,
      None => return Ok(false),
    };

    update
      .download_and_install(
        |_chunk_len, _content_len| {},
        || {},
      )
      .await
      .map_err(|e| e.to_string())?;

    app.restart()
  }
}
