//! Finite native Windows proof. Only the external labelled fixture is captured.
use super::*;
use crate::capture::{CaptureBackend, DisplayDescriptor};
use std::{io::{BufRead, BufReader, Write}, process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::atomic::{AtomicU32, Ordering}, time::{Duration, Instant}};
use ::windows::{core::w, Foundation::TimeSpan,
    Media::Editing::{MediaClip, MediaComposition, VideoFramePrecision},
    Storage::{StorageFile, Streams::DataReader},
    Win32::{Foundation::{COLORREF, HWND, LPARAM, LRESULT, WPARAM},
        Graphics::Gdi::{BeginPaint, CreateSolidBrush, DeleteObject, EndPaint, FillRect,
            GetMonitorInfoW, HMONITOR, InvalidateRect, MONITORINFO, PAINTSTRUCT, TextOutW, UpdateWindow},
        UI::{HiDpi::{SetThreadDpiAwarenessContext, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2},
            WindowsAndMessaging::{CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW,
                GetMessageW, GetWindowDisplayAffinity, PostMessageW, PostQuitMessage,
                SetWindowLongPtrW, TranslateMessage, GWLP_WNDPROC, MSG, WINDOW_EX_STYLE,
                WM_APP, WM_CLOSE, WM_DESTROY, WM_PAINT, WS_POPUP, WS_VISIBLE}}}};

/// Decode through Windows' actual media stack, never the production player or a fake codec.
pub(super) fn assert_pixel(path: &Path, time_ms: i64, x: u32, y: u32, expected: [u8; 3]) {
    let source = StorageFile::GetFileFromPathAsync(&storage_path(path).unwrap()).unwrap().join().unwrap();
    let clip = MediaClip::CreateFromFileAsync(&source).unwrap().join().unwrap();
    eprintln!("WINDOWS_DECODE_CLIP requested_ms={time_ms} original={:?} trimmed={:?}",
        clip.OriginalDuration(), clip.TrimmedDuration());
    let video = clip.GetVideoEncodingProperties().unwrap();
    let source_size = (video.Width().unwrap(), video.Height().unwrap());
    let composition = MediaComposition::new().unwrap();
    composition.Clips().unwrap().Append(&clip).unwrap();
    // Both render dimensions are explicit, so thumbnail defaults cannot add a
    // differently shaped canvas to this source-pixel assertion.
    let thumbnail = composition.GetThumbnailAsync(TimeSpan { Duration: time_ms * 10_000 },
        source_size.0.try_into().unwrap(), source_size.1.try_into().unwrap(),
        VideoFramePrecision::NearestFrame).unwrap().join().unwrap();
    let size = u32::try_from(thumbnail.Size().unwrap()).unwrap();
    let reader = DataReader::CreateDataReader(&thumbnail.GetInputStreamAt(0).unwrap()).unwrap();
    assert_eq!(reader.LoadAsync(size).unwrap().join().unwrap(), size);
    let mut bytes = vec![0; size as usize]; reader.ReadBytes(&mut bytes).unwrap();
    let image = image::load_from_memory(&bytes).unwrap().to_rgba8();
    assert_eq!((image.width(), image.height()), source_size);
    let actual = image.get_pixel(x, y).0;
    eprintln!("WINDOWS_DECODE time_ms={time_ms} size={}x{} pixel={x},{y} rgba={actual:?}", image.width(), image.height());
    for (actual, expected) in actual.into_iter().zip(expected) {
        assert!(actual.abs_diff(expected) < 45, "decoded pixel {x},{y} at {time_ms}ms rgba={:?}: {actual} != {expected}", image.get_pixel(x,y).0);
    }
    reader.Close().unwrap(); thumbnail.Close().unwrap();
}

pub(super) fn trace_movie(path: &Path) {
    let file = std::fs::File::open(path).unwrap(); let size = file.metadata().unwrap().len();
    let mut movie = mp4::Mp4Reader::read_header(file, size).unwrap();
    let tracks = movie.tracks().values().map(|track| {
        eprintln!("WINDOWS_MOVIE_TRACK id={} duration={:?} scale={} samples={} size={}x{} sps={:?}",
            track.track_id(), track.duration(), track.timescale(), track.sample_count(), track.width(), track.height(),
            track.sequence_parameter_set());
        (track.track_id(), track.sample_count())
    }).collect::<Vec<_>>();
    for (track, count) in tracks {
        let mut sync = Vec::new();
        for id in 1..=count {
            let sample = movie.read_sample(track, id).unwrap().unwrap();
            if sample.is_sync { sync.push((id, sample.start_time)); }
            if id == 1 || id == count { eprintln!("WINDOWS_MOVIE_SAMPLE id={id} start={} duration={} rendering_offset={}",
                sample.start_time, sample.duration, sample.rendering_offset); }
        }
        eprintln!("WINDOWS_MOVIE_SYNC {sync:?}");
    }
}

#[test]
#[ignore = "finite labelled fixture producer for the independent WebView2 proof"]
fn native_player_labelled_fixture() {
    let destination = std::env::var_os("HAPPIER_WINDOWS_PLAYER_FIXTURE").expect("fixture destination");
    let _runtime = WinRt::new().unwrap();
    if std::env::var_os("HAPPIER_WINDOWS_PLAYER_SPARSE").is_some() {
        let mut writer = Writer { encoder: Some(encoder(Path::new(&destination), PixelSize { width:64, height:48 }).unwrap()), last:None };
        writer.append([0,0,255,255].repeat(64*48), 0).unwrap();
        writer.append([0,255,0,255].repeat(64*48), 1_000_000_000).unwrap();
        writer.finish(2_000_000_000).unwrap();
        println!("WINDOWS_PLAYER_FIXTURE sparse red=0..1s green=1..2s size=64x48");
        return;
    }
    write_dense_fixture(Path::new(&destination), PixelSize { width:64, height:48 }, &[[0,0,255,255], [0,255,0,255]]);
    println!("WINDOWS_PLAYER_FIXTURE red=0..1s green=1..2s size=64x48 fps=60");
}

pub(super) fn write_dense_fixture(destination: &Path, size: PixelSize, colors: &[[u8; 4]]) {
    let mut writer = Writer { encoder: Some(encoder(destination, size).unwrap()), last:None };
    // Dense 60fps fixture matches the encoder's actual default, separating the
    // player's canvas contract from the separately failing sparse-frame contract.
    for frame in 0..colors.len() * 60 {
        writer.append(colors[frame / 60].repeat((size.width*size.height) as usize), frame as u64*1_000_000_000/60).unwrap();
    }
    writer.finish(colors.len() as u64*1_000_000_000).unwrap();
}

#[test]
fn timed_handoff_wakes_when_native_output_closes() {
    use ::windows::core::Interface;
    let _runtime = WinRt::new().unwrap();
    let stream = ::windows::Storage::Streams::InMemoryRandomAccessStream::new().unwrap();
    let mut encoder = VideoEncoder::new_from_stream(
        VideoSettingsBuilder::new(64,48).sub_type(VideoSettingsSubType::H264),
        AudioSettingsBuilder::new().disabled(true), ContainerSettingsBuilder::new(), stream.cast().unwrap()).unwrap();
    let pixels = [0,255,0,255].repeat(64*48);
    encoder.send_frame_buffer_with_duration(&pixels,0,166667).unwrap();
    stream.Close().unwrap();
    // A finite one-second fixture drives the genuine closed output boundary;
    // there is no timer or mock standing in for native pipeline settlement.
    let failed = (1..60).any(|frame| {
        if let Err(error) = encoder.send_frame_buffer_with_duration(&pixels,frame*166667,166667) {
            eprintln!("WINDOWS_ENCODER_CLOSED_STREAM frame={frame} error={error:?}"); true
        } else { false }
    });
    assert!(failed, "closed output must settle a waiting timed handoff with error");
    assert!(encoder.send_frame_buffer_with_duration(&pixels,10_000_000,166667).is_err(),
        "a send after terminal settlement must not wait for another native pull");
    println!("WINDOWS_ENCODER_CLOSED_STREAM_PASS");
}

#[test]
#[ignore = "requires the explicitly authorized native Windows profile proof"]
fn native_encoder_capability_matrix() {
    use ::windows::core::Interface;
    let _runtime = WinRt::new().unwrap();
    let directory = tempfile::tempdir().unwrap();
    for (width, height) in [(64, 48), (320, 240)] {
        let pixels = [0, 255, 0, 255].repeat((width * height) as usize);
        for memory in [false, true] {
            let stream = ::windows::Storage::Streams::InMemoryRandomAccessStream::new().unwrap();
            let destination = directory.path().join(format!("{width}-{height}-{memory}.mp4"));
            let settings = VideoSettingsBuilder::new(width, height).sub_type(VideoSettingsSubType::H264);
            let audio = AudioSettingsBuilder::new().disabled(true);
            let container = ContainerSettingsBuilder::new();
            let result = if memory { VideoEncoder::new_from_stream(settings, audio, container, stream.cast().unwrap()) }
                else { VideoEncoder::new(settings, audio, container, &destination) };
            let tag = format!("size={width}x{height} constructor={}", if memory { "stream" } else { "file" });
            let mut encoder = result.unwrap_or_else(|error| panic!("{tag} construct failed: {error:?}"));
            encoder.send_frame_buffer_with_duration(&pixels, 0, 10_000_000).unwrap();
            encoder.finish().unwrap();
            let bytes = if memory {
                let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).unwrap()).unwrap();
                let size = u32::try_from(stream.Size().unwrap()).unwrap();
                assert_eq!(reader.LoadAsync(size).unwrap().join().unwrap(), size);
                let mut bytes = vec![0; size as usize];
                reader.ReadBytes(&mut bytes).unwrap();
                reader.Close().unwrap();
                bytes
            } else { std::fs::read(&destination).unwrap() };
            let movie = mp4::Mp4Reader::read_header(std::io::Cursor::new(&bytes), bytes.len() as u64).unwrap();
            assert_eq!(movie.tracks().len(), 1);
            let track = movie.tracks().values().next().unwrap();
            assert_eq!(track.media_type().unwrap(), mp4::MediaType::H264);
            assert_eq!((track.width() as u32, track.height() as u32), (width, height));
            assert!(track.sample_count() > 0);
            let _ = stream.Close();
            eprintln!("WINDOWS_PREPARE_SELECTION {tag} PASS");
        }
    }
    eprintln!("WINDOWS_PREPARE_SELECTION_MATRIX_PASS cases=4");
}

static FIXTURE_PHASE: AtomicU32 = AtomicU32::new(0);
unsafe extern "system" fn marker_proc(window: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match message {
        WM_PAINT => {
            let mut paint = PAINTSTRUCT::default();
            let dc = unsafe { BeginPaint(window, &mut paint) };
            let colors = match FIXTURE_PHASE.load(Ordering::SeqCst) {
                1 => [0x00ff00ff; 4], // content visible only while paused
                2 => [0x0000ff00, 0x0000ffff, 0x00ffff00, 0x00ffffff],
                _ => [0x000000ff, 0x00ff0000, 0x0000ffff, 0x00ffff00],
            };
            for (index, color) in colors.into_iter().enumerate() {
                let left = (index % 2) as i32 * 160; let top = (index / 2) as i32 * 120;
                let rect = ::windows::Win32::Foundation::RECT { left, top, right: left+160, bottom: top+120 };
                let brush = unsafe { CreateSolidBrush(COLORREF(color)) };
                unsafe { FillRect(dc, &rect, brush); let _ = DeleteObject(brush.into()); }
                let label: Vec<u16> = format!("MARKER {index} phase {}", FIXTURE_PHASE.load(Ordering::SeqCst)).encode_utf16().collect();
                let _ = unsafe { TextOutW(dc, left+60, top+65, &label) };
            }
            let _ = unsafe { EndPaint(window, &paint) };
            println!("FIXTURE_PAINTED {}", FIXTURE_PHASE.load(Ordering::SeqCst));
            let _ = std::io::stdout().flush();
            LRESULT(0)
        },
        WM_APP => { FIXTURE_PHASE.store(wparam.0 as u32, Ordering::SeqCst);
            let _ = unsafe { InvalidateRect(Some(window), None, false) }; LRESULT(0) },
        WM_CLOSE => { let _ = unsafe { DestroyWindow(window) }; LRESULT(0) },
        WM_DESTROY => { unsafe { PostQuitMessage(0) }; LRESULT(0) },
        _ => unsafe { DefWindowProcW(window, message, wparam, lparam) },
    }
}
fn marker_window(x: i32, y: i32, width: i32, height: i32) -> HWND {
    unsafe {
        SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let window = CreateWindowExW(WINDOW_EX_STYLE::default(), w!("STATIC"), w!("Happier labelled fixture"),
            WS_POPUP | WS_VISIBLE, x, y, width, height, None, None, None, None).unwrap();
        SetWindowLongPtrW(window, GWLP_WNDPROC, marker_proc as *const () as isize);
        let _ = InvalidateRect(Some(window), None, false);
        let _ = UpdateWindow(window);
        window
    }
}

#[test]
#[ignore = "finite helper launched only by native_selected_pixels_pause_exclusion_and_source_close"]
fn synthetic_marker_child() {
    if std::env::var_os("HAPPIER_WINDOWS_MARKER_CHILD").is_none() { return; }
    let window = marker_window(96, 96, 320, 240);
    println!("FIXTURE_HWND {}", window.0 as usize); std::io::stdout().flush().unwrap();
    let address = window.0 as usize;
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            let Ok(line) = line else { break; };
            let window = HWND(address as *mut _);
            if line == "close" { let _ = unsafe { PostMessageW(Some(window), WM_CLOSE, WPARAM(0), LPARAM(0)) }; break; }
            let phase = line.parse::<usize>().unwrap();
            unsafe { PostMessageW(Some(window), WM_APP, WPARAM(phase), LPARAM(0)) }.unwrap();
        }
    });
    let mut message = MSG::default();
    while unsafe { GetMessageW(&mut message, None, 0, 0) }.as_bool() {
        unsafe { let _ = TranslateMessage(&message); DispatchMessageW(&message); }
    }
}
struct Fixture { child: Child, input: ChildStdin, output: BufReader<ChildStdout>, window_id: u32 }
impl Fixture {
    fn open() -> Self {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "capture::recording::windows::native_proof::synthetic_marker_child", "--ignored", "--nocapture"])
            .env("HAPPIER_WINDOWS_MARKER_CHILD", "1").stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
        let input = child.stdin.take().unwrap(); let mut output = BufReader::new(child.stdout.take().unwrap());
        let window_id = loop { let mut line = String::new(); assert_ne!(output.read_line(&mut line).unwrap(), 0, "marker exited before readiness");
            if let Some((_, id)) = line.trim().split_once("FIXTURE_HWND ") { break id.parse().unwrap(); } };
        let mut fixture = Self { child, input, output, window_id }; fixture.phase(0); fixture
    }
    fn phase(&mut self, phase: u32) {
        writeln!(self.input, "{phase}").unwrap(); self.input.flush().unwrap();
        loop { let mut line = String::new(); assert_ne!(self.output.read_line(&mut line).unwrap(), 0, "marker stopped before paint");
            if line.trim() == format!("FIXTURE_PAINTED {phase}") { break; } }
    }
    fn close(&mut self) { writeln!(self.input, "close").unwrap(); self.input.flush().unwrap(); assert!(self.child.wait().unwrap().success()); }
}
impl Drop for Fixture { fn drop(&mut self) { if self.child.try_wait().ok().flatten().is_none() { let _ = self.child.kill(); let _ = self.child.wait(); } } }

fn inventory() -> Inventory {
    let scales = Monitor::enumerate().unwrap().into_iter().map(|monitor| {
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        assert!(unsafe { GetMonitorInfoW(HMONITOR(monitor.as_raw_hmonitor()), &mut info) }.as_bool());
        (Rect { x: info.rcMonitor.left as f64, y: info.rcMonitor.top as f64,
            width: (info.rcMonitor.right-info.rcMonitor.left) as f64,
            height: (info.rcMonitor.bottom-info.rcMonitor.top) as f64 }, 1.)
    }).collect();
    crate::capture::windows::WindowsCaptureBackend::new(scales).unwrap().discover().unwrap()
}
fn moment(start: Instant) -> super::super::Moment { let ns = start.elapsed().as_nanos() as u64;
    super::super::Moment { steady_ns: ns, epoch_ms: ns/1_000_000 } }
fn movie(path: &Path, size: PixelSize) {
    let file = std::fs::File::open(path).unwrap();
    let movie = mp4::Mp4Reader::read_header(&file, file.metadata().unwrap().len()).unwrap();
    assert_eq!(movie.tracks().len(), 1, "silent recording has one video track");
    let track = movie.tracks().values().next().unwrap();
    assert_eq!(track.media_type().unwrap(), mp4::MediaType::H264);
    assert_eq!((track.width() as u32, track.height() as u32), (size.width, size.height));
    assert!((1800..2600).contains(&movie.duration().as_millis()), "paused wall time excluded: {:?}", movie.duration());
}

fn assert_synthetic_region_visible(fixture: HWND, x: i32, y: i32) {
    use ::windows::Win32::{Foundation::POINT, UI::WindowsAndMessaging::{
        GetForegroundWindow, GetWindowThreadProcessId, WindowFromPoint}};
    let foreground = unsafe { GetForegroundWindow() };
    let mut foreground_pid = 0;
    unsafe { GetWindowThreadProcessId(foreground, Some(&mut foreground_pid)); }
    eprintln!("WINDOWS_FIXTURE_FOREGROUND hwnd={} pid={foreground_pid}", foreground.0 as usize);
    // These four corners are outside our excluded overlay. Refuse the proof
    // before capture if another GUI owns them: no unrelated desktop pixels.
    for (dx,dy) in [(2,2),(62,2),(2,46),(62,46)] {
        let point = POINT { x:x+dx, y:y+dy };
        let visible = unsafe { WindowFromPoint(point) };
        let mut pid = 0;
        unsafe { GetWindowThreadProcessId(visible, Some(&mut pid)); }
        eprintln!("WINDOWS_FIXTURE_REGION point={},{} hwnd={} pid={pid} expected={}",
            point.x,point.y,visible.0 as usize,fixture.0 as usize);
        assert_eq!(visible,fixture,"synthetic region is obscured; coordinate the Windows graphical proof slot");
    }
}

#[test]
#[ignore = "requires the explicitly authorized unlocked Windows graphical worker"]
fn native_selected_pixels_pause_exclusion_and_source_close() {
    unsafe { SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2); }
    let _runtime = WinRt::new().unwrap(); let root = tempfile::tempdir().unwrap();
    let mut fixture = Fixture::open(); let facts = inventory();
    let window = facts.windows.iter().find(|window| window.window_id == fixture.window_id).unwrap();
    let display: &DisplayDescriptor = facts.window_display(window).unwrap();
    let region_x = window.frame.x + 16.; let region_y = window.frame.y + 12.;
    for (name, target) in [("window", CaptureTarget::Window { window_id: fixture.window_id }),
        ("region", CaptureTarget::Rect { display_id: display.display_id, rect: Rect {
            x: region_x-display.frame.x, y: region_y-display.frame.y, width:64., height:48. } })] {
        fixture.phase(0);
        let overlay = if name == "region" { FIXTURE_PHASE.store(1, Ordering::SeqCst);
            Some(marker_window(region_x as i32+8, region_y as i32+8, 32, 24)) } else { None };
        let mut previous_affinity = 0;
        if let Some(window) = overlay { unsafe { GetWindowDisplayAffinity(window, &mut previous_affinity) }.unwrap(); }
        if name == "region" {
            assert_synthetic_region_visible(HWND(fixture.window_id as usize as *mut _),region_x as i32,region_y as i32);
        }
        let path = root.path().join(format!("{name}.mp4"));
        let timeline = Arc::new(Mutex::new(Timeline::new())); let start = Instant::now();
        let (failed, failures) = std::sync::mpsc::channel();
        let mut prepared = prepare(&facts, &target, &path, timeline.clone(), Arc::new(move |error| { let _ = failed.send(error); })).unwrap();
        prepared.backend.start().unwrap(); timeline.lock().unwrap().start(moment(start));
        std::thread::sleep(Duration::from_secs(1));
        timeline.lock().unwrap().pause(moment(start)); fixture.phase(1);
        std::thread::sleep(Duration::from_secs(1));
        timeline.lock().unwrap().resume(moment(start)); fixture.phase(2);
        std::thread::sleep(Duration::from_secs(1));
        let duration = { let mut time = timeline.lock().unwrap(); time.settle_timing(moment(start));
            time.snapshot.phase = super::super::Phase::Finalizing; time.active_ns };
        assert_eq!(prepared.backend.finish(duration).unwrap(), None); drop(prepared.backend);
        assert!(failures.try_recv().is_err(), "source must remain usable until Stop");
        if let Some(window) = overlay { let mut restored = 0; unsafe { GetWindowDisplayAffinity(window, &mut restored) }.unwrap();
            assert_eq!(restored, previous_affinity); unsafe { DestroyWindow(window) }.unwrap(); }
        movie(&path, prepared.pixel_size);
        assert_pixel(&path, 250, 20, 20, [255,0,0]);
        if name == "region" {
            // MediaComposition rejects later thumbnails of these valid tiny
            // clips. Decode this SAME crop through the existing WebView2 proof.
            let destination = std::env::var_os("HAPPIER_WINDOWS_PLAYER_FIXTURE").expect("cropped WebView2 proof destination");
            assert_eq!(prepared.pixel_size, PixelSize { width:64, height:48 });
            std::fs::copy(&path, destination).unwrap();
            println!("WINDOWS_WGC_CROP_BROWSER_PENDING source=same_recorded_file expected=red_then_green size=64x48");
        } else { assert_pixel(&path, 1250, 20, 20, [0,255,0]); }
        if name == "window" { assert_pixel(&path, 250, 200, 20, [0,0,255]);
            assert_pixel(&path, 250, 20, 150, [255,255,0]);
            // An interval strictly inside the second phase is not a keyframe
            // cut. Distinct yellow/cyan quadrants also catch RGB/row reversal.
            let selected = root.path().join("window-selected.mp4");
            let original = std::fs::read(&path).unwrap();
            trim(&path, &selected, 1250, 1750, &crate::capture::CancelSignal::default()).unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), original);
            assert_pixel(&selected, 0, 20, 20, [0,255,0]);
            assert_pixel(&selected, 400, 200, 20, [255,255,0]);
            assert_pixel(&selected, 400, 20, 150, [0,255,255]);
            println!("WINDOWS_NONKEY_TRIM_PASS interval_ms=1250..1750 quadrants=green_yellow_cyan source_unchanged=true");
        }
        println!("WINDOWS_WGC_PASS target={name} size={:?} duration_ns={duration} origin={:?} exclusion_restored=true", prepared.pixel_size, prepared.origin);
    }
    // Source close has a real WGC event and remains the same source, never a display substitute.
    fixture.phase(0); let path = root.path().join("source-close.mp4");
    let timeline = Arc::new(Mutex::new(Timeline::new())); let start = Instant::now();
    let (failed, failures) = std::sync::mpsc::channel();
    let mut prepared = prepare(&facts, &CaptureTarget::Window { window_id: fixture.window_id }, &path,
        timeline.clone(), Arc::new(move |error| { let _ = failed.send(error); })).unwrap();
    prepared.backend.start().unwrap(); timeline.lock().unwrap().start(moment(start));
    std::thread::sleep(Duration::from_secs(1)); fixture.close();
    assert_eq!(failures.recv().unwrap(), CaptureError::TargetUnavailable);
    let duration = { let mut time = timeline.lock().unwrap(); time.settle_timing(moment(start));
        time.snapshot.phase = super::super::Phase::Finalizing; time.active_ns };
    prepared.backend.finish(duration).unwrap(); drop(prepared.backend);
    assert_pixel(&path, 250, 20, 20, [255,0,0]);
    println!("WINDOWS_SOURCE_CLOSE_PASS source_warning=target_unavailable retained_playable=true child_reaped=true");
}
