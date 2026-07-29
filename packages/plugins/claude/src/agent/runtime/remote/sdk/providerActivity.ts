import { normalizeClaudeAgentSdkProviderTaskId } from './providerTaskStatus.js';
import type { SDKHookResponseMessage } from '../../../sdk/types.js';

export type ClaudeProviderTaskIdentity = Readonly<{ sessionId: string; taskId: string }>;
export type ClaudeProviderTaskActivity =
  | (ClaudeProviderTaskIdentity & Readonly<{
    type: 'started';
    admission?: 'launch' | 'resume';
  }>)
  | (ClaudeProviderTaskIdentity & Readonly<{ type: 'progress' }>)
  | (ClaudeProviderTaskIdentity & Readonly<{
    type: 'terminal';
    terminalStatus?: 'completed' | 'failed' | 'stopped';
  }>);
export type ClaudeProviderTaskInterruptTarget = Readonly<{
  type: 'active' | 'terminal';
  taskId: string;
}>;
export type ClaudeProviderTaskEvent = Readonly<{
  activity: ClaudeProviderTaskActivity | null;
  interruptTarget: ClaudeProviderTaskInterruptTarget | null;
}>;

export type ClaudeProviderActivitySnapshot = Readonly<
  | { state: 'active'; activeCount: number }
  | { state: 'idle'; activeCount: 0 }
  | { state: 'unknown'; activeCount: 0 }
>;

export type ClaudeProviderActivityLedgerOptions = Readonly<{
  onSnapshotChanged?: (snapshot: ClaudeProviderActivitySnapshot) => void;
}>;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function normalizedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function terminalStatus(value: unknown): 'completed' | 'failed' | 'stopped' | null {
  if (value === 'completed' || value === 'failed' || value === 'stopped') return value;
  return value === 'killed' ? 'stopped' : null;
}

function taskNotificationTerminalStatus(value: unknown): 'completed' | 'failed' | 'stopped' | null {
  return value === 'completed' || value === 'failed' || value === 'stopped' ? value : null;
}

function taskUpdatedTerminalStatus(value: unknown): 'completed' | 'failed' | 'stopped' | null {
  if (value === 'completed' || value === 'failed') return value;
  return value === 'killed' ? 'stopped' : null;
}

function readHookEventName(row: Readonly<Record<string, unknown>>): string | null {
  return normalizedString(row.hook_event_name)
    ?? normalizedString(row.hookEventName)
    ?? normalizedString(row.eventName);
}

function readToolName(row: Readonly<Record<string, unknown>>): string | null {
  return normalizedString(row.tool_name) ?? normalizedString(row.toolName);
}

function readToolInput(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | null {
  return record(row.tool_input) ?? record(row.toolInput);
}

function readToolResponse(row: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | null {
  return record(row.tool_response)
    ?? record(row.toolResponse)
    ?? record(row.tool_use_result)
    ?? record(row.toolUseResult);
}

function readTaskId(row: Readonly<Record<string, unknown>>): string | null {
  return normalizeClaudeAgentSdkProviderTaskId(
    row.task_id ?? row.taskId ?? row.agent_id ?? row.agentId,
  );
}

function isFailedToolResponse(response: Readonly<Record<string, unknown>>): boolean {
  if (response.success === false || response.is_error === true || response.isError === true) return true;
  if (response.error !== undefined && response.error !== null) return true;
  const status = normalizedString(response.status)?.toLowerCase();
  return status === 'failed' || status === 'error' || status === 'denied' || status === 'rejected';
}

function readHookTaskActivity(
  row: Readonly<Record<string, unknown>>,
  contextualSessionId?: string,
): ClaudeProviderTaskActivity | null {
  const eventName = readHookEventName(row);
  if (!eventName) return null;
  const sessionId = normalizedString(row.session_id)
    ?? normalizedString(row.sessionId)
    ?? normalizedString(contextualSessionId);
  if (!sessionId) return null;

  const sidechainAgentId = normalizeClaudeAgentSdkProviderTaskId(row.agent_id);
  if (eventName === 'StopFailure') {
    return sidechainAgentId
      ? { type: 'terminal', terminalStatus: 'failed', sessionId, taskId: sidechainAgentId }
      : null;
  }
  if (eventName === 'SubagentStart') {
    return sidechainAgentId
      ? { type: 'progress', sessionId, taskId: sidechainAgentId }
      : null;
  }
  if (eventName === 'SubagentStop') {
    return sidechainAgentId
      ? { type: 'terminal', terminalStatus: 'stopped', sessionId, taskId: sidechainAgentId }
      : null;
  }
  if (eventName !== 'PostToolUse' || sidechainAgentId) return null;

  const toolName = readToolName(row);
  const response = readToolResponse(row);
  if (!toolName || !response) return null;

  if (toolName === 'Agent') {
    if (response.status === 'async_launched') {
      const taskId = normalizeClaudeAgentSdkProviderTaskId(response.agentId ?? response.agent_id);
      return taskId ? { type: 'started', admission: 'launch', sessionId, taskId } : null;
    }
    if (response.status === 'remote_launched') {
      const taskId = normalizeClaudeAgentSdkProviderTaskId(response.taskId ?? response.task_id);
      return taskId ? { type: 'started', admission: 'launch', sessionId, taskId } : null;
    }
    return null;
  }

  if (toolName === 'Workflow') {
    if (response.status !== 'async_launched' && response.status !== 'remote_launched') return null;
    const taskId = normalizeClaudeAgentSdkProviderTaskId(response.taskId);
    return taskId ? { type: 'started', admission: 'launch', sessionId, taskId } : null;
  }

  if (toolName === 'SendMessage') {
    if (isFailedToolResponse(response)) return null;
    const taskId = normalizeClaudeAgentSdkProviderTaskId(
      response.resumedAgentId ?? response.resumed_agent_id,
    );
    return taskId ? { type: 'started', admission: 'resume', sessionId, taskId } : null;
  }

  const input = readToolInput(row);
  const requestedTaskId = input ? readTaskId(input) : null;
  if (!requestedTaskId) return null;

  if (toolName === 'TaskOutput') {
    if (response.retrieval_status !== 'success' && response.retrievalStatus !== 'success') return null;
    const nestedTask = record(response.task);
    if (!nestedTask || readTaskId(nestedTask) !== requestedTaskId) return null;
    const status = terminalStatus(nestedTask.status);
    return status
      ? { type: 'terminal', terminalStatus: status, sessionId, taskId: requestedTaskId }
      : null;
  }

  if (toolName === 'TaskStop') {
    const nestedTask = record(response.task) ?? response;
    if (readTaskId(nestedTask) !== requestedTaskId) return null;
    const status = terminalStatus(nestedTask.status);
    return status
      ? { type: 'terminal', terminalStatus: status, sessionId, taskId: requestedTaskId }
      : null;
  }

  return null;
}

export function isReplayClaudeAgentSdkMessage(value: unknown): boolean {
  const row = record(value);
  return row?.isReplay === true || row?.is_replay === true;
}

function isSdkHookResponseMessage(
  value: Readonly<Record<string, unknown>>,
): value is Readonly<Record<string, unknown>> & SDKHookResponseMessage {
  return value.type === 'system'
    && value.subtype === 'hook_response'
    && (value.outcome === 'success' || value.outcome === 'error' || value.outcome === 'cancelled');
}

export function isClaudeProviderActivityHookObservationLoss(
  value: unknown,
  currentProviderSessionId: string | null | undefined,
): boolean {
  const row = record(value);
  const currentSessionId = normalizedString(currentProviderSessionId);
  if (
    !row
    || !currentSessionId
    || !isSdkHookResponseMessage(row)
    || normalizedString(row.session_id) !== currentSessionId
    || isReplayClaudeAgentSdkMessage(row)
  ) return false;

  const hookEvent = normalizedString(row.hook_event);
  if (hookEvent !== 'PostToolUse' && hookEvent !== 'SubagentStart' && hookEvent !== 'SubagentStop') {
    return false;
  }
  return row.outcome !== 'success';
}

function readStrictClaudeProviderTaskActivity(
  value: unknown,
  contextualSessionId?: string,
): ClaudeProviderTaskActivity | null {
  const row = record(value);
  if (!row) return null;
  const hookActivity = readHookTaskActivity(row, contextualSessionId);
  if (hookActivity) return hookActivity;
  if (row.type !== 'system') return null;
  const sessionId = normalizedString(row.session_id) ?? normalizedString(contextualSessionId);
  const taskId = normalizeClaudeAgentSdkProviderTaskId(row.task_id);
  if (!sessionId || !taskId) return null;
  if (row.subtype === 'task_started') {
    if (row.task_type !== 'local_workflow' && row.task_type !== 'local_bash') return null;
    return { type: 'started', admission: 'launch', sessionId, taskId };
  }
  if (row.subtype === 'task_progress') return { type: 'progress', sessionId, taskId };
  if (row.subtype === 'task_notification') {
    const status = taskNotificationTerminalStatus(row.status);
    if (status) return { type: 'terminal', terminalStatus: status, sessionId, taskId };
  }
  const taskUpdatedStatus = record(row.patch)?.status;
  if (row.subtype === 'task_updated') {
    const status = taskUpdatedTerminalStatus(taskUpdatedStatus);
    if (status) return { type: 'terminal', terminalStatus: status, sessionId, taskId };
  }
  return null;
}

/**
 * Separates strict provider-activity evidence from the broader provider-native task identity
 * accepted for an exact stop_task request.
 */
export function normalizeClaudeProviderTaskEvent(
  value: unknown,
  contextualSessionId?: string,
): ClaudeProviderTaskEvent {
  const row = record(value);
  if (!row || isReplayClaudeAgentSdkMessage(row)) {
    return { activity: null, interruptTarget: null };
  }

  const activity = readStrictClaudeProviderTaskActivity(row, contextualSessionId);
  if (activity) {
    return {
      activity,
      interruptTarget: {
        type: activity.type === 'terminal' ? 'terminal' : 'active',
        taskId: activity.taskId,
      },
    };
  }

  const response = readToolResponse(row);
  const launchedTaskId = response
    && (response.status === 'async_launched' || response.status === 'remote_launched')
    ? readTaskId(response)
    : null;
  if (launchedTaskId) {
    return {
      activity: null,
      interruptTarget: { type: 'active', taskId: launchedTaskId },
    };
  }

  if (row.type === 'system') {
    const taskId = readTaskId(row);
    if (taskId && (row.subtype === 'task_started' || row.subtype === 'task_progress')) {
      return {
        activity: null,
        interruptTarget: { type: 'active', taskId },
      };
    }
    if (taskId && row.subtype === 'task_notification' && taskNotificationTerminalStatus(row.status)) {
      return {
        activity: null,
        interruptTarget: { type: 'terminal', taskId },
      };
    }
    if (taskId && row.subtype === 'task_updated') {
      return {
        activity: null,
        interruptTarget: {
          type: taskUpdatedTerminalStatus(record(row.patch)?.status) ? 'terminal' : 'active',
          taskId,
        },
      };
    }
  }

  return { activity: null, interruptTarget: null };
}

/** Reads the installed Claude SDK's typed task rows and authenticated hook payloads. */
export function readClaudeProviderTaskActivity(
  value: unknown,
  contextualSessionId?: string,
): ClaudeProviderTaskActivity | null {
  return normalizeClaudeProviderTaskEvent(value, contextualSessionId).activity;
}

function keyOf(identity: ClaudeProviderTaskIdentity): string {
  return JSON.stringify([identity.sessionId, identity.taskId]);
}

export function createClaudeProviderActivityLedger(options?: ClaudeProviderActivityLedgerOptions) {
  type LedgerEntry = ClaudeProviderTaskIdentity & Readonly<{
    phase: 'active' | 'terminal_before_confirmation';
  }>;
  const entries = new Map<string, LedgerEntry>();
  let observationGapFree = true;

  const activeEntries = (): LedgerEntry[] => [...entries.values()]
    .filter((entry) => entry.phase === 'active');

  const getSnapshot = (): ClaudeProviderActivitySnapshot => {
    const activeCount = activeEntries().length;
    if (activeCount > 0) return { state: 'active', activeCount };
    return observationGapFree
      ? { state: 'idle', activeCount: 0 }
      : { state: 'unknown', activeCount: 0 };
  };

  const notifyIfChanged = (previous: ClaudeProviderActivitySnapshot): void => {
    const next = getSnapshot();
    if (previous.state === next.state && previous.activeCount === next.activeCount) return;
    options?.onSnapshotChanged?.(next);
  };

  return Object.freeze({
    apply(activity: ClaudeProviderTaskActivity): boolean {
      const previous = getSnapshot();
      const key = keyOf(activity);
      if (activity.type === 'terminal') {
        const current = entries.get(key);
        if (current?.phase === 'active') {
          entries.set(key, {
            sessionId: activity.sessionId,
            taskId: activity.taskId,
            phase: 'terminal_before_confirmation',
          });
        } else {
          if (!current) {
            entries.set(key, {
              sessionId: activity.sessionId,
              taskId: activity.taskId,
              phase: 'terminal_before_confirmation',
            });
          }
          return false;
        }
      } else if (activity.type === 'progress') {
        return false;
      } else {
        const current = entries.get(key);
        if (current?.phase === 'active') return false;
        if (current?.phase === 'terminal_before_confirmation' && activity.admission !== 'resume') {
          return false;
        }
        entries.set(key, {
          sessionId: activity.sessionId,
          taskId: activity.taskId,
          phase: 'active',
        });
      }
      notifyIfChanged(previous);
      return true;
    },
    getSnapshot,
    getActiveProviderTasks(): readonly ClaudeProviderTaskIdentity[] {
      return activeEntries().map(({ sessionId, taskId }) => ({ sessionId, taskId }));
    },
    getActiveProviderTaskCount(): number {
      return activeEntries().length;
    },
    hasActiveProviderTasks(): boolean {
      return activeEntries().length > 0;
    },
    hasProviderTask(identity: ClaudeProviderTaskIdentity): boolean {
      return entries.get(keyOf(identity))?.phase === 'active';
    },
    noteObservationLost(): void {
      const previous = getSnapshot();
      observationGapFree = false;
      notifyIfChanged(previous);
    },
  });
}
