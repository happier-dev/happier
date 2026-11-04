//! Native signal lifetimes for the existing display-change owner.
#[cfg(any(target_os = "linux", target_os = "windows", test))]
use crate::capture::CaptureState;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "windows")]
mod windows;

// A subscription owns its native disconnection resource, not monitor metadata.
// Repeated discovery/show must not multiply callbacks for a live native object.
#[cfg(any(target_os = "linux", test))]
struct Subscriptions<K, C>(Vec<(K, C)>);

#[cfg(any(target_os = "linux", test))]
impl<K: PartialEq, C> Subscriptions<K, C> {
    fn attach(&mut self, key: K, connect: impl FnOnce(&K) -> C) {
        if self.0.iter().any(|(existing, _)| existing == &key) { return; }
        let connection = connect(&key);
        self.0.push((key, connection));
    }

    fn detach(&mut self, key: &K) {
        self.0.retain(|(existing, _)| existing != key);
    }
}

#[cfg(any(target_os = "linux", target_os = "windows", test))]
#[derive(Clone, Copy, PartialEq, Eq)]
enum DisplayChange {
    Topology,
    #[cfg(any(target_os = "windows", test))]
    WindowDpi,
}

#[cfg(any(target_os = "linux", target_os = "windows", test))]
fn record_capture_display_change(capture: &CaptureState, change: DisplayChange) {
    match change {
        DisplayChange::Topology => { capture.invalidate_selection(None); },
        #[cfg(any(target_os = "windows", test))]
        DisplayChange::WindowDpi => capture.invalidate_display_targets(),
    }
}

#[cfg(any(target_os = "linux", target_os = "windows"))]
fn notify<R: tauri::Runtime>(app: &tauri::AppHandle<R>, change: DisplayChange) {
    use tauri::Manager;
    let app = app.clone();
    // Native GUI callbacks cannot wait for an operation that itself waits for
    // GUI-thread metadata or hide work. Use the existing blocking executor.
    tauri::async_runtime::spawn_blocking(move || {
        if change == DisplayChange::Topology {
            super::request_display_refresh(&app);
        } else if let Some(capture) = app.try_state::<CaptureState>() {
            record_capture_display_change(&capture, change);
        }
    });
}


#[cfg(target_os = "linux")]
pub(super) use linux::watch as watch_linux;
#[cfg(target_os = "windows")]
pub(super) use windows::watch as watch_window;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::capture::{CaptureMode, CaptureSnapshot, CaptureStartOptions};
    use happier_desktop_native::capture::{CaptureBackend, CaptureError, CancelSignal, Inventory, RgbaFrame};
    use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};

    pub(super) struct Desktop(pub(super) Arc<AtomicUsize>);
    impl CaptureBackend for Desktop {
        fn discover(&self) -> Result<Inventory, CaptureError> {
            self.0.fetch_add(1, Ordering::Relaxed);
            Ok(Inventory { displays: vec![], windows: vec![] })
        }
        fn capture_display(&self, _: u32, _: &CancelSignal) -> Result<RgbaFrame, CaptureError> { panic!("signal cannot acquire pixels") }
        fn capture_window(&self, _: u32, _include_shadow: bool, _: &CancelSignal) -> Result<RgbaFrame, CaptureError> { panic!("signal cannot acquire pixels") }
    }
    struct Connection { disconnected: Arc<AtomicUsize>, signal: Box<dyn Fn()> }
    impl Drop for Connection {
        fn drop(&mut self) { self.disconnected.fetch_add(1, Ordering::Relaxed); }
    }

    #[test]
    fn native_display_subscription_lifetime_retires_selection_once_without_idle_work() {
        let capture = CaptureState::default();
        let reads = Arc::new(AtomicUsize::new(0));
        let connected = AtomicUsize::new(0);
        let disconnected = Arc::new(AtomicUsize::new(0));
        let mut subscriptions = Subscriptions(Vec::new());
        // Only native signal registration is substituted; subscription lifetime,
        // CaptureState retirement stays real; the selection-owner test also
        // checks exact publication counts and retry discovery.
        let connect = |_: &u32| {
            connected.fetch_add(1, Ordering::Relaxed);
            let capture = capture.clone();
            Connection { disconnected: disconnected.clone(), signal: Box::new(move || record_capture_display_change(&capture, DisplayChange::Topology)) }
        };
        for _ in 0..1000 { subscriptions.attach(7, &connect); }
        assert_eq!(connected.load(Ordering::Relaxed), 1);
        for _ in 0..1000 { (subscriptions.0[0].1.signal)(); }
        assert_eq!(reads.load(Ordering::Relaxed), 0);
        assert_eq!(capture.snapshot(), CaptureSnapshot::Idle);
        let folder = tempfile::tempdir().unwrap();
        for _change in ["geometry at the same scale", "monitor removed"] {
            capture.start_with_target(CaptureMode::Still, None, CaptureStartOptions::default(),
                || Ok(Arc::new(Desktop(reads.clone()))), folder.path(), || panic!("no pixels"), |_, _| Ok(())).unwrap();
            for _ in 0..1000 { (subscriptions.0[0].1.signal)(); }
            assert_eq!(capture.snapshot(), CaptureSnapshot::Failed { reason: CaptureError::TargetUnavailable });
        }
        assert_eq!(reads.load(Ordering::Relaxed), 2);
        subscriptions.detach(&7);
        assert_eq!(disconnected.load(Ordering::Relaxed), 1);
        subscriptions.attach(9, &connect);
        subscriptions.attach(9, &connect);
        assert_eq!(connected.load(Ordering::Relaxed), 2);
        drop(subscriptions);
        assert_eq!(disconnected.load(Ordering::Relaxed), 2, "display closure releases remaining monitor handlers");
    }

    #[test]
    fn native_display_dpi_hint_retires_cached_targets_without_cancelling_selection() {
        let capture = CaptureState::default();
        let reads = Arc::new(AtomicUsize::new(0));
        capture.targets(|| Ok(Arc::new(Desktop(reads.clone())))).unwrap();
        record_capture_display_change(&capture, DisplayChange::WindowDpi);
        let selecting = capture.begin(CaptureMode::Still, || Ok(Arc::new(Desktop(reads.clone())))).unwrap();
        assert_eq!(reads.load(Ordering::Relaxed), 2, "DPI hints withdraw idle cached display facts");
        for _ in 0..1000 { record_capture_display_change(&capture, DisplayChange::WindowDpi); }
        assert_eq!(capture.snapshot(), selecting, "a retained window changing monitors must not cancel selection");
        assert_eq!(reads.load(Ordering::Relaxed), 2);
        record_capture_display_change(&capture, DisplayChange::Topology);
        assert_eq!(capture.snapshot(), CaptureSnapshot::Failed { reason: CaptureError::TargetUnavailable });
    }
}
