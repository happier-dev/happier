//! GDK enter/leave and pet motion signals; no pointer watchdog or idle source.
use super::pointer::{Sample, Tracker};
use gtk::{
    gdk::{EventMask, NotifyType},
    glib::{Propagation, SignalHandlerId},
    prelude::*,
};
use std::{cell::RefCell, collections::HashMap, rc::Rc, sync::Arc};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

struct Connection {
    window: gtk::ApplicationWindow,
    handlers: Vec<SignalHandlerId>,
    press: Option<PressMonitor>,
    tracker: Arc<Tracker>,
}
struct PressMonitor(Rc<RefCell<Option<gtk::glib::SourceId>>>);
impl Drop for PressMonitor {
    fn drop(&mut self) {
        if let Some(source) = self.0.borrow_mut().take() { source.remove(); }
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        for handler in self.handlers.drain(..) {
            self.window.disconnect(handler);
        }
    }
}
thread_local! { static CONNECTIONS: RefCell<HashMap<String, Connection>> = RefCell::new(HashMap::new()); }

pub(super) fn install<R: Runtime>(
    window: &WebviewWindow<R>,
    tracker: Arc<Tracker>,
) -> Result<(), String> {
    let native_window = window.clone();
    crate::desktop_panel::run_on_main_thread(
        window.app_handle(),
        move || {
            CONNECTIONS.with(|connections| {
                let mut connections = connections.borrow_mut();
                if connections.contains_key(native_window.label()) {
                    return Ok(());
                }
                let window = native_window
                    .gtk_window()
                    .map_err(|error| error.to_string())?;
                window.add_events(
                    EventMask::ENTER_NOTIFY_MASK
                        | EventMask::LEAVE_NOTIFY_MASK
                        | if tracker.position_events {
                            EventMask::POINTER_MOTION_MASK
                        } else {
                            EventMask::empty()
                        },
                );
                let enter_tracker = tracker.clone();
                let enter = window.connect_enter_notify_event(move |_, event| {
                    if event.detail() != NotifyType::Inferior {
                        let (x, y) = event.position();
                        enter_tracker.observe(Sample { inside: true, x, y });
                    }
                    Propagation::Proceed
                });
                let leave_tracker = tracker.clone();
                let leave = window.connect_leave_notify_event(move |_, event| {
                    if event.detail() != NotifyType::Inferior {
                        leave_tracker.observe(Sample {
                            inside: false,
                            x: 0.0,
                            y: 0.0,
                        });
                    }
                    Propagation::Proceed
                });
                let mut handlers = vec![enter, leave];
                let outside_tracker = tracker.clone();
                if tracker.position_events {
                    handlers.push(window.connect_motion_notify_event(move |_, event| {
                        let (x, y) = event.position();
                        tracker.observe(Sample { inside: true, x, y });
                        Propagation::Proceed
                    }));
                }
                connections.insert(
                    native_window.label().to_owned(),
                    Connection { window, handlers, press: None, tracker: outside_tracker },
                );
                Ok(())
            })
        },
        "Overlay pointer registration did not return",
    )?
}

pub(super) fn geometry_changed<R: Runtime>(
    window: &WebviewWindow<R>,
    tracker: Arc<Tracker>,
) -> Result<(), String> {
    let native_window = window.clone();
    crate::desktop_panel::run_on_main_thread(
        window.app_handle(),
        move || {
            let window = native_window
                .gtk_window()
                .map_err(|error| error.to_string())?;
            if let Some(surface) = window.window() {
                if let Some(pointer) = surface
                    .display()
                    .default_seat()
                    .and_then(|seat| seat.pointer())
                {
                    let (_, x, y, _) = surface.device_position(&pointer);
                    let inside = x >= 0
                        && y >= 0
                        && x < window.allocated_width()
                        && y < window.allocated_height();
                    tracker.observe(Sample {
                        inside,
                        x: if inside { x as f64 } else { 0.0 },
                        y: if inside { y as f64 } else { 0.0 },
                    });
                }
            }
            Ok(())
        },
        "Overlay pointer geometry did not return",
    )?
}

pub(super) fn set_engaged<R: Runtime>(_: &AppHandle<R>, _: &str, _: bool) -> Result<(), String> {
    Ok(())
}

pub(super) fn set_outside_press<R: Runtime>(app: &AppHandle<R>, label: &str, wanted: bool) -> Result<(), String> {
    use gtk::glib::{source::unix_fd_add_local, ControlFlow, IOCondition, translate::ToGlibPtr};
    let label = label.to_owned();
    crate::desktop_panel::run_on_main_thread(app, move || CONNECTIONS.with(|connections| {
        let mut connections = connections.borrow_mut();
        let Some(connection) = connections.get_mut(&label) else { return Ok(()); };
        if !wanted { connection.press = None; return Ok(()); }
        if connection.press.is_some() || connection.window.display().type_().name() != "GdkX11Display" { return Ok(()); }
        let surface = connection.window.window().ok_or("Overlay X11 window is not realized")?;
        // GDK owns the native identity; acquire its X11 symbol only on an X11 display.
        let xid = unsafe {
            let library = libloading::Library::new("libgdk-3.so.0").map_err(|error| error.to_string())?;
            let get: libloading::Symbol<unsafe extern "C" fn(*mut gtk::gdk::ffi::GdkWindow) -> std::os::raw::c_ulong> =
                library.get(b"gdk_x11_window_get_xid\0").map_err(|error| error.to_string())?;
            get(surface.to_glib_none().0) as u32
        };
        let monitor = happier_desktop_native::pointer::X11OutsidePress::new(xid)?;
        let owner = Rc::new(RefCell::new(None));
        let callback_owner = owner.clone();
        let tracker = connection.tracker.clone();
        let source = unix_fd_add_local(monitor.fd(), IOCondition::IN | IOCondition::ERR | IOCondition::HUP, move |_, condition| {
            let result = if condition.intersects(IOCondition::ERR | IOCondition::HUP) {
                Err("X11 outside-press connection closed".to_owned())
            } else { monitor.drain(|| tracker.outside_press()) };
            match result {
                Ok(()) => ControlFlow::Continue,
                Err(error) => {
                    log::warn!("Overlay outside press unavailable: {error}");
                    callback_owner.borrow_mut().take();
                    ControlFlow::Break
                }
            }
        });
        *owner.borrow_mut() = Some(source);
        connection.press = Some(PressMonitor(owner));
        Ok(())
    }), "Overlay outside-press registration did not return")?
}
pub(super) fn remove(label: &str) {
    CONNECTIONS.with(|connections| {
        connections.borrow_mut().remove(label);
    });
}
