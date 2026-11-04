//! Recording is projected into the existing tray model. Only its elapsed label has a local clock.
use std::sync::mpsc::{self, Sender};
use std::thread::JoinHandle;
use std::time::Duration;

use happier_desktop_native::capture::recording::{Phase, Snapshot};
use tauri::{AppHandle, Manager};

use super::{model::{epoch_ms, RecordingMenu, RecordingMenuPhase}, TrayState};

pub(super) struct RecordingClock { stop: Sender<()>, task: Option<JoinHandle<()>> }

impl Drop for RecordingClock {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(task) = self.task.take() { let _ = task.join(); }
    }
}

/// Called by capture's existing pushed lifecycle publisher. It never reads capture state.
pub(crate) fn recording_changed(app: &AppHandle, snapshot: &Snapshot) {
    let Some(state) = app.try_state::<TrayState>() else { return; };
    let phase = match snapshot.phase {
        Phase::Preparing => Some(RecordingMenuPhase::Preparing),
        Phase::Recording => Some(RecordingMenuPhase::Recording),
        Phase::Paused => Some(RecordingMenuPhase::Paused),
        Phase::Finalizing => Some(RecordingMenuPhase::Finalizing),
        Phase::Failed if snapshot.error == Some(happier_desktop_native::capture::CaptureError::Cancelled) => None,
        Phase::Failed => Some(RecordingMenuPhase::Failed),
        Phase::Ready => None,
    };
    let projection = phase.map(|phase| RecordingMenu { phase,
        duration_ms: snapshot.timing.duration_ms, active_since_ms: snapshot.timing.active_since_ms });
    let clock = {
        let Ok(mut inner) = state.0.lock() else { return; };
        if inner.model.recording == projection { return; }
        inner.model.recording = projection;
        inner.recording_clock.take()
    };
    // Lifecycle resources stop before the capture publisher announces pause/settlement. Joining
    // this thread never invokes native APIs; it only enqueues main-thread work.
    drop(clock);
    // Capture publishes under its operation mutex. Only native menu effects are deferred; the
    // callback reads the current model so an older queued phase cannot recreate a stopped clock.
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || apply_recording(&handle)) {
        log::warn!("failed to present recording tray state: {error}");
    }
}

fn apply_recording(app: &AppHandle) {
    let Some(state) = app.try_state::<TrayState>() else { return; };
    let model = {
        let Ok(inner) = state.0.lock() else { return; };
        inner.model.clone()
    };
    if let Err(error) = super::rebuild_menu(app, &model) {
        log::warn!("failed to present recording tray state: {error}");
    }
    // Install the clock while holding the same mutex that consumes terminal facts. A concurrent
    // settlement either prevents this start or takes and joins the clock before it publishes.
    let Ok(mut inner) = state.0.lock() else { return; };
    if inner.recording_clock.is_some() { return; }
    let Some(recording) = inner.model.recording
        .filter(|recording| recording.next_tick_ms(epoch_ms()).is_some()) else { return; };
    let (stop, wake) = mpsc::channel();
    let handle = app.clone();
    let task = std::thread::spawn(move || {
        while let Some(delay_ms) = recording.next_tick_ms(epoch_ms()) {
            match wake.recv_timeout(Duration::from_millis(delay_ms)) {
                Err(mpsc::RecvTimeoutError::Timeout) => {},
                _ => break,
            }
            let update = handle.clone();
            if handle.run_on_main_thread(move || {
                let Some(state) = update.try_state::<TrayState>() else { return; };
                let item = state.0.lock().ok().and_then(|inner| {
                    // An already queued clock callback has no effect once its recording is paused or settled.
                    (inner.model.recording == Some(recording)).then(|| {
                        Some((inner.recording_elapsed.clone(), recording.label(&inner.model.labels, epoch_ms()), inner.model.labels.clone()))
                    }).flatten()
                });
                if let Some((item, label, labels)) = item {
                    if let Some(item) = item {
                        if let Err(error) = item.set_text(label) { log::warn!("failed to update recording elapsed label: {error}"); }
                    }
                    if let Err(error) = super::update_recording_title(&update, Some(recording), &labels) {
                        log::warn!("failed to update recording menu-bar timer: {error}");
                    }
                }
            }).is_err() { break; }
        }
    });
    inner.recording_clock = Some(RecordingClock { stop, task: Some(task) });
}

/// Menu commands use the very same native handle and completion publisher as Tauri commands.
pub(crate) fn recording_control(app: &AppHandle, action: crate::menu::ids::DesktopMenuAction) {
    let session = app.state::<crate::capture::CaptureState>().active_recording();
    let Some(session) = session else { return; };
    let app = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let result = match action {
            crate::menu::ids::DesktopMenuAction::PauseRecording => session.pause(),
            crate::menu::ids::DesktopMenuAction::ResumeRecording => session.resume(),
            crate::menu::ids::DesktopMenuAction::StopRecording => session.stop(),
            _ => return,
        };
        if result.is_err() {
            let notice = super::labels(&app).action_failed_title;
            super::update_model(&app, |model| model.record_status_notice(Some(notice)));
        }
    });
}
