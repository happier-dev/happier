#[cfg(desktop)]
use serde::{Deserialize, Serialize};

#[cfg(desktop)]
use std::sync::Mutex;

#[cfg(desktop)]
use tauri::{App, Emitter, Manager, Runtime, TitleBarStyle, WebviewWindow, Window, WindowEvent};

#[cfg(desktop)]
pub(crate) const MAIN_WINDOW_LABEL: &str = "main";

#[cfg(desktop)]
const DESKTOP_WINDOW_STATE_EVENT: &str = "desktopWindow://state";

#[cfg(desktop)]
const DESKTOP_GLASS_STATE_EVENT: &str = "desktopGlass://state";

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DesktopGlassBlur {
    Off,
    Light,
    Regular,
    Strong,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct DesktopGlassMaterialRequest {
    enabled: bool,
    blur: DesktopGlassBlur,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopGlassStatePayload {
    pub supported: bool,
    /// Native transparent backing is live, including enabled material with blur Off.
    pub material_live: bool,
    pub reduce_transparency: bool,
    pub high_contrast: bool,
    pub window_active: bool,
}

#[cfg(desktop)]
struct DesktopGlassRuntime(Mutex<DesktopGlassRuntimeInner>);

#[cfg(desktop)]
struct DesktopGlassRuntimeInner {
    request: DesktopGlassMaterialRequest,
    applied_blur: Option<DesktopGlassBlur>,
    payload: DesktopGlassStatePayload,
}

#[cfg(desktop)]
fn desktop_glass_material_requested(
    request: DesktopGlassMaterialRequest,
    supported: bool,
    reduce_transparency: bool,
    window_active: bool,
) -> bool {
    request.enabled && supported && !reduce_transparency && window_active
}

#[cfg(target_os = "macos")]
fn read_glass_accessibility() -> Result<(bool, bool), String> {
    // Invoked on the native main thread with all material application.
    let workspace = unsafe { objc2_app_kit::NSWorkspace::sharedWorkspace() };
    Ok(unsafe {
        (
            workspace.accessibilityDisplayShouldReduceTransparency(),
            workspace.accessibilityDisplayShouldIncreaseContrast(),
        )
    })
}

#[cfg(target_os = "windows")]
fn read_glass_accessibility() -> Result<(bool, bool), String> {
    use windows::UI::ViewManagement::{AccessibilitySettings, UISettings};
    let effects = UISettings::new()
        .and_then(|settings| settings.AdvancedEffectsEnabled())
        .map_err(|error| error.to_string())?;
    let contrast = AccessibilitySettings::new()
        .and_then(|settings| settings.HighContrast())
        .map_err(|error| error.to_string())?;
    Ok((!effects, contrast))
}

#[cfg(all(desktop, not(any(target_os = "macos", target_os = "windows"))))]
fn read_glass_accessibility() -> Result<(bool, bool), String> {
    Ok((false, false))
}

#[cfg(target_os = "windows")]
fn read_windows_backdrop(window: &WebviewWindow) -> Result<i32, String> {
    use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_SYSTEMBACKDROP_TYPE};
    let mut backdrop = 0_i32;
    unsafe {
        DwmGetWindowAttribute(
            window.hwnd().map_err(|error| error.to_string())?,
            DWMWA_SYSTEMBACKDROP_TYPE,
            (&mut backdrop as *mut i32).cast(),
            std::mem::size_of::<i32>() as u32,
        )
    }
    .map_err(|error| error.to_string())?;
    Ok(backdrop)
}

#[cfg(desktop)]
fn glass_platform_supported(window: &WebviewWindow) -> bool {
    #[cfg(target_os = "macos")]
    {
        let _ = window;
        true
    }
    #[cfg(target_os = "windows")]
    {
        read_windows_backdrop(window).is_ok()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = window;
        false
    }
}

#[cfg(target_os = "macos")]
fn apply_native_glass(
    window: &WebviewWindow,
    blur: Option<DesktopGlassBlur>,
) -> Result<(), String> {
    use window_vibrancy::{NSVisualEffectMaterial as Material, NSVisualEffectState};
    let material = match blur {
        None | Some(DesktopGlassBlur::Off) => {
            return window_vibrancy::clear_vibrancy(window)
                .map(|_| ())
                .map_err(|error| error.to_string());
        }
        Some(DesktopGlassBlur::Light) => Material::UnderWindowBackground,
        Some(DesktopGlassBlur::Regular) => Material::Sidebar,
        Some(DesktopGlassBlur::Strong) => Material::HudWindow,
    };
    // Tauri's public effect path uses this same crate but drops its Result.
    // Replacing a step removes the old native view instead of stacking blur planes.
    window_vibrancy::clear_vibrancy(window).map_err(|error| error.to_string())?;
    window_vibrancy::apply_vibrancy(
        window,
        material,
        Some(NSVisualEffectState::FollowsWindowActiveState),
        None,
    )
    .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn apply_native_glass(
    window: &WebviewWindow,
    blur: Option<DesktopGlassBlur>,
) -> Result<(), String> {
    use windows::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMSBT_NONE, DWMSBT_TRANSIENTWINDOW, DWMWA_SYSTEMBACKDROP_TYPE,
    };
    // Public Desktop Acrylic (Windows 11 build 22621+), with result and readback.
    // Chrome drives this single window material. Windows maps each non-Off
    // chrome step to Acrylic; each group's renderer blur/tint remains independent.
    let backdrop = match blur {
        None | Some(DesktopGlassBlur::Off) => DWMSBT_NONE.0,
        Some(_) => DWMSBT_TRANSIENTWINDOW.0,
    };
    unsafe {
        DwmSetWindowAttribute(
            window.hwnd().map_err(|error| error.to_string())?,
            DWMWA_SYSTEMBACKDROP_TYPE,
            (&backdrop as *const i32).cast(),
            std::mem::size_of::<i32>() as u32,
        )
    }
    .map_err(|error| error.to_string())?;
    if read_windows_backdrop(window)? != backdrop {
        return Err("DWM did not retain the requested window material".into());
    }
    Ok(())
}

#[cfg(all(desktop, not(any(target_os = "macos", target_os = "windows"))))]
fn apply_native_glass(
    _window: &WebviewWindow,
    _blur: Option<DesktopGlassBlur>,
) -> Result<(), String> {
    Ok(())
}

#[cfg(desktop)]
fn refresh_desktop_glass(window: &WebviewWindow) -> Result<DesktopGlassStatePayload, String> {
    let state = window.app_handle().state::<DesktopGlassRuntime>();
    let mut inner = state.0.lock().map_err(|error| error.to_string())?;
    let previous = inner.payload;
    let accessibility = read_glass_accessibility();
    let supported = accessibility.is_ok() && glass_platform_supported(window);
    let (reduce_transparency, high_contrast) = accessibility.unwrap_or_else(|error| {
        log::warn!("failed to read desktop glass accessibility: {error}");
        (previous.reduce_transparency, previous.high_contrast)
    });
    let window_active = window.is_focused().unwrap_or(false);
    let wants_material = desktop_glass_material_requested(
        inner.request,
        supported,
        reduce_transparency,
        window_active,
    );
    let desired = if wants_material {
        Some(inner.request.blur)
    } else {
        None
    };
    let mut material_live = inner.applied_blur.is_some();
    if desired != inner.applied_blur {
        let result = if desired.is_some() {
            window
                .set_background_color(Some(tauri::window::Color(0, 0, 0, 0)))
                .map_err(|error| error.to_string())
                .and_then(|_| apply_native_glass(window, desired))
        } else {
            apply_native_glass(window, None).and_then(|_| {
                window
                    .set_background_color(None)
                    .map_err(|error| error.to_string())
            })
        };
        match result {
            Ok(()) => {
                inner.applied_blur = desired;
                material_live = desired.is_some();
            }
            Err(error) => {
                log::warn!("failed to apply desktop glass material: {error}");
                let _ = apply_native_glass(window, None);
                let _ = window.set_background_color(None);
                inner.applied_blur = None;
                material_live = false;
            }
        }
    }
    let payload = DesktopGlassStatePayload {
        supported,
        material_live: material_live && wants_material,
        reduce_transparency,
        high_contrast,
        window_active,
    };
    inner.payload = payload;
    drop(inner);
    if payload != previous {
        let _ = window.emit(DESKTOP_GLASS_STATE_EVENT, payload);
    }
    Ok(payload)
}

#[cfg(desktop)]
fn request_refresh_desktop_glass(app: &tauri::AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(window) = handle.get_webview_window(MAIN_WINDOW_LABEL) {
            if let Err(error) = refresh_desktop_glass(&window) {
                log::warn!("failed to refresh desktop glass: {error}");
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn register_glass_accessibility(app: &mut App) {
    use objc2::{rc::Retained, runtime::ProtocolObject};
    use objc2_app_kit::{NSWorkspace, NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification};
    use objc2_foundation::{NSNotification, NSNotificationCenter, NSObjectProtocol};
    use std::{cell::RefCell, ptr::NonNull};

    struct Observer {
        center: Retained<NSNotificationCenter>,
        token: Retained<ProtocolObject<dyn NSObjectProtocol>>,
    }
    impl Drop for Observer {
        fn drop(&mut self) {
            let token: &ProtocolObject<dyn NSObjectProtocol> = self.token.as_ref();
            unsafe { self.center.removeObserver(token.as_ref()) };
        }
    }
    thread_local! { static OBSERVER: RefCell<Option<Observer>> = const { RefCell::new(None) }; }
    let handle = app.handle().clone();
    let block = block2::RcBlock::new(move |_notification: NonNull<NSNotification>| {
        request_refresh_desktop_glass(&handle)
    });
    let center = unsafe { NSWorkspace::sharedWorkspace().notificationCenter() };
    let token = unsafe {
        center.addObserverForName_object_queue_usingBlock(
            Some(NSWorkspaceAccessibilityDisplayOptionsDidChangeNotification),
            None,
            None,
            &block,
        )
    };
    OBSERVER.with(|observer| *observer.borrow_mut() = Some(Observer { center, token }));
}

#[cfg(target_os = "windows")]
fn register_glass_accessibility(app: &mut App) {
    use windows::{
        core::IInspectable,
        Foundation::TypedEventHandler,
        UI::ViewManagement::{AccessibilitySettings, UISettings},
    };

    struct Subscriptions {
        ui: UISettings,
        effects_token: i64,
        accessibility: AccessibilitySettings,
        contrast_token: i64,
    }
    impl Drop for Subscriptions {
        fn drop(&mut self) {
            let _ = self
                .ui
                .RemoveAdvancedEffectsEnabledChanged(self.effects_token);
            let _ = self
                .accessibility
                .RemoveHighContrastChanged(self.contrast_token);
        }
    }
    let result = (|| -> windows::core::Result<Subscriptions> {
        let ui = UISettings::new()?;
        let accessibility = AccessibilitySettings::new()?;
        let handle = app.handle().clone();
        let effects_token = ui.AdvancedEffectsEnabledChanged(&TypedEventHandler::<
            UISettings,
            IInspectable,
        >::new(move |_, _| {
            request_refresh_desktop_glass(&handle);
            Ok(())
        }))?;
        let handle = app.handle().clone();
        let contrast_token =
            match accessibility.HighContrastChanged(&TypedEventHandler::<
                AccessibilitySettings,
                IInspectable,
            >::new(move |_, _| {
                request_refresh_desktop_glass(&handle);
                Ok(())
            })) {
                Ok(token) => token,
                Err(error) => {
                    let _ = ui.RemoveAdvancedEffectsEnabledChanged(effects_token);
                    return Err(error);
                }
            };
        Ok(Subscriptions {
            ui,
            effects_token,
            accessibility,
            contrast_token,
        })
    })();
    match result {
        Ok(subscriptions) => {
            app.manage(subscriptions);
        }
        Err(error) => log::warn!("failed to subscribe to desktop glass accessibility: {error}"),
    }
}

#[cfg(all(desktop, not(any(target_os = "macos", target_os = "windows"))))]
fn register_glass_accessibility(_app: &mut App) {}

#[cfg(desktop)]
async fn update_desktop_glass(
    window: WebviewWindow,
    request: Option<DesktopGlassMaterialRequest>,
) -> Result<DesktopGlassStatePayload, String> {
    if window.label() != MAIN_WINDOW_LABEL {
        return Err("window material belongs to the main window".into());
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = window.clone();
    window
        .run_on_main_thread(move || {
            let result = (|| {
                if let Some(request) = request {
                    handle
                        .app_handle()
                        .state::<DesktopGlassRuntime>()
                        .0
                        .lock()
                        .map_err(|error| error.to_string())?
                        .request = request;
                }
                refresh_desktop_glass(&handle)
            })();
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    receiver.await.map_err(|error| error.to_string())?
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_get_glass_state(
    window: WebviewWindow,
) -> Result<DesktopGlassStatePayload, String> {
    update_desktop_glass(window, None).await
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_apply_glass_material(
    window: WebviewWindow,
    enabled: bool,
    blur: DesktopGlassBlur,
) -> Result<DesktopGlassStatePayload, String> {
    update_desktop_glass(window, Some(DesktopGlassMaterialRequest { enabled, blur })).await
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_open_reduce_transparency_settings(
    window: WebviewWindow,
) -> Result<bool, String> {
    use tauri_plugin_opener::OpenerExt;
    if window.label() != MAIN_WINDOW_LABEL {
        return Ok(false);
    }
    let url = match resolve_current_desktop_window_platform() {
        DesktopWindowPlatform::MacOs => {
            "x-apple.systempreferences:com.apple.preference.universalaccess?Seeing_Display"
        }
        DesktopWindowPlatform::Windows => "ms-settings:easeofaccess-display",
        DesktopWindowPlatform::Linux | DesktopWindowPlatform::Unknown => return Ok(false),
    };
    // A fixed OS destination avoids extending the renderer's generic URL/scheme permission.
    window
        .app_handle()
        .opener()
        .open_url(url, None::<&str>)
        .map_err(|error| error.to_string())?;
    Ok(true)
}

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
    pub is_fullscreen: bool,
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
    }
}

#[cfg(desktop)]
fn build_desktop_window_state_payload(
    is_maximized: bool,
    is_fullscreen: bool,
) -> DesktopWindowStatePayload {
    DesktopWindowStatePayload {
        is_maximized,
        is_fullscreen,
    }
}

#[cfg(desktop)]
fn resolve_desktop_window_state_payload_for_policy(
    policy: DesktopWindowChromeRuntimePolicy,
    is_maximized: bool,
    is_fullscreen: bool,
) -> DesktopWindowStatePayload {
    if !desktop_window_chrome_policy_supports_controls(policy) {
        return build_desktop_window_state_payload(false, false);
    }

    build_desktop_window_state_payload(
        desktop_window_chrome_policy_tracks_maximized_state(policy) && is_maximized,
        is_fullscreen,
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
    resolve_desktop_window_state_payload_for_policy(
        policy,
        window.is_maximized().unwrap_or(false),
        window.is_fullscreen().unwrap_or(false),
    )
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
    if !desktop_window_chrome_policy_supports_controls(policy) {
        return;
    }

    let _ = window.emit(
        DESKTOP_WINDOW_STATE_EVENT,
        resolve_desktop_window_state_payload_for_policy(
            policy,
            window.is_maximized().unwrap_or(false),
            window.is_fullscreen().unwrap_or(false),
        ),
    );
}

/// Reveals the main window. In menu-bar mode there is none: it is created again from the app
/// config (a fresh web UI), hidden. After construction succeeds, the app leaves menu-bar mode
/// before showing the window, so macOS restores its Dock icon first and a construction failure
/// leaves the tray-only lifecycle intact.
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
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == MAIN_WINDOW_LABEL)
        .cloned()
        .ok_or_else(|| tauri::Error::WindowNotFound)?;
    // The renderer starts solid and clears selected paint roles only after native success.
    config.transparent = cfg!(any(target_os = "macos", target_os = "windows"));
    let window = tauri::WebviewWindowBuilder::from_config(app, &config)?.build()?;
    configure_main_window(app, &window);
    crate::window_sizing::configure_main_window(app, &window)?;
    Ok(window)
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
    // Fullscreen is owned by the OS/menu, not by titlebar zoom gestures.
    if window.is_fullscreen().map_err(|error| error.to_string())? {
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
pub async fn desktop_show_main_window(app: tauri::AppHandle) -> Result<bool, String> {
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
    if window.is_fullscreen().map_err(|error| error.to_string())? {
        return Ok(false);
    }

    window.start_dragging().map_err(|error| error.to_string())?;
    Ok(true)
}

/// Creates the main window at app start — unless the app was started at login in menu-bar mode,
/// which has no window until the tray's Open asks for one.
#[cfg(desktop)]
pub fn register(app: &mut App) -> tauri::Result<()> {
    app.manage(DesktopGlassRuntime(Mutex::new(DesktopGlassRuntimeInner {
        request: DesktopGlassMaterialRequest {
            enabled: false,
            blur: DesktopGlassBlur::Off,
        },
        applied_blur: None,
        payload: DesktopGlassStatePayload {
            supported: false,
            material_live: false,
            reduce_transparency: false,
            high_contrast: false,
            window_active: false,
        },
    })));
    register_glass_accessibility(app);
    if crate::menu_bar::launched_in_menu_bar_mode(app.handle()) {
        return Ok(());
    }
    create_main_window(app.handle())?;
    Ok(())
}

#[cfg(desktop)]
fn configure_main_window(app: &tauri::AppHandle, window: &WebviewWindow) {
    // New native windows have no effect yet; retain the last request across recreation.
    if let Ok(mut inner) = app.state::<DesktopGlassRuntime>().0.lock() {
        inner.applied_blur = None;
        inner.payload.material_live = false;
    }
    request_refresh_desktop_glass(app);
    let glass_handle = app.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::Focused(_) | WindowEvent::ThemeChanged(_)
        ) {
            request_refresh_desktop_glass(&glass_handle);
        }
    });
    let policy = resolve_desktop_window_chrome_runtime_policy(
        window.label(),
        resolve_current_desktop_window_platform(),
    );

    if let Err(error) = apply_desktop_window_chrome_runtime_policy(window, policy) {
        log::warn!("failed to apply main-window chrome policy: {error}");
    }

    if desktop_window_chrome_policy_supports_controls(policy) {
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
    fn glass_requires_supported_live_material_and_respects_reduce_transparency_and_focus() {
        let request = DesktopGlassMaterialRequest {
            enabled: true,
            blur: DesktopGlassBlur::Strong,
        };
        assert!(desktop_glass_material_requested(request, true, false, true));
        assert!(!desktop_glass_material_requested(
            request, false, false, true
        ));
        assert!(!desktop_glass_material_requested(request, true, true, true));
        assert!(!desktop_glass_material_requested(
            request, true, false, false
        ));
        assert!(!desktop_glass_material_requested(
            DesktopGlassMaterialRequest {
                enabled: false,
                ..request
            },
            true,
            false,
            true
        ));
        // Off removes blur, not the transparent window backing requested by Custom.
        assert!(desktop_glass_material_requested(
            DesktopGlassMaterialRequest {
                blur: DesktopGlassBlur::Off,
                ..request
            },
            true,
            false,
            true
        ));
    }

    #[test]
    fn glass_state_serializes_native_outcome_and_diagnostic_flags() {
        let payload = DesktopGlassStatePayload {
            supported: true,
            material_live: false,
            reduce_transparency: false,
            high_contrast: true,
            window_active: true,
        };
        assert_eq!(
            serde_json::to_value(payload).unwrap(),
            serde_json::json!({
                "supported": true, "materialLive": false, "reduceTransparency": false,
                "highContrast": true, "windowActive": true
            })
        );
    }

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
            serde_json::to_value(build_desktop_window_state_payload(true, false))
                .expect("payload should serialize"),
            serde_json::json!({
                "isMaximized": true,
                "isFullscreen": false,
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
            true,
        );

        assert_eq!(payload, build_desktop_window_state_payload(false, true));
    }

    #[test]
    fn custom_controls_preserve_maximized_state() {
        let payload = resolve_desktop_window_state_payload_for_policy(
            resolve_desktop_window_chrome_runtime_policy(
                MAIN_WINDOW_LABEL,
                DesktopWindowPlatform::Windows,
            ),
            true,
            false,
        );

        assert_eq!(payload, build_desktop_window_state_payload(true, false));
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
