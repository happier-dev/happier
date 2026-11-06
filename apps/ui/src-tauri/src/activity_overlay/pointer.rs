//! One native pointer-facts owner for overlay windows. Presentation stays in the renderer.
mod crossings;
#[cfg(any(target_os = "macos", test))]
pub(super) mod motion_monitors;
#[cfg(any(target_os = "windows", test))]
pub(super) mod raw_input;

use crossings::Crossings;
pub(super) use crossings::Sample;
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager, Runtime, WebviewWindow, WindowEvent};

#[cfg(target_os = "linux")]
use super::linux_pointer as platform;
#[cfg(target_os = "macos")]
use super::macos_pointer as platform;
#[cfg(target_os = "windows")]
use super::windows_pointer as platform;

#[derive(Default)]
struct Adapters(Mutex<HashMap<String, Arc<Tracker>>>);

pub(super) struct Tracker {
    crossings: Mutex<Crossings>,
    publish: Box<dyn Fn(bool, Sample) + Send + Sync>,
    press: Box<dyn Fn() + Send + Sync>,
    pub position_events: bool,
}

impl Tracker {
    pub fn is_visible(&self) -> Result<bool, String> {
        self.crossings
            .lock()
            .map(|state| state.visible)
            .map_err(|_| "Overlay pointer state poisoned".to_owned())
    }

    pub fn outside_press(&self) { (self.press)(); }
    pub fn observe(&self, sample: Sample) {
        let changed = self
            .crossings
            .lock()
            .ok()
            .and_then(|mut state| state.observe(sample));
        if let Some((crossing, sample)) = changed {
            (self.publish)(crossing, sample);
        }
    }
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct MousePayload {
    inside: bool,
    x: f64,
    y: f64,
}

#[derive(Clone, Copy, Serialize)]
struct CrossingPayload {
    kind: &'static str,
}

fn tracker<R: Runtime>(app: &AppHandle<R>, label: &str) -> Option<Arc<Tracker>> {
    app.try_state::<Adapters>()?
        .0
        .lock()
        .ok()?
        .get(label)
        .cloned()
}

/// Existing window labels are the lifetime identity; both pet and notch consume this path.
pub(crate) fn install<R: Runtime>(
    app: &AppHandle<R>,
    window: &WebviewWindow<R>,
    event_name: &'static str,
) -> Result<(), String> {
    app.manage(Adapters::default());
    let owner = app.state::<Adapters>();
    let (tracker, created) = {
        let mut adapters = owner
            .0
            .lock()
            .map_err(|_| "Overlay pointer state poisoned")?;
        if let Some(existing) = adapters.get(window.label()) {
            (existing.clone(), false)
        } else {
            let label = window.label().to_owned();
            let app = app.clone();
            let position_events = event_name == crate::pet_overlay::PET_OVERLAY_NATIVE_MOUSE_EVENT;
            let press_app = app.clone();
            let press_label = label.clone();
            let tracker = Arc::new(Tracker {
                crossings: Mutex::new(Crossings::default()),
                position_events,
                press: Box::new(move || {
                    if !position_events {
                        if let Err(error) = press_app.emit_to(&press_label, event_name, CrossingPayload { kind: "outsidePress" }) {
                            log::warn!("Overlay outside press delivery failed: {error}");
                        }
                    }
                }),
                publish: Box::new(move |crossing, sample| {
                    let result = if position_events {
                        app.emit_to(
                            &label,
                            event_name,
                            MousePayload {
                                inside: sample.inside,
                                x: sample.x,
                                y: sample.y,
                            },
                        )
                    } else if crossing {
                        app.emit_to(
                            &label,
                            event_name,
                            CrossingPayload {
                                kind: if sample.inside { "enter" } else { "leave" },
                            },
                        )
                    } else {
                        return;
                    };
                    if let Err(error) = result {
                        log::warn!("Overlay pointer event delivery failed: {error}");
                    }
                }),
            });
            adapters.insert(window.label().to_owned(), tracker.clone());
            (tracker, true)
        }
    };
    if created {
        let app = app.clone();
        let label = window.label().to_owned();
        window.on_window_event(move |event| match event {
            WindowEvent::Destroyed => {
                if let Some(owner) = app.try_state::<Adapters>() {
                    if let Ok(mut adapters) = owner.0.lock() {
                        adapters.remove(&label);
                    }
                }
                platform::remove(&label);
            }
            WindowEvent::Moved(_)
            | WindowEvent::Resized(_)
            | WindowEvent::ScaleFactorChanged { .. } => {
                if let Err(error) = geometry_changed(&app, &label) {
                    log::warn!("Overlay pointer geometry refresh failed: {error}");
                }
            }
            _ => {}
        });
    }
    platform::install(window, tracker)
}

pub(crate) fn set_visible<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    visible: bool,
) -> Result<(), String> {
    let Some(tracker) = tracker(app, label) else {
        return Ok(());
    };
    let changed = {
        let mut crossings = tracker
            .crossings
            .lock()
            .map_err(|_| "Overlay pointer state poisoned")?;
        if crossings.visible == visible {
            false
        } else {
            crossings.set_visible(visible);
            true
        }
    };
    if !changed {
        return Ok(());
    }
    if !visible {
        // AppKit motion monitors must release before hidden geometry refreshes stop.
        #[cfg(target_os = "macos")]
        if let Some(window) = app.get_webview_window(label) {
            platform::geometry_changed(&window, tracker)?;
        }
        set_outside_press(app, label, false)?;
        set_engaged(app, label, false)?;
    }
    if visible {
        geometry_changed(app, label)?;
    }
    Ok(())
}

pub(crate) fn set_engaged<R: Runtime>(
    app: &AppHandle<R>,
    label: &str,
    engaged: bool,
) -> Result<(), String> {
    let Some(tracker) = tracker(app, label) else {
        return Ok(());
    };
    platform::set_engaged(app, label, engaged && tracker.is_visible()?)
}

pub(crate) fn set_outside_press<R: Runtime>(app: &AppHandle<R>, label: &str, wanted: bool) -> Result<(), String> {
    platform::set_outside_press(app, label, wanted)
}

pub(crate) fn geometry_changed<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<(), String> {
    let Some(tracker) = tracker(app, label) else {
        return Ok(());
    };
    if !tracker.is_visible()? {
        return Ok(());
    }
    if let Some(window) = app.get_webview_window(label) {
        platform::geometry_changed(&window, tracker)?;
    }
    Ok(())
}

/// WebView2 reports the initial shape hit; only Windows needs this DOM boundary.
pub(crate) fn enter<R: Runtime>(app: &AppHandle<R>, label: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        set_engaged(app, label, true)?;
        geometry_changed(app, label)?;
    }
    #[cfg(not(target_os = "windows"))]
    let _ = (app, label);
    Ok(())
}
