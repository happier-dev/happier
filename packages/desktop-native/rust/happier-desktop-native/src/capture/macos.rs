//! ScreenCaptureKit stills. Metadata is acquired on demand and retained for one operation.
use super::*;
use objc2::{msg_send, rc::Retained, runtime::AnyObject, MainThreadMarker};
use objc2_core_graphics::CGDisplayBounds;
use objc2_foundation::{NSProcessInfo, NSString};
use screencapturekit::{prelude::*, screenshot_manager::{CGImageExt, SCScreenshotManager},
    cm::{CMSampleBufferExt, CMSampleBufferSCExt, SCFrameStatus}};
use std::{collections::HashMap, sync::mpsc};
mod metadata;
mod frontmost;

/// Start the frontmost target's workspace observation before any shell window activation.
pub fn initialize_frontmost_tracking() { frontmost::initialize(); }

pub fn display_facts(mtm: MainThreadMarker) -> Vec<DisplayDescriptor> {
    crate::display::list_displays(mtm).into_iter().filter_map(|display| {
        let id = display.cg_display_id?;
        let frame = unsafe { CGDisplayBounds(id) };
        Some(DisplayDescriptor { display_id: id,
            frame: crate::geometry::Rect { x: frame.origin.x, y: frame.origin.y,
                width: frame.size.width, height: frame.size.height }, scale: display.backing_scale_factor,
            desktop_scale: 1.,
            storage_key: Some(display.identity.storage_key), localized_name: Some(display.localized_name),
            safe_area_top: display.safe_area_top, physical_notch_size: display.physical_notch_size })
    }).collect()
}

pub use super::permissions::{screen_permission, request_screen_permission};

pub(super) fn native_error(error: SCError) -> CaptureError {
    match error { SCError::PermissionDenied(_) => CaptureError::ScreenPermissionRequired,
        _ => CaptureError::NativeFailure }
}

fn major_version() -> isize {
    NSProcessInfo::processInfo().operatingSystemVersion().majorVersion
}

pub fn window_shadow_supported() -> bool { major_version() >= 14 }

fn window_order() -> Result<HashMap<u32, usize>, CaptureError> {
    #[link(name = "CoreGraphics", kind = "framework")]
    extern "C" { fn CGWindowListCopyWindowInfo(options: u32, relative: u32) -> *mut AnyObject; }
    // CoreGraphics owns the z-order. The returned CFArray/CFDictionary objects
    // are toll-free bridged; adopt its +1 reference and release through objc2.
    let array = unsafe { Retained::from_raw(CGWindowListCopyWindowInfo(1, 0)) }
        .ok_or(CaptureError::NativeFailure)?;
    let count: usize = unsafe { msg_send![&*array, count] };
    let key = NSString::from_str("kCGWindowNumber");
    let mut order = HashMap::new();
    for index in 0..count {
        let dictionary: *mut AnyObject = unsafe { msg_send![&*array, objectAtIndex: index] };
        let value: *mut AnyObject = unsafe { msg_send![dictionary, objectForKey: &*key] };
        if !value.is_null() {
            let id: u32 = unsafe { msg_send![value, unsignedIntValue] };
            order.insert(id, index);
        }
    }
    Ok(order)
}

struct NativeMetadata {
    content: SCShareableContent,
}
impl metadata::Window for SCWindow {
    fn window_id(&self) -> u32 { SCWindow::window_id(self) }
    fn window_layer(&self) -> i32 { SCWindow::window_layer(self) }
    fn is_on_screen(&self) -> bool { SCWindow::is_on_screen(self) }
    fn process_id(&self) -> Option<u32> { self.owning_application().map(|app| app.process_id() as u32) }
    fn frame(&self) -> crate::geometry::Rect {
        let frame = SCWindow::frame(self);
        crate::geometry::Rect { x: frame.origin.x, y: frame.origin.y, width: frame.size.width, height: frame.size.height }
    }
    fn app_name(&self) -> Option<String> { self.owning_application().map(|app| app.application_name()) }
    fn title(&self) -> Option<String> { SCWindow::title(self) }
}
impl metadata::Source for NativeMetadata {
    type Window = SCWindow;
    fn windows(&self) -> Vec<SCWindow> { self.content.windows() }
    fn window_order(&self) -> Result<HashMap<u32, usize>, CaptureError> { window_order() }
    fn frontmost_process_id(&self) -> Result<u32, CaptureError> {
        frontmost::process_id().ok_or(CaptureError::TargetUnavailable)
    }
}

pub struct MacCaptureBackend {
    metadata: metadata::Metadata<NativeMetadata>,
}
impl MacCaptureBackend {
    pub fn new(displays: Vec<DisplayDescriptor>) -> Result<Self, CaptureError> {
        if screen_permission() != ScreenPermission::Granted { return Err(CaptureError::ScreenPermissionRequired); }
        let content = SCShareableContent::get().map_err(native_error)?;
        Ok(Self { metadata: metadata::Metadata::new(NativeMetadata { content }, displays) })
    }

    fn frame(&self, filter: SCContentFilter, width: u32, height: u32, window_shadow: Option<bool>, cancel: &CancelSignal) -> Result<RgbaFrame, CaptureError> {
        if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
        let mut config = frame_configuration(width, height, window_shadow)?;
        if major_version() >= 14 {
            if window_shadow == Some(true) {
                // Screenshot-manager buffers omit frame attachments. A complete
                // stream frame supplies SCK's shadow-inclusive content rectangle
                // and its fit scale; undo that scale before acquiring the still.
                let sample = self.stream_sample(&filter, &config, cancel)?;
                let rect = sample.content_rect().ok_or(CaptureError::NativeFailure)?;
                let scale = sample.scale_factor().ok_or(CaptureError::NativeFailure)?;
                let content_scale = sample.content_scale().ok_or(CaptureError::NativeFailure)?;
                let (width, height) = native_frame_dimensions(rect.size.width, rect.size.height, scale, content_scale);
                config.set_width(width);
                config.set_height(height);
            }
            if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
            let image = SCScreenshotManager::capture_image(&filter, &config).map_err(native_error)?;
            if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
            return Ok(RgbaFrame { width: image.width() as u32, height: image.height() as u32,
                rgba: image.rgba_data().map_err(native_error)? });
        }
        sample_frame(self.stream_sample(&filter, &config, cancel)?)
    }

    fn stream_sample(&self, filter: &SCContentFilter, config: &SCStreamConfiguration, cancel: &CancelSignal) -> Result<CMSampleBuffer, CaptureError> {
        let (tx, rx) = mpsc::channel();
        struct Delegate(mpsc::Sender<Result<CMSampleBuffer, CaptureError>>);
        impl SCStreamDelegateTrait for Delegate {
            fn did_stop_with_error(&self, error: SCError) { let _ = self.0.send(Err(native_error(error))); }
        }
        let mut stream = SCStream::new_with_delegate(filter, config, Delegate(tx.clone())).map_err(native_error)?;
        let frames = tx.clone();
        stream.add_output_handler(move |sample: CMSampleBuffer, kind: SCStreamOutputType| {
            if kind != SCStreamOutputType::Screen || sample.frame_status() != Some(SCFrameStatus::Complete) { return; }
            let _ = frames.send(Ok(sample));
        }, SCStreamOutputType::Screen).map_err(native_error)?;
        cancel.on_cancel(move || { let _ = tx.send(Err(CaptureError::Cancelled)); });
        let result = (|| {
            if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
            stream.start_capture().map_err(native_error)?;
            let result = rx.recv().map_err(|_| CaptureError::NativeFailure)?;
            let stopped = stream.stop_capture().map_err(native_error);
            match result { Ok(frame) => { stopped?; Ok(frame) }, Err(error) => Err(error) }
        })();
        cancel.clear_wake();
        result
    }
}

fn sample_frame(sample: CMSampleBuffer) -> Result<RgbaFrame, CaptureError> {
    let buffer = sample.pixel_buffer().ok_or(CaptureError::NativeFailure)?;
    let locked = buffer.lock_read_only().map_err(|_| CaptureError::NativeFailure)?;
    let width = locked.width(); let height = locked.height(); let stride = locked.bytes_per_row();
    // The lock holds the OS-owned BGRA allocation for the full copy.
    let bytes = unsafe { std::slice::from_raw_parts(locked.base_address(), stride*height) };
    let mut rgba = Vec::with_capacity(width*height*4);
    for row in bytes.chunks(stride).take(height) {
        for pixel in row[..width*4].chunks_exact(4) {
            let alpha = pixel[3] as u16;
            let straight = |c: u8| if alpha == 0 { 0 } else { ((c as u16*255+alpha/2)/alpha).min(255) as u8 };
            rgba.extend_from_slice(&[straight(pixel[2]), straight(pixel[1]), straight(pixel[0]), pixel[3]]);
        }
    }
    Ok(RgbaFrame { width: width as u32, height: height as u32, rgba })
}

fn frame_configuration(width: u32, height: u32, window_shadow: Option<bool>) -> Result<SCStreamConfiguration, CaptureError> {
    let mut config = SCStreamConfiguration::new().with_width(width).with_height(height)
        .with_pixel_format(PixelFormat::BGRA).with_shows_cursor(false);
    if let Some(include_shadow) = window_shadow {
        config.set_background_color_rgba(0., 0., 0., 0.);
        if window_shadow_supported() {
            config.set_ignores_shadows_single_window(!include_shadow).map_err(native_error)?;
            config.set_should_be_opaque(false).map_err(native_error)?;
        }
    }
    Ok(config)
}

fn native_frame_dimensions(width: f64, height: f64, display_scale: f64, content_scale: f64) -> (u32, u32) {
    ((width * display_scale / content_scale).round() as u32,
        (height * display_scale / content_scale).round() as u32)
}

#[cfg(test)]
mod shadow_tests {
    use super::*;

    #[test]
    fn shadow_framing_undoes_screen_capture_kits_fit_scale() {
        // Complete-frame attachments observed on mac-host: SCK fitted a
        // 428x390-point shadow frame into the 360x322-point output surface.
        assert_eq!(native_frame_dimensions(353.3743634223938, 322.0000040531158,
            2., 0.8256410360336304), (856, 780));
        assert_eq!(native_frame_dimensions(360., 322., 2., 1.), (720, 644));
    }

    #[test]
    fn window_capture_keeps_alpha_and_changes_only_the_single_window_shadow() {
        if major_version() < 14 { return; }
        for enabled in [false, true] {
            let configuration = frame_configuration(320, 200, Some(enabled)).unwrap();
            assert_eq!(configuration.ignores_shadows_single_window(), !enabled);
            assert!(!configuration.should_be_opaque());
            assert!(!configuration.ignores_shadows_display());
            assert!(!configuration.captures_shadows_only());
        }
    }
}

impl CaptureBackend for MacCaptureBackend {
    fn discover(&self) -> Result<Inventory, CaptureError> { self.metadata.discover() }
    fn foreground(&self) -> Result<Inventory, CaptureError> { self.metadata.foreground() }
    fn discover_target(&self, target: &CaptureTarget) -> Result<Inventory, CaptureError> { self.metadata.discover_target(target) }
    fn prepare_recording(&self, inventory: &Inventory, target: &CaptureTarget, path: &std::path::Path,
        timeline: std::sync::Arc<std::sync::Mutex<super::recording::Timeline>>,
        failed: std::sync::Arc<dyn Fn(CaptureError) + Send + Sync>) -> Result<super::recording::PreparedBackend, CaptureError> {
        if major_version() < 13 { return Err(CaptureError::UnsupportedPlatform); }
        super::recording::macos::prepare(&self.metadata.source.content, inventory, target, path, timeline, failed)
    }
    fn capture_display(&self, id: u32, cancel: &CancelSignal) -> Result<RgbaFrame, CaptureError> {
        let display = self.metadata.source.content.displays().into_iter().find(|d| d.display_id() == id).ok_or(CaptureError::TargetUnavailable)?;
        let d = self.metadata.displays.iter().find(|d| d.display_id == id).ok_or(CaptureError::TargetUnavailable)?;
        let apps = self.metadata.source.content.applications();
        let own: Vec<_> = apps.iter().filter(|a| a.process_id() as u32 == std::process::id()).collect();
        // Excluding the app also excludes selection/helper windows created after discovery.
        let filter = SCContentFilter::create().with_display(&display).with_excluding_applications(&own, &[]).build().map_err(native_error)?;
        self.frame(filter, (d.frame.width*d.scale).round() as u32, (d.frame.height*d.scale).round() as u32, None, cancel)
    }
    fn capture_window(&self, id: u32, include_shadow: bool, cancel: &CancelSignal) -> Result<RgbaFrame, CaptureError> {
        let window = self.metadata.source.content.windows().into_iter().find(|w| w.window_id() == id).ok_or(CaptureError::TargetUnavailable)?;
        let frame = <SCWindow as metadata::Window>::frame(&window);
        let filter = SCContentFilter::create().with_window(&window).build().map_err(native_error)?;
        let scale = if major_version() >= 14 { filter.point_pixel_scale() as f64 } else {
            super::display_for_window_frame(&self.metadata.displays, &frame)
                .map(|d| d.scale).ok_or(CaptureError::TargetUnavailable)?
        };
        self.frame(filter, (frame.width*scale).round() as u32, (frame.height*scale).round() as u32, Some(include_shadow), cancel)
    }
}
