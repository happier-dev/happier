//! GDK owns display/monitor signals on the GTK thread. No capture facts live here.
use super::{notify, DisplayChange, Subscriptions};
use gtk::{gdk::{Display, Monitor}, glib::SignalHandlerId, prelude::*};
use std::{cell::RefCell, rc::Rc};
use tauri::{AppHandle,Runtime};

struct MonitorConnection(Monitor, Option<SignalHandlerId>);
impl Drop for MonitorConnection {
    fn drop(&mut self) {
        if let Some(handler) = self.1.take() { self.0.disconnect(handler); }
    }
}

struct DisplayConnection {
    display: Display,
    handlers: Vec<SignalHandlerId>,
    _monitors: Rc<RefCell<Subscriptions<Monitor, MonitorConnection>>>,
}
impl Drop for DisplayConnection {
    fn drop(&mut self) {
        for handler in self.handlers.drain(..) { self.display.disconnect(handler); }
    }
}

thread_local! {
    // GTK resources are !Send and must be disconnected on their owning thread.
    // This is one native subscription lifetime, not a monitor-facts cache.
    static CONNECTION: RefCell<Option<DisplayConnection>> = const { RefCell::new(None) };
}

fn connect_monitor<R:Runtime>(monitor: &Monitor, app: &AppHandle<R>) -> MonitorConnection {
    let app = app.clone();
    let handler = monitor.connect_notify_local(None, move |_, property| {
        if matches!(property.name(), "geometry" | "scale-factor") { notify(&app, DisplayChange::Topology); }
    });
    MonitorConnection(monitor.clone(), Some(handler))
}

fn install<R:Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    CONNECTION.with(|connection| {
        if connection.borrow().is_some() { return Ok(()); }
        let display = Display::default().ok_or("Capture display connection unavailable")?;
        let monitors = Rc::new(RefCell::new(Subscriptions(Vec::new())));
        for index in 0..display.n_monitors() {
            if let Some(monitor) = display.monitor(index) {
                monitors.borrow_mut().attach(monitor, |monitor| connect_monitor(monitor, app));
            }
        }
        let weak = Rc::downgrade(&monitors);
        let added_app = app.clone();
        let added = display.connect_monitor_added(move |_, monitor| {
            if let Some(monitors) = weak.upgrade() {
                monitors.borrow_mut().attach(monitor.clone(), |monitor| connect_monitor(monitor, &added_app));
            }
            notify(&added_app, DisplayChange::Topology);
        });
        let weak = Rc::downgrade(&monitors);
        let removed_app = app.clone();
        let removed = display.connect_monitor_removed(move |_, monitor| {
            if let Some(monitors) = weak.upgrade() { monitors.borrow_mut().detach(monitor); }
            notify(&removed_app, DisplayChange::Topology);
        });
        let closed = display.connect_closed(|_, _| {
            CONNECTION.with(|connection| { connection.borrow_mut().take(); });
        });
        *connection.borrow_mut() = Some(DisplayConnection { display, handlers: vec![added, removed, closed], _monitors: monitors });
        Ok(())
    })
}

/// Subscribe on the GTK thread so topology changes reach capture and the overlay.
pub(in crate::activity_overlay) fn watch<R:Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    if gtk::is_initialized_main_thread() { return install(app); }
    let (tx, rx) = std::sync::mpsc::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || { let _ = tx.send(install(&handle)); }).map_err(|error| error.to_string())?;
    rx.recv().map_err(|_| "Capture display subscription did not return".to_string())?
}
