#![cfg(all(feature = "capture", target_os = "windows"))]
use happier_desktop_native::{capture::{acquire_still, windows::WindowsCaptureBackend,
    CancelSignal, CaptureBackend, CaptureTarget}, geometry::Rect};
use windows::{Win32::{Foundation::HWND, Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow,
    MONITORINFO, MONITOR_DEFAULTTONULL}, UI::HiDpi::{GetDpiForWindow,
    SetProcessDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2}}};

/// The external interactive fixture owns the HWND and marker paint, not this process.
#[test]
#[ignore = "requires the interactive P1U23 Windows fixture and its HWND"]
fn wgc_captures_only_the_fixture_window_with_native_marker_pixels() {
    unsafe { SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) }.unwrap();
    let id: u32 = std::env::var("HAPPIER_P1U23_FIXTURE_HWND").unwrap().parse().unwrap();
    let hwnd = HWND(id as usize as *mut _);
    let window = windows_capture::window::Window::from_raw_hwnd(hwnd.0);
    // Never acquire an unrelated desktop window if the fixture has disappeared.
    assert_eq!(window.title().unwrap(), "Happier P1U23 capture fixture");
    assert_eq!(window.process_id().unwrap().to_string(), std::env::var("HAPPIER_P1U23_FIXTURE_PID").unwrap());
    let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
    let monitor = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONULL) };
    assert!(unsafe { GetMonitorInfoW(monitor, &mut info) }.as_bool());
    let scale = unsafe { GetDpiForWindow(hwnd) } as f64 / 96.;
    let bounds = Rect { x: info.rcMonitor.left as f64, y: info.rcMonitor.top as f64,
        width: (info.rcMonitor.right-info.rcMonitor.left) as f64,
        height: (info.rcMonitor.bottom-info.rcMonitor.top) as f64 };
    let backend = WindowsCaptureBackend::new(vec![(bounds, scale)]).unwrap();
    let target = CaptureTarget::Window { window_id: id };
    let inventory = backend.discover_target(&target).unwrap();
    let image = acquire_still(&backend, &inventory, &target, false, &CancelSignal::default()).unwrap();
    assert_eq!((image.frame.width, image.frame.height), (320, 240));
    let pixel = |x: usize, y: usize| &image.frame.rgba[(y*320+x)*4..(y*320+x)*4+4];
    assert_eq!(pixel(32, 32), [211, 37, 53, 255]);
    assert_eq!(pixel(160, 120), [17, 29, 43, 255]);
    assert_eq!(pixel(288, 208), [31, 197, 83, 255]);
    assert_eq!(image.scale, scale);
    let origin = image.origin.as_ref().unwrap();
    let area = acquire_still(&backend, &inventory, &CaptureTarget::Rect {
        display_id: origin.display_id, rect: origin.rect,
    }, false, &CancelSignal::default()).unwrap();
    assert_eq!((area.frame.width, area.frame.height), (320, 240));
    assert_eq!(area.frame.rgba, image.frame.rgba);
    if let Ok(path) = std::env::var("HAPPIER_P1U23_FIXTURE_PNG") {
        std::fs::write(path, image.frame.png().unwrap()).unwrap();
    }
    println!("fixture capture: 320x240; three native RGBA markers; scale={scale}; selected window and display-local area agree");
}
