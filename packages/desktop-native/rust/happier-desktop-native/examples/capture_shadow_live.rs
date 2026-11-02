//! Opt-in real-window regression: cargo run --features capture --example capture_shadow_live.
#[cfg(all(target_os = "macos", feature = "capture"))]
fn main() {
    use happier_desktop_native::capture::{macos, CancelSignal, CaptureBackend, RgbaFrame};
    use objc2::{msg_send, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSApplication, NSBackingStoreType, NSColor, NSWindow, NSWindowStyleMask};
    use objc2_foundation::{NSPoint, NSRect, NSSize, NSString};

    fn content_width(frame: &RgbaFrame) -> usize {
        frame.rgba.chunks_exact(frame.width as usize * 4).map(|row| {
            row.chunks_exact(4).filter(|p| p[0] > 240 && p[1] < 15 && p[2] < 15 && p[3] == 255).count()
        }).max().unwrap()
    }

    let mtm = MainThreadMarker::new().expect("run on the macOS main thread");
    let app = NSApplication::sharedApplication(mtm);
    app.finishLaunching();
    if macos::screen_permission() != happier_desktop_native::capture::ScreenPermission::Granted {
        let _ = macos::request_screen_permission();
        eprintln!("OWNER CLICK NEEDED: Screen Recording for Happier Window Shadow Test; rerun after granting");
        std::process::exit(2);
    }
    let window = unsafe { NSWindow::initWithContentRect_styleMask_backing_defer(
        NSWindow::alloc(mtm), NSRect::new(NSPoint::new(200., 200.), NSSize::new(360., 290.)),
        NSWindowStyleMask::Titled | NSWindowStyleMask::Closable, NSBackingStoreType::Buffered, false,
    ) };
    window.setTitle(&NSString::from_str("Happier window-shadow regression"));
    window.setBackgroundColor(Some(&NSColor::redColor()));
    window.setHasShadow(true);
    window.orderFrontRegardless();
    window.displayIfNeeded();
    let window_id: isize = unsafe { msg_send![&*window, windowNumber] };
    let displays = macos::display_facts(mtm);
    std::thread::spawn(move || {
        let result = std::panic::catch_unwind(|| {
            let backend = macos::MacCaptureBackend::new(displays).unwrap();
            let cancel = CancelSignal::default();
            let off = backend.capture_window(window_id as u32, false, &cancel).unwrap();
            let on = backend.capture_window(window_id as u32, true, &cancel).unwrap();
            println!("window={window_id} OFF={}x{} content={} ON={}x{} content={}",
                off.width, off.height, content_width(&off), on.width, on.height, content_width(&on));
            assert_eq!(content_width(&off), off.width as usize, "fixture fills the native window width");
            assert_eq!(content_width(&on), content_width(&off), "shadow must preserve exact content pixels");
            assert!(on.width > off.width && on.height > off.height, "shadow grows the output frame");
            for frame in [&off, &on] {
                for pixel in [0, frame.width - 1, (frame.height - 1) * frame.width, frame.height * frame.width - 1] {
                    assert_eq!(frame.rgba[pixel as usize * 4 + 3], 0, "outside corners remain transparent");
                }
            }
            println!("PASS: exact native content width, larger shadow frame, transparent corners");
        });
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    });
    app.run();
}

#[cfg(not(all(target_os = "macos", feature = "capture")))]
fn main() { panic!("requires macOS with --features capture"); }
