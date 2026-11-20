use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

use super::{FirstContent, Handoff, Settlement};
use crate::{
    desktop_panel,
    desktop_window::MAIN_WINDOW_LABEL,
    window_chrome::{self, MainWindowRevealRequest},
    window_sizing::{self, WindowFrame},
};

const OVERLAY: &str = "first_open_overlay";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Candidate { Overlay, InApp }

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Decision { OverlayEligible, InApp, Reduced, None }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Placement {
    overlay_frame: WindowFrame,
    window_rect: WindowFrame,
    cursor: Option<[f64; 2]>,
}

#[derive(Clone, Serialize)]
struct Start {
    #[serde(flatten)]
    placement: Placement,
    epoch: f64,
    welcome: Value,
}

#[derive(Clone, Copy, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum Host {
    Overlay { epoch: f64 },
    Settled { outcome: Settlement },
}

fn notify_main(app: &AppHandle, host: Host) {
    let _ = app.emit_to(tauri::EventTarget::webview_window(MAIN_WINDOW_LABEL), "first_open:host", host);
}

#[derive(Default)]
struct Opening {
    handoff: Handoff,
    placement: Option<Placement>,
}

#[derive(Default)]
pub(crate) struct FirstOpenState(Mutex<Opening>);

fn placement(main: &WebviewWindow) -> Result<(Placement, f64), String> {
    let monitor = main.current_monitor().map_err(|error| error.to_string())?
        .or(main.primary_monitor().map_err(|error| error.to_string())?)
        .ok_or("the main window has no monitor")?;
    let overlay_frame = window_sizing::monitor_work_area(&monitor);
    let scale = monitor.scale_factor();
    let mut window_rect = window_sizing::window_frame(main)?;
    window_rect.x -= overlay_frame.x;
    window_rect.y -= overlay_frame.y;
    let cursor = main.app_handle().cursor_position().ok().and_then(|position| {
        let x = position.x / scale - overlay_frame.x;
        let y = position.y / scale - overlay_frame.y;
        (x >= 0. && x < overlay_frame.width && y >= 0. && y < overlay_frame.height).then_some([x, y])
    });
    Ok((Placement { overlay_frame, window_rect, cursor }, scale))
}

fn create_overlay(app: &AppHandle, placement: &Placement, scale: f64) -> Result<(), String> {
    let frame = placement.overlay_frame;
    let overlay = WebviewWindowBuilder::new(app, OVERLAY, WebviewUrl::App("/desktop/opening".into()))
        .visible(false).focused(false).transparent(true).decorations(false)
        .resizable(false).shadow(false).skip_taskbar(true).always_on_top(true)
        .build().map_err(|error| error.to_string())?;
    let result = (|| {
        let position = tauri::LogicalPosition::new(frame.x, frame.y).to_physical::<i32>(scale);
        let size = tauri::LogicalSize::new(frame.width, frame.height).to_physical::<u32>(scale);
        overlay.set_position(position).map_err(|error| error.to_string())?;
        overlay.set_size(size).map_err(|error| error.to_string())?;
        desktop_panel::prepare_first_paint(&overlay)?;
        #[cfg(target_os = "macos")]
        {
            desktop_panel::apply(&overlay, desktop_panel::PanelOptions {
                shadow: false, opaque: false, movable: false, movable_by_window_background: false,
                accepts_mouse_moved_events: false, ignores_mouse_events: false, nonactivating: false,
                keyboard_on_request: true, level: Some(objc2_app_kit::NSFloatingWindowLevel as i64),
                collection_behavior: tauri_nspanel::CollectionBehavior::new(),
            })?;
        }
        #[cfg(target_os = "linux")]
        {
            use webkit2gtk::WebViewExt;
            let app = app.clone();
            overlay.with_webview(move |webview| {
                webview.inner().connect_web_process_terminated(move |_, _| {
                    overlay_process_failed(&app);
                });
            }).map_err(|error| error.to_string())?;
        }
        #[cfg(target_os = "windows")]
        {
            let app = app.clone();
            overlay.with_webview(move |webview| {
                if let Err(error) = observe_overlay_process(&app, webview) {
                    log::warn!("Could not observe opening renderer: {error}");
                    overlay_process_failed(&app);
                }
            }).map_err(|error| error.to_string())?;
        }
        Ok(())
    })();
    if result.is_err() { let _ = overlay.destroy(); }
    result
}

fn overlay_process_failed(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        close_with(&app, MainWindowRevealRequest::App, Settlement::Fallback);
    });
}

#[cfg(target_os = "macos")]
pub(crate) fn on_web_content_process_terminate(webview: &tauri::Webview) {
    if webview.label() == OVERLAY {
        overlay_process_failed(webview.app_handle());
    }
}

#[cfg(target_os = "windows")]
fn observe_overlay_process(app: &AppHandle, webview: tauri::webview::PlatformWebview) -> Result<(), String> {
    use webview2_com::{
        Microsoft::Web::WebView2::Win32::{
            COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED,
            COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED,
        },
        ProcessFailedEventHandler,
    };

    let native_webview = unsafe { webview.controller().CoreWebView2() }.map_err(|error| error.to_string())?;
    let app = app.clone();
    let handler = ProcessFailedEventHandler::create(Box::new(move |_, args| {
        if let Some(args) = args {
            let mut kind = Default::default();
            unsafe { args.ProcessFailedKind(&mut kind)? };
            if kind == COREWEBVIEW2_PROCESS_FAILED_KIND_BROWSER_PROCESS_EXITED
                || kind == COREWEBVIEW2_PROCESS_FAILED_KIND_RENDER_PROCESS_EXITED
            {
                overlay_process_failed(&app);
            }
        }
        Ok(())
    }));
    let mut token = 0;
    unsafe { native_webview.add_ProcessFailed(&handler, &mut token) }.map_err(|error| error.to_string())
}

/// Called once on cold startup, after sizing has restored or computed the main frame.
pub(crate) fn prepare(main: &WebviewWindow, supports_overlay: bool) -> Candidate {
    if !supports_overlay { return Candidate::InApp; }
    let app = main.app_handle();
    #[cfg(target_os = "linux")]
    if !desktop_panel::allows_positioned_transparency(main) { return Candidate::InApp; }
    match placement(main).and_then(|(placement, scale)| {
        create_overlay(app, &placement, scale)?;
        let state = app.state::<FirstOpenState>();
        *state.0.lock().unwrap() = Opening { handoff: Handoff::prepare(), placement: Some(placement) };
        log::info!("first_open: presenter created");
        Ok(())
    }) {
        Ok(()) => Candidate::Overlay,
        Err(error) => {
            log::info!("Opening overlay unavailable: {error}");
            Candidate::InApp
        }
    }
}

fn ensure_caller(caller: &WebviewWindow, label: &str) -> Result<(), String> {
    if caller.label() == label { return Ok(()); }
    Err("opening caller window refused".into())
}

#[tauri::command]
pub async fn desktop_first_open_decide(window: WebviewWindow, play: Decision) -> Result<(), String> {
    ensure_caller(&window, MAIN_WINDOW_LABEL)?;
    let app = window.app_handle();
    let play_overlay = matches!(play, Decision::OverlayEligible);
    let placement = {
        let state = app.state::<FirstOpenState>();
        let mut opening = state.0.lock().unwrap();
        opening.handoff.decide(play_overlay).then(|| opening.placement.clone()).flatten()
    };
    if let Some(placement) = placement {
        if let Some(overlay) = app.get_webview_window(OVERLAY) {
            overlay.emit_to(tauri::EventTarget::webview_window(OVERLAY), "first_open:prepare", placement)
                .map_err(|error| error.to_string())?;
            log::info!("first_open: prepare sent");
        }
    } else if !play_overlay {
        close(app, MainWindowRevealRequest::App);
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_first_open_overlay_ready(window: WebviewWindow) -> Result<(), String> {
    ensure_caller(&window, OVERLAY)?;
    window.state::<FirstOpenState>().0.lock().unwrap().handoff.overlay_ready();
    log::info!("first_open: presenter ready");
    Ok(())
}

#[tauri::command]
pub async fn desktop_first_open_overlay_unavailable(window: WebviewWindow) -> Result<(), String> {
    ensure_caller(&window, OVERLAY)?;
    close_with(window.app_handle(), MainWindowRevealRequest::App, Settlement::Fallback);
    Ok(())
}

/// Returns true when the opening has taken ownership of main's reveal.
pub(crate) fn on_main_content(main: &WebviewWindow, request: MainWindowRevealRequest, welcome: Option<Value>) -> bool {
    let app = main.app_handle();
    let placement = {
        let state = app.state::<FirstOpenState>();
        let mut opening = state.0.lock().unwrap();
        if opening.placement.is_none() {
            if welcome.is_some() { notify_main(app, Host::Settled { outcome: Settlement::Fallback }); }
            return false;
        }
        // Only the startup owner can prepare a normal-launch overlay. macOS also supplies
        // activation before any window has focus. Preserve the original request for fallback.
        let overlay_request = if cfg!(target_os = "macos") { request } else { MainWindowRevealRequest::User };
        let decision = opening.handoff.first_content(welcome.is_some(), || window_chrome::reveal_request_takes_focus(app, overlay_request));
        log::info!("first_open: main content, {decision:?}");
        opening.placement.take().filter(|_| decision == FirstContent::PlayOverlay)
    };
    let attempting_overlay = placement.is_some();
    let start = (|| {
        let placement = placement?;
        let welcome = welcome?;
        let overlay = app.get_webview_window(OVERLAY)?;
        #[cfg(target_os = "macos")]
        {
            desktop_panel::set_window_alpha(main, 0.).ok()?;
            main.show().ok()?;
        }
        desktop_panel::reveal_after_paint(&overlay).ok()?;
        // The webviews each convert this stamp to their own monotonic performance clock.
        let epoch = SystemTime::now().duration_since(UNIX_EPOCH).ok()?.as_secs_f64() * 1000.0 + 1000.0 / 60.0;
        overlay.emit_to(tauri::EventTarget::webview_window(OVERLAY), "first_open:start", Start {
            placement, epoch, welcome,
        }).ok()?;
        overlay.show().ok()?;
        #[cfg(target_os = "macos")]
        desktop_panel::request_window_keyboard(&overlay, true).ok()?;
        #[cfg(not(target_os = "macos"))]
        overlay.set_focus().ok()?;
        notify_main(app, Host::Overlay { epoch });
        log::info!("first_open: start {epoch}");
        Some(())
    })();
    if start.is_some() { return true; }
    let revealed = close_with(app, request, Settlement::Fallback);
    if !attempting_overlay {
        notify_main(app, Host::Settled { outcome: Settlement::Fallback });
    }
    revealed
}

#[tauri::command]
pub async fn desktop_first_open_welcome(window: WebviewWindow, welcome: Value) -> Result<(), String> {
    ensure_caller(&window, MAIN_WINDOW_LABEL)?;
    let app = window.app_handle();
    if app.state::<FirstOpenState>().0.lock().unwrap().handoff == Handoff::Playing {
        app.emit_to(tauri::EventTarget::webview_window(OVERLAY), "first_open:welcome", welcome)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn reveal_main(app: &AppHandle, request: MainWindowRevealRequest) -> Result<(), String> {
    let Some(main) = app.get_webview_window(MAIN_WINDOW_LABEL) else { return Ok(()); };
    #[cfg(target_os = "macos")]
    {
        if let Some(overlay) = app.get_webview_window(OVERLAY) {
            if let Err(error) = desktop_panel::request_window_keyboard(&overlay, false) {
                log::warn!("Could not release opening keyboard request: {error}");
            }
        }
        desktop_panel::set_window_alpha(&main, 1.)?;
    }
    window_chrome::reveal_main_window(app, &main, request).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn desktop_first_open_swap(window: WebviewWindow) -> Result<(), String> {
    ensure_caller(&window, OVERLAY)?;
    let app = window.app_handle();
    if app.state::<FirstOpenState>().0.lock().unwrap().handoff.swap() {
        let result = reveal_main(app, MainWindowRevealRequest::App);
        notify_main(app, Host::Settled { outcome: Settlement::after_swap(result.is_ok()) });
        log::info!("first_open: swap");
        result?;
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_first_open_close(window: WebviewWindow) -> Result<(), String> {
    ensure_caller(&window, OVERLAY)?;
    close(window.app_handle(), MainWindowRevealRequest::App);
    Ok(())
}

pub(crate) fn close(app: &AppHandle, request: MainWindowRevealRequest) -> bool {
    close_with(app, request, Settlement::Interrupted)
}

fn close_with(app: &AppHandle, request: MainWindowRevealRequest, outcome: Settlement) -> bool {
    let revealed = dismissed(app, request, outcome);
    if let Some(overlay) = app.get_webview_window(OVERLAY) {
        let _ = overlay.destroy();
    }
    revealed
}

fn dismissed(app: &AppHandle, request: MainWindowRevealRequest, outcome: Settlement) -> bool {
    let outcome = {
        let state = app.state::<FirstOpenState>();
        let mut opening = state.0.lock().unwrap();
        opening.placement = None;
        opening.handoff.dismiss(outcome)
    };
    let Some(outcome) = outcome else { return false; };
    if let Err(error) = reveal_main(app, request) {
        notify_main(app, Host::Settled { outcome: Settlement::Fallback });
        log::warn!("Could not restore main after the opening: {error}");
        return false;
    }
    notify_main(app, Host::Settled { outcome });
    true
}

pub(crate) fn on_window_event(app: &AppHandle, label: &str, event: &tauri::WindowEvent) {
    if label != OVERLAY { return; }
    match event {
        tauri::WindowEvent::Destroyed => { dismissed(app, MainWindowRevealRequest::App, Settlement::Fallback); }
        tauri::WindowEvent::Focused(false)
            if app.state::<FirstOpenState>().0.lock().unwrap().handoff == Handoff::Playing
                && !window_chrome::app_is_active(app) => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { close(&app, MainWindowRevealRequest::App); });
        }
        _ => {}
    }
}
