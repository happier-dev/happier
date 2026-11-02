//! Finite physical video preparation; the capture library owns source and output paths.
use crate::capture::{CancelSignal, CaptureError};
use std::path::Path;

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
pub fn trim(_source: &Path, _output: &Path, _start_ms: u64, _end_ms: u64,
    _cancel: &CancelSignal) -> Result<(), CaptureError> {
    Err(CaptureError::UnsupportedPlatform)
}

#[cfg(target_os = "windows")]
pub fn trim(source: &Path, output: &Path, start_ms: u64, end_ms: u64,
    cancel: &CancelSignal) -> Result<(), CaptureError> {
    super::windows::trim(source, output, start_ms, end_ms, cancel)
}

#[cfg(target_os = "linux")]
pub fn trim(source: &Path, output: &Path, start_ms: u64, end_ms: u64,
    cancel: &CancelSignal) -> Result<(), CaptureError> {
    super::linux::trim(source, output, start_ms, end_ms, cancel)
}

#[cfg(target_os = "macos")]
pub fn trim(source: &Path, output: &Path, start_ms: u64, end_ms: u64,
    cancel: &CancelSignal) -> Result<(), CaptureError> {
    macos::trim(source, output, start_ms, end_ms, cancel)
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use crate::capture::recording::macos::Time;
    use block2::RcBlock;
    use objc2::{class, msg_send, rc::Retained, runtime::AnyObject, Encode, Encoding};
    use objc2_foundation::{NSString, NSURL};
    use std::sync::{Arc, mpsc};

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct TimeRange { start: Time, duration: Time }
    unsafe impl Encode for TimeRange {
        const ENCODING: Encoding = Encoding::Struct("?", &[Time::ENCODING, Time::ENCODING]);
    }
    #[link(name = "AVFoundation", kind = "framework")]
    extern "C" {
        static AVFileTypeMPEG4: &'static NSString;
        static AVAssetExportPresetHighestQuality: &'static NSString;
    }

    struct Export(Retained<AnyObject>);
    // AVAssetExportSession supports cancellation from another thread while exporting.
    // Configuration happens before the cancellation callback is published.
    unsafe impl Send for Export {}
    unsafe impl Sync for Export {}
    impl Export {
        fn cancel(&self) { unsafe { let _: () = msg_send![&*self.0, cancelExport]; } }
    }

    pub(super) fn trim(source: &Path, output: &Path, start_ms: u64, end_ms: u64,
        cancel: &CancelSignal) -> Result<(), CaptureError> {
        if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
        // AVFoundation requires an absent output. Refuse before export so failure
        // cleanup can never remove an existing source or another completed movie.
        if output.try_exists().map_err(|_| CaptureError::FileIo)? { return Err(CaptureError::FileIo); }
        objc2::rc::autoreleasepool(|_| unsafe {
            let url = NSURL::fileURLWithPath(&NSString::from_str(source.to_str().ok_or(CaptureError::FileIo)?));
            let asset: Retained<AnyObject> = msg_send![class!(AVURLAsset), URLAssetWithURL: &*url,
                options: std::ptr::null::<AnyObject>()];
            let duration: Time = msg_send![&*asset, duration];
            if duration.flags & 1 == 0 || duration.flags & (4 | 8 | 16) != 0 || duration.scale <= 0 || duration.value <= 0 {
                return Err(CaptureError::InvalidMedia);
            }
            if start_ms >= end_ms || end_ms as u128 * duration.scale as u128 > duration.value as u128 * 1000 {
                return Err(CaptureError::InvalidSelection);
            }
            let time = |ms| Time::milliseconds(ms).ok_or(CaptureError::InvalidSelection);
            let range = TimeRange { start: time(start_ms)?, duration: time(end_ms - start_ms)? };
            // HighestQuality re-encodes H.264 rather than retaining excluded GOPs
            // behind a playback edit list, and adds no local fps/bitrate/size policy.
            let session: Option<Retained<AnyObject>> = msg_send![class!(AVAssetExportSession),
                exportSessionWithAsset: &*asset, presetName: AVAssetExportPresetHighestQuality];
            let session = Arc::new(Export(session.ok_or(CaptureError::NativeFailure)?));
            let output_url = NSURL::fileURLWithPath(&NSString::from_str(output.to_str().ok_or(CaptureError::FileIo)?));
            let _: () = msg_send![&*session.0, setOutputURL: &*output_url];
            let _: () = msg_send![&*session.0, setOutputFileType: AVFileTypeMPEG4];
            let _: () = msg_send![&*session.0, setTimeRange: range];
            let (sender, receiver) = mpsc::channel();
            let completed = RcBlock::new(move || { let _ = sender.send(()); });
            let _: () = msg_send![&*session.0, exportAsynchronouslyWithCompletionHandler: &*completed];
            let cancelling = session.clone();
            cancel.on_cancel(move || cancelling.cancel());
            // AVFoundation's completion callback settles success, failure and cancel.
            // No worker, timer, polling loop or subordinate timeout survives it.
            let completion = receiver.recv();
            cancel.clear_wake();
            let status: isize = msg_send![&*session.0, status];
            let result = match (completion, status) {
                (Ok(()), 3) => Ok(()),
                (Ok(()), 5) => Err(CaptureError::Cancelled),
                _ => Err(CaptureError::NativeFailure),
            };
            if result.is_err() && output.try_exists().map_err(|_| CaptureError::FileIo)? {
                std::fs::remove_file(output).map_err(|_| CaptureError::FileIo)?;
            }
            result
        })
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;

    #[test]
    fn active_export_cancels_at_native_output_creation_and_releases_its_partial_movie() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.mp4");
        let output = root.path().join("trimmed.mp4");
        super::super::macos::tests::fixture_with_size(&source, crate::capture::PixelSize { width: 1920, height: 1080 });
        let original = std::fs::read(&source).unwrap();
        let cancel = CancelSignal::default();
        let worker_cancel = cancel.clone();
        let worker_source = source.clone();
        let worker_output = output.clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            sender.send(trim(&worker_source, &worker_output, 0, 2000, &worker_cancel)).unwrap();
        });
        // Observe the native writer's actual first effect, not a guessed delay.
        while !output.exists() {
            match receiver.try_recv() {
                Ok(result) => panic!("native export settled before output creation could be observed: {result:?}"),
                Err(std::sync::mpsc::TryRecvError::Empty) => std::thread::yield_now(),
                Err(error) => panic!("native export worker disconnected: {error}"),
            }
        }
        cancel.cancel();
        let completed = receiver.recv().unwrap();
        worker.join().unwrap();
        assert_eq!(completed, Err(CaptureError::Cancelled), "the native completion must confirm cancellation");
        assert!(!output.exists(), "failed preparation publishes no derivative movie");
        assert_eq!(std::fs::read(&source).unwrap(), original);
    }

    // Test-only decoder: actual outgoing pixels, never a product frame-export API.
    fn first_pixel(path: &Path) -> [u8; 4] {
        let (_, rgba) = super::super::macos::tests::decoded_frame(path);
        rgba[..4].try_into().unwrap()
    }

    #[test]
    fn exports_only_the_selected_interval_as_a_new_silent_h264_movie() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.mp4");
        let output = root.path().join("trimmed.mp4");
        super::super::macos::tests::fixture(&source);
        let original = std::fs::read(&source).unwrap();
        let red = first_pixel(&source);
        assert!(red[0] > red[1] && red[0] > red[2], "source begins with the excluded red frame");
        trim(&source, &output, 1000, 2000, &CancelSignal::default()).unwrap();
        assert_eq!(std::fs::read(&source).unwrap(), original, "source remains available for editing");
        let bytes = std::fs::metadata(&output).unwrap().len();
        let mut movie = mp4::Mp4Reader::read_header(std::io::BufReader::new(
            std::fs::File::open(&output).unwrap()), bytes).unwrap();
        assert_eq!(movie.tracks().len(), 1, "the derived movie remains silent");
        let video = movie.tracks().values().next().unwrap();
        assert_eq!(video.media_type().unwrap(), mp4::MediaType::H264);
        assert_eq!((video.width(), video.height()), (64, 48));
        assert_eq!(movie.duration().as_millis(), 1000, "physical duration excludes the first second");
        let id = video.track_id();
        assert!(!movie.read_sample(id, 1).unwrap().unwrap().bytes.is_empty());
        let green = first_pixel(&output);
        assert!(green[1] > green[0] && green[1] > green[2], "outgoing bytes start at the retained green frame");
        // A copied original with preview-only trim metadata fails duration above.
    }

    #[test]
    fn a_positive_subframe_export_never_changes_the_original_source() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.mp4");
        let output = root.path().join("subframe.mp4");
        super::super::macos::tests::fixture(&source);
        let original = std::fs::read(&source).unwrap();
        // One stored millisecond is below this fixture's encoded one-second frame.
        trim(&source, &output, 1999, 2000, &CancelSignal::default()).unwrap();
        let bytes = std::fs::metadata(&output).unwrap().len();
        let movie = mp4::Mp4Reader::read_header(std::io::BufReader::new(
            std::fs::File::open(&output).unwrap()), bytes).unwrap();
        let frames: u32 = movie.tracks().values().map(|track| track.sample_count()).sum();
        println!("positive_subframe_export duration_ms={} sample_count={frames}", movie.duration().as_millis());
        assert_eq!(std::fs::read(&source).unwrap(), original);
        assert!(movie.duration().as_millis() > 0);
    }

    #[test]
    fn refuses_out_of_asset_ranges_without_creating_output_and_cancel_is_settled() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.mp4");
        let output = root.path().join("trimmed.mp4");
        super::super::macos::tests::fixture(&source);
        for (start, end) in [(0, 2001), (1000, 1000), (2000, 1000)] {
            assert_eq!(trim(&source, &output, start, end, &CancelSignal::default()), Err(CaptureError::InvalidSelection));
            assert!(!output.exists());
        }
        let cancel = CancelSignal::default(); cancel.cancel();
        assert_eq!(trim(&source, &output, 0, 1000, &cancel), Err(CaptureError::Cancelled));
        assert!(!output.exists());
        assert_eq!(trim(&source, &source, 0, 1000, &CancelSignal::default()), Err(CaptureError::FileIo));
        assert!(source.is_file(), "a refused export never deletes the existing source");
    }
}
