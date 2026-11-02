//! ScreenCaptureKit sample stream and AVFoundation movie writer.
use super::{Backend, PreparedBackend, Timeline};
use super::pixels::{even_interval, window_pixel_size};
use crate::{capture::{CaptureError, CaptureOrigin, CaptureSource, CaptureTarget, Inventory, PixelSize, clamp_local_rect}, geometry::Rect};
use block2::RcBlock;
use objc2::{class, msg_send, rc::Retained, runtime::{AnyObject, Bool}, Encode, Encoding, RefEncode};
use objc2_foundation::{NSString, NSURL};
use screencapturekit::{prelude::*, cm::{CMSampleBufferSCExt, SCFrameStatus}};
use std::{ffi::c_void, path::Path, sync::{Arc, Mutex, mpsc}};

#[repr(C)]
#[derive(Clone, Copy, Default)]
pub(super) struct Time { pub(super) value: i64, pub(super) scale: i32, pub(super) flags: u32, pub(super) epoch: i64 }
// Core Media's CMTime is the same C structure in Objective-C method encodings.
unsafe impl Encode for Time {
    const ENCODING: Encoding = Encoding::Struct("?", &[i64::ENCODING, i32::ENCODING, u32::ENCODING, i64::ENCODING]);
}
impl Time {
    pub(super) fn milliseconds(ms: u64) -> Option<Self> {
        Some(Self { value: ms.try_into().ok()?, scale: 1000, flags: 1, epoch: 0 })
    }
    fn ns(ns: u64) -> Self { Self { value: ns as i64, scale: 1_000_000_000, flags: 1, epoch: 0 } }
    fn nanoseconds(self) -> Option<u64> {
        if self.flags & 1 == 0 || self.scale <= 0 || self.value < 0 { return None; }
        Some((self.value as u128 * 1_000_000_000 / self.scale as u128) as u64)
    }
}
#[repr(C)]
#[derive(Clone, Copy, Default)]
struct SampleTiming { duration: Time, presentation: Time, decode: Time }

// Preserve Core Media's opaque-pointer encoding for objc2's checked message send.
#[repr(C)]
struct SampleBuffer { _opaque: [u8; 0] }
unsafe impl RefEncode for SampleBuffer {
    const ENCODING_REF: Encoding = Encoding::Pointer(&Encoding::Struct("opaqueCMSampleBuffer", &[]));
}

#[link(name = "AVFoundation", kind = "framework")]
extern "C" {
    static AVFileTypeMPEG4: &'static NSString;
    static AVMediaTypeVideo: &'static NSString;
    static AVVideoCodecKey: &'static NSString;
    static AVVideoCodecTypeH264: &'static NSString;
    static AVVideoWidthKey: &'static NSString;
    static AVVideoHeightKey: &'static NSString;
    static AVVideoCompressionPropertiesKey: &'static NSString;
    static AVVideoAllowFrameReorderingKey: &'static NSString;
    static AVVideoColorPropertiesKey: &'static NSString;
    static AVVideoColorPrimariesKey: &'static NSString;
    static AVVideoColorPrimaries_ITU_R_709_2: &'static NSString;
    static AVVideoTransferFunctionKey: &'static NSString;
    static AVVideoTransferFunction_IEC_sRGB: &'static NSString;
    static AVVideoYCbCrMatrixKey: &'static NSString;
    static AVVideoYCbCrMatrix_ITU_R_709_2: &'static NSString;
}
#[link(name = "CoreMedia", kind = "framework")]
extern "C" {
    fn CMSampleBufferGetSampleTimingInfo(sample: *mut c_void, index: isize, timing: *mut SampleTiming) -> i32;
    fn CMSampleBufferCreateCopyWithNewTiming(allocator: *const c_void, sample: *mut c_void,
        count: isize, timing: *const SampleTiming, output: *mut *mut c_void) -> i32;
}
#[link(name = "CoreFoundation", kind = "framework")]
extern "C" { fn CFRelease(value: *const c_void); fn CFRetain(value: *const c_void) -> *const c_void; }

struct PendingFrame { sample: *mut c_void, timestamp_ns: u64 }
impl Drop for PendingFrame { fn drop(&mut self) { unsafe { CFRelease(self.sample); } } }
struct Writer { writer: Retained<AnyObject>, input: Retained<AnyObject>, started: bool, pending: Option<PendingFrame> }
// The AVFoundation handles are accessed serially beneath the one writer mutex.
unsafe impl Send for Writer {}
impl Writer {
    fn new(path: &Path, size: PixelSize) -> Result<Self, CaptureError> {
        objc2::rc::autoreleasepool(|_| unsafe {
            let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str().ok_or(CaptureError::FileIo)?));
            let mut error: *mut AnyObject = std::ptr::null_mut();
            let writer: Option<Retained<AnyObject>> = msg_send![class!(AVAssetWriter),
                assetWriterWithURL: &*url, fileType: AVFileTypeMPEG4, error: &mut error];
            let writer = writer.ok_or(CaptureError::FileIo)?;
            let settings: Retained<AnyObject> = msg_send![class!(NSMutableDictionary), new];
            let width: Retained<AnyObject> = msg_send![class!(NSNumber), numberWithUnsignedInt: size.width];
            let height: Retained<AnyObject> = msg_send![class!(NSNumber), numberWithUnsignedInt: size.height];
            let _: () = msg_send![&*settings, setObject: AVVideoCodecTypeH264, forKey: AVVideoCodecKey];
            let _: () = msg_send![&*settings, setObject: &*width, forKey: AVVideoWidthKey];
            let _: () = msg_send![&*settings, setObject: &*height, forKey: AVVideoHeightKey];
            // Reordered H.264 output can discard a held final input duration.
            // Keep decode/display order aligned so sparse SCK samples reach Stop.
            let compression: Retained<AnyObject> = msg_send![class!(NSMutableDictionary), new];
            let no_reordering: Retained<AnyObject> = msg_send![class!(NSNumber), numberWithBool: Bool::NO];
            let _: () = msg_send![&*compression, setObject: &*no_reordering, forKey: AVVideoAllowFrameReorderingKey];
            let _: () = msg_send![&*settings, setObject: &*compression, forKey: AVVideoCompressionPropertiesKey];
            // Match the stream's sRGB pixels explicitly. Untagged H.264 lets players
            // choose different transfer functions and matrices for the same keyframe.
            let color: Retained<AnyObject> = msg_send![class!(NSMutableDictionary), new];
            let _: () = msg_send![&*color, setObject: AVVideoColorPrimaries_ITU_R_709_2, forKey: AVVideoColorPrimariesKey];
            let _: () = msg_send![&*color, setObject: AVVideoTransferFunction_IEC_sRGB, forKey: AVVideoTransferFunctionKey];
            let _: () = msg_send![&*color, setObject: AVVideoYCbCrMatrix_ITU_R_709_2, forKey: AVVideoYCbCrMatrixKey];
            let _: () = msg_send![&*settings, setObject: &*color, forKey: AVVideoColorPropertiesKey];
            let input: Retained<AnyObject> = msg_send![class!(AVAssetWriterInput),
                assetWriterInputWithMediaType: AVMediaTypeVideo, outputSettings: &*settings];
            let _: () = msg_send![&*input, setExpectsMediaDataInRealTime: true];
            let supported: Bool = msg_send![&*writer, canAddInput: &*input];
            if !supported.as_bool() { return Err(CaptureError::NativeFailure); }
            let _: () = msg_send![&*writer, addInput: &*input];
            Ok(Self { writer, input, started: false, pending: None })
        })
    }
    fn append(&mut self, sample: *mut c_void, output_ns: u64) -> Result<(), CaptureError> {
        unsafe {
            if !self.started {
                let started: Bool = msg_send![&*self.writer, startWriting];
                if !started.as_bool() { return Err(CaptureError::FileIo); }
                let _: () = msg_send![&*self.writer, startSessionAtSourceTime: Time::ns(0)];
                self.started = true;
            }
            if let Some(previous) = &self.pending {
                // Readiness governs an append, not retention of the first frame.
                // SCK may become idle before startup backpressure clears; Stop
                // must still have that frame to append over the static interval.
                let ready: Bool = msg_send![&*self.input, isReadyForMoreMediaData];
                if !ready.as_bool() {
                    let status: isize = msg_send![&*self.writer, status];
                    return if status == 3 { Err(CaptureError::FileIo) } else { Ok(()) };
                }
                Self::append_timed(&self.input, previous, output_ns.saturating_sub(previous.timestamp_ns))?;
            }
            CFRetain(sample);
            self.pending = Some(PendingFrame { sample, timestamp_ns: output_ns });
            Ok(())
        }
    }
    fn append_timed(input: &AnyObject, frame: &PendingFrame, duration_ns: u64) -> Result<(), CaptureError> {
        unsafe {
            let mut timing = SampleTiming::default();
            if CMSampleBufferGetSampleTimingInfo(frame.sample, 0, &mut timing) != 0 { return Err(CaptureError::NativeFailure); }
            timing.presentation = Time::ns(frame.timestamp_ns);
            timing.duration = Time::ns(duration_ns);
            if timing.decode.flags & 1 != 0 { timing.decode = timing.presentation; }
            let mut copied = std::ptr::null_mut();
            if CMSampleBufferCreateCopyWithNewTiming(std::ptr::null(), frame.sample, 1, &timing, &mut copied) != 0 {
                return Err(CaptureError::NativeFailure);
            }
            let appended: Bool = msg_send![input, appendSampleBuffer: copied.cast::<SampleBuffer>()];
            CFRelease(copied);
            if !appended.as_bool() { return Err(CaptureError::FileIo); }
            Ok(())
        }
    }
    fn finish(&mut self, duration_ns: u64) -> Result<(), CaptureError> {
        if !self.started { self.cancel(); return Err(CaptureError::NativeFailure); }
        // endSession changes the container timeline, not the last video sample's
        // duration. Hold one source frame until its successor or Stop establishes
        // that duration, including static/hidden intervals with no complete frames.
        let pending = self.pending.take().ok_or(CaptureError::NativeFailure)?;
        {
            // Keep the real-time push path through Stop. Switching an already
            // back-pressured input to pull requests can strand its last sample.
            let ready = super::macos_readiness::Readiness::new(&self.input, &self.writer);
            ready.wait()?;
        }
        Self::append_timed(&self.input, &pending, duration_ns.saturating_sub(pending.timestamp_ns))?;
        let (tx, rx) = mpsc::channel();
        let complete = RcBlock::new(move || { let _ = tx.send(()); });
        unsafe {
            let _: () = msg_send![&*self.input, markAsFinished];
            let _: () = msg_send![&*self.writer, endSessionAtSourceTime: Time::ns(duration_ns)];
            let _: () = msg_send![&*self.writer, finishWritingWithCompletionHandler: &*complete];
        }
        rx.recv().map_err(|_| CaptureError::NativeFailure)?;
        let status: isize = unsafe { msg_send![&*self.writer, status] };
        if status == 2 { Ok(()) } else { Err(CaptureError::FileIo) }
    }
    fn cancel(&mut self) { self.pending.take(); unsafe { let _: () = msg_send![&*self.writer, cancelWriting]; } }
}

struct MacRecorder { stream: Option<SCStream>, writer: Arc<Mutex<Writer>> }
impl Backend for MacRecorder {
    fn start(&mut self) -> Result<(), CaptureError> {
        self.stream.as_mut().unwrap().start_capture().map_err(crate::capture::macos::native_error)
    }
    fn finish(&mut self, duration_ns: u64) -> Result<Option<CaptureError>, CaptureError> {
        // The lifecycle withdraws sample submission before stopping the source. Taking the
        // writer mutex drains any admitted append before AVFoundation finishes the file.
        let stop = self.stream.take().unwrap().stop_capture();
        let result = self.writer.lock().unwrap().finish(duration_ns);
        result.map(|_| stop.err().map(|_| CaptureError::NativeFailure))
    }
    fn cancel(&mut self) {
        if let Some(mut stream) = self.stream.take() { let _ = stream.stop_capture(); }
        self.writer.lock().unwrap().cancel();
    }
}
impl Drop for MacRecorder { fn drop(&mut self) { if self.stream.is_some() { self.cancel(); } } }

fn submit_screen_sample(sample: *mut c_void, status: Option<SCFrameStatus>,
    timeline: &Mutex<Timeline>, output: &Mutex<Writer>) -> Result<(), CaptureError> {
    if status != Some(SCFrameStatus::Complete) { return Ok(()); }
    let mut timing = SampleTiming::default();
    if unsafe { CMSampleBufferGetSampleTimingInfo(sample, 0, &mut timing) } != 0 { return Ok(()); }
    let Some(source_ns) = timing.presentation.nanoseconds() else { return Ok(()); };
    let mut admission = timeline.lock().unwrap();
    let Some(timestamp) = admission.sample_time(source_ns) else { return Ok(()); };
    let result = output.lock().unwrap().append(sample, timestamp);
    // A phase transition waits for this admitted append. No callback can append
    // after the lifecycle withdraws submission and starts writer completion.
    drop(admission);
    result
}

pub fn prepare(content: &SCShareableContent, inventory: &Inventory, target: &CaptureTarget,
    path: &Path, timeline: Arc<Mutex<Timeline>>, failed: Arc<dyn Fn(CaptureError) + Send + Sync>) -> Result<PreparedBackend, CaptureError> {
    let mut config = SCStreamConfiguration::new().with_pixel_format(PixelFormat::BGRA)
        .with_shows_cursor(true).with_captures_audio(false)
        .with_color_space_name(screencapturekit::stream::configuration::color_space::SRGB)
        .map_err(|_| CaptureError::NativeFailure)?;
    let (filter, input_size, size, scale, origin, source) = match target {
        CaptureTarget::Window { window_id } => {
            let window = content.windows().into_iter().find(|w| w.window_id() == *window_id).ok_or(CaptureError::TargetUnavailable)?;
            let facts = inventory.windows.iter().find(|w| w.window_id == *window_id).ok_or(CaptureError::TargetUnavailable)?;
            let display = inventory.window_display(facts)
                .ok_or(CaptureError::TargetUnavailable)?;
            let filter = SCContentFilter::create().with_window(&window).build().map_err(|_| CaptureError::NativeFailure)?;
            let scale = display.scale;
            let width = (facts.frame.width*scale).round() as u32;
            let height = (facts.frame.height*scale).round() as u32;
            let input_size = PixelSize { width, height };
            let size = window_pixel_size(width, height);
            (filter, input_size, size, scale, None, Some(CaptureSource { app_name: facts.app_name.clone(),
                window_title: facts.title.clone(), window_id: Some(*window_id) }))
        },
        CaptureTarget::Frontmost => {
            let window_id = inventory.windows.first().ok_or(CaptureError::TargetUnavailable)?.window_id;
            return prepare(content, inventory, &CaptureTarget::Window { window_id }, path, timeline, failed);
        },
        CaptureTarget::Display { display_id } | CaptureTarget::Rect { display_id, .. } => {
            let display = content.displays().into_iter().find(|d| d.display_id() == *display_id).ok_or(CaptureError::TargetUnavailable)?;
            let facts = inventory.displays.iter().find(|d| d.display_id == *display_id).ok_or(CaptureError::TargetUnavailable)?;
            let rect = if let CaptureTarget::Rect { rect, .. } = target { clamp_local_rect(*rect, facts)? }
                else { Rect { x: 0., y: 0., width: facts.frame.width, height: facts.frame.height } };
            let (left,right) = even_interval((rect.x*facts.scale).floor() as u32,
                ((rect.x+rect.width)*facts.scale).ceil() as u32, (facts.frame.width*facts.scale).round() as u32)?;
            let (top,bottom) = even_interval((rect.y*facts.scale).floor() as u32,
                ((rect.y+rect.height)*facts.scale).ceil() as u32, (facts.frame.height*facts.scale).round() as u32)?;
            let rect = Rect { x: left as f64/facts.scale, y: top as f64/facts.scale,
                width: (right-left) as f64/facts.scale, height: (bottom-top) as f64/facts.scale };
            config = config.with_source_rect(CGRect::new(rect.x, rect.y, rect.width, rect.height));
            let apps = content.applications();
            let own: Vec<_> = apps.iter().filter(|a| a.process_id() as u32 == std::process::id()).collect();
            let filter = SCContentFilter::create().with_display(&display).with_excluding_applications(&own, &[]).build()
                .map_err(|_| CaptureError::NativeFailure)?;
            let size = PixelSize { width: right-left, height: bottom-top };
            (filter, size, size, facts.scale,
                Some(CaptureOrigin { display_id: *display_id, rect }), None)
        },
    };
    config = config.with_width(input_size.width).with_height(input_size.height);
    let writer = Arc::new(Mutex::new(Writer::new(path, input_size)?));
    struct Delegate(Arc<dyn Fn(CaptureError) + Send + Sync>);
    impl SCStreamDelegateTrait for Delegate { fn did_stop_with_error(&self, _: SCError) { (self.0)(CaptureError::NativeFailure); } }
    let mut stream = SCStream::new_with_delegate(&filter, &config, Delegate(failed.clone())).map_err(|_| CaptureError::NativeFailure)?;
    let output = writer.clone();
    stream.add_output_handler(move |sample: CMSampleBuffer, kind: SCStreamOutputType| {
        if kind != SCStreamOutputType::Screen { return; }
        let result = submit_screen_sample(sample.as_ptr(), sample.frame_status(), &timeline, &output);
        if let Err(error) = result { failed(error); }
    }, SCStreamOutputType::Screen).map_err(|_| CaptureError::NativeFailure)?;
    Ok(PreparedBackend { backend: Box::new(MacRecorder { stream: Some(stream), writer }), pixel_size: size, scale: Some(scale), origin, source })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use objc2::{define_class, AnyThread, DefinedClass};
    use objc2_foundation::{NSObject, NSObjectProtocol};
    use std::sync::atomic::{AtomicBool, Ordering};

    struct DeferredInputState {
        native: Retained<AnyObject>,
        blocked: Arc<AtomicBool>,
        queried: Arc<Mutex<Option<mpsc::Sender<()>>>>,
    }
    // Only the SDK's readiness is controlled. All encoding, appends, completion,
    // KVO delivery and decoding use AVFoundation beneath this native boundary.
    define_class!(
        #[unsafe(super(NSObject))]
        #[name = "HappierRecordingDeferredInputFixture"]
        #[ivars = DeferredInputState]
        struct DeferredInput;
        unsafe impl NSObjectProtocol for DeferredInput {}
        impl DeferredInput {
            #[unsafe(method(isReadyForMoreMediaData))]
            fn ready(&self) -> Bool {
                if self.ivars().blocked.load(Ordering::Acquire) {
                    if let Some(signal) = self.ivars().queried.lock().unwrap().as_ref() { let _ = signal.send(()); }
                    Bool::NO
                } else { unsafe { msg_send![&*self.ivars().native, isReadyForMoreMediaData] } }
            }
            #[unsafe(method(appendSampleBuffer:))]
            fn append(&self, sample: *mut SampleBuffer) -> Bool {
                unsafe { msg_send![&*self.ivars().native, appendSampleBuffer: sample] }
            }
            #[unsafe(method(markAsFinished))]
            fn finish(&self) {
                unsafe { let _: () = msg_send![&*self.ivars().native, markAsFinished]; }
            }
        }
    );
    unsafe impl RefEncode for Time {
        const ENCODING_REF: Encoding = Encoding::Pointer(&Time::ENCODING);
    }

    /// Test-only native decoder shared by writer/trim fixtures, never a product frame-export API.
    pub(crate) fn decoded_frame(path: &Path) -> (PixelSize, Vec<u8>) {
        decoded_frame_at(path, 0)
    }
    fn decoded_frame_at(path: &Path, time_ms: u64) -> (PixelSize, Vec<u8>) {
        use objc2_foundation::{NSRect, NSPoint, NSSize};
        use objc2_core_graphics::CGImage;
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGColorSpaceCreateDeviceRGB() -> *mut c_void;
            fn CGBitmapContextCreate(data: *mut u8, width: usize, height: usize, bits: usize,
                stride: usize, space: *mut c_void, info: u32) -> *mut c_void;
            fn CGContextDrawImage(context: *mut c_void, rect: NSRect, image: *mut CGImage);
            fn CGImageGetWidth(image: *mut CGImage) -> usize;
            fn CGImageGetHeight(image: *mut CGImage) -> usize;
        }
        objc2::rc::autoreleasepool(|_| unsafe {
            let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str().unwrap()));
            let asset: Retained<AnyObject> = msg_send![class!(AVURLAsset), URLAssetWithURL: &*url,
                options: std::ptr::null::<AnyObject>()];
            let generator: Retained<AnyObject> = msg_send![class!(AVAssetImageGenerator),
                assetImageGeneratorWithAsset: &*asset];
            let zero = Time::milliseconds(0).unwrap();
            let _: () = msg_send![&*generator, setRequestedTimeToleranceBefore: zero];
            let _: () = msg_send![&*generator, setRequestedTimeToleranceAfter: zero];
            let mut error: *mut AnyObject = std::ptr::null_mut();
            let image: *mut CGImage = msg_send![&*generator, copyCGImageAtTime: Time::milliseconds(time_ms).unwrap(),
                actualTime: std::ptr::null_mut::<Time>(), error: &mut error];
            assert!(!image.is_null(), "native fixture decode must succeed");
            let width = CGImageGetWidth(image); let height = CGImageGetHeight(image);
            let mut rgba = vec![0; width * height * 4];
            let rgb = CGColorSpaceCreateDeviceRGB();
            let context = CGBitmapContextCreate(rgba.as_mut_ptr(), width, height, 8, width * 4, rgb, 1 | (4 << 12));
            assert!(!context.is_null());
            CGContextDrawImage(context, NSRect::new(NSPoint::new(0., 0.),
                NSSize::new(width as f64, height as f64)), image);
            CFRelease(context); CFRelease(rgb); CFRelease(image.cast());
            (PixelSize { width: width as u32, height: height as u32 }, rgba)
        })
    }
    #[link(name = "CoreVideo", kind = "framework")]
    extern "C" {
        fn CVPixelBufferCreate(allocator: *const c_void, width: usize, height: usize, format: u32,
            attributes: *const c_void, buffer: *mut *mut c_void) -> i32;
        fn CVPixelBufferLockBaseAddress(buffer: *mut c_void, flags: u64) -> i32;
        fn CVPixelBufferUnlockBaseAddress(buffer: *mut c_void, flags: u64) -> i32;
        fn CVPixelBufferGetBaseAddress(buffer: *mut c_void) -> *mut u8;
        fn CVPixelBufferGetBytesPerRow(buffer: *mut c_void) -> usize;
    }
    extern "C" {
        fn CMVideoFormatDescriptionCreateForImageBuffer(allocator: *const c_void, image: *mut c_void,
            description: *mut *mut c_void) -> i32;
        fn CMSampleBufferCreateReadyWithImageBuffer(allocator: *const c_void, image: *mut c_void,
            description: *mut c_void, timing: *const SampleTiming, sample: *mut *mut c_void) -> i32;
    }
    unsafe fn fixture_sample(size: PixelSize, source_ns: u64, color: [u8; 4],
        pixel_color: impl Fn(u32, u32, [u8; 4]) -> [u8; 4], sample_duration: Time) -> *mut c_void {
        let mut pixel = std::ptr::null_mut();
        assert_eq!(CVPixelBufferCreate(std::ptr::null(), size.width as usize, size.height as usize, u32::from_be_bytes(*b"BGRA"), std::ptr::null(), &mut pixel), 0);
        assert_eq!(CVPixelBufferLockBaseAddress(pixel, 0), 0);
        let stride = CVPixelBufferGetBytesPerRow(pixel);
        for row in 0..size.height as usize { for column in 0..size.width as usize {
            let color = pixel_color(column as u32, row as u32, color);
            std::ptr::copy_nonoverlapping(color.as_ptr(), CVPixelBufferGetBaseAddress(pixel).add(row*stride+column*4), 4);
        } }
        assert_eq!(CVPixelBufferUnlockBaseAddress(pixel, 0), 0);
        let mut format = std::ptr::null_mut();
        assert_eq!(CMVideoFormatDescriptionCreateForImageBuffer(std::ptr::null(), pixel, &mut format), 0);
        let timing = SampleTiming { duration: sample_duration, presentation: Time::ns(source_ns), decode: Time::default() };
        let mut sample = std::ptr::null_mut();
        assert_eq!(CMSampleBufferCreateReadyWithImageBuffer(std::ptr::null(), pixel, format, &timing, &mut sample), 0);
        CFRelease(format); CFRelease(pixel);
        sample
    }
    /// Native fixture: labelled red/green frames, never a desktop grant or mocked writer.
    pub(crate) fn fixture(path: &Path) {
        fixture_until(path, 2_000_000_000);
    }
    pub(crate) fn fixture_with_size(path: &Path, size: PixelSize) {
        fixture_with_pixels(path, 2_000_000_000, size, |_, _, color| color);
    }
    fn fixture_until(path: &Path, duration_ns: u64) {
        fixture_with_pixels(path, duration_ns, PixelSize { width: 64, height: 48 }, |_, _, color| color);
    }
    fn fixture_with_pixels(path: &Path, duration_ns: u64, size: PixelSize,
        pixel_color: impl Fn(u32, u32, [u8; 4]) -> [u8; 4]) {
        fixture_frames(path, duration_ns, size, [(100_000_000_000, [0u8, 0, 255, 255], false),
            (110_000_000_000, [0u8, 255, 0, 255], true)], pixel_color);
    }
    fn fixture_frames(path: &Path, duration_ns: u64, size: PixelSize,
        frames: impl IntoIterator<Item = (u64, [u8; 4], bool)>,
        pixel_color: impl Fn(u32, u32, [u8; 4]) -> [u8; 4]) {
        fixture_frames_with_sample_duration(path, duration_ns, size,
            frames.into_iter().map(|(time, color, pause)| (time, color, pause, SCFrameStatus::Complete)),
            pixel_color, Time::ns(1_000_000_000), |_| {});
    }
    fn fixture_frames_with_sample_duration(path: &Path, duration_ns: u64, size: PixelSize,
        frames: impl IntoIterator<Item = (u64, [u8; 4], bool, SCFrameStatus)>,
        pixel_color: impl Fn(u32, u32, [u8; 4]) -> [u8; 4], sample_duration: Time,
        before_finish: impl FnOnce(&Writer)) {
        objc2::rc::autoreleasepool(|_| unsafe {
            let writer = Mutex::new(Writer::new(path, size).unwrap());
            let timeline = Mutex::new(Timeline::new());
            timeline.lock().unwrap().start(super::super::Moment { steady_ns: 0, epoch_ms: 0 });
            for (source_ns, color, pause_before, status) in frames {
                if pause_before {
                    let mut admission = timeline.lock().unwrap();
                    admission.pause(super::super::Moment { steady_ns: 1_000_000_000, epoch_ms: 1000 });
                    assert!(admission.sample_time(105_000_000_000).is_none());
                    admission.resume(super::super::Moment { steady_ns: 10_000_000_000, epoch_ms: 10000 });
                }
                let sample = fixture_sample(size, source_ns, color, &pixel_color, sample_duration);
                // Fixture admission waits for the real encoder, unlike the real-time source
                // which may drop a frame when back-pressured. No product polling is added.
                let encoder = writer.lock().unwrap();
                if encoder.started { loop {
                    let ready: Bool = msg_send![&*encoder.input, isReadyForMoreMediaData];
                    if ready.as_bool() { break; }
                    let status: isize = msg_send![&*encoder.writer, status];
                    assert_ne!(status, 3); std::thread::yield_now();
                } }
                drop(encoder);
                submit_screen_sample(sample, Some(status), &timeline, &writer).unwrap();
                CFRelease(sample);
            }
            let mut encoder = writer.lock().unwrap();
            before_finish(&encoder);
            let finished = encoder.finish(duration_ns);
            if finished.is_err() {
                let status: isize = msg_send![&*encoder.writer, status];
                let error: *mut AnyObject = msg_send![&*encoder.writer, error];
                let code: isize = if error.is_null() { 0 } else { msg_send![error, code] };
                let underlying_code: isize = if error.is_null() { 0 } else {
                    let info: *mut AnyObject = msg_send![error, userInfo];
                    let underlying: *mut AnyObject = msg_send![info, objectForKey: &*NSString::from_str("NSUnderlyingError")];
                    if underlying.is_null() { 0 } else { msg_send![underlying, code] }
                };
                println!("FIXTURE_WRITER_FAILURE status={status} code={code} underlying_code={underlying_code}");
            }
            finished.unwrap();
        });
    }
    #[test]
    fn native_writer_tags_srgb_color_for_player_frame_agreement() {
        #[link(name = "CoreMedia", kind = "framework")]
        extern "C" {
            static kCMFormatDescriptionExtension_ColorPrimaries: &'static NSString;
            static kCMFormatDescriptionExtension_TransferFunction: &'static NSString;
            static kCMFormatDescriptionExtension_YCbCrMatrix: &'static NSString;
            fn CMFormatDescriptionGetExtension(description: *const c_void, key: &NSString) -> *mut NSString;
        }
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("srgb.mp4");
        // Same dark, non-primary colour that exposed the WK/FFmpeg mismatch in MAC-QA.
        fixture_with_pixels(&path, 2_000_000_000, PixelSize { width: 130, height: 98 },
            |_, _, _| [84, 61, 41, 255]);
        let trimmed = root.path().join("trimmed.mp4");
        super::super::trim::trim(&path, &trimmed, 250, 1750, &crate::capture::CancelSignal::default()).unwrap();
        // Retain only this synthetic output when running the finite decoded-comparison harness.
        if let Some(destination) = std::env::var_os("HAPPIER_MAC_FIX3_COLOR_FIXTURE") {
            std::fs::copy(&path, &destination).unwrap();
            std::fs::copy(&trimmed, std::path::PathBuf::from(destination).with_extension("trimmed.mp4")).unwrap();
        }
        for path in [&path, &trimmed] {
            objc2::rc::autoreleasepool(|_| unsafe {
                let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str().unwrap()));
                let asset: Retained<AnyObject> = msg_send![class!(AVURLAsset), URLAssetWithURL: &*url,
                    options: std::ptr::null::<AnyObject>()];
                let tracks: Retained<AnyObject> = msg_send![&*asset, tracksWithMediaType: AVMediaTypeVideo];
                let track: Retained<AnyObject> = msg_send![&*tracks, firstObject];
                let formats: Retained<AnyObject> = msg_send![&*track, formatDescriptions];
                let format: *mut AnyObject = msg_send![&*formats, firstObject];
                for (key, expected) in [
                    (kCMFormatDescriptionExtension_ColorPrimaries, "ITU_R_709_2"),
                    (kCMFormatDescriptionExtension_TransferFunction, "IEC_sRGB"),
                    (kCMFormatDescriptionExtension_YCbCrMatrix, "ITU_R_709_2"),
                ] {
                    let actual = CMFormatDescriptionGetExtension(format.cast(), key);
                    assert!(!actual.is_null(), "missing writer colour tag: {key}");
                    assert_eq!((*actual).to_string(), expected, "writer colour tag: {key}");
                }
            });
        }
    }
    #[test]
    fn native_writer_produces_silent_h264_with_the_paused_interval_removed() {
        let root = tempfile::tempdir().unwrap(); let path = root.path().join("fixture.mp4");
        fixture(&path);
        let size = std::fs::metadata(&path).unwrap().len();
        let mut movie = mp4::Mp4Reader::read_header(std::io::BufReader::new(std::fs::File::open(path).unwrap()), size).unwrap();
        assert_eq!(movie.tracks().len(), 1, "no audio track");
        let track = movie.tracks().values().next().unwrap();
        assert_eq!(track.track_type().unwrap(), mp4::TrackType::Video);
        assert_eq!(track.media_type().unwrap(), mp4::MediaType::H264);
        assert_eq!((track.width(), track.height()), (64, 48));
        assert_eq!(track.sample_count(), 2);
        let id = track.track_id();
        assert!(movie.duration().as_secs_f64() < 3., "pause must not be present in muxed timestamps");
        assert!(!movie.read_sample(id, 1).unwrap().unwrap().bytes.is_empty());
    }
    #[test]
    fn capture_library_exposes_the_media_frame_duration_for_trim_admission() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("capture-timing.mp4");
        fixture(&path);
        let mut files = crate::capture::files::CaptureFiles::default();
        let result = files.open_media(root.path(), &path).unwrap();
        let timing = serde_json::to_value(files.video_timing(&result.capture_ref).unwrap()).unwrap();
        assert_eq!(timing, serde_json::json!({ "durationMs": 2000, "frameDurationMs": 1000.0 }));
    }
    #[test]
    fn moving_fixture_preserves_every_frame_and_pause_offsets_through_stop() {
        let root = tempfile::tempdir().unwrap(); let path = root.path().join("moving.mp4");
        // This synthetic source supplies 25 frames per active second, with a
        // nine-second pause after the first second. Product cadence stays native.
        let frame_ns = 40_000_000;
        let count = 5 * 25;
        fixture_frames(&path, 5_000_000_000, PixelSize { width: 64, height: 48 },
            (0..count).map(|index| (100_000_000_000 + index * frame_ns
                + if index >= 25 { 9_000_000_000 } else { 0 }, [index as u8, 255, 0, 255], index == 25)),
            |_, _, color| color);
        let bytes = std::fs::metadata(&path).unwrap().len();
        let mut movie = mp4::Mp4Reader::read_header(std::io::BufReader::new(std::fs::File::open(&path).unwrap()), bytes).unwrap();
        let track = movie.tracks().values().next().unwrap();
        assert_eq!(u64::from(track.sample_count()), count);
        let (id, scale) = (track.track_id(), u64::from(track.timescale()));
        let last = movie.read_sample(id, count as u32).unwrap().unwrap();
        assert_eq!((last.start_time + u64::from(last.duration)) * 1_000_000_000 / scale, 5_000_000_000);
        if let Some(destination) = std::env::var_os("HAPPIER_REC_TRUNC_FIXTURE") {
            std::fs::copy(&path, destination).unwrap();
        }
    }
    #[test]
    fn a_single_source_frame_covers_the_recording_until_stop() {
        let root = tempfile::tempdir().unwrap(); let path = root.path().join("single-frame.mp4");
        fixture_frames(&path, 4_000_000_000, PixelSize { width: 64, height: 48 },
            [(100_000_000_000, [0, 255, 0, 255], false)], |_, _, color| color);
        let bytes = std::fs::metadata(&path).unwrap().len();
        let mut movie = mp4::Mp4Reader::read_header(std::io::BufReader::new(std::fs::File::open(&path).unwrap()), bytes).unwrap();
        let track = movie.tracks().values().next().unwrap();
        assert_eq!(track.sample_count(), 1);
        let (id, scale) = (track.track_id(), u64::from(track.timescale()));
        let only = movie.read_sample(id, 1).unwrap().unwrap();
        assert_eq!((only.start_time + u64::from(only.duration)) * 1000 / scale, 4000);
        let (_, pixels) = decoded_frame_at(&path, 3000);
        assert!(pixels.chunks_exact(4).all(|rgba| rgba[1] > rgba[0] && rgba[1] > rgba[2]));
    }
    #[test]
    fn unchanged_source_keeps_its_last_frame_until_the_actual_stop() {
        let root = tempfile::tempdir().unwrap(); let path = root.path().join("static-end.mp4");
        fixture_until(&path, 49_000_000_000);
        let bytes = std::fs::metadata(&path).unwrap().len();
        let mut movie = mp4::Mp4Reader::read_header(std::io::BufReader::new(std::fs::File::open(&path).unwrap()), bytes).unwrap();
        assert_eq!(movie.duration().as_millis(), 49000);
        let track = movie.tracks().values().next().unwrap();
        let (id, count, scale) = (track.track_id(), track.sample_count(), track.timescale());
        let last = movie.read_sample(id, count).unwrap().unwrap();
        assert_eq!(count, 2, "an unchanged source needs no repeated frames while the control is hidden");
        assert_eq!((last.start_time + u64::from(last.duration)) * 1000 / u64::from(scale), 49000,
            "the video samples, not only the container edit list, must cover the static interval");
        let (_, pixels) = decoded_frame_at(&path, 30_000);
        assert!(pixels.chunks_exact(4).all(|rgba| rgba[1] > rgba[0] && rgba[1] > rgba[2]));
        if let Some(destination) = std::env::var_os("HAPPIER_REC_TRUNC_STATIC_FIXTURE") {
            std::fs::copy(&path, destination).unwrap();
        }
    }
    #[test]
    fn complete_frames_then_idle_buffers_keep_the_track_until_stop() {
        for sample_duration in [Time::default(), Time::ns(16_666_667)] {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("sck-static.mp4");
            let stop_ns = 50_803_000_000;
            fixture_frames_with_sample_duration(&path, stop_ns, PixelSize { width: 600, height: 400 },
                [0, 523_333_333, 538_333_333].map(|offset| (100_000_000_000 + offset, [0, 255, 0, 255], false, SCFrameStatus::Complete))
                    .into_iter().chain([1_000_000_000, stop_ns].map(|offset|
                        (100_000_000_000 + offset, [0, 255, 0, 255], false, SCFrameStatus::Idle))),
                |_, _, color| color, sample_duration, |_| {});
            let bytes = std::fs::metadata(&path).unwrap().len();
            let mut movie = mp4::Mp4Reader::read_header(std::io::BufReader::new(std::fs::File::open(&path).unwrap()), bytes).unwrap();
            let track = movie.tracks().values().next().unwrap();
            let (id, count, scale) = (track.track_id(), track.sample_count(), u64::from(track.timescale()));
            let media_ns = track.duration().as_nanos();
            println!("STATIC_SCK samples={count} sample_duration_flags={} movie_ns={} media_ns={media_ns}", sample_duration.flags, movie.duration().as_nanos());
            for index in 1..=count {
                let sample = movie.read_sample(id, index).unwrap().unwrap();
                println!("STATIC_SCK sample={index} start={} duration={} offset={}", sample.start_time, sample.duration, sample.rendering_offset);
            }
            assert_eq!(count, 3);
            assert!(media_ns.abs_diff(u128::from(stop_ns)) <= u128::from(1_000_000_000 / scale),
                "the encoded video track must cover Stop to its native timestamp granularity");
            let (_, pixels) = decoded_frame_at(&path, 30_000);
            assert!(pixels.chunks_exact(4).all(|rgba| rgba[1] > rgba[0] && rgba[1] > rgba[2]));
            if let Some(destination) = std::env::var_os("HAPPIER_REC_TRUNC_IDLE_FIXTURE") {
                std::fs::copy(&path, destination).unwrap();
            }
        }
    }
    #[test]
    fn backpressured_complete_then_idle_source_finishes_without_another_frame() {
        fn release(controller: Writer, blocked: Arc<AtomicBool>, observed: mpsc::Receiver<()>) {
            if observed.recv().is_err() { return; }
            unsafe {
                let proxy = &*(Retained::as_ptr(&controller.input) as *const DeferredInput);
                super::super::macos_readiness::Readiness::new(&proxy.ivars().native, &controller.writer).wait().unwrap();
                let key = NSString::from_str("readyForMoreMediaData");
                let _: () = msg_send![&*controller.input, willChangeValueForKey: &*key];
                blocked.store(false, Ordering::Release);
                let _: () = msg_send![&*controller.input, didChangeValueForKey: &*key];
            }
        }
        // Exercise both startup backpressure (no previously held frame) and a
        // previously ready encoder becoming nonready exactly when Stop arrives.
        for initially_blocked in [true, false] {
            let root = tempfile::tempdir().unwrap();
            let path = root.path().join("backpressured-static.mp4");
            let stop_ns = 50_547_000_000;
            objc2::rc::autoreleasepool(|_| unsafe {
                let blocked = Arc::new(AtomicBool::new(initially_blocked));
                let queried = Arc::new(Mutex::new(None));
                let mut encoder = Writer::new(&path, PixelSize { width: 600, height: 400 }).unwrap();
                let proxy = DeferredInput::alloc().set_ivars(DeferredInputState {
                    native: encoder.input.clone(), blocked: blocked.clone(), queried: queried.clone(),
                });
                let proxy: Retained<DeferredInput> = msg_send![super(proxy), init];
                encoder.input = Retained::into_super(proxy).into();
                let writer = Mutex::new(encoder);
                let timeline = Mutex::new(Timeline::new());
                timeline.lock().unwrap().start(super::super::Moment { steady_ns: 0, epoch_ms: 0 });
                for (offset, status) in [0, 523_333_333, 538_333_333].map(|offset| (offset, SCFrameStatus::Complete))
                    .into_iter().chain([1_000_000_000, stop_ns].map(|offset| (offset, SCFrameStatus::Idle))) {
                    if !initially_blocked {
                        let encoder = writer.lock().unwrap();
                        if encoder.started {
                            super::super::macos_readiness::Readiness::new(&encoder.input, &encoder.writer).wait().unwrap();
                        }
                    }
                    let sample = fixture_sample(PixelSize { width: 600, height: 400 }, 100_000_000_000 + offset,
                        [0, 255, 0, 255], |_, _, color| color, Time::default());
                    submit_screen_sample(sample, Some(status), &timeline, &writer).unwrap();
                    CFRelease(sample);
                }
                blocked.store(true, Ordering::Release);
                let mut encoder = writer.lock().unwrap();
                let ready: Bool = msg_send![&*encoder.input, isReadyForMoreMediaData];
                assert!(!ready.as_bool(), "Stop must encounter real-time input backpressure");
                println!("SPARSE_STOP initially_blocked={initially_blocked} pending={} ready=false", encoder.pending.is_some());
                let controller = Writer { writer: encoder.writer.clone(), input: encoder.input.clone(), started: true, pending: None };
                let (signal, observed) = mpsc::channel();
                *queried.lock().unwrap() = Some(signal);
                let finished = std::thread::scope(|scope| {
                    scope.spawn(move || release(controller, blocked, observed));
                    let result = encoder.finish(stop_ns);
                    queried.lock().unwrap().take();
                    result
                });
                finished.expect("Complete then Idle must save even when the encoder is not ready at Stop");
            });
            let bytes = std::fs::metadata(&path).unwrap().len();
            let movie = mp4::Mp4Reader::read_header(std::io::BufReader::new(std::fs::File::open(&path).unwrap()), bytes).unwrap();
            let track = movie.tracks().values().next().unwrap();
            assert_eq!(track.sample_count(), if initially_blocked { 1 } else { 3 }, "no repeated-frame cadence");
            let tick_ns = 1_000_000_000 / u128::from(track.timescale());
            assert!(track.duration().as_nanos().abs_diff(u128::from(stop_ns)) <= tick_ns);
            assert!(movie.duration().as_nanos().abs_diff(u128::from(stop_ns)) <= tick_ns);
            let (_, pixels) = decoded_frame_at(&path, 30_000);
            assert!(pixels.chunks_exact(4).all(|rgba| rgba[1] > rgba[0] && rgba[1] > rgba[2]));
            println!("SPARSE_STOP initially_blocked={initially_blocked} samples={} media_ns={} completed", track.sample_count(), track.duration().as_nanos());
        }
    }
    #[test]
    fn cancelled_writer_wakes_a_nonready_input_without_a_readiness_callback() {
        let root = tempfile::tempdir().unwrap();
        objc2::rc::autoreleasepool(|_| unsafe {
            let writer = Writer::new(&root.path().join("cancelled.mp4"), PixelSize { width: 64, height: 48 }).unwrap();
            let started: Bool = msg_send![&*writer.writer, startWriting];
            assert!(started.as_bool());
            let _: () = msg_send![&*writer.writer, startSessionAtSourceTime: Time::ns(0)];
            // A finished native input cannot become ready again. Cancellation
            // must wake on writer status, rather than await another ready edge.
            let _: () = msg_send![&*writer.input, markAsFinished];
            let ready: Bool = msg_send![&*writer.input, isReadyForMoreMediaData];
            assert!(!ready.as_bool());
            let observation = super::super::macos_readiness::Readiness::new(&writer.input, &writer.writer);
            let mut controller = Writer { writer: writer.writer.clone(), input: writer.input.clone(), started: true, pending: None };
            std::thread::scope(|scope| {
                scope.spawn(move || controller.cancel());
                assert_eq!(observation.wait(), Err(CaptureError::FileIo));
            });
        });
    }
    #[test]
    fn simultaneous_writers_finish_with_complete_independent_movies() {
        let root = tempfile::tempdir().unwrap();
        let finish = std::sync::Barrier::new(2);
        std::thread::scope(|scope| {
            for index in 0..2 {
                let path = root.path().join(format!("recording-{index}.mp4"));
                let finish = &finish;
                scope.spawn(move || {
                    fixture_frames_with_sample_duration(&path, 2_000_000_000,
                        PixelSize { width: 600, height: 400 },
                        [0, 1_000_000_000].map(|offset|
                            (100_000_000_000 + offset, [0, 255, 0, 255], false, SCFrameStatus::Complete)),
                        |_, _, color| color, Time::ns(1_000_000_000), |writer| {
                            finish.wait();
                            let status: isize = unsafe { msg_send![&*writer.writer, status] };
                            let ready: Bool = unsafe { msg_send![&*writer.input, isReadyForMoreMediaData] };
                            println!("CONCURRENT_FINISH writer={index} status={status} ready={}", ready.as_bool());
                        });
                    let bytes = std::fs::metadata(&path).unwrap().len();
                    let movie = mp4::Mp4Reader::read_header(std::io::BufReader::new(
                        std::fs::File::open(&path).unwrap()), bytes).unwrap();
                    let track = movie.tracks().values().next().unwrap();
                    assert_eq!(track.sample_count(), 2);
                    assert_eq!(track.duration().as_millis(), 2000);
                    let (_, pixels) = decoded_frame_at(&path, 1500);
                    assert!(pixels.chunks_exact(4).all(|rgba| rgba[1] > rgba[0] && rgba[1] > rgba[2]));
                    println!("CONCURRENT_FINISH writer={index} completed");
                });
            }
        });
    }
    #[test]
    fn odd_window_reports_the_encoders_even_dimensions() {
        assert_eq!(window_pixel_size(65, 49), PixelSize { width: 64, height: 48 });
        assert_eq!(window_pixel_size(64, 49), PixelSize { width: 64, height: 48 });
        assert_eq!(window_pixel_size(65, 48), PixelSize { width: 64, height: 48 });
        assert_eq!(window_pixel_size(64, 48), PixelSize { width: 64, height: 48 });
    }
    #[test]
    fn native_odd_window_keeps_pixels_without_rescaling_the_trailing_edges() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("odd-window.mp4");
        let source = PixelSize { width: 65, height: 49 };
        fixture_with_pixels(&path, 2_000_000_000, source, |x, y, color| {
            // A rescale includes the green trailing edge. A crop leaves the first frame red.
            if x == source.width - 1 || y == source.height - 1 { [0, 255, 0, 255] } else { color }
        });
        let bytes = std::fs::metadata(&path).unwrap().len();
        let movie = mp4::Mp4Reader::read_header(std::io::BufReader::new(
            std::fs::File::open(&path).unwrap()), bytes).unwrap();
        let video = movie.tracks().values().next().unwrap();
        assert_eq!((video.width(), video.height()), (64, 48));
        let (size, pixels) = decoded_frame(&path);
        assert_eq!(size, PixelSize { width: 64, height: 48 });
        assert!(pixels.chunks_exact(4).all(|rgba| rgba[0] > rgba[1] && rgba[0] > rgba[2]),
            "the green trailing row/column must be absent from every decoded pixel");
    }
    #[test]
    fn odd_area_dimensions_use_real_neighbours_including_the_display_edge() {
        assert_eq!(even_interval(3, 8, 10).unwrap(), (3, 9));
        assert_eq!(even_interval(5, 10, 10).unwrap(), (4, 10));
        assert_eq!(even_interval(2, 8, 10).unwrap(), (2, 8));
    }
}
