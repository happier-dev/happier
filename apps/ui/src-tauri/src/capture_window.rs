//! A retained, thin Capture webview. P1 owns the pending operation; this host owns no capture state.

use serde::{Deserialize, Serialize};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use crate::desktop_window::{is_capture_window, CAPTURE_WINDOW_LABEL, MAIN_WINDOW_LABEL};

const CAPTURE_WINDOW_ROUTE: &str = "/desktop/capture";
const CAPTURE_WINDOW_LIFECYCLE: &str = "desktopCapture://window";

pub(crate) fn start_presentation(app: &AppHandle, label: &str) -> Result<(), String> {
    ensure_capture_window_with_label(app, label)?;
    // AppKit's panel owner restores its level synchronously at presentation. A queued Tao
    // level setter here can race the retained permission/control transition.
    #[cfg(not(target_os = "macos"))]
    if let Some(window) = app.get_webview_window(label) {
        window.set_always_on_top(true).map_err(|error| error.to_string())?;
    }
    app.emit_to(label, CAPTURE_WINDOW_LIFECYCLE, "start").map_err(|error| error.to_string())
}

pub(crate) fn end_presentation(app: &AppHandle, label: &str) {
    let _ = app.emit_to(label, CAPTURE_WINDOW_LIFECYCLE, "hidden");
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureWindowReadyPhase { Wake, State, Paint }

pub use crate::window_sizing::WindowFrame as CaptureWindowFrame;

#[derive(Clone, Copy, Debug, Serialize)]
pub struct CaptureWindowPosition {
    x: f64,
    y: f64,
    scale: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureWindowPlacement {
    previous_frame: Option<CaptureWindowFrame>,
}

/// Read once before the renderer's existing placement owner resolves a new capture's frame.
#[tauri::command]
pub fn desktop_capture_window_placement(app: AppHandle, caller_window: WebviewWindow) -> Result<CaptureWindowPlacement, String> {
    ensure_caller(&caller_window, &[CAPTURE_WINDOW_LABEL])?;
    let visible_labels = app.webview_windows().into_iter().filter(|(_, window)| window.is_visible().unwrap_or(false))
        .map(|(label, _)| label).collect::<Vec<_>>();
    let previous_label = app.state::<crate::capture::CaptureState>().previous_window_label(caller_window.label(), &visible_labels);
    let previous_frame = crate::window_sizing::previous_visible_window_frame(&app, caller_window.label(), previous_label.as_deref());
    Ok(CaptureWindowPlacement { previous_frame })
}

fn window_position(window: &WebviewWindow) -> Result<CaptureWindowPosition, String> {
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let position = window.outer_position().map_err(|error| error.to_string())?.to_logical::<f64>(scale);
    Ok(CaptureWindowPosition { x: position.x, y: position.y, scale })
}

fn ensure_caller(window: &WebviewWindow, allowed_labels: &[&str]) -> Result<(), String> {
    if allowed_labels.contains(&window.label())
        || (allowed_labels.contains(&CAPTURE_WINDOW_LABEL) && is_capture_window(window.label())) {
        Ok(())
    } else {
        Err("desktop_capture_window_caller_refused".into())
    }
}

/// Called on the first trigger, alongside selection. Construction never presents an unpainted UI.
pub(crate) fn ensure_capture_window(app: &AppHandle) -> Result<WebviewWindow, String> {
    ensure_capture_window_with_label(app, CAPTURE_WINDOW_LABEL)
}

pub(crate) fn ensure_capture_window_with_label(app: &AppHandle, label: &str) -> Result<WebviewWindow, String> {
    if app.get_webview_window(MAIN_WINDOW_LABEL).is_none() {
        crate::window_chrome::create_main_window(
            app,
            crate::window_sizing::InitialWindowVisibility::Hidden,
        )
        .map_err(|error| error.to_string())?;
        crate::menu_bar::leave(app);
    }
    if let Some(window) = app.get_webview_window(label) {
        return Ok(window);
    }
    let window = WebviewWindowBuilder::new(
        app,
        label,
        WebviewUrl::App(CAPTURE_WINDOW_ROUTE.into()),
    )
    .title("Happier Capture")
    .decorations(false)
    .resizable(false)
    .always_on_top(true)
    .transparent(true)
    .visible(false)
    .focused(false)
    .accept_first_mouse(true)
    .skip_taskbar(true)
    .build()
    .map_err(|error| error.to_string())?;
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::*;
        let retained = window.clone();
        crate::desktop_panel::run_on_main_thread(app, move || {
            let native = retained.gtk_window().map_err(|error| error.to_string())?;
            let content = native.child().ok_or_else(|| "Capture window content is unavailable".to_string())?;
            // Non-resizable GTK windows use the child's natural size as their minimum.
            // Keep WebKit filling the host while the renderer owns its frame instead.
            let frame = gtk::Overlay::new();
            native.remove(&content);
            frame.add_overlay(&content);
            native.add(&frame);
            frame.show();
            Ok::<_, String>(())
        }, "Capture window layout did not return")??;
    }
    crate::desktop_panel::prepare_first_paint(&window)?;
    #[cfg(target_os = "windows")]
    crate::activity_overlay::watch_native_display_window(&window)?;
    #[cfg(target_os = "macos")]
    crate::desktop_panel::configure_capture_panel(&window)?;
    let retained_window = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Destroyed = event {
            let state = retained_window.state::<crate::capture::CaptureState>();
            state.cancel_window_text_for_window(retained_window.label());
            state.release_window(retained_window.label());
            let app = retained_window.app_handle().clone();
            let handle = app.clone();
            // Let the native registry withdraw the destroyed host before replenishing one standby.
            let _ = app.run_on_main_thread(move || {
                if !handle.webview_windows().keys().any(|label| is_capture_window(label)) {
                    if let Err(error) = ensure_capture_window(&handle) { log::warn!("failed to retain a Capture standby: {error}"); }
                }
            });
        }
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Err(error) = desktop_capture_window_hide(retained_window.app_handle().clone(), retained_window.clone(), None) {
                log::warn!("failed to hide the Capture window: {error}");
            }
        }
    });
    Ok(window)
}

/// The renderer attaches its listener before asking P1 to replay the retained operation snapshot.
#[tauri::command]
pub fn desktop_capture_window_ready(
    app: AppHandle,
    caller_window: WebviewWindow,
    phase: CaptureWindowReadyPhase,
) -> Result<bool, String> {
    if matches!(phase, CaptureWindowReadyPhase::Paint) {
        if !is_capture_window(caller_window.label()) && !caller_window.label().starts_with("capture_selection_") {
            return Err("desktop_capture_window_caller_refused".into());
        }
        crate::desktop_panel::reveal_after_paint(&caller_window)?;
        return Ok(true);
    }
    ensure_caller(&caller_window, &[CAPTURE_WINDOW_LABEL])?;
    let snapshot = app.state::<crate::capture::CaptureState>().snapshot_for_window(caller_window.label());
    if matches!(snapshot, crate::capture::CaptureSnapshot::Idle | crate::capture::CaptureSnapshot::Selecting { .. }
        | crate::capture::CaptureSnapshot::Acquiring { .. } | crate::capture::CaptureSnapshot::Selected { .. }
        | crate::capture::CaptureSnapshot::Cancelled) { return Ok(false); }
    match phase {
        CaptureWindowReadyPhase::Paint => unreachable!(),
        CaptureWindowReadyPhase::Wake => start_presentation(&app, caller_window.label())?,
        CaptureWindowReadyPhase::State => app.emit_to(
        caller_window.label(),
        crate::capture::CAPTURE_EVENT,
        snapshot,
    )
    .map_err(|error| error.to_string())?,
    }
    Ok(true)
}

/// The renderer calls this after paint with the union frame, then the final frame after its morph.
/// Frame geometry has one owner: resolveCaptureWindowFrame in the renderer. `glass_radius` is the
/// resting card's radius when the card fills this frame; the app's glass is clipped to it.
#[tauri::command]
pub fn desktop_capture_window_present(
    frame: CaptureWindowFrame,
    activate: Option<bool>,
    glass_radius: Option<f64>,
    caller_window: WebviewWindow,
) -> Result<Option<CaptureWindowPosition>, String> {
    ensure_caller(&caller_window, &[CAPTURE_WINDOW_LABEL])?;
    let previous = window_position(&caller_window).ok();
    #[cfg(target_os = "linux")]
    {
        use gtk::prelude::WidgetExt;
        let retained = caller_window.clone();
        let size = LogicalSize::new(frame.width, frame.height).cast::<i32>();
        crate::desktop_panel::run_on_main_thread(caller_window.app_handle(), move || {
            let native = retained.gtk_window().map_err(|error| error.to_string())?;
            native.set_size_request(size.width, size.height);
            Ok::<_, String>(())
        }, "Capture window size did not return")??;
    }
    #[cfg(not(target_os = "linux"))]
    caller_window
        .set_size(LogicalSize::new(frame.width, frame.height))
        .map_err(|error| error.to_string())?;
    caller_window
        .set_position(LogicalPosition::new(frame.x, frame.y))
        .map_err(|error| error.to_string())?;
    if let Err(error) = crate::window_chrome::set_desktop_glass_panel_shape(&caller_window, glass_radius) {
        log::warn!("failed to follow the app's glass in the Capture window: {error}");
    }
    // The recording control stands beside the work being recorded and never takes it from the person.
    #[cfg(target_os = "macos")]
    crate::desktop_panel::configure_capture_panel(&caller_window)?;
    if activate == Some(false) {
        crate::desktop_panel::show_without_activation(&caller_window)?;
        crate::window_sizing::note_presented_work_window(&caller_window);
        return Ok(previous);
    }
    caller_window.show().map_err(|error| error.to_string())?;
    caller_window.set_focus().map_err(|error| error.to_string())?;
    crate::window_sizing::note_presented_work_window(&caller_window);
    Ok(previous)
}

#[tauri::command]
pub fn desktop_capture_window_hide(
    app: AppHandle,
    caller_window: WebviewWindow,
    window_label: Option<String>,
) -> Result<Option<CaptureWindowPosition>, String> {
    ensure_caller(&caller_window, &[MAIN_WINDOW_LABEL, CAPTURE_WINDOW_LABEL])?;
    let label = if caller_window.label() == MAIN_WINDOW_LABEL {
        window_label.as_deref().unwrap_or(CAPTURE_WINDOW_LABEL)
    } else { caller_window.label() };
    if !is_capture_window(label) { return Err("desktop_capture_window_caller_refused".into()); }
    if let Some(window) = app.get_webview_window(label) {
        let position = window_position(&window).ok();
        let _ = crate::window_chrome::set_desktop_glass_panel_shape(&window, None);
        let state = app.state::<crate::capture::CaptureState>();
        state.cancel_window_text_for_window(label);
        crate::capture::close_recents_for_window(&state, label);
        crate::capture::remove_permission_window(&app, label);
        window.hide().map_err(|error| error.to_string())?;
        end_presentation(&app, label);
        if matches!(state.snapshot_for_window(label), crate::capture::CaptureSnapshot::Idle
            | crate::capture::CaptureSnapshot::Failed { .. } | crate::capture::CaptureSnapshot::Unavailable { .. }) {
            window.destroy().map_err(|error| error.to_string())?;
        }
        return Ok(position);
    }
    Ok(None)
}

/// A main-renderer discard has no receipt or Undo hold in the addressed renderer.
pub(crate) fn destroy_settled_window(app: &AppHandle, label: &str) -> Result<(), String> {
    let state = app.state::<crate::capture::CaptureState>();
    if !matches!(state.snapshot_for_window(label), crate::capture::CaptureSnapshot::Idle) { return Ok(()); }
    if let Some(window) = app.get_webview_window(label) {
        crate::capture::close_recents_for_window(&state, label);
        crate::capture::remove_permission_window(app, label);
        window.destroy().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Permission recovery may leave the still-open Capture window behind System Settings.
/// Only a fresh native presentation start restores its usual floating level.
#[tauri::command]
pub fn desktop_capture_window_set_floating(
    floating: bool,
    caller_window: WebviewWindow,
) -> Result<(), String> {
    ensure_caller(&caller_window, &[CAPTURE_WINDOW_LABEL])?;
    caller_window.set_always_on_top(floating).map_err(|error| error.to_string())
}
