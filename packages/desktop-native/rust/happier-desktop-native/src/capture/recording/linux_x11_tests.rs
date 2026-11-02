use super::*;
use crate::capture::DisplayDescriptor;
use x11rb::{connection::Connection, protocol::xproto::{ConnectionExt, CreateWindowAux, WindowClass}, rust_connection::RustConnection};

fn scene() -> (RustConnection, Inventory, u32) {
    let (connection, screen) = x11rb::connect(None).unwrap();
    let root = &connection.setup().roots[screen];
    let window = connection.generate_id().unwrap();
    connection.create_window(x11rb::COPY_DEPTH_FROM_PARENT, window, root.root, 80, 60, 64, 48, 0,
        WindowClass::INPUT_OUTPUT, 0, &CreateWindowAux::new().background_pixel(0x00ff00)).unwrap().check().unwrap();
    connection.map_window(window).unwrap().check().unwrap();
    connection.flush().unwrap();
    let display_id = crate::capture::linux::native_monitor_frames(&connection, root.root).unwrap()[0].0;
    let inventory = Inventory { displays: vec![DisplayDescriptor { display_id,
        frame: Rect { x: 0., y: 0., width: root.width_in_pixels as f64, height: root.height_in_pixels as f64 },
        scale: 1., desktop_scale: 1., storage_key: None, localized_name: None, safe_area_top: 0., physical_notch_size: None }],
        windows: vec![crate::capture::WindowDescriptor { window_id: window, process_id: std::process::id(),
            frame: Rect { x: 80., y: 60., width: 64., height: 48. }, title: Some("Selected green fixture".into()),
            app_name: None, z_order: 0 }] };
    (connection, inventory, window)
}

#[test]
#[ignore = "requires finite X11 display: xvfb-run -a cargo test --lib x11_tests -- --ignored"]
fn exact_x11_window_is_prepared_without_a_second_portal_selection() {
    let (_connection, inventory, window) = scene();
    let root = tempfile::tempdir().unwrap();
    let result = prepare(&inventory, &CaptureTarget::Window { window_id: window }, &root.path().join("window.webm"),
        Arc::new(Mutex::new(Timeline::new())), Arc::new(|_| {}));
    assert!(result.is_ok(), "the P1-selected X11 window must prepare directly, without a portal: {:?}", result.err());
}

fn recorder(inventory: &Inventory, target: CaptureTarget, path: &Path)
    -> (LinuxRecorder, PixelSize, Arc<Mutex<Timeline>>, mpsc::Receiver<Result<(), CaptureError>>, Arc<std::sync::atomic::AtomicUsize>, super::super::Clock) {
    let timeline = Arc::new(Mutex::new(Timeline::new()));
    let (sender, receiver) = mpsc::channel(); let failed = sender.clone();
    let selection = x11_selection(inventory, &target).unwrap();
    let (mut recorder, size) = prepare_pipeline(path, timeline.clone(), Arc::new(move |error| { let _ = failed.send(Err(error)); }),
        &CancelSignal::default(), &selection).unwrap();
    let frames = Arc::new(std::sync::atomic::AtomicUsize::new(0)); let submitted = frames.clone();
    recorder.encoder_input.add_probe(gst::PadProbeType::BUFFER, move |_, _| {
        submitted.fetch_add(1, Ordering::SeqCst); let _ = sender.send(Ok(())); gst::PadProbeReturn::Ok
    });
    recorder.start().unwrap();
    let clock = super::super::clock();
    timeline.lock().unwrap().start(clock());
    assert_eq!(receiver.recv().unwrap(), Ok(()), "the real X11 source must admit a raw frame");
    (recorder, size, timeline, receiver, frames, clock)
}

fn next_source_frame(recorder: &LinuxRecorder) {
    let (sender, receiver) = mpsc::channel();
    let pad = recorder.pipeline.0.by_name("recording-source").unwrap().static_pad("src").unwrap();
    // IDLE fires after this push (including the production retime/drop probe)
    // completes. This observes native work without a timer or a process poll.
    pad.add_probe(gst::PadProbeType::BUFFER, move |pad, _| {
        let sender = sender.clone();
        pad.add_probe(gst::PadProbeType::IDLE, move |_, _| { let _ = sender.send(()); gst::PadProbeReturn::Remove });
        gst::PadProbeReturn::Remove
    });
    receiver.recv().unwrap();
}

#[test]
#[ignore = "requires finite X11 display: xvfb-run -a cargo test --lib x11_tests -- --ignored"]
fn exact_window_frontmost_and_physical_region_encode_selected_pixels_and_pause_without_portal() {
    let (_connection, inventory, window) = scene(); let folder = tempfile::tempdir().unwrap();
    for (index, (target, expected)) in [
        (CaptureTarget::Window { window_id: window }, PixelSize { width: 64, height: 48 }),
        (CaptureTarget::Frontmost, PixelSize { width: 64, height: 48 }),
        (CaptureTarget::Rect { display_id: inventory.displays[0].display_id, rect: Rect { x: 88., y: 68., width: 32., height: 24. } }, PixelSize { width: 32, height: 24 }),
    ].into_iter().enumerate() {
        let path = folder.path().join(format!("selected-{index}.webm"));
        let (mut recorder, size, timeline, _events, frames, clock) = recorder(&inventory, target, &path);
        assert_eq!(size, expected);
        let weak = recorder.pipeline.0.downgrade();
        timeline.lock().unwrap().pause(clock());
        next_source_frame(&recorder); let paused_frames = frames.load(Ordering::SeqCst);
        next_source_frame(&recorder); assert_eq!(frames.load(Ordering::SeqCst), paused_frames, "paused source samples reached the encoder");
        timeline.lock().unwrap().resume(clock());
        next_source_frame(&recorder);
        let duration = { let mut time = timeline.lock().unwrap(); time.settle_timing(clock());
            time.snapshot.phase = super::super::Phase::Finalizing; time.active_ns };
        assert_eq!(recorder.finish(duration), Ok(None));
        drop(recorder); assert!(weak.upgrade().is_none(), "settlement leaked an X11/GStreamer source");
        let green = super::tests::first_pixel(&path);
        assert!(green[1] > green[0] && green[1] > green[2], "wrong selected pixels: {green:?}");
        let movie = matroska_demuxer::MatroskaFile::open(std::fs::File::open(&path).unwrap()).unwrap();
        assert_eq!(movie.tracks().len(), 1, "native X11 recordings remain silent");
        assert_eq!(movie.tracks()[0].codec_id().trim_end_matches('\0'), "V_VP8");
    }
}

#[test]
#[ignore = "requires finite X11 display: xvfb-run -a cargo test --lib x11_tests -- --ignored"]
fn closing_the_selected_x11_window_finishes_playable_content_with_a_source_warning() {
    let (connection, inventory, window) = scene(); let folder = tempfile::tempdir().unwrap(); let path = folder.path().join("closed.webm");
    let (mut recorder, _, timeline, events, _, _) = recorder(&inventory, CaptureTarget::Window { window_id: window }, &path);
    connection.destroy_window(window).unwrap().check().unwrap(); connection.flush().unwrap();
    let error = loop { if let Err(error) = events.recv().unwrap() { break error; } };
    assert_eq!(error, CaptureError::TargetUnavailable);
    timeline.lock().unwrap().snapshot.phase = super::super::Phase::Finalizing;
    assert_eq!(recorder.finish(1_000_000_000), Ok(Some(CaptureError::TargetUnavailable)));
    drop(recorder);
    let green = super::tests::first_pixel(&path); assert!(green[1] > green[0] && green[1] > green[2]);
}

#[test]
#[ignore = "requires finite X11 display: xvfb-run -a cargo test --lib x11_tests -- --ignored --test-threads=1"]
fn closed_root_sized_window_never_admits_a_root_fallback() {
    let (connection, mut inventory, window) = scene(); let folder = tempfile::tempdir().unwrap();
    let display = inventory.displays[0].frame;
    connection.configure_window(window, &x11rb::protocol::xproto::ConfigureWindowAux::new()
        .x(0).y(0).width(display.width as u32).height(display.height as u32)).unwrap().check().unwrap();
    inventory.windows[0].frame = display;
    connection.destroy_window(window).unwrap().check().unwrap();
    let path = folder.path().join("must-not-record-root.webm");
    let result = prepare(&inventory, &CaptureTarget::Window { window_id: window }, &path,
        Arc::new(Mutex::new(Timeline::new())), Arc::new(|_| {}));
    assert!(matches!(result, Err(CaptureError::TargetUnavailable)));
    assert!(!path.exists(), "a missing selected xid must not open the root writer");
    // ximagesrc endx/endy=0 means fit-to-screen, not the first physical pixel.
    // Its expanded native caps must never silently replace the requested area.
    let path = folder.path().join("must-not-expand-first-pixel.webm");
    let result = prepare(&inventory, &CaptureTarget::Rect { display_id: inventory.displays[0].display_id,
        rect: Rect { x: 0., y: 0., width: 1., height: 1. } }, &path,
        Arc::new(Mutex::new(Timeline::new())), Arc::new(|_| {}));
    assert!(matches!(result, Err(CaptureError::TargetUnavailable)));
    assert!(path.metadata().map_or(true, |file| file.len() == 0), "expanded root pixels reached the writer");
}

#[test]
#[ignore = "requires finite X11 display: xvfb-run -a cargo test --lib x11_tests -- --ignored --test-threads=1"]
fn destruction_between_subscription_and_native_admission_cannot_be_lost() {
    let (connection, _, window) = scene();
    let watch = x11::SourceWatch::window(x11_connection().unwrap().0, window).unwrap();
    connection.destroy_window(window).unwrap().check().unwrap();
    assert_eq!(watch.admit(PixelSize { width: 64, height: 48 }), Err(CaptureError::TargetUnavailable));
}

#[test]
#[ignore = "requires serial finite Xvfb with RandR 1.5 monitors"]
fn removing_the_selected_monitor_does_not_silently_keep_recording_its_old_root_coordinates() {
    use x11rb::protocol::randr::{ConnectionExt as _, MonitorInfo};
    let (connection, mut inventory, _) = scene();
    let root = connection.setup().roots[0].root;
    let selected = connection.intern_atom(false, b"HAPPIER_TEST_SELECTED_MONITOR").unwrap().reply().unwrap().atom;
    connection.randr_set_monitor(root, MonitorInfo { name: selected, primary: false, automatic: false,
        x: 0, y: 0, width: 640, height: 1024, width_in_millimeters: 169, height_in_millimeters: 271, outputs: vec![] })
        .unwrap().check().unwrap();
    assert!(connection.randr_get_monitors(root, true).unwrap().reply().unwrap().monitors.iter().any(|monitor| monitor.name == selected),
        "the real X server must expose this selected monitor before the recorder is admitted");
    inventory.displays[0].display_id = selected; inventory.displays[0].frame.width = 640.;
    let folder = tempfile::tempdir().unwrap(); let path = folder.path().join("removed-monitor.webm");
    let (mut recorder, _, timeline, events, _, _) = recorder(&inventory,
        CaptureTarget::Rect { display_id: selected, rect: Rect { x: 88., y: 68., width: 32., height: 24. } }, &path);
    connection.randr_delete_monitor(root, selected).unwrap().check().unwrap();
    assert!(!connection.randr_get_monitors(root, true).unwrap().reply().unwrap().monitors.iter().any(|monitor| monitor.name == selected));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    let error = loop {
        match events.recv_timeout(deadline.saturating_duration_since(std::time::Instant::now())).expect("monitor removal must settle the native recording, not capture a replacement area indefinitely") {
            Ok(()) => {}, Err(error) => break error,
        }
    };
    assert_eq!(error, CaptureError::TargetUnavailable);
    timeline.lock().unwrap().snapshot.phase = super::super::Phase::Finalizing;
    assert_eq!(recorder.finish(1_000_000_000), Ok(Some(CaptureError::TargetUnavailable)));
    drop(recorder);
    let green = super::tests::first_pixel(&path); assert!(green[1] > green[0] && green[1] > green[2]);
}
