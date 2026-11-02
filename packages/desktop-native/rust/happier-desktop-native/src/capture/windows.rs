//! Windows Graphics Capture stills; metadata stays in native desktop pixels.
use super::*;
use std::sync::{mpsc, Mutex};
use ::windows::{core::BOOL, Win32::{Foundation::{HWND, LPARAM}, Graphics::Gdi::{GetMonitorInfoW, HMONITOR, MONITORINFO},
    UI::{HiDpi::{AreDpiAwarenessContextsEqual, GetThreadDpiAwarenessContext,
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2}, WindowsAndMessaging::{IsIconic,
        EnumWindows, GetWindowDisplayAffinity, GetWindowThreadProcessId, SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE, WINDOW_DISPLAY_AFFINITY}}}};
use windows_capture::{capture::{Context, GraphicsCaptureApiHandler}, frame::Frame,
    graphics_capture_api::InternalCaptureControl, monitor::Monitor, window::Window,
    settings::{ColorFormat, CursorCaptureSettings, DirtyRegionSettings, DrawBorderSettings,
        GraphicsCaptureItemType, MinimumUpdateIntervalSettings, SecondaryWindowSettings, Settings}};

pub struct WindowsCaptureBackend {
    monitors: Mutex<Vec<(u32, Monitor)>>,
    display_scales: Vec<(Rect, f64)>,
}
impl WindowsCaptureBackend {
    pub fn new(display_scales: Vec<(Rect, f64)>) -> Result<Self, CaptureError> {
        // Tauri owns the process awareness mode. Reject an incompatible mode;
        // never install another manifest or change it beneath existing windows.
        if !unsafe { AreDpiAwarenessContextsEqual(GetThreadDpiAwarenessContext(),
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2) }.as_bool() {
            return Err(CaptureError::UnsupportedPlatform);
        }
        Ok(Self { monitors: Mutex::new(Vec::new()), display_scales })
    }
    fn display(&self, monitor: Monitor) -> Result<DisplayDescriptor, CaptureError> {
        let id = monitor.index().map_err(|_| CaptureError::TargetUnavailable)? as u32;
        let native = HMONITOR(monitor.as_raw_hmonitor());
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        if !unsafe { GetMonitorInfoW(native, &mut info) }.as_bool() { return Err(CaptureError::TargetUnavailable); }
        let native_frame = Rect { x: info.rcMonitor.left as f64, y: info.rcMonitor.top as f64,
            width: (info.rcMonitor.right-info.rcMonitor.left) as f64,
            height: (info.rcMonitor.bottom-info.rcMonitor.top) as f64 };
        let scale = self.display_scales.iter().find(|(frame, _)| *frame == native_frame)
            .map(|(_, scale)| *scale).ok_or(CaptureError::TargetUnavailable)?;
        let mut monitors = self.monitors.lock().unwrap();
        if !monitors.iter().any(|(current, _)| *current == id) { monitors.push((id, monitor)); }
        Ok(DisplayDescriptor { display_id: id,
            frame: Rect { width: native_frame.width/scale, height: native_frame.height/scale, ..native_frame },
            scale, desktop_scale: scale, storage_key: None, localized_name: monitor.name().ok(),
            safe_area_top: 0., physical_notch_size: None })
    }
    fn window(&self, window: Window, z_order: usize) -> Result<WindowDescriptor, CaptureError> {
        let pid = window.process_id().map_err(|_| CaptureError::TargetUnavailable)?;
        if pid == std::process::id() || !window.is_valid()
            || unsafe { IsIconic(HWND(window.as_raw_hwnd())) }.as_bool() { return Err(CaptureError::TargetUnavailable); }
        let frame = window.rect().map_err(|_| CaptureError::TargetUnavailable)?;
        Ok(WindowDescriptor { window_id: window.as_raw_hwnd() as usize as u32, process_id: pid,
            frame: Rect { x: frame.left as f64, y: frame.top as f64,
                width: (frame.right-frame.left) as f64, height: (frame.bottom-frame.top) as f64 },
            app_name: window.process_name().ok(), title: window.title().ok(), z_order })
    }
    fn chosen_window(&self, window: Window) -> Result<Inventory, CaptureError> {
        let descriptor = self.window(window, 0)?;
        let displays = window.monitor().map(|monitor| self.display(monitor)).transpose()?.into_iter().collect();
        Ok(Inventory { displays, windows: vec![descriptor] })
    }
    fn frame<T: TryInto<GraphicsCaptureItemType> + Send + 'static>(&self, target: T, cancel: &CancelSignal) -> Result<RgbaFrame, CaptureError> {
        if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
        let _exclusion = OwnWindowExclusion::apply()?;
        let (tx, rx) = mpsc::channel();
        let settings = Settings::new(target, CursorCaptureSettings::WithoutCursor, DrawBorderSettings::WithoutBorder,
            SecondaryWindowSettings::Exclude, MinimumUpdateIntervalSettings::Default,
            DirtyRegionSettings::Default, ColorFormat::Rgba8, tx.clone());
        let control = FirstFrame::start_free_threaded(settings).map_err(|_| CaptureError::NativeFailure)?;
        cancel.on_cancel(move || { let _ = tx.send(Err(CaptureError::Cancelled)); });
        let result = rx.recv().map_err(|_| CaptureError::NativeFailure).and_then(|result| result);
        cancel.clear_wake();
        let stopped = control.stop().map_err(|_| CaptureError::NativeFailure);
        if cancel.is_cancelled() { return Err(CaptureError::Cancelled); }
        stopped?;
        result
    }
}
pub(crate) struct OwnWindowExclusion(Vec<(HWND, u32)>);
// Display-affinity APIs accept process HWNDs from any thread; ownership only
// restores their previous affinity after the joined WGC stream has stopped.
unsafe impl Send for OwnWindowExclusion {}
impl OwnWindowExclusion {
    pub(crate) fn apply() -> Result<Self, CaptureError> {
        unsafe extern "system" fn collect(window: HWND, pointer: LPARAM) -> BOOL {
            let mut pid = 0;
            unsafe { GetWindowThreadProcessId(window, Some(&mut pid)); }
            if pid == std::process::id() {
                unsafe { &mut *(pointer.0 as *mut Vec<HWND>) }.push(window);
            }
            BOOL(1)
        }
        let mut windows = Vec::<HWND>::new();
        unsafe { EnumWindows(Some(collect), LPARAM((&mut windows as *mut Vec<HWND>) as isize)) }
            .map_err(|_| CaptureError::NativeFailure)?;
        let mut exclusion = Self(Vec::new());
        for window in windows {
            let mut previous = 0;
            unsafe { GetWindowDisplayAffinity(window, &mut previous) }.map_err(|_| CaptureError::NativeFailure)?;
            unsafe { SetWindowDisplayAffinity(window, WDA_EXCLUDEFROMCAPTURE) }.map_err(|_| CaptureError::NativeFailure)?;
            exclusion.0.push((window, previous));
        }
        Ok(exclusion)
    }
}
impl Drop for OwnWindowExclusion {
    fn drop(&mut self) {
        for (window, previous) in &self.0 { let _ = unsafe { SetWindowDisplayAffinity(*window, WINDOW_DISPLAY_AFFINITY(*previous)) }; }
    }
}
impl CaptureBackend for WindowsCaptureBackend {
    fn prepare_recording(&self, inventory: &Inventory, target: &CaptureTarget, path: &std::path::Path,
        timeline: std::sync::Arc<std::sync::Mutex<super::recording::Timeline>>,
        failed: std::sync::Arc<dyn Fn(CaptureError) + Send + Sync>) -> Result<super::recording::PreparedBackend, CaptureError> {
        super::recording::windows::prepare(inventory, target, path, timeline, failed)
    }
    fn discover(&self) -> Result<Inventory, CaptureError> {
        let displays = Monitor::enumerate().map_err(|_| CaptureError::NativeFailure)?.into_iter()
            .map(|monitor| self.display(monitor)).collect::<Result<Vec<_>, _>>()?;
        // EnumWindows supplies the native top-to-bottom stacking order.
        let windows = Window::enumerate().map_err(|_| CaptureError::NativeFailure)?.into_iter()
            .enumerate().filter_map(|(z, window)| self.window(window, z).ok()).collect();
        Ok(Inventory::from_os(displays, windows, std::process::id()))
    }
    fn foreground(&self) -> Result<Inventory, CaptureError> {
        self.chosen_window(Window::foreground().map_err(|_| CaptureError::TargetUnavailable)?)
    }
    fn discover_target(&self, target: &CaptureTarget) -> Result<Inventory, CaptureError> {
        match target {
            CaptureTarget::Frontmost => self.foreground(),
            CaptureTarget::Window { window_id } => self.chosen_window(Window::from_raw_hwnd(*window_id as usize as *mut _)),
            CaptureTarget::Display { display_id } | CaptureTarget::Rect { display_id, .. } => {
                let monitor = Monitor::enumerate().map_err(|_| CaptureError::NativeFailure)?.into_iter()
                    .find(|monitor| monitor.index().ok() == Some(*display_id as usize)).ok_or(CaptureError::TargetUnavailable)?;
                Ok(Inventory { displays: vec![self.display(monitor)?], windows: vec![] })
            },
        }
    }
    fn capture_display(&self, id: u32, cancel: &CancelSignal) -> Result<RgbaFrame, CaptureError> {
        let monitor = self.monitors.lock().unwrap().iter().find(|(current, _)| *current == id)
            .map(|(_, monitor)| *monitor).ok_or(CaptureError::TargetUnavailable)?;
        self.frame(monitor, cancel)
    }
    fn capture_window(&self, id: u32, _include_shadow: bool, cancel: &CancelSignal) -> Result<RgbaFrame, CaptureError> {
        let window = Window::from_raw_hwnd(id as usize as *mut _);
        self.frame(window, cancel)
    }
}
struct FirstFrame(mpsc::Sender<Result<RgbaFrame, CaptureError>>);
impl GraphicsCaptureApiHandler for FirstFrame {
    type Flags = mpsc::Sender<Result<RgbaFrame, CaptureError>>;
    type Error = CaptureError;
    fn new(context: Context<Self::Flags>) -> Result<Self, Self::Error> { Ok(Self(context.flags)) }
    fn on_frame_arrived(&mut self, frame: &mut Frame, control: InternalCaptureControl) -> Result<(), Self::Error> {
        let (width, height) = (frame.width(), frame.height());
        if width == 0 || height == 0 { return Ok(()); }
        let result = frame.buffer().map_err(|_| CaptureError::NativeFailure).map(|buffer| {
            let mut pixels = Vec::new();
            let rgba = buffer.as_nopadding_buffer(&mut pixels).to_vec();
            RgbaFrame { width, height, rgba }
        });
        let _ = self.0.send(result);
        control.stop();
        Ok(())
    }
    fn on_closed(&mut self) -> Result<(), Self::Error> {
        let _ = self.0.send(Err(CaptureError::TargetUnavailable)); Ok(())
    }
}
