import { questionInput, readMuseNativeJson, readMuseRecord } from './nativeInput.js';
export { readMuseNativeJson, readMuseRecord } from './nativeInput.js';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import { parseMcpToolWireNameV1 } from '@happier-dev/plugin-sdk/agents/runtime';
import type { AgentExecutionRunConversationEventV1, AgentSessionCompactRequest, AgentSessionRuntimeEvent, AgentSessionSendRequest, AgentSessionSubagentObservation } from '@happier-dev/plugin-sdk/agents/runtime';
import { SESSION_WORKFLOW_RUN_SNAPSHOT_TITLE_MAX, SESSION_WORKFLOW_RUN_SNAPSHOT_SUMMARY_MAX,
  type SessionWorkflowRunSnapshotV1, type SessionWorkflowAgentStatusV1 } from '@happier-dev/plugin-sdk/sessions/work-state';
import { MUSE_ACCOUNTING_SOURCE_ID } from './definition.js';
import { readMuseUsageTokens } from './usage.js';

type EventContent<T = AgentExecutionRunConversationEventV1> = T extends AgentExecutionRunConversationEventV1
  ? Omit<T, 'emittedAtMs'> : never;
type ProjectionEvent<SessionId extends string | undefined> = SessionId extends string
  ? AgentSessionRuntimeEvent : AgentExecutionRunConversationEventV1;
type NativeRecord = Readonly<Record<string, JsonValue>>;
type Admission = { commandId: string; request: AgentSessionSendRequest; accepted: boolean; startedAtMs?: number; terminal?: boolean;
  cancelCause?: Extract<AgentSessionRuntimeEvent, { kind: 'turn-cancelled' }>['cause'];
  mcpCallCounts?: Map<string, number>;
  continuations?: Set<string>; steerCommandIds?: Set<string> };
type NativeItem = { value: NativeRecord; revision: number; streamedText: string; committed: boolean;
  compaction?: Pick<AgentSessionCompactRequest, 'compactionId' | 'trigger'>;
  presentation?: Readonly<{ toolCallId: string; toolName: string; input: JsonValue }> };
type ChildTerminal = 'completed' | 'failed' | 'cancelled' | 'interrupted';
type NativeChild = { state?: NativeItem; terminal?: ChildTerminal; workflowChild?: NativeRecord; label?: string; workflowRunId?: string };
type ChildObservation = AgentSessionSubagentObservation;

export function createMuseEventProjection<SessionId extends string | undefined = undefined>(options: Readonly<{ sessionId?: SessionId;
  mcpServerNames?: ReadonlySet<string>;
  resolveModelId?(id: string): string | null;
  onHostPromptEcho?(localId: string): Promise<void>;
  onActivity?(state: 'active' | 'idle' | 'unknown'): void;
  onChild?(observation: ChildObservation): Promise<void>;
  onWorkflow?(snapshot: SessionWorkflowRunSnapshotV1): Promise<void>;
}>) {
  let sequence = 0;
  let nativeSessionId: string | undefined;
  let disposed = false;
  let firstWatch = true;
  const pending: ProjectionEvent<SessionId>[] = [];
  const listeners = new Set<(event: ProjectionEvent<SessionId>) => void>();
  const commands = new Map<string, Admission>();
  const turns = new Map<string, Admission>();
  const items = new Map<string, NativeItem>();
  const workflows = new Map<string, { nativeTurnId: string; parentToolCallId: string; item?: NativeRecord; released?: boolean }>();
  const childItems = new Map<string, NativeChild>();
  let expectedCompaction: { request: AgentSessionCompactRequest; itemId?: string } | undefined;

  function publish(content: EventContent | Omit<Extract<AgentSessionRuntimeEvent, { kind: 'catalog-changed' }>, 'sequence' | 'sessionId' | 'emittedAtMs'>,
    emittedAtMs?: number) {
    if (disposed) return;
    if (content.kind === 'runtime-ended') {
      // A native process can exit after publishing an item start but before
      // its completion. Close that tool row at the same lifecycle boundary so
      // the host never waits on a result Muse can no longer deliver.
      for (const state of items.values()) {
        if (state.committed || !state.presentation) continue;
        state.committed = true;
        publish({ kind: 'tool-result', toolCallId: state.presentation.toolCallId,
          output: { status: 'runtimeEnded', cause: content.cause }, isError: true,
          ...toolCorrelation(state.value, state.presentation.toolCallId) });
      }
      // Settle pending input custody before the host closes its event stream.
      // A correlated native start already established acceptance and survives EOF.
      for (const [commandId, admission] of commands) {
        if (admission.accepted) continue;
        commands.delete(commandId);
        publish({ kind: 'input-custody-unknown', inputIds: admission.request.inputIds,
          issue: { code: 'native_send_outcome_unknown', severity: 'error' } });
      }
    }
    // The chosen scope supplies its envelope once, before watcher fanout.
    const event = Object.freeze({ ...content, emittedAtMs: emittedAtMs ?? Date.now(),
      ...(options.sessionId === undefined ? {} : { sequence: ++sequence, sessionId: options.sessionId }),
    }) as ProjectionEvent<SessionId>;
    if (firstWatch) pending.push(event);
    for (const listener of listeners) listener(event);
  }

  function correlation(nativeTurn: JsonValue | undefined) {
    if (typeof nativeTurn !== 'string') return {};
    const admission = turns.get(nativeTurn);
    return admission ? { turnId: admission.request.delivery.turnId, agentTurnId: nativeTurn } : {};
  }

  function toolCorrelation(item: NativeRecord, itemId: string) {
    // Reminder children stay readable in the transcript, but must not clear
    // foreground consumers' replies as if a new tool operation had started.
    return { ...correlation(item.turnId), ...(item.kind === 'reminderChild'
      ? { sidechainId: typeof item.childSessionId === 'string' ? item.childSessionId : itemId } : {}) };
  }

  function accepted(admission: Admission) {
    if (admission.accepted) return;
    admission.accepted = true;
    const { inputIds, delivery } = admission.request;
    publish({ kind: 'input-accepted', inputIds, delivery: { kind: delivery.kind, turnId: delivery.turnId } });
  }

  function observeSession(value: JsonValue | undefined) {
    const session = readMuseRecord(value);
    if (typeof session.status === 'string') activity(session.status);
    if (typeof session.sessionId !== 'string' || nativeSessionId === session.sessionId) return;
    nativeSessionId = session.sessionId;
    publish({ kind: 'provider-session-id', providerSessionId: nativeSessionId,
      ...(typeof session.path === 'string' ? { nativeSessionLogPath: session.path } : {}) });
  }

  function activity(status: JsonValue | undefined) {
    const state = status === 'running' ? 'active' : status === 'idle' ? 'idle' : 'unknown';
    options.onActivity?.(state);
    publish({ kind: 'runtime-activity-snapshot', state, activeCount: state === 'active' ? 1 : 0 });
  }

  function textItem(itemId: string, state: NativeItem, completed: boolean, initialReplay = false) {
    const item = state.value;
    if (item.kind !== 'agentMessage' && item.kind !== 'reasoning' && item.kind !== 'userMessage') return;
    const role = item.kind === 'agentMessage' ? 'assistant' : item.kind === 'reasoning' ? 'reasoning' : 'user';
    const text = typeof item.text === 'string' ? item.text : state.streamedText;
    if (!initialReplay && role !== 'user' && text.startsWith(state.streamedText)) {
      const delta = text.slice(state.streamedText.length);
      if (delta) publish({ kind: 'message-delta', messageId: itemId, channel: role,
        text: delta, ...correlation(item.turnId) });
    }
    state.streamedText = text;
    if (!completed || state.committed) return;
    state.committed = true;
    const admission = typeof item.turnId === 'string' ? turns.get(item.turnId) : undefined;
    if (role === 'user' && admission && typeof item.commandId === 'string'
      && (item.commandId === admission.commandId || admission.steerCommandIds?.has(item.commandId))) {
      return options.onHostPromptEcho?.(itemId);
    }
    const owner = correlation(item.turnId);
    publish({ kind: 'transcript-message-committed', messageId: itemId, role, text,
      ...(owner.turnId ? { turnId: owner.turnId } : {}) });
  }

  function compactionItem(itemId: string, state: NativeItem, previous: NativeItem | undefined) {
    const item = state.value;
    if (item.kind !== 'compaction') return false;
    // MSP compaction Items have a stable itemId but no commandId. The first
    // manual Item belongs to the outstanding host request; later revisions
    // retain that identity instead of treating its admission ack as completion.
    if (!state.compaction && item.trigger === 'manual' && expectedCompaction && !expectedCompaction.itemId) {
      expectedCompaction.itemId = itemId;
      state.compaction = expectedCompaction.request;
    }
    const common = state.compaction ?? { compactionId: itemId,
      trigger: item.trigger === 'manual' ? 'manual' as const : item.trigger === 'auto' ? 'automatic' as const : 'unknown' as const };
    if (state.committed) return true;
    if (item.status === 'inProgress') {
      if (previous) publish({ kind: 'context-compaction', ...common, phase: 'progress' });
      else publish({ kind: 'context-compaction', ...common, phase: 'started',
        ...(typeof item.tokensBefore === 'number' ? { tokenCountBefore: item.tokensBefore, tokenCountSource: 'providerReported' } : {}) });
      return true;
    }
    state.committed = true;
    if (expectedCompaction?.itemId === itemId) expectedCompaction = undefined;
    const diagnostic = { code: 'PLUGIN_EXEC_FAILED', severity: 'error' as const,
      details: { nativeStatus: item.status ?? null, nativeOutcome: item.outcome ?? null,
        ...(typeof item.reason === 'string' ? { reason: item.reason } : {}) } };
    switch (item.status) {
      case 'completed':
        if (item.outcome === 'compacted' || item.outcome === 'noop') {
          publish({ kind: 'context-compaction', ...common, phase: 'completed',
            ...(typeof item.tokensBefore === 'number' ? { tokenCountBefore: item.tokensBefore } : {}),
            ...(typeof item.tokensAfter === 'number' ? { tokenCountAfter: item.tokensAfter } : {}),
            ...(typeof item.tokensBefore === 'number' || typeof item.tokensAfter === 'number' ? { tokenCountSource: 'providerReported' } : {}) });
          return true;
        }
        if (item.outcome === 'failed') { publish({ kind: 'context-compaction', ...common, phase: 'failed', diagnostic }); return true; }
        if (item.outcome === 'cancelled') { publish({ kind: 'context-compaction', ...common, phase: 'cancelled' }); return true; }
        break;
      case 'failed': case 'rejected': case 'timedOut':
        publish({ kind: 'context-compaction', ...common, phase: 'failed', diagnostic });
        return true;
      case 'cancelled':
        publish({ kind: 'context-compaction', ...common, phase: 'cancelled' });
        return true;
    }
    publish({ kind: 'context-compaction', ...common, phase: 'outcomeUnknown', diagnostic });
    return true;
  }

  function workflowLaunch(item: NativeRecord, toolCallId: string) {
    if (item.tool !== 'workflow' || typeof item.visibleOutput !== 'string' || typeof item.turnId !== 'string') return;
    const result = readMuseRecord(readMuseNativeJson(item.visibleOutput));
    const admission = turns.get(item.turnId);
    if (result.status !== 'launched' || typeof result.workflowRunId !== 'string' || !admission || workflows.has(result.workflowRunId)) return;
    const parentTurnId = admission.request.delivery.turnId;
    workflows.set(result.workflowRunId, { nativeTurnId: item.turnId, parentToolCallId: toolCallId });
    (admission.continuations ??= new Set()).add(result.workflowRunId);
    publish({ kind: 'provider-continuation-registered', continuationId: result.workflowRunId, parentTurnId, parentToolCallId: toolCallId });
  }

  function workflowCompleted(item: NativeRecord) {
    if (item.kind !== 'workflow' || typeof item.workflowRunId !== 'string') return;
    if (item.status !== 'completed' && item.status !== 'failed' && item.status !== 'cancelled' && item.status !== 'interrupted') return;
    const workflow = workflows.get(item.workflowRunId);
    if (!workflow || workflow.released) return;
    publish({ kind: 'provider-continuation-released', continuationId: item.workflowRunId });
    workflow.released = true;
    const admission = turns.get(workflow.nativeTurnId);
    admission?.continuations?.delete(item.workflowRunId);
    if (admission?.terminal && admission.continuations?.size === 0) turns.delete(workflow.nativeTurnId);
  }

  function childInput(item: NativeRecord): JsonValue {
    return { objective: item.objective ?? null, role: item.role ?? null, nativeChild: item };
  }

  function readChildTerminal(value: JsonValue | undefined): ChildTerminal | undefined {
    if (value === 'completed' || value === 'failed' || value === 'cancelled' || value === 'interrupted') return value;
  }

  function finishChild(child: NativeChild, terminal: ChildTerminal | undefined, output?: JsonValue) {
    const state = child.state;
    if (!terminal || !state || child.terminal || typeof state.value.subagentId !== 'string') return;
    child.terminal = terminal;
    publish({ kind: 'tool-result', toolCallId: state.value.subagentId,
      output: output ?? state.value.result ?? { status: terminal }, isError: terminal !== 'completed' });
  }

  function childStatus(child: NativeChild): ChildObservation['status'] | undefined {
    const workflow = child.workflowChild;
    const status = workflow?.status === 'terminal' ? workflow.terminal : workflow?.status;
    const terminal = child.terminal ?? readChildTerminal(status);
    if (terminal === 'completed' || terminal === 'failed') return terminal;
    if (terminal) return 'aborted';
    const native = child.state?.value;
    if (native?.controlStatus === 'running' || native?.controlStatus === 'resultReady') return 'running';
    if (native?.controlStatus === 'accepted' || status === 'scheduled') return 'starting';
    return undefined;
  }

  function workflowAgentStatus(child: NativeChild): SessionWorkflowAgentStatusV1 {
    const status = childStatus(child);
    return status === 'completed' ? 'complete' : status === 'running' ? 'active'
      : status === 'aborted' ? 'cancelled' : status === 'starting' ? 'pending' : status ?? 'unknown';
  }

  async function publishChild(id: string, child: NativeChild) {
    const status = childStatus(child);
    if (!status || !child.state || !options.onChild) return;
    await options.onChild({ observationId: id, ...(child.workflowRunId ? { groupId: child.workflowRunId } : {}), status,
      detail: { nativeChild: child.state.value, workflowChild: child.workflowChild ?? null,
        ...(child.label ? { label: child.label } : {}) } });
  }

  async function publishWorkflow(runId: string) {
    const workflow = workflows.get(runId);
    const item = workflow?.item;
    if (!workflow || !item || !options.onWorkflow) return;
    const now = Date.now();
    const agents = [...childItems].filter(([, child]) => child.workflowRunId === runId).map(([id, child]) => ({
      id, title: (child.label ?? id).slice(0, SESSION_WORKFLOW_RUN_SNAPSHOT_TITLE_MAX),
      status: workflowAgentStatus(child), updatedAt: now,
      ...(typeof child.state?.value.childSessionId === 'string' ? { vendorRef: child.state.value.childSessionId } : {}),
      nativeChild: child.state?.value ?? null, nativeWorkflowChild: child.workflowChild ?? null,
    }));
    await options.onWorkflow({ v: 1, projectionVersion: 1, runId, backendId: 'muse', agentId: 'muse',
      title: (typeof item.label === 'string' ? item.label : 'Workflow').slice(0, SESSION_WORKFLOW_RUN_SNAPSHOT_TITLE_MAX),
      status: item.status === 'completed' ? 'complete' : item.status === 'failed' ? 'failed'
        : item.status === 'cancelled' ? 'cancelled' : item.status === 'interrupted' ? 'stopped'
          : item.status === 'inProgress' ? 'active' : 'unknown',
      recordRevision: '0', sourceRevision: String(item.revision), updatedAt: now,
      ...(nativeSessionId ? { sourceSessionId: nativeSessionId } : {}),
      workflowToolUseId: workflow.parentToolCallId,
      totalAgents: agents.length, completedAgents: agents.filter(agent => agent.status === 'complete').length,
      phases: [], agents, nativeWorkflow: item,
      ...(typeof item.finalSummary === 'string' ? { summary: item.finalSummary.slice(0, SESSION_WORKFLOW_RUN_SNAPSHOT_SUMMARY_MAX) } : {}),
    });
  }

  function childItem(state: NativeItem, previous: NativeItem | undefined, initialReplay = false): Promise<void> | undefined {
    const item = state.value;
    if (item.kind === 'subagent' && typeof item.subagentId === 'string') {
      const id = item.subagentId;
      const child = childItems.get(id) ?? {};
      child.state = state;
      if (typeof item.workflowRunId === 'string') child.workflowRunId = item.workflowRunId;
      childItems.set(id, child);
      if (!previous) publish({ kind: 'tool-call', toolCallId: item.subagentId, toolName: 'Task', input: childInput(item) });
      else publish({ kind: 'tool-progress', toolCallId: item.subagentId,
        progress: { toolName: 'Task', rawInput: childInput(item), status: child.terminal ?? item.status ?? 'unknown' } });
      finishChild(child, readChildTerminal(item.status));
      if (initialReplay) return;
      if (typeof item.childSessionId === 'string' && item.usage !== undefined && item.usage !== null
        && (previous?.value.childSessionId !== item.childSessionId || previous.value.usage === undefined || previous.value.usage === null)) {
        // Child counters are measured, but their total and overlap semantics are unknown.
        const usage = readMuseRecord(item.usage);
        const tokens = readMuseUsageTokens(usage, usage.inputTokens, undefined);
        publish({ kind: 'usage-observed', observationId: `${item.childSessionId}:subagent:${item.itemId}`,
          source: MUSE_ACCOUNTING_SOURCE_ID, scope: 'session_cumulative',
          accounting: { nativeSessionId: item.childSessionId }, ...(tokens ? { tokens } : {}) });
      }
      return (async () => { await publishChild(id, child); if (child.workflowRunId) await publishWorkflow(child.workflowRunId); })();
    }
    if (item.kind === 'workflow' && typeof item.workflowRunId === 'string' && Array.isArray(item.children)) {
      const runId = item.workflowRunId;
      const workflow = workflows.get(runId);
      if (workflow) workflow.item = item;
      const changed: Array<readonly [string, NativeChild]> = [];
      for (const value of item.children) {
        const child = readMuseRecord(value);
        if (typeof child.childId !== 'string') continue;
        const native = childItems.get(child.childId) ?? {};
        native.workflowChild = child;
        native.workflowRunId = runId;
        if (typeof child.label === 'string') native.label = child.label;
        childItems.set(child.childId, native);
        finishChild(native, readChildTerminal(child.status === 'terminal' ? child.terminal : child.status));
        changed.push([child.childId, native]);
      }
      if (initialReplay) return;
      return (async () => { for (const [id, child] of changed) await publishChild(id, child); await publishWorkflow(runId); })();
    }
  }

  function toolItem(itemId: string, state: NativeItem, previous: NativeItem | undefined, completed: boolean) {
    const item = state.value;
    const fallback = item.kind !== 'agentMessage' && item.kind !== 'reasoning' && item.kind !== 'userMessage'
      && item.kind !== 'subagent' && item.kind !== 'workflow' && typeof item.fallbackText === 'string';
    if (item.kind !== 'toolCall' && item.kind !== 'userShell' && !fallback) return;
    const toolCallId = typeof item.callId === 'string' ? item.callId : itemId;
    const toolName = item.kind === 'userShell' || item.tool === 'bash' ? 'Bash'
      : item.tool === 'request_user_input' ? 'AskUserQuestion'
      : typeof item.tool === 'string' ? item.tool : typeof item.kind === 'string' ? item.kind : 'nativeItem';
    const rawInput = item.kind === 'userShell' ? { command: item.commandText ?? '' }
      : fallback ? { text: item.fallbackText ?? '' } : readMuseNativeJson(item.args);
    const input = item.tool === 'request_user_input' ? questionInput(readMuseRecord(rawInput)) : rawInput;
    state.presentation = { toolCallId, toolName, input };
    const owner = toolCorrelation(item, itemId);
    if (!previous) publish({ kind: 'tool-call', toolCallId, toolName, input, ...owner });
    else if (!state.committed && (item.args !== previous.value.args || item.fallbackText !== previous.value.fallbackText
      || !completed && item.visibleOutput !== previous.value.visibleOutput)) {
      publish({ kind: 'tool-progress', toolCallId, progress: { toolName, rawInput: input,
        ...(typeof item.status === 'string' ? { status: item.status } : {}),
        ...(!completed && typeof item.visibleOutput === 'string'
          ? { content: [{ type: 'text', text: item.visibleOutput }] } : {}) }, ...owner });
    }
    if (!completed && !state.committed) return;
    if (state.committed && previous && item.visibleOutput === previous.value.visibleOutput
      && item.status === previous.value.status && item.failureKind === previous.value.failureKind
      && item.failureReason === previous.value.failureReason && item.fallbackText === previous.value.fallbackText) return;
    state.committed = true;
    const text = fallback ? item.fallbackText ?? '' : item.visibleOutput;
    // Visible text supplements native failure status and details; it must not erase either.
    const output = text === undefined || item.status !== undefined && item.status !== 'completed'
      || item.failureKind !== undefined || item.failureReason !== undefined
      ? { ...(text === undefined ? {} : { text }), status: item.status ?? 'unknown',
        ...(item.failureKind === undefined ? {} : { failureKind: item.failureKind }),
        ...(item.failureReason === undefined ? {} : { failureReason: item.failureReason }) }
      : text;
    publish({ kind: 'tool-result', toolCallId, output, isError: item.status !== 'completed', ...owner });
    if (item.status === 'completed') workflowLaunch(item, toolCallId);
  }

  function usageObservation(method: string, params: NativeRecord) {
    const first = readMuseRecord(readMuseRecord(params.sourceRange).first);
    const identity = typeof first.id === 'string' ? first.id : typeof params.viewCursor === 'string' ? params.viewCursor : undefined;
    if (!identity || typeof params.sessionId !== 'string') return;
    const owner = correlation(params.turnId);
    const modelId = typeof params.modelId === 'string' ? options.resolveModelId?.(params.modelId) ?? null : null;
    if (method === 'session/tokenUsage') {
      const usage = readMuseRecord(params.usage);
      const counted = readMuseUsageTokens(usage, params.promptTokens, params.totalTokens);
      // Muse's promptTokens is the counted-once derivation; usage.inputTokens is provider dependent.
      publish({ kind: 'usage-observed', observationId: `${params.sessionId}:${method}:${identity}`,
        source: MUSE_ACCOUNTING_SOURCE_ID, scope: 'turn_delta', ...(owner.turnId ? { turnId: owner.turnId } : {}),
        accounting: { nativeSessionId: params.sessionId, inferenceId: identity,
          inputIncludesCache: true, outputIncludesReasoning: true },
        ...(modelId ? { modelId } : {}),
        ...(counted ? { tokens: counted } : {}) });
    } else if (typeof params.usedTokens === 'number') {
      publish({ kind: 'usage-observed', observationId: `${params.sessionId}:${method}:${identity}`,
        source: MUSE_ACCOUNTING_SOURCE_ID, scope: 'session_cumulative', accounting: { nativeSessionId: params.sessionId },
        context: { v: 1, modelId,
          usedTokens: params.usedTokens, windowTokens: typeof params.windowTokens === 'number' ? params.windowTokens : null,
          totalProcessedTokens: null, baselineTokens: null, isAutoCompactEnabled: null, categories: null,
          observedAtMs: Date.now(), source: 'provider_live' } });
    }
  }

  function observeItem(itemValue: JsonValue | undefined, completed: boolean, initialReplay = false): Promise<void> | undefined {
    const item = readMuseRecord(itemValue);
    if (typeof item.itemId !== 'string') return;
    const previous = items.get(item.itemId);
    const revision = typeof item.revision === 'number' ? item.revision : 0;
    if (previous && revision <= previous.revision) return;
    const state: NativeItem = { value: item, revision, streamedText: previous?.streamedText ?? '', committed: previous?.committed ?? false,
      ...(previous?.compaction ? { compaction: previous.compaction } : {}) };
    items.set(item.itemId, state);
    if (!previous && !initialReplay && options.mcpServerNames?.size && item.kind === 'toolCall'
      && typeof item.turnId === 'string' && typeof item.tool === 'string') {
      const admission = turns.get(item.turnId);
      if (admission && !admission.terminal) {
        const tool = parseMcpToolWireNameV1(item.tool, options.mcpServerNames);
        if (tool) {
          const counts = admission.mcpCallCounts ??= new Map();
          counts.set(tool.server, (counts.get(tool.server) ?? 0) + 1);
        }
      }
    }
    if (!initialReplay && compactionItem(item.itemId, state, previous)) return;
    if (completed && item.kind === 'subagentResult' && typeof item.subagentId === 'string') {
      const child = childItems.get(item.subagentId);
      const terminal = readChildTerminal(item.resultStatus);
      if (child?.state && terminal) {
        if (state.committed) return;
        state.committed = true;
        // Direct children keep their launch item in progress. This separate native
        // result carries the outcome and child identity, even after the result is drained.
        const text = typeof item.text === 'string' ? item.text : undefined;
        finishChild(child, terminal, { ...readMuseRecord(child.state.value.result), status: terminal,
          ...(text === undefined ? {} : { text }) });
        if (text) publish({ kind: 'transcript-message-committed', messageId: item.itemId,
          sidechainId: item.subagentId, role: 'assistant', text });
        if (!initialReplay) return publishChild(item.subagentId, child);
        return;
      }
    }
    const childPublication = childItem(state, previous, initialReplay);
    const textPublication = textItem(item.itemId, state, completed, initialReplay);
    toolItem(item.itemId, state, previous, completed);
    if (textPublication) return textPublication;
    if (childPublication) return childPublication.then(() => workflowCompleted(item));
    if (!initialReplay) workflowCompleted(item);
  }

  function observe(message: Readonly<{ method: string; params?: JsonValue }>) {
    if (disposed) return;
    const params = readMuseRecord(message.params);
    if (message.method === 'skill/changed') {
      if (options.sessionId !== undefined && typeof params.sessionId === 'string' && params.sessionId === nativeSessionId) {
        publish({ kind: 'catalog-changed', catalog: 'skills' });
      }
      return;
    }
    if (message.method === 'session/statusChanged') {
      if (params.sessionId === nativeSessionId) activity(params.status);
      return;
    }
    if (message.method === 'session/tokenUsage' || message.method === 'session/contextUsage') { usageObservation(message.method, params); return; }
    if (message.method === 'session/started') { observeSession(params.session); return; }
    if (message.method === 'turn/started') {
      if (typeof params.turnId !== 'string') return;
      const admission = (typeof params.commandId === 'string' ? commands.get(params.commandId) : undefined)
        ?? turns.get(params.turnId);
      if (!admission || admission.startedAtMs !== undefined) return;
      const startedAtMs = admission.startedAtMs = Date.now();
      turns.set(params.turnId, admission);
      accepted(admission);
      publish({ kind: 'turn-start', turnId: admission.request.delivery.turnId, agentTurnId: params.turnId,
        startedBy: 'host' }, startedAtMs);
      return;
    }
    if (message.method === 'turn/foregroundCompleted') {
      const owner = correlation(params.turnId);
      if (owner.turnId) publish({ kind: 'turn-progress', turnId: owner.turnId, agentTurnId: owner.agentTurnId });
      return;
    }
    if (message.method === 'turn/completed') {
      if (typeof params.turnId !== 'string') return;
      const admission = turns.get(params.turnId);
      if (!admission || admission.terminal) return;
      const owner = { turnId: admission.request.delivery.turnId, agentTurnId: params.turnId };
      if (params.terminal === 'interrupted' || params.terminal === 'cancelled') {
        publish({ kind: 'turn-cancelled', ...owner, cause: admission.cancelCause ?? 'providerInterrupted' });
      } else if (params.terminal === 'failed') {
        const error = readMuseRecord(params.error);
        // MSP reports this key refusal in the terminal message. The status from a
        // separate connection check is not part of the turn's native evidence.
        const rejectedApiKey = error.message === 'your API key from META_API_KEY was rejected — update or unset it';
        publish({ kind: 'turn-failed', ...owner, diagnostic: {
          code: rejectedApiKey ? 'provider_endpoint_auth_required' : 'PLUGIN_EXEC_FAILED', severity: 'error',
          ...(typeof error.message === 'string' ? { message: error.message } : {}),
          ...(rejectedApiKey ? { details: { failureCause: {
            phase: 'authentication', failureReason: 'authentication_required',
          } } } : {}),
        } });
      } else if (params.terminal === 'completed') {
        const { startedAtMs, mcpCallCounts } = admission;
        if (startedAtMs !== undefined && mcpCallCounts?.size) {
          const endMs = Math.max(startedAtMs, Date.now());
          publish({ kind: 'mcp-tool-usage', ...owner, window: { startMs: startedAtMs, endMs },
            // MSP exposes observed calls but no evidence of delivered, unused tools.
            coverage: 'partial',
            servers: [...mcpCallCounts].map(([serverName, toolCallCount]) => ({ serverName, toolCallCount, schemaBytes: null })),
          }, endMs);
        }
        publish({ kind: 'turn-complete', ...owner });
        publish({ kind: 'turn-rollback-boundary', ...owner, providerCheckpoint: { lastTurnId: params.turnId } });
      } else return;
      admission.terminal = true;
      delete admission.mcpCallCounts;
      if (!admission.continuations?.size) turns.delete(params.turnId);
      return;
    }
    if (message.method === 'item/delta') {
      if (typeof params.itemId !== 'string' || typeof params.delta !== 'string' || params.field !== 'text') return;
      const state = items.get(params.itemId);
      if (!state || state.committed || (state.value.kind !== 'agentMessage' && state.value.kind !== 'reasoning')) return;
      state.streamedText += params.delta;
      publish({ kind: 'message-delta', messageId: params.itemId,
        channel: state.value.kind === 'reasoning' ? 'reasoning' : 'assistant', text: params.delta,
        ...correlation(state.value.turnId) });
      return;
    }
    if (message.method === 'item/started' || message.method === 'item/updated' || message.method === 'item/completed') {
      const item = readMuseRecord(params.item);
      if (item.kind === 'compaction' && params.sessionId !== nativeSessionId) return;
      return observeItem(item, message.method === 'item/completed');
    }
  }

  return {
    publish,
    observeSession,
    async replayItems(nativeItems: readonly JsonValue[]) {
      for (const item of nativeItems) {
        await observeItem(item, readMuseRecord(item).status !== 'inProgress', true);
      }
    },
    async replayHistoryEvent(message: Readonly<{ method: string; params?: JsonValue }>) {
      if (message.method !== 'item/started' && message.method !== 'item/updated' && message.method !== 'item/completed') return;
      await observeItem(readMuseRecord(message.params).item, message.method === 'item/completed', true);
    },
    expectCompaction(request: AgentSessionCompactRequest) {
      if (expectedCompaction) return undefined;
      const expected: { request: AgentSessionCompactRequest; itemId?: string } = { request };
      expectedCompaction = expected;
      return {
        retire() {
          if (expectedCompaction === expected) expectedCompaction = undefined;
          return expected.itemId !== undefined;
        },
      };
    },
    admit(request: AgentSessionSendRequest, commandId: string) { commands.set(commandId, { commandId, request, accepted: false }); },
    retireCommand(commandId: string) {
      const admission = commands.get(commandId);
      commands.delete(commandId);
      return admission?.accepted;
    },
    setCancellationCause(nativeTurnId: string, cause: Admission['cancelCause']) {
      const admission = turns.get(nativeTurnId);
      if (admission) admission.cancelCause = cause;
    },
    readOwningTurn(hostTurnId?: string) {
      for (const [nativeTurnId, admission] of turns) {
        if (!admission.terminal && (hostTurnId === undefined || admission.request.delivery.turnId === hostTurnId)) {
          return nativeTurnId;
        }
      }
      return undefined;
    },
    accept(commandId: string, result: JsonValue) {
      const admission = commands.get(commandId);
      if (!admission) return;
      const response = readMuseRecord(result);
      if (response.status === 'accepted' && typeof response.turnId === 'string') {
        if (!admission.accepted) {
          const owner = turns.get(response.turnId);
          if (admission.request.delivery.kind === 'steer' && owner) {
            (owner.steerCommandIds ??= new Set()).add(commandId);
          } else turns.set(response.turnId, admission);
          accepted(admission);
        }
      }
      commands.delete(commandId);
    },
    observe,
    presentNativeInteraction(params: NativeRecord, detail: JsonValue) {
      const state = typeof params.itemId === 'string' ? items.get(params.itemId) : undefined;
      const presentation = state?.presentation;
      if (!state || !presentation) return;
      publish({ kind: 'tool-progress', toolCallId: presentation.toolCallId,
        progress: { toolName: presentation.toolName, rawInput: presentation.input,
          content: [{ type: 'text', text: JSON.stringify(detail) }] }, ...correlation(state.value.turnId) });
    },
    readNativeChildOrigin(subagentId: string) {
      const child = childItems.get(subagentId);
      if (!child) return undefined;
      const sessionId = child.state?.value.childSessionId;
      return { subagentId, ...(typeof sessionId === 'string' ? { sessionId } : {}),
        ...(child.label ? { subagentLabel: child.label } : {}) };
    },
    watch(listener: (event: ProjectionEvent<SessionId>) => void) {
      if (disposed) return { dispose() {} };
      listeners.add(listener);
      if (firstWatch) {
        firstWatch = false;
        for (const event of pending.splice(0)) listener(event);
      }
      return { dispose() { listeners.delete(listener); } };
    },
    dispose() { disposed = true; expectedCompaction = undefined; listeners.clear(); commands.clear(); turns.clear(); items.clear(); workflows.clear(); childItems.clear(); pending.length = 0; },
  };
}
