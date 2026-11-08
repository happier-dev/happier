//! Desktop quit handoff.
//!
//! The main window never closes — it hides to the tray (`window_chrome::resolve_desktop_window_close_strategy`)
//! — so "the app closed" is the app exiting, and that happens exactly once, never once per window.
//! It is where the background-service preference is honoured, and the webview owns the decision
//! because only it knows what is running on this computer and can put a question to the user.
//!
//! The safe direction is asymmetric: leaving the daemon running costs the user nothing they did
//! not already have, while stopping it can end in-flight agent work. So the exit proceeds unless
//! the webview asks for the handoff, and the service is only ever stopped by the webview acting on
//! an answer it actually received. A force quit, an OS shutdown or a logout that kills the app
//! part-way through therefore leaves the daemon exactly where it was.
//!
//! R16 (a): with the login-start setting on, the webview answers the handoff with `menuBar`
//! instead of exiting — the app then drops its windows and web UI and keeps only the tray
//! (`crate::menu_bar`), with the services still running. Destroying the last window raises an
//! implicit exit request, which menu-bar mode holds; only an explicit Quit ends that process.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

mod policy;

pub use policy::QuitIntent;
use policy::{
    parse_shutdown_outcome, resolve_desktop_exit_action, AppExitRequestedPayload,
    DesktopExitAction, DesktopExitRequest, ShutdownOutcome,
};

/// Emitted to the webview when the app is quitting and the handoff is still available.
pub const APP_EXIT_REQUESTED_EVENT: &str = "desktop_app_exit_requested";

#[derive(Default)]
pub struct DesktopShutdownState {
    handoff_used: AtomicBool,
    intent: Mutex<QuitIntent>,
}

/// Asks the app to quit the way the person chose; the exit handler hands the choice to the
/// webview with the one handoff.
pub fn request_quit(app: &AppHandle, intent: QuitIntent) {
    let state: State<'_, DesktopShutdownState> = app.state();
    if let Ok(mut current) = state.intent.lock() {
        *current = intent;
    }
    app.exit(0);
}

/// Successful explicit component removal already settled service ownership. A following
/// finish-shutdown must exit without offering a second service decision or returning to the tray.
pub(crate) fn prepare_after_component_removal(app: &AppHandle) {
    let state: State<'_, DesktopShutdownState> = app.state();
    state.handoff_used.store(true, Ordering::SeqCst);
}

/// Called by the webview once it has done whatever the user's answer asked for. `menuBar` keeps a
/// tray-only process with the services running (R16 a); anything else exits, re-entering the
/// handler, which now finds the handoff used and lets the app go.
#[tauri::command]
pub fn desktop_finish_shutdown(app: AppHandle, outcome: Option<String>) -> Result<(), String> {
    match parse_shutdown_outcome(outcome.as_deref()) {
        ShutdownOutcome::MenuBar => {
            let state: State<'_, DesktopShutdownState> = app.state();
            // The quit is over; the next one (from the tray, or after reopening) starts afresh.
            state.handoff_used.store(false, Ordering::SeqCst);
            crate::menu_bar::enter(&app);
        }
        ShutdownOutcome::Exit => app.exit(0),
    }
    Ok(())
}

/// Handles `RunEvent::ExitRequested`. Returns `true` when the caller must hold the exit.
pub fn handle_exit_requested(app: &AppHandle, code: Option<i32>) -> bool {
    let state: State<'_, DesktopShutdownState> = app.state();
    let request = DesktopExitRequest {
        system_tasks_busy: app
            .state::<crate::system_tasks::SystemTasksState>()
            .is_busy()
            .unwrap_or_else(|error| {
                eprintln!("Unable to check system tasks before quitting: {error}");
                true
            }),
        webview_present: !app.webview_windows().is_empty(),
        handoff_used: state.handoff_used.load(Ordering::SeqCst),
        is_restart: code == Some(tauri::RESTART_EXIT_CODE),
        menu_bar_mode: crate::menu_bar::is_active(app),
        explicit: code.is_some(),
    };

    match resolve_desktop_exit_action(request) {
        DesktopExitAction::WaitForSystemTasks => {
            let labels = crate::tray::labels(app);
            app.dialog()
                .message(labels.quit_wait_for_system_tasks)
                .title(labels.action_failed_title)
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::Ok)
                .show(|_| {});
            true
        }
        DesktopExitAction::Exit => false,
        DesktopExitAction::StayInMenuBar => true,
        DesktopExitAction::HandOffToWebview => {
            state.handoff_used.store(true, Ordering::SeqCst);
            let intent = state
                .intent
                .lock()
                .map(|mut intent| std::mem::take(&mut *intent))
                .unwrap_or_default();
            let payload = AppExitRequestedPayload::new(intent, crate::tray::start_at_login(app));
            // `emit` reports success with zero listeners, so this only fires when the event could
            // not be published at all — never as "nobody is listening". A quit that beats the
            // webview's listener is still held, and is finished by pressing Quit again.
            if app.emit(APP_EXIT_REQUESTED_EVENT, payload).is_err() {
                return false;
            }
            true
        }
    }
}
