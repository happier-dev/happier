//! Desktop capture operation, native effects and local reference transport.
mod commands;
mod annotation;
pub use annotation::*;
mod displays;
mod selection_host;
mod recording;
pub use recording::*;
mod recovery;
pub use recovery::*;
mod recent_commands;
pub use recent_commands::*;
mod permission_commands;
pub use permission_commands::*;
mod permission_placement;
mod permission_drag;
pub use permission_drag::*;
mod preferences;
mod intents;
pub(super) mod triggers;
pub(super) mod shortcuts;
#[cfg(target_os = "linux")]
mod session;
mod preference_commands;
pub use preference_commands::*;
pub use commands::*;
pub(crate) use commands::library_folder;

use happier_desktop_native::capture::{acquire_still, files::CaptureFiles, CancelSignal, CaptureDisclosure,
    CaptureBackend, CaptureError, CaptureResult, CaptureTarget, Inventory};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::Path, sync::{Arc, Mutex}};

pub const CAPTURE_EVENT: &str = "desktopCapture://state";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMode { Still, Recording }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSessionTarget {
    pub server_id: String,
    pub account_id: String,
    pub session_id: String,
}

#[derive(Clone, PartialEq, Eq)]
pub struct CaptureStartOptions {
    pub target_session: Option<CaptureSessionTarget>,
    pub present_capture_window: bool,
    pub include_window_shadow: bool,
}
impl Default for CaptureStartOptions {
    fn default() -> Self { Self { target_session: None, present_capture_window: true, include_window_shadow: false } }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum CaptureSnapshot {
    Idle,
    Selecting { operation_ref: u64, mode: CaptureMode, inventory: Inventory },
    SystemSelection { operation_ref: u64, mode: CaptureMode },
    Acquiring { operation_ref: u64 },
    Selected { operation_ref: u64, target: CaptureTarget, inventory: Inventory },
    Recording { operation_ref: u64, recording: happier_desktop_native::capture::recording::Snapshot,
        /// Where the control stands; known once the source is prepared, absent for a portal source.
        #[serde(skip_serializing_if = "Option::is_none")]
        origin: Option<happier_desktop_native::capture::CaptureOrigin> },
    Completed { operation_ref: u64, result: CaptureResult,
        #[serde(skip_serializing_if = "Option::is_none")]
        target_session: Option<CaptureSessionTarget> },
    Cancelled,
    Unavailable { reason: CaptureError },
    Failed { reason: CaptureError },
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureDeliveryState {
    pub in_use: bool,
    pub disclosure: Option<CaptureDisclosure>,
    pub window_text: Option<happier_desktop_native::capture::window_text::WindowTextOutcome>,
    pub prepared_recording: Option<happier_desktop_native::capture::files::PreparedRecording>,
}
impl CaptureSnapshot {
    pub fn operation_ref(&self) -> Option<u64> {
        match self { Self::Selecting { operation_ref, .. } | Self::SystemSelection { operation_ref, .. } | Self::Acquiring { operation_ref }
            | Self::Selected { operation_ref, .. } | Self::Recording { operation_ref, .. }
            | Self::Completed { operation_ref, .. } => Some(*operation_ref),
            _ => None }
    }
}

struct Active {
    id: u64,
    mode: CaptureMode,
    backend: Option<Arc<dyn CaptureBackend>>,
    inventory: Inventory,
    cancel: CancelSignal,
    recording: Option<Arc<happier_desktop_native::capture::recording::Session>>,
    recording_document: Option<serde_json::Value>,
    trim_cancel: Option<CancelSignal>,
    options: CaptureStartOptions,
}
struct Operation {
    next_id: u64,
    active: Option<Active>,
    pending_targets: Option<(Arc<dyn CaptureBackend>, Inventory)>,
    snapshot: CaptureSnapshot,
    last_start: Option<CaptureStartRequest>,
    completed: HashMap<String, Completed>,
    window_label: String,
}
struct Completed {
    active: Option<Active>,
    snapshot: CaptureSnapshot,
    window_label: Option<String>,
    annotation_ready: bool,
    annotation_requests: HashMap<u64, tokio::sync::oneshot::Sender<serde_json::Value>>,
    next_annotation_request_id: u64,
}
impl Default for Operation {
    fn default() -> Self { Self { next_id: 0, active: None, pending_targets: None, snapshot: CaptureSnapshot::Idle, last_start: None,
        completed: HashMap::new(), window_label: crate::desktop_window::CAPTURE_WINDOW_LABEL.into() } }
}
impl Operation {
    fn is_current_capture(&self, capture_ref: &str) -> bool {
        matches!(&self.snapshot, CaptureSnapshot::Completed { result, .. } if result.capture_ref == capture_ref)
    }
    fn is_current_recording(&self, capture_ref: &str) -> bool {
        self.completed.get(capture_ref).is_some_and(|completed| completed.active.is_some() && matches!(&completed.snapshot, CaptureSnapshot::Completed { result, .. }
            if result.capture_ref == capture_ref && result.kind == happier_desktop_native::capture::MediaKind::Video)
        )
    }
    fn assign_window(&mut self, id: u64) {
        self.window_label = self.available_window_label(id);
    }
    fn available_window_label(&self, id: u64) -> String {
        if (self.active.is_some() && self.window_label == crate::desktop_window::CAPTURE_WINDOW_LABEL)
            || self.completed.values().any(|completed| completed.window_label.as_deref() == Some(crate::desktop_window::CAPTURE_WINDOW_LABEL)) {
            format!("capture_{id}")
        } else { crate::desktop_window::CAPTURE_WINDOW_LABEL.into() }
    }
}
type Publisher = Arc<dyn Fn(&CaptureSnapshot, bool, bool, &str, bool) + Send + Sync>;
#[derive(Default)]
struct Shared {
    operation: Mutex<Operation>,
    files: Mutex<CaptureFiles>,
    preferences: Mutex<Option<preferences::CapturePreferences>>,
    recents: Mutex<recent_commands::RecentState>,
    permissions: Mutex<happier_desktop_native::capture::permissions::PermissionOwner>,
    publisher: Mutex<Option<Publisher>>,
}
/// Default construction does no filesystem, grant, backend, window or network work.
#[derive(Clone, Default)]
pub struct CaptureState(Arc<Shared>);

impl CaptureState {
    pub fn snapshot(&self) -> CaptureSnapshot { self.0.operation.lock().unwrap().snapshot.clone() }
    pub fn current_window_label(&self) -> String { self.0.operation.lock().unwrap().window_label.clone() }
    pub fn previous_window_label(&self, caller_label: &str, visible_labels: &[String]) -> Option<String> {
        let operation = self.0.operation.lock().unwrap();
        let completed = operation.completed.values().filter_map(|completed| {
            Some((completed.snapshot.operation_ref()?, completed.window_label.as_ref()?))
        });
        let active = operation.active.as_ref().map(|active| (active.id, &operation.window_label));
        completed.chain(active).filter(|(_, label)| label.as_str() != caller_label && visible_labels.contains(label))
            .max_by_key(|(operation_ref, _)| *operation_ref).map(|(_, label)| label.clone())
    }
    pub fn snapshot_for_capture(&self, capture_ref: &str) -> Option<CaptureSnapshot> {
        self.0.operation.lock().unwrap().completed.get(capture_ref).map(|completed| completed.snapshot.clone())
    }
    pub fn snapshot_for_window(&self, label: &str) -> CaptureSnapshot {
        let op = self.0.operation.lock().unwrap();
        if let Some(completed) = op.completed.values().find(|completed| completed.window_label.as_deref() == Some(label)) {
            return completed.snapshot.clone();
        }
        if op.window_label == label && op.active.is_some() { return op.snapshot.clone(); }
        if op.window_label == label && matches!(op.snapshot, CaptureSnapshot::Failed { .. } | CaptureSnapshot::Unavailable { .. }) {
            return op.snapshot.clone();
        }
        CaptureSnapshot::Idle
    }
    pub fn window_label_for_capture(&self, capture_ref: &str) -> Option<String> {
        self.0.operation.lock().unwrap().completed.get(capture_ref).and_then(|completed| completed.window_label.clone())
    }
    /// Window labels remain reserved through delivery receipts and the discard Undo hold.
    pub fn release_window(&self, label: &str) {
        let mut operation = self.0.operation.lock().unwrap();
        let current_ref = match &operation.snapshot { CaptureSnapshot::Completed { result, .. } => Some(result.capture_ref.clone()), _ => None };
        operation.completed.retain(|_, completed| completed.window_label.as_deref() != Some(label));
        if current_ref.is_some_and(|capture_ref| !operation.completed.contains_key(&capture_ref)) {
            operation.snapshot = CaptureSnapshot::Idle;
        }
        if operation.window_label == label && operation.active.is_none()
            && matches!(operation.snapshot, CaptureSnapshot::Failed { .. } | CaptureSnapshot::Unavailable { .. }) {
            operation.snapshot = CaptureSnapshot::Idle;
        }
    }
    /// Closing the current preview stops its finite text read without removing
    /// the image needed by delivery or the existing discard Undo flow.
    pub fn cancel_window_text(&self) {
        let label = self.0.operation.lock().unwrap().window_label.clone();
        self.cancel_window_text_for_window(&label);
    }
    pub fn cancel_window_text_for_window(&self, label: &str) {
        let mut operation = self.0.operation.lock().unwrap();
        if operation.window_label == label && matches!(operation.snapshot, CaptureSnapshot::SystemSelection { .. }) {
            if let Some(active) = operation.active.take() { active.cancel.cancel(); }
            self.publish(&mut operation, CaptureSnapshot::Cancelled);
            return;
        }
        for completed in operation.completed.values_mut().filter(|completed| completed.window_label.as_deref() == Some(label)) {
            completed.annotation_ready = false;
            completed.annotation_requests.clear();
            let Some(active) = completed.active.as_ref() else { continue; };
            active.cancel.cancel();
            if active.options.present_capture_window {
                if let Some(cancel) = &active.trim_cancel { cancel.cancel(); }
            }
        }
    }
    pub fn capture_window_snapshot(&self) -> Option<CaptureSnapshot> {
        let op = self.0.operation.lock().unwrap();
        (matches!(op.snapshot, CaptureSnapshot::Completed { .. } | CaptureSnapshot::Recording { .. }
            | CaptureSnapshot::SystemSelection { .. } | CaptureSnapshot::Failed { .. } | CaptureSnapshot::Unavailable { .. })
            && (matches!(op.snapshot, CaptureSnapshot::SystemSelection { .. })
                || Self::presents(&op))).then(|| op.snapshot.clone())
    }
    pub fn open_file(&self, read_file: impl FnOnce(&mut CaptureFiles) -> Result<CaptureResult, CaptureError>) -> Result<CaptureResult, CaptureError> {
        let mut op = self.0.operation.lock().unwrap();
        if op.active.is_some() { return Err(CaptureError::OperationUnavailable); }
        let result = read_file(&mut self.0.files.lock().unwrap())?;
        drop(op);
        self.open(&result.capture_ref, None)?;
        Ok(result)
    }
    pub fn open(&self, capture_ref: &str, target_session: Option<CaptureSessionTarget>) -> Result<CaptureSnapshot, CaptureError> {
        // Explicit reopen waits for any old cancelled read off the GUI thread,
        // before taking the operation lock or rearming its cancellation signal.
        let text = self.0.files.lock().unwrap().window_text(capture_ref)?;
        let mut text = text.lock().unwrap();
        let mut op = self.0.operation.lock().unwrap();
        let is_latest = op.is_current_capture(capture_ref);
        if let Some(id) = op.completed.get(capture_ref).filter(|completed| completed.active.is_some() && completed.window_label.is_none())
            .and_then(|completed| completed.active.as_ref().map(|active| active.id)) {
            let label = op.available_window_label(id);
            let completed = op.completed.get_mut(capture_ref).unwrap();
            completed.window_label = Some(label);
            completed.active.as_mut().unwrap().options.present_capture_window = true;
        }
        if let Some(completed) = op.completed.get_mut(capture_ref).filter(|completed| completed.active.is_some()) {
            if let CaptureSnapshot::Completed { operation_ref, result, target_session: current_target } = &completed.snapshot {
                let next = CaptureSnapshot::Completed { operation_ref: *operation_ref, result: result.clone(),
                    target_session: target_session.or_else(|| current_target.clone()) };
                let cancel = CancelSignal::default();
                text.resume(cancel.clone());
                completed.active.as_mut().unwrap().cancel = cancel;
                if completed.snapshot != next {
                    completed.snapshot = next.clone();
                    self.notify_completed(completed, is_latest);
                }
                if is_latest { op.snapshot = next.clone(); }
                return Ok(next);
            }
        }
        if op.active.is_some() { return Err(CaptureError::OperationUnavailable); }
        let result = self.0.files.lock().unwrap().describe(capture_ref)?;
        let cancel = CancelSignal::default();
        text.resume(cancel.clone());
        Ok(self.adopt_result(&mut op, result, target_session, cancel))
    }
    fn adopt_result(&self, op: &mut Operation, result: CaptureResult,
        target_session: Option<CaptureSessionTarget>, cancel: CancelSignal) -> CaptureSnapshot {
        op.next_id += 1;
        let id = op.next_id;
        op.assign_window(id);
        op.pending_targets = None;
        op.active = Some(Active { id, mode: CaptureMode::Still, backend: None,
            inventory: Inventory { displays: Vec::new(), windows: Vec::new() }, cancel, recording: None, recording_document: None, trim_cancel: None,
            options: CaptureStartOptions::default() });
        self.publish(op, CaptureSnapshot::Completed { operation_ref: id, result, target_session })
    }
    pub fn settle(&self, capture_ref: &str) -> Result<CaptureSnapshot, CaptureError> {
        let mut op = self.0.operation.lock().unwrap();
        let Some(completed) = op.completed.get_mut(capture_ref) else {
            return Ok(op.snapshot.clone());
        };
        let Some(active) = completed.active.take() else { return Ok(op.snapshot.clone()); };
        active.cancel.cancel();
        if let Some(cancel) = &active.trim_cancel { cancel.cancel(); }
        completed.annotation_ready = false;
        completed.annotation_requests.clear();
        completed.snapshot = CaptureSnapshot::Idle;
        let window_label = completed.window_label.clone();
        if window_label.is_none() { op.completed.remove(capture_ref); }
        // Settlement releases native custody before the Action result returns.
        // The Capture renderer still owns its visible delivery receipt until hide.
        if op.is_current_capture(capture_ref) {
            op.snapshot = CaptureSnapshot::Idle;
            if let Some(publish) = self.0.publisher.lock().unwrap().as_ref() {
                publish(&CaptureSnapshot::Idle, false, false, window_label.as_deref().unwrap_or(""), true);
            }
        }
        Ok(CaptureSnapshot::Idle)
    }
    pub fn delivery_state(&self, capture_ref: &str) -> Result<CaptureDeliveryState, CaptureError> {
        let op = self.0.operation.lock().unwrap();
        let in_use = op.completed.get(capture_ref).and_then(|completed| completed.active.as_ref())
            .is_some_and(|active| active.options.present_capture_window);
        drop(op);
        let files = self.0.files.lock().unwrap();
        let disclosure = files.disclosure(capture_ref)?;
        let prepared_recording = files.prepared_recording(capture_ref)?;
        let text = files.window_text(capture_ref)?;
        drop(files);
        let window_text = text.lock().unwrap().settled();
        Ok(CaptureDeliveryState { in_use, disclosure, window_text, prepared_recording })
    }
    pub fn window_text_for_read(&self, capture_ref: &str, capture_preview: bool)
        -> Result<Arc<Mutex<happier_desktop_native::capture::window_text::WindowText>>, CaptureError> {
        if !capture_preview {
            let current = self.delivery_state(capture_ref)?;
            if current.in_use { return Err(CaptureError::CaptureInUse); }
            if !current.disclosure.is_some_and(|record| record.include_window_text) {
                return Err(CaptureError::BlurredCapture);
            }
        }
        self.0.files.lock().unwrap().window_text(capture_ref)
    }
    fn set_publisher(&self, publisher: Publisher) {
        let mut current = self.0.publisher.lock().unwrap();
        if current.is_none() { *current = Some(publisher); }
    }
    fn publish(&self, operation: &mut Operation, snapshot: CaptureSnapshot) -> CaptureSnapshot {
        self.publish_with_presentation(operation, snapshot, None)
    }
    fn publish_with_presentation(&self, operation: &mut Operation, snapshot: CaptureSnapshot,
        present: Option<bool>) -> CaptureSnapshot {
        if operation.snapshot != snapshot {
            let presentation_start = match (&operation.snapshot, &snapshot) {
                (CaptureSnapshot::Completed { operation_ref: previous, .. }, CaptureSnapshot::Completed { operation_ref: next, .. })
                | (CaptureSnapshot::Recording { operation_ref: previous, .. }, CaptureSnapshot::Recording { operation_ref: next, .. }) => previous != next,
                (_, CaptureSnapshot::Completed { .. } | CaptureSnapshot::Recording { .. } | CaptureSnapshot::SystemSelection { .. }
                    | CaptureSnapshot::Failed { .. } | CaptureSnapshot::Unavailable { .. }) => true,
                _ => false,
            };
            operation.snapshot = snapshot.clone();
            if let CaptureSnapshot::Completed { result, .. } = &snapshot {
                if let Some(mut active) = operation.active.take() {
                    active.backend = None;
                    active.inventory.windows.clear();
                    active.recording = None;
                    operation.completed.insert(result.capture_ref.clone(), Completed {
                        window_label: active.options.present_capture_window.then(|| operation.window_label.clone()),
                        active: Some(active), snapshot: snapshot.clone(),
                        annotation_ready: false, annotation_requests: HashMap::new(), next_annotation_request_id: 0,
                    });
                }
            }
            self.notify_with_presentation(operation, present, presentation_start);
        }
        snapshot
    }
    fn notify_current(&self, operation: &Operation) {
        self.notify_with_presentation(operation, None, false);
    }
    fn presents(operation: &Operation) -> bool {
        operation.active.as_ref().map(|active| active.options.present_capture_window)
            .or_else(|| match &operation.snapshot {
                CaptureSnapshot::Completed { result, .. } => operation.completed.get(&result.capture_ref)
                    .and_then(|completed| completed.active.as_ref()).map(|active| active.options.present_capture_window), _ => None,
            })
            .or_else(|| operation.last_start.as_ref().map(|request| request.options.present_capture_window)).unwrap_or(true)
    }
    fn notify_with_presentation(&self, operation: &Operation, present: Option<bool>, presentation_start: bool) {
        // Publication occurs under the operation lock, in the same order as mutations.
        if let Some(publish) = self.0.publisher.lock().unwrap().as_ref() {
            let present = present.unwrap_or_else(|| Self::presents(operation));
            publish(&operation.snapshot, present, presentation_start
                && (present || matches!(operation.snapshot, CaptureSnapshot::SystemSelection { .. })), &operation.window_label, true);
        }
    }
    fn notify_completed(&self, completed: &Completed, current_operation: bool) {
        if let Some(publish) = self.0.publisher.lock().unwrap().as_ref() {
            publish(&completed.snapshot, completed.active.as_ref().is_some_and(|active| active.options.present_capture_window), false,
                completed.window_label.as_deref().unwrap_or(""), current_operation);
        }
    }
    pub fn begin(&self, mode: CaptureMode,
        make_backend: impl FnOnce() -> Result<Arc<dyn CaptureBackend>, CaptureError>) -> Result<CaptureSnapshot, CaptureError> {
        self.begin_once(mode, None, CaptureStartOptions::default(), make_backend).map(|(snapshot, _)| snapshot)
    }
    fn begin_once(&self, mode: CaptureMode, target: Option<&CaptureTarget>,
        options: CaptureStartOptions,
        make_backend: impl FnOnce() -> Result<Arc<dyn CaptureBackend>, CaptureError>) -> Result<(CaptureSnapshot, bool), CaptureError> {
        let mut op = self.0.operation.lock().unwrap();
        if op.active.is_some() { return Ok((op.snapshot.clone(), false)); }
        let next_id = op.next_id + 1;
        op.assign_window(next_id);
        op.last_start = Some(CaptureStartRequest { mode, target: target.cloned(), options: options.clone() });
        // A frontmost trigger observes the foreground now, never a previous
        // target-list snapshot retained by an unrelated picker.
        if matches!(target, Some(CaptureTarget::Frontmost)) { op.pending_targets = None; }
        let (backend, inventory) = match op.pending_targets.take() {
            Some(pending) => pending,
            None => {
                let backend = match make_backend() {
                    Ok(backend) => backend,
                    Err(reason) => return Ok((self.publish(&mut op, CaptureSnapshot::Unavailable { reason }), false)),
                };
                let inventory = match target.map_or_else(|| backend.discover(), |target| backend.discover_target(target)) {
                    Ok(inventory) => inventory,
                    Err(reason) => return Ok((self.publish(&mut op, CaptureSnapshot::Unavailable { reason }), false)),
                };
                (backend, inventory)
            }
        };
        op.next_id += 1;
        let id = op.next_id;
        op.active = Some(Active { id, mode, backend: Some(backend), inventory: inventory.clone(), cancel: CancelSignal::default(), recording: None, recording_document: None, trim_cancel: None, options });
        Ok((self.publish(&mut op, CaptureSnapshot::Selecting { operation_ref: id, mode, inventory }), true))
    }
    pub fn targets(&self, make_backend: impl FnOnce() -> Result<Arc<dyn CaptureBackend>, CaptureError>) -> Result<Inventory, CaptureError> {
        let mut op = self.0.operation.lock().unwrap();
        if let Some(active) = &op.active { return Ok(active.inventory.clone()); }
        if let Some((_, inventory)) = &op.pending_targets { return Ok(inventory.clone()); }
        let backend = make_backend()?;
        let inventory = backend.discover()?;
        // The descriptors carry transient native references until start consumes them.
        op.pending_targets = Some((backend, inventory.clone()));
        Ok(inventory)
    }
    pub fn start_with_target(&self, mode: CaptureMode, target: Option<CaptureTarget>,
        options: CaptureStartOptions,
        make_backend: impl FnOnce() -> Result<Arc<dyn CaptureBackend>, CaptureError>, folder: &Path,
        hide_selection: impl FnOnce() -> Result<(), CaptureError>,
        show_selection: impl FnOnce(u64, &Inventory) -> Result<(), CaptureError>) -> Result<CaptureSnapshot, CaptureError> {
        let (snapshot, started) = self.begin_once(mode, target.as_ref(), options, make_backend)?;
        if !started { return Ok(snapshot); }
        let CaptureSnapshot::Selecting { operation_ref, inventory, .. } = &snapshot else { return Ok(snapshot); };
        if let Some(target) = target { return self.commit(*operation_ref, target, folder, hide_selection); }
        if let Err(reason) = show_selection(*operation_ref, inventory) {
            let _ = self.cancel(*operation_ref);
            return Err(reason);
        }
        Ok(snapshot)
    }
    pub fn start_portal(&self, folder: &Path, options: CaptureStartOptions,
        context: impl FnOnce() -> Option<happier_desktop_native::capture::window_text::FrontmostWindowContext>,
        request: impl FnOnce(&CancelSignal) -> Result<Vec<u8>, CaptureError>) -> Result<CaptureSnapshot, CaptureError> {
        let (id, cancel) = {
            let mut op = self.0.operation.lock().unwrap();
            if op.active.is_some() { return Ok(op.snapshot.clone()); }
            op.next_id += 1;
            let id = op.next_id;
            op.assign_window(id);
            let cancel = CancelSignal::default();
            op.pending_targets = None;
            op.active = Some(Active { id, mode: CaptureMode::Still, backend: None,
                inventory: Inventory { displays: Vec::new(), windows: Vec::new() }, cancel: cancel.clone(), recording: None, recording_document: None, trim_cancel: None, options });
            self.publish(&mut op, CaptureSnapshot::Acquiring { operation_ref: id });
            (id, cancel)
        };
        let context = context();
        // Consent waits without holding the operation lock, so the existing
        // cancel command can retire the one native request while it is pending.
        let response = request(&cancel);
        let mut op = self.0.operation.lock().unwrap();
        if cancel.is_cancelled() || matches!(response, Err(CaptureError::Cancelled)) {
            op.active = None;
            return Ok(self.publish(&mut op, CaptureSnapshot::Cancelled));
        }
        let result = response.and_then(|png| {
            let mut files = self.0.files.lock().unwrap();
            let result = files.write_png(folder, &png)?;
            files.bind_frontmost_window_text(&result.capture_ref, context, cancel.clone())
        });
        match result {
            Ok(result) => {
                let target_session = op.active.as_ref().and_then(|active| active.options.target_session.clone());
                Ok(self.publish(&mut op, CaptureSnapshot::Completed { operation_ref: id, result, target_session }))
            },
            Err(reason) => {
                op.active = None;
                let snapshot = if matches!(reason, CaptureError::PortalUnavailable | CaptureError::PortalDenied) {
                    CaptureSnapshot::Unavailable { reason }
                } else { CaptureSnapshot::Failed { reason } };
                Ok(self.publish(&mut op, snapshot))
            },
        }
    }
    pub fn set_selection_mode(&self, id: u64, caller_label: &str, mode: CaptureMode) -> Result<CaptureSnapshot, CaptureError> {
        let mut op = self.0.operation.lock().unwrap();
        let active = op.active.as_ref().filter(|active| active.id == id).ok_or(CaptureError::OperationUnavailable)?;
        if !matches!(op.snapshot, CaptureSnapshot::Selecting { .. })
            || !active.inventory.displays.iter().any(|display| selection_host::label(id, display.display_id) == caller_label)
        { return Err(CaptureError::OperationUnavailable); }
        let inventory = active.inventory.clone();
        op.active.as_mut().unwrap().mode = mode;
        if let Some(request) = &mut op.last_start { request.mode = mode; }
        Ok(self.publish(&mut op, CaptureSnapshot::Selecting { operation_ref: id, mode, inventory }))
    }
    pub fn commit(&self, id: u64, target: CaptureTarget, folder: &Path,
        hide_selection: impl FnOnce() -> Result<(), CaptureError>) -> Result<CaptureSnapshot, CaptureError> {
        self.commit_with_folder(id, target, || Ok(folder.to_path_buf()), hide_selection)
    }
    pub fn commit_with_folder(&self, id: u64, target: CaptureTarget,
        folder: impl FnOnce() -> Result<std::path::PathBuf, CaptureError>,
        hide_selection: impl FnOnce() -> Result<(), CaptureError>) -> Result<CaptureSnapshot, CaptureError> {
        let (backend, inventory, cancel, folder, include_window_shadow) = {
            let mut op = self.0.operation.lock().unwrap();
            let active = op.active.as_ref().filter(|active| active.id == id).ok_or(CaptureError::OperationUnavailable)?;
            if !matches!(op.snapshot, CaptureSnapshot::Selecting { .. }) { return Ok(op.snapshot.clone()); }
            let inventory = active.inventory.clone();
            let backend = active.backend.as_ref().expect("selecting operation owns a native source").clone();
            let cancel = active.cancel.clone();
            if active.mode == CaptureMode::Recording {
                hide_selection()?;
                return Ok(self.publish(&mut op, CaptureSnapshot::Selected { operation_ref: id, target, inventory }));
            }
            // Resolve the still destination under the same mode decision. A
            // selection-mode update cannot invalidate an earlier snapshot read.
            let folder = folder()?;
            let include_window_shadow = active.options.include_window_shadow;
            self.publish(&mut op, CaptureSnapshot::Acquiring { operation_ref: id });
            (backend, inventory, cancel, folder, include_window_shadow)
        };
        let acquired = hide_selection().and_then(|_| acquire_still(backend.as_ref(), &inventory, &target, include_window_shadow, &cancel))
            .and_then(|image| { let png = image.frame.png()?; Ok((image, png)) });
        let mut op = self.0.operation.lock().unwrap();
        if cancel.is_cancelled() {
            op.active = None;
            return Ok(self.publish(&mut op, CaptureSnapshot::Cancelled));
        }
        match acquired {
            Ok((image, png)) => {
                let mut files = self.0.files.lock().unwrap();
                let result = files.write_png(&folder, &png).and_then(|mut result| {
                    result.scale = Some(image.scale); result.origin = image.origin; result.source = image.source;
                    files.set_context(result.clone())?;
                    let context = result.source.as_ref().and_then(|source| source.window_id)
                        .and_then(|id| inventory.windows.iter().find(|window| window.window_id == id)).cloned();
                    files.bind_window_text(&result.capture_ref, context, cancel.clone())
                });
                match result {
                    Ok(result) => {
                        let active = op.active.as_mut().unwrap();
                        active.backend = None;
                        active.inventory.windows.clear();
                        let target_session = active.options.target_session.clone();
                        Ok(self.publish(&mut op, CaptureSnapshot::Completed { operation_ref: id, result, target_session }))
                    },
                    Err(reason) => { op.active = None; Ok(self.publish(&mut op, CaptureSnapshot::Failed { reason })) }
                }
            },
            Err(CaptureError::Cancelled) => { op.active = None; Ok(self.publish(&mut op, CaptureSnapshot::Cancelled)) },
            Err(reason) => { op.active = None; Ok(self.publish(&mut op, CaptureSnapshot::Failed { reason })) },
        }
    }
    #[cfg(any(target_os = "windows", test))]
    pub(super) fn invalidate_display_targets(&self) {
        // A retained window's DPI may change simply because it moved between
        // monitors. Withdraw requested target facts, not active selection.
        self.0.operation.lock().unwrap().pending_targets = None;
    }
    pub(super) fn invalidate_selection(&self, expected_operation: Option<u64>) -> bool {
        let mut op = self.0.operation.lock().unwrap();
        let operation_ref = match op.snapshot { CaptureSnapshot::Selecting { operation_ref, .. } => Some(operation_ref), _ => None };
        if expected_operation.is_some_and(|expected| Some(expected) != operation_ref) { return false; }
        op.pending_targets = None;
        if operation_ref.is_none() { return false; }
        if let Some(active) = op.active.take() { active.cancel.cancel(); }
        self.publish(&mut op, CaptureSnapshot::Failed { reason: CaptureError::TargetUnavailable });
        true
    }
    pub fn cancel(&self, id: u64) -> Result<CaptureSnapshot, CaptureError> {
        let mut op = self.0.operation.lock().unwrap();
        if let Some(completed) = op.completed.values().find(|completed| completed.active.as_ref().is_some_and(|active| active.id == id)) {
            let active = completed.active.as_ref().unwrap();
            active.cancel.cancel();
            if let Some(cancel) = &active.trim_cancel { cancel.cancel(); }
            return Ok(completed.snapshot.clone());
        }
        let active = op.active.as_ref().filter(|active| active.id == id).ok_or(CaptureError::OperationUnavailable)?;
        if let Some(cancel) = &active.trim_cancel { cancel.cancel(); }
        if matches!(op.snapshot, CaptureSnapshot::Completed { .. }) {
            active.cancel.cancel();
            return Ok(op.snapshot.clone());
        }
        if let Some(session) = active.recording.clone() {
            drop(op);
            // Discard stops observation, but keeps a finalized movie for P3's Undo hold.
            session.stop()?;
            return Ok(self.snapshot());
        }
        active.cancel.cancel();
        if !matches!(op.snapshot, CaptureSnapshot::Acquiring { .. }) { op.active = None; }
        Ok(self.publish(&mut op, CaptureSnapshot::Cancelled))
    }
    pub fn read_source(&self, capture_ref: &str) -> Result<Vec<u8>, CaptureError> {
        self.0.files.lock().unwrap().read_source_png(capture_ref)
    }
    pub fn discard(&self, capture_ref: &str) -> Result<(), CaptureError> {
        let mut op = self.0.operation.lock().unwrap();
        let recording = op.active.as_ref().and_then(|active| active.recording.clone())
            .filter(|session| session.snapshot().source_ref.as_deref() == Some(capture_ref));
        if let Some(session) = recording {
            drop(op);
            session.stop()?;
            op = self.0.operation.lock().unwrap();
        }
        if let Some(completed) = op.completed.get(capture_ref) {
            if let Some(active) = &completed.active {
                active.cancel.cancel();
                if let Some(cancel) = &active.trim_cancel { cancel.cancel(); }
            }
        }
        self.0.files.lock().unwrap().discard(capture_ref)?;
        if let Some(completed) = op.completed.get_mut(capture_ref) {
            completed.active = None;
            completed.annotation_ready = false;
            completed.annotation_requests.clear();
            completed.snapshot = CaptureSnapshot::Idle;
            if completed.window_label.is_none() { op.completed.remove(capture_ref); }
        }
        if matches!(&op.snapshot, CaptureSnapshot::Completed { result, .. } if result.capture_ref == capture_ref)
            || matches!(&op.snapshot, CaptureSnapshot::Recording { recording, .. } if recording.source_ref.as_deref() == Some(capture_ref)) {
            if let Some(active) = &op.active { active.cancel.cancel(); }
            op.active = None;
            op.snapshot = CaptureSnapshot::Idle;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests;
