//! Windows Graphics Capture feeds one explicit silent H.264 writer.
use super::{Backend, PreparedBackend, Timeline, pixels::{Crop, display_crop, pack_crop, window_pixel_size}};
use crate::{capture::{CaptureError, CaptureOrigin, CaptureSource, CaptureTarget, Inventory, PixelSize}, geometry::Rect};
use std::{path::Path, sync::{Arc, Mutex}};
use ::windows::{core::HSTRING, Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED}};
use windows_capture::{capture::{CaptureControl, Context, GraphicsCaptureApiHandler},
    encoder::{AudioSettingsBuilder, ContainerSettingsBuilder, VideoEncoder, VideoSettingsBuilder, VideoSettingsSubType},
    frame::Frame, graphics_capture_api::InternalCaptureControl, monitor::Monitor, window::Window,
    settings::{ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings, GraphicsCaptureItemType}};

struct WinRt;
impl WinRt {
    fn new() -> Result<Self, CaptureError> {
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(|_| CaptureError::NativeFailure)?;
        Ok(Self)
    }
}
impl Drop for WinRt { fn drop(&mut self) { unsafe { RoUninitialize(); } } }

fn encoder(path: &Path, size: PixelSize) -> Result<VideoEncoder, CaptureError> {
    VideoEncoder::new(VideoSettingsBuilder::new(size.width, size.height).sub_type(VideoSettingsSubType::H264),
        AudioSettingsBuilder::new().disabled(true), ContainerSettingsBuilder::new(), path)
        .map_err(|_| CaptureError::FileIo)
}

struct Writer { encoder: Option<VideoEncoder>, last: Option<(Vec<u8>, u64)> }
impl Writer {
    fn append(&mut self, pixels: Vec<u8>, timestamp_ns: u64) -> Result<(), CaptureError> {
        // A changed WGC frame covers the preceding frame's actual interval.
        // Keep one pending frame rather than asking the codec to infer a gap.
        if let Some((previous, start_ns)) = self.last.take() {
            self.encoder.as_mut().ok_or(CaptureError::OperationUnavailable)?
                .send_frame_buffer_with_duration(&previous,
                    (start_ns/100).try_into().map_err(|_| CaptureError::NativeFailure)?,
                    ((timestamp_ns-start_ns)/100).try_into().map_err(|_| CaptureError::NativeFailure)?)
                .map_err(|_| CaptureError::FileIo)?;
        }
        self.last = Some((pixels, timestamp_ns)); Ok(())
    }
    fn finish(&mut self, duration_ns: u64) -> Result<(), CaptureError> {
        let mut encoder = self.encoder.take().ok_or(CaptureError::OperationUnavailable)?;
        let Some((pixels, last_ns)) = self.last.take() else {
            let _ = encoder.finish(); return Err(CaptureError::NativeFailure);
        };
        // WGC only pushes changed frames. Close a static tail at the actual Stop
        // time rather than publishing a one-frame movie after a long recording.
        let tail = if duration_ns > last_ns {
            encoder.send_frame_buffer_with_duration(&pixels,
                (last_ns/100).try_into().map_err(|_| CaptureError::NativeFailure)?,
                ((duration_ns-last_ns)/100).try_into().map_err(|_| CaptureError::NativeFailure)?)
                .map_err(|_| CaptureError::FileIo)
        } else { Ok(()) };
        let completed = encoder.finish().map_err(|_| CaptureError::FileIo);
        tail.and(completed)
    }
}

enum Source { Window(Window), Monitor(Monitor) }
impl TryInto<GraphicsCaptureItemType> for Source {
    type Error = CaptureError;
    fn try_into(self) -> Result<GraphicsCaptureItemType, CaptureError> {
        match self {
            Self::Window(window) => window.try_into().map_err(|_| CaptureError::TargetUnavailable),
            Self::Monitor(monitor) => monitor.try_into().map_err(|_| CaptureError::TargetUnavailable),
        }
    }
}
struct Input {
    timeline: Arc<Mutex<Timeline>>, writer: Arc<Mutex<Writer>>,
    crop: Crop, source_size: PixelSize, failed: Arc<dyn Fn(CaptureError) + Send + Sync>,
}
struct Frames(Input);
impl GraphicsCaptureApiHandler for Frames {
    type Flags = Input;
    type Error = CaptureError;
    fn new(context: Context<Input>) -> Result<Self, CaptureError> { Ok(Self(context.flags)) }
    fn on_frame_arrived(&mut self, frame: &mut Frame, control: InternalCaptureControl) -> Result<(), CaptureError> {
        let result = (|| {
            let mut timeline = self.0.timeline.lock().unwrap();
            let source_ns = u64::try_from(frame.timestamp().map_err(|_| CaptureError::NativeFailure)?.Duration)
                .ok().and_then(|ticks| ticks.checked_mul(100)).ok_or(CaptureError::NativeFailure)?;
            let Some(timestamp) = timeline.sample_time(source_ns) else { return Ok(()); };
            if frame.width() != self.0.source_size.width || frame.height() != self.0.source_size.height {
                return Err(CaptureError::TargetUnavailable);
            }
            // Stage only the selected texture region, then pack its driver rows;
            // the encoder never resizes or guesses the selection origin.
            let size = self.0.crop.size();
            let mut buffer = frame.buffer_crop(self.0.crop.left, self.0.crop.top, self.0.crop.right, self.0.crop.bottom)
                .map_err(|_| CaptureError::NativeFailure)?;
            let stride = buffer.row_pitch() as usize;
            let pixels = pack_crop(buffer.as_raw_buffer(), stride, Crop { left: 0, top: 0, right: size.width, bottom: size.height })?;
            self.0.writer.lock().unwrap().append(pixels, timestamp)
        })();
        if let Err(error) = result { control.stop(); (self.0.failed)(error); }
        Ok(())
    }
    fn on_closed(&mut self) -> Result<(), CaptureError> {
        (self.0.failed)(CaptureError::TargetUnavailable); Ok(())
    }
}

struct WindowsRecorder {
    source: Option<Source>, input: Option<Input>, capture: Option<CaptureControl<Frames, CaptureError>>,
    writer: Arc<Mutex<Writer>>, exclusion: Option<crate::capture::windows::OwnWindowExclusion>,
}
impl Backend for WindowsRecorder {
    fn start(&mut self) -> Result<(), CaptureError> {
        let _runtime = WinRt::new()?;
        let input = self.input.take().ok_or(CaptureError::OperationUnavailable)?;
        let source = self.source.take().ok_or(CaptureError::OperationUnavailable)?;
        let settings = Settings::new(source, CursorCaptureSettings::WithCursor,
            DrawBorderSettings::WithoutBorder, SecondaryWindowSettings::Exclude,
            MinimumUpdateIntervalSettings::Default, DirtyRegionSettings::Default, ColorFormat::Bgra8, input);
        self.capture = Some(Frames::start_free_threaded(settings).map_err(|_| CaptureError::NativeFailure)?);
        Ok(())
    }
    fn finish(&mut self, duration_ns: u64) -> Result<Option<CaptureError>, CaptureError> {
        let _runtime = WinRt::new()?;
        let stopped = self.capture.take().map(|capture| capture.stop().map_err(|_| CaptureError::NativeFailure)).transpose();
        // WGC has joined and the shared timeline withdrew submission before finish.
        let completed = self.writer.lock().unwrap().finish(duration_ns);
        self.exclusion.take();
        completed.map(|_| stopped.err())
    }
    fn cancel(&mut self) {
        // The encoder's native EOS is still awaited on cancel so its worker cannot leak.
        let _ = self.finish(0); self.input.take(); self.source.take(); self.exclusion.take();
    }
}
impl Drop for WindowsRecorder {
    fn drop(&mut self) { if self.capture.is_some() || self.writer.lock().unwrap().encoder.is_some() { self.cancel(); } }
}

pub fn prepare(inventory: &Inventory, target: &CaptureTarget, path: &Path,
    timeline: Arc<Mutex<Timeline>>, failed: Arc<dyn Fn(CaptureError) + Send + Sync>) -> Result<PreparedBackend, CaptureError> {
    let _runtime = WinRt::new()?;
    let (source, crop, source_size, scale, origin, context) = match target {
        CaptureTarget::Frontmost => {
            let id = inventory.windows.first().ok_or(CaptureError::TargetUnavailable)?.window_id;
            return prepare(inventory, &CaptureTarget::Window { window_id: id }, path, timeline, failed);
        },
        CaptureTarget::Window { window_id } => {
            let facts = inventory.windows.iter().find(|window| window.window_id == *window_id).ok_or(CaptureError::TargetUnavailable)?;
            let window = Window::from_raw_hwnd(*window_id as usize as *mut _);
            if !window.is_valid() { return Err(CaptureError::TargetUnavailable); }
            let size = PixelSize { width: window.width().map_err(|_| CaptureError::TargetUnavailable)?.try_into().map_err(|_| CaptureError::TargetUnavailable)?,
                height: window.height().map_err(|_| CaptureError::TargetUnavailable)?.try_into().map_err(|_| CaptureError::TargetUnavailable)? };
            let encoded = window_pixel_size(size.width, size.height);
            let crop = Crop { left: 0, top: 0, right: encoded.width, bottom: encoded.height };
            let scale = inventory.window_display(facts).ok_or(CaptureError::TargetUnavailable)?.scale;
            (Source::Window(window), crop, size, scale, None, Some(CaptureSource {
                app_name: facts.app_name.clone(), window_title: facts.title.clone(), window_id: Some(*window_id) }))
        },
        CaptureTarget::Display { display_id } | CaptureTarget::Rect { display_id, .. } => {
            let display = inventory.displays.iter().find(|display| display.display_id == *display_id).ok_or(CaptureError::TargetUnavailable)?;
            let monitor = Monitor::enumerate().map_err(|_| CaptureError::TargetUnavailable)?.into_iter()
                .find(|monitor| monitor.index().ok() == Some(*display_id as usize)).ok_or(CaptureError::TargetUnavailable)?;
            let rect = if let CaptureTarget::Rect { rect, .. } = target { *rect }
                else { Rect { x: 0., y: 0., width: display.frame.width, height: display.frame.height } };
            let crop = display_crop(display, rect)?;
            let size = PixelSize { width: monitor.width().map_err(|_| CaptureError::TargetUnavailable)?,
                height: monitor.height().map_err(|_| CaptureError::TargetUnavailable)? };
            let origin = CaptureOrigin { display_id: *display_id, rect: Rect { x: crop.left as f64/display.scale,
                y: crop.top as f64/display.scale, width: (crop.right-crop.left) as f64/display.scale,
                height: (crop.bottom-crop.top) as f64/display.scale } };
            (Source::Monitor(monitor), crop, size, display.scale, Some(origin), None)
        },
    };
    let size = crop.size();
    let exclusion = crate::capture::windows::OwnWindowExclusion::apply()?;
    let writer = Arc::new(Mutex::new(Writer { encoder: Some(encoder(path, size)?), last: None }));
    let input = Input { timeline, writer: writer.clone(), crop, source_size, failed };
    Ok(PreparedBackend { backend: Box::new(WindowsRecorder { source: Some(source), input: Some(input), capture: None,
        writer, exclusion: Some(exclusion) }), pixel_size: size, scale: Some(scale), origin, source: context })
}

#[path = "windows_trim.rs"]
mod physical_trim;
pub use physical_trim::trim;

fn storage_path(path: &Path) -> Result<HSTRING, CaptureError> {
    // Storage APIs consume absolute DOS/UNC paths, not Rust's verbatim prefix.
    let path = path.canonicalize().map_err(|_| CaptureError::FileIo)?;
    let text = path.to_str().ok_or(CaptureError::FileIo)?;
    Ok(HSTRING::from(if let Some(unc) = text.strip_prefix(r"\\?\UNC\") { format!(r"\\{unc}") }
        else { text.strip_prefix(r"\\?\").unwrap_or(text).to_owned() }))
}

#[cfg(test)]
#[path = "windows_proof.rs"]
mod native_proof;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_h264_writer_is_silent_and_pause_removes_the_gap() {
        let _runtime = WinRt::new().unwrap();
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("selected.mp4");
        // WinRT thumbnails of tiny clips fail independently of valid playback;
        // the same 64x48 cropped file is verified through WebView2 below.
        let size = PixelSize { width: 320, height: 240 };
        let mut writer = Writer { encoder: Some(encoder(&path, size).unwrap()), last: None };
        let mut timeline = Timeline::new();
        timeline.start(super::super::Moment { steady_ns: 0, epoch_ms: 0 });
        let first = timeline.sample_time(10_000_000_000).unwrap();
        writer.append([0, 0, 255, 255].repeat((size.width*size.height) as usize), first).unwrap();
        timeline.pause(super::super::Moment { steady_ns: 1_000_000_000, epoch_ms: 1000 });
        assert_eq!(timeline.sample_time(12_000_000_000), None);
        timeline.resume(super::super::Moment { steady_ns: 10_000_000_000, epoch_ms: 10000 });
        let second = timeline.sample_time(20_000_000_000).unwrap();
        writer.append([0, 255, 0, 255].repeat((size.width*size.height) as usize), second).unwrap();
        writer.finish(2_000_000_000).unwrap();
        if let Some(destination) = std::env::var_os("HAPPIER_WINDOWS_PLAYER_FIXTURE") {
            std::fs::copy(&path, destination).unwrap();
        }
        let file = std::fs::File::open(&path).unwrap();
        let movie = mp4::Mp4Reader::read_header(&file, file.metadata().unwrap().len()).unwrap();
        eprintln!("WINDOWS_TRACKS {:?}", movie.tracks().values().map(|track| (track.media_type(), track.sample_count())).collect::<Vec<_>>());
        native_proof::assert_pixel(&path, 250, 0, 0, [255, 0, 0]);
        native_proof::assert_pixel(&path, 1250, 0, 0, [0, 255, 0]);
        assert_eq!(movie.tracks().len(), 1, "no audio track");
        let track = movie.tracks().values().next().unwrap();
        assert_eq!(track.media_type().unwrap(), mp4::MediaType::H264);
        assert_eq!((track.width() as u32, track.height() as u32), (size.width, size.height));
        assert!(movie.duration().abs_diff(std::time::Duration::from_secs(2)) < std::time::Duration::from_millis(17),
            "pause removed and tail held to Stop within the encoder's 60fps frame interval");
    }

    #[test]
    fn accurate_trim_keeps_source_and_exports_a_new_silent_selected_interval() {
        let _runtime = WinRt::new().unwrap();
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.mp4"); let output = root.path().join("trim.mp4");
        native_proof::write_dense_fixture(&source, PixelSize { width:64, height:48 }, &[[0,0,255,255], [0,255,0,255], [255,0,0,255]]);
        native_proof::trace_movie(&source);
        let source_file = std::fs::File::open(&source).unwrap();
        let mut source_movie = mp4::Mp4Reader::read_header(&source_file, source_file.metadata().unwrap().len()).unwrap();
        eprintln!("WINDOWS_DENSE_SOURCE duration={:?} tracks={:?}", source_movie.duration(),
            source_movie.tracks().values().map(|track| (track.media_type(), track.sample_count())).collect::<Vec<_>>());
        let track = source_movie.tracks().values().next().unwrap();
        let (track_id, timescale) = (track.track_id(), u64::from(track.timescale()));
        // Each fixture color lasts one second. Use the first keyframe's
        // presentation offset: later encoded sample ordinals can be reordered
        // B frames and do not identify the displayed color boundary.
        let first = source_movie.read_sample(track_id, 1).unwrap().unwrap();
        let first_pts = u64::try_from(i128::from(first.start_time) + i128::from(first.rendering_offset)).unwrap();
        let green_start = first_pts + timescale;
        let blue_start = first_pts + 2 * timescale;
        let start_ms = (green_start * 1000).div_ceil(timescale);
        let end_ms = blue_start * 1000 / timescale;
        eprintln!("WINDOWS_TRIM_SOURCE_PRESENTATION green_ticks={green_start} blue_ticks={blue_start} scale={timescale} selected_ms={start_ms}..{end_ms}");
        let original = std::fs::read(&source).unwrap();
        if let Some(destination) = std::env::var_os("HAPPIER_WINDOWS_SOURCE_FIXTURE") {
            std::fs::copy(&source, destination).unwrap();
        }
        trim(&source, &output, start_ms, end_ms, &crate::capture::CancelSignal::default()).unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), original);
        let file = std::fs::File::open(&output).unwrap();
        let movie = mp4::Mp4Reader::read_header(&file, file.metadata().unwrap().len()).unwrap();
        assert_eq!(movie.tracks().len(), 1);
        assert_eq!(movie.tracks().values().next().unwrap().media_type().unwrap(), mp4::MediaType::H264);
        assert!(movie.duration().abs_diff(std::time::Duration::from_millis(end_ms - start_ms)) < std::time::Duration::from_millis(17));
        if let Some(destination) = std::env::var_os("HAPPIER_WINDOWS_TRIM_FIXTURE") {
            std::fs::copy(&output, destination).unwrap();
        }
        // Native first-frame decode catches preroll; WinRT's late tiny-frame
        // thumbnails fail even on valid output. The retained exact bytes are
        // checked across ALL frames with FFmpeg (including ignore_editlist),
        // and the same output's near-end PNG is read through WebView2.
        for time_ms in [0, 250] { native_proof::assert_pixel(&output, time_ms, 0, 0, [0, 255, 0]); }
        let cancel = crate::capture::CancelSignal::default(); cancel.cancel();
        let cancelled = root.path().join("cancelled.mp4");
        assert_eq!(trim(&source, &cancelled, 0, 1000, &cancel), Err(CaptureError::Cancelled));
        assert!(!cancelled.exists());
        // A real FileCreate notification cancels after the decoder/output are
        // acquired, without a timer or a mock of internal trim orchestration.
        use notify::Watcher;
        let active = crate::capture::CancelSignal::default();
        let stopping = active.clone();
        let active_output = root.path().join("active-cancelled.mp4");
        let mut watcher = notify::recommended_watcher(move |event: Result<notify::Event, notify::Error>| {
            if let Ok(event) = event {
                if event.kind.is_create() && event.paths.iter().any(|path| path.file_name() == Some(std::ffi::OsStr::new("active-cancelled.mp4"))) {
                    stopping.cancel();
                }
            }
        }).unwrap();
        watcher.watch(root.path(), notify::RecursiveMode::NonRecursive).unwrap();
        assert_eq!(trim(&source, &active_output, 0, 2000, &active), Err(CaptureError::Cancelled));
        assert_eq!(std::fs::read(&source).unwrap(), original);
        assert!(!active_output.exists(), "native work joins before removing the cancelled partial");
        println!("WINDOWS_ACTIVE_TRIM_CANCEL_PASS source_unchanged=true output_removed=true");
    }
}
