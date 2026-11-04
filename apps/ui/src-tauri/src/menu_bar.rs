//! Menu-bar mode (R16): the tray outlives the window.
//!
//! With the login-start setting on, Quit releases every window and the web UI (and, on macOS, the
//! Dock icon) and keeps this process with only its tray, while the background services keep
//! running; a login start begins here directly (`--menu-bar`). Open from the tray builds the main
//! window again. While tray-only, the tray reads the services itself through the existing status
//! system task — hsetup and the CLI own every service rule; nothing here restates one — and its
//! actions run the existing start/stop/autostart tasks, then read again.

pub mod policy;

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Instant;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

use crate::menu::ids::ServiceMenuAction;
use crate::system_tasks::{run_system_task_for_native, NativeTaskOutcome};
use crate::tray::model::{fill_relay, read_service_status, AutostartMode, ServiceList};
use policy::{
    build_native_task_spec, launched_in_menu_bar_mode as launched_with_args, status_timer_needed,
    StatusReadState, StatusReadTrigger, LINUX_STATUS_TIMER_INTERVAL,
};

/// Tells a running web UI that a tray action changed this computer's services, so it re-reads.
pub const BACKGROUND_SERVICES_CHANGED_EVENT: &str = "desktop_background_services_changed";

pub use policy::{MainWindowDestination, PendingDestination};

pub const OPEN_HOME_REQUESTED_EVENT: &str = "desktop_open_home_requested";

impl MainWindowDestination {
    fn event(&self) -> &'static str {
        match self {
            Self::Updates => crate::menu::OPEN_UPDATES_REQUESTED_EVENT,
            Self::Settings => crate::menu::OPEN_SETTINGS_REQUESTED_EVENT,
            Self::Relay(_) => OPEN_HOME_REQUESTED_EVENT,
        }
    }
}

pub struct MenuBarState {
    active: AtomicBool,
    inner: Mutex<MenuBarInner>,
    update_relaunch: AtomicBool,
}

impl Default for MenuBarState {
    fn default() -> Self {
        Self {
            active: AtomicBool::new(false),
            inner: Mutex::new(MenuBarInner::default()),
            update_relaunch: AtomicBool::new(false),
        }
    }
}

#[derive(Default)]
struct MenuBarInner {
    status_read: StatusReadState,
    last_read_started: Option<Instant>,
    /// The last native status read failed: the next pointer event retries without the throttle.
    last_read_failed: bool,
    action_in_flight: bool,
    /// A screen a tray item asked for while the main window was being built again.
    pending_destination: Option<MainWindowDestination>,
    timer_running: bool,
}

pub fn launched_in_menu_bar_mode(app: &AppHandle) -> bool {
    let update_relaunch = app
        .try_state::<MenuBarState>()
        .is_some_and(|state| state.update_relaunch.load(Ordering::SeqCst));
    launched_with_args(std::env::args(), update_relaunch)
}

/// Consume updater intent before any login-mode or window-creation decision.
pub fn prepare_launch(app: &AppHandle) {
    let result = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())
        .and_then(|dir| {
            crate::app_updates::relaunch::consume_update_relaunch_marker(
                &dir,
                &app.package_info().version.to_string(),
            )
            .map_err(|error| error.to_string())
        });
    match result {
        Ok(relaunch) => {
            if let Some(state) = app.try_state::<MenuBarState>() {
                state.update_relaunch.store(relaunch, Ordering::SeqCst);
            }
        }
        Err(error) => log::warn!("could not consume updater relaunch intent: {error}"),
    }
}

pub fn is_active<R: tauri::Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<MenuBarState>()
        .is_some_and(|state| state.active.load(Ordering::SeqCst))
}

/// App start. A login start (`--menu-bar`) begins tray-only: no window was created
/// (`window_chrome::register`), so there is no web UI to load.
pub fn register(app: &AppHandle) {
    if launched_in_menu_bar_mode(app) {
        activate(app);
    }
}

/// The webview answered the quit handoff with "keep running" (the login-start setting is on).
pub fn enter(app: &AppHandle) {
    let handle = app.clone();
    let result = app.run_on_main_thread(move || {
        // Active first: destroying the last window raises an implicit exit request, which
        // `crate::desktop_lifecycle` holds only while this is set.
        activate(&handle);
        crate::pet_overlay::release_for_menu_bar(&handle);
        crate::activity_overlay::release_for_menu_bar(&handle);
        for (_, window) in handle.webview_windows() {
            if let Err(error) = window.destroy() {
                log::warn!("failed to release a window for menu-bar mode: {error}");
            }
        }
    });
    if let Err(error) = result {
        log::warn!("failed to enter menu-bar mode: {error}");
    }
}

fn activate(app: &AppHandle) {
    let Some(state) = app.try_state::<MenuBarState>() else {
        return;
    };
    state.active.store(true, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    if let Err(error) = app.set_activation_policy(tauri::ActivationPolicy::Accessory) {
        log::warn!("failed to hide the Dock icon for menu-bar mode: {error}");
    }
    // The web UI's connection line describes an app that is no longer open.
    crate::tray::update_model(app, |model| model.status_line = None);
    start_timer_if_needed(app);
    read_status(app, StatusReadTrigger::EnteredMenuBar);
}

/// The main window is coming back (tray Open, macOS reopen): a regular app again.
pub fn leave(app: &AppHandle) {
    let Some(state) = app.try_state::<MenuBarState>() else {
        return;
    };
    if !state.active.swap(false, Ordering::SeqCst) {
        return;
    }
    if let Ok(mut inner) = state.inner.lock() {
        inner.status_read.leave();
    };
    #[cfg(target_os = "macos")]
    {
        if let Err(error) = app.set_activation_policy(tauri::ActivationPolicy::Regular) {
            log::warn!("failed to restore the Dock icon: {error}");
        }
        crate::dock_icon::apply();
    }
}

/// Another launch of this app while it runs (single instance): the same "open the main window" path
/// as the tray's Open and a macOS reopen, which also leaves menu-bar mode — unless it is the login
/// item firing again (`--menu-bar`), which asks for no window.
pub fn on_second_launch(app: &AppHandle, args: Vec<String>) {
    if !crate::capture::triggers::second_launch(app, &args)
        || !policy::second_launch_opens_main_window(&args) {
        return;
    }
    crate::window_chrome::present_main_window_for_lifecycle_event(
        app,
        crate::window_chrome::DesktopMainWindowLifecycleEvent::SecondLaunch,
    );
}

pub fn on_tray_pointer(app: &AppHandle) {
    let main = app.get_webview_window(crate::window_chrome::MAIN_WINDOW_LABEL);
    #[cfg(target_os = "windows")]
    crate::tray::refresh_tray_theme_on_pointer(app, main.is_some());
    let target = {
        let Some(state) = app.try_state::<MenuBarState>() else {
            return;
        };
        let Ok(mut inner) = state.inner.lock() else {
            return;
        };
        let target = policy::tray_pointer_refresh_target(
            main.is_some(),
            inner.last_read_started.map(|started| started.elapsed()),
        );
        if target == policy::TrayPointerRefreshTarget::Webview {
            inner.last_read_started = Some(Instant::now());
        }
        target
    };
    match target {
        policy::TrayPointerRefreshTarget::Webview => {
            if let Some(window) = main {
                if let Err(error) = window.emit(
                    "desktop_tray_refresh_requested",
                    json!({"trigger":"tray-pointer"}),
                ) {
                    log::warn!("could not request tray inspection refresh: {error}");
                }
            }
        }
        policy::TrayPointerRefreshTarget::Native => {
            read_status(app, StatusReadTrigger::TrayPointer)
        }
        policy::TrayPointerRefreshTarget::Suppressed => {}
    }
}

pub fn take_pending_destination(app: &AppHandle) -> Option<PendingDestination> {
    let state = app.try_state::<MenuBarState>()?;
    let mut inner = state.inner.lock().ok()?;
    inner
        .pending_destination
        .take()
        .map(|d| d.pending_payload())
}

/// Updates / Settings / a relay pick: a running web UI is told to navigate; one being built again reads the
/// request with its first tray push (`desktop_set_tray_state`), after its listeners exist.
pub fn open_main_window_at(app: &AppHandle, destination: MainWindowDestination) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.emit(destination.event(), destination.event_payload()) {
            log::warn!("failed to ask the main window to open {destination:?}: {error}");
        }
    } else if let Some(state) = app.try_state::<MenuBarState>() {
        if let Ok(mut inner) = state.inner.lock() {
            inner.pending_destination = Some(destination);
        }
    }
    crate::window_chrome::request_show_main_window(app);
}

/// A window gets the existing quit handoff; tray-only Quit follows the same Stop owner when OFF.
pub fn quit(app: &AppHandle) {
    let intent = if is_active(app) {
        crate::desktop_lifecycle::QuitIntent::for_menu_bar_quit(crate::tray::start_at_login(app))
    } else {
        crate::desktop_lifecycle::QuitIntent::Quit
    };
    if intent == crate::desktop_lifecycle::QuitIntent::StopServices {
        stop_services_and_quit(app);
    } else {
        crate::desktop_lifecycle::request_quit(app, intent);
    }
}

/// "Stop background services and quit". With a web UI, the quit handoff carries the choice there
/// (it knows the sessions and asks when some run). Tray-only, the native side cannot see sessions,
/// so it always confirms before stopping anything that runs, then stops and exits.
pub fn stop_services_and_quit(app: &AppHandle) {
    if !app.webview_windows().is_empty() {
        crate::desktop_lifecycle::request_quit(
            app,
            crate::desktop_lifecycle::QuitIntent::StopServices,
        );
        return;
    }
    if crate::tray::app_managed_service_running(app) == Some(false) {
        run_stop_services_and_quit(app.clone());
        return;
    }
    let labels = crate::tray::labels(app);
    let handle = app.clone();
    app.dialog()
        .message(labels.stop_all_confirm_body.clone())
        .title(labels.stop_all_confirm_title.clone())
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            labels.stop_confirm_action.clone(),
            labels.cancel.clone(),
        ))
        .show(move |confirmed| {
            if !confirmed {
                return;
            }
            run_stop_services_and_quit(handle);
        });
}

// Only the task owner proves every installed managed service stopped. Cached tray rows
// affect the confirmation, never authorize an exit that bypasses that owner.
fn run_stop_services_and_quit(app: AppHandle) {
    run_action(
        app,
        crate::menu::ids::STOP_SERVICES_AND_QUIT_MENU_ID.to_string(),
        |app| {
            let outcome = run_service_task(app, "daemon.service.stop.v1", &[]);
            if let Some(message) = failure_message(&outcome) {
                Err(message)
            } else {
                app.exit(0);
                Ok(())
            }
        },
    );
}

/// The tray's "Start at login" check item: the one login-start setting, written through the
/// existing `daemon.service.autostart.set.v1` task (every service the app manages), then the app's
/// own login item follows it.
pub fn toggle_start_at_login(app: &AppHandle) {
    let Some(current) = crate::tray::start_at_login(app) else {
        return;
    };
    let target = if current {
        AutostartMode::OnDemand
    } else {
        AutostartMode::AtLogin
    };
    run_action(
        app.clone(),
        crate::menu::ids::TOGGLE_START_AT_LOGIN_MENU_ID.to_string(),
        move |app| {
            let outcome = run_service_task(
                app,
                "daemon.service.autostart.set.v1",
                &[("autostart", json!(target.as_str()))],
            );
            match failure_message(&outcome) {
                Some(message) => Err(message),
                None => {
                    crate::tray::persist_service_autostart(app, Some(target));
                    crate::tray::update_model(app, |model| {
                        model.start_at_login = Some(target == AutostartMode::AtLogin)
                    });
                    crate::autostart::follow_login_start_setting(app, Some(target));
                    Ok(())
                }
            }
        },
    );
}

/// A service row's Open / Start / Restart / Stop.
pub fn run_service_action(app: &AppHandle, action: ServiceMenuAction, relay_url: String) {
    match action {
        ServiceMenuAction::Open => {
            // D11-3: this is direct user intent. The web UI's existing selection owner applies it.
            open_main_window_at(app, MainWindowDestination::Relay(relay_url));
        }
        ServiceMenuAction::Start => run_relay_task(app, relay_url, &["daemon.service.start.v1"]),
        // A restart is the existing stop then the existing start, each proven by its re-read.
        ServiceMenuAction::Restart => run_relay_task(
            app,
            relay_url,
            &["daemon.service.stop.v1", "daemon.service.start.v1"],
        ),
        ServiceMenuAction::Stop => {
            // The native side never sees sessions, and a running daemon may have some: ask.
            let labels = crate::tray::labels(app);
            let name = crate::tray::relay_display_name(app, &relay_url);
            let handle = app.clone();
            app.dialog()
                .message(fill_relay(&labels.stop_confirm_body, &name))
                .title(fill_relay(&labels.stop_confirm_title, &name))
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    labels.stop_confirm_action.clone(),
                    labels.cancel.clone(),
                ))
                .show(move |confirmed| {
                    if confirmed {
                        run_relay_task(&handle, relay_url, &["daemon.service.stop.v1"]);
                    }
                });
        }
    }
}

fn run_relay_task(app: &AppHandle, relay_url: String, kinds: &'static [&'static str]) {
    let action = if kinds.len() > 1 {
        ServiceMenuAction::Restart
    } else if kinds[0] == "daemon.service.stop.v1" {
        ServiceMenuAction::Stop
    } else {
        ServiceMenuAction::Start
    };
    run_action(
        app.clone(),
        crate::menu::ids::service_menu_id(action, &relay_url),
        move |app| {
            for kind in kinds {
                let outcome = run_service_task(app, kind, &[("relayUrl", json!(relay_url))]);
                if let Some(message) = failure_message(&outcome) {
                    return Err(message);
                }
            }
            Ok(())
        },
    );
}

/// One tray action at a time, off the main thread; the menu shows it as busy, the web UI (when it
/// runs) is told to re-read, and menu-bar mode reads again.
fn run_action(
    app: AppHandle,
    action: String,
    work: impl FnOnce(&AppHandle) -> Result<(), String> + Send + 'static,
) {
    let Some(state) = app.try_state::<MenuBarState>() else {
        return;
    };
    {
        let Ok(mut inner) = state.inner.lock() else {
            return;
        };
        if inner.action_in_flight {
            return;
        }
        inner.action_in_flight = true;
    }
    crate::tray::update_model(&app, |model| {
        model.busy = true;
        model.retry_action(&action);
    });
    std::thread::spawn(move || {
        match work(&app) {
            Err(message) => {
                crate::tray::update_model(&app, |model| {
                    model.record_action_failure(action, message.clone())
                });
                show_failure(&app, &message);
            }
            Ok(()) => crate::tray::update_model(&app, |model| model.action_succeeded(&action)),
        }
        if let Some(state) = app.try_state::<MenuBarState>() {
            if let Ok(mut inner) = state.inner.lock() {
                inner.action_in_flight = false;
            }
        }
        crate::tray::update_model(&app, |model| model.busy = false);
        let _ = app.emit(BACKGROUND_SERVICES_CHANGED_EVENT, ());
        read_status(&app, StatusReadTrigger::AfterAction);
    });
}

fn run_service_task(app: &AppHandle, kind: &str, extra: &[(&str, Value)]) -> NativeTaskOutcome {
    let Some(params) = crate::tray::native_task_params(app) else {
        return NativeTaskOutcome::Failed {
            code: "task_params_unknown".to_string(),
            message: "Open Happier once so the tray can manage this computer's services."
                .to_string(),
        };
    };
    match build_native_task_spec(kind, &params, extra) {
        Some(spec) => run_system_task_for_native(app, &spec),
        None => NativeTaskOutcome::Failed {
            code: "invalid_spec".to_string(),
            message: "The tray could not describe this task.".to_string(),
        },
    }
}

fn failure_message(outcome: &NativeTaskOutcome) -> Option<String> {
    match outcome {
        NativeTaskOutcome::Succeeded(_) => None,
        NativeTaskOutcome::Failed { code, message } => Some(if message.trim().is_empty() {
            code.clone()
        } else {
            message.clone()
        }),
    }
}

/// A failed tray action is said twice: at once in a native dialog, and in the menu itself until the
/// next success (`notice`), so it is never only a log line — release builds keep no log.
fn show_failure(app: &AppHandle, message: &str) {
    let labels = crate::tray::labels(app);
    app.dialog()
        .message(message.to_string())
        .title(labels.action_failed_title)
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::Ok)
        .show(|_| {});
}

fn read_status(app: &AppHandle, trigger: StatusReadTrigger) {
    let Some(state) = app.try_state::<MenuBarState>() else {
        return;
    };
    {
        let Ok(mut inner) = state.inner.lock() else {
            return;
        };
        let since_last = inner.last_read_started.map(|started| started.elapsed());
        let last_read_failed = inner.last_read_failed;
        if !inner.status_read.request(
            trigger,
            state.active.load(Ordering::SeqCst),
            since_last,
            last_read_failed,
        ) {
            return;
        }
        inner.last_read_started = Some(Instant::now());
    }
    let app = app.clone();
    std::thread::spawn(move || loop {
        // Reopening can happen after a follow-up was reserved but before this iteration runs.
        if !is_active(&app) {
            if let Some(state) = app.try_state::<MenuBarState>() {
                if let Ok(mut inner) = state.inner.lock() {
                    inner.status_read.finish(false);
                }
            }
            return;
        }
        let outcome = run_service_task(&app, "daemon.service.status.v1", &[]);
        let failed = match &outcome {
            NativeTaskOutcome::Succeeded(Some(data)) => {
                matches!(read_service_status(data).services, ServiceList::Failed)
            }
            _ => true,
        };
        // A read that finished after the window came back is stale beside the web UI's rows.
        if is_active(&app) {
            match outcome {
                NativeTaskOutcome::Succeeded(Some(data)) => {
                    let projected = read_service_status(&data);
                    crate::tray::persist_service_autostart(&app, projected.autostart);
                    crate::tray::update_model(&app, |model| {
                        model.services = projected.services;
                        model.running_managed_service_count =
                            projected.running_managed_service_count;
                        model.record_status_notice(None);
                        model.start_at_login = projected
                            .autostart
                            .map(|mode| mode == AutostartMode::AtLogin);
                    });
                    crate::autostart::follow_login_start_setting(&app, projected.autostart);
                }
                NativeTaskOutcome::Succeeded(None) | NativeTaskOutcome::Failed { .. } => {
                    // Said in the menu ("Couldn't read background services" and the reason), and
                    // retried the next time the menu is about to open.
                    let reason = match &outcome {
                        NativeTaskOutcome::Failed { code, message } => {
                            log::warn!("menu-bar status read failed ({code}): {message}");
                            failure_message(&outcome)
                        }
                        _ => None,
                    };
                    crate::tray::update_model(&app, |model| {
                        model.services = ServiceList::Failed;
                        model.running_managed_service_count = None;
                        model.record_status_notice(reason);
                    });
                }
            }
        }
        let Some(state) = app.try_state::<MenuBarState>() else {
            return;
        };
        let Ok(mut inner) = state.inner.lock() else {
            return;
        };
        inner.last_read_failed = failed;
        // Keep the read reserved through publication, then drain the one action obligation on
        // this worker. Pointer/timer demand cannot overtake it or add another status thread.
        if !inner
            .status_read
            .finish(state.active.load(Ordering::SeqCst))
        {
            return;
        }
        inner.last_read_started = Some(Instant::now());
    });
}

/// Linux's AppIndicator reports no hover or click, so tray-only Linux re-reads on a slow timer
/// that stops as soon as a window is back.
fn start_timer_if_needed(app: &AppHandle) {
    if !status_timer_needed(crate::tray::model::MenuPlatform::current(), is_active(app)) {
        return;
    }
    let Some(state) = app.try_state::<MenuBarState>() else {
        return;
    };
    {
        let Ok(mut inner) = state.inner.lock() else {
            return;
        };
        if inner.timer_running {
            return;
        }
        inner.timer_running = true;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(LINUX_STATUS_TIMER_INTERVAL);
            if !is_active(&app) {
                break;
            }
            read_status(&app, StatusReadTrigger::Timer);
        }
        if let Some(state) = app.try_state::<MenuBarState>() {
            if let Ok(mut inner) = state.inner.lock() {
                inner.timer_running = false;
            }
        }
    });
}
