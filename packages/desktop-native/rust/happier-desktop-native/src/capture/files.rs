//! Kept captures and their current prepared PNG. Dropping the owner deletes nothing.
use super::{CaptureDisclosure, CaptureError, CaptureResult, MediaKind, PixelSize, PreparedPng};
use std::{collections::HashMap, fs, io::{BufReader, Cursor, Write}, path::{Path, PathBuf}, sync::{Arc, Mutex}};

struct OwnedCapture {
    result: CaptureResult,
    prepared: Option<PathBuf>,
    disclosure: Option<CaptureDisclosure>,
    recording: Option<PreparedRecording>,
    derivatives: Vec<String>,
    window_text: Arc<Mutex<super::window_text::WindowText>>,
}
enum CaptureFile { PendingVideo(PathBuf), Ready(OwnedCapture) }

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingFrameInput { pub time_ms: u64, pub bytes: Vec<u8>, pub note: Option<String> }

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoTiming { pub duration_ms: u64, pub frame_duration_ms: f64 }

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedRecordingFrame {
    pub frame_ref: String, pub time_ms: u64, pub note: Option<String>,
    pub byte_size: u64, pub pixel_size: PixelSize,
}

#[derive(Debug, Clone, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreparedRecording {
    pub capture_ref: String, pub frames: Vec<PreparedRecordingFrame>, pub video_ref: Option<String>,
    pub include_video: bool, pub byte_size: u64,
}

#[derive(Default)]
pub struct CaptureFiles { files: HashMap<String, CaptureFile> }

pub fn png_size(bytes: &[u8]) -> Result<PixelSize, CaptureError> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    // PNG's dimensions and the allocator are the boundaries; no capture-size cap.
    decoder.set_limits(png::Limits { bytes: usize::MAX });
    let mut reader = decoder.read_info().map_err(|_| CaptureError::InvalidPng)?;
    let mut pixels = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut pixels).map_err(|_| CaptureError::InvalidPng)?;
    Ok(PixelSize { width: info.width, height: info.height })
}

fn complete_write(directory: &Path, path: &Path, bytes: &[u8]) -> Result<(), CaptureError> {
    let mut temp = tempfile::Builder::new().prefix(".capture-").suffix(".tmp")
        .tempfile_in(directory).map_err(|_| CaptureError::FileIo)?;
    temp.write_all(bytes).and_then(|_| temp.flush()).map_err(|_| CaptureError::FileIo)?;
    temp.persist(path).map_err(|_| CaptureError::FileIo)?;
    Ok(())
}

fn prepared_path(source: &Path) -> PathBuf {
    source.with_file_name(format!("{}-prepared.png", source.file_stem().unwrap().to_string_lossy()))
}

fn disclosure_path(source: &Path) -> PathBuf {
    source.with_file_name(format!("{}-disclosure.json", source.file_stem().unwrap().to_string_lossy()))
}

fn remove_if_present(path: &Path) -> Result<(), CaptureError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(CaptureError::FileIo),
    }
}

fn library_capture_ref(root: &Path, path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    (path.parent() == Some(root) && stem.starts_with("capture-") && !stem.ends_with("-prepared")).then(|| stem.to_owned())
}

fn is_png_path(path: &Path) -> bool {
    path.extension().and_then(|extension| extension.to_str()).is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
}

fn write_png_file(root: &Path, bytes: &[u8], pixel_size: PixelSize, prepared: bool) -> Result<CaptureResult, CaptureError> {
    let mut temp = tempfile::Builder::new().prefix(".capture-").suffix(".tmp")
        .tempfile_in(root).map_err(|_| CaptureError::FileIo)?;
    let stem = temp.path().file_stem().unwrap().to_string_lossy().trim_start_matches('.').to_owned();
    let path = root.join(format!("{stem}.png"));
    let path = if prepared { prepared_path(&path) } else { path };
    let capture_ref = path.file_stem().unwrap().to_string_lossy().into_owned();
    temp.write_all(bytes).and_then(|_| temp.flush()).map_err(|_| CaptureError::FileIo)?;
    temp.persist_noclobber(&path).map_err(|_| CaptureError::FileIo)?;
    Ok(CaptureResult { capture_ref, path, kind: MediaKind::Still, mime_type: "image/png".into(),
        pixel_size, byte_size: bytes.len() as u64, scale: None, origin: None, source: None, window_text_ref: None })
}

impl CaptureFiles {
    pub fn prepare_recording(&mut self, capture_ref: &str, frames: Vec<RecordingFrameInput>,
        video_ref: Option<&str>, include_video: bool, disclosure: CaptureDisclosure,
        cancel: &super::CancelSignal) -> Result<PreparedRecording, CaptureError> {
        self.invalidate_recording(capture_ref)?;
        let parent = self.ready_mut(capture_ref)?;
        let root = parent.result.path.parent().ok_or(CaptureError::FileIo)?.to_owned();
        let video_ref = if include_video {
            let video_ref = video_ref.unwrap_or(capture_ref);
            if video_ref != capture_ref && !parent.derivatives.iter().any(|child| child == video_ref) {
                return Err(CaptureError::UnknownCapture);
            }
            Some(video_ref.to_owned())
        } else { None };
        let video_bytes = match &video_ref {
            Some(video_ref) => {
                let video = self.ready(video_ref)?;
                if video.result.kind != MediaKind::Video { return Err(CaptureError::InvalidMedia); }
                video.result.byte_size
            },
            None => 0,
        };
        let mut outputs = Vec::new();
        let mut prepared_frames = Vec::new();
        let written = (|| {
            for frame in frames {
                if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
                let size = png_size(&frame.bytes)?;
                let output = write_png_file(&root, &frame.bytes, size, true)?;
                prepared_frames.push(PreparedRecordingFrame { frame_ref: output.capture_ref.clone(),
                    time_ms: frame.time_ms, note: frame.note, byte_size: output.byte_size, pixel_size: size });
                outputs.push(output);
            }
            if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
            Ok(())
        })();
        if let Err(error) = written {
            for output in outputs { remove_if_present(&output.path)?; }
            return Err(error);
        }
        let prepared = PreparedRecording { capture_ref: capture_ref.to_owned(), video_ref, include_video,
            byte_size: video_bytes + prepared_frames.iter().map(|frame| frame.byte_size).sum::<u64>(), frames: prepared_frames };
        let children = outputs.iter().map(|output| output.capture_ref.clone()).collect::<Vec<_>>();
        for output in outputs {
            // These bytes were flattened by P2 already. The existing prepared reader
            // points to the one complete PNG; it does not write a duplicate source.
            let path = output.path.clone();
            self.adopt_result(output, Some(path));
        }
        let parent = self.ready_mut(capture_ref)?;
        parent.derivatives.extend(children);
        parent.disclosure = Some(disclosure);
        parent.recording = Some(prepared.clone());
        Ok(prepared)
    }
    pub fn prepared_recording(&self, capture_ref: &str) -> Result<Option<PreparedRecording>, CaptureError> {
        Ok(self.ready(capture_ref)?.recording.clone())
    }
    pub fn invalidate_recording(&mut self, capture_ref: &str) -> Result<(), CaptureError> {
        let owned = self.ready_mut(capture_ref)?;
        if owned.result.kind != MediaKind::Video { return Err(CaptureError::InvalidMedia); }
        // As with prepared stills, editing or failed replacement cannot authorize older output.
        owned.recording = None;
        owned.disclosure = None;
        Ok(())
    }
    pub fn video_timing(&self, capture_ref: &str) -> Result<VideoTiming, CaptureError> {
        let source = self.ready(capture_ref)?;
        if source.result.kind != MediaKind::Video { return Err(CaptureError::InvalidMedia); }
        video_metadata(&source.result.path)?.4.ok_or(CaptureError::OperationUnavailable)
    }
    /// Associate trim output at allocation, including a native export that later fails.
    pub fn allocate_video_derivative(&mut self, parent_ref: &str) -> Result<(String, PathBuf), CaptureError> {
        let source = self.ready(parent_ref)?;
        let root = source.result.path.parent().ok_or(CaptureError::FileIo)?.to_owned();
        let format = super::recording::Format::from_mime_type(&source.result.mime_type)?;
        let allocation = self.allocate_video_file(&root, true, format)?;
        self.ready_mut(parent_ref)?.derivatives.push(allocation.0.clone());
        Ok(allocation)
    }
    /// Allocate through the same kept library owner; AVAssetWriter creates the movie itself.
    pub fn allocate_video(&mut self, root: &Path, format: super::recording::Format) -> Result<(String, PathBuf), CaptureError> {
        self.allocate_video_file(root, false, format)
    }
    fn allocate_video_file(&mut self, root: &Path, prepared: bool, format: super::recording::Format) -> Result<(String, PathBuf), CaptureError> {
        fs::create_dir_all(root).map_err(|_| CaptureError::FileIo)?;
        let root = root.canonicalize().map_err(|_| CaptureError::FileIo)?;
        let suffix = format!("{}.{}", if prepared { "-prepared" } else { "" }, format.extension());
        let reservation = tempfile::Builder::new().prefix("capture-").suffix(&suffix)
            .tempfile_in(root).map_err(|_| CaptureError::FileIo)?;
        let path = reservation.path().to_owned();
        let capture_ref = path.file_stem().unwrap().to_string_lossy().into_owned();
        reservation.close().map_err(|_| CaptureError::FileIo)?;
        self.files.insert(capture_ref.clone(), CaptureFile::PendingVideo(path.clone()));
        Ok((capture_ref, path))
    }
    /// Called only after the native writer's completion, before ready is published.
    pub fn complete_video(&mut self, mut result: CaptureResult) -> Result<CaptureResult, CaptureError> {
        result.byte_size = fs::metadata(&result.path).map_err(|_| CaptureError::FileIo)?.len();
        if result.byte_size == 0 { return Err(CaptureError::NativeFailure); }
        Ok(self.adopt_result(result, None))
    }
    /// The picker and finalized P4 video use the same kept-file owner. Only a
    /// selected external file is copied; completed library files reopen in place.
    pub fn open_media(&mut self, root: &Path, path: &Path) -> Result<CaptureResult, CaptureError> {
        let path = path.canonicalize().map_err(|_| CaptureError::FileIo)?;
        let owned_ref = root.canonicalize().ok().and_then(|root| library_capture_ref(&root, &path));
        if let Some(capture_ref) = &owned_ref {
            if self.files.contains_key(capture_ref) { return self.describe(capture_ref); }
        }
        match super::recents::media_kind(&path) {
            Some(MediaKind::Still) if is_png_path(&path) => {
                if let Some(capture_ref) = owned_ref { self.read_kept_png(capture_ref, path) } else { self.import_png(root, &path) }
            },
            Some(MediaKind::Still) => {
                let mut reader = image::ImageReader::open(&path).map_err(|_| CaptureError::FileIo)?
                    .with_guessed_format().map_err(|_| CaptureError::InvalidMedia)?;
                reader.no_limits();
                let image = reader.decode().map_err(|_| CaptureError::InvalidMedia)?;
                let pixel_size = PixelSize { width: image.width(), height: image.height() };
                let mut bytes = Cursor::new(Vec::new());
                image.write_to(&mut bytes, image::ImageFormat::Png).map_err(|_| CaptureError::InvalidMedia)?;
                self.write_checked_png(root, bytes.get_ref(), pixel_size)
            },
            Some(MediaKind::Video) => {
                let (pixel_size, mime_type, suffix, original_size, _) = video_metadata(&path)?;
                let (capture_ref, kept, byte_size) = if let Some(capture_ref) = owned_ref { (capture_ref, path, original_size) } else {
                    fs::create_dir_all(root).map_err(|_| CaptureError::FileIo)?;
                    let root = root.canonicalize().map_err(|_| CaptureError::FileIo)?;
                    let mut temp = tempfile::Builder::new().prefix(".capture-").suffix(".tmp").tempfile_in(&root).map_err(|_| CaptureError::FileIo)?;
                    let stem = temp.path().file_stem().unwrap().to_string_lossy().trim_start_matches('.').to_owned();
                    let kept = root.join(format!("{stem}.{suffix}"));
                    let byte_size = std::io::copy(&mut fs::File::open(&path).map_err(|_| CaptureError::FileIo)?, &mut temp).map_err(|_| CaptureError::FileIo)?;
                    temp.flush().map_err(|_| CaptureError::FileIo)?;
                    temp.persist_noclobber(&kept).map_err(|_| CaptureError::FileIo)?;
                    (stem, kept, byte_size)
                };
                let result = CaptureResult { capture_ref, kind: MediaKind::Video, byte_size, path: kept,
                    mime_type: mime_type.into(), pixel_size, scale: None, origin: None, source: None, window_text_ref: None };
                Ok(self.adopt_result(result, None))
            },
            None => Err(CaptureError::InvalidMedia),
        }
    }
    pub fn write_png(&mut self, root: &Path, bytes: &[u8]) -> Result<CaptureResult, CaptureError> {
        let size = png_size(bytes)?;
        self.write_checked_png(root, bytes, size)
    }

    fn write_checked_png(&mut self, root: &Path, bytes: &[u8], size: PixelSize) -> Result<CaptureResult, CaptureError> {
        fs::create_dir_all(root).map_err(|_| CaptureError::FileIo)?;
        let root = root.canonicalize().map_err(|_| CaptureError::FileIo)?;
        Ok(self.adopt_result(write_png_file(&root, bytes, size, false)?, None))
    }

    fn adopt(&mut self, capture_ref: String, path: PathBuf, pixel_size: PixelSize, byte_size: u64,
        prepared: Option<PathBuf>) -> CaptureResult {
        let result = CaptureResult { capture_ref: capture_ref.clone(), kind: MediaKind::Still, path,
            mime_type: "image/png".into(), byte_size, pixel_size, scale: None, origin: None,
            source: None, window_text_ref: None };
        self.adopt_result(result, prepared)
    }

    fn adopt_result(&mut self, result: CaptureResult, prepared: Option<PathBuf>) -> CaptureResult {
        let window_text = Arc::new(Mutex::new(super::window_text::WindowText::new(None, result.source.clone(), super::CancelSignal::default())));
        self.files.insert(result.capture_ref.clone(), CaptureFile::Ready(OwnedCapture {
            result: result.clone(), prepared, disclosure: None, window_text, recording: None, derivatives: Vec::new(),
        }));
        result
    }

    pub fn import_png(&mut self, root: &Path, original: &Path) -> Result<CaptureResult, CaptureError> {
        self.write_png(root, &fs::read(original).map_err(|_| CaptureError::FileIo)?)
    }

    pub fn open_library_png(&mut self, root: &Path, path: &Path) -> Result<CaptureResult, CaptureError> {
        let root = root.canonicalize().map_err(|_| CaptureError::FileIo)?;
        let path = path.canonicalize().map_err(|_| CaptureError::FileIo)?;
        if !is_png_path(&path) { return Err(CaptureError::UnknownCapture); }
        let capture_ref = library_capture_ref(&root, &path).ok_or(CaptureError::UnknownCapture)?;
        self.read_kept_png(capture_ref, path)
    }

    fn read_kept_png(&mut self, capture_ref: String, path: PathBuf) -> Result<CaptureResult, CaptureError> {
        // Reopen the existing owner, including sanitized text and disclosure,
        // rather than reconstructing this capture from its own file output.
        if self.files.contains_key(&capture_ref) { return self.describe(&capture_ref); }
        let bytes = fs::read(&path).map_err(|_| CaptureError::FileIo)?;
        let size = png_size(&bytes)?;
        let disclosure = match fs::read(disclosure_path(&path)) {
            Ok(bytes) => Some(serde_json::from_slice(&bytes).map_err(|_| CaptureError::FileIo)?),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(_) => return Err(CaptureError::FileIo),
        };
        let prepared = prepared_path(&path);
        let prepared = (disclosure.is_some() && prepared.is_file()).then_some(prepared);
        let result = self.adopt(capture_ref, path, size, bytes.len() as u64, prepared);
        self.ready_mut(&result.capture_ref)?.disclosure = disclosure;
        Ok(result)
    }

    pub fn describe(&self, capture_ref: &str) -> Result<CaptureResult, CaptureError> {
        Ok(self.ready(capture_ref)?.result.clone())
    }
    fn ready(&self, capture_ref: &str) -> Result<&OwnedCapture, CaptureError> {
        match self.files.get(capture_ref).ok_or(CaptureError::UnknownCapture)? {
            CaptureFile::Ready(owned) => Ok(owned),
            CaptureFile::PendingVideo(_) => Err(CaptureError::OperationUnavailable),
        }
    }
    fn ready_mut(&mut self, capture_ref: &str) -> Result<&mut OwnedCapture, CaptureError> {
        match self.files.get_mut(capture_ref).ok_or(CaptureError::UnknownCapture)? {
            CaptureFile::Ready(owned) => Ok(owned),
            CaptureFile::PendingVideo(_) => Err(CaptureError::OperationUnavailable),
        }
    }

    pub fn set_context(&mut self, result: CaptureResult) -> Result<(), CaptureError> {
        let owned = self.ready_mut(&result.capture_ref)?;
        owned.result = result;
        Ok(())
    }

    pub fn bind_window_text(&mut self, capture_ref: &str, target: Option<super::WindowDescriptor>,
        cancel: super::CancelSignal) -> Result<CaptureResult, CaptureError> {
        let owned = self.ready_mut(capture_ref)?;
        owned.result.window_text_ref = target.as_ref().map(|_| capture_ref.to_owned());
        owned.window_text = Arc::new(Mutex::new(super::window_text::WindowText::new(target, owned.result.source.clone(), cancel)));
        Ok(owned.result.clone())
    }

    pub fn bind_frontmost_window_text(&mut self, capture_ref: &str,
        context: Option<super::window_text::FrontmostWindowContext>, cancel: super::CancelSignal) -> Result<CaptureResult, CaptureError> {
        let owned = self.ready_mut(capture_ref)?;
        owned.result.window_text_ref = context.as_ref().map(|_| capture_ref.to_owned());
        // This is text provenance only. Portal pixels never acquire an invented
        // window identity or origin from the pre-consent frontmost reference.
        owned.window_text = Arc::new(Mutex::new(super::window_text::WindowText::from_frontmost(context, cancel)));
        Ok(owned.result.clone())
    }

    /// Release the files lock before awaiting or traversing native accessibility.
    pub fn window_text(&self, capture_ref: &str) -> Result<Arc<Mutex<super::window_text::WindowText>>, CaptureError> {
        Ok(self.ready(capture_ref)?.window_text.clone())
    }

    pub fn read_source_png(&self, capture_ref: &str) -> Result<Vec<u8>, CaptureError> {
        fs::read(&self.ready(capture_ref)?.result.path)
            .map_err(|_| CaptureError::FileIo)
    }

    pub fn disclosure(&self, capture_ref: &str) -> Result<Option<CaptureDisclosure>, CaptureError> {
        Ok(self.ready(capture_ref)?.disclosure)
    }

    pub fn write_prepared_png(&mut self, capture_ref: &str, bytes: &[u8], disclosure: CaptureDisclosure) -> Result<PreparedPng, CaptureError> {
        let owned = self.ready_mut(capture_ref)?;
        owned.prepared = None;
        owned.disclosure = None;
        // Invalidate the previous decision before attempting another export. A
        // failed write cannot authorize old prepared pixels after library reopen.
        let record_path = disclosure_path(&owned.result.path);
        remove_if_present(&record_path)?;
        let pixel_size = png_size(bytes)?;
        let path = prepared_path(&owned.result.path);
        complete_write(path.parent().unwrap(), &path, bytes)?;
        let record = serde_json::to_vec(&disclosure).map_err(|_| CaptureError::FileIo)?;
        complete_write(record_path.parent().unwrap(), &record_path, &record)?;
        owned.prepared = Some(path.clone());
        owned.disclosure = Some(disclosure);
        Ok(PreparedPng { capture_ref: capture_ref.into(), path, pixel_size, byte_size: bytes.len() as u64,
            mime_type: "image/png".into() })
    }

    pub fn read_prepared_png(&self, capture_ref: &str) -> Result<Vec<u8>, CaptureError> {
        let owned = self.ready(capture_ref)?;
        let path = owned.prepared.as_ref().ok_or(CaptureError::PreparedMissing)?;
        fs::read(path).map_err(|_| CaptureError::FileIo)
    }

    /// A delivered draft owns its flattened pixels independently of the editor.
    pub fn retain_prepared_png(&mut self, capture_ref: &str) -> Result<CaptureResult, CaptureError> {
        let bytes = self.read_prepared_png(capture_ref)?;
        let size = png_size(&bytes)?;
        let root = self.ready(capture_ref)?.result.path.parent().ok_or(CaptureError::FileIo)?;
        let result = write_png_file(root, &bytes, size, true)?;
        let path = result.path.clone();
        // Unlike recording working files, this output belongs to the draft and
        // must survive discard of the capture that produced it.
        Ok(self.adopt_result(result, Some(path)))
    }

    pub fn discard(&mut self, capture_ref: &str) -> Result<(), CaptureError> {
        let children = match self.files.get(capture_ref).ok_or(CaptureError::UnknownCapture)? {
            CaptureFile::Ready(owned) => owned.derivatives.clone(),
            CaptureFile::PendingVideo(_) => Vec::new(),
        };
        for child in children {
            if self.files.contains_key(&child) { self.discard(&child)?; }
        }
        let source = match self.files.get(capture_ref).ok_or(CaptureError::UnknownCapture)? {
            CaptureFile::PendingVideo(path) => path,
            CaptureFile::Ready(owned) => &owned.result.path,
        };
        // Also remove an older completed prepared output after a failed newer write.
        for path in [prepared_path(source), disclosure_path(source), source.clone()] {
            remove_if_present(&path)?;
        }
        self.files.remove(capture_ref);
        Ok(())
    }
}

fn video_metadata(path: &Path) -> Result<(PixelSize, &'static str, &'static str, u64, Option<VideoTiming>), CaptureError> {
    let file = fs::File::open(path).map_err(|_| CaptureError::FileIo)?;
    let size = file.metadata().map_err(|_| CaptureError::FileIo)?.len();
    let extension = path.extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase();
    if extension == "webm" {
        let mut media = matroska_demuxer::MatroskaFile::open(BufReader::new(file)).map_err(|_| CaptureError::InvalidMedia)?;
        // matroska-demuxer 0.8.1 preserves the encoded Duration value (ticks);
        // TimestampScale converts those ticks to nanoseconds.
        let duration_ms = media.info().duration().and_then(|ticks| std::time::Duration::try_from_secs_f64(
            ticks * media.info().timestamp_scale().get() as f64 / 1_000_000_000.).ok())
            .and_then(|duration| duration.as_millis().try_into().ok());
        let (track, width, height, default_duration_ns) = media.tracks().iter().find_map(|track| {
            track.video().map(|video| (track.track_number().get(), video.pixel_width().get(), video.pixel_height().get(),
                track.default_duration().map(|duration| duration.get())))
        }).ok_or(CaptureError::InvalidMedia)?;
        let pixel_size = PixelSize { width: width.try_into().map_err(|_| CaptureError::InvalidMedia)?, height: height.try_into().map_err(|_| CaptureError::InvalidMedia)? };
        let mut frame = matroska_demuxer::Frame::default();
        loop {
            if !media.next_frame(&mut frame).map_err(|_| CaptureError::InvalidMedia)? { return Err(CaptureError::InvalidMedia); }
            if frame.track == track && !frame.data.is_empty() { break; }
        }
        let tick_ns = media.info().timestamp_scale().get() as f64;
        let mut frame_duration_ms = default_duration_ns.map(|ns| ns as f64 / 1_000_000.)
            .or_else(|| frame.duration.filter(|ticks| *ticks > 0).map(|ticks| ticks as f64 * tick_ns / 1_000_000.));
        if frame_duration_ms.is_none() {
            let first_time = frame.timestamp;
            while media.next_frame(&mut frame).map_err(|_| CaptureError::InvalidMedia)? {
                if frame.track == track && !frame.data.is_empty() && frame.timestamp > first_time {
                    frame_duration_ms = Some((frame.timestamp - first_time) as f64 * tick_ns / 1_000_000.);
                    break;
                }
            }
        }
        let timing = duration_ms.zip(frame_duration_ms.or_else(|| duration_ms.map(|ms| ms as f64)))
            .map(|(duration_ms, frame_duration_ms)| VideoTiming { duration_ms, frame_duration_ms });
        Ok((pixel_size, "video/webm", "webm", size, timing))
    } else {
        let mut media = mp4::Mp4Reader::read_header(BufReader::new(file), size).map_err(|_| CaptureError::InvalidMedia)?;
        let (id, pixel_size, frame_duration_ms) = media.tracks().values().find(|track| matches!(track.track_type(), Ok(mp4::TrackType::Video)))
            .map(|track| (track.track_id(), PixelSize { width: track.width().into(), height: track.height().into() },
                track.trak.mdia.minf.stbl.stts.entries.iter().filter(|entry| entry.sample_count > 0 && entry.sample_delta > 0)
                    .map(|entry| entry.sample_delta).min().map(|delta| f64::from(delta) * 1000. / f64::from(track.timescale()))))
            .ok_or(CaptureError::InvalidMedia)?;
        if pixel_size.width == 0 || pixel_size.height == 0 || media.read_sample(id, 1).map_err(|_| CaptureError::InvalidMedia)?.is_none() {
            return Err(CaptureError::InvalidMedia);
        }
        let timing = media.duration().as_millis().try_into().ok().zip(frame_duration_ms)
            .map(|(duration_ms, frame_duration_ms)| VideoTiming { duration_ms, frame_duration_ms });
        if extension == "mov" { Ok((pixel_size, "video/quicktime", "mov", size, timing)) }
        else { Ok((pixel_size, "video/mp4", "mp4", size, timing)) }
    }
}
