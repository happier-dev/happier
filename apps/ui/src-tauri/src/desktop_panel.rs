//! Shared Tauri panel mechanics. Callers own placement, level and input policy.
/// Floating cards own their rounded paint and elevation in the renderer. Clear both the window
/// and webview backing (including WebKit's under-page colour), and avoid a rectangular OS shadow.
pub(crate) fn configure_floating_surface<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    let background = tauri::window::Color(0, 0, 0, 0);
    #[cfg(target_os = "linux")]
    let background = {
        use gtk::prelude::*;
        let native_window = window.clone();
        run_on_main_thread(window.app_handle(), move || {
            let native = native_window.gtk_window().map_err(|error| error.to_string())?;
            if gtk::prelude::GtkWindowExt::screen(&native).is_some_and(|screen| screen.is_composited()) { return Ok(background); }
            // Without a compositor, alpha cannot reveal the desktop. Use the platform's own
            // opaque surface colour for square corners rather than WebKit's default white.
            let style = native.style_context();
            let color = match style.lookup_color("theme_bg_color") {
                Some(color) => color,
                None => style.style_property_for_state("background-color", gtk::StateFlags::NORMAL)
                    .get::<gtk::gdk::RGBA>().map_err(|error| error.to_string())?,
            };
            Ok::<_, String>(tauri::window::Color((color.red() * 255.) as u8,
                (color.green() * 255.) as u8, (color.blue() * 255.) as u8, 255))
        }, "Floating surface background did not return")??
    };
    window.set_background_color(Some(background))
        .map_err(|error| error.to_string())?;
    window.set_shadow(false).map_err(|error| error.to_string())
}

/// Let WebKit load and paint an ordered capture host without exposing its initial page.
pub(crate) fn prepare_first_paint<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    configure_floating_surface(window)?;
    #[cfg(target_os = "macos")]
    {
        let app = window.app_handle().clone();
        let window = window.clone();
        run_on_main_thread(&app, move || {
            let pointer = window.ns_window().map_err(|error| error.to_string())?;
            let native: &objc2_app_kit::NSWindow = unsafe { &*pointer.cast() };
            native.setAlphaValue(0.);
            Ok::<_, String>(())
        }, "Capture first paint preparation did not return")??;
    }
    Ok(())
}

/// The route acknowledges a painted transparent frame, rather than guessing a load delay.
pub(crate) fn reveal_after_paint<R: tauri::Runtime>(window: &tauri::WebviewWindow<R>) -> Result<(), String> {
    configure_floating_surface(window)?;
    #[cfg(target_os = "macos")]
    {
        let app = window.app_handle().clone();
        let window = window.clone();
        run_on_main_thread(&app, move || {
            let pointer = window.ns_window().map_err(|error| error.to_string())?;
            let native: &objc2_app_kit::NSWindow = unsafe { &*pointer.cast() };
            native.setAlphaValue(1.);
            Ok::<_, String>(())
        }, "Capture first paint acknowledgement did not return")??;
    }
    Ok(())
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
use tauri::{AppHandle, Manager, Runtime};
#[cfg(target_os = "macos")]
use tauri::WebviewWindow;
#[cfg(target_os = "macos")]
use tauri_nspanel::{tauri_panel, CollectionBehavior, ManagerExt, StyleMask, WebviewWindowExt};

#[cfg(target_os = "macos")]
tauri_panel! {
    panel!(DesktopPanel {
        config: {
            can_become_main_window: false,
            hides_on_deactivate: false
        }
    })
}

#[cfg(target_os = "macos")]
pub(crate) struct PanelOptions {
    pub shadow: bool,
    pub opaque: bool,
    pub movable: bool,
    pub movable_by_window_background: bool,
    pub accepts_mouse_moved_events: bool,
    pub ignores_mouse_events: bool,
    pub nonactivating: bool,
    pub keyboard_on_request: bool,
    pub level: Option<i64>,
    pub collection_behavior: CollectionBehavior,
}

/// The retained Capture host alternates between editors, permission recovery and controls.
#[cfg(target_os = "macos")]
pub(crate) fn configure_capture_panel<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<(), String> {
    apply(window, PanelOptions {
        shadow: false, opaque: false, movable: true, movable_by_window_background: false,
        // Keep the panel's input policy stable across editor/control reuse. An editor's
        // explicit focus request is separate from whether a mouse click activates the app.
        accepts_mouse_moved_events: true, ignores_mouse_events: false, nonactivating: true,
        keyboard_on_request: false,
        level: Some(objc2_app_kit::NSFloatingWindowLevel as i64), collection_behavior: CollectionBehavior::new()
            .can_join_all_spaces().full_screen_auxiliary(),
    })?;
    let app = window.app_handle().clone();
    let window = window.clone();
    run_on_main_thread(&app, move || {
        let panel = ensure_panel(&window)?;
        // WKWebView must receive the first mouse-down on an inactive control. Its ordinary
        // NSView does not opt in through needsPanelToBecomeKey; nonactivation is owned by
        // the WindowServer tag, independently of this panel's keyboard eligibility.
        panel.as_panel().setBecomesKeyOnlyIfNeeded(false);
        panel.as_panel().setSharingType(objc2_app_kit::NSWindowSharingType::None);
        Ok(())
    }, "Capture panel protection did not return")?
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
pub(crate) fn run_on_main_thread<R: Runtime, T: Send + 'static>(
    app: &AppHandle<R>,
    task: impl FnOnce() -> T + Send + 'static,
    completion_error: &'static str,
) -> Result<T, String> {
    #[cfg(target_os = "macos")]
    let on_main = objc2::MainThreadMarker::new().is_some();
    #[cfg(target_os = "linux")]
    let on_main = gtk::is_initialized_main_thread();
    if on_main {
        return Ok(task());
    }
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(task());
    })
    .map_err(|error| error.to_string())?;
    rx.recv().map_err(|_| completion_error.to_string())
}

#[cfg(target_os = "macos")]
pub(crate) fn apply<R: Runtime>(
    window: &WebviewWindow<R>,
    options: PanelOptions,
) -> Result<(), String> {
    let app = window.app_handle().clone();
    let window = window.clone();
    run_on_main_thread(
        &app,
        move || {
            let pointer = window.ns_window().map_err(|error| error.to_string())?;
            // Conversion and floating-panel configuration can reset the existing Tauri level.
            // Preserve it unless the presentation owner explicitly supplies a different level.
            let native: &objc2_app_kit::NSWindow = unsafe { &*pointer.cast() };
            let level = options.level.unwrap_or(native.level() as i64);
            let panel = ensure_panel(&window)?;
            if options.keyboard_on_request { initialize_keyboard_request(panel.as_panel()); }
            configure_floating_surface(&window)?;
            panel.set_has_shadow(options.shadow);
            panel.set_opaque(options.opaque);
            panel.set_transparent(true);
            panel.set_hides_on_deactivate(false);
            panel.set_movable_by_window_background(options.movable_by_window_background);
            panel.set_becomes_key_only_if_needed(options.nonactivating);
            panel.set_floating_panel(level > objc2_app_kit::NSNormalWindowLevel as i64);
            panel.set_collection_behavior(options.collection_behavior.into());
            let style = StyleMask::empty().borderless();
            panel.set_style_mask(
                if options.nonactivating {
                    style.nonactivating_panel()
                } else {
                    style
                }
                .into(),
            );
            let native = panel.as_panel();
            // Class conversion skips NSPanel's initializer. The style flag alone does not
            // install WindowServer's activation-prevention tag. Keep its initializer effect
            // at the same owner as the style policy, before the panel can receive input.
            unsafe {
                if !native.respondsToSelector(objc2::sel!(_setPreventsActivation:)) {
                    return Err("AppKit panel activation policy is unavailable".to_owned());
                }
                let _: () = objc2::msg_send![native, _setPreventsActivation: options.nonactivating];
            }
            native.setMovable(options.movable);
            native.setAcceptsMouseMovedEvents(options.accepts_mouse_moved_events);
            native.setIgnoresMouseEvents(options.ignores_mouse_events);
            panel.set_level(level);
            Ok(())
        },
        "Panel host application did not return",
    )?
}

/// Called on main by panel configuration and positioning; conversion has one owner.
#[cfg(target_os = "macos")]
pub(crate) fn ensure_panel<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<tauri_nspanel::PanelHandle<R>, String> {
    static KEY_ELIGIBILITY: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();
    KEY_ELIGIBILITY.get_or_init(|| install_keyboard_eligibility_override(
        <RawDesktopPanel as objc2::ClassType>::class(),
    )).clone()?;
    if let Ok(panel) = window.app_handle().get_webview_panel(window.label()) {
        return Ok(panel);
    }
    let pointer = window.ns_window().map_err(|error| error.to_string())?;
    // WebKit observes the window through a KVO-generated subclass. The panel conversion changes
    // that class: detach its views under the original class, then register their observations anew.
    // Keep the content view itself attached: Tao's resize delegate requires it throughout.
    let native: &objc2_app_kit::NSWindow = unsafe { &*pointer.cast() };
    // Retire titlebar observations before replacing the KVO-generated window class, too.
    native.setStyleMask(objc2_app_kit::NSWindowStyleMask::Borderless);
    let content = native
        .contentView()
        .ok_or("Panel window has no content view")?;
    let views = content.subviews();
    for view in &views {
        view.removeFromSuperview();
    }
    let panel = window.to_panel::<DesktopPanel<R>>();
    for view in &views {
        content.addSubview(&view);
    }
    panel.map_err(|error| error.to_string())
}

#[cfg(target_os = "macos")]
static KEYBOARD_REQUEST: u8 = 0;

#[cfg(target_os = "macos")]
fn keyboard_request(window: &objc2::runtime::AnyObject) -> Option<bool> {
    // This private association is retained by the native window and accessed only on main.
    let value = unsafe { objc2::ffi::objc_getAssociatedObject(window, (&KEYBOARD_REQUEST as *const u8).cast()) };
    unsafe { value.cast::<objc2_foundation::NSNumber>().as_ref() }.map(|value| value.as_bool())
}

#[cfg(target_os = "macos")]
fn set_keyboard_eligibility(window: &objc2::runtime::AnyObject, wanted: bool) {
    let value = objc2_foundation::NSNumber::new_bool(wanted);
    // SAFETY: The association key is private, the NSNumber is retained until replacement/window
    // destruction, and conversion never changes the native object's allocation or layout.
    unsafe { objc2::ffi::objc_setAssociatedObject(
        window as *const _ as *mut _, (&KEYBOARD_REQUEST as *const u8).cast(),
        objc2::rc::Retained::as_ptr(&value).cast_mut().cast(), objc2::ffi::OBJC_ASSOCIATION_RETAIN_NONATOMIC,
    ); }
}

#[cfg(target_os = "macos")]
fn initialize_keyboard_request(window: &objc2::runtime::AnyObject) {
    if keyboard_request(window).is_none() { set_keyboard_eligibility(window, false); }
}

#[cfg(target_os = "macos")]
fn install_keyboard_eligibility_override(class: &objc2::runtime::AnyClass) -> Result<(), String> {
    use objc2::{Encode, runtime::{AnyObject, Bool}};
    let block = block2::RcBlock::new(|window: *mut AnyObject| -> Bool {
        // Capture hosts keep their existing eligibility; only request-driven panels opt out.
        Bool::new(keyboard_request(unsafe { &*window }).unwrap_or(true))
    });
    let encoding = std::ffi::CString::new(format!("{}@:", Bool::ENCODING)).unwrap();
    // SAFETY: libobjc copies the block and supplies the selector, giving AppKit's BOOL(id, SEL)
    // ABI. The macro leaves this method undeclared; the shared conversion owner installs it once.
    let installed = unsafe {
        let implementation = objc2::ffi::imp_implementationWithBlock(block2::RcBlock::as_ptr(&block).cast());
        let installed = objc2::ffi::class_addMethod(class as *const _ as *mut _,
            objc2::sel!(canBecomeKeyWindow), implementation, encoding.as_ptr()).as_bool();
        if !installed { objc2::ffi::imp_removeBlock(implementation); }
        installed
    };
    if installed { Ok(()) } else { Err("Panel keyboard eligibility could not be installed".to_owned()) }
}

#[cfg(target_os = "macos")]
fn apply_keyboard_request(window: &objc2::runtime::AnyObject, wanted: bool, mut native_key: impl FnMut(bool)) {
    if wanted { set_keyboard_eligibility(window, true); native_key(true); }
    else { native_key(false); set_keyboard_eligibility(window, false); }
}

/// The keyboard request is the sole writer of a request-driven panel's key eligibility.
#[cfg(target_os = "macos")]
pub(crate) fn set_keyboard_wanted(panel: &objc2_app_kit::NSPanel, wanted: bool) {
    initialize_keyboard_request(panel);
    panel.setBecomesKeyOnlyIfNeeded(true);
    apply_keyboard_request(panel, wanted, |wanted| {
        if wanted { panel.makeKeyWindow(); } else { panel.resignKeyWindow(); }
    });
}

/// Place converted panels synchronously before presentation. Tao's queued position/size setters
/// can otherwise constrain a newly key selector below the menu bar while resizing it.
#[cfg(target_os = "macos")]
pub(crate) fn set_content_frame<R: Runtime>(
    window: &WebviewWindow<R>,
    content_frame: objc2_foundation::NSRect,
) -> Result<objc2_foundation::NSRect, String> {
    let app = window.app_handle().clone();
    let window = window.clone();
    run_on_main_thread(&app, move || {
        let panel = ensure_panel(&window)?;
        let native = panel.as_panel();
        let frame = unsafe { objc2_app_kit::NSWindow::frameRectForContentRect_styleMask(
            content_frame, native.styleMask(), objc2::MainThreadMarker::new()
                .expect("panel placement runs on the main thread"),
        ) };
        native.setFrame_display(frame, false);
        Ok(native.frame())
    }, "Panel positioning did not return a native frame")?
}

#[cfg(target_os = "macos")]
pub(crate) fn window_drag_event(
    native: &objc2_app_kit::NSWindow,
    pending: Option<&objc2_app_kit::NSEvent>,
) -> Result<objc2::rc::Retained<objc2_app_kit::NSEvent>, String> {
    use objc2_app_kit::{NSEvent, NSEventType};
    // The DOM request arrives through an application event (windowNumber=0), or after
    // AppKit has cleared currentEvent. AppKit needs a mouse-down belonging to this panel,
    // with window-local coordinates, rather than the IPC event or a screen-space point.
    unsafe {
        NSEvent::mouseEventWithType_location_modifierFlags_timestamp_windowNumber_context_eventNumber_clickCount_pressure(
            NSEventType::LeftMouseDown, native.convertPointFromScreen(NSEvent::mouseLocation()),
            pending.map_or_else(|| NSEvent::modifierFlags_class(), |event| event.modifierFlags()),
            pending.map_or(0., |event| event.timestamp()), native.windowNumber(), None, 0, 1, 1.,
        ).ok_or_else(|| "AppKit did not create a window drag event".to_owned())
    }
}

/// Keep native dragging behind the existing desktop drag command.
#[cfg(target_os = "macos")]
pub(crate) fn start_window_dragging<R: Runtime>(window: &tauri::Window<R>) -> Result<bool, String> {
    if window.app_handle().get_webview_panel(window.label()).is_err() {
        window.start_dragging().map_err(|error| error.to_string())?;
        return Ok(true);
    }
    let app = window.app_handle().clone();
    let window = window.clone();
    run_on_main_thread(&app, move || {
        let marker = objc2::MainThreadMarker::new().expect("window drag runs on main");
        if unsafe { objc2_app_kit::NSEvent::pressedMouseButtons() } & 1 == 0 { return Ok(false); }
        let application = objc2_app_kit::NSApplication::sharedApplication(marker);
        let pending = application.currentEvent();
        let pointer = window.ns_window().map_err(|error| error.to_string())?;
        let native: &objc2_app_kit::NSWindow = unsafe { &*pointer.cast() };
        let event = window_drag_event(native, pending.as_deref())?;
        unsafe { native.performWindowDragWithEvent(&event); }
        Ok(true)
    }, "Native panel drag did not return")?
}

pub(crate) fn show_without_activation<R: tauri::Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let app = window.app_handle().clone();
        let window = window.clone();
        run_on_main_thread(
            &app,
            move || {
                let pointer = window.ns_window().map_err(|error| error.to_string())?;
                // SAFETY: Tauri owns this live window and this closure runs on main.
                let native: &objc2_app_kit::NSWindow = unsafe { &*pointer.cast() };
                unsafe {
                    let _: () = objc2::msg_send![native, orderFrontRegardless];
                }
                Ok(())
            },
            "Panel show did not return",
        )?
    }
    #[cfg(not(target_os = "macos"))]
    window.show().map_err(|error| error.to_string())
}

#[cfg(all(test, target_os = "macos"))]
mod keyboard_tests {
    use super::*;
    use objc2::{ClassType, msg_send, rc::Retained, runtime::{AnyObject, ClassBuilder}};
    use objc2_foundation::NSObject;

    #[test]
    fn keyboard_request_controls_only_its_panel_and_brackets_native_keyness() {
        // Foundation objects substitute the AppKit key effects; Objective-C eligibility
        // dispatch and per-window storage are the same as the converted panel's.
        let class = ClassBuilder::new(c"HappierPanelKeyboardEligibilityTest", NSObject::class()).unwrap().register();
        install_keyboard_eligibility_override(class).unwrap();
        let overlay: Retained<AnyObject> = unsafe { msg_send![class, new] };
        let capture: Retained<AnyObject> = unsafe { msg_send![class, new] };
        let eligible = |window: &AnyObject| -> bool { unsafe { msg_send![window, canBecomeKeyWindow] } };
        initialize_keyboard_request(&overlay);
        assert!(!eligible(&overlay), "row clicks must leave the editor's keyboard alone before a request");
        assert!(eligible(&capture), "capture hosts retain their existing key eligibility");
        for _ in 0..50 {
            apply_keyboard_request(&overlay, true, |make_key| {
                assert!(make_key);
                assert!(eligible(&overlay), "eligibility must precede makeKeyWindow");
            });
            initialize_keyboard_request(&overlay);
            assert!(eligible(&overlay), "host reconfiguration must preserve an active request");
            apply_keyboard_request(&overlay, false, |make_key| {
                assert!(!make_key);
                assert!(eligible(&overlay), "resign before disabling key eligibility");
            });
            assert!(!eligible(&overlay), "release disables future row-click keyness");
            assert!(eligible(&capture), "one window's request never changes another host");
        }
    }
}
