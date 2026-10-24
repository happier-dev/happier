// The native main-thread harness includes the real app modules; their libtest-only helpers
// are intentionally unused here. The ordinary library test target still checks them normally.
#![allow(dead_code, unused_imports)]

#[cfg(target_os = "macos")]
#[path = "../src/macos_window_frame.rs"]
mod macos_window_frame;

// Exercise the private production window owner without exporting a test-only runtime API.
#[cfg(target_os = "macos")]
include!("../src/lib.rs");

#[cfg(target_os = "macos")]
fn main() {
    use objc2::{rc::Retained, MainThreadOnly};
    use objc2_app_kit::{
        NSApplication, NSBackingStoreType, NSWindow, NSWindowStyleMask, NSWindowTitleVisibility,
    };
    use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize, NSString, NSUserDefaults};

    let args: Vec<String> = std::env::args().collect();
    // Cargo forwards filters and options even with harness=false. Only our explicit marker
    // selects a child phase; ordinary cargo-test arguments still run the coordinator.
    if args.get(1).map(String::as_str) != Some("--window-frame-phase") {
        let name = format!("happier-main-window-test-{}", std::process::id());
        let mut passed = true;
        for phase in [
            "save",
            "restore",
            "offscreen-save",
            "offscreen-restore",
            "tauri-save",
            "tauri-restore",
            "cleanup",
        ] {
            let mut child = std::process::Command::new(&args[0]);
            child.args(["--window-frame-phase", phase, &name]);
            if phase == "tauri-restore" {
                child.arg("--menu-bar");
            }
            let status = child.status().expect("run native window test phase");
            passed &= status.success();
        }
        assert!(passed, "native window frame regression failed");
        println!("main window frame survives recreation, restart and an off-screen saved position");
        return;
    }

    let phase = args.get(2).expect("child phase");
    let name = args.get(3).expect("child autosave name");
    if phase.starts_with("tauri-") {
        run_tauri_phase(phase == "tauri-save");
        return;
    }
    let mtm = MainThreadMarker::new().expect("AppKit runs on the main thread");
    let _app = NSApplication::sharedApplication(mtm);
    let native_name = NSString::from_str(name);
    if phase == "cleanup" {
        NSWindow::removeFrameUsingName(&native_name, mtm);
        NSWindow::removeFrameUsingName(&NSString::from_str("main"), mtm);
        assert!(NSUserDefaults::standardUserDefaults().synchronize());
        return;
    }
    let create = || -> Retained<NSWindow> {
        let window = unsafe {
            NSWindow::initWithContentRect_styleMask_backing_defer(
                NSWindow::alloc(mtm),
                NSRect::new(NSPoint::new(100.0, 100.0), NSSize::new(800.0, 600.0)),
                NSWindowStyleMask::Titled
                    | NSWindowStyleMask::Resizable
                    | NSWindowStyleMask::Closable
                    | NSWindowStyleMask::FullSizeContentView,
                NSBackingStoreType::Buffered,
                false,
            )
        };
        // Rust's Retained owns the window even after close().
        unsafe { window.setReleasedWhenClosed(false) };
        window.setTitleVisibility(NSWindowTitleVisibility::Hidden);
        window.setTitlebarAppearsTransparent(true);
        window
    };

    let window = create();
    let expected = NSRect::new(NSPoint::new(150.0, 160.0), NSSize::new(1000.0, 700.0));
    if phase == "save" {
        let initial = window.frame();
        assert!(macos_window_frame::restore_and_track_frame(&window, name));
        assert_eq!(
            window.frame(),
            initial,
            "first launch keeps its default frame"
        );
        window.setFrame_display(expected, false);
        // Recreating the hidden main window is the menu-bar Open path's native lifecycle.
        window.close();
        drop(window);
        for _ in 0..3 {
            let recreated = create();
            assert!(macos_window_frame::restore_and_track_frame(
                &recreated, name
            ));
            assert_eq!(
                recreated.frame(),
                expected,
                "overlay chrome must not grow the restored frame"
            );
            assert!(
                !recreated.isVisible(),
                "restoration must not reveal a hidden window"
            );
            recreated.close();
        }
        assert!(NSUserDefaults::standardUserDefaults().synchronize());
    } else if phase == "restore" {
        assert!(macos_window_frame::restore_and_track_frame(&window, name));
        assert_eq!(
            window.frame(),
            expected,
            "new process restores the saved frame"
        );
        assert!(!window.isVisible());
    } else if phase == "offscreen-save" {
        assert!(macos_window_frame::restore_and_track_frame(&window, name));
        window.setFrame_display(
            NSRect::new(NSPoint::new(100_000.0, 100_000.0), expected.size),
            false,
        );
        assert!(NSUserDefaults::standardUserDefaults().synchronize());
    } else {
        assert!(macos_window_frame::restore_and_track_frame(&window, name));
        let frame = window.frame();
        let screen = window
            .screen()
            .expect("restored window has a screen")
            .visibleFrame();
        assert!(frame.origin.x < screen.origin.x + screen.size.width);
        assert!(frame.origin.x + frame.size.width > screen.origin.x);
        assert!(frame.origin.y < screen.origin.y + screen.size.height);
        assert!(frame.origin.y + frame.size.height > screen.origin.y);
    }
}

#[cfg(target_os = "macos")]
fn run_tauri_phase(save: bool) {
    use objc2_app_kit::NSWindow;
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString, NSUserDefaults};
    use tauri::Manager;

    // Use Tauri's asset/context testkit with the real native runtime and production window config.
    // Omitting generate_context! also keeps the test executable out of the app's defaults domain.
    let mut context = tauri::test::mock_context(tauri::test::noop_assets());
    *context.config_mut() = serde_json::from_str(include_str!("../tauri.conf.json"))
        .expect("production desktop configuration");
    context.config_mut().identifier = "dev.happier.window-frame-test".to_string();
    // Geometry needs a real native webview, but no account, relay, Metro, or background services.
    context.config_mut().app.windows[0].url =
        tauri::WebviewUrl::External("about:blank".parse().expect("blank URL"));
    tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();
            if save {
                NSWindow::removeFrameUsingName(
                    &NSString::from_str("main"),
                    objc2_foundation::MainThreadMarker::new().expect("main thread"),
                );
            }
            window_chrome::register(app)?;
            if save {
                let window = handle
                    .get_webview_window("main")
                    .expect("startup main window");
                window.with_webview(move |webview| {
                    let native = unsafe { &*webview.ns_window().cast::<NSWindow>() };
                    assert_eq!(native.frameAutosaveName().to_string(), "main");
                    assert!(!native.isVisible());
                    native.setFrame_display(
                        NSRect::new(NSPoint::new(150.0, 160.0), NSSize::new(1000.0, 700.0)),
                        false,
                    );
                    assert!(NSUserDefaults::standardUserDefaults().synchronize());
                    handle.exit(0);
                })?;
            } else {
                assert!(
                    handle.get_webview_window("main").is_none(),
                    "login stays tray-only"
                );
                // Tray Open creates and presents a main window from a worker thread.
                let present = move || {
                    window_chrome::show_main_window(&handle).expect("open main window");
                    let window = handle.get_webview_window("main").expect("main window");
                    window
                        .with_webview(move |webview| {
                            let native = unsafe { &*webview.ns_window().cast::<NSWindow>() };
                            assert_eq!(
                                native.frame(),
                                NSRect::new(NSPoint::new(150.0, 160.0), NSSize::new(1000.0, 700.0)),
                                "the production creation and show path restores the frame",
                            );
                            assert!(native.isVisible());
                            handle.exit(0);
                        })
                        .expect("inspect presented window");
                };
                std::thread::spawn(move || {
                    // A worker failure must fail this child, not leave its native event loop open.
                    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(present)).is_err() {
                        std::process::exit(1);
                    }
                });
            }
            Ok(())
        })
        .build(context)
        .expect("build isolated native window test")
        .run(|_, _| {});
}

#[cfg(not(target_os = "macos"))]
fn main() {
    println!("macOS window frame test requires AppKit; skipped on this platform");
}
