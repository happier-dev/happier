use serde::Serialize;
use std::fs;
use tauri::{AppHandle, Emitter, Runtime};

pub const DESKTOP_STARTUP_READY_EVENT: &str = "desktop-startup-ready";

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopStartupReadyPayload {
    pub phase: &'static str,
}

pub fn emit_ready<R: Runtime>(app: &AppHandle<R>) {
    let payload = DesktopStartupReadyPayload { phase: "ready" };
    if let Err(error) = app.emit(DESKTOP_STARTUP_READY_EVENT, &payload) {
        log::error!("failed to emit {DESKTOP_STARTUP_READY_EVENT}: {error}");
    }
    if let Some(marker_path) = std::env::var_os("HAPPIER_TAURI_STARTUP_MARKER") {
        if let Err(error) = fs::write(
            marker_path,
            serde_json::to_vec(&payload).unwrap_or_default(),
        ) {
            log::error!("failed to write Tauri startup marker: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{DesktopStartupReadyPayload, DESKTOP_STARTUP_READY_EVENT};

    #[test]
    fn startup_ready_contract_is_stable() {
        assert_eq!(DESKTOP_STARTUP_READY_EVENT, "desktop-startup-ready");
        assert_eq!(
            serde_json::to_value(DesktopStartupReadyPayload { phase: "ready" }).unwrap()["phase"],
            "ready"
        );
    }
}
