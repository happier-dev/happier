#[cfg(desktop)]
use serde::Serialize;

#[cfg(desktop)]
#[path = "window_chrome_preferences.rs"]
mod preferences;

#[cfg(desktop)]
struct DesktopWindowChromeState(std::sync::Mutex<preferences::WindowChromePreferences>);

#[cfg(desktop)]
use tauri::{App, Emitter, Manager, Runtime, TitleBarStyle, WebviewWindow, Window, WindowEvent};

#[cfg(target_os = "macos")]
#[path = "macos_window_frame.rs"]
mod macos_window_frame;

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
    NativeWindowsFrame,
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
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub can_set_native_title_bar: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub native_title_bar_persistence_error: bool,
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
    MacOsReopen {
        has_visible_windows: bool,
    },
    /// Happier was launched again while it runs (single instance).
    SecondLaunch,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DesktopMainWindowPresentationIntent {
    /// Show the main window, creating it when menu-bar mode released it.
    Show,
    /// Show the main window only if it exists: a login start in menu-bar mode has none, and app
    /// start must not create one for it (R16 b).
    ShowExisting,
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
    use_native_title_bar: bool,
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
        DesktopWindowPlatform::Windows if use_native_title_bar => {
            DesktopWindowChromeRuntimePolicy {
                strategy: DesktopWindowChromeStrategy::NativeWindowsFrame,
                use_window_decorations: true,
                title_bar_style: None,
                hide_native_title: false,
            }
        }
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
        DesktopMainWindowLifecycleEvent::AppReady => {
            DesktopMainWindowPresentationIntent::ShowExisting
        }
        DesktopMainWindowLifecycleEvent::MacOsReopen { .. }
        | DesktopMainWindowLifecycleEvent::SecondLaunch => {
            DesktopMainWindowPresentationIntent::Show
        }
    }
}

#[cfg(desktop)]
fn build_desktop_window_chrome_policy_payload(
    policy: DesktopWindowChromeRuntimePolicy,
) -> DesktopWindowChromePolicyPayload {
    DesktopWindowChromePolicyPayload {
        strategy: policy.strategy,
        can_set_native_title_bar: false,
        native_title_bar_persistence_error: false,
    }
}

#[cfg(desktop)]
fn resolve_window_chrome_policy<R: Runtime>(
    app: &tauri::AppHandle<R>,
    label: &str,
) -> DesktopWindowChromeRuntimePolicy {
    let state = app.state::<DesktopWindowChromeState>();
    let preferences = state
        .0
        .lock()
        .expect("window chrome preference lock poisoned");
    resolve_desktop_window_chrome_runtime_policy(
        label,
        resolve_current_desktop_window_platform(),
        preferences.use_native_title_bar,
    )
}

#[cfg(desktop)]
fn window_chrome_policy_payload(
    label: &str,
    preferences: &preferences::WindowChromePreferences,
) -> DesktopWindowChromePolicyPayload {
    let platform = resolve_current_desktop_window_platform();
    let mut payload =
        build_desktop_window_chrome_policy_payload(resolve_desktop_window_chrome_runtime_policy(
            label,
            platform,
            preferences.use_native_title_bar,
        ));
    payload.can_set_native_title_bar =
        label == MAIN_WINDOW_LABEL && platform == DesktopWindowPlatform::Windows;
    payload.native_title_bar_persistence_error =
        payload.can_set_native_title_bar && preferences.persistence_error;
    payload
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
    let policy = resolve_window_chrome_policy(window.app_handle(), window.label());
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
    let policy = resolve_window_chrome_policy(window.app_handle(), window.label());
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

/// Reveals the main window. In menu-bar mode there is none: it is created again from the app
/// config (a fresh web UI). A successful rebuild leaves menu-bar mode and restores the Dock icon;
/// a failed rebuild keeps the tray active so Open can be retried.
#[cfg(desktop)]
pub(crate) fn show_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    let window = match app.get_webview_window(MAIN_WINDOW_LABEL) {
        Some(window) => window,
        None => {
            let window = create_main_window(app)?;
            crate::menu_bar::leave(app);
            window
        }
    };
    window.unminimize()?;
    window.show()?;
    window.set_focus()?;
    Ok(())
}

/// WebView2 creation deadlocks in synchronous event handlers (Tauri 2.8.2's builder contract).
/// Menu, reopen and second-instance events all schedule the existing presentation owner here.
#[cfg(desktop)]
pub(crate) fn request_show_main_window(app: &tauri::AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(error) = show_main_window(&app) {
            log::warn!("failed to show the main window: {error}");
        }
    });
}

#[cfg(desktop)]
fn show_existing_main_window(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW_LABEL) {
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
    }
    Ok(())
}

#[cfg(desktop)]
pub(crate) fn present_main_window_for_lifecycle_event(
    app: &tauri::AppHandle,
    event: DesktopMainWindowLifecycleEvent,
) {
    let result = match resolve_desktop_main_window_presentation_intent(event) {
        DesktopMainWindowPresentationIntent::Show => {
            request_show_main_window(app);
            Ok(())
        }
        DesktopMainWindowPresentationIntent::ShowExisting => show_existing_main_window(app),
    };
    if let Err(error) = result {
        log::warn!("failed to show main window for lifecycle event {event:?}: {error}");
    }
}

/// The main window, built from its `tauri.conf.json` entry (`"create": false`: the app creates it
/// here, so a login start in menu-bar mode never loads a web UI).
#[cfg(desktop)]
pub(crate) fn create_main_window(app: &tauri::AppHandle) -> tauri::Result<WebviewWindow> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW_LABEL)
        .cloned()
        .ok_or_else(|| tauri::Error::WindowNotFound)?;
    let policy = resolve_window_chrome_policy(app, MAIN_WINDOW_LABEL);
    let window = tauri::WebviewWindowBuilder::from_config(app, &config)?
        .decorations(policy.use_window_decorations)
        .build()?;
    configure_main_window(app, &window);
    Ok(window)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_get_window_chrome_policy(
    window: Window,
) -> Result<DesktopWindowChromePolicyPayload, String> {
    let state = window.state::<DesktopWindowChromeState>();
    let preferences = state.0.lock().map_err(|error| error.to_string())?;
    Ok(window_chrome_policy_payload(window.label(), &preferences))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_set_native_title_bar(
    window: WebviewWindow,
    use_native_title_bar: bool,
) -> Result<DesktopWindowChromePolicyPayload, String> {
    if window.label() != MAIN_WINDOW_LABEL
        || resolve_current_desktop_window_platform() != DesktopWindowPlatform::Windows
    {
        return Err(
            "native title bar preference is only available for the Windows main window".into(),
        );
    }
    let state = window.state::<DesktopWindowChromeState>();
    let policy = resolve_desktop_window_chrome_runtime_policy(
        window.label(),
        DesktopWindowPlatform::Windows,
        use_native_title_bar,
    );
    // Applying decorations may synchronously deliver resize events, whose state
    // projection reads the preferences too. Never hold that lock across the OS call.
    apply_desktop_window_chrome_runtime_policy(&window, policy)?;
    let mut preferences = state.0.lock().map_err(|error| error.to_string())?;
    preferences.save_applied(use_native_title_bar);
    Ok(window_chrome_policy_payload(window.label(), &preferences))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_get_window_state(window: Window) -> Result<DesktopWindowStatePayload, String> {
    Ok(resolve_desktop_window_state_payload_for_window(&window))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_minimize_window(window: Window) -> Result<bool, String> {
    let policy = resolve_window_chrome_policy(window.app_handle(), window.label());
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
    let policy = resolve_window_chrome_policy(window.app_handle(), window.label());
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
    let policy = resolve_window_chrome_policy(window.app_handle(), window.label());
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
pub async fn desktop_show_main_window(app: tauri::AppHandle) -> Result<bool, String> {
    let has_main_window = app.get_webview_window(MAIN_WINDOW_LABEL).is_some();
    show_main_window(&app).map_err(|error| error.to_string())?;
    Ok(has_main_window)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_start_window_dragging(window: Window) -> Result<bool, String> {
    let policy = resolve_window_chrome_policy(window.app_handle(), window.label());
    if !desktop_window_chrome_policy_supports_controls(policy) {
        return Ok(false);
    }

    window.start_dragging().map_err(|error| error.to_string())?;
    Ok(true)
}

/// Creates the main window at app start — unless the app was started at login in menu-bar mode,
/// which has no window until the tray's Open asks for one.
#[cfg(desktop)]
pub fn register(app: &mut App) -> tauri::Result<()> {
    let preferences = if resolve_current_desktop_window_platform() == DesktopWindowPlatform::Windows
    {
        preferences::WindowChromePreferences::load(
            app.path()
                .app_config_dir()?
                .join("window-state/main-window-chrome.json"),
        )
    } else {
        preferences::WindowChromePreferences::default()
    };
    app.manage(DesktopWindowChromeState(std::sync::Mutex::new(preferences)));
    if crate::menu_bar::launched_in_menu_bar_mode(app.handle()) {
        return Ok(());
    }
    create_main_window(app.handle())?;
    Ok(())
}

#[cfg(desktop)]
fn configure_main_window(app: &tauri::AppHandle, window: &WebviewWindow) {
    let policy = resolve_window_chrome_policy(window.app_handle(), window.label());

    if let Err(error) = apply_desktop_window_chrome_runtime_policy(window, policy) {
        log::warn!("failed to apply main-window chrome policy: {error}");
    }

    #[cfg(target_os = "macos")]
    if let Err(error) = window.with_webview(|webview| {
        // Tauri runs this callback on the main thread and keeps the NSWindow alive for it.
        let native_window = unsafe { &*webview.ns_window().cast::<objc2_app_kit::NSWindow>() };
        if !macos_window_frame::restore_and_track_frame(native_window, MAIN_WINDOW_LABEL) {
            eprintln!("failed to enable main-window frame autosave: name already in use");
        }
    }) {
        eprintln!("failed to configure main-window frame autosave: {error}");
    }

    // Windows can switch back to custom controls without recreating the window.
    if matches!(
        policy.strategy,
        DesktopWindowChromeStrategy::CustomControls
            | DesktopWindowChromeStrategy::NativeWindowsFrame
    ) {
        emit_desktop_window_state(window);

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

    #[cfg(target_os = "windows")]
    crate::tray::follow_tray_theme_from_window(app, window);
    #[cfg(not(target_os = "windows"))]
    let _ = app;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn main_window_prefers_native_traffic_lights_on_macos() {
        let policy = resolve_desktop_window_chrome_runtime_policy(
            MAIN_WINDOW_LABEL,
            DesktopWindowPlatform::MacOs,
            false,
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
            false,
        );

        assert_eq!(policy.strategy, DesktopWindowChromeStrategy::CustomControls);
        assert!(!policy.use_window_decorations);
        assert_eq!(policy.title_bar_style, None);
        assert!(!policy.hide_native_title);
    }

    #[test]
    fn windows_native_title_bar_restores_decorations_without_disabling_actions() {
        let policy = resolve_desktop_window_chrome_runtime_policy(
            MAIN_WINDOW_LABEL,
            DesktopWindowPlatform::Windows,
            true,
        );
        assert!(policy.use_window_decorations);
        assert!(desktop_window_chrome_policy_supports_controls(policy));
        assert!(!desktop_window_chrome_policy_tracks_maximized_state(policy));
        for platform in [DesktopWindowPlatform::MacOs, DesktopWindowPlatform::Linux] {
            assert_eq!(
                resolve_desktop_window_chrome_runtime_policy(MAIN_WINDOW_LABEL, platform, true),
                resolve_desktop_window_chrome_runtime_policy(MAIN_WINDOW_LABEL, platform, false),
            );
        }
    }

    #[test]
    fn non_main_windows_do_not_receive_main_window_chrome_policy() {
        let policy = resolve_desktop_window_chrome_runtime_policy(
            "pet_overlay",
            DesktopWindowPlatform::MacOs,
            false,
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
    fn app_ready_shows_the_main_window_it_created_but_never_creates_one() {
        // A login start in menu-bar mode has no window at app ready, and must not get one.
        assert_eq!(
            resolve_desktop_main_window_presentation_intent(
                DesktopMainWindowLifecycleEvent::AppReady
            ),
            DesktopMainWindowPresentationIntent::ShowExisting
        );
    }

    #[test]
    fn macos_reopen_presents_the_main_window_even_when_auxiliary_windows_are_visible() {
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
            DesktopMainWindowPresentationIntent::Show
        );
    }

    #[test]
    fn a_second_launch_opens_the_main_window_through_the_same_path_as_reopen() {
        assert_eq!(
            resolve_desktop_main_window_presentation_intent(
                DesktopMainWindowLifecycleEvent::SecondLaunch
            ),
            DesktopMainWindowPresentationIntent::Show
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
                false,
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
            false,
        );

        assert!(!desktop_window_chrome_policy_supports_controls(policy));
    }

    #[test]
    fn native_macos_traffic_lights_do_not_report_maximized_state() {
        let payload = resolve_desktop_window_state_payload_for_policy(
            resolve_desktop_window_chrome_runtime_policy(
                MAIN_WINDOW_LABEL,
                DesktopWindowPlatform::MacOs,
                false,
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
                false,
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
            false,
        );

        assert!(!desktop_window_chrome_policy_tracks_maximized_state(policy));
    }

    #[test]
    fn custom_controls_track_maximized_state() {
        let policy = resolve_desktop_window_chrome_runtime_policy(
            MAIN_WINDOW_LABEL,
            DesktopWindowPlatform::Windows,
            false,
        );

        assert!(desktop_window_chrome_policy_tracks_maximized_state(policy));
    }
}
