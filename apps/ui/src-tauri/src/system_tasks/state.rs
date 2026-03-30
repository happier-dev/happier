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
}

struct TaskRecord {
    child: Option<SharedChild>,
    cancel_requested: bool,
    snapshot: SystemTaskSnapshot,
    stderr_preview: Vec<u8>,
}

impl SystemTasksState {
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
        record.child = None;
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
