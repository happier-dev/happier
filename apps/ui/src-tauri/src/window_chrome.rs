#[cfg(desktop)]
use serde::Serialize;

#[cfg(desktop)]
use tauri::{App, Emitter, Manager, Runtime, TitleBarStyle, WebviewWindow, Window, WindowEvent};

#[cfg(desktop)]
const MAIN_WINDOW_LABEL: &str = "main";

#[cfg(desktop)]
const DESKTOP_WINDOW_STATE_EVENT: &str = "desktopWindow://state";

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DesktopWindowChromeStrategy {
    None,
    NativeMacosTrafficLights,
    CustomControls,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DesktopWindowPlatform {
    MacOs,
    Windows,
    Linux,
    Unknown,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DesktopWindowChromeRuntimePolicy {
    strategy: DesktopWindowChromeStrategy,
    use_window_decorations: bool,
    title_bar_style: Option<TitleBarStyle>,
    hide_native_title: bool,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWindowChromePolicyPayload {
    pub strategy: DesktopWindowChromeStrategy,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopWindowStatePayload {
    pub is_maximized: bool,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DesktopWindowCloseStrategy {
    Hide,
    Close,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DesktopMainWindowLifecycleEvent {
    AppReady,
    MacOsReopen { has_visible_windows: bool },
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DesktopMainWindowPresentationIntent {
    None,
    Show,
}

#[cfg(desktop)]
fn resolve_current_desktop_window_platform() -> DesktopWindowPlatform {
    if cfg!(target_os = "macos") {
        return DesktopWindowPlatform::MacOs;
    }
    if cfg!(target_os = "windows") {
        return DesktopWindowPlatform::Windows;
    }
    if cfg!(target_os = "linux") {
        return DesktopWindowPlatform::Linux;
    }
    DesktopWindowPlatform::Unknown
}

#[cfg(desktop)]
fn resolve_desktop_window_chrome_runtime_policy(
    window_label: &str,
    platform: DesktopWindowPlatform,
) -> DesktopWindowChromeRuntimePolicy {
    if window_label != MAIN_WINDOW_LABEL {
        return DesktopWindowChromeRuntimePolicy {
            strategy: DesktopWindowChromeStrategy::None,
            use_window_decorations: true,
            title_bar_style: None,
            hide_native_title: false,
        };
    }

    match platform {
        DesktopWindowPlatform::MacOs => DesktopWindowChromeRuntimePolicy {
            strategy: DesktopWindowChromeStrategy::NativeMacosTrafficLights,
            use_window_decorations: true,
            title_bar_style: Some(TitleBarStyle::Overlay),
            hide_native_title: true,
        },
        DesktopWindowPlatform::Windows
        | DesktopWindowPlatform::Linux
        | DesktopWindowPlatform::Unknown => DesktopWindowChromeRuntimePolicy {
            strategy: DesktopWindowChromeStrategy::CustomControls,
            use_window_decorations: false,
            title_bar_style: None,
            hide_native_title: false,
        },
    }
}

#[cfg(desktop)]
fn desktop_window_chrome_policy_supports_controls(
    policy: DesktopWindowChromeRuntimePolicy,
) -> bool {
    policy.strategy != DesktopWindowChromeStrategy::None
}

#[cfg(desktop)]
fn desktop_window_chrome_policy_tracks_maximized_state(
    policy: DesktopWindowChromeRuntimePolicy,
) -> bool {
    policy.strategy == DesktopWindowChromeStrategy::CustomControls
}

#[cfg(desktop)]
fn resolve_desktop_window_close_strategy(window_label: &str) -> DesktopWindowCloseStrategy {
    if window_label == MAIN_WINDOW_LABEL {
        return DesktopWindowCloseStrategy::Hide;
    }

    DesktopWindowCloseStrategy::Close
}

#[cfg(desktop)]
pub(crate) fn resolve_desktop_main_window_presentation_intent(
    event: DesktopMainWindowLifecycleEvent,
) -> DesktopMainWindowPresentationIntent {
    match event {
        DesktopMainWindowLifecycleEvent::AppReady => DesktopMainWindowPresentationIntent::Show,
        DesktopMainWindowLifecycleEvent::MacOsReopen {
            has_visible_windows,
        } => {
            if has_visible_windows {
                DesktopMainWindowPresentationIntent::None
            } else {
                DesktopMainWindowPresentationIntent::Show
            }
        }
    }
}

#[cfg(desktop)]
fn build_desktop_window_chrome_policy_payload(
    policy: DesktopWindowChromeRuntimePolicy,
) -> DesktopWindowChromePolicyPayload {
    DesktopWindowChromePolicyPayload {
        strategy: policy.strategy,
    }
}

#[cfg(desktop)]
fn build_desktop_window_state_payload(is_maximized: bool) -> DesktopWindowStatePayload {
    DesktopWindowStatePayload { is_maximized }
}

#[cfg(desktop)]
fn resolve_desktop_window_state_payload_for_policy(
    policy: DesktopWindowChromeRuntimePolicy,
    is_maximized: bool,
) -> DesktopWindowStatePayload {
    if !desktop_window_chrome_policy_supports_controls(policy) {
        return build_desktop_window_state_payload(false);
    }

    build_desktop_window_state_payload(
        desktop_window_chrome_policy_tracks_maximized_state(policy) && is_maximized,
    )
}

#[cfg(desktop)]
fn resolve_desktop_window_state_payload_for_window<R: Runtime>(
    window: &Window<R>,
) -> DesktopWindowStatePayload {
    let policy = resolve_desktop_window_chrome_runtime_policy(
        window.label(),
        resolve_current_desktop_window_platform(),
    );
    if !desktop_window_chrome_policy_tracks_maximized_state(policy) {
        return resolve_desktop_window_state_payload_for_policy(policy, false);
    }

    resolve_desktop_window_state_payload_for_policy(policy, window.is_maximized().unwrap_or(false))
}

#[cfg(desktop)]
fn apply_desktop_window_chrome_runtime_policy<R: Runtime>(
    window: &WebviewWindow<R>,
    policy: DesktopWindowChromeRuntimePolicy,
) -> Result<(), String> {
    if policy.hide_native_title {
        window.set_title("").map_err(|error| error.to_string())?;
    }

    window
        .set_decorations(policy.use_window_decorations)
        .map_err(|error| error.to_string())?;

    #[cfg(target_os = "macos")]
    if let Some(style) = policy.title_bar_style {
        window
            .set_title_bar_style(style)
            .map_err(|error| error.to_string())?;
    }

    Ok(())
}

#[cfg(desktop)]
fn emit_desktop_window_state<R: Runtime>(window: &WebviewWindow<R>) {
    let policy = resolve_desktop_window_chrome_runtime_policy(
        window.label(),
        resolve_current_desktop_window_platform(),
    );
    if !desktop_window_chrome_policy_tracks_maximized_state(policy) {
        return;
    }

    let _ = window.emit(
        DESKTOP_WINDOW_STATE_EVENT,
        resolve_desktop_window_state_payload_for_policy(
            policy,
            window.is_maximized().unwrap_or(false),
        ),
    );
}

#[cfg(desktop)]
pub(crate) fn show_main_window<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
    }
    Ok(())
}

#[cfg(desktop)]
pub(crate) fn present_main_window_for_lifecycle_event<R: Runtime>(
    app: &tauri::AppHandle<R>,
    event: DesktopMainWindowLifecycleEvent,
) {
    if resolve_desktop_main_window_presentation_intent(event)
        != DesktopMainWindowPresentationIntent::Show
    {
        return;
    }

    if let Err(error) = show_main_window(app) {
        log::warn!("failed to show main window for lifecycle event {event:?}: {error}");
    }
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_get_window_chrome_policy(
    window: Window,
) -> Result<DesktopWindowChromePolicyPayload, String> {
    Ok(build_desktop_window_chrome_policy_payload(
        resolve_desktop_window_chrome_runtime_policy(
            window.label(),
            resolve_current_desktop_window_platform(),
        ),
    ))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_get_window_state(window: Window) -> Result<DesktopWindowStatePayload, String> {
    Ok(resolve_desktop_window_state_payload_for_window(&window))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_minimize_window(window: Window) -> Result<bool, String> {
    let policy = resolve_desktop_window_chrome_runtime_policy(
        window.label(),
        resolve_current_desktop_window_platform(),
    );
    if !desktop_window_chrome_policy_supports_controls(policy) {
        return Ok(false);
    }

    window.minimize().map_err(|error| error.to_string())?;
    let _ = window.emit(
        DESKTOP_WINDOW_STATE_EVENT,
        resolve_desktop_window_state_payload_for_window(&window),
    );
    Ok(true)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_toggle_window_maximize(window: Window) -> Result<bool, String> {
    let policy = resolve_desktop_window_chrome_runtime_policy(
        window.label(),
        resolve_current_desktop_window_platform(),
    );
    if !desktop_window_chrome_policy_supports_controls(policy) {
        return Ok(false);
    }

    if window.is_maximized().unwrap_or(false) {
        window.unmaximize().map_err(|error| error.to_string())?;
    } else {
        window.maximize().map_err(|error| error.to_string())?;
    }
    let _ = window.emit(
        DESKTOP_WINDOW_STATE_EVENT,
        resolve_desktop_window_state_payload_for_window(&window),
    );
    Ok(true)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_close_window(window: Window) -> Result<bool, String> {
    let policy = resolve_desktop_window_chrome_runtime_policy(
        window.label(),
        resolve_current_desktop_window_platform(),
    );
    if !desktop_window_chrome_policy_supports_controls(policy) {
        return Ok(false);
    }

    match resolve_desktop_window_close_strategy(window.label()) {
        DesktopWindowCloseStrategy::Hide => {
            window.hide().map_err(|error| error.to_string())?;
        }
        DesktopWindowCloseStrategy::Close => {
            window.close().map_err(|error| error.to_string())?;
        }
    }
    Ok(true)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_show_main_window<R: Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<bool, String> {
    let has_main_window = app.get_webview_window(MAIN_WINDOW_LABEL).is_some();
    show_main_window(&app).map_err(|error| error.to_string())?;
    Ok(has_main_window)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_start_window_dragging(window: Window) -> Result<bool, String> {
    let policy = resolve_desktop_window_chrome_runtime_policy(
        window.label(),
        resolve_current_desktop_window_platform(),
    );
    if !desktop_window_chrome_policy_supports_controls(policy) {
        return Ok(false);
    }

    window.start_dragging().map_err(|error| error.to_string())?;
    Ok(true)
}

#[cfg(desktop)]
pub fn register<R: Runtime>(app: &mut App<R>) -> tauri::Result<()> {
    let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) else {
        return Ok(());
    };

    let policy = resolve_desktop_window_chrome_runtime_policy(
        window.label(),
        resolve_current_desktop_window_platform(),
    );

    if let Err(error) = apply_desktop_window_chrome_runtime_policy(&window, policy) {
        log::warn!("failed to apply main-window chrome policy: {error}");
    }

    if desktop_window_chrome_policy_tracks_maximized_state(policy) {
        emit_desktop_window_state(&window);

        let window_for_events = window.clone();
        window.on_window_event(move |event| {
            if matches!(
                event,
                WindowEvent::Moved(_)
                    | WindowEvent::Resized(_)
                    | WindowEvent::ScaleFactorChanged { .. }
            ) {
                emit_desktop_window_state(&window_for_events);
            }
        });
    }

    let close_strategy = resolve_desktop_window_close_strategy(window.label());
    if close_strategy == DesktopWindowCloseStrategy::Hide {
        let window_for_close = window.clone();
        window.on_window_event(move |event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window_for_close.hide();
            }
        });
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_window_prefers_native_traffic_lights_on_macos() {
        let policy = resolve_desktop_window_chrome_runtime_policy(
            MAIN_WINDOW_LABEL,
            DesktopWindowPlatform::MacOs,
        );

        assert_eq!(
            policy.strategy,
            DesktopWindowChromeStrategy::NativeMacosTrafficLights
        );
        assert!(policy.use_window_decorations);
        assert_eq!(policy.title_bar_style, Some(TitleBarStyle::Overlay));
        assert!(policy.hide_native_title);
    }

    #[test]
    fn main_window_prefers_custom_controls_on_non_macos_desktop() {
        let policy = resolve_desktop_window_chrome_runtime_policy(
            MAIN_WINDOW_LABEL,
            DesktopWindowPlatform::Windows,
        );

        assert_eq!(policy.strategy, DesktopWindowChromeStrategy::CustomControls);
        assert!(!policy.use_window_decorations);
        assert_eq!(policy.title_bar_style, None);
        assert!(!policy.hide_native_title);
    }

    #[test]
    fn non_main_windows_do_not_receive_main_window_chrome_policy() {
        let policy = resolve_desktop_window_chrome_runtime_policy(
            "pet_overlay",
            DesktopWindowPlatform::MacOs,
        );

        assert_eq!(policy.strategy, DesktopWindowChromeStrategy::None);
        assert!(policy.use_window_decorations);
        assert_eq!(policy.title_bar_style, None);
        assert!(!policy.hide_native_title);
    }

    #[test]
    fn main_window_hides_instead_of_closing() {
        assert_eq!(
            resolve_desktop_window_close_strategy(MAIN_WINDOW_LABEL),
            DesktopWindowCloseStrategy::Hide
        );
    }

    #[test]
    fn app_ready_shows_the_main_window_when_it_started_hidden() {
        assert_eq!(
            resolve_desktop_main_window_presentation_intent(
                DesktopMainWindowLifecycleEvent::AppReady
            ),
            DesktopMainWindowPresentationIntent::Show
        );
    }

    #[test]
    fn macos_reopen_shows_the_main_window_only_when_no_window_is_visible() {
        assert_eq!(
            resolve_desktop_main_window_presentation_intent(
                DesktopMainWindowLifecycleEvent::MacOsReopen {
                    has_visible_windows: false,
                }
            ),
            DesktopMainWindowPresentationIntent::Show
        );
        assert_eq!(
            resolve_desktop_main_window_presentation_intent(
                DesktopMainWindowLifecycleEvent::MacOsReopen {
                    has_visible_windows: true,
                }
            ),
            DesktopMainWindowPresentationIntent::None
        );
    }

    #[test]
    fn non_main_windows_still_close_normally() {
        assert_eq!(
            resolve_desktop_window_close_strategy("pet_overlay"),
            DesktopWindowCloseStrategy::Close
        );
    }

    #[test]
    fn custom_control_policy_payload_serializes_to_the_frontend_contract() {
        let payload = build_desktop_window_chrome_policy_payload(
            resolve_desktop_window_chrome_runtime_policy(
                MAIN_WINDOW_LABEL,
                DesktopWindowPlatform::Windows,
            ),
        );

        assert_eq!(
            serde_json::to_value(payload).expect("payload should serialize"),
            serde_json::json!({
                "strategy": "custom-controls",
            })
        );
    }

    #[test]
    fn state_payload_serializes_to_the_frontend_contract() {
        assert_eq!(
            serde_json::to_value(build_desktop_window_state_payload(true))
                .expect("payload should serialize"),
            serde_json::json!({
                "isMaximized": true,
            })
        );
    }

    #[test]
    fn non_main_window_policy_disables_control_operations() {
        let policy = resolve_desktop_window_chrome_runtime_policy(
            "pet_overlay",
            DesktopWindowPlatform::Windows,
        );

        assert!(!desktop_window_chrome_policy_supports_controls(policy));
    }

    #[test]
    fn native_macos_traffic_lights_do_not_report_maximized_state() {
        let payload = resolve_desktop_window_state_payload_for_policy(
            resolve_desktop_window_chrome_runtime_policy(
                MAIN_WINDOW_LABEL,
                DesktopWindowPlatform::MacOs,
            ),
            true,
        );

        assert_eq!(payload, build_desktop_window_state_payload(false));
    }

    #[test]
    fn custom_controls_preserve_maximized_state() {
        let payload = resolve_desktop_window_state_payload_for_policy(
            resolve_desktop_window_chrome_runtime_policy(
                MAIN_WINDOW_LABEL,
                DesktopWindowPlatform::Windows,
            ),
            true,
        );

        assert_eq!(payload, build_desktop_window_state_payload(true));
    }

    #[test]
    fn native_macos_traffic_lights_do_not_track_maximized_state() {
        let policy = resolve_desktop_window_chrome_runtime_policy(
            MAIN_WINDOW_LABEL,
            DesktopWindowPlatform::MacOs,
        );

        assert!(!desktop_window_chrome_policy_tracks_maximized_state(policy));
    }

    #[test]
    fn custom_controls_track_maximized_state() {
        let policy = resolve_desktop_window_chrome_runtime_policy(
            MAIN_WINDOW_LABEL,
            DesktopWindowPlatform::Windows,
        );

        assert!(desktop_window_chrome_policy_tracks_maximized_state(policy));
    }
}
