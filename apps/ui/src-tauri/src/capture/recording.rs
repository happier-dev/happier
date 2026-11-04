//! Compose the selected P1 source with the shared recorder; no second capture owner.
use super::*;
use happier_desktop_native::capture::recording::{self, Phase, Session, Snapshot};

impl CaptureState {
    fn begin_recording_trim(&self, capture_ref: &str) -> Result<(u64, CancelSignal), CaptureError> {
        let mut op = self.0.operation.lock().unwrap();
        if !op.is_current_recording(capture_ref) { return Err(CaptureError::OperationUnavailable); }
        let active = op.completed.get_mut(capture_ref).unwrap().active.as_mut().unwrap();
        if active.trim_cancel.is_some() { return Err(CaptureError::OperationUnavailable); }
        let cancel = CancelSignal::default();
        active.trim_cancel = Some(cancel.clone());
        Ok((active.id, cancel))
    }
    fn finish_recording_trim(&self, operation_ref: u64) {
        if let Some(completed) = self.0.operation.lock().unwrap().completed.values_mut().find(|completed| completed.active.as_ref().is_some_and(|active| active.id == operation_ref)) {
            completed.active.as_mut().unwrap().trim_cancel = None;
        }
    }
    fn cancel_recording_trim(&self, capture_ref: &str) -> Result<(), CaptureError> {
        let op = self.0.operation.lock().unwrap();
        if !op.is_current_recording(capture_ref) { return Err(CaptureError::OperationUnavailable); }
        if let Some(cancel) = &op.completed.get(capture_ref).unwrap().active.as_ref().unwrap().trim_cancel { cancel.cancel(); }
        Ok(())
    }
    pub fn read_recording_document(&self, capture_ref: &str) -> Option<serde_json::Value> {
        let op = self.0.operation.lock().unwrap();
        op.completed.get(capture_ref).and_then(|completed| completed.active.as_ref()).and_then(|active| active.recording_document.clone())
    }
    pub fn write_recording_document(&self, capture_ref: &str, document: serde_json::Value, initialize_only: bool,
        expected_document: Option<serde_json::Value>) -> Result<serde_json::Value, CaptureError> {
        let mut op = self.0.operation.lock().unwrap();
        if !op.is_current_recording(capture_ref) { return Err(CaptureError::OperationUnavailable); }
        let current_operation = op.is_current_capture(capture_ref);
        let completed = op.completed.get_mut(capture_ref).unwrap();
        let active = completed.active.as_mut().unwrap();
        if initialize_only {
            if let Some(current) = &active.recording_document { return Ok(current.clone()); }
        }
        if !initialize_only && (expected_document.is_none()
            || expected_document.as_ref() != active.recording_document.as_ref()) {
            return Err(CaptureError::CaptureInUse);
        }
        let changed = active.recording_document.as_ref() != Some(&document);
        if changed {
            self.0.files.lock().unwrap().invalidate_recording(capture_ref)?;
            active.recording_document = Some(document);
        }
        let document = active.recording_document.clone().unwrap();
        if changed { self.notify_completed(completed, current_operation); }
        Ok(document)
    }
    pub fn start_recording(&self, folder: &Path) -> Result<CaptureSnapshot, CaptureError> {
        let op = self.0.operation.lock().unwrap();
        let target = match &op.snapshot {
            CaptureSnapshot::Selected { target, .. } => target.clone(),
            _ => return Ok(op.snapshot.clone()),
        };
        let backend = op.active.as_ref().unwrap().backend.as_ref().unwrap().clone();
        let inventory = op.active.as_ref().unwrap().inventory.clone();
        let format = backend.recording_format();
        self.start_recording_with(op, folder, format, move |path, timeline, failed, _| {
            backend.prepare_recording(&inventory, &target, path, timeline, failed)
        })
    }
    /// Pause before opening a system picker so the person can read its scope.
    /// The existing selection commit continues this admitted start; no extra grant.
    pub fn select_system_recording(&self, options: CaptureStartOptions) -> Result<CaptureSnapshot, CaptureError> {
        let mut op = self.0.operation.lock().unwrap();
        if op.active.is_some() { return Ok(op.snapshot.clone()); }
        op.last_start = Some(CaptureStartRequest { mode: CaptureMode::Recording, target: None, options: options.clone() });
        op.next_id += 1;
        let id = op.next_id;
        op.assign_window(id);
        op.pending_targets = None;
        op.active = Some(Active { id, mode: CaptureMode::Recording, backend: None,
            inventory: Inventory { displays: Vec::new(), windows: Vec::new() }, cancel: CancelSignal::default(),
            recording: None, recording_document: None, trim_cancel: None, options });
        Ok(self.publish(&mut op, CaptureSnapshot::SystemSelection { operation_ref: id, mode: CaptureMode::Recording }))
    }
    pub fn start_system_recording(&self, operation_ref: u64, folder: &Path,
        prepare: impl FnOnce(&Path, Arc<Mutex<recording::Timeline>>, Arc<dyn Fn(CaptureError) + Send + Sync>, &CancelSignal)
            -> Result<recording::PreparedBackend, CaptureError>) -> Result<CaptureSnapshot, CaptureError> {
        let op = self.0.operation.lock().unwrap();
        if !matches!(op.snapshot, CaptureSnapshot::SystemSelection { operation_ref: current, .. } if current == operation_ref) {
            return Err(CaptureError::OperationUnavailable);
        }
        self.start_recording_with(op, folder, recording::Format::Webm, prepare)
    }
    fn start_recording_with(&self, mut op: std::sync::MutexGuard<'_, Operation>, folder: &Path, format: recording::Format,
        prepare: impl FnOnce(&Path, Arc<Mutex<recording::Timeline>>, Arc<dyn Fn(CaptureError) + Send + Sync>, &CancelSignal)
            -> Result<recording::PreparedBackend, CaptureError>) -> Result<CaptureSnapshot, CaptureError> {
        let id = op.active.as_ref().unwrap().id;
        let inventory = op.active.as_ref().unwrap().inventory.clone();
        let cancel = op.active.as_ref().unwrap().cancel.clone();
        let preparation_cancel = cancel.clone();
        let files = Arc::downgrade(&self.0);
        let publisher = Arc::downgrade(&self.0);
        let prepared_origin = Arc::new(std::sync::OnceLock::new());
        let publish_origin = prepared_origin.clone();
        let started = Session::start(move |timeline, session| {
            let shared = files.upgrade().ok_or(CaptureError::OperationUnavailable)?;
            let (capture_ref, path) = shared.files.lock().unwrap().allocate_video(folder, format)?;
            session.upgrade().ok_or(CaptureError::OperationUnavailable)?.set_source_ref(capture_ref.clone());
            let failed = Arc::new(move |error| {
                if let Some(session) = session.upgrade() {
                    // Never stop the source from its own callback queue.
                    tauri::async_runtime::spawn_blocking(move || { let _ = session.fail(error); });
                }
            });
            let prepared = prepare(&path, timeline, failed, &cancel)?;
            let _ = prepared_origin.set(prepared.origin.clone());
            let result = CaptureResult { capture_ref, path, kind: happier_desktop_native::capture::MediaKind::Video,
                mime_type: format.mime_type().into(), byte_size: 0, pixel_size: prepared.pixel_size,
                scale: prepared.scale, origin: prepared.origin, source: prepared.source, window_text_ref: None };
            let context = result.source.as_ref().and_then(|source| source.window_id)
                .and_then(|id| inventory.windows.iter().find(|window| window.window_id == id)).cloned();
            Ok((prepared.backend, Box::new(move || {
                let shared = files.upgrade().ok_or(CaptureError::OperationUnavailable)?;
                let mut files = shared.files.lock().unwrap();
                files.complete_video(result.clone())?;
                files.bind_window_text(&result.capture_ref, context.clone(), cancel.clone())
            })))
        }, Arc::new(move |recording| {
            let Some(shared) = publisher.upgrade() else { return; };
            let state = CaptureState(shared);
            let mut op = state.0.operation.lock().unwrap();
            let Some(active) = op.active.as_mut().filter(|active| active.id == id) else { return; };
            if matches!(recording.phase, Phase::Ready | Phase::Failed) {
                active.backend = None;
                active.inventory.windows.clear();
            }
            let next = if let (Phase::Ready, Some(result)) = (recording.phase, &recording.result) {
                CaptureSnapshot::Completed { operation_ref: id, result: result.clone(), target_session: active.options.target_session.clone() }
            } else { CaptureSnapshot::Recording { operation_ref: id, recording: recording.clone(),
                origin: publish_origin.get().cloned().flatten() } };
            state.publish(&mut op, next);
        }), recording::clock(), move |session| {
            // Register while holding P1's operation lock, before native preparation. A
            // simultaneous Quit/Stop sees this same handle and awaits its lifecycle lock.
            session.bind_preparation_cancel(preparation_cancel);
            op.active.as_mut().unwrap().recording = Some(session);
            drop(op);
        });
        // Failure is already a pushed terminal fact, including failed preparation.
        let _ = started;
        Ok(self.snapshot())
    }
    pub fn recording_session(&self, operation_ref: u64) -> Result<Arc<Session>, CaptureError> {
        self.0.operation.lock().unwrap().active.as_ref().filter(|active| active.id == operation_ref)
            .and_then(|active| active.recording.clone()).ok_or(CaptureError::OperationUnavailable)
    }
    pub fn active_recording(&self) -> Option<Arc<Session>> {
        let operation = self.0.operation.lock().unwrap();
        if matches!(operation.snapshot, CaptureSnapshot::Completed { .. }) { return None; }
        operation.active.as_ref().and_then(|active| active.recording.clone())
            .filter(|session| session.snapshot().phase != Phase::Ready)
    }
}

pub(super) async fn start_selected(state: &CaptureState, app: &tauri::AppHandle,
    snapshot: CaptureSnapshot) -> Result<CaptureSnapshot, CaptureError> {
    if !matches!(snapshot, CaptureSnapshot::Selected { .. }) { return Ok(snapshot); }
    let state = state.clone(); let app = app.clone();
    commands::blocking(move || state.start_recording(&commands::library_folder(&app, &state)?)).await
}

#[tauri::command]
pub fn desktop_recording_status(state: tauri::State<'_, CaptureState>, operation_ref: u64) -> Result<Snapshot, CaptureError> {
    Ok(state.recording_session(operation_ref)?.snapshot())
}
#[tauri::command]
pub fn desktop_recording_document_read(state: tauri::State<'_, CaptureState>, capture_ref: String) -> Option<serde_json::Value> {
    state.read_recording_document(&capture_ref)
}
#[tauri::command]
pub fn desktop_recording_document_write(state: tauri::State<'_, CaptureState>, capture_ref: String,
    document: serde_json::Value, initialize_only: Option<bool>, expected_document: Option<serde_json::Value>) -> Result<serde_json::Value, CaptureError> {
    state.write_recording_document(&capture_ref, document, initialize_only.unwrap_or(false), expected_document)
}
#[tauri::command]
pub async fn desktop_recording_pause(state: tauri::State<'_, CaptureState>, operation_ref: u64) -> Result<Snapshot, CaptureError> {
    let session = state.recording_session(operation_ref)?;
    commands::blocking(move || session.pause()).await
}
#[tauri::command]
pub async fn desktop_recording_resume(state: tauri::State<'_, CaptureState>, operation_ref: u64) -> Result<Snapshot, CaptureError> {
    let session = state.recording_session(operation_ref)?;
    commands::blocking(move || session.resume()).await
}
#[tauri::command]
pub async fn desktop_recording_stop(state: tauri::State<'_, CaptureState>, operation_ref: u64) -> Result<Snapshot, CaptureError> {
    let session = state.recording_session(operation_ref)?;
    commands::blocking(move || session.stop()).await
}

#[tauri::command]
pub async fn desktop_recording_trim(state: tauri::State<'_, CaptureState>,
    capture_ref: String, start_ms: u64, end_ms: u64) -> Result<CaptureResult, CaptureError> {
    let state = state.inner().clone();
    let (operation, cancel) = state.begin_recording_trim(&capture_ref)?;
    let worker = state.clone();
    let result = commands::blocking(move || {
        let source = worker.0.files.lock().unwrap().describe(&capture_ref)?;
        if source.kind != happier_desktop_native::capture::MediaKind::Video { return Err(CaptureError::InvalidMedia); }
        let (capture_ref, path) = worker.0.files.lock().unwrap().allocate_video_derivative(&source.capture_ref)?;
        recording::trim::trim(&source.path, &path, start_ms, end_ms, &cancel)?;
        if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
        let completed = worker.0.files.lock().unwrap().complete_video(CaptureResult { capture_ref, path,
            byte_size: 0, window_text_ref: None, ..source });
        completed
    }).await;
    state.finish_recording_trim(operation);
    result
}

#[tauri::command]
pub fn desktop_recording_trim_cancel(state: tauri::State<'_, CaptureState>, capture_ref: String) -> Result<(), CaptureError> {
    state.cancel_recording_trim(&capture_ref)
}

#[tauri::command]
pub async fn desktop_recording_prepare(state: tauri::State<'_, CaptureState>, capture_ref: String,
    frames: Vec<happier_desktop_native::capture::files::RecordingFrameInput>, video_ref: Option<String>,
    include_video: bool, has_marks: bool, include_window_text: bool)
    -> Result<happier_desktop_native::capture::files::PreparedRecording, CaptureError> {
    let state = state.inner().clone();
    commands::blocking(move || {
        let prepared = state.0.files.lock().unwrap().prepare_recording(&capture_ref, frames, video_ref.as_deref(),
            include_video, CaptureDisclosure { has_marks, include_window_text }, &CancelSignal::default());
        prepared
    }).await
}

#[tauri::command]
pub async fn desktop_recording_timing(state: tauri::State<'_, CaptureState>, capture_ref: String)
    -> Result<happier_desktop_native::capture::files::VideoTiming, CaptureError> {
    let state = state.inner().clone();
    commands::blocking(move || {
        let timing = state.0.files.lock().unwrap().video_timing(&capture_ref);
        timing
    }).await
}

#[cfg(test)]
mod document_tests {
    use super::*;
    use happier_desktop_native::capture::{files::RecordingFrameInput, MediaKind, PixelSize, RgbaFrame};

    #[test]
    fn completed_recordings_keep_documents_and_export_cancellation_per_capture() {
        let state = CaptureState::default();
        let root = tempfile::tempdir().unwrap();
        let mut refs = Vec::new();
        for pin in [200, 400] {
            let mut files = state.0.files.lock().unwrap();
            let (capture_ref, path) = files.allocate_video(root.path(), recording::Format::Mp4).unwrap();
            std::fs::write(&path, b"completed-native-video").unwrap();
            files.complete_video(CaptureResult { capture_ref: capture_ref.clone(), path, kind: MediaKind::Video,
                mime_type: "video/mp4".into(), byte_size: 0, pixel_size: PixelSize { width: 2, height: 2 },
                scale: None, origin: None, source: None, window_text_ref: None }).unwrap();
            drop(files);
            state.open(&capture_ref, None).unwrap();
            state.write_recording_document(&capture_ref, serde_json::json!({"pins": [pin]}), true, None).unwrap();
            refs.push(capture_ref);
        }
        let (first_operation, first_cancel) = state.begin_recording_trim(&refs[0]).unwrap();
        let (second_operation, second_cancel) = state.begin_recording_trim(&refs[1]).unwrap();
        state.cancel_window_text_for_window(&state.window_label_for_capture(&refs[0]).unwrap());
        assert!(first_cancel.is_cancelled());
        assert!(!second_cancel.is_cancelled());
        assert_eq!(state.read_recording_document(&refs[0]), Some(serde_json::json!({"pins": [200]})));
        assert_eq!(state.read_recording_document(&refs[1]), Some(serde_json::json!({"pins": [400]})));
        state.settle(&refs[0]).unwrap();
        state.finish_recording_trim(first_operation);
        assert!(state.read_recording_document(&refs[0]).is_none());
        assert!(!second_cancel.is_cancelled());
        state.discard(&refs[0]).unwrap();
        assert!(state.read_source(&refs[1]).is_ok());
        state.cancel_recording_trim(&refs[1]).unwrap();
        assert!(second_cancel.is_cancelled());
        state.finish_recording_trim(second_operation);
    }

    #[test]
    fn system_source_note_has_no_native_effect_until_continue_and_hide_cancels_it() {
        let state = CaptureState::default();
        let selected = state.select_system_recording(CaptureStartOptions { present_capture_window: false, ..CaptureStartOptions::default() }).unwrap();
        assert!(matches!(selected, CaptureSnapshot::SystemSelection { mode: CaptureMode::Recording, .. }));
        assert_eq!(state.capture_window_snapshot(), Some(selected), "system consent scope is replayed even for headless agent capture");
        assert!(state.active_recording().is_none(), "the scope note opens no portal or encoder");
        state.cancel_window_text();
        assert_eq!(state.snapshot(), CaptureSnapshot::Cancelled, "hiding the note retires its pending selection");
        assert!(state.0.operation.lock().unwrap().active.is_none());
    }

    #[test]
    fn system_selected_recording_uses_shared_lifecycle_and_actual_webm_library_result() {
        struct Encoder(std::path::PathBuf);
        impl recording::Backend for Encoder {
            fn start(&mut self) -> Result<(), CaptureError> { Ok(()) }
            fn finish(&mut self, _: u64) -> Result<Option<CaptureError>, CaptureError> {
                std::fs::write(&self.0, b"completed OS writer output").unwrap(); Ok(None)
            }
            fn cancel(&mut self) {}
        }
        let state = CaptureState::default();
        let root = tempfile::tempdir().unwrap();
        let target = CaptureSessionTarget { server_id: "home".into(), account_id: "account".into(), session_id: "session".into() };
        let selection = state.select_system_recording(CaptureStartOptions { target_session: Some(target.clone()), present_capture_window: true, ..CaptureStartOptions::default() }).unwrap();
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
        assert_eq!(state.select_system_recording(CaptureStartOptions::default()).unwrap(), selection,
            "repeated entry cannot open the portal before the person's explicit selection commit");
        assert!(matches!(state.start_system_recording(selection.operation_ref().unwrap()+1, root.path(), |_, _, _, _| {
            panic!("stale Continue must not acquire a source")
        }), Err(CaptureError::OperationUnavailable)));
        let snapshot = state.start_system_recording(selection.operation_ref().unwrap(), root.path(), |path, _, _, _| {
            assert_eq!(path.extension().unwrap(), "webm");
            Ok(recording::PreparedBackend { backend: Box::new(Encoder(path.to_owned())),
                pixel_size: PixelSize { width: 64, height: 48 }, scale: None, origin: None, source: None })
        }).unwrap();
        let session = state.recording_session(snapshot.operation_ref().unwrap()).unwrap();
        assert_eq!(session.pause().unwrap().phase, Phase::Paused);
        assert_eq!(session.resume().unwrap().phase, Phase::Recording);
        assert_eq!(session.stop().unwrap().phase, Phase::Ready);
        let CaptureSnapshot::Completed { result, target_session, .. } = state.snapshot() else { panic!("shared completion"); };
        assert_eq!(result.mime_type, "video/webm");
        assert_eq!(result.scale, None, "a system-granted source has no known desktop point scale");
        assert_eq!(result.path.extension().unwrap(), "webm");
        assert_eq!(target_session, Some(target));
        assert!(state.active_recording().is_none());
    }

    #[test]
    fn recording_trim_cancel_and_hide_settle_only_the_admitted_export() {
        let state = CaptureState::default();
        let root = tempfile::tempdir().unwrap();
        let mut files = state.0.files.lock().unwrap();
        let (capture_ref, path) = files.allocate_video(root.path(), recording::Format::Mp4).unwrap();
        std::fs::write(&path, b"completed-native-video").unwrap();
        files.complete_video(CaptureResult { capture_ref: capture_ref.clone(), path, kind: MediaKind::Video,
            mime_type: "video/mp4".into(), byte_size: 0, pixel_size: PixelSize { width: 2, height: 2 },
            scale: None, origin: None, source: None, window_text_ref: None }).unwrap();
        drop(files);
        state.open(&capture_ref, None).unwrap();
        let document = serde_json::json!({"pins": [200]});
        state.write_recording_document(&capture_ref, document.clone(), true, None).unwrap();
        let (operation, cancelled) = state.begin_recording_trim(&capture_ref).unwrap();
        assert!(matches!(state.begin_recording_trim(&capture_ref), Err(CaptureError::OperationUnavailable)));
        state.cancel_recording_trim(&capture_ref).unwrap();
        assert!(cancelled.is_cancelled(), "explicit abort reaches the admitted native export");
        state.finish_recording_trim(operation);

        let (operation, hidden) = state.begin_recording_trim(&capture_ref).unwrap();
        state.cancel_window_text();
        assert!(hidden.is_cancelled(), "hiding this capture releases its export demand");
        assert_eq!(state.read_recording_document(&capture_ref), Some(document));
        state.finish_recording_trim(operation);

        let (operation, headless) = state.begin_recording_trim(&capture_ref).unwrap();
        state.0.operation.lock().unwrap().completed.get_mut(&capture_ref).unwrap().active.as_mut().unwrap().options.present_capture_window = false;
        state.cancel_window_text();
        assert!(!headless.is_cancelled(), "an unrelated hidden window cannot cancel headless delivery");
        state.settle(&capture_ref).unwrap();
        assert!(headless.is_cancelled(), "settling the owning operation stops its finite export");
        state.open(&capture_ref, None).unwrap();
        let (fresh_operation, fresh) = state.begin_recording_trim(&capture_ref).unwrap();
        state.finish_recording_trim(operation);
        state.cancel_recording_trim(&capture_ref).unwrap();
        assert!(fresh.is_cancelled(), "old completion cannot clear a reopened operation's cancellation slot");
        state.finish_recording_trim(fresh_operation);
    }

    #[test]
    fn recording_document_survives_hidden_reopen_invalidates_outputs_and_settles_with_operation() {
        let state = CaptureState::default();
        let root = tempfile::tempdir().unwrap();
        let mut files = state.0.files.lock().unwrap();
        let (capture_ref, path) = files.allocate_video(root.path(), recording::Format::Mp4).unwrap();
        // The encoder completion is the system boundary; this test exercises authoring, not decoding.
        std::fs::write(&path, b"completed-native-video").unwrap();
        files.complete_video(CaptureResult { capture_ref: capture_ref.clone(), path, kind: MediaKind::Video,
            mime_type: "video/mp4".into(), byte_size: 0, pixel_size: PixelSize { width: 2, height: 2 },
            scale: None, origin: None, source: None, window_text_ref: None }).unwrap();
        drop(files);
        let opened = state.open(&capture_ref, None).unwrap();
        let publications = Arc::new(Mutex::new(Vec::new()));
        let observed = publications.clone();
        state.set_publisher(Arc::new(move |snapshot, present, _, _, _| observed.lock().unwrap().push((snapshot.clone(), present))));
        let document = serde_json::json!({"sourceCaptureRef": capture_ref, "pins": [200], "opaquePayload": {"keep": true}});
        assert_eq!(state.read_recording_document(&capture_ref), None);
        state.write_recording_document(&capture_ref, document.clone(), true, None).unwrap();
        assert_eq!(*publications.lock().unwrap(), vec![(opened.clone(), true)], "metadata change pushes current snapshot without a new operation");
        state.cancel_window_text(); // Capture-window hide retains the authoring operation.
        assert_eq!(state.open(&capture_ref, None).unwrap(), opened);
        assert_eq!(state.read_recording_document(&capture_ref), Some(document.clone()));
        assert_eq!(state.read_recording_document("not-current"), None);
        assert_eq!(state.write_recording_document("not-current", document.clone(), false, Some(document.clone())), Err(CaptureError::OperationUnavailable));

        let png = RgbaFrame { width: 1, height: 1, rgba: vec![1, 2, 3, 255] }.png().unwrap();
        state.0.files.lock().unwrap().prepare_recording(&capture_ref,
            vec![RecordingFrameInput { time_ms: 200, bytes: png, note: None }], None, false,
            CaptureDisclosure { has_marks: true, include_window_text: false }, &CancelSignal::default()).unwrap();
        state.write_recording_document(&capture_ref, document.clone(), false, Some(document.clone())).unwrap();
        assert!(state.delivery_state(&capture_ref).unwrap().prepared_recording.is_some(), "identical document preserves prepared bytes");
        assert_eq!(publications.lock().unwrap().len(), 1, "identical payload and same reopen publish nothing");
        let edited = serde_json::json!({"pins": [400]});
        state.write_recording_document(&capture_ref, edited.clone(), false, Some(document.clone())).unwrap();
        assert_eq!(state.write_recording_document(&capture_ref, document.clone(), true, None).unwrap(), edited,
            "a delayed initializer in another renderer cannot replace committed edits");
        assert_eq!(publications.lock().unwrap().len(), 2, "an initializer reuses existing authoring without invalidating or publishing");
        let delivery = state.delivery_state(&capture_ref).unwrap();
        assert_eq!(delivery.prepared_recording, None, "changed edits cannot deliver stale output");
        assert_eq!(delivery.disclosure, None);
        state.settle(&capture_ref).unwrap();
        assert_eq!(state.read_recording_document(&capture_ref), None);
        assert_eq!(state.write_recording_document(&capture_ref, document.clone(), false, Some(document.clone())), Err(CaptureError::OperationUnavailable));
        state.open(&capture_ref, None).unwrap();
        assert_eq!(state.read_recording_document(&capture_ref), None, "a settled operation is not a library document registry");
        state.settle(&capture_ref).unwrap();
        let still = state.open_file(|files| files.write_png(root.path(), &RgbaFrame {
            width: 1, height: 1, rgba: vec![1, 2, 3, 255] }.png().unwrap())).unwrap();
        assert_eq!(state.write_recording_document(&still.capture_ref, document.clone(), false, Some(document)), Err(CaptureError::OperationUnavailable));
    }

    #[test]
    fn stale_recording_write_cannot_replace_committed_blur_disclosure_or_prepared_pixels() {
        let state = CaptureState::default();
        let root = tempfile::tempdir().unwrap();
        let mut files = state.0.files.lock().unwrap();
        let (capture_ref, path) = files.allocate_video(root.path(), recording::Format::Mp4).unwrap();
        std::fs::write(&path, b"completed-native-video").unwrap();
        files.complete_video(CaptureResult { capture_ref: capture_ref.clone(), path, kind: MediaKind::Video,
            mime_type: "video/mp4".into(), byte_size: 0, pixel_size: PixelSize { width: 2, height: 2 },
            scale: None, origin: None, source: None, window_text_ref: None }).unwrap();
        drop(files);
        state.open(&capture_ref, None).unwrap();
        let baseline = serde_json::json!({"pins": [], "frames": [], "videoDisclosure": {"included": true, "blurCount": 0}});
        state.write_recording_document(&capture_ref, baseline.clone(), true, None).unwrap();
        let blurred = serde_json::json!({"pins": [], "frames": [{"sourceTimeMs": 200, "document": {
            "v": 1, "image": {"width": 2, "height": 2, "scale": 1}, "marks": [{"id": "private", "kind": "blur",
                "rect": {"x": 0, "y": 0, "width": 2, "height": 2}, "size": "s"}]}}],
            "videoDisclosure": {"included": false, "blurCount": 1}, "windowTextDisclosure": {"included": false, "blurCount": 1}});
        state.write_recording_document(&capture_ref, blurred.clone(), false, Some(baseline.clone())).unwrap();
        let png = RgbaFrame { width: 1, height: 1, rgba: vec![50, 50, 50, 255] }.png().unwrap();
        let prepared = state.0.files.lock().unwrap().prepare_recording(&capture_ref,
            vec![RecordingFrameInput { time_ms: 200, bytes: png.clone(), note: None }], None, false,
            CaptureDisclosure { has_marks: true, include_window_text: false }, &CancelSignal::default()).unwrap();
        let before = state.delivery_state(&capture_ref).unwrap();
        let stale_pin = serde_json::json!({"pins": [400], "frames": [], "videoDisclosure": {"included": true, "blurCount": 0}});
        assert_eq!(state.write_recording_document(&capture_ref, stale_pin, false, Some(baseline)), Err(CaptureError::CaptureInUse));
        assert_eq!(state.write_recording_document(&capture_ref, blurred.clone(), false, None), Err(CaptureError::CaptureInUse),
            "ordinary writers cannot omit the baseline");
        assert_eq!(state.read_recording_document(&capture_ref), Some(blurred.clone()));
        assert_eq!(state.delivery_state(&capture_ref).unwrap(), before);
        assert_eq!(state.0.files.lock().unwrap().read_prepared_png(&prepared.frames[0].frame_ref).unwrap(), png);
        let mut current_pin = blurred.clone(); current_pin["pins"] = serde_json::json!([400]);
        assert_eq!(state.write_recording_document(&capture_ref, current_pin.clone(), false, Some(blurred)).unwrap(), current_pin);
        assert!(state.delivery_state(&capture_ref).unwrap().prepared_recording.is_none());
    }
}
