//! App-window lifetime and its small device-local restore reference.
//! Tab membership, draft state and presentation placement belong to the existing UI layouts.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, fs, sync::Mutex};
#[cfg(desktop)]
use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};

use crate::desktop_window::{is_app_window, MAIN_WINDOW_LABEL};
#[cfg(desktop)]
use crate::window_sizing::WindowFrame;

pub(crate) const LIFECYCLE_EVENT: &str = "desktopAppWindow://lifecycle";

#[path = "app_window_context.rs"]
mod context;
use context::{edit_live, home_responders, set_surface, AppWindowResponder, AppWindowSurface, LiveAppWindow};
pub(crate) use context::{note_window_focus, retire_live_window, uses_full_chrome};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SelectedAddress {
    Home,
    Session {
        #[serde(rename = "sessionId")]
        session_id: String,
        // The Protocol ingress validates this reference; native persistence preserves it opaquely.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        destination: Option<serde_json::Value>,
    },
    WorkspaceTab {
        #[serde(rename = "tabId")]
        tab_id: String,
    },
    Destination {
        // The catalog owner admits this reference; native stores no launch input or draft.
        target: serde_json::Value,
    },
    PaneTab {
        #[serde(rename = "layoutId")]
        layout_id: String,
        #[serde(rename = "scopeId")]
        scope_id: String,
        #[serde(rename = "resourceId")]
        #[serde(default, skip_serializing_if = "Option::is_none")]
        resource_id: Option<String>,
        #[serde(rename = "tabKey")]
        tab_key: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AppWindowChrome {
    Full,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AppWindowRecord {
    pub window_id: String,
    pub account_id: String,
    pub home_id: String,
    pub layout_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chrome: Option<AppWindowChrome>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_layout_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_tab_id: Option<String>,
    pub selected_address: SelectedAddress,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HomeAccountCredentialScope {
    server_id: String,
    account_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HomeCredentialContext {
    server_id: String,
    account_id: Option<String>,
}

fn matches_home_credential_context(record: &AppWindowRecord, server_id: &str, account_id: Option<&str>) -> bool {
    record.home_id == server_id && match account_id {
        Some(account_id) => record.account_id == account_id,
        // No authentication is inferred: the full realm resolves credentials and renders Connect.
        None => record.chrome == Some(AppWindowChrome::Full),
    }
}

fn records_in_credential_scopes(records: impl IntoIterator<Item = AppWindowRecord>, scopes: &[HomeAccountCredentialScope]) -> Vec<AppWindowRecord> {
    records.into_iter().filter(|record| scopes.iter().any(|scope|
        matches_home_credential_context(record, &scope.server_id, Some(&scope.account_id)))).collect()
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HomeCredentialMutationKind { CredentialsSet, CredentialsRemoved }

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HomeCredentialMutationNotice {
    kind: HomeCredentialMutationKind,
    server_id: String,
    server_url: String,
}

fn records_on_forgotten_homes(records: impl IntoIterator<Item = AppWindowRecord>, mutations: &[HomeCredentialMutationNotice]) -> Vec<AppWindowRecord> {
    records.into_iter().filter(|record| mutations.iter().any(|mutation|
        mutation.kind == HomeCredentialMutationKind::CredentialsRemoved && record.home_id == mutation.server_id)).collect()
}

#[derive(Default)]
pub struct AppWindowState {
    live: Mutex<BTreeMap<String, LiveAppWindow>>,
    // Disk operations are serialized at this owner; no retained second tab/placement projection.
    persistence: Mutex<()>,
}

fn route_for_record(record: &AppWindowRecord) -> &'static str {
    match record.chrome {
        Some(AppWindowChrome::Full) => "/desktop/app-window",
        None => "/desktop/window",
    }
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_app_window_surface(
    app: AppHandle,
    caller_window: WebviewWindow,
    home_id: String,
    account_id: String,
    session_id: Option<String>,
    methods: Option<Vec<String>>,
) -> Result<(), String> {
    let label = caller_window.label();
    let window_id = if label == MAIN_WINDOW_LABEL { MAIN_WINDOW_LABEL } else {
        label.strip_prefix("destination_").filter(|_| is_app_window(label)).ok_or("desktop_app_window_caller_refused")?
    };
    let surface = AppWindowSurface {
        window_id: window_id.into(), home_id, account_id, session_id, methods: methods.unwrap_or_default(),
        focused: caller_window.is_focused().map_err(|error| error.to_string())?,
    };
    set_surface(&app, label, Some(surface))
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_app_window_surfaces(app: AppHandle) -> Result<Vec<AppWindowSurface>, String> {
    Ok(app.state::<AppWindowState>().live.lock().map_err(|error| error.to_string())?
        .values().filter_map(|window| window.surface.clone()).collect())
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_app_window_responders(
    app: AppHandle,
    caller_window: WebviewWindow,
    home_id: Option<String>,
    account_id: Option<String>,
) -> Result<Vec<AppWindowResponder>, String> {
    if caller_window.label() == MAIN_WINDOW_LABEL {
        let surface = match (home_id, account_id) {
            (Some(home_id), Some(account_id)) => {
                let state = app.state::<AppWindowState>();
                let live = state.live.lock().map_err(|error| error.to_string())?;
                Some(AppWindowSurface::for_main_scope(
                    live.get(MAIN_WINDOW_LABEL).and_then(|window| window.surface.as_ref()),
                    home_id, account_id, caller_window.is_focused().map_err(|error| error.to_string())?,
                ))
            }
            _ => None,
        };
        set_surface(&app, MAIN_WINDOW_LABEL, surface)?;
    }
    let state = app.state::<AppWindowState>();
    let live = state.live.lock().map_err(|error| error.to_string())?;
    Ok(home_responders(&live))
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppWindowLifecycle {
    kind: &'static str,
    window_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    focused: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppWindowOpenResult {
    window_id: String,
    window_label: String,
    ready: bool,
    reused: bool,
}

fn readiness_after_record_update(
    ready: bool,
    previous: Option<&AppWindowRecord>,
    next: &AppWindowRecord,
) -> bool {
    ready
        && previous.is_some_and(|previous| {
            previous.account_id == next.account_id
                && previous.home_id == next.home_id
                && previous.selected_address == next.selected_address
        })
}

fn label_for_id(id: &str) -> Result<String, String> {
    let label = format!("destination_{id}");
    if !is_app_window(&label) {
        return Err("desktop_app_window_id_invalid".into());
    }
    Ok(label)
}

#[cfg(desktop)]
fn records_path(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .resolve(
            "window-state/app-windows.json",
            tauri::path::BaseDirectory::AppConfig,
        )
        .map_err(|error| error.to_string())
}

#[cfg(desktop)]
fn read_records(app: &AppHandle) -> Result<BTreeMap<String, AppWindowRecord>, String> {
    let state = app.state::<AppWindowState>();
    let _guard = state
        .persistence
        .lock()
        .map_err(|error| error.to_string())?;
    read_records_from_disk(app)
}

#[cfg(desktop)]
fn read_records_from_disk(app: &AppHandle) -> Result<BTreeMap<String, AppWindowRecord>, String> {
    match fs::read(records_path(app)?) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|error| error.to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(desktop)]
fn edit_records(
    app: &AppHandle,
    edit: impl FnOnce(&mut BTreeMap<String, AppWindowRecord>),
) -> Result<(bool, BTreeMap<String, AppWindowRecord>), String> {
    let state = app.state::<AppWindowState>();
    let _guard = state
        .persistence
        .lock()
        .map_err(|error| error.to_string())?;
    let mut records = read_records_from_disk(app)?;
    let previous = records.clone();
    edit(&mut records);
    if records == previous {
        return Ok((false, records));
    }
    let path = records_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(
        path,
        serde_json::to_vec(&records).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    Ok((true, records))
}

#[cfg(desktop)]
fn active_records(
    app: &AppHandle,
    records: BTreeMap<String, AppWindowRecord>,
) -> Vec<AppWindowRecord> {
    records
        .into_values()
        .filter(|record| {
            label_for_id(&record.window_id)
                .ok()
                .is_some_and(|label| app.get_webview_window(&label).is_some())
        })
        .collect()
}

#[cfg(desktop)]
fn publish_active_records(
    app: &AppHandle,
    records: BTreeMap<String, AppWindowRecord>,
) -> Result<(), String> {
    let records = active_records(app, records);
    for (label, _) in app.webview_windows() {
        if label == MAIN_WINDOW_LABEL || is_app_window(&label) {
            app.emit_to(label, "desktopAppWindow://records", &records)
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(desktop)]
fn lifecycle(
    app: &AppHandle,
    id: &str,
    kind: &'static str,
    focused: Option<bool>,
) -> Result<(), String> {
    app.emit_to(
        MAIN_WINDOW_LABEL,
        LIFECYCLE_EVENT,
        AppWindowLifecycle {
            kind,
            window_id: id.into(),
            focused,
            error: None,
        },
    )
    .map_err(|error| error.to_string())
}

#[cfg(desktop)]
pub(crate) fn request_return(app: &AppHandle, label: &str) -> Result<(), String> {
    let id = label
        .strip_prefix("destination_")
        .ok_or("desktop_app_window_id_invalid")?;
    lifecycle(app, id, "return", None)
}

#[cfg(desktop)]
fn reveal(window: &WebviewWindow) -> Result<(), String> {
    crate::window_sizing::recover_app_window_frame(window)?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    crate::window_sizing::note_presented_work_window(window);
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_app_window_open(
    app: AppHandle,
    record: AppWindowRecord,
    frame: Option<WindowFrame>,
) -> Result<AppWindowOpenResult, String> {
    let label = label_for_id(&record.window_id)?;
    let state = app.state::<AppWindowState>();
    if let Some(window) = app.get_webview_window(&label) {
        desktop_app_window_update(app.clone(), record.clone())?;
        let ready = state
            .live
            .lock()
            .map_err(|error| error.to_string())?
            .get(&label)
            .map(|window| window.ready)
            .unwrap_or(false);
        if ready {
            reveal(&window)?;
        }
        return Ok(AppWindowOpenResult {
            window_id: record.window_id,
            window_label: label,
            ready,
            reused: true,
        });
    }
    // Boot context comes from the opaque native label and its local record.
    let route = route_for_record(&record);
    let builder = if record.chrome == Some(AppWindowChrome::Full) {
        let mut config = app.config().app.windows.iter()
            .find(|window| window.label == MAIN_WINDOW_LABEL).cloned()
            .ok_or("desktop_app_window_main_config_missing")?;
        config.label = label.clone();
        config.url = WebviewUrl::App(route.into());
        WebviewWindowBuilder::from_config(&app, &config).map_err(|error| error.to_string())?
    } else {
        WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(route.into()))
            .decorations(false)
            .inner_size(480., 640.)
    };
    let previous_record = read_records(&app)?.remove(&record.window_id);
    let (_, opened_records) = edit_records(&app, |records| {
        records.insert(record.window_id.clone(), record.clone());
    })?;
    let created = builder
        .title("Happier")
        .resizable(true)
        .transparent(cfg!(any(target_os = "macos", target_os = "windows")))
        .visible(false)
        .focused(false)
        .build()
        .map_err(|error| error.to_string())
        .and_then(|window| {
            if let Err(error) = crate::desktop_panel::prepare_first_paint(&window)
                .and_then(|_| crate::window_sizing::configure_app_window(&window, frame))
            {
                let _ = window.destroy();
                return Err(error);
            }
            Ok(window)
        });
    let window = match created {
        Ok(window) => window,
        Err(error) => {
            edit_records(&app, |records| {
                if let Some(previous) = previous_record {
                    records.insert(record.window_id.clone(), previous);
                } else {
                    records.remove(&record.window_id);
                }
            })
            .map_err(|rollback| {
                format!("{error}; app-window record rollback failed: {rollback}")
            })?;
            return Err(error);
        }
    };
    edit_live(&app, |live| {
        let opened_order = live.values().map(|window| window.opened_order).max().unwrap_or(0) + 1;
        live.insert(label.clone(), LiveAppWindow { ready: false, opened_order, record: Some(record.clone()), surface: None });
    })?;
    crate::window_chrome::configure_app_window(&window);
    let retained = window.clone();
    let id = record.window_id.clone();
    window.on_window_event(move |event| {
        let app = retained.app_handle();
        match event {
            WindowEvent::Focused(focused) => {
                note_window_focus(app, retained.label(), *focused);
                let _ = lifecycle(app, &id, "focused", Some(*focused));
            }
            WindowEvent::Destroyed => {
                retire_live_window(app, retained.label());
                // Explicit Close/Account teardown retires the record; Quit preserves it.
                let _ = lifecycle(app, &id, "destroyed", None);
            }
            _ => {}
        }
    });
    publish_active_records(&app, opened_records)?;
    Ok(AppWindowOpenResult {
        window_id: record.window_id,
        window_label: label,
        ready: false,
        reused: false,
    })
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_app_window_ready(
    app: AppHandle,
    caller_window: WebviewWindow,
    failure: Option<String>,
) -> Result<(), String> {
    if !is_app_window(caller_window.label()) {
        return Err("desktop_app_window_caller_refused".into());
    }
    if let Some(error) = failure {
        return app
            .emit_to(
                MAIN_WINDOW_LABEL,
                LIFECYCLE_EVENT,
                AppWindowLifecycle {
                    kind: "failed",
                    window_id: caller_window.label()["destination_".len()..].into(),
                    focused: None,
                    error: Some(error),
                },
            )
            .map_err(|error| error.to_string());
    }
    if app
        .state::<AppWindowState>()
        .live
        .lock()
        .map_err(|error| error.to_string())?
        .get(caller_window.label())
        .is_some_and(|window| window.ready)
    {
        return Ok(());
    }
    crate::desktop_panel::reveal_after_paint(&caller_window)?;
    reveal(&caller_window)?;
    edit_live(&app, |live| {
        if let Some(window) = live.get_mut(caller_window.label()) { window.ready = true; }
    })?;
    lifecycle(
        &app,
        &caller_window.label()["destination_".len()..],
        "ready",
        None,
    )
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_app_window_read(
    app: AppHandle,
    caller_window: WebviewWindow,
) -> Result<Option<AppWindowRecord>, String> {
    let Some(id) = caller_window.label().strip_prefix("destination_") else {
        return Err("desktop_app_window_caller_refused".into());
    };
    Ok(read_records(&app)?.remove(id))
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_app_window_restore(
    app: AppHandle,
    contexts: Vec<HomeCredentialContext>,
    active_only: Option<bool>,
) -> Result<Vec<AppWindowRecord>, String> {
    let records = if active_only.unwrap_or(false) {
        active_records(&app, read_records(&app)?)
    } else {
        read_records(&app)?.into_values().collect()
    };
    Ok(records.into_iter().filter(|record| contexts.iter().any(|context|
        matches_home_credential_context(record, &context.server_id, context.account_id.as_deref()))).collect())
}

#[cfg(desktop)]
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppWindowPlacement {
    work_area: Option<WindowFrame>,
    previous_frame: Option<WindowFrame>,
    frame: Option<WindowFrame>,
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_app_window_placement(
    app: AppHandle,
    window_id: String,
    caller_window: WebviewWindow,
) -> Result<AppWindowPlacement, String> {
    let label = label_for_id(&window_id)?;
    Ok(AppWindowPlacement {
        work_area: crate::window_sizing::app_window_work_area(&caller_window)?,
        previous_frame: crate::window_sizing::previous_visible_window_frame(&app, &label, None),
        frame: crate::window_sizing::app_window_saved_frame(&app, &label),
    })
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_app_window_update(app: AppHandle, record: AppWindowRecord) -> Result<(), String> {
    let label = label_for_id(&record.window_id)?;
    let previous = read_records(&app)?.remove(&record.window_id);
    let (changed, records) = edit_records(&app, |records| {
        records.insert(record.window_id.clone(), record.clone());
    })?;
    if changed {
        edit_live(&app, |live| {
            if let Some(window) = live.get_mut(&label) {
                window.ready = readiness_after_record_update(window.ready, previous.as_ref(), &record);
                window.record = Some(record.clone());
            }
        })?;
        app.emit_to(label, "desktopAppWindow://record", &record)
            .map_err(|error| error.to_string())?;
        app.emit_to(MAIN_WINDOW_LABEL, "desktopAppWindow://record", &record)
            .map_err(|error| error.to_string())?;
        publish_active_records(&app, records)?;
    }
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_app_window_close(app: AppHandle, window_id: String, reason: Option<AppWindowCloseReason>) -> Result<(), String> {
    if reason == Some(AppWindowCloseReason::RestoreFailed) {
        // A failed attempt may release its partial webview, but cannot retire the saved
        // reference or overwrite its retained geometry. Relaunch/Retry uses that reference.
        if let Some(window) = app.get_webview_window(&label_for_id(&window_id)?) {
            window.destroy().map_err(|error| error.to_string())?;
        }
    } else {
        destroy_window(&app, &window_id)?;
    }
    let (changed, records) = edit_records(&app, |records| {
        close_record(records, &window_id, reason);
    })?;
    if changed || reason == Some(AppWindowCloseReason::RestoreFailed) {
        publish_active_records(&app, records)?;
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AppWindowCloseReason {
    RestoreFailed,
}

fn close_record(records: &mut BTreeMap<String, AppWindowRecord>, window_id: &str, reason: Option<AppWindowCloseReason>) {
    if reason != Some(AppWindowCloseReason::RestoreFailed) { records.remove(window_id); }
}

#[cfg(desktop)]
fn destroy_window(app: &AppHandle, window_id: &str) -> Result<(), String> {
    let label = label_for_id(&window_id)?;
    if let Some(window) = app.get_webview_window(&label) {
        crate::window_sizing::persist_app_window_frame(&window);
        // destroy bypasses CloseRequested after the existing UI return/guard owner has admitted Close.
        window.destroy().map_err(|error| error.to_string())?;
    }
    Ok(())
}

/// Desktop Quit owns the exit decision; preserving these references must never run Return.
#[cfg(desktop)]
pub(crate) fn preserve_for_quit(app: &AppHandle) {
    for (label, window) in app.webview_windows() {
        if is_app_window(&label) {
            crate::window_sizing::persist_app_window_frame(&window);
        }
    }
}

#[cfg(desktop)]
#[tauri::command]
pub fn desktop_app_windows_teardown(
    app: AppHandle,
    scopes: Vec<HomeAccountCredentialScope>,
) -> Result<(), String> {
    retire_records(&app, records_in_credential_scopes(read_records(&app)?.into_values(), &scopes))
}

#[cfg(desktop)]
fn retire_records(app: &AppHandle, records: Vec<AppWindowRecord>) -> Result<(), String> {
    let mut retired = Vec::new();
    let result = records
        .iter()
        .try_for_each(|record| {
            destroy_window(app, &record.window_id)?;
            retired.push(record.window_id.clone());
            Ok::<(), String>(())
        });
    let (changed, records) = edit_records(app, |records| {
        for id in retired {
            records.remove(&id);
        }
    })?;
    if changed {
        publish_active_records(app, records)?;
    }
    result
}

/// The auth owner calls this only after its credential mutation has committed.
#[cfg(desktop)]
#[tauri::command]
pub fn desktop_app_windows_auth_changed(
    app: AppHandle,
    caller_window: WebviewWindow,
    mutations: Vec<HomeCredentialMutationNotice>,
) -> Result<(), String> {
    let source_window_label = caller_window.label().to_owned();
    // A forgotten Home's Connect shell may have no current Account to match at pre-commit teardown.
    let retirement = read_records(&app).and_then(|records|
        retire_records(&app, records_on_forgotten_homes(records.into_values(), &mutations)));
    let notice = serde_json::json!({"mutations": mutations, "sourceWindowLabel": source_window_label});
    let mut notification = Ok(());
    // Always reach the surviving realms, even if one native destruction or delivery fails.
    for label in app.webview_windows().keys().filter(|label| label.as_str() == MAIN_WINDOW_LABEL || is_app_window(label)) {
        let delivery = app.emit_to(label, "desktopAppWindow://account-teardown", &notice)
            .map_err(|error| error.to_string());
        if notification.is_ok() { notification = delivery; }
    }
    let reveal = crate::window_chrome::show_main_window(&app).map_err(|error| error.to_string());
    retirement?;
    notification?;
    reveal
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record(id: &str, home: &str, account: &str) -> AppWindowRecord {
        serde_json::from_value(serde_json::json!({
            "windowId": id, "accountId": account, "homeId": home, "layoutId": id,
            "chrome": "full", "selectedAddress": {"kind":"home"}
        })).unwrap()
    }

    #[test]
    fn failed_restore_keeps_the_record_eligible_for_retry_but_explicit_close_retires_it() {
        let saved = record("saved", "home-a", "account-a");
        let mut records = BTreeMap::from([(saved.window_id.clone(), saved.clone())]);
        close_record(&mut records, &saved.window_id, Some(AppWindowCloseReason::RestoreFailed));
        assert_eq!(records.get(&saved.window_id), Some(&saved));
        assert_eq!(records_in_credential_scopes(records.clone().into_values(), &[
            HomeAccountCredentialScope { server_id: "home-a".into(), account_id: "account-a".into() }
        ]), vec![saved.clone()]);
        close_record(&mut records, &saved.window_id, None);
        assert!(records.is_empty());
    }

    #[test]
    fn teardown_matches_the_qualified_home_account_pair() {
        let a = record("a", "home-a", "same");
        let b_same = record("b-same", "home-b", "same");
        let b_different = record("b-different", "home-b", "different");
        let records = vec![a.clone(), b_same, b_different.clone()];
        let a_scope = HomeAccountCredentialScope { server_id: "home-a".into(), account_id: "same".into() };
        assert_eq!(records_in_credential_scopes(records.clone(), &[a_scope]), vec![a.clone()]);
    }

    #[test]
    fn committed_forget_retires_connect_records_in_every_forgotten_home_only() {
        let a_connect = record("a-connect", "home-a", "former-a");
        let b = record("b", "home-b", "b");
        let c_connect = record("c-connect", "home-c", "former-c");
        let records = vec![a_connect.clone(), b, c_connect.clone()];
        let notice = |kind, home: &str| HomeCredentialMutationNotice {
            kind, server_id: home.into(), server_url: format!("https://{home}.test"),
        };
        let a = notice(HomeCredentialMutationKind::CredentialsRemoved, "home-a");
        assert_eq!(records_on_forgotten_homes(records.clone(), &[a]), vec![a_connect.clone()]);
        assert!(records_on_forgotten_homes(records.clone(), &[
            notice(HomeCredentialMutationKind::CredentialsSet, "home-a")]).is_empty());
        assert_eq!(records_on_forgotten_homes(records, &[
            notice(HomeCredentialMutationKind::CredentialsRemoved, "home-a"),
            notice(HomeCredentialMutationKind::CredentialsRemoved, "home-c"),
        ]), vec![a_connect, c_connect]);
    }

    #[test]
    fn restore_includes_each_home_local_account_and_excludes_replaced_credentials() {
        let a = record("a", "home-a", "same");
        let b_different = record("b-different", "home-b", "different");
        let records = vec![a.clone(), record("b-replaced", "home-b", "same"), b_different.clone()];
        assert_eq!(records_in_credential_scopes(records, &[
            HomeAccountCredentialScope { server_id: "home-a".into(), account_id: "same".into() },
            HomeAccountCredentialScope { server_id: "home-b".into(), account_id: "different".into() },
        ]), vec![a, b_different]);
    }

    #[test]
    fn absent_home_credentials_allow_only_full_connect_recovery_in_that_home() {
        let full = record("connect", "home-b", "account-b");
        assert!(matches_home_credential_context(&full, "home-b", None));
        assert!(!matches_home_credential_context(&full, "home-a", None));
        assert!(!matches_home_credential_context(&full, "home-b", Some("other-account")));
        let destination = AppWindowRecord { chrome: None, ..full };
        assert!(!matches_home_credential_context(&destination, "home-b", None));
    }
    #[test]
    fn full_window_restore_preserves_blank_home_and_presentation() {
        let value = serde_json::json!({
            "windowId":"full-1", "accountId":"account-a", "homeId":"home-b", "layoutId":"full-layout",
            "chrome":"full", "selectedAddress":{"kind":"home"}
        });
        let record: AppWindowRecord = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&record).unwrap(), value);
        assert_eq!(label_for_id(&record.window_id).unwrap(), "destination_full-1");
        assert_eq!(route_for_record(&record), "/desktop/app-window");
    }

    #[test]
    fn full_window_restore_retains_chrome_with_a_session_selection() {
        let value = serde_json::json!({
            "windowId":"full-2", "accountId":"account-a", "homeId":"home-b", "layoutId":"full-layout",
            "chrome":"full", "selectedAddress":{"kind":"session", "sessionId":"session-d"}
        });
        let record: AppWindowRecord = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&record).unwrap(), value);
    }

    #[test]
    fn changed_destination_waits_for_its_own_paint_ack_but_same_target_reuses_readiness() {
        let previous: AppWindowRecord = serde_json::from_value(serde_json::json!({
            "windowId":"opaque-1", "accountId":"account-a", "homeId":"home-b", "layoutId":"layout-c",
            "selectedAddress":{"kind":"session", "sessionId":"session-d"}
        })).unwrap();
        assert!(readiness_after_record_update(
            true,
            Some(&previous),
            &previous
        ));
        let mut next = previous.clone();
        next.selected_address = SelectedAddress::Session {
            session_id: "other".into(),
            destination: None,
        };
        assert!(!readiness_after_record_update(true, Some(&previous), &next));
        next = previous.clone();
        next.home_id = "other-home".into();
        assert!(!readiness_after_record_update(true, Some(&previous), &next));
        next = previous.clone();
        next.account_id = "other-account".into();
        assert!(!readiness_after_record_update(true, Some(&previous), &next));
    }
    #[test]
    fn restore_record_contains_only_references_and_preserves_qualified_scope() {
        let record: AppWindowRecord = serde_json::from_value(serde_json::json!({
            "windowId":"opaque-1", "accountId":"account-a", "homeId":"home-b", "layoutId":"layout-c",
            "selectedAddress":{"kind":"session", "sessionId":"session-d"}
        })).unwrap();
        assert_eq!(
            label_for_id(&record.window_id).unwrap(),
            "destination_opaque-1"
        );
        assert_eq!(serde_json::to_value(&record).unwrap()["homeId"], "home-b");
        assert_eq!(route_for_record(&record), "/desktop/window");
        assert!(label_for_id("../account").is_err());
    }

    #[test]
    fn restore_record_retains_source_tab_reference_for_other_window_strips() {
        let record: AppWindowRecord = serde_json::from_value(serde_json::json!({
            "windowId":"opaque-1", "accountId":"account-a", "homeId":"home-b", "layoutId":"layout-c",
            "sourceLayoutId":"main", "sourceTabId":"tab-source",
            "selectedAddress":{"kind":"session", "sessionId":"session-d"}
        })).unwrap();
        let value = serde_json::to_value(record).unwrap();
        assert_eq!(value["sourceTabId"], "tab-source");
    }

    #[test]
    fn restore_record_retains_session_review_destination() {
        let selected = serde_json::json!({"kind":"session", "sessionId":"session-d",
            "destination":{"kind":"scmReview", "comparison":{"kind":"workingTree"}, "view":"walkthrough", "explain":true}});
        let record: AppWindowRecord = serde_json::from_value(serde_json::json!({
            "windowId":"opaque-1", "accountId":"account-a", "homeId":"home-b", "layoutId":"layout-c",
            "selectedAddress":selected
        })).unwrap();
        assert_eq!(
            serde_json::to_value(record).unwrap()["selectedAddress"],
            selected
        );
    }

    #[test]
    fn restore_preserves_catalog_and_pane_addresses_without_losing_scope() {
        for selected in [
            serde_json::json!({"kind":"destination", "target":{"kind":"pluginPage", "params":{
                "pluginId":"example", "pageId":"editor", "instanceId":"instance-a", "subPath":"files/main.rs"
            }}}),
            serde_json::json!({"kind":"paneTab", "layoutId":"source-layout", "scopeId":"session:shared-id",
                "resourceId":"machine:shared-id", "tabKey":"file:main.rs"}),
        ] {
            let value = serde_json::json!({
                "windowId":"generic-window", "accountId":"account-a", "homeId":"home-b", "layoutId":"window-layout",
                "selectedAddress":selected
            });
            let record: AppWindowRecord = serde_json::from_value(value.clone()).unwrap();
            assert_eq!(serde_json::to_value(&record).unwrap(), value);
            assert!(readiness_after_record_update(true, Some(&record), &record));
            let mut other_home = record.clone();
            other_home.home_id = "home-c".into();
            assert!(!readiness_after_record_update(true, Some(&record), &other_home));
            let mut other_account = record.clone();
            other_account.account_id = "account-b".into();
            assert!(!readiness_after_record_update(true, Some(&record), &other_account));
        }
    }

    #[test]
    fn one_home_responder_uses_main_then_opening_order_and_releases_closed_windows() {
        let record = |id: &str, home: &str, chrome: Option<&str>| -> AppWindowRecord {
            serde_json::from_value(serde_json::json!({
                "windowId":id, "accountId":"account-a", "homeId":home, "layoutId":id,
                "chrome":chrome, "selectedAddress":{"kind":"session", "sessionId":"session"}
            })).unwrap()
        };
        let mut live = BTreeMap::new();
        for (id, home, chrome, order) in [
            ("z-first", "home-b", Some("full"), 1),
            ("a-second", "home-b", Some("full"), 2),
            ("dest", "home-c", None, 3),
            ("third", "home-a", Some("full"), 4),
        ] {
            live.insert(label_for_id(id).unwrap(), LiveAppWindow {
                ready: true, opened_order: order, record: Some(record(id, home, chrome)), surface: None,
            });
        }
        live.insert(MAIN_WINDOW_LABEL.into(), LiveAppWindow {
            ready: true, opened_order: 0, record: None,
            surface: Some(AppWindowSurface { window_id: MAIN_WINDOW_LABEL.into(), account_id: "account-a".into(),
                home_id: "home-a".into(), session_id: None, methods: Vec::new(), focused: true }),
        });
        let responders = home_responders(&live);
        assert_eq!(responders.iter().map(|r| (r.home_id.as_str(), r.window_id.as_str())).collect::<Vec<_>>(),
            [("home-a", "main"), ("home-b", "z-first")]);
        // Destination chrome never becomes a full-shell socket responder.
        assert!(!responders.iter().any(|r| r.home_id == "home-c"));
        live.remove("destination_z-first");
        assert_eq!(home_responders(&live)[1].window_id, "a-second");
        live.get_mut(MAIN_WINDOW_LABEL).unwrap().surface.as_mut().unwrap().home_id = "home-b".into();
        let responders = home_responders(&live);
        assert_eq!(responders.iter().map(|r| (r.home_id.as_str(), r.window_id.as_str())).collect::<Vec<_>>(),
            [("home-a", "third"), ("home-b", "main")]);
    }
}
