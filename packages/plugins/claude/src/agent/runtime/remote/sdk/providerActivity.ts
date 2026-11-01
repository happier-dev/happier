import { readClaudeTaskLifecycleEnvelope } from '../../../transcripts/taskNotification.js';
import { readClaudeProviderIdentityValue, readClaudeTranscriptProviderSessionId } from '../../../../protocol/providerIdentity.js';
import { normalizeClaudeAgentSdkProviderTaskId } from './providerTaskStatus.js';
import type { SDKHookResponseMessage } from '../../../sdk/types.js';

export type ClaudeProviderTaskIdentity = Readonly<{ sessionId: string; taskId: string }>;
export type ClaudeProviderTaskActivity =
  | (ClaudeProviderTaskIdentity & Readonly<{
    type: 'started';
    admission?: 'launch' | 'resume' | 'known-resume';
    confirmsActivity?: false;
    /** The Agent that owns this task, from the typed SDK `task_started` row. */
    parentTaskId?: string;
  }>)
  | (ClaudeProviderTaskIdentity & Readonly<{
    type: 'progress';
    confirmsActivity?: false;
    source?: 'system-task-progress';
  }>)
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

function readHookTaskActivity(
  row: Readonly<Record<string, unknown>>,
  contextualSessionId?: string,
): ClaudeProviderTaskActivity | null {
  const eventName = readHookEventName(row);
  if (!eventName) return null;
  const sessionId = readClaudeProviderIdentityValue(row.session_id)
    ?? readClaudeProviderIdentityValue(row.sessionId)
    ?? readClaudeProviderIdentityValue(contextualSessionId);
  if (!sessionId) return null;

  const sidechainAgentId = normalizeClaudeAgentSdkProviderTaskId(row.agent_id);
  if (eventName === 'StopFailure') {
    return sidechainAgentId
      ? { type: 'terminal', terminalStatus: 'failed', sessionId, taskId: sidechainAgentId }
      : null;
  }
  if (eventName === 'SubagentStart') {
    return sidechainAgentId
      ? { type: 'started', admission: 'known-resume', sessionId, taskId: sidechainAgentId }
      : null;
  }
  if (eventName === 'SubagentStop') {
    return sidechainAgentId
      ? { type: 'progress', sessionId, taskId: sidechainAgentId }
      : null;
  }
  if (eventName !== 'PostToolUse') return null;
  if (sidechainAgentId) return { type: 'progress', sessionId, taskId: sidechainAgentId };

  const toolName = readToolName(row);
  const response = readToolResponse(row);
  if (!toolName || !response) return null;

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
      ? { type: 'terminal', terminalStatus: 'stopped', sessionId, taskId: requestedTaskId }
      : null;
  }

  return null;
}

export function readClaudeProviderTaskToolTarget(
  toolName: string,
  toolInput: unknown,
  sessionId: string | null | undefined,
): ClaudeProviderTaskIdentity | null {
  if (toolName !== 'TaskStop' && toolName !== 'TaskOutput') return null;
  const input = record(toolInput);
  const taskId = input ? readTaskId(input) : null;
  const nativeSessionId = readClaudeProviderIdentityValue(sessionId);
  return taskId && nativeSessionId ? { sessionId: nativeSessionId, taskId } : null;
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
  const currentSessionId = readClaudeProviderIdentityValue(currentProviderSessionId);
  if (
    !row
    || !currentSessionId
    || !isSdkHookResponseMessage(row)
    || readClaudeProviderIdentityValue(row.session_id) !== currentSessionId
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
  const envelope = readClaudeTaskLifecycleEnvelope(row);
  if (envelope?.taskId && !(row.type === 'system' && (row.subtype === 'task_started' || row.subtype === 'task_notification'))) {
    const sessionId = envelope.sourceSessionId ?? readClaudeProviderIdentityValue(contextualSessionId);
    if (sessionId) {
      const taskId = envelope.taskId;
      const status = envelope.status;
      const terminal = status === 'complete' ? 'completed' : status === 'failed' ? 'failed'
        : status === 'cancelled' ? 'stopped' : null;
      if (envelope.subtype === 'async-launch') return { type: 'started', admission: 'launch', sessionId, taskId };
      if (envelope.resumed) return { type: 'started', admission: envelope.knownOnly ? 'known-resume' : 'resume', sessionId, taskId };
      if (terminal) return { type: 'terminal', terminalStatus: terminal, sessionId, taskId };
      if (status === 'active') return { type: 'progress', sessionId, taskId,
        ...(envelope.subtype === 'handback' || envelope.knownOnly ? { confirmsActivity: false as const } : {}) };
    }
  }
  const hookActivity = readHookTaskActivity(row, contextualSessionId);
  if (hookActivity) return hookActivity;
  if (row.type !== 'system') return null;
  const sessionId = readClaudeTranscriptProviderSessionId(row)
    ?? readClaudeProviderIdentityValue(contextualSessionId);
  const taskId = normalizeClaudeAgentSdkProviderTaskId(row.task_id);
  if (!sessionId || !taskId) return null;
  if (row.subtype === 'task_started') {
    if (row.task_type !== 'local_workflow' && row.task_type !== 'local_bash'
      && !(row.task_type === 'local_agent' && row.is_backgrounded === true)) return null;
    const parentTaskId = normalizeClaudeAgentSdkProviderTaskId(row.parent_task_id);
    return { type: 'started', admission: 'launch', sessionId, taskId, ...withParent(parentTaskId ?? undefined) };
  }
  if (row.subtype === 'task_progress') return { type: 'progress', sessionId, taskId, source: 'system-task-progress' };
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

function withParent(parentTaskId: string | undefined): { parentTaskId?: string } {
  return parentTaskId ? { parentTaskId } : {};
}

export function createClaudeProviderActivityLedger(options?: ClaudeProviderActivityLedgerOptions) {
  type LedgerEntry = ClaudeProviderTaskIdentity & Readonly<{
    phase: 'active' | 'terminal_before_confirmation';
    observed: boolean;
    backgroundConfirmed: boolean;
    ownerScope?: object;
    requiresOwnerConfirmation?: true;
    parentTaskId?: string;
    /**
     * Claude reports an Agent `completed` each time it stops, including when it stops to wait on
     * background children it still owns; it wakes when they settle. Such an Agent is not active,
     * but its query keeps observing so the wake is read, and only its own typed progress may
     * reactivate it.
     */
    awaitingChildren?: true;
  }>;
  const entries = new Map<string, LedgerEntry>();
  let observationPhase: 'observing' | 'lost' | 'stopped' = 'observing';
  type ToolCall = Readonly<{ target?: ClaudeProviderTaskIdentity; targetOwner?: object }>;
  type OwnerObservation =
    | { kind: 'query'; observed: boolean; toolCalls: Map<string, ToolCall> }
    | { kind: 'completed-query' }
    | { kind: 'terminal'; observed: boolean }
    | { kind: 'source-baseline'; observed: false };
  const ownerObservations = new Map<object, OwnerObservation>();

  const activeEntries = (ownerScope?: object): LedgerEntry[] => [...entries.values()]
    .filter((entry) => entry.phase === 'active'
      && (ownerScope === undefined || entry.ownerScope === undefined || entry.ownerScope === ownerScope));
  const unsettledEntries = (ownerScope?: object): LedgerEntry[] => [...entries.values()]
    .filter((entry) => (entry.phase === 'active' || entry.awaitingChildren === true)
      && (ownerScope === undefined || entry.ownerScope === undefined || entry.ownerScope === ownerScope));
  /** A child still owns live work while active or while it waits on its own children. */
  const hasLiveChild = (identity: ClaudeProviderTaskIdentity): boolean => [...entries.values()].some((entry) =>
    entry.parentTaskId === identity.taskId
    && entry.sessionId === identity.sessionId
    && (entry.phase === 'active' || entry.awaitingChildren === true));

  const getSnapshot = (): ClaudeProviderActivitySnapshot => {
    const activeCount = activeEntries().filter((entry) => entry.observed).length;
    if (activeCount > 0) return { state: 'active', activeCount };
    return observationPhase !== 'lost' && ![...ownerObservations.values()].some((owner) => owner.kind !== 'completed-query' && !owner.observed) && activeEntries().length === 0
      ? { state: 'idle', activeCount: 0 }
      : { state: 'unknown', activeCount: 0 };
  };

  const notifyIfChanged = (previous: ClaudeProviderActivitySnapshot): void => {
    const next = getSnapshot();
    if (previous.state === next.state && previous.activeCount === next.activeCount) return;
    options?.onSnapshotChanged?.(next);
  };

  return Object.freeze({
    registerOwner(ownerScope: object): void {
      ownerObservations.set(ownerScope, { kind: 'query', observed: true, toolCalls: new Map() });
    },
    completeQueryObservation(ownerScope: object): void {
      // A final native result closes observation, but physical custody remains until process exit.
      const owner = ownerObservations.get(ownerScope);
      if (owner?.kind !== 'query' || !owner.observed || unsettledEntries(ownerScope).length > 0) return;
      const previous = getSnapshot();
      ownerObservations.set(ownerScope, { kind: 'completed-query' });
      notifyIfChanged(previous);
    },
    registerTerminalOwner(ownerScope: object): void {
      ownerObservations.set(ownerScope, { kind: 'terminal', observed: true });
    },
    isTerminalOwnerObserved(ownerScope: object): boolean {
      const owner = ownerObservations.get(ownerScope);
      return owner?.kind === 'terminal' && owner.observed;
    },
    getRegisteredTerminalOwners(): object[] {
      return [...ownerObservations].flatMap(([scope, owner]) => owner.kind === 'terminal' ? [scope] : []);
    },
    noteSourceBaselinePending(sourceScope: object): void {
      const previous = getSnapshot();
      ownerObservations.set(sourceScope, { kind: 'source-baseline', observed: false });
      notifyIfChanged(previous);
    },
    noteSourceBaselineComplete(sourceScope: object): void {
      if (ownerObservations.get(sourceScope)?.kind !== 'source-baseline') return;
      const previous = getSnapshot();
      ownerObservations.delete(sourceScope);
      notifyIfChanged(previous);
    },
    observeToolUse(ownerScope: object, toolUseId: string, target: ClaudeProviderTaskIdentity | null): void {
      const owner = ownerObservations.get(ownerScope);
      if (owner?.kind !== 'query') return;
      const targetOwner = target ? entries.get(keyOf(target))?.ownerScope : undefined;
      owner.toolCalls.set(toolUseId, target ? { target, ...(targetOwner ? { targetOwner } : {}) } : {});
    },
    resolveToolUse(toolUseId: string): Readonly<{ ownerScope: object; target?: ClaudeProviderTaskIdentity; targetOwner?: object }> | null {
      let match: Readonly<{ ownerScope: object; target?: ClaudeProviderTaskIdentity; targetOwner?: object }> | null = null;
      for (const [ownerScope, owner] of ownerObservations) {
        if (owner.kind !== 'query') continue;
        const toolCall = owner.toolCalls.get(toolUseId);
        if (!toolCall) continue;
        if (match) return null;
        match = { ownerScope, ...toolCall };
      }
      return match;
    },
    getRegisteredQueryOwners(): object[] {
      return [...ownerObservations].flatMap(([ownerScope, owner]) =>
        owner.kind === 'query' || owner.kind === 'completed-query' ? [ownerScope] : []);
    },
    getProviderTaskOwner(identity: ClaudeProviderTaskIdentity): object | undefined {
      const entry = entries.get(keyOf(identity));
      return entry?.phase === 'active' ? entry.ownerScope : undefined;
    },
    apply(activity: ClaudeProviderTaskActivity, ownerScope?: object): boolean {
      if (ownerScope === undefined && observationPhase === 'stopped') return false;
      if (ownerScope !== undefined) {
        const owner = ownerObservations.get(ownerScope);
        if (!owner || (owner.kind !== 'query' && owner.kind !== 'terminal')) return false;
      }
      const previous = getSnapshot();
      const key = keyOf(activity);
      if (activity.type === 'terminal') {
        const current = entries.get(key);
        if (current?.phase === 'active') {
          if (current.ownerScope !== undefined && current.ownerScope !== ownerScope) return false;
          // Only a completed stop can be interim; a failed or stopped Agent never wakes.
          const awaitsChildren = activity.terminalStatus === 'completed' && hasLiveChild(activity);
          entries.set(key, {
            sessionId: activity.sessionId,
            taskId: activity.taskId,
            phase: 'terminal_before_confirmation',
            observed: false,
            backgroundConfirmed: true,
            ...(current.ownerScope ? { requiresOwnerConfirmation: true as const } : {}),
            ...(awaitsChildren
              ? { awaitingChildren: true as const, ...(current.ownerScope ? { ownerScope: current.ownerScope } : {}) }
              : {}),
            ...withParent(current.parentTaskId),
          });
        } else if (current?.awaitingChildren === true && activity.terminalStatus !== 'completed') {
          if (current.ownerScope !== undefined && current.ownerScope !== ownerScope) return false;
          // A later stop/failure settles the pending wake; duplicate completed rows do not.
          const { awaitingChildren: _settled, ownerScope: _owner, ...terminal } = current;
          entries.set(key, terminal);
        } else {
          if (!current) {
            entries.set(key, {
              sessionId: activity.sessionId,
              taskId: activity.taskId,
              phase: 'terminal_before_confirmation',
              observed: false,
              backgroundConfirmed: false,
              ...(ownerScope ? { requiresOwnerConfirmation: true as const } : {}),
            });
          }
          return false;
        }
      } else if (activity.type === 'progress') {
        if (activity.confirmsActivity === false) return false;
        const current = entries.get(key);
        if (
          current?.phase === 'terminal_before_confirmation'
          && current.awaitingChildren === true
          && activity.source === 'system-task-progress'
          && (current.ownerScope === undefined || current.ownerScope === ownerScope)
        ) {
          entries.set(key, {
            sessionId: current.sessionId,
            taskId: current.taskId,
            phase: 'active',
            observed: true,
            backgroundConfirmed: true,
            ...(current.ownerScope ? { ownerScope: current.ownerScope } : {}),
            ...withParent(current.parentTaskId),
          });
          notifyIfChanged(previous);
          return true;
        }
        if (current?.phase !== 'active') return false;
        if (current.ownerScope !== undefined && current.ownerScope !== ownerScope) return false;
        if (current.observed && (ownerScope === undefined || current.ownerScope !== undefined)) return false;
        entries.set(key, { ...current, observed: true, ...(ownerScope ? { ownerScope } : {}) });
      } else {
        const current = entries.get(key);
        if (activity.admission === 'known-resume' && (!current || !current.backgroundConfirmed)) return false;
        if (ownerScope === undefined && (current?.ownerScope !== undefined || current?.requiresOwnerConfirmation)) return false;
        if (current?.phase === 'active' && ownerScope !== undefined && current.ownerScope !== undefined
          && current.ownerScope !== ownerScope && activity.admission !== 'resume' && activity.admission !== 'known-resume') return false;
        // Hook and typed launches race; only the typed row carries the owning Agent.
        const parentLink = withParent(current?.parentTaskId ?? activity.parentTaskId);
        if (current?.phase === 'active' && current.observed) {
          const confirmsOwner = ownerScope !== undefined && (current.ownerScope === undefined
            || activity.admission === 'resume' || activity.admission === 'known-resume');
          if (!confirmsOwner || current.ownerScope === ownerScope) {
            if (parentLink.parentTaskId !== current.parentTaskId) entries.set(key, { ...current, ...parentLink });
            return false;
          }
          entries.set(key, { ...current, ...parentLink, ownerScope });
          return true;
        }
        if (current?.phase === 'terminal_before_confirmation' && activity.admission !== 'resume' && activity.admission !== 'known-resume') {
          // A late real launch proves background membership without undoing its settled outcome.
          if (!current.backgroundConfirmed) entries.set(key, { ...current, backgroundConfirmed: true });
          return false;
        }
        entries.set(key, {
          sessionId: activity.sessionId,
          taskId: activity.taskId,
          phase: 'active',
          observed: activity.confirmsActivity !== false,
          backgroundConfirmed: true,
          ...(ownerScope ? { ownerScope } : current?.ownerScope ? { ownerScope: current.ownerScope } : {}),
          ...parentLink,
        });
      }
      notifyIfChanged(previous);
      return true;
    },
    getSnapshot,
    getActiveProviderTasks(ownerScope?: object): readonly ClaudeProviderTaskIdentity[] {
      return activeEntries(ownerScope).map(({ sessionId, taskId }) => ({ sessionId, taskId }));
    },
    getActiveProviderTaskCount(): number {
      return activeEntries().length;
    },
    hasActiveProviderTasks(ownerScope?: object): boolean {
      return activeEntries(ownerScope).length > 0;
    },
    /** Active tasks plus Agents awaiting their own children: the query must keep observing them. */
    hasUnsettledProviderTasks(ownerScope?: object): boolean {
      return unsettledEntries(ownerScope).length > 0;
    },
    hasProviderTask(identity: ClaudeProviderTaskIdentity): boolean {
      return entries.get(keyOf(identity))?.phase === 'active';
    },
    noteObservationLost(ownerScope?: object): void {
      // An ended whole provider cannot be made live or unknown by its delayed observer callbacks.
      if (ownerScope === undefined && observationPhase === 'stopped') return;
      const scopedOwner = ownerScope === undefined ? undefined : ownerObservations.get(ownerScope);
      if (ownerScope !== undefined && (!scopedOwner || scopedOwner.kind === 'completed-query')) return;
      const previous = getSnapshot();
      if (ownerScope === undefined) observationPhase = 'lost';
      else {
        const owner = ownerObservations.get(ownerScope);
        if (owner && owner.kind !== 'completed-query') owner.observed = false;
      }
      // Unresolved identities remain available for exact task operations. Only fresh native
      // evidence about an individual task can restore its current activity after observer loss.
      for (const [key, entry] of entries) {
        if (entry.phase === 'active' && (ownerScope === undefined || entry.ownerScope === ownerScope)) {
          entries.set(key, { ...entry, observed: false });
        }
      }
      notifyIfChanged(previous);
    },
    noteProviderStopped(ownerScope?: object): void {
      if (ownerScope !== undefined && ownerObservations.get(ownerScope)?.kind === 'source-baseline') return;
      const previous = getSnapshot();
      if (ownerScope !== undefined) ownerObservations.delete(ownerScope);
      for (const [key, entry] of entries) {
        if (entry.awaitingChildren === true && (ownerScope === undefined || entry.ownerScope === ownerScope)) {
          // A stopped provider cannot wake an Agent that was waiting on its children.
          const { awaitingChildren: _released, ownerScope: _owner, ...settled } = entry;
          entries.set(key, settled);
          continue;
        }
        if (entry.phase !== 'active') continue;
        if (ownerScope !== undefined && entry.ownerScope !== ownerScope) continue;
        entries.set(key, {
          sessionId: entry.sessionId,
          taskId: entry.taskId,
          phase: 'terminal_before_confirmation',
          observed: false,
          backgroundConfirmed: entry.backgroundConfirmed,
          ...(entry.ownerScope || entry.requiresOwnerConfirmation ? { requiresOwnerConfirmation: true as const } : {}),
        });
      }
      if (ownerScope === undefined) {
        ownerObservations.clear();
        observationPhase = 'stopped';
      }
      notifyIfChanged(previous);
    },
  });
}
