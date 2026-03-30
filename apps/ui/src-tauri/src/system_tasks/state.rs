use super::protocol::{SystemTaskEvent, SystemTaskResult};
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::process::Child;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

pub type SharedChild = Arc<Mutex<Child>>;
const DEFAULT_MAX_COMPLETED_TASKS: usize = 64;

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
}

impl SystemTasksState {
    pub fn new(max_completed_tasks: usize) -> Self {
        Self {
            inner: Arc::new(SystemTasksStateInner {
                next_task_id: AtomicU64::default(),
                max_completed_tasks,
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
            },
        );
        Ok(())
    }

    pub fn append_event(&self, task_id: &str, event: SystemTaskEvent) -> Result<(), String> {
        let mut task_store = self.lock_tasks()?;
        let record = task_store
            .tasks
            .entry(task_id.to_string())
            .or_insert_with(TaskRecord::default);
        if record.snapshot.result.is_none() {
            record.snapshot.events.push(event);
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
    use super::SystemTasksState;
    use crate::system_tasks::protocol::{
        build_failure_result, SystemTaskEvent, SystemTaskResult, SystemTaskSuccessResult,
        SYSTEM_TASK_PROTOCOL_VERSION,
    };

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
    }

    #[test]
    fn ignores_late_events_after_completion() {
        let state = SystemTasksState::default();
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
