use super::{CaptureError, CaptureOrigin, CaptureSource};
use crate::geometry::Rect;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DisplayDescriptor {
    pub display_id: u32, pub frame: Rect, pub scale: f64,
    /// Logical selection delta to native desktop delta. macOS uses points;
    /// Windows uses physical pixels. The signed native origin is never scaled.
    pub desktop_scale: f64,
    pub storage_key: Option<String>, pub localized_name: Option<String>,
    pub safe_area_top: f64, pub physical_notch_size: Option<crate::geometry::NotchSize>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowDescriptor {
    pub window_id: u32,
    pub process_id: u32,
    pub frame: Rect,
    pub app_name: Option<String>,
    pub title: Option<String>,
    pub z_order: usize,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Inventory { pub displays: Vec<DisplayDescriptor>, pub windows: Vec<WindowDescriptor> }
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionFacts {
    pub display: DisplayDescriptor,
    /// Display-local logical rectangles; the native window identity is unchanged.
    pub windows: Vec<WindowDescriptor>,
}
pub(crate) fn display_for_window_frame<'a>(displays: &'a [DisplayDescriptor], frame: &Rect) -> Option<&'a DisplayDescriptor> {
    displays.iter().filter_map(|display| {
        let width = (frame.x + frame.width).min(display.frame.x + display.frame.width * display.desktop_scale)
            - frame.x.max(display.frame.x);
        let height = (frame.y + frame.height).min(display.frame.y + display.frame.height * display.desktop_scale)
            - frame.y.max(display.frame.y);
        (width > 0. && height > 0.).then_some((display, width * height))
    }).max_by(|(_, left), (_, right)| left.total_cmp(right)).map(|(display, _)| display)
}
impl Inventory {
    pub(crate) fn window_display(&self, window: &WindowDescriptor) -> Option<&DisplayDescriptor> {
        display_for_window_frame(&self.displays, &window.frame)
    }
    pub fn from_os(displays: Vec<DisplayDescriptor>, mut windows: Vec<WindowDescriptor>, own_pid: u32) -> Self {
        windows.retain(|w| w.process_id != own_pid);
        windows.sort_by_key(|w| w.z_order);
        Self { displays, windows }
    }
    pub fn hit_test(&self, x: f64, y: f64) -> Option<&WindowDescriptor> {
        self.windows.iter().find(|w| x >= w.frame.x && x < w.frame.x+w.frame.width
            && y >= w.frame.y && y < w.frame.y+w.frame.height)
    }
    pub fn selection_facts(&self, display_id: u32) -> Result<SelectionFacts, CaptureError> {
        let display = self.displays.iter().find(|display| display.display_id == display_id)
            .ok_or(CaptureError::TargetUnavailable)?;
        let windows = self.windows.iter().filter_map(|window| {
            let frame = crate::geometry::desktop_rect_to_display_local(display.frame, display.desktop_scale, window.frame);
            if frame.x >= display.frame.width || frame.y >= display.frame.height
                || frame.x+frame.width <= 0. || frame.y+frame.height <= 0. { return None; }
            Some(WindowDescriptor { frame, ..window.clone() })
        }).collect();
        Ok(SelectionFacts { display: display.clone(), windows })
    }
    pub fn hit_test_local(&self, display_id: u32, x: f64, y: f64) -> Result<Option<WindowDescriptor>, CaptureError> {
        let display = self.displays.iter().find(|display| display.display_id == display_id)
            .ok_or(CaptureError::TargetUnavailable)?;
        let (x, y) = crate::geometry::display_local_point(display.frame, display.desktop_scale, x, y);
        Ok(self.hit_test(x, y).map(|window| WindowDescriptor {
            frame: crate::geometry::desktop_rect_to_display_local(display.frame, display.desktop_scale, window.frame),
            ..window.clone()
        }))
    }
}

#[cfg(test)]
mod display_tests {
    use super::*;
    #[test]
    fn native_window_overlap_uses_each_displays_desktop_scale() {
        let display = |id, x, scale| DisplayDescriptor { display_id: id,
            frame: Rect { x, y: 0., width: 100., height: 100. }, scale, desktop_scale: scale,
            storage_key: None, localized_name: None, safe_area_top: 0., physical_notch_size: None };
        let inventory = Inventory { displays: vec![display(1, 0., 1.), display(2, -200., 2.)], windows: vec![] };
        let window = WindowDescriptor { window_id: 7, process_id: 9,
            frame: Rect { x: -60., y: 120., width: 30., height: 40. }, app_name: None, title: None, z_order: 0 };
        assert_eq!(inventory.window_display(&window).map(|display| display.display_id), Some(2));
    }
    #[test]
    fn vertically_stacked_displays_choose_the_windows_actual_display() {
        let display = |id, y, scale| DisplayDescriptor { display_id: id,
            frame: Rect { x: 0., y, width: 100., height: 100. }, scale, desktop_scale: 1.,
            storage_key: None, localized_name: None, safe_area_top: 0., physical_notch_size: None };
        let inventory = Inventory { displays: vec![display(1, 0., 1.), display(2, 100., 2.)], windows: vec![] };
        let window = WindowDescriptor { window_id: 7, process_id: 9,
            frame: Rect { x: 10., y: 150., width: 30., height: 40. }, app_name: None, title: None, z_order: 0 };
        assert_eq!(inventory.window_display(&window).unwrap().display_id, 2);
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum CaptureTarget {
    Window { window_id: u32 },
    Display { display_id: u32 },
    Rect { display_id: u32, rect: Rect },
    Frontmost,
}

#[derive(Default)]
struct Cancellation {
    cancelled: AtomicBool,
    wake: Mutex<Option<Box<dyn Fn() + Send + Sync>>>,
}
#[derive(Clone, Default)]
pub struct CancelSignal(Arc<Cancellation>);
impl CancelSignal {
    pub fn cancel(&self) {
        self.0.cancelled.store(true, Ordering::Release);
        if let Some(wake) = self.0.wake.lock().unwrap().take() { wake(); }
    }
    pub fn is_cancelled(&self) -> bool { self.0.cancelled.load(Ordering::Acquire) }
    /// A finite native request installs one wake callback while awaiting OS completion.
    pub fn on_cancel(&self, wake: impl Fn() + Send + Sync + 'static) {
        let mut callback = self.0.wake.lock().unwrap();
        if self.is_cancelled() { wake(); } else { *callback = Some(Box::new(wake)); }
    }
    pub fn clear_wake(&self) { self.0.wake.lock().unwrap().take(); }
}

#[derive(Debug)]
pub struct RgbaFrame { pub width: u32, pub height: u32, pub rgba: Vec<u8> }
impl RgbaFrame {
    pub fn png(&self) -> Result<Vec<u8>, CaptureError> {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, self.width, self.height);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            encoder.write_header().and_then(|mut w| w.write_image_data(&self.rgba))
                .map_err(|_| CaptureError::NativeFailure)?;
        }
        Ok(bytes)
    }
}

/// These three methods are OS boundaries, not injectable internal domain decisions.
pub trait CaptureBackend: Send + Sync {
    fn discover(&self) -> Result<Inventory, CaptureError>;
    fn foreground(&self) -> Result<Inventory, CaptureError> { Err(CaptureError::UnsupportedTarget) }
    fn discover_target(&self, target: &CaptureTarget) -> Result<Inventory, CaptureError> {
        match target { CaptureTarget::Frontmost => self.foreground(), _ => self.discover() }
    }
    fn capture_display(&self, display_id: u32, cancel: &CancelSignal) -> Result<RgbaFrame, CaptureError>;
    fn capture_window(&self, window_id: u32, _include_shadow: bool, cancel: &CancelSignal) -> Result<RgbaFrame, CaptureError>;
    fn recording_format(&self) -> super::recording::Format { super::recording::Format::Mp4 }
    fn prepare_recording(&self, _inventory: &Inventory, _target: &CaptureTarget, _path: &std::path::Path,
        _timeline: Arc<Mutex<super::recording::Timeline>>,
        _failed: Arc<dyn Fn(CaptureError) + Send + Sync>) -> Result<super::recording::PreparedBackend, CaptureError> {
        Err(CaptureError::UnsupportedPlatform)
    }
}

#[derive(Debug)]
pub struct AcquiredStill {
    pub frame: RgbaFrame,
    pub scale: f64,
    pub origin: Option<CaptureOrigin>,
    pub source: Option<CaptureSource>,
}

pub fn clamp_local_rect(rect: Rect, display: &DisplayDescriptor) -> Result<Rect, CaptureError> {
    crate::geometry::clamp_display_rect(rect, display.frame).ok_or(CaptureError::InvalidSelection)
}

pub fn acquire_still(backend: &dyn CaptureBackend, inventory: &Inventory,
    target: &CaptureTarget, include_window_shadow: bool, cancel: &CancelSignal) -> Result<AcquiredStill, CaptureError> {
    if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
    let result = match target {
        CaptureTarget::Window { window_id } => {
            let w = inventory.windows.iter().find(|w| w.window_id == *window_id).ok_or(CaptureError::TargetUnavailable)?;
            let frame = backend.capture_window(*window_id, include_window_shadow, cancel)?;
            let display = inventory.window_display(w);
            let scale = display.map_or_else(|| frame.width as f64 / w.frame.width, |d| d.scale);
            let origin = display.filter(|d| w.frame.x >= d.frame.x && w.frame.y >= d.frame.y
                && w.frame.x+w.frame.width <= d.frame.x+d.frame.width*d.desktop_scale
                && w.frame.y+w.frame.height <= d.frame.y+d.frame.height*d.desktop_scale)
                .map(|d| CaptureOrigin { display_id: d.display_id,
                    rect: crate::geometry::desktop_rect_to_display_local(d.frame, d.desktop_scale, w.frame) });
            AcquiredStill { frame, scale, origin, source: Some(CaptureSource { app_name: w.app_name.clone(),
                window_title: w.title.clone(), window_id: Some(w.window_id) }) }
        },
        CaptureTarget::Frontmost => {
            let w = inventory.windows.first().ok_or(CaptureError::TargetUnavailable)?;
            return acquire_still(backend, inventory, &CaptureTarget::Window { window_id: w.window_id }, include_window_shadow, cancel);
        },
        CaptureTarget::Display { display_id } | CaptureTarget::Rect { display_id, .. } => {
            let d = inventory.displays.iter().find(|d| d.display_id == *display_id).ok_or(CaptureError::TargetUnavailable)?;
            let rect = match target { CaptureTarget::Rect { rect, .. } => clamp_local_rect(*rect, d)?,
                _ => Rect { x: 0., y: 0., width: d.frame.width, height: d.frame.height } };
            let full = backend.capture_display(*display_id, cancel)?;
            let frame = match target {
                CaptureTarget::Rect { .. } => {
                    let (xs, ys) = crate::geometry::display_pixel_ranges(rect, d.scale, full.width, full.height)
                        .ok_or(CaptureError::InvalidSelection)?;
                    let mut rgba = Vec::new();
                    for y in ys.clone() {
                        let start = (y as usize*full.width as usize+xs.start as usize)*4;
                        rgba.extend_from_slice(&full.rgba[start..start+xs.len()*4]);
                    }
                    RgbaFrame { width: xs.len() as u32, height: ys.len() as u32, rgba }
                },
                _ => full,
            };
            let (start_x, start_y) = match target {
                CaptureTarget::Rect { rect, .. } => (rect.x, rect.y),
                _ => (rect.x, rect.y),
            };
            let (x, y) = crate::geometry::display_local_point(d.frame, d.desktop_scale, start_x, start_y);
            let source = inventory.hit_test(x, y).map(|w|
                CaptureSource { app_name: w.app_name.clone(), window_title: w.title.clone(), window_id: Some(w.window_id) });
            AcquiredStill { frame, scale: d.scale, origin: Some(CaptureOrigin { display_id: *display_id, rect }), source }
        },
    };
    if cancel.is_cancelled() { Err(CaptureError::Cancelled) } else { Ok(result) }
}
