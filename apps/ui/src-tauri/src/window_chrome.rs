#[cfg(desktop)]
#[path = "window_chrome_preferences.rs"]
mod preferences;

#[cfg(desktop)]
#[path = "window_chrome_presentation.rs"]
mod presentation;

#[cfg(desktop)]
#[derive(Default)]
struct MainWindowPresentationState(Mutex<presentation::MainWindowPresentation>);

#[cfg(desktop)]
struct DesktopWindowChromeState(std::sync::Mutex<preferences::WindowChromePreferences>);

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

/// Floating panels show the main window's material behind their one rounded card.
#[cfg(desktop)]
fn is_glass_panel_window(label: &str) -> bool {
    crate::desktop_window::is_capture_window(label) || label == crate::desktop_window::ACTIVITY_WINDOW_LABEL
}

/// Where a panel's material stands when it does not fill the window (the notch's island), in window
/// points from the top-left. A side running past the window reads square: only free corners round.
#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct DesktopGlassPanelFrame {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

/// The native material a window currently carries; a panel's is clipped to its card's corners.
#[cfg(desktop)]
#[derive(Clone, Copy, Debug, PartialEq)]
struct DesktopGlassApplied {
    blur: DesktopGlassBlur,
    radius: Option<f64>,
    frame: Option<DesktopGlassPanelFrame>,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopGlassStatePayload {
    pub supported: bool,
    /// Native transparent backing is live, including enabled material with blur Off.
    pub material_live: bool,
    pub reduce_transparency: bool,
    pub high_contrast: bool,
    pub window_active: bool,
}

/// What a webview reads: the native outcome and, for panels, the main window's glass settings,
/// which panels cannot read from the Account themselves.
#[cfg(desktop)]
#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DesktopGlassStateView {
    #[serde(flatten)]
    pub state: DesktopGlassStatePayload,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub settings: Option<serde_json::Value>,
}

#[cfg(desktop)]
struct DesktopGlassRuntime(Mutex<DesktopGlassRuntimeInner>);

#[cfg(desktop)]
struct DesktopGlassRuntimeInner {
    /// The main window's request; every glass window follows it.
    request: DesktopGlassMaterialRequest,
    settings: Option<serde_json::Value>,
    windows: std::collections::HashMap<String, DesktopGlassWindow>,
}

#[cfg(desktop)]
#[derive(Default)]
struct DesktopGlassWindow {
    /// A panel's resting card radius while the card fills the window; None while it moves.
    panel_radius: Option<f64>,
    panel_frame: Option<DesktopGlassPanelFrame>,
    applied: Option<DesktopGlassApplied>,
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
fn glass_platform_supported(window: &WebviewWindow, panel: bool) -> bool {
    #[cfg(target_os = "macos")]
    {
        let _ = (window, panel);
        true
    }
    // DWM's backdrop fills the whole window rectangle and cannot follow a panel card's corners.
    #[cfg(target_os = "windows")]
    {
        !panel && read_windows_backdrop(window).is_ok()
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (window, panel);
        false
    }
}

#[cfg(target_os = "macos")]
fn apply_native_glass(
    window: &WebviewWindow,
    applied: Option<DesktopGlassApplied>,
    panel: bool,
) -> Result<(), String> {
    use window_vibrancy::{NSVisualEffectMaterial as Material, NSVisualEffectState};
    let blur = applied.map(|applied| applied.blur);
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
    // A floating panel never becomes the key window, so its material stays active.
    window_vibrancy::apply_vibrancy(
        window,
        material,
        Some(if panel { NSVisualEffectState::Active } else { NSVisualEffectState::FollowsWindowActiveState }),
        applied.and_then(|applied| applied.radius),
    )
    .map_err(|error| error.to_string())?;
    if let Some(frame) = applied.and_then(|applied| applied.frame) {
        place_native_glass_view(window, frame)?;
    }
    Ok(())
}

/// The view `apply_vibrancy` added under the webview, with the content view it stands in.
#[cfg(target_os = "macos")]
fn with_native_glass_view(
    window: &WebviewWindow,
    action: impl FnOnce(&objc2::runtime::AnyObject, &objc2_app_kit::NSView),
) -> Result<(), String> {
    use objc2::{msg_send, rc::Retained, runtime::{AnyClass, AnyObject, Bool}};
    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    let native: &objc2_app_kit::NSWindow = unsafe { &*pointer.cast() };
    let content = native.contentView().ok_or("Glass content view unavailable")?;
    let class = AnyClass::get(c"NSVisualEffectView").ok_or("AppKit visual effect views unavailable")?;
    let subviews: Retained<objc2_foundation::NSArray<AnyObject>> = unsafe { msg_send![&*content, subviews] };
    for view in subviews.iter() {
        let matches: Bool = unsafe { msg_send![&*view, isKindOfClass: class] };
        if matches.as_bool() {
            action(&view, &content);
            break;
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn place_native_glass_view(window: &WebviewWindow, frame: DesktopGlassPanelFrame) -> Result<(), String> {
    use objc2::{msg_send, runtime::Bool};
    use objc2_foundation::{NSPoint, NSRect, NSSize};
    with_native_glass_view(window, |view, content| {
        let flipped: Bool = unsafe { msg_send![content, isFlipped] };
        let (x, y, width, height) = desktop_glass_view_rect(frame, content.frame().size.height, flipped.as_bool());
        unsafe {
            let _: () = msg_send![view, setAutoresizingMask: 0usize];
            let _: () = msg_send![view, setFrame: NSRect::new(NSPoint::new(x, y), NSSize::new(width, height))];
        }
    })
}

#[cfg(target_os = "macos")]
fn show_native_glass_view(window: &WebviewWindow, shown: bool) -> Result<(), String> {
    with_native_glass_view(window, |view, _| unsafe {
        let _: () = objc2::msg_send![view, setHidden: !shown];
    })
}

/// Only macOS panels take material (`glass_platform_supported`).
#[cfg(all(desktop, not(target_os = "macos")))]
fn show_native_glass_view(_window: &WebviewWindow, _shown: bool) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn apply_native_glass(
    window: &WebviewWindow,
    applied: Option<DesktopGlassApplied>,
    _panel: bool,
) -> Result<(), String> {
    let blur = applied.map(|applied| applied.blur);
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
    _applied: Option<DesktopGlassApplied>,
    _panel: bool,
) -> Result<(), String> {
    Ok(())
}

/// The event a window's renderer subscribes to; panels get their own so the main window's
/// broadcast never reaches them.
#[cfg(desktop)]
fn desktop_glass_state_event(label: &str) -> String {
    if is_glass_panel_window(label) {
        format!("{DESKTOP_GLASS_STATE_EVENT}/{label}")
    } else {
        DESKTOP_GLASS_STATE_EVENT.to_string()
    }
}

#[cfg(desktop)]
fn refresh_desktop_glass(window: &WebviewWindow, announce: bool) -> Result<DesktopGlassStateView, String> {
    let label = window.label().to_string();
    let panel = is_glass_panel_window(&label);
    let state = window.app_handle().state::<DesktopGlassRuntime>();
    let mut guard = state.0.lock().map_err(|error| error.to_string())?;
    let inner = &mut *guard;
    let entry = inner.windows.entry(label.clone()).or_default();
    let previous = entry.payload;
    let accessibility = read_glass_accessibility();
    let supported = accessibility.is_ok() && glass_platform_supported(window, panel);
    let (reduce_transparency, high_contrast) = accessibility.unwrap_or_else(|error| {
        log::warn!("failed to read desktop glass accessibility: {error}");
        (previous.reduce_transparency, previous.high_contrast)
    });
    // A floating panel has no inactive appearance; it shows material only while its card fills it.
    let window_active = panel || window.is_focused().unwrap_or(false);
    let shaped = !panel || entry.panel_radius.is_some();
    let wants_material = shaped && desktop_glass_material_requested(
        inner.request,
        supported,
        reduce_transparency,
        window_active,
    );
    let desired = wants_material.then_some(DesktopGlassApplied {
        blur: inner.request.blur,
        radius: entry.panel_radius,
        frame: entry.panel_frame,
    });
    let mut material_live = entry.applied.is_some();
    if desired != entry.applied {
        // A panel's window stays transparent (`configure_floating_surface`); only the main window
        // swaps its backing colour with its material.
        let result = if desired.is_some() {
            (if panel { Ok(()) } else {
                window
                    .set_background_color(Some(tauri::window::Color(0, 0, 0, 0)))
                    .map_err(|error| error.to_string())
            })
            .and_then(|_| apply_native_glass(window, desired, panel))
        } else {
            apply_native_glass(window, None, panel).and_then(|_| if panel { Ok(()) } else {
                window
                    .set_background_color(None)
                    .map_err(|error| error.to_string())
            })
        };
        match result {
            Ok(()) => {
                entry.applied = desired;
                material_live = desired.is_some();
            }
            Err(error) => {
                log::warn!("failed to apply desktop glass material: {error}");
                let _ = apply_native_glass(window, None, panel);
                if !panel {
                    let _ = window.set_background_color(None);
                }
                entry.applied = None;
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
    entry.payload = payload;
    let view = DesktopGlassStateView {
        state: payload,
        settings: if panel { inner.settings.clone() } else { None },
    };
    drop(guard);
    if payload != previous || announce {
        let _ = window.emit(&desktop_glass_state_event(&label), view.clone());
    }
    Ok(view)
}

/// Re-applies every glass window: the main window and the panels that follow it.
#[cfg(desktop)]
fn refresh_all_desktop_glass(app: &tauri::AppHandle, announce_panels: bool) {
    for (label, window) in app.webview_windows() {
        if label == MAIN_WINDOW_LABEL || crate::desktop_window::is_app_window(&label)
            || (is_glass_panel_window(&label) && window.is_visible().unwrap_or(false)) {
            let announce = announce_panels && is_glass_panel_window(&label);
            if let Err(error) = refresh_desktop_glass(&window, announce) {
                log::warn!("failed to refresh desktop glass: {error}");
            }
        }
    }
}

#[cfg(desktop)]
fn request_refresh_desktop_glass(app: &tauri::AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || refresh_all_desktop_glass(&handle, false));
}

/// A panel reports its card's radius once the card fills the window, and None when it starts to move.
/// Must run on the native main thread (synchronous commands do).
#[cfg(desktop)]
pub(crate) fn set_desktop_glass_panel_shape(window: &WebviewWindow, radius: Option<f64>) -> Result<(), String> {
    set_desktop_glass_panel_placement(window, radius, None)
}

/// A panel placed by frame (the notch's island) moves far more often than it changes material, and its
/// webview's coat follows `material_live`. So while it moves the view only hides: nothing is torn down
/// and no state event re-renders the panel.
#[cfg(desktop)]
fn set_desktop_glass_panel_placement(
    window: &WebviewWindow,
    radius: Option<f64>,
    frame: Option<DesktopGlassPanelFrame>,
) -> Result<(), String> {
    if !is_glass_panel_window(window.label()) {
        return Err("window is not a glass panel".into());
    }
    let radius = radius.filter(|radius| radius.is_finite() && *radius >= 0.0);
    let frame = frame.filter(|frame| [frame.x, frame.y, frame.width, frame.height].iter().all(|value| value.is_finite()));
    {
        let state = window.app_handle().state::<DesktopGlassRuntime>();
        let mut guard = state.0.lock().map_err(|error| error.to_string())?;
        let entry = guard.windows.entry(window.label().to_string()).or_default();
        if radius.is_none() && entry.panel_frame.is_some() {
            drop(guard);
            return show_native_glass_view(window, false);
        }
        entry.panel_radius = radius;
        entry.panel_frame = frame;
    }
    refresh_desktop_glass(window, false)?;
    show_native_glass_view(window, true)
}

/// A frame in AppKit's coordinates for a content view of `content_height`.
#[cfg(any(target_os = "macos", test))]
fn desktop_glass_view_rect(frame: DesktopGlassPanelFrame, content_height: f64, flipped: bool) -> (f64, f64, f64, f64) {
    let y = if flipped { frame.y } else { content_height - frame.y - frame.height };
    (frame.x, y, frame.width, frame.height)
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
    request: Option<(DesktopGlassMaterialRequest, Option<serde_json::Value>)>,
) -> Result<DesktopGlassStateView, String> {
    let panel = is_glass_panel_window(window.label());
    if window.label() != MAIN_WINDOW_LABEL && !crate::desktop_window::is_app_window(window.label()) && !(panel && request.is_none()) {
        return Err("window material belongs to the main window".into());
    }
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = window.clone();
    window
        .run_on_main_thread(move || {
            let result = (|| {
                let Some((request, settings)) = request else {
                    return refresh_desktop_glass(&handle, false);
                };
                {
                    let state = handle.app_handle().state::<DesktopGlassRuntime>();
                    let mut inner = state.0.lock().map_err(|error| error.to_string())?;
                    inner.request = request;
                    inner.settings = settings;
                }
                let view = refresh_desktop_glass(&handle, false);
                // Open panels follow the new settings live.
                for (label, panel) in handle.app_handle().webview_windows() {
                    if label != handle.label() && (label == MAIN_WINDOW_LABEL || crate::desktop_window::is_app_window(&label)
                        || (is_glass_panel_window(&label) && panel.is_visible().unwrap_or(false))) {
                        if let Err(error) = refresh_desktop_glass(&panel, true) {
                            log::warn!("failed to refresh panel glass: {error}");
                        }
                    }
                }
                view
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
) -> Result<DesktopGlassStateView, String> {
    update_desktop_glass(window, None).await
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_apply_glass_material(
    window: WebviewWindow,
    enabled: bool,
    blur: DesktopGlassBlur,
    settings: Option<serde_json::Value>,
) -> Result<DesktopGlassStateView, String> {
    update_desktop_glass(window, Some((DesktopGlassMaterialRequest { enabled, blur }, settings))).await
}

/// Clears a panel's material while its card moves; resting shapes arrive with the frame that fits them.
#[cfg(desktop)]
#[tauri::command]
pub fn desktop_set_glass_panel_shape(
    window: WebviewWindow,
    radius: Option<f64>,
    frame: Option<DesktopGlassPanelFrame>,
) -> Result<(), String> {
    set_desktop_glass_panel_placement(&window, radius, frame)
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
    pub is_fullscreen: bool,
}

#[cfg(desktop)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DesktopWindowCloseStrategy {
    Hide,
    Return,
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
    if crate::desktop_window::is_capture_window(window_label) || crate::desktop_window::is_app_window(window_label) {
        return DesktopWindowChromeRuntimePolicy {
            strategy: DesktopWindowChromeStrategy::CustomControls,
            use_window_decorations: false,
            title_bar_style: None,
            hide_native_title: false,
        };
    }
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
    if crate::desktop_window::is_app_window(window_label) {
        return DesktopWindowCloseStrategy::Return;
    }

    DesktopWindowCloseStrategy::Close
}

#[cfg(desktop)]
fn chrome_policy_label(label: &str, full_chrome: bool) -> &str {
    if full_chrome { MAIN_WINDOW_LABEL } else { label }
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
        chrome_policy_label(label, crate::app_window::uses_full_chrome(app, label)),
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
    let policy = resolve_window_chrome_policy(window.app_handle(), window.label());
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
    let policy = resolve_window_chrome_policy(window.app_handle(), window.label());
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
            let window = create_main_window(
                app,
                crate::window_sizing::InitialWindowVisibility::Visible,
            )?;
            crate::menu_bar::leave(app);
            window
        }
    };
    if !app.state::<MainWindowPresentationState>().0.lock().unwrap().request_show() {
        return Ok(());
    }
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
    if app.get_webview_window(MAIN_WINDOW_LABEL).is_some() {
        show_main_window(app)?;
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
pub(crate) fn create_main_window(
    app: &tauri::AppHandle,
    initial_visibility: crate::window_sizing::InitialWindowVisibility,
) -> tauri::Result<WebviewWindow> {
    {
        let state = app.state::<MainWindowPresentationState>();
        let mut presentation = state.0.lock().unwrap();
        *presentation = presentation::MainWindowPresentation::default();
        if initial_visibility == crate::window_sizing::InitialWindowVisibility::Visible {
            presentation.request_show();
        }
    }
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
    let policy = resolve_window_chrome_policy(app, MAIN_WINDOW_LABEL);
    let window = tauri::WebviewWindowBuilder::from_config(app, &config)?
        .visible(false)
        .decorations(policy.use_window_decorations)
        .on_page_load(|window, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Started {
                window.app_handle().state::<MainWindowPresentationState>().0.lock().unwrap()
                    .loading(window.is_visible().unwrap_or(false));
                if let Err(error) = window.hide() {
                    log::warn!("failed to hide loading main window: {error}");
                }
            }
        })
        .build()?;
    configure_main_window(app, &window);
    crate::window_sizing::configure_main_window(app, &window, crate::window_sizing::InitialWindowVisibility::Hidden)?;
    Ok(window)
}

/// The main shell (or its recovery screen) acknowledges its first nonempty committed layout.
#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_main_window_content_rendered(window: Window) -> Result<bool, String> {
    if window.label() != MAIN_WINDOW_LABEL {
        return Err("main window content acknowledgement requires the main caller".into());
    }
    let reveal = window.state::<MainWindowPresentationState>().0.lock()
        .map_err(|error| error.to_string())?.content_rendered();
    if reveal {
        show_main_window(window.app_handle()).map_err(|error| error.to_string())?;
    }
    Ok(reveal)
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_get_window_chrome_policy(
    window: Window,
) -> Result<DesktopWindowChromePolicyPayload, String> {
    let state = window.state::<DesktopWindowChromeState>();
    let preferences = state.0.lock().map_err(|error| error.to_string())?;
    Ok(window_chrome_policy_payload(chrome_policy_label(window.label(), crate::app_window::uses_full_chrome(window.app_handle(), window.label())), &preferences))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_get_window_state(window: Window) -> Result<DesktopWindowStatePayload, String> {
    Ok(resolve_desktop_window_state_payload_for_window(&window))
}

#[cfg(desktop)]
#[tauri::command]
pub async fn desktop_set_window_title(window: Window, title: String) -> Result<(), String> {
    window.set_title(&title).map_err(|error| error.to_string())
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
        DesktopWindowCloseStrategy::Return => {
            crate::app_window::request_return(window.app_handle(), window.label())?;
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
    if !crate::desktop_window::window_allows_dragging(window.label()) {
        return Ok(false);
    }
    if window.is_fullscreen().map_err(|error| error.to_string())? {
        return Ok(false);
    }

    #[cfg(target_os = "macos")]
    { crate::desktop_panel::start_window_dragging(&window) }
    #[cfg(not(target_os = "macos"))]
    {
        window.start_dragging().map_err(|error| error.to_string())?;
        Ok(true)
    }
}

/// Creates the main window at app start — unless the app was started at login in menu-bar mode,
/// which has no window until the tray's Open asks for one.
#[cfg(desktop)]
pub fn register(app: &mut App) -> tauri::Result<()> {
    let preferences = if resolve_current_desktop_window_platform() == DesktopWindowPlatform::Windows
    {
        preferences::WindowChromePreferences::load(
            app.path()
                .app_config_dir()
                .ok()
                .map(|directory| directory.join("window-state/main-window-chrome.json")),
        )
    } else {
        preferences::WindowChromePreferences::default()
    };
    app.manage(DesktopWindowChromeState(std::sync::Mutex::new(preferences)));
    app.manage(MainWindowPresentationState::default());
    app.manage(DesktopGlassRuntime(Mutex::new(DesktopGlassRuntimeInner {
        request: DesktopGlassMaterialRequest {
            enabled: false,
            blur: DesktopGlassBlur::Off,
        },
        settings: None,
        windows: std::collections::HashMap::new(),
    })));
    register_glass_accessibility(app);
    if crate::menu_bar::launched_in_menu_bar_mode(app.handle())
        || crate::capture::triggers::cold_launch_is_capture_only(app.handle()) {
        return Ok(());
    }
    create_main_window(
        app.handle(),
        crate::window_sizing::InitialWindowVisibility::Visible,
    )?;
    Ok(())
}

#[cfg(desktop)]
fn configure_main_window(app: &tauri::AppHandle, window: &WebviewWindow) {
    // New native windows have no effect yet; retain the last request across recreation.
    if let Ok(mut inner) = app.state::<DesktopGlassRuntime>().0.lock() {
        inner.windows.remove(MAIN_WINDOW_LABEL);
    }
    request_refresh_desktop_glass(app);
    let glass_handle = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(focused) = event {
            crate::app_window::note_window_focus(&glass_handle, MAIN_WINDOW_LABEL, *focused);
        }
        if matches!(event, WindowEvent::Destroyed) {
            crate::app_window::retire_live_window(&glass_handle, MAIN_WINDOW_LABEL);
        }
        if matches!(
            event,
            WindowEvent::Focused(_) | WindowEvent::ThemeChanged(_)
        ) {
            request_refresh_desktop_glass(&glass_handle);
        }
    });
    let policy = resolve_window_chrome_policy(window.app_handle(), window.label());

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

/// App-window controls share the existing chrome policy and close owner.
#[cfg(desktop)]
pub(crate) fn configure_app_window(window: &WebviewWindow) {
    let policy = resolve_window_chrome_policy(window.app_handle(), window.label());
    if let Err(error) = apply_desktop_window_chrome_runtime_policy(window, policy) {
        log::warn!("failed to apply app-window chrome policy: {error}");
    }
    let retained = window.clone();
    window.on_window_event(move |event| {
        match event {
            WindowEvent::Destroyed => {
                if let Ok(mut inner) = retained.app_handle().state::<DesktopGlassRuntime>().0.lock() {
                    inner.windows.remove(retained.label());
                }
            }
            WindowEvent::Focused(_) | WindowEvent::ThemeChanged(_) => request_refresh_desktop_glass(retained.app_handle()),
            WindowEvent::CloseRequested { api, .. } => {
                if matches!(resolve_desktop_window_close_strategy(retained.label()), DesktopWindowCloseStrategy::Return) {
                    api.prevent_close();
                    if let Err(error) = crate::app_window::request_return(retained.app_handle(), retained.label()) {
                        log::warn!("failed to return the app window: {error}");
                    }
                }
            }
            WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => emit_desktop_window_state(&retained),
            _ => {}
        }
    });
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
    fn glass_frame_converts_to_appkit_coordinates_from_the_window_top_left() {
        let frame = DesktopGlassPanelFrame { x: -18., y: 8., width: 482., height: 300. };
        assert_eq!(desktop_glass_view_rect(frame, 316., false), (-18., 8., 482., 300.));
        assert_eq!(desktop_glass_view_rect(DesktopGlassPanelFrame { x: 8., y: -18., width: 464., height: 318. }, 300., false),
            (8., 0., 464., 318.));
        assert_eq!(desktop_glass_view_rect(frame, 316., true), (-18., 8., 482., 300.));
    }

    #[test]
    fn capture_panel_follows_main_glass_on_its_own_event_with_projected_settings() {
        assert!(is_glass_panel_window(crate::desktop_window::CAPTURE_WINDOW_LABEL));
        assert!(is_glass_panel_window("capture_42"));
        assert!(!is_glass_panel_window(MAIN_WINDOW_LABEL));
        assert!(!is_glass_panel_window("capture_selection_1"));
        assert_eq!(desktop_glass_state_event(MAIN_WINDOW_LABEL), "desktopGlass://state");
        assert_eq!(desktop_glass_state_event("capture"), "desktopGlass://state/capture");
        assert!(is_glass_panel_window(crate::desktop_window::ACTIVITY_WINDOW_LABEL));
        assert_eq!(desktop_glass_state_event("activity_overlay"), "desktopGlass://state/activity_overlay");
        let view = DesktopGlassStateView {
            state: DesktopGlassStatePayload { supported: true, material_live: true, window_active: true, ..Default::default() },
            settings: Some(serde_json::json!({ "glassBlurEnabled": true })),
        };
        assert_eq!(serde_json::to_value(&view).unwrap(), serde_json::json!({
            "supported": true, "materialLive": true, "reduceTransparency": false, "highContrast": false,
            "windowActive": true, "settings": { "glassBlurEnabled": true },
        }));
        let main = DesktopGlassStateView { settings: None, ..view };
        assert!(serde_json::to_value(&main).unwrap().get("settings").is_none());
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
    fn capture_always_reports_its_borderless_custom_chrome_independent_of_main_preferences() {
        for platform in [DesktopWindowPlatform::MacOs, DesktopWindowPlatform::Windows, DesktopWindowPlatform::Linux] {
            for native_preference in [true, false] {
                let policy = resolve_desktop_window_chrome_runtime_policy(
                    crate::desktop_window::CAPTURE_WINDOW_LABEL, platform, native_preference);
                assert_eq!(resolve_desktop_window_chrome_runtime_policy("capture_42", platform, native_preference), policy);
                assert_eq!(policy.strategy, DesktopWindowChromeStrategy::CustomControls);
                assert!(!policy.use_window_decorations);
                assert_eq!(policy.title_bar_style, None);
                assert!(!policy.hide_native_title);
            }
        }
    }

    #[test]
    fn main_window_hides_instead_of_closing() {
        assert_eq!(
            resolve_desktop_window_close_strategy(MAIN_WINDOW_LABEL),
            DesktopWindowCloseStrategy::Hide
        );
    }

    #[test]
    fn full_extras_share_main_platform_chrome_but_keep_guarded_close() {
        for platform in [DesktopWindowPlatform::MacOs, DesktopWindowPlatform::Windows, DesktopWindowPlatform::Linux] {
            for preference in [true, false] {
                let full = resolve_desktop_window_chrome_runtime_policy(chrome_policy_label("destination_full", true), platform, preference);
                assert_eq!(full, resolve_desktop_window_chrome_runtime_policy(MAIN_WINDOW_LABEL, platform, preference));
                let destination = resolve_desktop_window_chrome_runtime_policy(chrome_policy_label("destination_detached", false), platform, preference);
                assert_eq!(destination.strategy, DesktopWindowChromeStrategy::CustomControls);
                assert!(!destination.use_window_decorations);
            }
        }
        assert_eq!(resolve_desktop_window_close_strategy("destination_full"), DesktopWindowCloseStrategy::Return);
        assert_eq!(resolve_desktop_window_close_strategy("destination_detached"), DesktopWindowCloseStrategy::Return);
        assert_eq!(resolve_desktop_window_close_strategy(MAIN_WINDOW_LABEL), DesktopWindowCloseStrategy::Hide);
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
                false,
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
