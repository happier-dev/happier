//! Granted PipeWire streams and finite GStreamer VP8/WebM output.
use super::{Backend, PreparedBackend, Timeline};
use crate::capture::{CancelSignal, CaptureError, CaptureOrigin, CaptureSource, CaptureTarget, Inventory, PixelSize,
    linux::ScreenCastGrant};
use crate::geometry::Rect;
use std::{os::fd::AsRawFd, path::Path, sync::{Arc, Mutex, mpsc, atomic::{AtomicBool, Ordering}}};
use gstreamer::{self as gst, prelude::*};

struct Pipeline(gst::Pipeline);
impl Drop for Pipeline { fn drop(&mut self) { x11::teardown(|| { let _ = self.0.set_state(gst::State::Null); }); } }

fn element(factory: &str, reason: CaptureError) -> Result<gst::Element, CaptureError> {
    gst::ElementFactory::make(factory).build().map_err(|_| reason)
}
fn initialize() -> Result<(), CaptureError> { gst::init().map_err(|_| CaptureError::VideoPipelineUnavailable) }
fn bus_failure(message: &gst::MessageRef) -> CaptureError {
    match message.view() {
        gst::MessageView::Error(error) if error.src().is_some_and(|source| source.name() == "recording-output") => CaptureError::FileIo,
        gst::MessageView::Element(element) if element.structure().is_some_and(|s| s.name() == "missing-plugin") => CaptureError::VideoDecoderUnavailable,
        _ => CaptureError::NativeFailure,
    }
}
fn await_eos(pipeline: &gst::Pipeline, cancel: &CancelSignal) -> Result<(), CaptureError> {
    let bus = pipeline.bus().ok_or(CaptureError::NativeFailure)?;
    loop {
        let message = bus.timed_pop(gst::ClockTime::NONE).ok_or(CaptureError::NativeFailure)?;
        if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
        match message.view() {
            gst::MessageView::Eos(_) => return Ok(()),
            gst::MessageView::Error(_) => return Err(bus_failure(&message)),
            gst::MessageView::Element(element) if element.structure().is_some_and(|s| s.name() == "missing-plugin") => return Err(bus_failure(&message)),
            _ => {},
        }
    }
}

/// Decode/accurate-seek/re-encode: no excluded GOPs survive in a playback edit list.
/// The caller owns both library paths; failed/cancelled output is never adopted.
pub fn trim(source: &Path, output: &Path, start_ms: u64, end_ms: u64,
    cancel: &CancelSignal) -> Result<(), CaptureError> {
    if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
    if output.try_exists().map_err(|_| CaptureError::FileIo)? { return Err(CaptureError::FileIo); }
    if start_ms >= end_ms { return Err(CaptureError::InvalidSelection); }
    let time = |ms: u64| ms.checked_mul(1_000_000).filter(|ns| *ns != u64::MAX)
        .map(gst::ClockTime::from_nseconds).ok_or(CaptureError::InvalidSelection);
    let start = time(start_ms)?;
    let end = time(end_ms)?;
    initialize()?;
    let pipeline = Pipeline(gst::Pipeline::new());
    let decode = element("uridecodebin", CaptureError::VideoDecoderUnavailable)?;
    let uri = url::Url::from_file_path(source).map_err(|_| CaptureError::FileIo)?;
    decode.set_property("uri", uri.as_str());
    decode.set_property("caps", gst::Caps::builder("video/x-raw").build());
    decode.set_property("expose-all-streams", false);
    let convert = element("videoconvert", CaptureError::VideoPipelineUnavailable)?;
    let samples = element("appsink", CaptureError::VideoDecoderUnavailable)?;
    samples.set_property("emit-signals", true);
    samples.set_property("sync", false);
    pipeline.0.add_many([&decode, &convert, &samples]).map_err(|_| CaptureError::NativeFailure)?;
    convert.link(&samples).map_err(|_| CaptureError::NativeFailure)?;
    let input = convert.static_pad("sink").ok_or(CaptureError::NativeFailure)?;
    decode.connect_pad_added(move |_, pad| {
        if pad.current_caps().and_then(|caps| caps.structure(0).map(|s| s.name().starts_with("video/"))).unwrap_or(false) {
            let _ = pad.link(&input);
        }
    });
    // A seeking decoder must not preroll the output muxer: a flushed muxer can
    // otherwise leave excluded bytes or a corrupt EBML header in the file.
    // appsrc's native blocking/default queue budget supplies backpressure.
    let writer = Pipeline(gst::Pipeline::new());
    let frames = element("appsrc", CaptureError::VideoPipelineUnavailable)?;
    frames.set_property("format", gst::Format::Time);
    frames.set_property("block", true);
    let encoder = element("vp8enc", CaptureError::VideoEncoderUnavailable)?;
    let muxer = element("webmmux", CaptureError::VideoMuxerUnavailable)?;
    let sink = gst::ElementFactory::make("filesink").name("recording-output").build().map_err(|_| CaptureError::VideoMuxerUnavailable)?;
    sink.set_property("location", output.to_str().ok_or(CaptureError::FileIo)?);
    writer.0.add_many([&frames, &encoder, &muxer, &sink]).map_err(|_| CaptureError::NativeFailure)?;
    gst::Element::link_many([&frames, &encoder, &muxer, &sink]).map_err(|_| CaptureError::NativeFailure)?;
    let cancelling = pipeline.0.clone();
    let cancelling_writer = writer.0.clone();
    cancel.on_cancel(move || {
        // Native cancellation wakes preroll and the bus wait; no timer or worker pool.
        // Release appsrc backpressure before stopping the decoding callback.
        let _ = cancelling_writer.set_state(gst::State::Null);
        let _ = cancelling.set_state(gst::State::Null);
        let _ = cancelling.post_message(gst::message::Application::new(gst::Structure::new_empty("cancelled")));
        let _ = cancelling_writer.post_message(gst::message::Application::new(gst::Structure::new_empty("cancelled")));
    });
    let result = (|| {
        pipeline.0.set_state(gst::State::Paused).map_err(|_| CaptureError::InvalidMedia)?;
        pipeline.0.state(gst::ClockTime::NONE).0.map_err(|_| CaptureError::InvalidMedia)?;
        if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
        let duration = decode.query_duration::<gst::ClockTime>().ok_or(CaptureError::InvalidMedia)?;
        if end > duration { return Err(CaptureError::InvalidSelection); }
        decode.seek(1., gst::SeekFlags::FLUSH | gst::SeekFlags::ACCURATE,
            gst::SeekType::Set, start, gst::SeekType::Set, end).map_err(|_| CaptureError::InvalidSelection)?;
        pipeline.0.state(gst::ClockTime::NONE).0.map_err(|_| CaptureError::InvalidMedia)?;
        if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
        let caps = samples.static_pad("sink").and_then(|pad| pad.current_caps()).ok_or(CaptureError::InvalidMedia)?;
        frames.set_property("caps", caps);
        let output = frames.clone();
        samples.connect("new-sample", false, move |values| {
            let sink = values[0].get::<gst::Element>().unwrap();
            let Some(sample) = sink.emit_by_name::<Option<gst::Sample>>("pull-sample", &[]) else { return Some(gst::FlowReturn::Eos.to_value()); };
            let Some(mut buffer) = sample.buffer_owned() else { return Some(gst::FlowReturn::Error.to_value()); };
            let Some(segment) = sample.segment().and_then(|segment| segment.downcast_ref::<gst::ClockTime>()) else { return Some(gst::FlowReturn::Error.to_value()); };
            let Some(timestamp) = buffer.pts().and_then(|pts| segment.to_running_time(pts)) else { return Some(gst::FlowReturn::Error.to_value()); };
            buffer.make_mut().set_pts(timestamp);
            buffer.make_mut().set_dts(gst::ClockTime::NONE);
            Some(output.emit_by_name::<gst::FlowReturn>("push-buffer", &[&buffer]).to_value())
        });
        writer.0.set_state(gst::State::Playing).map_err(|_| CaptureError::NativeFailure)?;
        pipeline.0.set_state(gst::State::Playing).map_err(|_| CaptureError::NativeFailure)?;
        await_eos(&pipeline.0, cancel)?;
        if frames.emit_by_name::<gst::FlowReturn>("end-of-stream", &[]) != gst::FlowReturn::Ok { return Err(CaptureError::NativeFailure); }
        await_eos(&writer.0, cancel)
    })();
    cancel.clear_wake();
    drop(writer); drop(pipeline); // Release both pipelines before removing partial output.
    let result = if cancel.is_cancelled() { Err(CaptureError::Cancelled) } else { result };
    if result.is_err() && output.try_exists().map_err(|_| CaptureError::FileIo)? {
        std::fs::remove_file(output).map_err(|_| CaptureError::FileIo)?;
    }
    result
}

fn retime(buffer: &mut gst::BufferRef, timeline: &mut Timeline) -> bool {
    let Some(source_time) = buffer.pts() else { return false; };
    let Some(output_ns) = timeline.sample_time(source_time.nseconds()) else { return false; };
    let output = gst::ClockTime::from_nseconds(output_ns);
    buffer.set_pts(output);
    if buffer.dts().is_some() { buffer.set_dts(output); }
    true
}

fn dimensions(caps: &gst::CapsRef) -> Result<PixelSize, CaptureError> {
    let video = caps.structure(0).ok_or(CaptureError::InvalidMedia)?;
    let width = video.get::<i32>("width").map_err(|_| CaptureError::InvalidMedia)?;
    let height = video.get::<i32>("height").map_err(|_| CaptureError::InvalidMedia)?;
    if width <= 0 || height <= 0 { return Err(CaptureError::InvalidMedia); }
    Ok(PixelSize { width: width as u32, height: height as u32 })
}

fn observe_samples(pipeline: &gst::Pipeline, convert: &gst::Element, timeline: Arc<Mutex<Timeline>>,
    size_tx: mpsc::Sender<Result<PixelSize, CaptureError>>, source_ended: Arc<AtomicBool>) -> Result<Arc<Mutex<Option<gst::Buffer>>>, CaptureError> {
    let changed = pipeline.downgrade();
    let initial_size = Mutex::new(None);
    let last_sample = Arc::new(Mutex::new(None)); let retained = last_sample.clone();
    convert.static_pad("src").ok_or(CaptureError::NativeFailure)?.add_probe(gst::PadProbeType::BUFFER | gst::PadProbeType::EVENT_DOWNSTREAM,
        move |_, info| {
            if source_ended.load(Ordering::Acquire) {
                return if info.event().is_some() { gst::PadProbeReturn::Handled } else { gst::PadProbeReturn::Drop };
            }
            if let Some(gst::EventView::Caps(caps)) = info.event().map(|event| event.view()) {
                let size = dimensions(caps.caps());
                if let Ok(size) = size {
                    let mut initial = initial_size.lock().unwrap();
                    if initial.is_some_and(|before| before != size) {
                        source_ended.store(true, Ordering::Release);
                        if let Some(pipeline) = changed.upgrade() { notify(&pipeline, "source-closed"); }
                        return gst::PadProbeReturn::Handled;
                    }
                    *initial = Some(size);
                }
                let _ = size_tx.send(size);
            }
            if let Some(gst::PadProbeData::Buffer(buffer)) = &mut info.data {
                if !retime(buffer.make_mut(), &mut timeline.lock().unwrap()) { return gst::PadProbeReturn::Drop; }
                *retained.lock().unwrap() = Some(buffer.clone());
            }
            gst::PadProbeReturn::Ok
        });
    Ok(last_sample)
}

enum Selection {
    Portal,
    Window { id: u32, scale: f64, source: CaptureSource },
    Region { x: std::ops::RangeInclusive<u32>, y: std::ops::RangeInclusive<u32>, scale: f64, origin: CaptureOrigin, display_frame: Rect },
}
impl Selection {
    fn metadata(&self) -> (Option<f64>, Option<CaptureOrigin>, Option<CaptureSource>) {
        match self {
            Self::Portal => (None, None, None),
            Self::Window { scale, source, .. } => (Some(*scale), None, Some(source.clone())),
            Self::Region { scale, origin, .. } => (Some(*scale), Some(origin.clone()), None),
        }
    }
}

fn x11_selection(inventory: &Inventory, target: &CaptureTarget) -> Result<Selection, CaptureError> {
    match target {
        CaptureTarget::Frontmost => {
            let window = inventory.windows.first().ok_or(CaptureError::TargetUnavailable)?;
            x11_selection(inventory, &CaptureTarget::Window { window_id: window.window_id })
        },
        CaptureTarget::Window { window_id } => {
            let window = inventory.windows.iter().find(|w| w.window_id == *window_id).ok_or(CaptureError::TargetUnavailable)?;
            let display = inventory.window_display(window).ok_or(CaptureError::TargetUnavailable)?;
            Ok(Selection::Window { id: *window_id, scale: display.scale,
                source: CaptureSource { app_name: window.app_name.clone(), window_title: window.title.clone(), window_id: Some(*window_id) } })
        },
        CaptureTarget::Display { display_id } | CaptureTarget::Rect { display_id, .. } => {
            let display = inventory.displays.iter().find(|d| d.display_id == *display_id).ok_or(CaptureError::TargetUnavailable)?;
            let rect = crate::capture::clamp_local_rect(if let CaptureTarget::Rect { rect, .. } = target { *rect }
                else { Rect { x: 0., y: 0., width: display.frame.width, height: display.frame.height } }, display)?;
            let (x, y) = crate::geometry::display_pixel_ranges(rect, display.scale,
                (display.frame.width * display.scale).round() as u32, (display.frame.height * display.scale).round() as u32)
                .ok_or(CaptureError::InvalidSelection)?;
            // P1 owns coverage and signed native display origins. ximagesrc's
            // inclusive guint bounds are the native API's representation boundary.
            let coordinate = |origin: f64, local: u32| u32::try_from(origin.round() as i64 + i64::from(local))
                .map_err(|_| CaptureError::InvalidSelection);
            Ok(Selection::Region { x: coordinate(display.frame.x, x.start)?..=coordinate(display.frame.x, x.end - 1)?,
                y: coordinate(display.frame.y, y.start)?..=coordinate(display.frame.y, y.end - 1)?,
                scale: display.scale, origin: CaptureOrigin { display_id: *display_id, rect },
                display_frame: Rect { width: (display.frame.width * display.scale).round(), height: (display.frame.height * display.scale).round(), ..display.frame } })
        },
    }
}

fn x11_connection() -> Result<(x11rb::rust_connection::RustConnection, usize), CaptureError> {
    use x11rb::protocol::xproto::ConnectionExt;
    let (connection, screen) = x11rb::connect(None).map_err(|_| CaptureError::TargetUnavailable)?;
    let fixes = connection.query_extension(b"XFIXES").map_err(|_| CaptureError::NativeFailure)?.reply().map_err(|_| CaptureError::NativeFailure)?;
    if fixes.present { Ok((connection, screen)) } else { Err(CaptureError::CursorUnavailable) }
}

#[path = "linux_x11.rs"]
mod x11;

fn notify(pipeline: &gst::Pipeline, name: &str) {
    let _ = pipeline.post_message(gst::message::Application::new(gst::Structure::new_empty(name)));
}

struct LinuxRecorder {
    pipeline: Pipeline,
    grant: Option<ScreenCastGrant>,
    source_watch: Option<x11::SourceWatch>,
    stopped: Arc<AtomicBool>,
    source_ended: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
    completed: Option<mpsc::Receiver<Result<Option<CaptureError>, CaptureError>>>,
    failed: Arc<dyn Fn(CaptureError) + Send + Sync>,
    last_sample: Arc<Mutex<Option<gst::Buffer>>>,
    encoder_input: gst::Pad,
    _xlib_trap: Option<x11::ErrorTrap>,
}
impl Backend for LinuxRecorder {
    fn start(&mut self) -> Result<(), CaptureError> {
        let bus = self.pipeline.0.bus().ok_or(CaptureError::NativeFailure)?;
        let stopped = self.stopped.clone();
        let source_ended = self.source_ended.clone();
        let failed = self.failed.clone();
        let (sender, receiver) = mpsc::channel(); self.completed = Some(receiver);
        self.worker = Some(std::thread::spawn(move || {
            let mut warning = None;
            let close_source = |warning: &mut Option<CaptureError>| {
                source_ended.store(true, Ordering::Release);
                if warning.is_none() {
                    *warning = Some(CaptureError::TargetUnavailable);
                    // The lifecycle owns the end timestamp. Its finish injects
                    // the static tail and EOS; this worker then awaits muxer EOS.
                    let failed = failed.clone();
                    std::thread::spawn(move || failed(CaptureError::TargetUnavailable));
                }
            };
            let result = loop {
                let Some(message) = bus.timed_pop(gst::ClockTime::NONE) else { break Err(CaptureError::NativeFailure); };
                match message.view() {
                    gst::MessageView::Eos(_) => break Ok(warning.or_else(|| (!stopped.load(Ordering::Acquire)).then_some(CaptureError::TargetUnavailable))),
                    gst::MessageView::Error(error) if error.src().is_some_and(|source| source.name() == "recording-source") => {
                        close_source(&mut warning);
                    },
                    gst::MessageView::Error(_) => break Err(bus_failure(&message)),
                    gst::MessageView::Application(application) => match application.structure().map(|s| s.name().as_str()) {
                        Some("cancelled") => break Err(CaptureError::Cancelled),
                        Some("source-closed") => {
                            close_source(&mut warning);
                        },
                        _ => {},
                    },
                    _ => {},
                }
            };
            let error = match result { Ok(warning) => warning, Err(error) => Some(error) };
            let _ = sender.send(result);
            if !stopped.load(Ordering::Acquire) && warning.is_none() {
                if let Some(error) = error {
                    // The Session's finish joins this bus worker. Deliver the terminal
                    // callback off that worker, after its result has been produced.
                    std::thread::spawn(move || failed(error));
                }
            }
        }));
        Ok(())
    }
    fn finish(&mut self, duration_ns: u64) -> Result<Option<CaptureError>, CaptureError> {
        self.stopped.store(true, Ordering::Release);
        self.source_ended.store(true, Ordering::Release);
        let completed = self.completed.take().ok_or(CaptureError::NativeFailure)?;
        let result = match completed.try_recv() {
            Ok(result) => result,
            Err(mpsc::TryRecvError::Empty) => {
                // PipeWire sends changed content; its defaults need not resend a
                // static frame. One retained raw sample closes the presentation
                // interval at Stop, using the lifecycle's pause-free active time.
                let mut last = self.last_sample.lock().unwrap().clone().ok_or(CaptureError::NativeFailure)?;
                if duration_ns > 0 && last.pts().is_some_and(|pts| pts.nseconds() < duration_ns - 1) {
                    last.make_mut().set_pts(gst::ClockTime::from_nseconds(duration_ns - 1));
                    last.make_mut().set_dts(gst::ClockTime::NONE);
                    last.make_mut().set_duration(gst::ClockTime::from_nseconds(1));
                    self.encoder_input.chain(last).map_err(|_| CaptureError::NativeFailure)?;
                }
                if !self.encoder_input.send_event(gst::event::Eos::new()) { notify(&self.pipeline.0, "cancelled"); }
                completed.recv().map_err(|_| CaptureError::NativeFailure)?
            },
            Err(mpsc::TryRecvError::Disconnected) => Err(CaptureError::NativeFailure),
        };
        if let Some(worker) = self.worker.take() { let _ = worker.join(); }
        x11::teardown(|| { let _ = self.pipeline.0.set_state(gst::State::Null); });
        self.grant.take(); // The granted fd and session outlive the awaited EOS.
        self.source_watch.take();
        result
    }
    fn cancel(&mut self) {
        self.stopped.store(true, Ordering::Release);
        self.source_ended.store(true, Ordering::Release);
        notify(&self.pipeline.0, "cancelled");
        x11::teardown(|| { let _ = self.pipeline.0.set_state(gst::State::Null); });
        if let Some(worker) = self.worker.take() { let _ = worker.join(); }
        self.completed.take(); self.grant.take(); self.source_watch.take();
    }
}
impl Drop for LinuxRecorder { fn drop(&mut self) { self.cancel(); } }

fn prepare_pipeline(path: &Path, timeline: Arc<Mutex<Timeline>>, failed: Arc<dyn Fn(CaptureError) + Send + Sync>,
    cancel: &CancelSignal, selection: &Selection) -> Result<(LinuxRecorder, PixelSize), CaptureError> {
    if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
    initialize()?;
    // Element creation is the one requested-start prerequisite check, before consent.
    let portal = matches!(selection, Selection::Portal);
    let source = gst::ElementFactory::make(if portal { "pipewiresrc" } else { "ximagesrc" }).name("recording-source").build()
        .map_err(|_| if portal { CaptureError::PipewireUnavailable } else { CaptureError::VideoPipelineUnavailable })?;
    let convert = gst::ElementFactory::make("videoconvert").name("recording-convert").build().map_err(|_| CaptureError::VideoPipelineUnavailable)?;
    let encoder = element("vp8enc", CaptureError::VideoEncoderUnavailable)?;
    let muxer = element("webmmux", CaptureError::VideoMuxerUnavailable)?;
    let sink = gst::ElementFactory::make("filesink").name("recording-output").build().map_err(|_| CaptureError::VideoMuxerUnavailable)?;
    sink.set_property("location", path.to_str().ok_or(CaptureError::FileIo)?);
    sink.set_property("async", false);
    let mut xlib_trap = None;
    let source_ended = Arc::new(AtomicBool::new(false));
    let pipeline = Pipeline(gst::Pipeline::new());
    let mut source_watch = None;
    let grant = match selection {
        Selection::Portal => {
            let closed = pipeline.0.clone();
            let ended = source_ended.clone();
            let grant = crate::capture::linux::screencast(3, cancel, Arc::new(move || { ended.store(true, Ordering::Release); notify(&closed, "source-closed"); }))?;
            source.set_property("fd", grant.fd.as_raw_fd());
            if let Some(serial) = grant.stream.serial {
                if source.find_property("target-object").is_none() { return Err(CaptureError::PipewireUnavailable); }
                source.set_property("target-object", serial.to_string());
            } else { source.set_property("path", grant.stream.node_id.to_string()); }
            Some(grant)
        },
        Selection::Window { id, .. } => {
            let connection = x11_connection()?.0;
            xlib_trap = Some(x11::ErrorTrap::install(&connection, *id)?);
            source_watch = Some(x11::SourceWatch::window(connection, *id)?);
            source.set_property("show-pointer", true); source.set_property("xid", u64::from(*id)); None
        },
        Selection::Region { x, y, origin, display_frame, .. } => {
            let (connection, screen) = x11_connection()?;
            x11::validate_region(&connection, screen, x, y)?;
            source_watch = Some(x11::SourceWatch::display(connection, screen, origin.display_id, *display_frame,
                PixelSize { width: x.end() - x.start() + 1, height: y.end() - y.start() + 1 })?);
            source.set_property("show-pointer", true);
            source.set_property("startx", *x.start()); source.set_property("endx", *x.end());
            source.set_property("starty", *y.start()); source.set_property("endy", *y.end()); None
        },
    };
    // Linking queries source caps and may open the X display. Bind xid/area
    // first; ximagesrc refuses a later xid change and would capture the root.
    pipeline.0.add_many([&source, &convert, &encoder, &muxer, &sink]).map_err(|_| CaptureError::NativeFailure)?;
    gst::Element::link_many([&source, &convert, &encoder, &muxer, &sink]).map_err(|_| CaptureError::NativeFailure)?;
    let (size_tx, size_rx) = mpsc::channel();
    let bus = pipeline.0.bus().ok_or(CaptureError::NativeFailure)?;
    let failure = size_tx.clone();
    bus.set_sync_handler(move |_, message| {
        match message.view() {
            gst::MessageView::Error(_) => { let _ = failure.send(Err(bus_failure(message))); },
            gst::MessageView::Application(message) if message.structure().is_some_and(|s| s.name() == "source-closed") => {
                let _ = failure.send(Err(CaptureError::TargetUnavailable));
            },
            gst::MessageView::Application(message) if message.structure().is_some_and(|s| s.name() == "cancelled") => {
                let _ = failure.send(Err(CaptureError::Cancelled));
            },
            _ => {},
        }
        gst::BusSyncReply::Pass
    });
    let last_sample = observe_samples(&pipeline.0, &convert, timeline, size_tx, source_ended.clone())?;
    let cancelling = pipeline.0.clone();
    cancel.on_cancel(move || notify(&cancelling, "cancelled"));
    let result = (|| {
        pipeline.0.set_state(gst::State::Playing).map_err(|_| CaptureError::NativeFailure)?;
        size_rx.recv().map_err(|_| CaptureError::NativeFailure)?
    })();
    cancel.clear_wake(); bus.unset_sync_handler();
    let pixel_size = result?;
    if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
    if let Some(watch) = &mut source_watch {
        // ximagesrc opens the drawable synchronously while querying caps. It
        // silently falls back to root for a missing xid; its xid getter still
        // reports the requested id. Drain the pre-open event subscription after
        // a server barrier, while Preparing still drops every raw sample.
        watch.admit(pixel_size)?;
        let closed = pipeline.0.clone();
        let ended = source_ended.clone();
        watch.start(move || { ended.store(true, Ordering::Release); notify(&closed, "source-closed"); })?;
    }
    Ok((LinuxRecorder { pipeline, grant, source_watch, source_ended, stopped: Arc::new(AtomicBool::new(false)),
        worker: None, completed: None, failed, last_sample, _xlib_trap: xlib_trap,
        encoder_input: encoder.static_pad("sink").ok_or(CaptureError::NativeFailure)? }, pixel_size))
}

fn prepare_stream(path: &Path, timeline: Arc<Mutex<Timeline>>, failed: Arc<dyn Fn(CaptureError) + Send + Sync>,
    cancel: &CancelSignal, selection: Selection) -> Result<PreparedBackend, CaptureError> {
    let (scale, origin, source) = selection.metadata();
    let (backend, pixel_size) = prepare_pipeline(path, timeline, failed, cancel, &selection)?;
    Ok(PreparedBackend { backend: Box::new(backend), pixel_size, scale, origin, source })
}

pub fn prepare_wayland(path: &Path, timeline: Arc<Mutex<Timeline>>, failed: Arc<dyn Fn(CaptureError) + Send + Sync>,
    cancel: &CancelSignal) -> Result<PreparedBackend, CaptureError> {
    prepare_stream(path, timeline, failed, cancel, Selection::Portal)
}

pub fn prepare(inventory: &Inventory, target: &CaptureTarget, path: &Path, timeline: Arc<Mutex<Timeline>>,
    failed: Arc<dyn Fn(CaptureError) + Send + Sync>) -> Result<PreparedBackend, CaptureError> {
    prepare_stream(path, timeline, failed, &CancelSignal::default(), x11_selection(inventory, target)?)
}

#[cfg(test)]
#[path = "linux_x11_tests.rs"]
mod x11_tests;

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(path: &Path) {
        fixture_size(path, PixelSize { width: 64, height: 48 });
    }
    fn fixture_size(path: &Path, size: PixelSize) {
        gst::init().unwrap();
        let pipeline = gst::parse::launch(&format!("concat name=frames ! videoconvert ! vp8enc ! webmmux ! filesink name=output videotestsrc num-buffers=30 pattern=red ! video/x-raw,width={},height={},framerate=30/1 ! frames. videotestsrc num-buffers=30 pattern=green ! video/x-raw,width={},height={},framerate=30/1 ! frames.", size.width, size.height, size.width, size.height))
            .unwrap().downcast::<gst::Pipeline>().unwrap();
        pipeline.by_name("output").unwrap().set_property("location", path.to_str().unwrap());
        pipeline.set_state(gst::State::Playing).unwrap();
        let message = pipeline.bus().unwrap().timed_pop_filtered(gst::ClockTime::NONE, &[gst::MessageType::Eos, gst::MessageType::Error]).unwrap();
        pipeline.set_state(gst::State::Null).unwrap();
        assert!(matches!(message.view(), gst::MessageView::Eos(_)), "{message:?}");
    }

    #[test]
    fn physical_trim_reencodes_only_the_requested_silent_interval_and_preserves_source() {
        let root = tempfile::tempdir().unwrap(); let source = root.path().join("source.webm"); let output = root.path().join("trim.webm");
        fixture(&source); let before = std::fs::read(&source).unwrap();
        let red = first_pixel(&source); assert!(red[0] > red[1] && red[0] > red[2]);
        trim(&source, &output, 1000, 2000, &CancelSignal::default()).unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), before);
        let movie = matroska_demuxer::MatroskaFile::open(std::fs::File::open(&output).unwrap()).unwrap();
        assert_eq!(movie.tracks().len(), 1);
        assert_eq!(movie.tracks()[0].codec_id().trim_end_matches('\0'), "V_VP8");
        let info = movie.info();
        let ns = info.duration().unwrap() * info.timestamp_scale().get() as f64;
        assert!((ns - 1_000_000_000.).abs() < 40_000_000., "encoded duration {ns}");
        let green = first_pixel(&output); assert!(green[1] > green[0] && green[1] > green[2], "excluded red pixels remain in output: {green:?}");
    }

    pub(super) fn first_pixel(path: &Path) -> [u8; 4] {
        decoded_pixels(path)[0]
    }

    fn decoded_pixels(path: &Path) -> Vec<[u8; 4]> {
        let pipeline = Pipeline(gst::parse::launch("uridecodebin name=decode ! videoconvert ! video/x-raw,format=RGBA ! fakesink name=output sync=false signal-handoffs=true")
            .unwrap().downcast::<gst::Pipeline>().unwrap());
        pipeline.0.by_name("decode").unwrap().set_property("uri", url::Url::from_file_path(path).unwrap().as_str());
        let pixels = Arc::new(Mutex::new(Vec::new())); let observed = pixels.clone();
        pipeline.0.by_name("output").unwrap().connect("handoff", false, move |values| {
            let buffer = values[1].get::<gst::Buffer>().unwrap();
            let map = buffer.map_readable().unwrap();
            observed.lock().unwrap().push(map[..4].try_into().unwrap());
            None
        });
        pipeline.0.set_state(gst::State::Playing).unwrap();
        await_eos(&pipeline.0, &CancelSignal::default()).unwrap();
        let result = pixels.lock().unwrap().clone(); result
    }

    #[test]
    fn invalid_or_cancelled_trim_never_changes_the_existing_source_or_retains_output() {
        let root = tempfile::tempdir().unwrap(); let source = root.path().join("source.webm"); let output = root.path().join("trim.webm");
        fixture(&source); let before = std::fs::read(&source).unwrap();
        for (start, end) in [(0,2001), (1000,1000), (2000,1000)] {
            assert_eq!(trim(&source, &output, start, end, &CancelSignal::default()), Err(CaptureError::InvalidSelection));
            assert!(!output.exists());
        }
        assert_eq!(trim(&source, &source, 0, 1000, &CancelSignal::default()), Err(CaptureError::FileIo));
        let cancel = CancelSignal::default(); cancel.cancel();
        assert_eq!(trim(&source, &output, 0, 1000, &cancel), Err(CaptureError::Cancelled));
        assert!(!output.exists()); assert_eq!(std::fs::read(&source).unwrap(), before);
    }

    #[test]
    fn active_trim_cancellation_on_native_file_creation_releases_both_pipelines_and_partial_output() {
        use notify::Watcher;
        let root = tempfile::tempdir().unwrap(); let source = root.path().join("source.webm"); let output = root.path().join("trim.webm");
        fixture_size(&source, PixelSize { width: 1920, height: 1080 });
        let before = std::fs::read(&source).unwrap();
        let cancel = CancelSignal::default(); let observed_cancel = cancel.clone(); let observed_output = output.clone();
        let mut watcher = notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
            if let Ok(event) = event {
                if matches!(event.kind, notify::EventKind::Create(_)) && event.paths.contains(&observed_output) { observed_cancel.cancel(); }
            }
        }).unwrap();
        watcher.watch(root.path(), notify::RecursiveMode::NonRecursive).unwrap();
        assert_eq!(trim(&source, &output, 1000, 2000, &cancel), Err(CaptureError::Cancelled));
        drop(watcher);
        assert!(!output.exists(), "cancelled export cannot publish a partial derivative");
        assert_eq!(std::fs::read(&source).unwrap(), before);
    }

    #[test]
    fn x11_region_uses_p1_pixel_coverage_and_native_origin_with_inclusive_source_bounds() {
        let display = crate::capture::DisplayDescriptor { display_id: 7, frame: Rect { x: 200., y: 100., width: 100., height: 80. },
            scale: 2., desktop_scale: 2., storage_key: None, localized_name: None, safe_area_top: 0., physical_notch_size: None };
        let inventory = Inventory { displays: vec![display], windows: vec![] };
        let Selection::Region { x, y, .. } = x11_selection(&inventory,
            &CaptureTarget::Rect { display_id: 7, rect: Rect { x: 10., y: 20., width: 30., height: 40. } }).unwrap() else { panic!("native region required"); };
        assert_eq!(x, 220..=279); assert_eq!(y, 140..=219);
    }

    #[test]
    fn missing_pipewire_settles_before_portal_consent_without_retaining_a_recorder() {
        let root = tempfile::tempdir().unwrap();
        let status = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "capture::recording::linux::tests::missing_pipewire_child", "--nocapture"])
            .env("HAPPIER_TEST_MISSING_PIPEWIRE", "1")
            .env("GST_PLUGIN_SYSTEM_PATH_1_0", "").env("GST_PLUGIN_PATH_1_0", "")
            .env("GST_REGISTRY_1_0", root.path().join("registry.bin"))
            .status().unwrap();
        assert!(status.success());
    }

    #[test]
    fn missing_pipewire_child() {
        if std::env::var("HAPPIER_TEST_MISSING_PIPEWIRE").as_deref() != Ok("1") { return; }
        let root = tempfile::tempdir().unwrap(); let path = root.path().join("video.webm");
        let registered = Arc::new(Mutex::new(None)); let current = registered.clone();
        let result = super::super::Session::start(|timeline, _| {
            let prepared = prepare_wayland(&path, timeline, Arc::new(|_| panic!("no recording was admitted")), &CancelSignal::default())?;
            Ok((prepared.backend, Box::new(|| unreachable!("no file can finalize without its source"))))
        }, Arc::new(|_| {}), super::super::clock(), move |session| *current.lock().unwrap() = Some(session));
        assert!(matches!(result, Err(CaptureError::PipewireUnavailable)));
        let snapshot = registered.lock().unwrap().as_ref().unwrap().snapshot();
        assert_eq!(snapshot.phase, super::super::Phase::Failed);
        assert_eq!(snapshot.error, Some(CaptureError::PipewireUnavailable));
        assert!(!path.exists());
        let missing_x11 = prepare_pipeline(&path, Arc::new(Mutex::new(Timeline::new())), Arc::new(|_| {}), &CancelSignal::default(),
            &Selection::Window { id: 42, scale: 1., source: CaptureSource { app_name: None, window_title: None, window_id: Some(42) } });
        assert!(matches!(missing_x11, Err(CaptureError::VideoPipelineUnavailable)), "missing ximagesrc settles before connecting to X11 or any portal");
    }

    #[test]
    fn paused_buffers_never_enter_encoder_and_resume_rewrites_presentation_and_decode_time() {
        gst::init().unwrap();
        let mut timeline = Timeline::new();
        let moment = |seconds: u64| super::super::Moment { steady_ns: seconds * 1_000_000_000, epoch_ms: seconds * 1000 };
        timeline.start(moment(10));
        let mut buffer = gst::Buffer::new();
        buffer.make_mut().set_pts(gst::ClockTime::from_seconds(100));
        buffer.make_mut().set_dts(gst::ClockTime::from_seconds(100));
        assert!(retime(buffer.make_mut(), &mut timeline));
        assert_eq!(buffer.pts(), Some(gst::ClockTime::ZERO));
        timeline.pause(moment(11));
        buffer.make_mut().set_pts(gst::ClockTime::from_seconds(105));
        assert!(!retime(buffer.make_mut(), &mut timeline));
        timeline.resume(moment(20));
        buffer.make_mut().set_pts(gst::ClockTime::from_seconds(110));
        buffer.make_mut().set_dts(gst::ClockTime::from_seconds(110));
        assert!(retime(buffer.make_mut(), &mut timeline));
        assert_eq!(buffer.pts(), Some(gst::ClockTime::SECOND));
        assert_eq!(buffer.dts(), Some(gst::ClockTime::SECOND));
    }

    #[test]
    fn real_writer_drops_preparing_pixels_extends_static_tail_to_stop_and_releases_its_pipeline_after_eos() {
        synthetic_writer(false);
    }

    #[test]
    fn changed_native_caps_cannot_submit_replacement_pixels_and_source_close_uses_the_lifecycle_end_time() {
        synthetic_writer(true);
    }

    fn synthetic_writer(source_changed: bool) {
        initialize().unwrap();
        let root = tempfile::tempdir().unwrap(); let path = root.path().join("static.webm");
        // Only the OS source is replaced: real raw GstBuffers traverse conversion,
        // VP8, WebM, disk completion and the production Backend::finish.
        let pipeline = Pipeline(gst::parse::launch("identity name=input ! videoconvert name=convert ! vp8enc name=encoder ! webmmux ! filesink name=recording-output async=false")
            .unwrap().downcast::<gst::Pipeline>().unwrap());
        let weak = pipeline.0.downgrade();
        pipeline.0.by_name("recording-output").unwrap().set_property("location", path.to_str().unwrap());
        let timeline = Arc::new(Mutex::new(Timeline::new()));
        let convert = pipeline.0.by_name("convert").unwrap();
        let (size_tx, _) = mpsc::channel();
        let source_ended = Arc::new(AtomicBool::new(false));
        let last_sample = observe_samples(&pipeline.0, &convert, timeline.clone(), size_tx, source_ended.clone()).unwrap();
        let replacement_caps = Arc::new(AtomicBool::new(false)); let observed = replacement_caps.clone();
        convert.static_pad("src").unwrap().add_probe(gst::PadProbeType::EVENT_DOWNSTREAM, move |_, info| {
            if let Some(gst::EventView::Caps(caps)) = info.event().map(|event| event.view()) {
                if dimensions(caps.caps()).unwrap() != (PixelSize { width: 64, height: 48 }) { observed.store(true, Ordering::Release); }
            }
            gst::PadProbeReturn::Ok
        });
        let (failure, failures) = mpsc::channel();
        let encoder_input = pipeline.0.by_name("encoder").unwrap().static_pad("sink").unwrap();
        let input = pipeline.0.by_name("input").unwrap().static_pad("sink").unwrap();
        let mut backend = LinuxRecorder { pipeline, grant: None, source_watch: None, source_ended, _xlib_trap: None, stopped: Arc::new(AtomicBool::new(false)), worker: None, completed: None,
            failed: Arc::new(move |error| { let _ = failure.send(error); }), last_sample: last_sample.clone(), encoder_input };
        backend.start().unwrap(); backend.pipeline.0.set_state(gst::State::Playing).unwrap();
        assert!(input.send_event(gst::event::StreamStart::new("synthetic-source")));
        let caps = gst::Caps::builder("video/x-raw").field("format", "RGBA").field("width", 64i32).field("height", 48i32)
            .field("framerate", gst::Fraction::new(30,1)).build();
        assert!(input.send_event(gst::event::Caps::new(&caps)));
        assert!(input.send_event(gst::event::Segment::new(&gst::FormattedSegment::<gst::ClockTime>::new())));
        let frame = |rgba: [u8;4]| {
            let mut buffer = gst::Buffer::from_mut_slice(rgba.repeat(64*48));
            buffer.make_mut().set_pts(gst::ClockTime::ZERO);
            buffer.make_mut().set_duration(gst::ClockTime::from_nseconds(33_333_333)); buffer
        };
        input.chain(frame([255,0,0,255])).unwrap();
        assert!(last_sample.lock().unwrap().is_none(), "Preparing content must never be retained or submitted");
        timeline.lock().unwrap().start(super::super::Moment { steady_ns: 0, epoch_ms: 0 });
        input.chain(frame([0,255,0,255])).unwrap();
        assert!(last_sample.lock().unwrap().is_some());
        if source_changed {
            let mut changed_caps = caps.clone();
            changed_caps.make_mut().structure_mut(0).unwrap().set("width", 128i32);
            changed_caps.make_mut().structure_mut(0).unwrap().set("height", 96i32);
            let _ = input.send_event(gst::event::Caps::new(&changed_caps));
            assert!(!replacement_caps.load(Ordering::Acquire), "changed source geometry reached the writer before the asynchronous lifecycle callback");
            let mut red = gst::Buffer::from_mut_slice([255u8,0,0,255].repeat(128*96));
            red.make_mut().set_pts(gst::ClockTime::from_seconds(1));
            let _ = input.chain(red);
            assert_eq!(failures.recv_timeout(std::time::Duration::from_secs(10)).unwrap(), CaptureError::TargetUnavailable);
        }
        timeline.lock().unwrap().snapshot.phase = super::super::Phase::Finalizing;
        assert_eq!(backend.finish(10_000_000_000), Ok(source_changed.then_some(CaptureError::TargetUnavailable)));
        let movie = matroska_demuxer::MatroskaFile::open(std::fs::File::open(&path).unwrap()).unwrap();
        let ns = movie.info().duration().unwrap() * movie.info().timestamp_scale().get() as f64;
        assert!((ns-10_000_000_000.).abs() < 1_000_000., "static source ended before Stop: {ns}");
        assert_eq!(movie.tracks().len(), 1);
        let pixels = decoded_pixels(&path); assert!(!pixels.is_empty());
        assert!(pixels.iter().all(|pixel| pixel[1] > pixel[0] && pixel[1] > pixel[2]), "Preparing or replacement source pixels leaked: {pixels:?}");
        drop(input); drop(backend);
        assert!(weak.upgrade().is_none(), "EOS must release the source/probe/bus graph");
    }
}
