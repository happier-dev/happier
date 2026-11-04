use super::*;
use happier_desktop_native::{capture::*, geometry::Rect};
use std::sync::{Arc, atomic::{AtomicBool, AtomicUsize, Ordering}};

struct Os {
    hidden: Arc<AtomicBool>,
    reads: AtomicUsize,
    discoveries: AtomicUsize,
    cancel_during_read: bool,
}
impl CaptureBackend for Os {
    fn discover(&self) -> Result<Inventory, CaptureError> {
        self.discoveries.fetch_add(1, Ordering::Relaxed);
        Ok(Inventory::from_os(vec![DisplayDescriptor { display_id: 1,
            frame: Rect { x: -2., y: 0., width: 2., height: 1. }, scale: 2., desktop_scale: 1.,
            storage_key: None, localized_name: None, safe_area_top: 0., physical_notch_size: None }], vec![], 99))
    }
    fn capture_window(&self, _: u32, _include_shadow: bool, _: &CancelSignal) -> Result<RgbaFrame, CaptureError> { unreachable!() }
    fn capture_display(&self, _: u32, cancel: &CancelSignal) -> Result<RgbaFrame, CaptureError> {
        self.reads.fetch_add(1, Ordering::Relaxed);
        if self.cancel_during_read { cancel.cancel(); }
        Ok(RgbaFrame { width: 4, height: 2, rgba: vec![if self.hidden.load(Ordering::Acquire) { 211 } else { 17 }; 4*2*4] })
    }
}
fn os(cancel_during_read: bool) -> Arc<Os> {
    Arc::new(Os { hidden: Arc::new(AtomicBool::new(false)), reads: AtomicUsize::new(0),
        discoveries: AtomicUsize::new(0), cancel_during_read })
}

#[test]
fn completed_captures_keep_independent_targets_and_settlement() {
    let state = CaptureState::default();
    let publications = Arc::new(Mutex::new(Vec::new()));
    let observed = publications.clone();
    state.set_publisher(Arc::new(move |snapshot, _, _, label, current_operation| observed.lock().unwrap().push((label.to_owned(), snapshot.clone(), current_operation))));
    let folder = tempfile::tempdir().unwrap();
    let source = os(false);
    let take = |session: &str| state.start_with_target(CaptureMode::Still,
        Some(CaptureTarget::Display { display_id: 1 }),
        CaptureStartOptions { target_session: Some(CaptureSessionTarget {
            server_id: "home".into(), account_id: "account".into(), session_id: session.into(),
        }), ..CaptureStartOptions::default() },
        || Ok(source.clone()), folder.path(), || Ok(()), |_, _| unreachable!()).unwrap();
    let CaptureSnapshot::Completed { result: first, target_session: first_target, .. } = take("first") else { panic!("first capture"); };
    let CaptureSnapshot::Completed { result: second, target_session: second_target, .. } = take("second") else { panic!("second capture"); };
    assert_ne!(first.capture_ref, second.capture_ref, "a completed preview cannot block the next capture");
    assert_eq!(first_target.unwrap().session_id, "first");
    assert_eq!(second_target.unwrap().session_id, "second");
    let first_label = state.window_label_for_capture(&first.capture_ref).unwrap();
    let second_label = state.window_label_for_capture(&second.capture_ref).unwrap();
    assert_eq!(first_label, "capture");
    assert_ne!(first_label, second_label);
    assert!(crate::desktop_window::is_capture_window(&second_label));
    assert!(matches!(state.snapshot_for_window(&first_label), CaptureSnapshot::Completed { target_session: Some(target), .. } if target.session_id == "first"));
    assert!(matches!(state.snapshot_for_window(&second_label), CaptureSnapshot::Completed { target_session: Some(target), .. } if target.session_id == "second"));
    assert!(state.delivery_state(&first.capture_ref).unwrap().in_use);
    assert!(state.delivery_state(&second.capture_ref).unwrap().in_use);
    state.open(&first.capture_ref, Some(CaptureSessionTarget {
        server_id: "home".into(), account_id: "account".into(), session_id: "first-chosen".into(),
    })).unwrap();
    let (updated_label, _, current_operation) = publications.lock().unwrap().last().cloned().unwrap();
    assert_eq!(updated_label, first_label);
    assert!(!current_operation, "an older editor's metadata cannot replace main's current operation or retire a newer recording's marks");
    let before_settlement = publications.lock().unwrap().len();
    state.settle(&first.capture_ref).unwrap();
    assert_eq!(publications.lock().unwrap().len(), before_settlement, "settling an older preview cannot retire the new operation's event stream");
    assert!(matches!(state.snapshot_for_window(&second_label), CaptureSnapshot::Completed { result, .. } if result.capture_ref == second.capture_ref));
    assert!(!state.delivery_state(&first.capture_ref).unwrap().in_use);
    assert!(state.delivery_state(&second.capture_ref).unwrap().in_use);
    assert_eq!(state.read_source(&second.capture_ref).unwrap(), state.read_source(&first.capture_ref).unwrap());
    state.discard(&first.capture_ref).unwrap();
    assert!(state.read_source(&first.capture_ref).is_err());
    assert!(state.read_source(&second.capture_ref).is_ok());
    assert!(state.delivery_state(&second.capture_ref).unwrap().in_use);
    state.release_window(&first_label);
    let CaptureSnapshot::Completed { result: third, .. } = take("third") else { panic!("third capture"); };
    assert_eq!(state.window_label_for_capture(&third.capture_ref).as_deref(), Some("capture"), "one freed standby label is reused");
    assert!(state.delivery_state(&second.capture_ref).unwrap().in_use);
    assert_eq!(state.previous_window_label("capture_4", &[second_label.clone(), "capture".into()]).as_deref(), Some("capture"),
        "a reused standby is newer than its surviving numbered sibling");
    assert_eq!(state.previous_window_label("capture_4", &[second_label.clone()]).as_deref(), Some(second_label.as_str()),
        "hidden siblings do not influence placement");
}

#[test]
fn each_presented_capture_prepares_its_own_hidden_host_before_acquisition() {
    let state = CaptureState::default();
    let folder = tempfile::tempdir().unwrap();
    let prepared = Arc::new(Mutex::new(std::collections::HashSet::new()));
    let observed = prepared.clone();
    let source = os(false);
    let hidden = source.hidden.clone();
    // Native webview construction is the OS boundary; admission, assignment and acquisition stay real.
    state.set_publisher(Arc::new(move |snapshot, present, _, label, _| {
        commands::prepare_window(snapshot, present, label, |label| {
            observed.lock().unwrap().insert(label.to_owned());
            hidden.store(true, Ordering::Release);
            Ok(())
        }).unwrap();
    }));
    let take = |present| state.start_with_target(CaptureMode::Still,
        Some(CaptureTarget::Display { display_id: 1 }),
        CaptureStartOptions { present_capture_window: present, ..CaptureStartOptions::default() },
        || Ok(source.clone()), folder.path(), || {
            assert!(source.hidden.load(Ordering::Acquire), "the assigned hidden webview must exist before native acquisition");
            Ok(())
        }, |_, _| unreachable!()).unwrap();
    let CaptureSnapshot::Completed { result: first, .. } = take(true) else { panic!("first capture"); };
    source.hidden.store(false, Ordering::Release);
    let CaptureSnapshot::Completed { result: second, .. } = take(true) else { panic!("second capture"); };
    assert_eq!(*prepared.lock().unwrap(), std::collections::HashSet::from([
        state.window_label_for_capture(&first.capture_ref).unwrap(),
        state.window_label_for_capture(&second.capture_ref).unwrap(),
    ]));
    let before_headless = prepared.lock().unwrap().clone();
    take(false);
    assert_eq!(*prepared.lock().unwrap(), before_headless, "headless captures do not grow the host pool");
}

#[test]
fn opening_headless_media_does_not_take_the_active_recording_window() {
    let state = CaptureState::default();
    let folder = tempfile::tempdir().unwrap();
    let CaptureSnapshot::Completed { result, .. } = state.start_with_target(CaptureMode::Still,
        Some(CaptureTarget::Display { display_id: 1 }),
        CaptureStartOptions { present_capture_window: false, ..CaptureStartOptions::default() },
        || Ok(os(false)), folder.path(), || Ok(()), |_, _| unreachable!()).unwrap() else { panic!("headless capture"); };
    assert!(state.window_label_for_capture(&result.capture_ref).is_none(), "headless captures do not reserve a host");
    let recording = state.select_system_recording(CaptureStartOptions::default()).unwrap();
    let recording_label = state.current_window_label();
    state.open(&result.capture_ref, None).unwrap();
    let opened_label = state.window_label_for_capture(&result.capture_ref).unwrap();
    assert_ne!(opened_label, recording_label, "opening retained media cannot occupy the current recorder's host");
    assert_eq!(state.current_window_label(), recording_label);
    assert_eq!(state.snapshot_for_window(&recording_label), recording);
    assert!(matches!(state.snapshot_for_window(&opened_label), CaptureSnapshot::Completed { .. }));
}

#[test]
fn reopening_a_retained_off_capture_rearms_its_text_owner() {
    use happier_desktop_native::capture::window_text::{WindowTextOutcome, WindowTextUnavailable};
    let state = CaptureState::default();
    let folder = tempfile::tempdir().unwrap();
    let png = RgbaFrame { width: 1, height: 1, rgba: vec![1, 2, 3, 255] }.png().unwrap();
    let capture = state.open_file(|files| files.write_png(folder.path(), &png)).unwrap();
    let cancel = state.0.operation.lock().unwrap().completed.get(&capture.capture_ref).unwrap().active.as_ref().unwrap().cancel.clone();
    state.0.files.lock().unwrap().bind_window_text(&capture.capture_ref, Some(WindowDescriptor {
        window_id: 9, process_id: 80, frame: Rect { x: 0., y: 0., width: 10., height: 10. },
        app_name: None, title: None, z_order: 0,
    }), cancel).unwrap();
    state.cancel_window_text();
    state.open(&capture.capture_ref, None).unwrap();
    let text = state.window_text_for_read(&capture.capture_ref, true).unwrap();
    let connections = AtomicUsize::new(0);
    assert_eq!(text.lock().unwrap().read_with(|| {
        connections.fetch_add(1, Ordering::Relaxed);
        Err(WindowTextUnavailable::ProviderUnavailable)
    }), WindowTextOutcome::Unavailable { reason: WindowTextUnavailable::ProviderUnavailable, source: None, scope: None });
    assert_eq!(connections.load(Ordering::Relaxed), 1);
    state.settle(&capture.capture_ref).unwrap();
    state.open(&capture.capture_ref, None).unwrap();
    text.lock().unwrap().read_with(|| {
        connections.fetch_add(1, Ordering::Relaxed);
        Err(WindowTextUnavailable::ProviderUnavailable)
    });
    assert_eq!(connections.load(Ordering::Relaxed), 2);
}

#[test]
fn portal_media_is_imported_once_without_a_selector_inventory_or_a_second_capture() {
    let state = CaptureState::default();
    let publications = Arc::new(AtomicUsize::new(0));
    let observed = publications.clone();
    state.set_publisher(Arc::new(move |_, _, _, _, _| { observed.fetch_add(1, Ordering::Relaxed); }));
    let root = tempfile::tempdir().unwrap();
    let png = RgbaFrame { width: 1, height: 1, rgba: vec![13, 29, 47, 255] }.png().unwrap();
    let requests = AtomicUsize::new(0);
    let done = state.start_portal(root.path(), CaptureStartOptions::default(), || None, |_| { requests.fetch_add(1, Ordering::Relaxed); Ok(png.clone()) }).unwrap();
    let CaptureSnapshot::Completed { result, .. } = done else { panic!("portal must produce completed media") };
    assert_eq!(requests.load(Ordering::Relaxed), 1);
    assert_eq!(state.read_source(&result.capture_ref).unwrap(), png);
    assert_eq!(result.origin, None);
    assert_eq!(result.scale, None);
    assert_eq!(result.source, None);
    let text = state.window_text_for_read(&result.capture_ref, true).unwrap();
    assert_eq!(text.lock().unwrap().read_with(|| panic!("absent preportal context must not borrow Happier after portal")),
        window_text::WindowTextOutcome::Unavailable { reason: window_text::WindowTextUnavailable::NoWindowContext,
            source: None, scope: Some(window_text::WindowTextScope::WholeFrontmostWindow) });
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    // Acquisition has finished: the next trigger admits a new independent capture.
    let next = state.start_portal(root.path(), CaptureStartOptions::default(), || None, |_| { requests.fetch_add(1, Ordering::Relaxed); Ok(png.clone()) }).unwrap();
    assert!(matches!(next, CaptureSnapshot::Completed { result: next, .. } if next.capture_ref != result.capture_ref));
    assert_eq!(requests.load(Ordering::Relaxed), 2);
    assert_eq!(publications.load(Ordering::Relaxed), 4);
}

#[test]
fn portal_binds_preconsent_frontmost_metadata_without_claiming_crop_identity_or_reading_text_off() {
    use happier_desktop_native::capture::window_text::*;
    let state = CaptureState::default();
    let root = tempfile::tempdir().unwrap();
    let png = RgbaFrame { width: 1, height: 1, rgba: vec![13, 29, 47, 255] }.png().unwrap();
    let metadata_reads = AtomicUsize::new(0);
    let provider_reads = AtomicUsize::new(0);
    let done = state.start_portal(root.path(), CaptureStartOptions::default(), || {
        metadata_reads.fetch_add(1, Ordering::Relaxed);
        Some(FrontmostWindowContext { process_id: 80,
            identity: AtspiWindowIdentity { bus_name: ":1.80".into(), object_path: "/chosen".into() },
            app_name: Some("Before portal app".into()), window_title: Some("Before portal window".into()) })
    }, |_| {
        assert_eq!(metadata_reads.load(Ordering::Relaxed), 1, "context is captured before consent/focus changes");
        Ok(png.clone())
    }).unwrap();
    let CaptureSnapshot::Completed { result, .. } = done else { panic!("portal media must remain usable") };
    assert_eq!(result.source, None, "the portal never identifies its chosen crop/window");
    assert_eq!(result.origin, None);
    assert_eq!(result.window_text_ref.as_deref(), Some(result.capture_ref.as_str()));
    assert_eq!(provider_reads.load(Ordering::Relaxed), 0, "Off performs no provider text traversal");
    let text = state.window_text_for_read(&result.capture_ref, true).unwrap();
    assert!(text.lock().unwrap().settled().is_none());
    assert_eq!(text.lock().unwrap().read_with(|| {
        provider_reads.fetch_add(1, Ordering::Relaxed);
        Err(WindowTextUnavailable::PermissionRequired)
    }), WindowTextOutcome::Unavailable { reason: WindowTextUnavailable::PermissionRequired,
        source: Some(CaptureSource { app_name: Some("Before portal app".into()), window_title: Some("Before portal window".into()), window_id: None }),
        scope: Some(WindowTextScope::WholeFrontmostWindow) });
    assert_eq!(provider_reads.load(Ordering::Relaxed), 1, "first enable reaches the existing text owner");
    assert!(state.delivery_state(&result.capture_ref).unwrap().in_use);
}

#[test]
fn portal_cancellation_releases_pending_work_and_a_late_response_creates_no_file() {
    let state = CaptureState::default();
    let root = tempfile::tempdir().unwrap();
    let folder = root.path().to_owned();
    let (started_tx, started_rx) = std::sync::mpsc::channel();
    let pending = state.clone();
    let worker = std::thread::spawn(move || pending.start_portal(&folder, CaptureStartOptions::default(), || None, |cancel| {
        let (tx, rx) = std::sync::mpsc::channel();
        cancel.on_cancel(move || { let _ = tx.send(()); });
        started_tx.send(()).unwrap();
        rx.recv().unwrap();
        Ok(RgbaFrame { width: 1, height: 1, rgba: vec![13, 29, 47, 255] }.png().unwrap())
    }).unwrap());
    started_rx.recv().unwrap();
    let pending = state.snapshot();
    assert!(matches!(pending, CaptureSnapshot::Acquiring { .. }));
    assert_eq!(state.start_portal(root.path(), CaptureStartOptions::default(), || None, |_| panic!("no second request while pending")).unwrap(), pending);
    state.cancel(pending.operation_ref().unwrap()).unwrap();
    assert!(matches!(worker.join().unwrap(), CaptureSnapshot::Cancelled));
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    assert!(matches!(state.start_portal(root.path(), CaptureStartOptions::default(), || None, |_| Err(CaptureError::PortalUnavailable)).unwrap(),
        CaptureSnapshot::Unavailable { reason: CaptureError::PortalUnavailable }));
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

#[test]
fn one_operation_acquires_undimmed_pixels_once_and_keeps_current_result() {
    let state = CaptureState::default();
    let publications = Arc::new(AtomicUsize::new(0));
    let effects = publications.clone();
    state.set_publisher(Arc::new(move |_, _, _, _, _| { effects.fetch_add(1, Ordering::Relaxed); }));
    assert_eq!(publications.load(Ordering::Relaxed), 0);
    let os = os(false);
    let start = state.begin(CaptureMode::Still, || Ok(os.clone())).unwrap();
    let id = start.operation_ref().unwrap();
    state.begin(CaptureMode::Still, || panic!("duplicate must not initialize native backend")).unwrap();
    let root = tempfile::tempdir().unwrap();
    let done = state.commit(id, CaptureTarget::Display { display_id: 1 }, root.path(), || {
        os.hidden.store(true, Ordering::Release); Ok(())
    }).unwrap();
    let CaptureSnapshot::Completed { result, .. } = done else { panic!("expected completed capture") };
    let bytes = state.read_source(&result.capture_ref).unwrap();
    let mut reader = png::Decoder::new(bytes.as_slice()).read_info().unwrap();
    let mut pixels = vec![0; reader.output_buffer_size()];
    reader.next_frame(&mut pixels).unwrap();
    assert!(pixels.iter().all(|b| *b == 211));
    assert_eq!(os.reads.load(Ordering::Relaxed), 1);
    assert_eq!(os.discoveries.load(Ordering::Relaxed), 1);
    assert!(matches!(state.commit(id, CaptureTarget::Display { display_id: 1 }, root.path(), || panic!("no second capture")), Err(CaptureError::OperationUnavailable)));
    assert!(matches!(state.snapshot_for_capture(&result.capture_ref), Some(CaptureSnapshot::Completed { .. })));
    assert_eq!(os.reads.load(Ordering::Relaxed), 1);
    assert_eq!(publications.load(Ordering::Relaxed), 3, "selecting, acquiring and completed only; no unchanged publication");
}

#[test]
fn cancel_before_or_during_acquisition_publishes_no_media() {
    let state = CaptureState::default();
    let os = os(false);
    let id = state.begin(CaptureMode::Still, || Ok(os.clone())).unwrap().operation_ref().unwrap();
    assert!(matches!(state.cancel(id).unwrap(), CaptureSnapshot::Cancelled));
    let root = tempfile::tempdir().unwrap();
    assert!(state.commit(id, CaptureTarget::Display { display_id: 1 }, root.path(), || Ok(())).is_err());
    assert_eq!(os.reads.load(Ordering::Relaxed), 0);
    let os = self::os(true);
    let id = state.begin(CaptureMode::Still, || Ok(os.clone())).unwrap().operation_ref().unwrap();
    assert!(matches!(state.commit(id, CaptureTarget::Display { display_id: 1 }, root.path(), || Ok(())).unwrap(), CaptureSnapshot::Cancelled));
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

#[test]
fn recording_selection_has_no_still_file_or_encoder_effect() {
    let state = CaptureState::default(); let os = os(false);
    let id = state.begin(CaptureMode::Recording, || Ok(os.clone())).unwrap().operation_ref().unwrap();
    let root = tempfile::tempdir().unwrap();
    assert!(matches!(state.commit(id, CaptureTarget::Display { display_id: 1 }, root.path(), || Ok(())).unwrap(), CaptureSnapshot::Selected { .. }));
    assert_eq!(os.reads.load(Ordering::Relaxed), 0);
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

#[test]
fn selection_mode_is_owned_and_published_by_the_current_native_operation() {
    let state = CaptureState::default(); let os = os(false);
    let publications = Arc::new(Mutex::new(Vec::new()));
    let observed = publications.clone();
    state.set_publisher(Arc::new(move |snapshot, _, _, _, _| { observed.lock().unwrap().push(snapshot.clone()); }));
    let id = state.begin(CaptureMode::Still, || Ok(os.clone())).unwrap().operation_ref().unwrap();
    let caller = format!("capture_selection_{}_1", id);
    let switched = state.set_selection_mode(id, &caller, CaptureMode::Recording).unwrap();
    assert!(matches!(switched, CaptureSnapshot::Selecting { operation_ref, mode: CaptureMode::Recording, .. } if operation_ref == id));
    assert_eq!(state.snapshot(), switched);
    assert_eq!(publications.lock().unwrap().last(), Some(&switched));
    state.set_selection_mode(id, &caller, CaptureMode::Recording).unwrap();
    assert_eq!(publications.lock().unwrap().len(), 2, "one push per change, no duplicate or rediscovery");
    for (operation_ref, label) in [(id, "main".to_owned()), (id, format!("capture_selection_{}_99", id)),
        (id + 1, caller.clone()), (id, format!("capture_selection_{}_1", id + 1))] {
        assert_eq!(state.set_selection_mode(operation_ref, &label, CaptureMode::Still), Err(CaptureError::OperationUnavailable));
        assert_eq!(state.snapshot(), switched);
    }
    let still = state.set_selection_mode(id, &caller, CaptureMode::Still).unwrap();
    assert!(matches!(still, CaptureSnapshot::Selecting { mode: CaptureMode::Still, .. }));
    assert_eq!(state.commit_with_folder(id, CaptureTarget::Display { display_id: 1 },
        || Err(CaptureError::FileIo), || panic!("folder failure cannot hide selection")), Err(CaptureError::FileIo));
    assert_eq!(state.snapshot(), still, "failed folder admission keeps selection available");
    state.set_selection_mode(id, &caller, CaptureMode::Recording).unwrap();
    let root = tempfile::tempdir().unwrap();
    assert!(matches!(state.commit_with_folder(id, CaptureTarget::Display { display_id: 1 },
        || panic!("the chosen recording mode needs no still-image folder"), || Ok(())).unwrap(), CaptureSnapshot::Selected { .. }));
    assert_eq!(state.set_selection_mode(id, &caller, CaptureMode::Still), Err(CaptureError::OperationUnavailable));
    assert_eq!(os.reads.load(Ordering::Relaxed), 0);
    assert_eq!(os.discoveries.load(Ordering::Relaxed), 1);
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    state.start_recording(root.path()).unwrap(); // This OS fixture has no recorder.
    let recovery::CaptureRetry::Start(request) = state.prepare_retry().unwrap() else { panic!("retry selected recording"); };
    assert_eq!(request.mode, CaptureMode::Recording, "the selection toggle also owns the retry's mode");
    assert_eq!(request.target, None, "a person-selected source retries through selection");
}

#[test]
fn failed_recording_source_has_a_discardable_reference_without_a_playable_result() {
    let state = CaptureState::default(); let source = os(false);
    let root = tempfile::tempdir().unwrap();
    state.start_with_target(CaptureMode::Recording, Some(CaptureTarget::Display { display_id: 1 }), CaptureStartOptions::default(),
        || Ok(source), root.path(), || Ok(()), |_, _| panic!("explicit target has no selector")).unwrap();
    let CaptureSnapshot::Recording { recording, .. } = state.start_recording(root.path()).unwrap() else { panic!("recording failure") };
    assert_eq!(recording.phase, happier_desktop_native::capture::recording::Phase::Failed);
    assert!(recording.result.is_none());
    let capture_ref = recording.source_ref.expect("partial source identity");
    assert!(state.0.files.lock().unwrap().describe(&capture_ref).is_err());
    let request = state.0.operation.lock().unwrap().last_start.clone().unwrap();
    let mut different_request = request.clone(); different_request.mode = CaptureMode::Still;
    assert_eq!(state.recover_matching_start(&different_request).unwrap(), Some(state.snapshot()));
    assert!(state.active_recording().is_some(), "another request cannot silently replace the failed capture");
    assert!(state.recover_matching_start(&request).unwrap().is_none());
    assert!(state.active_recording().is_none(), "an explicit matching start can replace an unrecoverable failed preparation");
    state.discard(&capture_ref).unwrap();
    assert_eq!(state.snapshot(), CaptureSnapshot::Idle);
    assert!(state.active_recording().is_none());
}

#[test]
fn selected_recording_reuses_the_source_and_completes_the_library_only_after_native_finish() {
    struct Encoder { path: std::path::PathBuf, finished: Arc<AtomicBool> }
    impl happier_desktop_native::capture::recording::Backend for Encoder {
        fn start(&mut self) -> Result<(), CaptureError> { Ok(()) }
        fn finish(&mut self, _: u64) -> Result<Option<CaptureError>, CaptureError> {
            std::fs::write(&self.path, b"native encoder bytes").unwrap();
            self.finished.store(true, Ordering::SeqCst); Ok(None)
        }
        fn cancel(&mut self) {}
    }
    struct Source { inventory: Inventory, finished: Arc<AtomicBool>, starts: AtomicUsize }
    impl CaptureBackend for Source {
        fn discover(&self) -> Result<Inventory, CaptureError> { Ok(self.inventory.clone()) }
        fn capture_display(&self, _: u32, _: &CancelSignal) -> Result<RgbaFrame, CaptureError> { panic!("no still capture") }
        fn capture_window(&self, _: u32, _include_shadow: bool, _: &CancelSignal) -> Result<RgbaFrame, CaptureError> { panic!("no still capture") }
        fn prepare_recording(&self, inventory: &Inventory, _: &CaptureTarget, path: &Path,
            _: Arc<Mutex<happier_desktop_native::capture::recording::Timeline>>,
            _: Arc<dyn Fn(CaptureError) + Send + Sync>) -> Result<happier_desktop_native::capture::recording::PreparedBackend, CaptureError> {
            self.starts.fetch_add(1, Ordering::SeqCst);
            assert_eq!(inventory, &self.inventory, "consume the selected inventory, never rediscover");
            Ok(happier_desktop_native::capture::recording::PreparedBackend {
                backend: Box::new(Encoder { path: path.to_owned(), finished: self.finished.clone() }),
                pixel_size: PixelSize { width: 4, height: 2 }, scale: Some(2.), origin: None, source: None,
            })
        }
    }
    let state = CaptureState::default();
    let finished = Arc::new(AtomicBool::new(false));
    let source = Arc::new(Source { inventory: os(false).discover().unwrap(), finished: finished.clone(), starts: AtomicUsize::new(0) });
    let root = tempfile::tempdir().unwrap();
    let selected = state.start_with_target(CaptureMode::Recording, Some(CaptureTarget::Display { display_id: 1 }), CaptureStartOptions::default(),
        || Ok(source.clone()), root.path(), || Ok(()), |_, _| panic!("explicit target has no selector")).unwrap();
    assert!(matches!(selected, CaptureSnapshot::Selected { .. }));
    assert_eq!(source.starts.load(Ordering::SeqCst), 0);
    let started = state.start_recording(root.path()).unwrap();
    assert_eq!(serde_json::to_value(&started).unwrap()["status"], "recording");
    assert_eq!(source.starts.load(Ordering::SeqCst), 1);
    assert!(!finished.load(Ordering::SeqCst));
    let id = started.operation_ref().unwrap();
    let session = state.recording_session(id).unwrap();
    assert_eq!(session.pause().unwrap().phase, happier_desktop_native::capture::recording::Phase::Paused);
    assert_eq!(session.resume().unwrap().phase, happier_desktop_native::capture::recording::Phase::Recording);
    assert_eq!(session.stop().unwrap().phase, happier_desktop_native::capture::recording::Phase::Ready);
    let CaptureSnapshot::Completed { result, .. } = state.snapshot() else { panic!("finalized movie") };
    assert!(finished.load(Ordering::SeqCst));
    assert_eq!(result.kind, MediaKind::Video);
    assert_eq!(result.byte_size, b"native encoder bytes".len() as u64);
    assert_eq!(state.read_source(&result.capture_ref).unwrap(), b"native encoder bytes");
    assert!(state.active_recording().is_none());
    assert_eq!(state.0.operation.lock().unwrap().completed.get(&result.capture_ref).unwrap().active.as_ref().unwrap().inventory.displays, source.inventory.displays,
        "review placement retains source display facts without rediscovering or requesting capture permission");
    state.settle(&result.capture_ref).unwrap();
    assert!(result.path.exists(), "Send/Add settlement keeps the library file");
}

#[test]
fn a_duplicate_explicit_start_returns_existing_selection_without_acquisition() {
    let state = CaptureState::default(); let os = os(false);
    let hosts = AtomicUsize::new(0);
    let first = state.start_with_target(CaptureMode::Still, None, CaptureStartOptions::default(), || Ok(os.clone()), Path::new(""), || Ok(()),
        |_, _| { hosts.fetch_add(1, Ordering::Relaxed); Ok(()) }).unwrap();
    let repeated = state.start_with_target(CaptureMode::Recording, Some(CaptureTarget::Display { display_id: 1 }), CaptureStartOptions::default(),
        || panic!("no second backend"), Path::new(""), || panic!("existing work must not hide"),
        |_, _| panic!("duplicate cannot create another selector")).unwrap();
    assert_eq!(repeated, first);
    assert_eq!(hosts.load(Ordering::Relaxed), 1);
    assert_eq!(os.reads.load(Ordering::Relaxed), 0);
}

#[test]
fn settled_capture_keeps_source_and_prepared_files_and_can_be_reopened_without_acquisition() {
    let state = CaptureState::default();
    let publications = Arc::new(Mutex::new(Vec::new()));
    let observed = publications.clone();
    state.set_publisher(Arc::new(move |snapshot, present, _, _, _| observed.lock().unwrap().push((snapshot.clone(), present))));
    let backend = os(false);
    let root = tempfile::tempdir().unwrap();
    let id = state.begin(CaptureMode::Still, || Ok(backend.clone())).unwrap().operation_ref().unwrap();
    let done = state.commit(id, CaptureTarget::Display { display_id: 1 }, root.path(), || Ok(())).unwrap();
    let CaptureSnapshot::Completed { result, .. } = done else { panic!("expected completed capture") };
    let source = state.read_source(&result.capture_ref).unwrap();
    let prepared = RgbaFrame { width: 1, height: 1, rgba: vec![18, 37, 53, 255] }.png().unwrap();
    let disclosure = CaptureDisclosure { has_marks: true, include_window_text: false };
    state.0.files.lock().unwrap().write_prepared_png(&result.capture_ref, &prepared, disclosure).unwrap();

    assert!(matches!(state.settle(&result.capture_ref).unwrap(), CaptureSnapshot::Idle));
    assert_eq!(state.snapshot(), CaptureSnapshot::Idle, "delivery releases native operation authority");
    assert_eq!(publications.lock().unwrap().last(), Some(&(CaptureSnapshot::Idle, false)),
        "main receives settlement; Capture retains the current document through its receipt and hide");
    assert_eq!(state.read_source(&result.capture_ref).unwrap(), source);
    assert_eq!(state.0.files.lock().unwrap().read_prepared_png(&result.capture_ref).unwrap(), prepared);

    let next = state.begin(CaptureMode::Still, || Ok(backend.clone())).unwrap();
    assert_eq!(publications.lock().unwrap().last(), Some(&(next.clone(), true)), "the next operation reaches Capture normally");
    let published = publications.lock().unwrap().len();
    assert_eq!(state.settle(&result.capture_ref).unwrap(), next, "stale settlement cannot retire the next operation");
    assert_eq!(publications.lock().unwrap().len(), published, "stale settlement publishes nothing");
    state.cancel(next.operation_ref().unwrap()).unwrap();
    let reopened = state.open(&result.capture_ref, None).unwrap();
    assert!(matches!(&reopened, CaptureSnapshot::Completed { result: current, .. } if current == &result));
    assert_eq!(state.snapshot_for_capture(&result.capture_ref), Some(reopened));
    assert_eq!(backend.reads.load(Ordering::Relaxed), 1);
    assert!(state.delivery_state(&result.capture_ref).unwrap().in_use,
        "an unsettled capture stays held before paint and while hidden");
    state.settle(&result.capture_ref).unwrap();
    assert!(!state.delivery_state(&result.capture_ref).unwrap().in_use);
    assert_eq!(state.delivery_state(&result.capture_ref).unwrap().disclosure, Some(disclosure));
}

#[test]
fn recording_prepared_batch_and_its_disclosure_reach_the_existing_delivery_read() {
    use happier_desktop_native::capture::files::RecordingFrameInput;
    let state = CaptureState::default();
    let root = tempfile::tempdir().unwrap();
    let png = RgbaFrame { width: 1, height: 1, rgba: vec![1, 2, 3, 255] }.png().unwrap();
    let mut files = state.0.files.lock().unwrap();
    let (capture_ref, path) = files.allocate_video(root.path(), happier_desktop_native::capture::recording::Format::Mp4).unwrap();
    std::fs::write(&path, b"completed-native-video").unwrap();
    files.complete_video(CaptureResult { capture_ref: capture_ref.clone(), path, kind: MediaKind::Video,
        mime_type: "video/mp4".into(), byte_size: 0, pixel_size: PixelSize { width: 1, height: 1 },
        scale: None, origin: None, source: None, window_text_ref: None }).unwrap();
    let disclosure = CaptureDisclosure { has_marks: true, include_window_text: false };
    let prepared = files.prepare_recording(&capture_ref, vec![RecordingFrameInput { time_ms: 200,
        bytes: png.clone(), note: Some("Current edit".into()) }], None, false, disclosure, &CancelSignal::default()).unwrap();
    drop(files);
    let delivery = state.delivery_state(&capture_ref).unwrap();
    assert_eq!(delivery.prepared_recording, Some(prepared.clone()));
    assert_eq!(delivery.disclosure, Some(disclosure));
    assert_eq!(serde_json::to_value(&delivery).unwrap()["preparedRecording"]["frames"][0]["frameRef"],
        prepared.frames[0].frame_ref);
    assert_eq!(state.0.files.lock().unwrap().read_prepared_png(&prepared.frames[0].frame_ref).unwrap(), png);
    state.0.files.lock().unwrap().invalidate_recording(&capture_ref).unwrap();
    assert_eq!(state.delivery_state(&capture_ref).unwrap().prepared_recording, None);
}

#[test]
fn library_open_keeps_each_pinned_target_in_its_own_preview() {
    let state = CaptureState::default();
    let root = tempfile::tempdir().unwrap();
    let png = RgbaFrame { width: 1, height: 1, rgba: vec![18, 37, 53, 255] }.png().unwrap();
    let first = state.0.files.lock().unwrap().write_png(root.path(), &png).unwrap();
    let second = state.0.files.lock().unwrap().write_png(root.path(), &png).unwrap();
    let target = CaptureSessionTarget { server_id: "home-1".into(), account_id: "account-1".into(), session_id: "session-1".into() };
    let initial = state.open(&first.capture_ref, None).unwrap();
    let opened = state.open(&first.capture_ref, Some(target.clone())).unwrap();
    assert_eq!(opened.operation_ref(), initial.operation_ref());
    assert!(matches!(&opened, CaptureSnapshot::Completed { target_session: Some(pinned), .. } if pinned == &target));
    assert_eq!(serde_json::to_value(&opened).unwrap()["targetSession"], serde_json::json!({
        "serverId": "home-1", "accountId": "account-1", "sessionId": "session-1",
    }));
    assert_eq!(state.open(&first.capture_ref, None).unwrap(), opened);
    let second_opened = state.open(&second.capture_ref, None).unwrap();
    assert_eq!(state.snapshot_for_capture(&first.capture_ref), Some(opened));
    assert_eq!(state.snapshot(), second_opened);
    assert!(state.delivery_state(&second.capture_ref).unwrap().in_use);
    assert_eq!(state.delivery_state("missing").unwrap_err(), CaptureError::UnknownCapture);
    state.settle(&first.capture_ref).unwrap();
    assert!(matches!(state.open(&second.capture_ref, None).unwrap(), CaptureSnapshot::Completed { result, target_session: None, .. } if result == second));
}

#[test]
fn window_text_actions_honor_custody_and_the_prepared_disclosure_without_blocking_person_preview() {
    let state = CaptureState::default();
    let root = tempfile::tempdir().unwrap();
    let png = RgbaFrame { width: 1, height: 1, rgba: vec![18, 37, 53, 255] }.png().unwrap();
    let capture = state.0.files.lock().unwrap().write_png(root.path(), &png).unwrap();
    state.open(&capture.capture_ref, None).unwrap();
    assert!(state.window_text_for_read(&capture.capture_ref, true).is_ok(),
        "the person's preview uses the sanitized P1 reader before committing disclosure");
    assert!(matches!(state.window_text_for_read(&capture.capture_ref, false), Err(CaptureError::CaptureInUse)));
    state.settle(&capture.capture_ref).unwrap();
    assert!(matches!(state.window_text_for_read(&capture.capture_ref, false), Err(CaptureError::BlurredCapture)));
    state.0.files.lock().unwrap().write_prepared_png(&capture.capture_ref, &png,
        CaptureDisclosure { has_marks: true, include_window_text: false }).unwrap();
    assert!(matches!(state.window_text_for_read(&capture.capture_ref, false), Err(CaptureError::BlurredCapture)));
    state.0.files.lock().unwrap().write_prepared_png(&capture.capture_ref, &png,
        CaptureDisclosure { has_marks: true, include_window_text: true }).unwrap();
    assert!(state.window_text_for_read(&capture.capture_ref, false).is_ok());
}

#[test]
fn presentation_starts_are_operation_transitions_not_metadata_or_headless_publications() {
    let state = CaptureState::default();
    let publications = Arc::new(Mutex::new(Vec::new()));
    let observed = publications.clone();
    state.set_publisher(Arc::new(move |snapshot, present, start, _, _| observed.lock().unwrap().push((snapshot.clone(), present, start))));
    let folder = tempfile::tempdir().unwrap();
    let id = state.begin(CaptureMode::Still, || Ok(os(false))).unwrap().operation_ref().unwrap();
    assert!(publications.lock().unwrap().iter().all(|(_, _, start)| !start), "selection is not an editor presentation");
    let CaptureSnapshot::Completed { result, .. } = state.commit(id, CaptureTarget::Display { display_id: 1 },
        folder.path(), || Ok(())).unwrap() else { panic!("completed media") };
    assert_eq!(publications.lock().unwrap().last().map(|(_, _, start)| *start), Some(true));
    let target = CaptureSessionTarget { server_id: "home".into(), account_id: "account".into(), session_id: "session".into() };
    state.open(&result.capture_ref, Some(target)).unwrap();
    assert_eq!(publications.lock().unwrap().last().map(|(_, _, start)| *start), Some(false), "same-capture metadata is not a wake");
    state.settle(&result.capture_ref).unwrap();
    assert_eq!(publications.lock().unwrap().last(), Some(&(CaptureSnapshot::Idle, false, false)));
    let selected = state.start_with_target(CaptureMode::Still, None,
        CaptureStartOptions { target_session: None, present_capture_window: false, ..CaptureStartOptions::default() },
        || Ok(os(false)), folder.path(), || Ok(()), |_, _| Ok(())).unwrap();
    state.commit(selected.operation_ref().unwrap(), CaptureTarget::Display { display_id: 1 }, folder.path(), || Ok(())).unwrap();
    assert_eq!(publications.lock().unwrap().last().map(|(_, present, start)| (*present, *start)), Some((false, false)));
}

#[test]
fn request_target_is_preserved_until_selected_media_finishes_without_capture_window_publication() {
    let state = CaptureState::default();
    assert!(state.capture_window_snapshot().is_none(), "idle bootstrap has no presentation to wake");
    let backend = os(false);
    let root = tempfile::tempdir().unwrap();
    let target = CaptureSessionTarget { server_id: "home".into(), account_id: "account".into(), session_id: "requester".into() };
    let publications = Arc::new(Mutex::new(Vec::new()));
    let observed = publications.clone();
    state.set_publisher(Arc::new(move |snapshot, present, _, _, _| {
        observed.lock().unwrap().push((snapshot.clone(), present));
    }));
    let selected = state.start_with_target(CaptureMode::Still, None,
        CaptureStartOptions { target_session: Some(target.clone()), present_capture_window: false, ..CaptureStartOptions::default() },
        || Ok(backend), root.path(), || Ok(()), |_, _| Ok(())).unwrap();
    let completed = state.commit(selected.operation_ref().unwrap(), CaptureTarget::Display { display_id: 1 }, root.path(), || Ok(())).unwrap();
    assert!(matches!(completed, CaptureSnapshot::Completed { target_session: Some(pinned), .. } if pinned == target));
    assert!(publications.lock().unwrap().iter().all(|(_, present)| !present));
    assert!(state.capture_window_snapshot().is_none());
    state.settle(&match state.snapshot() { CaptureSnapshot::Completed { result, .. } => result.capture_ref, _ => unreachable!() }).unwrap();
    assert!(state.capture_window_snapshot().is_none(), "settled headless media cannot wake a retained renderer");
}

#[test]
fn explicit_target_reuses_its_discovery_without_a_second_inventory_read() {
    let state = CaptureState::default(); let os = os(false);
    assert_eq!(state.targets(|| Ok(os.clone())).unwrap().displays.len(), 1);
    let root = tempfile::tempdir().unwrap();
    let result = state.start_with_target(CaptureMode::Still, Some(CaptureTarget::Display { display_id: 1 }), CaptureStartOptions::default(),
        || panic!("reuse native target handles"), root.path(), || Ok(()), |_, _| panic!("explicit target has no selector")).unwrap();
    assert!(matches!(result, CaptureSnapshot::Completed { .. }));
    assert_eq!(os.discoveries.load(Ordering::Relaxed), 1);
    assert_eq!(os.reads.load(Ordering::Relaxed), 1);
}

#[test]
fn imported_media_opens_independently_and_discard_keeps_other_imports_and_originals() {
    let state = CaptureState::default();
    let root = tempfile::tempdir().unwrap(); let external = tempfile::tempdir().unwrap();
    let path = external.path().join("original.png");
    std::fs::write(&path, RgbaFrame { width: 1, height: 1, rgba: vec![42, 0, 0, 255] }.png().unwrap()).unwrap();
    let result = state.open_file(|files| files.import_png(root.path(), &path)).unwrap();
    let repeated = state.open_file(|files| files.import_png(root.path(), &path)).unwrap();
    assert_ne!(repeated.capture_ref, result.capture_ref);
    state.discard(&result.capture_ref).unwrap();
    assert!(matches!(state.snapshot(), CaptureSnapshot::Completed { result: current, .. } if current == repeated));
    assert!(state.delivery_state(&repeated.capture_ref).unwrap().in_use);
    assert!(state.0.operation.lock().unwrap().active.is_none(), "discard releases operation custody");
    assert_eq!(state.read_source(&result.capture_ref), Err(CaptureError::UnknownCapture));
    assert!(!std::path::Path::new(&result.path).exists(), "discard deletes the owned capture file");
    assert!(path.exists(), "discard never deletes the imported external source");
    let next = state.start_with_target(CaptureMode::Still, Some(CaptureTarget::Display { display_id: 1 }),
        CaptureStartOptions::default(), || Ok(os(false)), root.path(), || Ok(()),
        |_, _| panic!("an explicit target has no selector")).unwrap();
    let CaptureSnapshot::Completed { result: next, .. } = next else { panic!("next capture must run after discard") };
    assert_ne!(next.capture_ref, result.capture_ref, "the next trigger cannot reopen discarded work");
}

#[test]
fn settling_an_older_library_delivery_keeps_the_current_capture_open() {
    let state = CaptureState::default();
    let root = tempfile::tempdir().unwrap();
    let png = RgbaFrame { width: 1, height: 1, rgba: vec![18, 37, 53, 255] }.png().unwrap();
    let previous = state.0.files.lock().unwrap().write_png(root.path(), &png).unwrap();
    let current = state.0.files.lock().unwrap().write_png(root.path(), &png).unwrap();
    let opened = state.open(&current.capture_ref, None).unwrap();
    assert_eq!(state.settle(&previous.capture_ref).unwrap(), opened);
    assert_eq!(state.snapshot(), opened);
    assert!(state.delivery_state(&current.capture_ref).unwrap().in_use);
    assert_eq!(state.snapshot_for_capture(&current.capture_ref), Some(opened));
}
