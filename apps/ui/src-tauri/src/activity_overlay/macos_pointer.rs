//! AppKit tracking areas continue delivering crossings while another app is active.
use super::pointer::{Sample, Tracker};
use objc2::{
    define_class, msg_send,
    rc::Retained,
    runtime::{AnyClass, AnyObject, NSObjectProtocol},
    DefinedClass, MainThreadMarker, MainThreadOnly,
};
use objc2_app_kit::{NSEvent, NSEventMask, NSView, NSWindow};
use objc2_foundation::{NSObject, NSRect};
use std::{cell::{Cell, RefCell}, collections::HashMap, sync::Arc};
use tauri::{AppHandle, Manager, Runtime, WebviewWindow};

struct TrackingIvars {
    tracker: Arc<Tracker>,
    window: Retained<NSWindow>,
    hit_rect: Cell<Option<(f64, f64, f64, f64)>>,
    motion: RefCell<Option<PressMonitors>>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "HappierOverlayPointerOwner"]
    #[ivars = TrackingIvars]
    struct PointerOwner;

    unsafe impl NSObjectProtocol for PointerOwner {}

    impl PointerOwner {
        #[unsafe(method(mouseEntered:))]
        fn mouse_entered(&self, _event: &NSEvent) { let _ = self.sample(); }
        #[unsafe(method(mouseExited:))]
        fn mouse_exited(&self, _event: &NSEvent) { let _ = self.sample(); }
        #[unsafe(method(mouseMoved:))]
        fn mouse_moved(&self, _event: &NSEvent) { let _ = self.sample(); }
    }
);

impl PointerOwner {
    fn sample(&self) -> Result<(), String> {
        let ivars = self.ivars();
        let visible = ivars.tracker.is_visible()?;
        if !visible {
            super::pointer::motion_monitors::update(&mut ivars.motion.borrow_mut(), visible, false, || self.register_motion())?;
            return Ok(());
        }
        let window = &ivars.window;
        let frame = window.frame();
        let point = unsafe { NSEvent::mouseLocation() };
        let frame = (frame.origin.x, frame.origin.y, frame.size.width, frame.size.height);
        let point = (point.x, point.y);
        let sample = if let Some(hit_rect) = ivars.hit_rect.get() {
            let sample = Sample::from_bottom_left_hit_rect(frame, hit_rect, point);
            super::pointer::motion_monitors::update(&mut ivars.motion.borrow_mut(), visible, !sample.inside && !ivars.tracker.position_events, || self.register_motion())?;
            // The drawing envelope also covers old animation frames and Extract flights.
            // Only the island receives input; global motion restores entry while ignored.
            if window.ignoresMouseEvents() == sample.inside {
                window.setIgnoresMouseEvents(!sample.inside);
            }
            sample
        } else { Sample::from_bottom_left(frame, point) };
        ivars.tracker.observe(sample);
        Ok(())
    }

    fn register_motion(&self) -> Result<PressMonitors, String> {
        // Connection removes these registrations before releasing the owner, including
        // when its native window is torn down while still ignoring mouse events.
        let owner = unsafe { Retained::retain(self as *const Self as *mut Self) }
            .expect("AppKit supplied a live pointer owner");
        let local_owner = owner.clone();
        let local = block2::RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| {
            let _ = local_owner.sample();
            event.as_ptr()
        });
        let global = block2::RcBlock::new(move |_: std::ptr::NonNull<NSEvent>| { let _ = owner.sample(); });
        let mask = NSEventMask::MouseMoved | NSEventMask::LeftMouseDragged
            | NSEventMask::RightMouseDragged | NSEventMask::OtherMouseDragged;
        let local = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &local) }
            .ok_or("Overlay local motion monitor unavailable")?;
        let Some(global) = NSEvent::addGlobalMonitorForEventsMatchingMask_handler(mask, &global) else {
            unsafe { NSEvent::removeMonitor(&local); }
            return Err("Overlay global motion monitor unavailable".to_owned());
        };
        Ok(PressMonitors { local, global })
    }
}

struct Connection {
    view: Retained<NSView>,
    area: Retained<AnyObject>,
    _owner: Retained<PointerOwner>,
    monitors: Option<PressMonitors>,
}
struct PressMonitors { local: Retained<AnyObject>, global: Retained<AnyObject> }
impl Drop for PressMonitors {
    fn drop(&mut self) {
        unsafe { NSEvent::removeMonitor(&self.local); NSEvent::removeMonitor(&self.global); }
    }
}
impl Drop for Connection {
    fn drop(&mut self) {
        self._owner.ivars().motion.borrow_mut().take();
        unsafe {
            let _: () = msg_send![&*self.view, removeTrackingArea: &*self.area];
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
            if connections.contains_key(native_window.label()) { return Ok(()); }
            let marker = MainThreadMarker::new().ok_or("Overlay tracking requires the AppKit thread")?;
            let pointer = native_window.ns_window().map_err(|error| error.to_string())?;
            let window: &NSWindow = unsafe { &*pointer.cast() };
            let view = window.contentView().ok_or("Overlay content view unavailable")?;
            let retained_window = unsafe { Retained::retain(window as *const NSWindow as *mut NSWindow) }.ok_or("Overlay native window unavailable")?;
            let owner = PointerOwner::alloc(marker).set_ivars(TrackingIvars { tracker: tracker.clone(), window: retained_window, hit_rect: Cell::new(None), motion: RefCell::new(None) });
            let owner: Retained<PointerOwner> = unsafe { msg_send![super(owner), init] };
            let class = AnyClass::get(c"NSTrackingArea").ok_or("AppKit tracking areas unavailable")?;
            // Local tracking-area moves detect leaving the island while still inside its
            // animation envelope. Pet additionally tracks moves throughout dragging.
            let options: usize = 0x01 | 0x02 | 0x80 | 0x200 | if tracker.position_events { 0x400 } else { 0 };
            let area: objc2::rc::Allocated<AnyObject> = unsafe { msg_send![class, alloc] };
            let area: Retained<AnyObject> = unsafe { msg_send![area, initWithRect: NSRect::ZERO, options: options, owner: &*owner, userInfo: std::ptr::null::<AnyObject>()] };
            // AppKit does not retain a tracking area's owner; Connection owns both.
            unsafe { let _: () = msg_send![&*view, addTrackingArea: &*area]; }
            connections.insert(native_window.label().to_owned(), Connection { view, area, _owner: owner, monitors: None });
            Ok(())
        })
        },
        "Overlay tracking registration did not return",
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
            let _ = tracker;
            CONNECTIONS.with(|connections| -> Result<(), String> {
                if let Some(connection) = connections.borrow().get(native_window.label()) {
                    connection._owner.sample()?;
                }
                Ok(())
            })
        },
        "Overlay tracking geometry did not return",
    )?
}

/// Top-left coordinates inside the drawing envelope, supplied by the native frame owner.
pub(super) fn set_hit_rect<R: Runtime>(window: &WebviewWindow<R>, rect: (f64, f64, f64, f64)) -> Result<(), String> {
    let label = window.label().to_owned();
    crate::desktop_panel::run_on_main_thread(window.app_handle(), move || {
        CONNECTIONS.with(|connections| -> Result<(), String> {
            if let Some(connection) = connections.borrow().get(&label) {
                connection._owner.ivars().hit_rect.set(Some(rect));
                connection._owner.sample()?;
            }
            Ok(())
        })
    }, "Overlay hit region update did not return")?
}

pub(super) fn set_engaged<R: Runtime>(_: &AppHandle<R>, _: &str, _: bool) -> Result<(), String> {
    Ok(())
}
pub(super) fn set_outside_press<R: Runtime>(app: &AppHandle<R>, label: &str, wanted: bool) -> Result<(), String> {
    let label = label.to_owned();
    crate::desktop_panel::run_on_main_thread(app, move || CONNECTIONS.with(|connections| {
        let mut connections = connections.borrow_mut();
        let Some(connection) = connections.get_mut(&label) else { return Ok(()); };
        if !wanted { connection.monitors = None; return Ok(()); }
        if connection.monitors.is_some() { return Ok(()); }
        let tracker = connection._owner.ivars().tracker.clone();
        let window = connection._owner.ivars().window.clone();
        let local = block2::RcBlock::new(move |event: std::ptr::NonNull<NSEvent>| {
            let event = unsafe { event.as_ref() };
            let mtm = MainThreadMarker::new().expect("AppKit local event monitor runs on the main thread");
            // AppKit's global monitor excludes this app. Local events must exclude only this panel.
            if event.window(mtm).as_deref() != Some(&*window) { tracker.outside_press(); }
            event as *const NSEvent as *mut NSEvent
        });
        let tracker = connection._owner.ivars().tracker.clone();
        let global = block2::RcBlock::new(move |_: std::ptr::NonNull<NSEvent>| { tracker.outside_press(); });
        let mask = NSEventMask::LeftMouseDown | NSEventMask::RightMouseDown;
        let local = unsafe { NSEvent::addLocalMonitorForEventsMatchingMask_handler(mask, &local) }
            .ok_or("Overlay local press monitor unavailable")?;
        let Some(global) = (unsafe { NSEvent::addGlobalMonitorForEventsMatchingMask_handler(mask, &global) }) else {
            unsafe { NSEvent::removeMonitor(&local); }
            return Err("Overlay global press monitor unavailable".to_owned());
        };
        connection.monitors = Some(PressMonitors { local, global });
        Ok(())
    }), "Overlay press registration did not return")?
}
pub(super) fn remove(label: &str) {
    CONNECTIONS.with(|connections| {
        connections.borrow_mut().remove(label);
    });
}
