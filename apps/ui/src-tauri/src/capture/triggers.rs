//! Person intents enter the native operation without waiting for a main renderer.
use super::{intents::{classify, NativeUrlIntent}, CaptureMode, CaptureSnapshot, CaptureState};
use tauri::{AppHandle, Manager};
use url::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureIntent { Still, Frontmost, Recording }

pub fn dispatch(app: &AppHandle, intent: CaptureIntent) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let mode = if intent == CaptureIntent::Recording { CaptureMode::Recording } else { CaptureMode::Still };
        let target = (intent == CaptureIntent::Frontmost).then_some(happier_desktop_native::capture::CaptureTarget::Frontmost);
        match super::desktop_capture_start(app.clone(), app.state::<CaptureState>(), mode, target, None, None).await {
            Ok(_) => {},
            Err(reason) => {
                let state = app.state::<CaptureState>();
                let mut operation = state.0.operation.lock().unwrap();
                state.publish(&mut operation, CaptureSnapshot::Failed { reason });
            }
        }
    });
}

fn route(app: &AppHandle, urls: Vec<Url>, present_main: bool) {
    let mut show_main = false;
    for url in urls {
        match classify(&url) {
            NativeUrlIntent::Capture => dispatch(app, CaptureIntent::Still),
            NativeUrlIntent::MainWindow => show_main = true,
            NativeUrlIntent::Ignore => {},
        }
    }
    if present_main && show_main { crate::window_chrome::request_show_main_window(app); }
}

/// The deep-link plugin emits live URLs before its single-instance callback.
/// Subscribe once, then consume its cold snapshot; renderer delivery ignores capture.
pub fn install_deep_links(app: &AppHandle) {
    use tauri_plugin_deep_link::DeepLinkExt;
    let handle = app.clone();
    app.deep_link().on_open_url(move |event| route(&handle, event.urls(), cfg!(target_os = "macos")));
    if let Ok(Some(urls)) = app.deep_link().get_current() { route(app, urls, false); }
}

/// The plugin handles a sole URL before the single-instance callback. Mixed CLI
/// batches need native dispatch here because the plugin accepts only one URL.
pub fn second_launch(app: &AppHandle, args: &[String]) -> bool {
    let urls: Vec<Url> = args.iter().skip(1).filter_map(|arg| Url::parse(arg).ok()).collect();
    if urls.is_empty() { return true; }
    if args.len() != 2 {
        #[cfg(any(target_os = "windows", target_os = "linux"))]
        {
            use tauri_plugin_deep_link::DeepLinkExt;
            // Reuse the plugin's URL delivery and current-snapshot owner for each
            // mixed argument, rather than dispatching a second native callback.
            for url in &urls { app.deep_link().handle_cli_arguments([args[0].as_str(), url.as_str()].into_iter()); }
        }
        #[cfg(target_os = "macos")]
        route(app, urls.clone(), true);
    }
    urls.iter().any(|url| classify(url) == NativeUrlIntent::MainWindow)
}

pub fn cold_launch_is_capture_only(app: &AppHandle) -> bool {
    use tauri_plugin_deep_link::DeepLinkExt;
    app.deep_link().get_current().ok().flatten().is_some_and(|urls|
        !urls.is_empty() && urls.iter().all(|url| classify(url) != NativeUrlIntent::MainWindow)
            && urls.iter().any(|url| classify(url) == NativeUrlIntent::Capture))
}
