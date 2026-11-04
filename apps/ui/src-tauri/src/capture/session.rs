//! The loaded GDK backend is selected once for this desktop process.
use happier_desktop_native::capture::{
    linux::{session_from_gdk, DesktopSession},
    CaptureError,
};
use tauri::{AppHandle, Manager};

struct Session(Result<DesktopSession, CaptureError>);

/// Tauri setup calls this on the GTK main thread. XWayland's DISPLAY variable
/// does not change the backend selected by the actual GDK connection.
pub(super) fn install(app: &AppHandle) -> Result<DesktopSession, CaptureError> {
    use gtk::prelude::*;
    if let Some(session) = app.try_state::<Session>() {
        return session.0.clone();
    }
    let selected = gtk::gdk::Display::default()
        .ok_or(CaptureError::UnsupportedPlatform)
        .and_then(|display| session_from_gdk(display.type_().name()));
    app.manage(Session(selected.clone()));
    selected
}

pub(super) fn read(app: &AppHandle) -> Result<DesktopSession, CaptureError> {
    app.try_state::<Session>()
        .ok_or(CaptureError::UnsupportedPlatform)?
        .0
        .clone()
}
