//! One desktop Quit owner: finalize native capture, then hand off service/recovery choices.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use happier_desktop_native::capture::{recording::{Phase, Session}, CaptureError};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub(crate) use macos::install as install_native_quit;

pub use crate::desktop_exit_policy::QuitIntent;
use crate::desktop_exit_policy::{parse_shutdown_outcome, resolve_desktop_exit_action,
    DesktopExitAction, DesktopExitRequest, RecordingExitState, ShutdownOutcome};

pub const APP_EXIT_REQUESTED_EVENT: &str = "desktop_app_exit_requested";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppExitRequestedPayload {
    stop_services: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    service_autostart: Option<crate::tray::model::AutostartMode>,
    /// A stopped writer/file-adoption failure; Retry never starts observing again.
    #[serde(skip_serializing_if = "Option::is_none")]
    recording_failure: Option<CaptureError>,
    /// The library-owned source, including an unfinished file, for P3's existing Discard owner.
    #[serde(skip_serializing_if = "Option::is_none")]
    recording_ref: Option<String>,
}

#[derive(Default)]
enum RecordingQuit {
    #[default]
    Idle,
    Finalizing,
    Failed(CaptureError),
    Acknowledged,
}

#[derive(Default)]
pub struct DesktopShutdownState {
    handoff_used: AtomicBool,
    intent: Mutex<QuitIntent>,
    recording: Mutex<RecordingQuit>,
    #[cfg(target_os = "macos")]
    native_termination: Mutex<macos::NativeTermination>,
}

pub fn request_quit(app: &AppHandle, intent: QuitIntent) {
    let state: State<'_, DesktopShutdownState> = app.state();
    if let Ok(mut current) = state.intent.lock() { *current = intent; }
    app.exit(0);
}

fn payload(app: &AppHandle, state: &DesktopShutdownState) -> AppExitRequestedPayload {
    let recording_failure = state.recording.lock().ok().and_then(|recording| match *recording {
        RecordingQuit::Failed(error) => Some(error), _ => None,
    });
    let recording_ref = recording_failure.and_then(|_| app.state::<crate::capture::CaptureState>()
        .active_recording().and_then(|session| session.snapshot().source_ref));
    AppExitRequestedPayload {
        stop_services: state.intent.lock().map(|intent| *intent == QuitIntent::StopServices).unwrap_or(false),
        service_autostart: crate::tray::persisted_service_autostart(app),
        recording_failure,
        recording_ref,
    }
}

/// A freshly recreated main renderer reads the same pending handoff after installing its listener.
#[tauri::command]
pub fn desktop_read_shutdown_state(app: AppHandle) -> Option<AppExitRequestedPayload> {
    let state: State<'_, DesktopShutdownState> = app.state();
    let pending = state.recording.lock().ok().is_some_and(|recording| matches!(*recording, RecordingQuit::Failed(_)));
    pending.then(|| payload(&app, &state))
}

/// `recordingDiscard` acknowledges P3's completed reversible discard; this command never deletes
/// files or owns an Undo timer. `recordingQuit` explicitly preserves the partial library source.
#[tauri::command]
pub fn desktop_finish_shutdown(app: AppHandle, outcome: Option<String>) -> Result<(), String> {
    let state: State<'_, DesktopShutdownState> = app.state();
    match parse_shutdown_outcome(outcome.as_deref()) {
        ShutdownOutcome::MenuBar => {
            #[cfg(target_os = "macos")]
            macos::reply(&app, false);
            state.handoff_used.store(false, Ordering::SeqCst);
            *state.recording.lock().unwrap() = RecordingQuit::Idle;
            *state.intent.lock().unwrap() = QuitIntent::Quit;
            crate::menu_bar::enter(&app);
        }
        ShutdownOutcome::RetryRecording => {
            *state.recording.lock().unwrap() = RecordingQuit::Idle;
            state.handoff_used.store(false, Ordering::SeqCst);
            app.exit(0);
        }
        ShutdownOutcome::DiscardRecording | ShutdownOutcome::QuitRecording => {
            *state.recording.lock().unwrap() = RecordingQuit::Acknowledged;
            state.handoff_used.store(false, Ordering::SeqCst);
            app.exit(0);
        }
        ShutdownOutcome::Exit => app.exit(0),
    }
    Ok(())
}

fn finalize_recording(session: &Session) -> Result<(), CaptureError> {
    let snapshot = session.stop()?;
    if snapshot.phase == Phase::Failed && snapshot.error != Some(CaptureError::Cancelled) {
        Err(snapshot.error.unwrap_or(CaptureError::NativeFailure))
    } else { Ok(()) }
}

/// Returns true exactly when the runtime must hold the requested exit.
pub fn handle_exit_requested(app: &AppHandle, code: Option<i32>) -> bool {
    let state: State<'_, DesktopShutdownState> = app.state();
    let session = app.state::<crate::capture::CaptureState>().active_recording();
    let recording = state.recording.lock().map(|recording| match *recording {
        RecordingQuit::Idle if session.is_some() => RecordingExitState::NeedsFinalization,
        RecordingQuit::Finalizing => RecordingExitState::Finalizing,
        RecordingQuit::Failed(_) => RecordingExitState::Failed,
        _ => RecordingExitState::None,
    }).unwrap_or(RecordingExitState::Failed);
    let request = DesktopExitRequest {
        recording,
        webview_present: app.get_webview_window("main").is_some(),
        handoff_used: state.handoff_used.load(Ordering::SeqCst),
        is_restart: code == Some(tauri::RESTART_EXIT_CODE),
        menu_bar_mode: crate::menu_bar::is_active(app),
        explicit: code.is_some(),
    };
    match resolve_desktop_exit_action(request) {
        DesktopExitAction::Exit => {
            #[cfg(target_os = "macos")]
            if macos::reply(app, true) { return true; }
            false
        },
        DesktopExitAction::StayInMenuBar | DesktopExitAction::WaitForRecording => true,
        DesktopExitAction::FinalizeRecording => {
            let Some(session) = session else { return true; };
            if let Ok(mut recording) = state.recording.lock() { *recording = RecordingQuit::Finalizing; }
            let app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let completed = finalize_recording(&session);
                let state = app.state::<DesktopShutdownState>();
                if let Ok(mut recording) = state.recording.lock() {
                    *recording = match completed { Ok(()) => RecordingQuit::Idle, Err(error) => RecordingQuit::Failed(error) };
                }
                app.exit(0);
            });
            true
        }
        DesktopExitAction::HandOffToWebview => {
            state.handoff_used.store(true, Ordering::SeqCst);
            let pending = payload(app, &state);
            let failed_recording = pending.recording_failure.is_some();
            if failed_recording { crate::window_chrome::request_show_main_window(app); }
            // A failure remains readable if the main renderer is still mounting or publication fails.
            if app.emit(APP_EXIT_REQUESTED_EVENT, pending).is_err() { return failed_recording; }
            true
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use happier_desktop_native::capture::recording::{Backend, Moment};
    use std::sync::{Arc, mpsc};

    #[test]
    fn quit_can_finish_when_its_pending_source_request_was_cancelled() {
        let (register, registered) = mpsc::channel();
        assert!(Session::start(|_, _| Err(CaptureError::Cancelled), Arc::new(|_| {}),
            Arc::new(|| Moment { steady_ns: 0, epoch_ms: 0 }), move |session| register.send(session).unwrap()).is_err());
        assert_eq!(finalize_recording(&registered.recv().unwrap()), Ok(()),
            "a withdrawn source dialog has no unfinished movie requiring a failure handoff");
    }

    #[test]
    fn quit_waits_for_the_writer_and_preserves_its_terminal_failure() {
        // The only substituted boundary is the OS writer: completion is held until released.
        struct Writer { entered: mpsc::Sender<()>, completion: mpsc::Receiver<()> }
        impl Backend for Writer {
            fn start(&mut self) -> Result<(), CaptureError> { Ok(()) }
            fn finish(&mut self, _duration_ns: u64) -> Result<Option<CaptureError>, CaptureError> {
                self.entered.send(()).unwrap(); self.completion.recv().unwrap(); Err(CaptureError::FileIo)
            }
            fn cancel(&mut self) {}
        }
        let (entered, entered_writer) = mpsc::channel();
        let (complete, completion) = mpsc::channel();
        let writer = Writer { entered, completion };
        let session = Session::start(|_, _| Ok((Box::new(writer), Box::new(|| unreachable!()))),
            Arc::new(|_| {}), Arc::new(|| Moment { steady_ns: 0, epoch_ms: 0 }), |_| {}).unwrap();
        let stopping = session.clone();
        let (settled, settlement) = mpsc::channel();
        let quit = std::thread::spawn(move || settled.send(finalize_recording(&stopping)).unwrap());
        entered_writer.recv().unwrap();
        assert_eq!(session.snapshot().phase, Phase::Finalizing);
        assert!(matches!(settlement.try_recv(), Err(mpsc::TryRecvError::Empty)));
        complete.send(()).unwrap();
        assert_eq!(settlement.recv().unwrap(), Err(CaptureError::FileIo));
        quit.join().unwrap();
        assert_eq!(session.snapshot().phase, Phase::Failed);
    }

    #[test]
    fn quit_handoff_carries_the_last_proven_login_mode_but_omits_unknown_mode() {
        let known = serde_json::to_value(AppExitRequestedPayload {
            stop_services: false, service_autostart: Some(crate::tray::model::AutostartMode::AtLogin),
            recording_failure: None,
            recording_ref: None,
        }).unwrap();
        assert_eq!(known, serde_json::json!({"stopServices": false, "serviceAutostart": "at-login"}));
        let failed = serde_json::to_value(AppExitRequestedPayload {
            stop_services: true, service_autostart: None, recording_failure: Some(CaptureError::FileIo),
            recording_ref: Some("unfinished-movie".into()),
        }).unwrap();
        assert_eq!(failed, serde_json::json!({"stopServices": true, "recordingFailure": "file_io", "recordingRef": "unfinished-movie"}));
    }
}
