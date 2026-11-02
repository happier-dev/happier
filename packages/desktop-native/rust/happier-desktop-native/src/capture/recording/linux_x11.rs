//! The selected X drawable's lifetime, subscribed before ximagesrc opens it.
use super::{CaptureError, PixelSize, Rect};
use std::os::fd::{AsRawFd, RawFd};
use x11rb::{connection::Connection, protocol::{Event, xproto::{ChangeWindowAttributesAux, ConnectionExt, EventMask}}, rust_connection::RustConnection};

#[path = "linux_xlib.rs"]
mod xlib;
pub(super) use xlib::{ErrorTrap, teardown};

struct Socket(RustConnection);
impl AsRawFd for Socket { fn as_raw_fd(&self) -> RawFd { self.0.stream().as_raw_fd() } }

#[derive(Clone, Copy)]
enum Target { Window(u32), Display { root: u32, id: u32, frame: Rect } }
impl Target {
    fn display_available(self, connection: &RustConnection) -> bool {
        let Self::Display { root, id, frame } = self else { return true; };
        crate::capture::linux::native_monitor_frames(connection, root).is_ok_and(|monitors|
            monitors.into_iter().any(|(current_id, current_frame)| current_id == id && current_frame == frame))
    }
    fn ended(self, event: &Event, size: PixelSize, connection: &RustConnection) -> bool {
        match (self, event) {
            (Self::Window(id), Event::DestroyNotify(event)) => event.window == id,
            (Self::Window(id), Event::ConfigureNotify(event)) => event.window == id && (u32::from(event.width) != size.width || u32::from(event.height) != size.height),
            (Self::Display { root, .. }, Event::ConfigureNotify(event)) if event.window == root => !self.display_available(connection),
            (Self::Display { .. }, Event::RandrScreenChangeNotify(_) | Event::RandrNotify(_)) => !self.display_available(connection),
            _ => false,
        }
    }
}

pub(super) struct SourceWatch {
    connection: Option<RustConnection>,
    target: Target,
    size: PixelSize,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl SourceWatch {
    pub(super) fn window(connection: RustConnection, id: u32) -> Result<Self, CaptureError> {
        connection.change_window_attributes(id, &ChangeWindowAttributesAux::new().event_mask(EventMask::STRUCTURE_NOTIFY))
            .map_err(|_| CaptureError::TargetUnavailable)?.check().map_err(|_| CaptureError::TargetUnavailable)?;
        let geometry = connection.get_geometry(id).map_err(|_| CaptureError::TargetUnavailable)?.reply().map_err(|_| CaptureError::TargetUnavailable)?;
        Ok(Self { connection: Some(connection), target: Target::Window(id),
            size: PixelSize { width: u32::from(geometry.width), height: u32::from(geometry.height) }, stop: None, worker: None })
    }
    pub(super) fn display(connection: RustConnection, screen: usize, id: u32, frame: Rect, size: PixelSize) -> Result<Self, CaptureError> {
        use x11rb::protocol::randr::{ConnectionExt as _, NotifyMask};
        let root = connection.setup().roots[screen].root;
        // RRSetMonitor/RRDeleteMonitor send core root ConfigureNotify even when
        // its pixel size stays unchanged (xserver rrmonitor.c::RRSendConfigNotify).
        connection.change_window_attributes(root, &ChangeWindowAttributesAux::new().event_mask(EventMask::STRUCTURE_NOTIFY))
            .map_err(|_| CaptureError::NativeFailure)?.check().map_err(|_| CaptureError::NativeFailure)?;
        connection.randr_select_input(root, NotifyMask::SCREEN_CHANGE | NotifyMask::CRTC_CHANGE | NotifyMask::OUTPUT_CHANGE | NotifyMask::RESOURCE_CHANGE)
            .map_err(|_| CaptureError::NativeFailure)?.check().map_err(|_| CaptureError::NativeFailure)?;
        let target = Target::Display { root, id, frame };
        if !target.display_available(&connection) { return Err(CaptureError::TargetUnavailable); }
        Ok(Self { connection: Some(connection), target, size, stop: None, worker: None })
    }
    pub(super) fn admit(&self, actual: PixelSize) -> Result<(), CaptureError> {
        let connection = self.connection.as_ref().unwrap();
        connection.get_input_focus().map_err(|_| CaptureError::TargetUnavailable)?.reply().map_err(|_| CaptureError::TargetUnavailable)?;
        while let Some(event) = connection.poll_for_event().map_err(|_| CaptureError::TargetUnavailable)? {
            if self.target.ended(&event, self.size, connection) { return Err(CaptureError::TargetUnavailable); }
        }
        if actual != self.size { return Err(CaptureError::TargetUnavailable); }
        Ok(())
    }
    pub(super) fn start(&mut self, closed: impl FnOnce() + Send + 'static) -> Result<(), CaptureError> {
        let runtime = tokio::runtime::Builder::new_current_thread().enable_io().build().map_err(|_| CaptureError::NativeFailure)?;
        let connection = self.connection.take().unwrap(); let target = self.target; let size = self.size;
        let (stop, mut stopped) = tokio::sync::oneshot::channel(); self.stop = Some(stop);
        self.worker = Some(std::thread::spawn(move || {
            let ended = runtime.block_on(async move {
                // Both native lock roots must build (Tokio 1.53 and 1.54). The
                // shared API owns this private connection until deregistration;
                // x11rb's owned stream keeps the same open fd throughout that life.
                #[allow(deprecated)]
                let Ok(socket) = tokio::io::unix::AsyncFd::with_interest(Socket(connection), tokio::io::Interest::READABLE) else { return true; };
                loop {
                    // Drain buffered X events, then sleep on the real socket and
                    // cancellation. There is no timer or per-frame X request.
                    loop {
                        match socket.get_ref().0.poll_for_event() {
                            Ok(Some(event)) if target.ended(&event, size, &socket.get_ref().0) => return true,
                            Ok(Some(_)) => {}, Ok(None) => break, Err(_) => return true,
                        }
                    }
                    tokio::select! {
                        _ = &mut stopped => return false,
                        ready = socket.readable() => match ready { Ok(mut ready) => ready.clear_ready(), Err(_) => return true },
                    }
                }
            });
            if ended { closed(); }
        }));
        Ok(())
    }
}
impl Drop for SourceWatch {
    fn drop(&mut self) {
        if let Some(stop) = self.stop.take() { let _ = stop.send(()); }
        if let Some(worker) = self.worker.take() { let _ = worker.join(); }
    }
}

pub(super) fn validate_region(connection: &RustConnection, screen: usize, x: &std::ops::RangeInclusive<u32>, y: &std::ops::RangeInclusive<u32>) -> Result<(), CaptureError> {
    // ximagesrc resets out-of-root bounds to full screen. Reject at its native
    // representation boundary rather than admitting a different source.
    let root = &connection.setup().roots[screen];
    if *x.end() >= u32::from(root.width_in_pixels) || *y.end() >= u32::from(root.height_in_pixels) { return Err(CaptureError::InvalidSelection); }
    Ok(())
}
