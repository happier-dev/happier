use super::protocol::{SystemTaskEvent, SystemTaskResult};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::process::Child;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub type SharedChild = Arc<Mutex<Child>>;
const DEFAULT_MAX_COMPLETED_TASKS: usize = 64;
const DEFAULT_MAX_EVENTS_PER_TASK: usize = 200;
const DEFAULT_MAX_STDERR_PREVIEW_BYTES: usize = 4096;

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemTaskSnapshot {
    pub events: Vec<SystemTaskEvent>,
    pub result: Option<SystemTaskResult>,
}

#[derive(Clone)]
pub struct SystemTasksState {
    inner: Arc<SystemTasksStateInner>,
}

struct SystemTasksStateInner {
    next_task_id: AtomicU64,
    max_completed_tasks: usize,
    max_events_per_task: usize,
    max_stderr_preview_bytes: usize,
    tasks: Mutex<TaskStore>,
}

#[derive(Default)]
struct TaskStore {
    tasks: HashMap<String, TaskRecord>,
    completed_task_ids: VecDeque<String>,
    starting_tasks: usize,
    component_removal: ComponentRemoval,
}

#[derive(Default, PartialEq, Eq)]
enum ComponentRemoval {
    #[default]
    Idle,
    Running,
    Finished,
}

impl TaskStore {
    fn is_busy(&self) -> bool {
        self.component_removal == ComponentRemoval::Running
            || self.starting_tasks > 0
            || self.tasks.values().any(|task| task.child.is_some())
    }
}

pub(crate) struct TaskStartReservation(SystemTasksState);

impl Drop for TaskStartReservation {
    fn drop(&mut self) {
        if let Ok(mut store) = self.0.lock_tasks() {
            store.starting_tasks -= 1;
        }
    }
}

struct TaskRecord {
    child: Option<SharedChild>,
    cancel_requested: bool,
    snapshot: SystemTaskSnapshot,
    stderr_preview: Vec<u8>,
}

impl SystemTasksState {
    /// A result can arrive before the executor exits. Keep quit held until the real child
    /// is released, including task starts and synchronous component cleanup.
    pub(crate) fn is_busy(&self) -> Result<bool, String> {
        Ok(self.lock_tasks()?.is_busy())
    }

    pub(crate) fn reserve_start(&self) -> Result<TaskStartReservation, String> {
        let mut store = self.lock_tasks()?;
        if store.component_removal != ComponentRemoval::Idle {
            return Err("Desktop component cleanup is in progress or complete. Quit the app before starting more system tasks.".to_string());
        }
        store.starting_tasks += 1;
        Ok(TaskStartReservation(self.clone()))
    }

    pub(crate) fn run_component_cleanup(
        &self,
        cleanup: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        {
            let mut store = self.lock_tasks()?;
            if store.component_removal != ComponentRemoval::Idle {
                return Err(
                    "Desktop component cleanup is already in progress or complete.".to_string(),
                );
            }
            if store.is_busy() {
                return Err("A system task is still running. Wait for it to finish, then retry desktop component cleanup.".to_string());
            }
            store.component_removal = ComponentRemoval::Running;
        }
        let result = cleanup();
        self.lock_tasks()?.component_removal = if result.is_ok() {
            ComponentRemoval::Finished
        } else {
            ComponentRemoval::Idle
        };
        result
    }

    pub fn new(max_completed_tasks: usize) -> Self {
        Self {
            inner: Arc::new(SystemTasksStateInner {
                next_task_id: AtomicU64::default(),
                max_completed_tasks,
                max_events_per_task: DEFAULT_MAX_EVENTS_PER_TASK,
                max_stderr_preview_bytes: DEFAULT_MAX_STDERR_PREVIEW_BYTES,
                tasks: Mutex::new(TaskStore::default()),
            }),
        }
    }

    pub fn allocate_task_id(&self) -> String {
        let sequence = self.inner.next_task_id.fetch_add(1, Ordering::SeqCst) + 1;
        format!("system_task_{sequence}")
    }

    pub fn insert_running_task(&self, task_id: &str, child: SharedChild) -> Result<(), String> {
        let mut task_store = self.lock_tasks()?;
        task_store.tasks.insert(
            task_id.to_string(),
            TaskRecord {
                child: Some(child),
                cancel_requested: false,
                snapshot: SystemTaskSnapshot::default(),
                stderr_preview: Vec::new(),
            },
        );
        Ok(())
    }

    pub fn append_event(&self, task_id: &str, event: SystemTaskEvent) -> Result<(), String> {
        let mut task_store = self.lock_tasks()?;
        let Some(record) = task_store.tasks.get_mut(task_id) else {
            return Ok(());
        };
        if record.snapshot.result.is_none() {
            // Byte samples are current state, not an event log. Keep phase boundaries and
            // intervening prompts while replacing the last sample from this acquisition phase.
            if let Some(index) = record
                .snapshot
                .events
                .iter()
                .rposition(|previous| previous.event_type == "cli.acquisition.progress")
            {
                let previous = &record.snapshot.events[index];
                if replaceable_acquisition_sample(previous, &event) {
                    record.snapshot.events.remove(index);
                }
            }
            record.snapshot.events.push(event);
            let max_events = self.inner.max_events_per_task;
            if record.snapshot.events.len() > max_events {
                let overflow = record.snapshot.events.len() - max_events;
                record.snapshot.events.drain(0..overflow);
            }
        }
        Ok(())
    }

    pub fn complete_task(&self, task_id: &str, result: SystemTaskResult) -> Result<bool, String> {
        let mut task_store = self.lock_tasks()?;
        let record = task_store
            .tasks
            .entry(task_id.to_string())
            .or_insert_with(TaskRecord::default);
        if record.snapshot.result.is_some() {
            return Ok(false);
        }
        record.snapshot.result = Some(result);
        task_store.completed_task_ids.push_back(task_id.to_string());
        evict_completed_tasks(&mut task_store, self.inner.max_completed_tasks);
        Ok(true)
    }

    pub fn append_stderr_preview_bytes(&self, task_id: &str, bytes: &[u8]) -> Result<(), String> {
        if bytes.is_empty() {
            return Ok(());
        }

        let mut task_store = self.lock_tasks()?;
        let Some(record) = task_store.tasks.get_mut(task_id) else {
            return Ok(());
        };
        if record.snapshot.result.is_some() {
            return Ok(());
        }

        record.stderr_preview.extend_from_slice(bytes);

        let max_bytes = self.inner.max_stderr_preview_bytes;
        if record.stderr_preview.len() > max_bytes {
            let overflow = record.stderr_preview.len() - max_bytes;
            record.stderr_preview.drain(0..overflow);
        }

        Ok(())
    }

    pub fn read_stderr_preview_bytes(&self, task_id: &str) -> Result<Vec<u8>, String> {
        let task_store = self.lock_tasks()?;
        Ok(task_store
            .tasks
            .get(task_id)
            .map(|record| record.stderr_preview.clone())
            .unwrap_or_default())
    }

    pub fn request_cancel(&self, task_id: &str) -> Result<Option<SharedChild>, String> {
        let mut task_store = self.lock_tasks()?;
        let Some(record) = task_store.tasks.get_mut(task_id) else {
            return Ok(None);
        };
        record.cancel_requested = true;
        Ok(record.child.clone())
    }

    pub fn running_child(&self, task_id: &str) -> Result<Option<SharedChild>, String> {
        let task_store = self.lock_tasks()?;
        Ok(task_store
            .tasks
            .get(task_id)
            .and_then(|record| record.child.clone()))
    }

    pub fn is_cancel_requested(&self, task_id: &str) -> Result<bool, String> {
        let task_store = self.lock_tasks()?;
        Ok(task_store
            .tasks
            .get(task_id)
            .map(|record| record.cancel_requested)
            .unwrap_or(false))
    }

    pub fn mark_finished(&self, task_id: &str) -> Result<(), String> {
        let mut task_store = self.lock_tasks()?;
        if let Some(record) = task_store.tasks.get_mut(task_id) {
            record.child = None;
        }
        evict_completed_tasks(&mut task_store, self.inner.max_completed_tasks);
        Ok(())
    }

    pub fn snapshot(&self, task_id: &str) -> Result<SystemTaskSnapshot, String> {
        let task_store = self.lock_tasks()?;
        Ok(task_store
            .tasks
            .get(task_id)
            .map(|record| record.snapshot.clone())
            .unwrap_or_default())
    }

    fn lock_tasks(&self) -> Result<std::sync::MutexGuard<'_, TaskStore>, String> {
        self.inner
            .tasks
            .lock()
            .map_err(|_| "SystemTasksState poisoned.".to_string())
    }
}

fn replaceable_acquisition_sample(previous: &SystemTaskEvent, next: &SystemTaskEvent) -> bool {
    if next.event_type != "cli.acquisition.progress" || previous.step_id != next.step_id {
        return false;
    }
    let (Some(previous_data), Some(next_data)) = (previous.data.as_ref(), next.data.as_ref())
    else {
        return false;
    };
    previous_data
        .get("receivedBytes")
        .and_then(|value| value.as_u64())
        .is_some()
        && next_data
            .get("receivedBytes")
            .and_then(|value| value.as_u64())
            .is_some()
        && previous_data.get("failure").is_none()
        && next_data.get("failure").is_none()
        && previous_data
            .get("phase")
            .and_then(|value| value.as_str())
            .is_some()
        && previous_data.get("phase") == next_data.get("phase")
}

fn evict_completed_tasks(task_store: &mut TaskStore, max_completed_tasks: usize) {
    while task_store.completed_task_ids.len() > max_completed_tasks {
        let Some(task_id) = task_store.completed_task_ids.pop_front() else {
            break;
        };
        let should_remove = task_store
            .tasks
            .get(&task_id)
            .map(|record| record.snapshot.result.is_some() && record.child.is_none())
            .unwrap_or(false);
        if should_remove {
            task_store.tasks.remove(&task_id);
        } else if task_store.tasks.contains_key(&task_id) {
            // A result can precede process exit. Keep its retention entry until
            // mark_finished releases the child, then retry the existing eviction.
            task_store.completed_task_ids.push_front(task_id);
            break;
        }
    }
}

impl Default for TaskRecord {
    fn default() -> Self {
        Self {
            child: None,
            cancel_requested: false,
            snapshot: SystemTaskSnapshot::default(),
            stderr_preview: Vec::new(),
        }
    }
}

impl Default for SystemTasksState {
    fn default() -> Self {
        Self::new(DEFAULT_MAX_COMPLETED_TASKS)
    }
}

#[cfg(test)]
mod tests {
    use super::{SharedChild, SystemTasksState};
    use crate::system_tasks::protocol::{
        build_failure_result, SystemTaskEvent, SystemTaskResult, SystemTaskSuccessResult,
        SYSTEM_TASK_PROTOCOL_VERSION,
    };
    use std::process::{Command, Stdio};
    use std::sync::{Arc, Mutex};

    fn spawn_test_child() -> SharedChild {
        let child = Command::new("node")
            .arg("-e")
            .arg("setTimeout(() => {}, 60_000)")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("test child should spawn");
        Arc::new(Mutex::new(child))
    }

    fn kill_test_child(child: SharedChild) {
        if let Ok(mut guard) = child.lock() {
            let _ = guard.kill();
            let _ = guard.wait();
        }
    }

    fn build_event(task_id: &str, message: &str) -> SystemTaskEvent {
        SystemTaskEvent {
            protocol_version: SYSTEM_TASK_PROTOCOL_VERSION,
            task_id: task_id.to_string(),
            ts_ms: 1,
            event_type: "progress".to_string(),
            step_id: Some("install.runtime".to_string()),
            message: Some(message.to_string()),
            data: None,
        }
    }

    #[test]
    fn component_cleanup_excludes_task_starts_and_keeps_success_closed() {
        let state = SystemTasksState::default();
        assert!(!state.is_busy().unwrap());
        state.run_component_cleanup(|| {
            assert!(state.reserve_start().is_err(), "cleanup must exclude task starts");
            assert!(state.is_busy().unwrap(), "quit must wait for component cleanup");
            Ok(())
        }).unwrap();
        assert!(!state.is_busy().unwrap(), "completed cleanup must allow quit");
        assert!(state.reserve_start().is_err(), "successful cleanup must block reacquisition until exit");
    }

    #[test]
    fn component_cleanup_rejects_running_tasks_and_allows_retry_after_failure() {
        let state = SystemTasksState::default();
        let child = spawn_test_child();
        state.insert_running_task("busy", child.clone()).unwrap();
        let result = state.run_component_cleanup(|| panic!("busy cleanup must have no side effects"));
        kill_test_child(child);
        assert!(result.is_err());
        state.mark_finished("busy").unwrap();
        assert!(state.run_component_cleanup(|| Err("retry".to_string())).is_err());
        assert!(!state.is_busy().unwrap(), "failed cleanup must allow quit after its executor returns");
        assert!(state.reserve_start().is_ok(), "failed cleanup must permit recovery");
    }

    #[test]
    fn component_cleanup_waits_for_spawn_reservations_and_real_process_exit() {
        let state = SystemTasksState::default();
        let reservation = state.reserve_start().unwrap();
        assert!(state.is_busy().unwrap(), "quit must wait for task startup");
        assert!(state.run_component_cleanup(|| panic!("spawn is in progress")).is_err());
        drop(reservation);
        assert!(!state.is_busy().unwrap());
        let child = spawn_test_child();
        state.insert_running_task("finishing", child.clone()).unwrap();
        state.complete_task("finishing", build_failure_result("finishing", "failed", "done")).unwrap();
        assert!(state.is_busy().unwrap(), "a result must not allow quit before process exit");
        let result = state.run_component_cleanup(|| panic!("result precedes actual process exit"));
        kill_test_child(child);
        assert!(result.is_err());
        state.mark_finished("finishing").unwrap();
        assert!(!state.is_busy().unwrap(), "real process exit must permit quit");
        state.run_component_cleanup(|| Ok(())).unwrap();
    }

    #[test]
    fn completed_snapshot_retention_waits_for_real_process_exit() {
        let state = SystemTasksState::new(0);
        let child = spawn_test_child();
        state.insert_running_task("finishing", child.clone()).unwrap();
        state.complete_task("finishing", build_failure_result("finishing", "failed", "done")).unwrap();
        assert!(state.snapshot("finishing").unwrap().result.is_some());
        kill_test_child(child);
        state.mark_finished("finishing").unwrap();
        assert!(state.snapshot("finishing").unwrap().result.is_none());
    }

    #[test]
    fn preserves_event_order_in_snapshots() {
        let state = SystemTasksState::default();
        let child = spawn_test_child();
        state
            .insert_running_task("task_1", child.clone())
            .expect("task should insert");
        state
            .append_event("task_1", build_event("task_1", "first"))
            .expect("event should append");
        state
            .append_event("task_1", build_event("task_1", "second"))
            .expect("event should append");

        let snapshot = state.snapshot("task_1").expect("snapshot should load");

        assert_eq!(snapshot.events.len(), 2);
        assert_eq!(snapshot.events[0].message.as_deref(), Some("first"));
        assert_eq!(snapshot.events[1].message.as_deref(), Some("second"));
        kill_test_child(child);
    }

    #[test]
    fn acquisition_byte_samples_replace_each_other_without_evicting_milestones() {
        let state = SystemTasksState::default();
        let child = spawn_test_child();
        state.insert_running_task("task_1", child.clone()).unwrap();
        state
            .append_event("task_1", build_event("task_1", "prepare"))
            .unwrap();
        for received in 0..1000 {
            let mut event = build_event("task_1", "download");
            event.event_type = "cli.acquisition.progress".to_string();
            event.data =
                Some(serde_json::json!({"phase": "downloading", "receivedBytes": received}));
            state.append_event("task_1", event).unwrap();
        }
        state
            .append_event("task_1", build_event("task_1", "unpack"))
            .unwrap();
        let snapshot = state.snapshot("task_1").unwrap();
        kill_test_child(child);
        assert_eq!(snapshot.events.len(), 3);
        assert_eq!(snapshot.events[0].message.as_deref(), Some("prepare"));
        assert_eq!(
            snapshot.events[1].data.as_ref().unwrap()["receivedBytes"],
            999
        );
        assert_eq!(snapshot.events[2].message.as_deref(), Some("unpack"));
    }

    #[test]
    fn ignores_late_events_after_completion() {
        let state = SystemTasksState::default();
        let child = spawn_test_child();
        state
            .insert_running_task("task_1", child.clone())
            .expect("task should insert");
        let result = SystemTaskResult::Success(SystemTaskSuccessResult {
            protocol_version: SYSTEM_TASK_PROTOCOL_VERSION,
            task_id: "task_1".to_string(),
            ok: true,
            data: None,
        });

        state
            .complete_task("task_1", result)
            .expect("task should complete");
        state
            .append_event("task_1", build_event("task_1", "late"))
            .expect("event append should not fail");

        let snapshot = state.snapshot("task_1").expect("snapshot should load");
        assert!(snapshot.events.is_empty());
        kill_test_child(child);
    }

    #[test]
    fn returns_stable_snapshot_for_failed_tasks() {
        let state = SystemTasksState::default();

        state
            .complete_task(
                "task_1",
                build_failure_result("task_1", "cancelled", "Task cancelled."),
            )
            .expect("task should complete");

        let snapshot = state.snapshot("task_1").expect("snapshot should load");

        match snapshot.result.expect("result should exist") {
            SystemTaskResult::Failure(failure) => assert_eq!(failure.error.code, "cancelled"),
            _ => panic!("expected failure result"),
        }
    }

    #[test]
    fn ignores_events_for_unknown_task_ids() {
        let state = SystemTasksState::default();
        state
            .append_event("unknown_task", build_event("unknown_task", "ignored"))
            .expect("append should not fail");

        let snapshot = state
            .snapshot("unknown_task")
            .expect("snapshot should load");
        assert!(snapshot.events.is_empty());
        assert!(snapshot.result.is_none());
    }

    #[test]
    fn caps_event_history_per_task() {
        const EXPECTED_MAX_EVENTS: usize = 200;

        let state = SystemTasksState::default();
        let child = spawn_test_child();
        state
            .insert_running_task("task_1", child.clone())
            .expect("task should insert");

        for idx in 0..(EXPECTED_MAX_EVENTS + 25) {
            state
                .append_event("task_1", build_event("task_1", &format!("event-{idx}")))
                .expect("event should append");
        }

        let snapshot = state.snapshot("task_1").expect("snapshot should load");
        assert_eq!(snapshot.events.len(), EXPECTED_MAX_EVENTS);
        assert_eq!(
            snapshot.events[0].message.as_deref(),
            Some("event-25"),
            "oldest events should be truncated"
        );
        let expected_last = format!("event-{}", EXPECTED_MAX_EVENTS + 24);
        assert_eq!(
            snapshot.events[EXPECTED_MAX_EVENTS - 1].message.as_deref(),
            Some(expected_last.as_str()),
            "newest events should be retained"
        );
        kill_test_child(child);
    }

    #[test]
    fn evicts_oldest_completed_snapshots_when_retention_limit_is_reached() {
        let state = SystemTasksState::new(1);

        state
            .complete_task(
                "task_1",
                SystemTaskResult::Success(SystemTaskSuccessResult {
                    protocol_version: SYSTEM_TASK_PROTOCOL_VERSION,
                    task_id: "task_1".to_string(),
                    ok: true,
                    data: None,
                }),
            )
            .expect("first task should complete");
        state
            .complete_task(
                "task_2",
                SystemTaskResult::Success(SystemTaskSuccessResult {
                    protocol_version: SYSTEM_TASK_PROTOCOL_VERSION,
                    task_id: "task_2".to_string(),
                    ok: true,
                    data: None,
                }),
            )
            .expect("second task should complete");

        let evicted_snapshot = state.snapshot("task_1").expect("snapshot should load");
        let retained_snapshot = state.snapshot("task_2").expect("snapshot should load");

        assert!(evicted_snapshot.events.is_empty());
        assert!(evicted_snapshot.result.is_none());
        assert!(retained_snapshot.result.is_some());
    }
}
