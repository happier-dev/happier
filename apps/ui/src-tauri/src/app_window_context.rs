//! Transient context and derived Home responders for the canonical app-window owner.
use super::{AppWindowChrome, AppWindowRecord, AppWindowState};
use crate::desktop_window::{is_app_window, MAIN_WINDOW_LABEL};
use serde::Serialize;
use std::collections::BTreeMap;
use tauri::{AppHandle, Emitter, Manager};

pub(super) struct LiveAppWindow {
    pub(super) ready: bool,
    pub(super) opened_order: usize,
    pub(super) record: Option<AppWindowRecord>,
    pub(super) surface: Option<AppWindowSurface>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppWindowSurface {
    pub(super) window_id: String,
    pub(super) home_id: String,
    pub(super) account_id: String,
    pub(super) session_id: Option<String>,
    pub(super) methods: Vec<String>,
    pub(super) focused: bool,
}

impl AppWindowSurface {
    pub(super) fn for_main_scope(previous: Option<&Self>, home_id: String, account_id: String, focused: bool) -> Self {
        let previous = previous.filter(|surface| surface.home_id == home_id && surface.account_id == account_id);
        Self { window_id: MAIN_WINDOW_LABEL.into(), home_id, account_id,
            session_id: previous.and_then(|surface| surface.session_id.clone()),
            methods: previous.map(|surface| surface.methods.clone()).unwrap_or_default(), focused }
    }

    fn note_focus(&mut self, focused: bool) -> Option<Self> {
        if self.focused == focused { return None; }
        self.focused = focused;
        Some(self.clone())
    }

    fn retired(mut self) -> Self {
        self.focused = false;
        self.session_id = None;
        self.methods.clear();
        self
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AppWindowResponder {
    pub(super) home_id: String,
    pub(super) account_id: String,
    pub(super) window_id: String,
}

pub(super) fn home_responders(live: &BTreeMap<String, LiveAppWindow>) -> Vec<AppWindowResponder> {
    let mut responders = BTreeMap::new();
    if let Some(surface) = live
        .get(MAIN_WINDOW_LABEL)
        .and_then(|window| window.surface.as_ref())
    {
        responders.insert(
            (surface.home_id.clone(), surface.account_id.clone()),
            MAIN_WINDOW_LABEL.to_string(),
        );
    }
    let mut windows: Vec<_> = live
        .values()
        .filter(|window| {
            window
                .record
                .as_ref()
                .is_some_and(|record| record.chrome == Some(AppWindowChrome::Full))
        })
        .collect();
    windows.sort_by_key(|window| window.opened_order);
    for window in windows {
        let record = window
            .record
            .as_ref()
            .expect("full window has its admitted record");
        responders
            .entry((record.home_id.clone(), record.account_id.clone()))
            .or_insert_with(|| record.window_id.clone());
    }
    responders
        .into_iter()
        .map(|((home_id, account_id), window_id)| AppWindowResponder {
            home_id,
            account_id,
            window_id,
        })
        .collect()
}

#[cfg(desktop)]
pub(super) fn edit_live<R: tauri::Runtime>(
    app: &AppHandle<R>,
    edit: impl FnOnce(&mut BTreeMap<String, LiveAppWindow>),
) -> Result<(), String> {
    let (previous, next) = {
        let state = app.state::<AppWindowState>();
        let mut live = state.live.lock().map_err(|error| error.to_string())?;
        let previous = home_responders(&live);
        edit(&mut live);
        (previous, home_responders(&live))
    };
    if previous != next {
        for (label, _) in app.webview_windows() {
            if label == MAIN_WINDOW_LABEL || is_app_window(&label) {
                app.emit_to(label, "desktopAppWindow://responders", &next)
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

#[cfg(desktop)]
pub(crate) fn uses_full_chrome<R: tauri::Runtime>(app: &AppHandle<R>, label: &str) -> bool {
    app.state::<AppWindowState>()
        .live
        .lock()
        .ok()
        .and_then(|live| {
            live.get(label)
                .and_then(|window| window.record.as_ref())
                .map(|record| record.chrome == Some(AppWindowChrome::Full))
        })
        .unwrap_or(false)
}

#[cfg(desktop)]
pub(super) fn publish_surface<R: tauri::Runtime>(
    app: &AppHandle<R>,
    surface: &AppWindowSurface,
) -> Result<(), String> {
    for (label, _) in app.webview_windows() {
        if label == MAIN_WINDOW_LABEL || is_app_window(&label) {
            app.emit_to(label, "desktopAppWindow://surface", surface)
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(desktop)]
pub(super) fn set_surface(
    app: &AppHandle,
    label: &str,
    surface: Option<AppWindowSurface>,
) -> Result<(), String> {
    let mut changed = None;
    edit_live(app, |live| {
        let entry = live.entry(label.into()).or_insert_with(|| LiveAppWindow {
            ready: true,
            opened_order: 0,
            record: None,
            surface: None,
        });
        if entry.surface != surface {
            changed = surface.clone().or_else(|| {
                entry.surface.clone().map(AppWindowSurface::retired)
            });
            entry.surface = surface;
        }
    })?;
    if let Some(surface) = changed {
        publish_surface(app, &surface)?;
    }
    Ok(())
}

#[cfg(desktop)]
pub(crate) fn note_window_focus<R: tauri::Runtime>(app: &AppHandle<R>, label: &str, focused: bool) {
    let changed = app
        .state::<AppWindowState>()
        .live
        .lock()
        .ok()
        .and_then(|mut live| {
            let surface = live.get_mut(label)?.surface.as_mut()?;
            surface.note_focus(focused)
        });
    if let Some(surface) = changed {
        if let Err(error) = publish_surface(app, &surface) {
            log::warn!("failed to publish app-window focus: {error}");
        }
    }
}

#[cfg(desktop)]
pub(crate) fn retire_live_window<R: tauri::Runtime>(app: &AppHandle<R>, label: &str) {
    let mut retired = None;
    if let Err(error) = edit_live(app, |live| {
        retired = live
            .remove(label)
            .and_then(|window| window.surface)
            .map(AppWindowSurface::retired);
    }) {
        log::warn!("failed to retire live app window: {error}");
    }
    if let Some(surface) = retired {
        if let Err(error) = publish_surface(app, &surface) {
            log::warn!("failed to retire app-window surface: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mounted_methods_projection_survives_responder_focus_and_retires_with_surface() {
        let mut surface = AppWindowSurface::for_main_scope(None, "home-a".into(), "account-a".into(), true);
        surface.session_id = Some("session-a".into());
        surface.methods = vec!["session-a:mountedWorkRead".into(), "session-a:workflowDraft".into()];
        let mut responder = AppWindowSurface::for_main_scope(Some(&surface), "home-a".into(), "account-a".into(), true);
        assert_eq!(responder.methods, surface.methods, "responder refresh must retain committed method membership in the same Home/Account");
        assert_eq!(responder.session_id, surface.session_id);
        let blurred = responder.note_focus(false).unwrap();
        assert_eq!(blurred.methods, surface.methods, "native focus cannot withdraw mounted methods");
        assert!(responder.note_focus(false).is_none(), "unchanged focus emits no projection");
        let retired = blurred.clone().retired();
        assert_eq!(serde_json::to_value(blurred).unwrap()["methods"], serde_json::json!(surface.methods));
        assert_eq!(serde_json::to_value(retired).unwrap()["methods"], serde_json::json!([]), "surface retirement withdraws all methods");
        for (home, account) in [("home-b", "account-a"), ("home-a", "account-b")] {
            let changed_scope = AppWindowSurface::for_main_scope(Some(&surface), home.into(), account.into(), true);
            assert!(changed_scope.methods.is_empty(), "another Home/Account cannot inherit mounted methods");
            assert!(changed_scope.session_id.is_none());
        }
    }
}
