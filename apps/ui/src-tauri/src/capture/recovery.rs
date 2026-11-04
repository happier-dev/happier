//! Explicit recovery consumes the native operation's original request and recorder facts.
use super::*;

#[derive(Clone, PartialEq)]
pub(super) struct CaptureStartRequest {
    pub mode: CaptureMode,
    pub target: Option<CaptureTarget>,
    pub options: CaptureStartOptions,
}

pub(super) enum CaptureRetry {
    Settled(CaptureSnapshot),
    Start(CaptureStartRequest),
}

impl CaptureState {
    fn prepare_retry_for_window(&self, label: &str) -> Result<CaptureRetry, CaptureError> {
        {
            let operation = self.0.operation.lock().unwrap();
            if let Some((capture_ref, completed)) = operation.completed.iter().find(|(_, completed)| completed.window_label.as_deref() == Some(label)) {
                self.notify_completed(completed, operation.is_current_capture(capture_ref));
                return Ok(CaptureRetry::Settled(completed.snapshot.clone()));
            }
            if operation.window_label != label { return Err(CaptureError::OperationUnavailable); }
        }
        self.prepare_retry()
    }
    pub(super) fn remember_start(&self, mode: CaptureMode, target: Option<CaptureTarget>, options: CaptureStartOptions) {
        let mut operation = self.0.operation.lock().unwrap();
        if operation.active.is_none() {
            operation.last_start = Some(CaptureStartRequest { mode, target, options });
        }
    }

    pub(super) fn prepare_retry(&self) -> Result<CaptureRetry, CaptureError> {
        let mut operation = self.0.operation.lock().unwrap();
        match &operation.snapshot {
            CaptureSnapshot::Completed { .. } => {
                // An explicit retry of a failed renderer file/document read replays
                // the retained capture; it never acquires another source.
                self.notify_current(&operation);
                return Ok(CaptureRetry::Settled(operation.snapshot.clone()));
            },
            CaptureSnapshot::Recording { operation_ref, recording, .. } if recording.phase == happier_desktop_native::capture::recording::Phase::Failed => {
                if let Some(result) = &recording.result {
                    let snapshot = CaptureSnapshot::Completed { operation_ref: *operation_ref, result: result.clone(),
                        target_session: operation.active.as_ref().and_then(|active| active.options.target_session.clone()) };
                    return Ok(CaptureRetry::Settled(self.publish(&mut operation, snapshot)));
                }
                let id = *operation_ref;
                let session = operation.active.as_ref().and_then(|active| active.recording.clone())
                    .ok_or(CaptureError::OperationUnavailable)?;
                // A recorder publishes through the operation lock. Never hold it
                // while waiting for the recorder's native completion lock.
                drop(operation);
                if session.can_retry_finalization() {
                    session.stop()?;
                    return Ok(CaptureRetry::Settled(self.snapshot()));
                }
                operation = self.0.operation.lock().unwrap();
                if operation.active.as_ref().map(|active| active.id) != Some(id) {
                    return Err(CaptureError::OperationUnavailable);
                }
            },
            CaptureSnapshot::Failed { .. } | CaptureSnapshot::Unavailable { .. } => {},
            _ => return Err(CaptureError::OperationUnavailable),
        }
        let request = operation.last_start.clone().ok_or(CaptureError::OperationUnavailable)?;
        if let Some(active) = operation.active.take() { active.cancel.cancel(); }
        operation.pending_targets = None;
        // Partial library allocations remain owned files; only Discard deletes them.
        Ok(CaptureRetry::Start(request))
    }

    pub(super) fn recover_matching_start(&self, request: &CaptureStartRequest) -> Result<Option<CaptureSnapshot>, CaptureError> {
        let operation = self.0.operation.lock().unwrap();
        let failed = matches!(operation.snapshot, CaptureSnapshot::Failed { .. } | CaptureSnapshot::Unavailable { .. })
            || matches!(&operation.snapshot, CaptureSnapshot::Recording { recording, .. }
                if recording.phase == happier_desktop_native::capture::recording::Phase::Failed);
        if !failed || operation.last_start.as_ref() != Some(request) {
            return Ok(operation.active.as_ref().map(|_| operation.snapshot.clone()));
        }
        drop(operation);
        match self.prepare_retry()? {
            CaptureRetry::Settled(snapshot) => Ok(Some(snapshot)),
            CaptureRetry::Start(_) => Ok(None),
        }
    }
}

#[tauri::command]
pub async fn desktop_capture_retry(app: tauri::AppHandle, state: tauri::State<'_, CaptureState>,
    window: tauri::WebviewWindow) -> Result<CaptureSnapshot, CaptureError> {
    let worker = state.inner().clone();
    match commands::blocking(move || if crate::desktop_window::is_capture_window(window.label()) {
        worker.prepare_retry_for_window(window.label())
    } else { worker.prepare_retry() }).await? {
        CaptureRetry::Settled(snapshot) => Ok(snapshot),
        CaptureRetry::Start(request) => super::desktop_capture_start(app, state, request.mode, request.target,
            request.options.target_session, Some(request.options.present_capture_window)).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use happier_desktop_native::capture::{recording::{Backend, PreparedBackend, Timeline, Phase}, PixelSize, RgbaFrame, MediaKind};
    use std::sync::atomic::{AtomicUsize, Ordering};

    #[test]
    fn recording_recovery_retries_only_adoption_or_acknowledges_a_playable_source_warning() {
        // Source discovery and encoder completion are native OS boundaries; the
        // recording lifecycle, library adoption, retry and Quit owners stay real.
        struct Encoder { path: std::path::PathBuf, finishes: Arc<AtomicUsize>, source_warning: bool }
        impl Backend for Encoder {
            fn start(&mut self) -> Result<(), CaptureError> { Ok(()) }
            fn finish(&mut self, _: u64) -> Result<Option<CaptureError>, CaptureError> {
                self.finishes.fetch_add(1, Ordering::Relaxed);
                if self.source_warning { std::fs::write(&self.path, b"finalized movie").unwrap(); }
                Ok(self.source_warning.then_some(CaptureError::TargetUnavailable))
            }
            fn cancel(&mut self) {}
        }
        struct Source { finishes: Arc<AtomicUsize>, starts: AtomicUsize, path: Mutex<std::path::PathBuf>, source_warning: bool }
        impl CaptureBackend for Source {
            fn discover(&self) -> Result<Inventory, CaptureError> { Ok(Inventory { displays: vec![], windows: vec![] }) }
            fn capture_window(&self, _: u32, _include_shadow: bool, _: &CancelSignal) -> Result<RgbaFrame, CaptureError> { panic!("recording is never a still capture") }
            fn capture_display(&self, _: u32, _: &CancelSignal) -> Result<RgbaFrame, CaptureError> { panic!("recording is never a still capture") }
            fn prepare_recording(&self, _: &Inventory, _: &CaptureTarget, path: &Path,
                _: Arc<Mutex<Timeline>>, _: Arc<dyn Fn(CaptureError) + Send + Sync>) -> Result<PreparedBackend, CaptureError> {
                self.starts.fetch_add(1, Ordering::Relaxed);
                *self.path.lock().unwrap() = path.to_path_buf();
                Ok(PreparedBackend { backend: Box::new(Encoder { path: path.to_path_buf(), finishes: self.finishes.clone(), source_warning: self.source_warning }),
                    pixel_size: PixelSize { width: 4, height: 2 }, scale: Some(1.), origin: None, source: None })
            }
        }
        for source_warning in [false, true] {
            let state = CaptureState::default();
            let source = Arc::new(Source { finishes: Arc::new(AtomicUsize::new(0)), starts: AtomicUsize::new(0),
                path: Mutex::new(Default::default()), source_warning });
            let folder = tempfile::tempdir().unwrap();
            state.start_with_target(CaptureMode::Recording, Some(CaptureTarget::Display { display_id: 1 }), CaptureStartOptions::default(),
                || Ok(source.clone()), folder.path(), || Ok(()), |_, _| panic!("an explicit source has no selector")).unwrap();
            let started = state.start_recording(folder.path()).unwrap();
            let session = state.recording_session(started.operation_ref().unwrap()).unwrap();
            let request = state.0.operation.lock().unwrap().last_start.clone().unwrap();
            assert_eq!(state.recover_matching_start(&request).unwrap(), Some(started.clone()));
            assert_eq!(session.snapshot().phase, Phase::Recording, "a live start never becomes recovery");
            assert_eq!(session.stop().unwrap().phase, Phase::Failed);
            assert!(state.active_recording().is_some(), "failure remains visible until the person recovers it");
            let path = source.path.lock().unwrap().clone();
            if !source_warning { std::fs::write(&path, b"finalized movie").unwrap(); }
            let CaptureRetry::Settled(CaptureSnapshot::Completed { result, .. }) = state.prepare_retry().unwrap()
                else { panic!("finalized media must recover into review without another observation"); };
            assert_eq!(result.kind, MediaKind::Video);
            assert_eq!(state.read_source(&result.capture_ref).unwrap(), b"finalized movie");
            assert!(state.active_recording().is_none(), "acknowledged review cannot block normal Quit");
            assert_eq!(source.starts.load(Ordering::Relaxed), 1);
            assert_eq!(source.finishes.load(Ordering::Relaxed), 1);
            assert!(matches!(state.prepare_retry().unwrap(), CaptureRetry::Settled(CaptureSnapshot::Completed { .. })));
            assert_eq!(source.starts.load(Ordering::Relaxed), 1, "reopening review never records again");
            assert!(path.exists(), "recovery and Quit admission retain the library source");
        }
    }

    #[test]
    fn explicit_retry_preserves_the_failed_recording_request_and_session_target() {
        let state = CaptureState::default();
        let target = CaptureTarget::Display { display_id: 7 };
        let session = CaptureSessionTarget { server_id: "home".into(), account_id: "account".into(), session_id: "session".into() };
        let options = CaptureStartOptions { target_session: Some(session.clone()), present_capture_window: true, ..CaptureStartOptions::default() };
        let root = tempfile::tempdir().unwrap();
        assert!(matches!(state.start_with_target(CaptureMode::Recording, Some(target.clone()), options,
            || Err(CaptureError::ScreenPermissionRequired), root.path(), || Ok(()), |_, _| Ok(())).unwrap(),
            CaptureSnapshot::Unavailable { reason: CaptureError::ScreenPermissionRequired }));
        let CaptureRetry::Start(request) = state.prepare_retry().unwrap() else { panic!("explicit retry must admit the original recording request"); };
        assert_eq!(request.mode, CaptureMode::Recording);
        assert_eq!(request.target, Some(target));
        assert_eq!(request.options.target_session, Some(session));
        assert!(request.options.present_capture_window);
        assert!(state.0.operation.lock().unwrap().active.is_none());
    }

    #[test]
    fn retry_does_not_replace_active_selection_or_a_retained_capture() {
        let state = CaptureState::default();
        assert!(matches!(state.prepare_retry(), Err(CaptureError::OperationUnavailable)));
        state.0.operation.lock().unwrap().snapshot = CaptureSnapshot::Selecting { operation_ref: 1,
            mode: CaptureMode::Recording, inventory: Inventory { displays: Vec::new(), windows: Vec::new() } };
        assert!(matches!(state.prepare_retry(), Err(CaptureError::OperationUnavailable)));
    }

    #[test]
    fn another_entry_preserves_an_active_system_selection_before_platform_target_validation() {
        let state = CaptureState::default();
        let selected = state.select_system_recording(CaptureStartOptions::default()).unwrap();
        let frontmost = CaptureStartRequest { mode: CaptureMode::Still, target: Some(CaptureTarget::Frontmost),
            options: CaptureStartOptions::default() };
        assert_eq!(state.recover_matching_start(&frontmost).unwrap(), Some(selected.clone()),
            "an unrelated unsupported target cannot overwrite the admitted recording's visible state");
        assert_eq!(state.snapshot(), selected);
        assert_eq!(state.0.operation.lock().unwrap().last_start.as_ref().unwrap().mode, CaptureMode::Recording);
    }
}
