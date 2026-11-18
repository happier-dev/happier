import * as React from 'react';
import { PluginError, type JsonValue, type PluginEphemeralSharedScope } from '@happier-dev/plugin-sdk';
import { pluginJsonValuesEqual, projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { usePluginHostApi, usePluginUiEphemeralSharedScope } from '@happier-dev/plugin-ui';
import type { PluginUiActionControlExecution, PluginUiHostApi } from '@happier-dev/plugin-sdk/ui';
import { mergeAbortSignals } from '@happier-dev/plugin-sdk/async';
import { TriageTaskWriteResultV1Schema, type TriageTaskWriteResultV1, type TriageEntryRefV1,
  type TriageEntryStateV1, type TriageTaskFieldsV1 } from '@happier-dev/triage-protocol/v1';
import { TRIAGE_TASKS_CREATE_ACTION_LOCAL_ID_V1, TRIAGE_TASKS_EDIT_ACTION_LOCAL_ID_V1,
  TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1, TriageEditTaskActionInputV1Schema,
  TriageTransitionTaskActionInputV1Schema, TriageCreateTaskActionInputV1Schema,
  TriageCreateTaskActionResultV1Schema, TRIAGE_TASKS_CHECK_WRITE_ACTION_LOCAL_ID_V1 } from '../../actions/tasksProtocol.js';
import { TriageMountedUiResultV1Schema } from '../../actions/mountedUiProtocol.js';
import { TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1, TriageReobserveEntryResultV1Schema } from '../../actions/reobserveEntryProtocol.js';
import { triageEntryRowKey } from '../../projection/listWindow.js';
import { TriageSetTaskOriginReviewResultV1Schema } from '../../actions/taskReviewProtocol.js';
import { TriageSetTaskOriginErrorResultV1Schema } from '../../actions/taskOriginProtocol.js';
import type { TriageCreateTaskActionInputV1 } from '../../actions/tasksProtocol.js';
import { triageTaskWriteInvocationFailureV1 } from '../../actions/taskWriteFailure.js';

type TaskAction = typeof TRIAGE_TASKS_CREATE_ACTION_LOCAL_ID_V1 | typeof TRIAGE_TASKS_EDIT_ACTION_LOCAL_ID_V1
  | typeof TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1;
type TaskExecution = Readonly<{ ok: true; result: unknown }> | Readonly<{ ok: false; error: unknown }>;
function hostTaskExecution(execution: PluginUiActionControlExecution): TaskExecution {
  if (execution.ok) return execution;
  return { ok: false, error: Object.assign(new PluginError({ code: execution.errorCode, message: execution.error,
    retryable: false, details: projectNativeJsonValueForTransport({
      ...(execution.details !== null && typeof execution.details === 'object' ? execution.details : {}),
      ...(execution.requestId === undefined ? {} : { requestId: execution.requestId }) }),
    ...(execution.failureCause === undefined ? {} : { failureCause: execution.failureCause }) }), {
    ...(execution.effectAttempted === false ? { actionHandlerInvocation: 'notStarted' } : {}),
  }) };
}
type TaskAddress = Readonly<{ entryRef: TriageEntryRefV1; sourceInstanceId: string }>;
type TaskWriteAddress = TaskAddress | Readonly<{ draftId: string }>;
type TaskWriteSnapshot = Readonly<{
  result: TriageTaskWriteResultV1 | null;
  busy: boolean;
  checking: boolean;
  /** A fresh edit read permits replacement without claiming the preceding write succeeded. */
  rebaseFields: Readonly<Partial<TriageTaskFieldsV1>> | null;
  progress: string | null;
  sessionLink: 'linked' | 'failed' | 'unknown' | null;
  linkSessionId: string | null;
  originErrorLink: 'linked' | 'failed' | 'unknown' | null;
  originError: TriageCreateTaskActionInputV1['originError'] | null;
  reviewLink: 'linked' | 'failed' | 'unknown' | null;
  originReview: TriageCreateTaskActionInputV1['originReview'] | null;
  createdEntryRef: TriageEntryRefV1 | null;
}>;
const IDLE: TaskWriteSnapshot = Object.freeze({ result: null, busy: false, checking: false, rebaseFields: null, progress: null, sessionLink: null, linkSessionId: null, originErrorLink: null, originError: null, reviewLink: null, originReview: null, createdEntryRef: null });

/** This is the mounted commit's state, shared by entry rather than by its row or detail renderer. */
function createTaskWriteOperation() {
  let snapshot = IDLE;
  let retired = false;
  let active: AbortController | null = null;
  let intent: Readonly<{ action: TaskAction; input: JsonValue; state?: TriageEntryStateV1 }> | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: TaskWriteSnapshot) => {
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  return {
    snapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    abort() { active?.abort(); },
    dispose() { retired = true; active?.abort(); listeners.clear(); },
    adoptCreated(created: TaskWriteSnapshot) {
      if (!retired && !snapshot.busy && snapshot.result === null) publish({ ...created });
    },
    observeSessionLinks(sessionIds: readonly string[]) {
      if (!retired && (snapshot.sessionLink === 'failed' || snapshot.sessionLink === 'unknown')
        && snapshot.linkSessionId !== null && sessionIds.includes(snapshot.linkSessionId)) {
        publish({ ...snapshot, sessionLink: 'linked' });
      }
    },
    prepare(action: TaskAction, input: JsonValue, transition?: Readonly<{ label: string; state?: TriageEntryStateV1 }>) {
      if (retired || snapshot.busy || snapshot.checking
        || (snapshot.result?.kind === 'uncertain' && (action !== TRIAGE_TASKS_EDIT_ACTION_LOCAL_ID_V1 || snapshot.rebaseFields === null))) return null;
      intent = { action, input, ...(transition?.state === undefined ? {} : { state: transition.state }) };
      publish({ ...snapshot, result: null, busy: true, checking: false, rebaseFields: null, progress: transition?.label ?? null });
      return { input };
    },
    settle(host: Pick<PluginUiHostApi, 'diagnostic'>, onApplied: () => Promise<void>, execution: TaskExecution) {
      if (retired || !snapshot.busy || intent === null) return;
      const { action, input } = intent;
      let result: TriageTaskWriteResultV1;
      let sessionLink = snapshot.sessionLink;
      let linkSessionId = snapshot.linkSessionId;
      let originErrorLink = snapshot.originErrorLink;
      let originError = snapshot.originError;
      let reviewLink = snapshot.reviewLink;
      let originReview = snapshot.originReview;
      let createdEntryRef = snapshot.createdEntryRef;
      try {
        if (!execution.ok) throw execution.error;
        const raw = execution.result;
        const created = action === TRIAGE_TASKS_CREATE_ACTION_LOCAL_ID_V1 ? TriageCreateTaskActionResultV1Schema.parse(raw) : null;
        if (created?.kind === 'createdAndLinkAttempted') {
          result = created.creation;
          sessionLink = created.sessionLink ?? null;
          const creation = TriageCreateTaskActionInputV1Schema.parse(input);
          linkSessionId = typeof creation.linkSession === 'string' ? creation.linkSession : null;
          originErrorLink = created.originErrorLink ?? null;
          originError = creation.originError ?? null;
          reviewLink = created.reviewLink ?? null;
          originReview = creation.originReview ?? null;
          createdEntryRef = result.kind === 'applied' ? { source: creation.source, ...result.observation.localRef } : null;
        }
        else result = TriageTaskWriteResultV1Schema.parse(raw);
        if (action === TRIAGE_TASKS_CREATE_ACTION_LOCAL_ID_V1 && result.kind === 'applied') {
          createdEntryRef = { source: TriageCreateTaskActionInputV1Schema.parse(input).source, ...result.observation.localRef };
        }
      }
      catch (error) {
        result = triageTaskWriteInvocationFailureV1(error);
      }
      if (retired) return;
      active = null;
      if (result.kind !== 'uncertain') intent = null;
      publish({ result, busy: false, checking: false, rebaseFields: null,
        progress: result.kind === 'uncertain' ? snapshot.progress : null, sessionLink, linkSessionId, originErrorLink, originError, reviewLink, originReview, createdEntryRef });
      // A slow aggregate refresh never holds the confirmed write or its UI hostage.
      if (result.kind === 'applied' || result.kind === 'uncertain') void Promise.resolve().then(onApplied).catch(() => {
        host.diagnostic({ code: 'triage_task_reread_unavailable', severity: 'warning',
          message: 'The task write settled, but its authoritative reread was unavailable.' });
      });
      return result;
    },
    prepareReviewRepair() {
      const { result, originReview, createdEntryRef } = snapshot;
      if (retired || snapshot.busy || result?.kind !== 'applied' || originReview == null || createdEntryRef === null) return null;
      publish({ ...snapshot, busy: true });
      return { input: { v: 1, entryRef: createdEntryRef,
        displayAtMark: { title: result.observation.snapshot.title, scopeLabel: result.observation.snapshot.scopeLabel }, originReview } };
    },
    settleReviewRepair(execution: TaskExecution) {
      if (retired || !snapshot.busy) return false;
      let reviewLink: TaskWriteSnapshot['reviewLink'];
      try {
        if (!execution.ok) throw execution.error;
        const answer = TriageSetTaskOriginReviewResultV1Schema.parse(execution.result);
        reviewLink = answer.status === 'linked' ? 'linked' : 'failed';
      } catch (error) {
        reviewLink = triageTaskWriteInvocationFailureV1(error).kind === 'refused' ? 'failed' : 'unknown';
      }
      if (retired) return false;
      active = null;
      publish({ ...snapshot, busy: false, reviewLink });
      return reviewLink === 'linked';
    },
    prepareOriginRepair() {
      const { result, originError, createdEntryRef } = snapshot;
      if (retired || snapshot.busy || result?.kind !== 'applied' || originError == null || createdEntryRef === null) return null;
      publish({ ...snapshot, busy: true });
      return { input: { v: 1, entryRef: createdEntryRef,
        displayAtMark: { title: result.observation.snapshot.title, scopeLabel: result.observation.snapshot.scopeLabel }, originError } };
    },
    settleOriginRepair(execution: TaskExecution) {
      if (retired || !snapshot.busy) return false;
      let originErrorLink: TaskWriteSnapshot['originErrorLink'];
      try {
        if (!execution.ok) throw execution.error;
        const answer = TriageSetTaskOriginErrorResultV1Schema.parse(execution.result);
        originErrorLink = answer.status === 'linked' ? 'linked' : 'failed';
      } catch (error) {
        originErrorLink = triageTaskWriteInvocationFailureV1(error).kind === 'refused' ? 'failed' : 'unknown';
      }
      if (retired) return false;
      active = null;
      publish({ ...snapshot, busy: false, originErrorLink });
      return originErrorLink === 'linked';
    },
    async checkAgain(host: Pick<PluginUiHostApi, 'executeAction'>, signal?: AbortSignal) {
      if (retired || snapshot.busy || snapshot.checking || snapshot.result?.kind !== 'uncertain' || intent === null) return false;
      // A lost create response supplies no safe identity to find or retry. Keep its draft held.
      if (intent.action === TRIAGE_TASKS_CREATE_ACTION_LOCAL_ID_V1) return false;
      const edit = intent.action === TRIAGE_TASKS_EDIT_ACTION_LOCAL_ID_V1
        ? TriageEditTaskActionInputV1Schema.safeParse(intent.input) : null;
      const transition = intent.action === TRIAGE_TASKS_TRANSITION_ACTION_LOCAL_ID_V1
        ? TriageTransitionTaskActionInputV1Schema.safeParse(intent.input) : null;
      const address = edit?.success ? edit.data : transition?.success ? transition.data : null;
      if (address === null || signal?.aborted) return false;
      const controller = new AbortController();
      active = controller;
      const merged = mergeAbortSignals([signal, controller.signal]);
      const readSignal = merged.signal!;
      publish({ ...snapshot, checking: true });
      try {
        const result = TriageReobserveEntryResultV1Schema.parse(await host.executeAction(TRIAGE_REOBSERVE_ENTRY_ACTION_LOCAL_ID_V1, {
          v: 1, entryRef: address.entryRef, sourceInstanceId: address.sourceInstanceId,
          ...(address.lastKnownLocator === undefined ? {} : { lastKnownLocator: address.lastKnownLocator }),
          ...(edit?.success ? { includeTaskFields: true } : {}),
        }, { signal: readSignal }));
        if (retired || readSignal.aborted || result.kind !== 'observed'
          || !pluginJsonValuesEqual(result.entryRef, address.entryRef)
          || result.observation.sourceInstanceId !== address.sourceInstanceId
          || result.observation.outcome.kind !== 'present') return false;
        const outcome = result.observation.outcome;
        const matches = edit?.success
          ? result.taskFields !== undefined && Object.keys(edit.data.fields).length > 0 && Object.entries(edit.data.fields).every(([field, value]) =>
            pluginJsonValuesEqual(result.taskFields?.[field as keyof TriageTaskFieldsV1], value))
          // A state-only reread cannot prove that native required inputs were applied.
          : transition?.success && (transition.data.fieldValues?.length ?? 0) === 0 && intent.state !== undefined && Object.entries(intent.state).every(([field, value]) =>
            pluginJsonValuesEqual(outcome.snapshot.state[field as keyof TriageEntryStateV1], value));
        if (!matches) {
          if (edit?.success && result.taskFields !== undefined) {
            publish({ ...snapshot, rebaseFields: result.taskFields, checking: false });
          }
          return false;
        }
        const { entryRef } = address;
        publish({ ...snapshot, result: { kind: 'applied', observation: { ...outcome,
          localRef: { kindId: entryRef.kindId, collisionScope: entryRef.collisionScope, entryId: entryRef.entryId } } },
          busy: false, checking: false, rebaseFields: null, progress: null });
        intent = null;
        return true;
      } catch { return false; }
      finally {
        merged.dispose();
        active = null;
        if (!retired && snapshot.checking) publish({ ...snapshot, checking: false });
      }
    },
  };
}
type TaskWriteOperation = ReturnType<typeof createTaskWriteOperation>;
const sharedKey = (ref: TriageEntryRefV1) => `tasks/mounted-write/v1:${triageEntryRowKey(ref)}`;
const draftKey = (draftId: string) => `tasks/mounted-create-write/v1:${draftId}`;
function acquire(scope: PluginEphemeralSharedScope | null, key: string) {
  return scope?.acquire(key, () => {
    const value = createTaskWriteOperation();
    // Uncertainty survives a detail close or virtualized row; Account/generation retirement clears it.
    return { value, retainWhenIdle: true, dispose: () => value.dispose() };
  }) ?? null;
}

function useTaskWriteOperation(key: string | null) {
  const scope = usePluginUiEphemeralSharedScope();
  const local = React.useMemo(createTaskWriteOperation, [scope, key]);
  const committed = React.useRef<Readonly<{ scope: typeof scope; key: string | null; operation: TaskWriteOperation }> | null>(null);
  const subscribe = React.useCallback((listener: () => void) => {
    const lease = key === null ? null : acquire(scope, key);
    const operation = key === null ? local : lease?.value;
    if (operation === undefined) return () => {};
    const binding = { scope, key, operation };
    committed.current = binding;
    const unsubscribe = operation.subscribe(listener);
    return () => {
      unsubscribe();
      if (committed.current === binding) committed.current = null;
      lease?.release();
    };
  }, [scope, key, local]);
  const read = React.useCallback(() => committed.current?.scope === scope && committed.current.key === key
    ? committed.current.operation.snapshot() : IDLE, [scope, key]);
  const snapshot = React.useSyncExternalStore(subscribe, read, read);
  React.useEffect(() => () => { if (key === null) local.abort(); }, [local, key]);
  const operation = () => committed.current?.scope === scope && committed.current.key === key ? committed.current.operation : null;
  return { snapshot, operation };
}

export function useTriageTaskCommit(onApplied: () => Promise<void>, address?: TaskWriteAddress, linkedSessionIds?: readonly string[]) {
  const host = usePluginHostApi();
  const scope = usePluginUiEphemeralSharedScope();
  const key = address === undefined ? null : 'entryRef' in address ? sharedKey(address.entryRef)
    : draftKey(address.draftId);
  const { snapshot, operation } = useTaskWriteOperation(key);
  React.useEffect(() => {
    if (linkedSessionIds !== undefined) operation()?.observeSessionLinks(linkedSessionIds);
  }, [scope, key, snapshot.sessionLink, snapshot.linkSessionId, linkedSessionIds]);
  const adoptCreated = (owner: TaskWriteOperation) => {
    const created = owner.snapshot();
    if (created.result?.kind !== 'applied' || created.createdEntryRef === null) return;
    const lease = acquire(scope, sharedKey(created.createdEntryRef));
    lease?.value.adoptCreated(created);
    lease?.release();
  };
  // Action controls retain the controller that prepared the gesture, including its operation when selection moves.
  let preparedOwner: TaskWriteOperation | null = null;
  return { ...snapshot,
    prepare: (action: TaskAction, input: JsonValue, transition?: Readonly<{ label: string; state?: TriageEntryStateV1 }>) => {
      preparedOwner = operation();
      return preparedOwner?.prepare(action, input, transition) ?? null;
    },
    settle: (execution: PluginUiActionControlExecution) => {
      const owner = preparedOwner;
      if (owner === null) return;
      const result = owner.settle(host, onApplied, hostTaskExecution(execution));
      adoptCreated(owner);
      return result;
    },
    prepareReviewRepair: () => {
      preparedOwner = operation();
      return preparedOwner?.prepareReviewRepair() ?? null;
    },
    settleReviewRepair: (execution: PluginUiActionControlExecution) => preparedOwner?.settleReviewRepair(hostTaskExecution(execution)) ?? false,
    prepareOriginRepair: () => {
      preparedOwner = operation();
      return preparedOwner?.prepareOriginRepair() ?? null;
    },
    settleOriginRepair: (execution: PluginUiActionControlExecution) => preparedOwner?.settleOriginRepair(hostTaskExecution(execution)) ?? false,
    checkAgain: async () => {
      let resolved = false;
      try {
        if (address !== undefined && 'entryRef' in address) resolved = TriageMountedUiResultV1Schema.parse(await host.executeAction(TRIAGE_TASKS_CHECK_WRITE_ACTION_LOCAL_ID_V1,
          { v: 1, entryRef: address.entryRef })).status === 'applied';
      } catch { /* Read failure cannot resolve the preceding write. */ }
      if (resolved) void Promise.resolve().then(onApplied).catch(() => {});
      // The editor may discard its submitted draft after a fresh rebase without reporting that write applied.
      return resolved || (operation()?.snapshot().rebaseFields ?? null) !== null;
    },
  };
}

/** A mounted reader subscribes only to its task or draft, with zero reads or work for unrelated writes. */
export function useTriageTaskWriteState(address: TriageEntryRefV1 | Readonly<{ draftId: string }> | null) {
  return useTaskWriteOperation(address === null ? null : 'draftId' in address ? draftKey(address.draftId) : sharedKey(address)).snapshot;
}

/** Agent/MCP/CLI recovery through the incumbent mounted UI Action, using the same authoritative reader. */
export async function checkTriageTaskWrite(scope: PluginEphemeralSharedScope | null, entryRef: TriageEntryRefV1,
  host: Pick<PluginUiHostApi, 'executeAction'>, signal: AbortSignal) {
  const lease = acquire(scope, sharedKey(entryRef));
  if (lease === null) return false;
  try { return await lease.value.checkAgain(host, signal); }
  finally { lease.release(); }
}
