//! AppKit must run on the executable's main thread, so this test owns a real event loop.
#[cfg(target_os = "macos")]
#[path = "../src/desktop_panel.rs"]
mod desktop_panel;

// Read only this fixture's WindowServer state. A style-mask assertion alone cannot observe
// the activation tag that AppKit normally installs in NSPanel's initializer.
#[cfg(target_os = "macos")]
fn assert_prevents_activation(native: &objc2_app_kit::NSWindow) {
    #[link(name = "CoreGraphics", kind = "framework")]
    unsafe extern "C" {
        fn CGSMainConnectionID() -> i32;
        fn CGSGetWindowTags(connection: i32, window: u32, tags: *mut u32, bits: usize) -> i32;
    }
    let mut tags = [0_u32; 2];
    let result = unsafe { CGSGetWindowTags(CGSMainConnectionID(), native.windowNumber() as u32, tags.as_mut_ptr(), 64) };
    assert_eq!(result, 0, "read this fixture's native activation policy");
    println!("native activation: style={} prevents_activation={}",
        native.styleMask().contains(objc2_app_kit::NSWindowStyleMask::NonactivatingPanel), tags[0] & (1 << 16) != 0);
    assert_ne!(tags[0] & (1 << 16), 0,
        "class conversion must install NSPanel's WindowServer nonactivation policy before any selector mouse-down");
}

#[cfg(target_os = "macos")]
fn assert_transparent_backing(window: &tauri::WebviewWindow, phase: &'static str) {
    let pointer = window.ns_window().unwrap();
    let native: &objc2_app_kit::NSWindow = unsafe { &*pointer.cast() };
    let alpha: f64 = unsafe {
        let color: objc2::rc::Retained<objc2::runtime::AnyObject> = objc2::msg_send![native, backgroundColor];
        objc2::msg_send![&*color, alphaComponent]
    };
    println!("{phase}: opaque={} background_alpha={alpha} shadow={}", native.isOpaque(), native.hasShadow());
    assert!(!native.isOpaque(), "{phase}: native backing must stay transparent");
    assert_eq!(alpha, 0., "{phase}: native background must be clear");
    window.with_webview(move |webview| unsafe {
        let view: &objc2::runtime::AnyObject = &*webview.inner().cast();
        let draws: objc2::rc::Retained<objc2::runtime::AnyObject> = objc2::msg_send![view,
            valueForKey: &*objc2_foundation::NSString::from_str("drawsBackground")];
        let draws: bool = objc2::msg_send![&*draws, boolValue];
        let opaque: bool = objc2::msg_send![view, isOpaque];
        let color: objc2::rc::Retained<objc2::runtime::AnyObject> = objc2::msg_send![view, underPageBackgroundColor];
        let alpha: f64 = objc2::msg_send![&*color, alphaComponent];
        println!("{phase}: webview_draws_background={draws} webview_opaque={opaque} under_page_alpha={alpha}");
        assert!(!draws, "{phase}: WebKit must not paint a white backing");
        assert!(!opaque, "{phase}: WebKit must composite transparent pixels");
        if phase != "before conversion" {
            assert_eq!(alpha, 0., "{phase}: WebKit under-page background must be clear");
        }
    }).unwrap();
}

#[cfg(target_os = "macos")]
fn webkit_view(view: &objc2_app_kit::NSView) -> Option<objc2::rc::Retained<objc2_app_kit::NSView>> {
    use objc2::runtime::NSObjectProtocol;
    let class = objc2::runtime::AnyClass::get(c"WKWebView").unwrap();
    if view.isKindOfClass(class) { return unsafe { objc2::rc::Retained::retain(view as *const _ as *mut _) }; }
    view.subviews().iter().find_map(|child| webkit_view(&child))
}

#[cfg(target_os = "macos")]
fn main() {
    unsafe extern "C" fn describe_exception(
        exception: *mut objc2::runtime::AnyObject,
    ) -> *mut objc2::runtime::AnyObject {
        let reason: Option<objc2::rc::Retained<objc2_foundation::NSString>> =
            unsafe { objc2::msg_send![exception, reason] };
        eprintln!("PANEL_EXCEPTION: {reason:?}");
        eprintln!("{}", std::backtrace::Backtrace::force_capture());
        exception
    }
    unsafe extern "C" {
        fn objc_setExceptionPreprocessor(
            handler: unsafe extern "C" fn(
                *mut objc2::runtime::AnyObject,
            ) -> *mut objc2::runtime::AnyObject,
        );
    }
    unsafe {
        objc_setExceptionPreprocessor(describe_exception);
    }
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };
    use tauri::{Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
    let destroyed = Arc::new(AtomicUsize::new(0));
    let observed = destroyed.clone();
    let app = tauri::Builder::default()
        // The fixture tests presentation, not the app launch's independent activation policy.
        .activate_ignoring_other_apps(false)
        .plugin(tauri_nspanel::init())
        .setup(move |app| {
            for (label, decorated) in [("capture_selection_98765_1", false), ("capture", true)] {
                let input_app = app.handle().clone();
                let (painted, paint) = std::sync::mpsc::channel();
                let window = WebviewWindowBuilder::new(
                    app, label, WebviewUrl::External("about:blank".parse().unwrap()),
                )
                .visible(false)
                .focused(false)
                .accept_first_mouse(true)
                .decorations(decorated)
                .transparent(true)
                .always_on_top(true)
                // About:blank has no app-command capability. Substitute only the WebKit IPC
                // transport; the asynchronous drag admission and native owner remain real.
                .on_navigation(move |url| {
                    if url.host_str() == Some("panel-paint.invalid") {
                        let window = input_app.get_webview_window(label).unwrap();
                        let pointer = window.ns_window().unwrap();
                        let native: &objc2_app_kit::NSWindow = unsafe { &*pointer.cast() };
                        assert_eq!(native.alphaValue(), 0., "first clear document must paint while invisible");
                        assert_transparent_backing(&window, "first clear frame");
                        desktop_panel::reveal_after_paint(&window).unwrap();
                        assert_eq!(native.alphaValue(), 1.);
                        println!("{label}: clear document reached two real WebKit animation frames before reveal");
                        painted.send(()).unwrap();
                        return false;
                    }
                    if url.host_str() != Some("panel-drag.invalid") { return true; }
                    if url.path() == "/ready" { println!("native pointer surface ready"); return false; }
                    let window = input_app.get_webview_window(label).unwrap();
                    std::thread::spawn(move || {
                        println!("native pointer drag request: {:?}", desktop_panel::start_window_dragging(&window.as_ref().window()));
                    });
                    false
                })
                .build()?;
                let pointer = window.ns_window()?;
                // Tauri owns the live window; setup runs on the executable's main thread.
                let native: &objc2_app_kit::NSWindow = unsafe { &*pointer.cast() };
                let content = native.contentView().unwrap();
                let children = content.subviews();
                let level_before = native.level();
                assert!(level_before > objc2_app_kit::NSNormalWindowLevel);
                assert_transparent_backing(&window, "before conversion");
                desktop_panel::prepare_first_paint(&window)?;
                let webkit = webkit_view(&content).expect("real WebKit view");
                unsafe {
                    let _: () = objc2::msg_send![&*webkit, setUnderPageBackgroundColor: &*objc2_app_kit::NSColor::whiteColor()];
                    let _: () = objc2::msg_send![&*webkit, setValue: &*objc2_foundation::NSNumber::new_bool(true),
                        forKey: &*objc2_foundation::NSString::from_str("drawsBackground")];
                }
                desktop_panel::apply(&window, desktop_panel::PanelOptions {
                    shadow: false, opaque: false, movable: decorated, movable_by_window_background: false,
                    accepts_mouse_moved_events: true, ignores_mouse_events: false, nonactivating: true,
                    keyboard_on_request: false,
                    level: None, collection_behavior: tauri_nspanel::CollectionBehavior::new(),
                })?;
                assert!(!native.isVisible(), "conversion must not present an unpainted page");
                assert_eq!(native.alphaValue(), 0., "an unpainted converted panel must remain invisible even when ordered front to start WebKit rendering");
                unsafe {
                    let color: objc2::rc::Retained<objc2::runtime::AnyObject> = objc2::msg_send![&*webkit, underPageBackgroundColor];
                    let alpha: f64 = objc2::msg_send![&*color, alphaComponent];
                    let draws: objc2::rc::Retained<objc2::runtime::AnyObject> = objc2::msg_send![&*webkit,
                        valueForKey: &*objc2_foundation::NSString::from_str("drawsBackground")];
                    let draws: bool = objc2::msg_send![&*draws, boolValue];
                    assert_eq!((alpha, draws), (0., false), "clear WebKit synchronously before the first orderFront, without draining Tao's queued setters");
                }
                assert_eq!(native.contentView().as_ref(), Some(&content));
                assert_eq!(content.subviews(), children, "panel conversion must preserve the webview");
                assert_eq!(native.level(), level_before, "panel conversion must retain the floating control's window level");
                assert_transparent_backing(&window, "after conversion");
                assert!(!native.hasShadow());
                assert!(native.styleMask().contains(objc2_app_kit::NSWindowStyleMask::NonactivatingPanel));
                assert_eq!(native.isMovable(), decorated, "the converted control must retain native dragging");
                if decorated {
                    // Permission recovery deliberately lowers this retained host. A recording
                    // presentation must restore its own level, regardless of its previous use.
                    native.setLevel(objc2_app_kit::NSNormalWindowLevel);
                    desktop_panel::configure_capture_panel(&window)?;
                    let floating = native.level() > objc2_app_kit::NSNormalWindowLevel;
                    desktop_panel::configure_capture_panel(&window)?;
                    let nonactivating = native.styleMask().contains(objc2_app_kit::NSWindowStyleMask::NonactivatingPanel);
                    desktop_panel::configure_capture_panel(&window)?;
                    let excluded = native.sharingType() == objc2_app_kit::NSWindowSharingType::None;
                    let key_only_if_needed: bool = unsafe { objc2::msg_send![native, becomesKeyOnlyIfNeeded] };
                    assert!(!key_only_if_needed, "the inactive control must let WebKit become key on its first mouse-down");
                    println!("retained capture: floating={floating} nonactivating_after_editor={nonactivating} excluded={excluded}");
                    assert!(floating && nonactivating && excluded,
                        "recording presentation must restore floating level, retain nonactivation through editor reuse, and exclude the control from capture");
                    let pending = unsafe {
                        objc2_app_kit::NSEvent::otherEventWithType_location_modifierFlags_timestamp_windowNumber_context_subtype_data1_data2(
                            objc2_app_kit::NSEventType::ApplicationDefined, objc2_foundation::NSPoint::new(0., 0.),
                            objc2_app_kit::NSEventModifierFlags::empty(), 1., 0, None, 0, 0, 0,
                        ).unwrap()
                    };
                    let event = desktop_panel::window_drag_event(native, Some(&pending))?;
                    assert_eq!(event.windowNumber(), native.windowNumber(),
                        "the asynchronous DOM drag must target this panel, not Tao's application event window 0");
                    assert_eq!(native.convertPointToScreen(unsafe { event.locationInWindow() }), unsafe { objc2_app_kit::NSEvent::mouseLocation() },
                        "AppKit drag event coordinates must be local to this panel");
                    assert_eq!(desktop_panel::window_drag_event(native, None)?.windowNumber(), native.windowNumber(),
                        "the panel must also drag when AppKit has cleared currentEvent before IPC dispatch");
                }
                desktop_panel::show_without_activation(&window)?;
                assert_eq!(native.alphaValue(), 0., "ordering must not expose the unpainted document");
                assert_transparent_backing(&window, "ordered before paint");
                window.with_webview(|webview| unsafe {
                    let view: &objc2::runtime::AnyObject = &*webview.inner().cast();
                    let html = objc2_foundation::NSString::from_str("<html style='background:transparent'><body style='margin:0;background:transparent'><script>requestAnimationFrame(()=>requestAnimationFrame(()=>location.href='https://panel-paint.invalid/ready'))</script></body></html>");
                    let _: *mut objc2::runtime::AnyObject = objc2::msg_send![view, loadHTMLString: &*html, baseURL: std::ptr::null::<objc2::runtime::AnyObject>()];
                })?;
                let level_before = if decorated { objc2_app_kit::NSFloatingWindowLevel } else { level_before };
                let handle = app.handle().clone();
                let observed = observed.clone();
                window.on_window_event(move |event| {
                    if matches!(event, WindowEvent::Destroyed) {
                        if observed.fetch_add(1, Ordering::SeqCst) + 1 == 2 {
                            println!("macos_panel_lifecycle: PASS (decorated and selection windows destroyed)");
                            handle.exit(0);
                        }
                    }
                });
                // Same OS boundary as selection retirement after still commit, recording Stop or Esc.
                std::thread::spawn(move || {
                    if let Err(error) = paint.recv_timeout(std::time::Duration::from_secs(20)) {
                        eprintln!("{label}: real WebKit first-frame acknowledgement failed: {error}");
                        window.app_handle().exit(1);
                        return;
                    }
                    if !decorated {
                        let display = desktop_panel::run_on_main_thread(window.app_handle(), || {
                            let marker = objc2::MainThreadMarker::new().unwrap();
                            objc2_app_kit::NSScreen::screens(marker).firstObject().unwrap().frame()
                        }, "Selection display frame did not return").unwrap();
                        // The selector must settle its complete native display frame before
                        // showing/keying; queued Tauri setters reproduced a 33-point downward shift.
                        assert_eq!(desktop_panel::set_content_frame(&window, display).unwrap(), display);
                        let pending = window.clone();
                        desktop_panel::run_on_main_thread(window.app_handle(), move || {
                            desktop_panel::show_without_activation(&pending).unwrap();
                            let pointer = pending.ns_window().unwrap();
                            let native: &objc2_app_kit::NSWindow = unsafe { &*pointer.cast() };
                            native.makeKeyWindow();
                        }, "Selection immediate show did not return").unwrap();
                        let selector = window.clone();
                        desktop_panel::run_on_main_thread(window.app_handle(), move || {
                            let pointer = selector.ns_window().unwrap();
                            let native: &objc2_app_kit::NSWindow = unsafe { &*pointer.cast() };
                            desktop_panel::show_without_activation(&selector).unwrap();
                            println!("selection display={display:?} panel={:?} content={:?}", native.frame(), native.contentView().unwrap().frame());
                            assert_eq!(native.frame(), display, "selection panel must cover the full display without a menu-bar offset");
                            selector.with_webview(move |webview| unsafe {
                                let view: &objc2_app_kit::NSView = &*webview.inner().cast();
                                let rect = view.convertRect_toView(view.bounds(), None);
                                println!("selection webview_in_window={rect:?}");
                                println!("selection webview_safe_area={:?}", view.safeAreaInsets());
                                assert_eq!(rect.origin.x, 0.);
                                assert_eq!(rect.origin.y, 0., "selection webview must not retain a title-bar inset");
                                assert_eq!(rect.size, display.size, "selection viewport must cover the full panel");
                            }).unwrap();
                        }, "Selection geometry check did not return").unwrap();
                    }
                    window.set_size(tauri::LogicalSize::new(253., 44.)).unwrap();
                    window.set_position(tauri::LogicalPosition::new(99., 693.)).unwrap();
                    let shown = window.clone();
                    desktop_panel::run_on_main_thread(window.app_handle(), move || {
                        let marker = objc2::MainThreadMarker::new().unwrap();
                        let application = objc2_app_kit::NSApplication::sharedApplication(marker);
                        let active_before = application.isActive();
                        desktop_panel::show_without_activation(&shown).unwrap();
                        assert_eq!(application.isActive(), active_before, "showing a panel must not activate Happier");
                        assert_transparent_backing(&shown, "after show");
                        let pointer = shown.ns_window().unwrap();
                        let native: &objc2_app_kit::NSWindow = unsafe { &*pointer.cast() };
                        assert_eq!(native.isMovable(), decorated);
                        assert_eq!(native.level(), level_before, "resize/show must preserve the floating control's level");
                        assert!(!native.hasShadow(), "resizing must not restore a rectangular shadow");
                        let workspace = unsafe { objc2_app_kit::NSWorkspace::sharedWorkspace() };
                        let frontmost = unsafe { workspace.frontmostApplication() }.map(|app| unsafe { app.processIdentifier() });
                        native.makeKeyWindow();
                        // A directly initialized NSPanel also reports isActive after makeKey on 26.6;
                        // WindowServer's frontmost app is the user's menu bar/working-app contract.
                        assert_eq!(unsafe { workspace.frontmostApplication() }.map(|app| unsafe { app.processIdentifier() }), frontmost,
                            "selection keyboard focus must preserve the frontmost app");
                    }, "Panel show check did not return").unwrap();
                    // WindowServer tags are committed after the main run loop, including for
                    // a directly initialized NSPanel. Do not read the pre-commit value in setup.
                    std::thread::sleep(std::time::Duration::from_millis(200));
                    let committed = window.clone();
                    desktop_panel::run_on_main_thread(window.app_handle(), move || {
                        let pointer = committed.ns_window().unwrap();
                        let native: &objc2_app_kit::NSWindow = unsafe { &*pointer.cast() };
                        assert_prevents_activation(native);
                    }, "Committed panel input policy did not return").unwrap();
                    if decorated && std::env::var_os("HAPPIER_MAC_PANEL_REAL_INPUT").is_some() {
                        let input = window.clone();
                        desktop_panel::run_on_main_thread(window.app_handle(), move || {
                            let pointer = input.ns_window().unwrap();
                            let native: &objc2_app_kit::NSWindow = unsafe { &*pointer.cast() };
                            // Keep the owned input target above the Dock/Screenshot test obstruction.
                            // Production's floating level was asserted separately above.
                            native.setLevel(objc2_app_kit::NSPopUpMenuWindowLevel);
                            input.with_webview(|webview| unsafe {
                                let view: &objc2::runtime::AnyObject = &*webview.inner().cast();
                                let html = objc2_foundation::NSString::from_str("<html><body style='margin:0;height:100vh;background:rgba(20,30,40,.8)' onmousedown=\"location.href='https://panel-drag.invalid/start'\"><script>location.href='https://panel-drag.invalid/ready'</script></body></html>");
                                let _: *mut objc2::runtime::AnyObject = objc2::msg_send![view, loadHTMLString: &*html, baseURL: std::ptr::null::<objc2::runtime::AnyObject>()];
                            }).unwrap();
                        }, "Native drag input preparation did not return").unwrap();
                        std::thread::sleep(std::time::Duration::from_millis(200));
                        let result = std::process::Command::new("swift")
                            .arg("-e").arg(include_str!("fixtures/macos_panel_drag.swift"))
                            .arg(std::process::id().to_string()).output().unwrap();
                        println!("{}", String::from_utf8_lossy(&result.stdout));
                        if !result.status.success() {
                            eprintln!("real native pointer drag failed: {}", String::from_utf8_lossy(&result.stderr));
                            window.app_handle().exit(1);
                            return;
                        }
                        desktop_panel::configure_capture_panel(&window).unwrap();
                    }
                    if !decorated {
                        let marks = window.clone();
                        let (checked, completed) = std::sync::mpsc::channel();
                        desktop_panel::run_on_main_thread(window.app_handle(), move || {
                            marks.set_ignore_cursor_events(true).unwrap();
                            marks.set_content_protected(true).unwrap();
                            // Tao dispatches the mouse-events setter asynchronously, even on main.
                            let verify = block2::RcBlock::new(move || {
                                let pointer = marks.ns_window().unwrap();
                                let native: &objc2_app_kit::NSWindow = unsafe { &*pointer.cast() };
                                assert!(native.ignoresMouseEvents(), "recording marks must let the working app receive clicks");
                                assert_eq!(native.sharingType(), objc2_app_kit::NSWindowSharingType::None,
                                    "recording marks must be excluded from capture");
                                assert_transparent_backing(&marks, "recording marks");
                                checked.send(()).unwrap();
                            });
                            unsafe { objc2_foundation::NSOperationQueue::mainQueue().addOperationWithBlock(&verify); }
                        }, "Recording marks check did not return").unwrap();
                        completed.recv().unwrap();
                    }
                    window.hide().unwrap();
                    let hidden = window.clone();
                    desktop_panel::run_on_main_thread(window.app_handle(), move || {
                        let pointer = hidden.ns_window().unwrap();
                        let native: &objc2_app_kit::NSWindow = unsafe { &*pointer.cast() };
                        assert!(!native.isVisible(), "Tauri hide must retire a nonactivating panel");
                    }, "Panel hide check did not return").unwrap();
                    window.destroy().unwrap();
                });
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("build panel lifecycle application");
    app.run(|_, _| {});
    assert_eq!(
        destroyed.load(Ordering::SeqCst),
        2,
        "the native host must finish window destruction"
    );
}

#[cfg(not(target_os = "macos"))]
fn main() {}
