//! One native selection host for every desktop backend that supplies targets.
use super::{CaptureSnapshot, CaptureState};
use happier_desktop_native::capture::recording::Phase;
use happier_desktop_native::capture::{CaptureError, CaptureTarget, Inventory};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
#[cfg(not(target_os = "macos"))]
use tauri::{LogicalSize, PhysicalPosition};

pub(super) fn release(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if label.starts_with("capture_selection_") { let _ = window.destroy(); }
    }
}

/// An area keeps its corner marks while it records (MIS 7.1): that display's layer stays, hidden and
/// click-through, until the recorder runs. A window target moves with its window, so it has no marks.
pub(super) fn settle_after_commit(app: &AppHandle, operation_ref: u64, snapshot: &CaptureSnapshot) {
    let keep: Option<String> = match snapshot {
        #[cfg(not(target_os = "linux"))] // Only macOS and Windows keep this window out of the video.
        CaptureSnapshot::Selected { target: CaptureTarget::Rect { display_id, .. }, .. } => Some(label(operation_ref, *display_id)),
        _ => None,
    };
    for (label, window) in app.webview_windows() {
        if !label.starts_with("capture_selection_") { continue; }
        let kept = keep.as_deref() == Some(label.as_str()) && window.set_ignore_cursor_events(true).is_ok()
            && window.set_content_protected(true).is_ok();
        if !kept { let _ = window.destroy(); }
    }
}

pub(super) fn recording_marks_changed(app: &AppHandle, phase: Phase) {
    match phase {
        Phase::Recording => {
            for (label, window) in app.webview_windows() {
                if label.starts_with("capture_selection_") && !window.is_visible().unwrap_or(true) {
                    let _ = crate::desktop_panel::show_without_activation(&window);
                }
            }
        },
        Phase::Finalizing | Phase::Failed | Phase::Ready => release_recording_marks(app),
        Phase::Preparing | Phase::Paused => {},
    }
}

/// Publishing can hold the operation lock, and destruction reads it back: settle off this stack.
pub(super) fn release_recording_marks(app: &AppHandle) {
    if !app.webview_windows().keys().any(|label| label.starts_with("capture_selection_")) { return; }
    let app = app.clone();
    tauri::async_runtime::spawn(async move { release(&app) });
}

pub(super) fn label(operation_ref: u64, display_id: u32) -> String {
    format!("capture_selection_{}_{}", operation_ref, display_id)
}

pub(super) fn show(app: &AppHandle, operation_ref: u64, inventory: &Inventory) -> Result<(), CaptureError> {
    let result = (|| {
        for (index, display) in inventory.displays.iter().enumerate() {
            let label = label(operation_ref, display.display_id);
            if app.get_webview_window(&label).is_some() { continue; }
            let route = format!("/desktop/capture-selection?displayId={}", display.display_id);
            let window = WebviewWindowBuilder::new(app, label, WebviewUrl::App(route.into()))
                .title("Happier Capture").visible(false).focused(false).accept_first_mouse(true)
                .transparent(true).decorations(false).resizable(false).shadow(false)
                .skip_taskbar(true).always_on_top(true).build().map_err(|_| CaptureError::NativeFailure)?;
            crate::desktop_panel::prepare_first_paint(&window).map_err(|_| CaptureError::NativeFailure)?;
            #[cfg(target_os = "macos")]
            {
                crate::desktop_panel::apply(&window, crate::desktop_panel::PanelOptions {
                    shadow: false, opaque: false, movable: false, movable_by_window_background: false,
                    accepts_mouse_moved_events: true, ignores_mouse_events: false, nonactivating: true,
                    keyboard_on_request: false,
                    level: None, collection_behavior: tauri_nspanel::CollectionBehavior::new()
                        .can_join_all_spaces().full_screen_auxiliary(),
                }).map_err(|_| CaptureError::NativeFailure)?;
                let selector = window.clone();
                let display_id = display.display_id;
                crate::desktop_panel::run_on_main_thread(app, move || {
                    let marker = objc2::MainThreadMarker::new().expect("selection placement runs on main");
                    // Use the full AppKit display frame by native identity. No content/safe-area
                    // inset or CG y-flip belongs in the selector's display-local projection.
                    let frame = happier_desktop_native::display::list_displays(marker).into_iter()
                        .find(|display| display.cg_display_id == Some(display_id))
                        .ok_or(CaptureError::TargetUnavailable)?.frame;
                    crate::desktop_panel::set_content_frame(&selector, objc2_foundation::NSRect::new(
                        objc2_foundation::NSPoint::new(frame.x, frame.y),
                        objc2_foundation::NSSize::new(frame.width, frame.height),
                    )).map_err(|_| CaptureError::NativeFailure)?;
                    Ok::<_, CaptureError>(())
                }, "Selection display placement did not return").map_err(|_| CaptureError::NativeFailure)??;
            }
            #[cfg(not(target_os = "macos"))]
            window.set_position(PhysicalPosition::new(display.frame.x as i32, display.frame.y as i32))
                .map_err(|_| CaptureError::NativeFailure)?;
            #[cfg(not(target_os = "macos"))]
            window.set_size(LogicalSize::new(display.frame.width, display.frame.height))
                .map_err(|_| CaptureError::NativeFailure)?;
            window.set_always_on_top(true).map_err(|_| CaptureError::NativeFailure)?;
            #[cfg(target_os = "windows")]
            crate::activity_overlay::watch_native_display_window(&window).map_err(|_| CaptureError::NativeFailure)?;
            let handle = app.clone();
            window.on_window_event(move |event| {
                if !matches!(event, WindowEvent::Destroyed | WindowEvent::ScaleFactorChanged { .. }) { return; }
                let state = handle.state::<CaptureState>();
                // The operation owner retires the matching selection and its
                // existing terminal publisher releases every selector host.
                state.invalidate_selection(Some(operation_ref));
            });
            crate::desktop_panel::show_without_activation(&window).map_err(|_| CaptureError::NativeFailure)?;
            if index == 0 {
                #[cfg(target_os = "macos")]
                {
                    let key_window = window.clone();
                    crate::desktop_panel::run_on_main_thread(app, move || {
                        let pointer = key_window.ns_window().map_err(|_| CaptureError::NativeFailure)?;
                        let native: &objc2_app_kit::NSWindow = unsafe { &*pointer.cast() };
                        unsafe { let _: () = objc2::msg_send![native, makeKeyWindow]; }
                        Ok::<_, CaptureError>(())
                    }, "Selection key window did not return").map_err(|_| CaptureError::NativeFailure)??;
                }
                #[cfg(not(target_os = "macos"))]
                window.set_focus().map_err(|_| CaptureError::NativeFailure)?;
            }
        }
        Ok(())
    })();
    if result.is_err() { release(app); }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::{CaptureMode, CaptureStartOptions};
    use happier_desktop_native::{capture::{CaptureBackend, DisplayDescriptor, CancelSignal, RgbaFrame}, geometry::Rect};
    use std::sync::{Arc, Mutex, atomic::{AtomicUsize, Ordering}};

    // Display metadata and pixels are OS boundaries; the capture operation,
    // inventory retirement, terminal publication and retry remain real.
    struct Desktop { displays: Mutex<Vec<DisplayDescriptor>>, reads: AtomicUsize }
    impl CaptureBackend for Desktop {
        fn discover(&self) -> Result<Inventory, CaptureError> {
            self.reads.fetch_add(1, Ordering::Relaxed);
            Ok(Inventory { displays: self.displays.lock().unwrap().clone(), windows: vec![] })
        }
        fn capture_window(&self, _: u32, _include_shadow: bool, _: &CancelSignal) -> Result<RgbaFrame, CaptureError> { panic!("topology must not acquire pixels") }
        fn capture_display(&self, _: u32, _: &CancelSignal) -> Result<RgbaFrame, CaptureError> { panic!("topology must not acquire pixels") }
    }
    #[test]
    fn display_topology_retires_stale_selection_once_and_retry_discovers_current_displays() {
        let desktop = Arc::new(Desktop { displays: Mutex::new(vec![DisplayDescriptor { display_id: 7,
            frame: Rect { x: 0., y: 0., width: 100., height: 100. }, scale: 2., desktop_scale: 1.,
            storage_key: None, localized_name: None, safe_area_top: 0., physical_notch_size: None }]), reads: AtomicUsize::new(0) });
        let state = CaptureState::default();
        let publications = Arc::new(AtomicUsize::new(0));
        let observed = publications.clone();
        state.set_publisher(Arc::new(move |_, _, _, _, _| { observed.fetch_add(1, Ordering::Relaxed); }));
        for _ in 0..1000 { assert!(!state.invalidate_selection(None)); }
        assert_eq!(publications.load(Ordering::Relaxed), 0);
        assert_eq!(desktop.reads.load(Ordering::Relaxed), 0);
        state.targets(|| Ok(desktop.clone())).unwrap();
        assert!(!state.invalidate_selection(Some(999)), "a retired window event must retain unrelated requested target facts");
        assert!(state.0.operation.lock().unwrap().pending_targets.is_some());
        desktop.displays.lock().unwrap()[0].frame.width = 120.;
        assert!(!state.invalidate_selection(None));
        assert!(state.0.operation.lock().unwrap().pending_targets.is_none(), "the global topology event retires cached geometry even without a selector");
        assert_eq!(desktop.reads.load(Ordering::Relaxed), 1);
        assert_eq!(publications.load(Ordering::Relaxed), 0);
        let CaptureSnapshot::Selecting { operation_ref, inventory, .. } = state.begin(CaptureMode::Still, || Ok(desktop.clone())).unwrap()
            else { panic!("the next admitted selection must discover current geometry"); };
        assert_eq!(inventory.displays[0].frame.width, 120.);
        assert_eq!(desktop.reads.load(Ordering::Relaxed), 2);
        state.cancel(operation_ref).unwrap();
        let folder = tempfile::tempdir().unwrap();
        for removed in [false, true] {
            state.start_with_target(CaptureMode::Still, None, CaptureStartOptions::default(),
                || Ok(desktop.clone()), folder.path(), || panic!("selection has no pixel acquisition"), |_, _| Ok(())).unwrap();
            let CaptureSnapshot::Selecting { operation_ref, inventory, .. } = state.snapshot() else { panic!("expected native selection"); };
            assert_eq!(inventory.displays[0].scale, 2.);
            assert!(!state.invalidate_selection(Some(operation_ref - 1)), "a retired selector cannot invalidate a new operation");
            let cancel = state.0.operation.lock().unwrap().active.as_ref().unwrap().cancel.clone();
            if removed { desktop.displays.lock().unwrap().clear(); }
            else { desktop.displays.lock().unwrap()[0].frame = Rect { x: -50., y: 20., width: 80., height: 90. }; }
            let before = publications.load(Ordering::Relaxed);
            let reads = desktop.reads.load(Ordering::Relaxed);
            assert!(state.invalidate_selection(if removed { Some(operation_ref) } else { None }));
            assert_eq!(state.snapshot(), CaptureSnapshot::Failed { reason: CaptureError::TargetUnavailable });
            assert!(cancel.is_cancelled());
            assert!(state.0.operation.lock().unwrap().active.is_none());
            assert!(state.0.operation.lock().unwrap().pending_targets.is_none());
            assert_eq!(publications.load(Ordering::Relaxed), before + 1);
            for _ in 0..1000 { assert!(!state.invalidate_selection(None)); }
            assert_eq!(publications.load(Ordering::Relaxed), before + 1);
            assert_eq!(desktop.reads.load(Ordering::Relaxed), reads);
            assert_eq!(state.commit(operation_ref, CaptureTarget::Display { display_id: 7 }, folder.path(),
                || panic!("retired selection cannot acquire pixels")), Err(CaptureError::OperationUnavailable));
            let crate::capture::recovery::CaptureRetry::Start(request) = state.prepare_retry().unwrap() else { panic!("failure must offer the existing retry"); };
            assert_eq!(request.mode, CaptureMode::Still);
            assert_eq!(request.target, None);
        }
        let CaptureSnapshot::Selecting { inventory, .. } = state.begin(CaptureMode::Still, || Ok(desktop.clone())).unwrap()
            else { panic!("retry must use fresh display metadata"); };
        assert!(inventory.displays.is_empty());
        assert_eq!(desktop.reads.load(Ordering::Relaxed), 5);
    }
}
