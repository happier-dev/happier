//! Subclass existing Tauri HWNDs; Windows owns the handler's lifetime.
use tauri::{Manager, Runtime, WebviewWindow};
use super::DisplayChange;
use ::windows::Win32::{Foundation::{HWND, LPARAM, LRESULT, WPARAM}, UI::{
    Shell::{DefSubclassProc, GetWindowSubclass, RemoveWindowSubclass, SetWindowSubclass},
    WindowsAndMessaging::{WM_DISPLAYCHANGE, WM_DPICHANGED, WM_NCDESTROY},
}};

struct Signal(Box<dyn Fn(DisplayChange) + Send + Sync>);

unsafe extern "system" fn display_message(
    hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM, subclass: usize, data: usize,
) -> LRESULT {
    if message == WM_DISPLAYCHANGE || message == WM_DPICHANGED {
        // This callback only submits to the existing executor. It never locks
        // CaptureState or destroys a selector on the native message stack.
        let signal = unsafe { &*(data as *const Signal) };
        (signal.0)(if message == WM_DISPLAYCHANGE { DisplayChange::Topology } else { DisplayChange::WindowDpi });
    } else if message == WM_NCDESTROY {
        unsafe {
            RemoveWindowSubclass(hwnd, Some(display_message), subclass);
            drop(Box::from_raw(data as *mut Signal));
        }
    }
    unsafe { DefSubclassProc(hwnd, message, wparam, lparam) }
}

unsafe fn install(hwnd: HWND, signal: impl Fn(DisplayChange) + Send + Sync + 'static) -> Result<(), String> {
    // Native HWND+callback identity is the registration authority: no mirrored
    // window registry and no duplicate handlers on repeated show/discovery.
    if unsafe { GetWindowSubclass(hwnd, Some(display_message), 0, None) }.as_bool() { return Ok(()); }
    let signal = Box::into_raw(Box::new(Signal(Box::new(signal))));
    if !unsafe { SetWindowSubclass(hwnd, Some(display_message), 0, signal as usize) }.as_bool() {
        unsafe { drop(Box::from_raw(signal)); }
        return Err("Capture display message registration failed".to_string());
    }
    Ok(())
}

pub(in crate::activity_overlay) fn watch<R: Runtime>(window: &WebviewWindow<R>) -> Result<(), String> {
    let window = window.clone();
    let dispatcher = window.clone();
    let (tx, rx) = std::sync::mpsc::channel();
    dispatcher.run_on_main_thread(move || {
        let result = window.hwnd().map_err(|error| error.to_string()).and_then(|hwnd| {
            let app = window.app_handle().clone();
            let retained = window.label() == crate::desktop_window::MAIN_WINDOW_LABEL || crate::desktop_window::is_capture_window(window.label());
            let activity = window.label() == super::super::OVERLAY_WINDOW_LABEL;
            // SAFETY: this is the HWND's owning GUI thread; Windows drops the
            // signal exactly once at WM_NCDESTROY after removing the subclass.
            unsafe { install(hwnd, move |change| {
                // Selector DPI is operation-scoped by Tauri ScaleFactorChanged.
                // Retained-window DPI hints withdraw cached targets only.
                if activity {
                    if change == DisplayChange::WindowDpi { super::notify_activity(&app); }
                } else if retained {
                    super::notify(&app, change);
                }
            }) }
        });
        let _ = tx.send(result);
    }).map_err(|error| error.to_string())?;
    rx.recv().map_err(|_| "Capture display message registration did not return".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::{record_capture_display_change, tests::Desktop};
    use crate::capture::{CaptureMode, CaptureSnapshot, CaptureState};
    use happier_desktop_native::capture::CaptureError;
    use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};
    use ::windows::{core::w, Win32::{Foundation::RECT, UI::WindowsAndMessaging::{
        CreateWindowExW, DestroyWindow, SendMessageW, WINDOW_EX_STYLE, WS_POPUP, WM_MOVE, WM_SIZE,
    }}};

    #[test]
    fn native_display_hwnd_lifetime_has_one_handler_and_ignores_window_movement() {
        let count = Arc::new(AtomicUsize::new(0));
        let released = Arc::new(AtomicUsize::new(0));
        let capture = CaptureState::default();
        let reads = Arc::new(AtomicUsize::new(0));
        capture.targets(|| Ok(Arc::new(Desktop(reads.clone())))).unwrap();
        struct Release(Arc<AtomicUsize>);
        impl Drop for Release { fn drop(&mut self) { self.0.fetch_add(1, Ordering::Relaxed); } }
        // A real existing top-level HWND receives actual native messages. No
        // extra production message window or replacement event dispatcher.
        unsafe {
            let hwnd = CreateWindowExW(WINDOW_EX_STYLE::default(), w!("STATIC"), w!("Capture display signal test"),
                WS_POPUP, 0, 0, 1, 1, None, None, None, None).unwrap();
            let observed = count.clone();
            let owner = capture.clone();
            let lifetime = Release(released.clone());
            install(hwnd, move |change| {
                let _ = &lifetime;
                observed.fetch_add(1, Ordering::Relaxed);
                record_capture_display_change(&owner, change);
            }).unwrap();
            for _ in 0..1000 { install(hwnd, |_| panic!("duplicate native handler")).unwrap(); }
            for message in [WM_MOVE, WM_SIZE] { SendMessageW(hwnd, message, Some(WPARAM(0)), Some(LPARAM(0))); }
            assert_eq!(count.load(Ordering::Relaxed), 0);
            assert_eq!(reads.load(Ordering::Relaxed), 1);
            let frame = RECT { left: 0, top: 0, right: 100, bottom: 100 };
            SendMessageW(hwnd, WM_DPICHANGED, Some(WPARAM(96 | (96 << 16))), Some(LPARAM((&frame as *const RECT) as isize)));
            let selecting = capture.begin(CaptureMode::Still, || Ok(Arc::new(Desktop(reads.clone())))).unwrap();
            assert_eq!(reads.load(Ordering::Relaxed), 2, "DPI hint retires idle cached facts without reading them");
            SendMessageW(hwnd, WM_DPICHANGED, Some(WPARAM(144 | (144 << 16))), Some(LPARAM((&frame as *const RECT) as isize)));
            assert_eq!(capture.snapshot(), selecting, "a retained window changing DPI does not cancel active selection");
            for _ in 0..2 { SendMessageW(hwnd, WM_DISPLAYCHANGE, Some(WPARAM(32)), Some(LPARAM(0))); }
            assert_eq!(capture.snapshot(), CaptureSnapshot::Failed { reason: CaptureError::TargetUnavailable });
            assert_eq!(reads.load(Ordering::Relaxed), 2);
            assert_eq!(count.load(Ordering::Relaxed), 4);
            DestroyWindow(hwnd).unwrap();
            assert_eq!(released.load(Ordering::Relaxed), 1);
        }
    }
}
