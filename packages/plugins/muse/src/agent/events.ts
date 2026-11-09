import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { AgentSessionRuntimeEvent, AgentSessionSendRequest, AgentSessionSubagentObservation } from '@happier-dev/plugin-sdk/agents/runtime';
import { SESSION_WORKFLOW_RUN_SNAPSHOT_TITLE_MAX, SESSION_WORKFLOW_RUN_SNAPSHOT_SUMMARY_MAX,
  type SessionWorkflowRunSnapshotV1, type SessionWorkflowAgentStatusV1 } from '@happier-dev/plugin-sdk/sessions/work-state';
import { MUSE_ACCOUNTING_SOURCE_ID } from './definition.js';

type EventContent<T = AgentSessionRuntimeEvent> = T extends AgentSessionRuntimeEvent
  ? Omit<T, 'sequence' | 'sessionId' | 'emittedAtMs'> : never;
type NativeRecord = Readonly<Record<string, JsonValue>>;
type Admission = { commandId: string; request: AgentSessionSendRequest; accepted: boolean; started: boolean; terminal?: boolean; continuations?: Set<string> };
type NativeItem = { value: NativeRecord; revision: number; streamedText: string; committed: boolean;
  presentation?: Readonly<{ toolCallId: string; toolName: string; input: JsonValue }> };
type NativeChild = { state?: NativeItem; workflowChild?: NativeRecord; label?: string; workflowRunId?: string };
type ChildObservation = AgentSessionSubagentObservation;

/** MSP objects are decoded once at this plugin's native boundary. */
export function readMuseRecord(value: JsonValue | undefined): NativeRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function createMuseEventProjection(options: Readonly<{ sessionId: string;
  onChild?(observation: ChildObservation): Promise<void>;
  onWorkflow?(snapshot: SessionWorkflowRunSnapshotV1): Promise<void>;
}>) {
  let sequence = 0;
  let nativeSessionId: string | undefined;
  let disposed = false;
  let firstWatch = true;
  const pending: AgentSessionRuntimeEvent[] = [];
  const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
  const commands = new Map<string, Admission>();
  const turns = new Map<string, Admission>();
  const items = new Map<string, NativeItem>();
  const workflows = new Map<string, { nativeTurnId: string; parentToolCallId: string; item?: NativeRecord; released?: boolean }>();
  const childItems = new Map<string, NativeChild>();

  function publish(content: EventContent) {
    if (disposed) return;
    const event: AgentSessionRuntimeEvent = Object.freeze({ ...content, sequence: ++sequence,
      sessionId: options.sessionId, emittedAtMs: Date.now() });
    if (firstWatch) pending.push(event);
    for (const listener of listeners) listener(event);
  }

  function correlation(nativeTurn: JsonValue | undefined) {
    if (typeof nativeTurn !== 'string') return {};
    const admission = turns.get(nativeTurn);
    return admission ? { turnId: admission.request.delivery.turnId, agentTurnId: nativeTurn } : {};
  }

  function accepted(admission: Admission) {
    if (admission.accepted) return;
    admission.accepted = true;
    const { inputIds, delivery } = admission.request;
    publish({ kind: 'input-accepted', inputIds, delivery: { kind: delivery.kind, turnId: delivery.turnId } });
  }

  function observeSession(value: JsonValue | undefined) {
    const session = readMuseRecord(value);
    if (typeof session.sessionId !== 'string' || nativeSessionId === session.sessionId) return;
    nativeSessionId = session.sessionId;
    publish({ kind: 'provider-session-id', providerSessionId: nativeSessionId,
      ...(typeof session.path === 'string' ? { nativeSessionLogPath: session.path } : {}) });
  }

  function textItem(itemId: string, state: NativeItem, completed: boolean) {
    const item = state.value;
    if (item.kind !== 'agentMessage' && item.kind !== 'reasoning' && item.kind !== 'userMessage') return;
    const role = item.kind === 'agentMessage' ? 'assistant' : item.kind === 'reasoning' ? 'reasoning' : 'user';
    const text = typeof item.text === 'string' ? item.text : state.streamedText;
    if (role !== 'user' && text.startsWith(state.streamedText)) {
      const delta = text.slice(state.streamedText.length);
      if (delta) publish({ kind: 'message-delta', messageId: itemId, channel: role,
        text: delta, ...correlation(item.turnId) });
    }
    state.streamedText = text;
    if (!completed || state.committed) return;
    state.committed = true;
    const admission = typeof item.turnId === 'string' ? turns.get(item.turnId) : undefined;
    if (role === 'user' && admission && item.commandId === admission.commandId) return;
    const owner = correlation(item.turnId);
    publish({ kind: 'transcript-message-committed', messageId: itemId, role, text,
      ...(owner.turnId ? { turnId: owner.turnId } : {}) });
  }

  function nativeJson(value: JsonValue | undefined): JsonValue {
    if (typeof value !== 'string') return value ?? null;
    try { return JSON.parse(value); } catch { return value; }
  }

  function workflowLaunch(item: NativeRecord, toolCallId: string) {
    if (item.tool !== 'workflow' || typeof item.visibleOutput !== 'string' || typeof item.turnId !== 'string') return;
    const result = readMuseRecord(nativeJson(item.visibleOutput));
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

  function finishChild(state: NativeItem, terminal: JsonValue | undefined) {
    if (state.committed || typeof state.value.subagentId !== 'string') return;
    if (terminal !== 'completed' && terminal !== 'failed' && terminal !== 'cancelled' && terminal !== 'interrupted') return;
    state.committed = true;
    publish({ kind: 'tool-result', toolCallId: state.value.subagentId,
      output: state.value.result ?? { status: terminal }, isError: terminal !== 'completed' });
  }

  function childStatus(child: NativeChild): ChildObservation['status'] | undefined {
    const workflow = child.workflowChild;
    const status = workflow?.status === 'terminal' ? workflow.terminal : workflow?.status;
    if (status === 'completed' || status === 'failed') return status;
    if (status === 'cancelled' || status === 'interrupted') return 'aborted';
    const native = child.state?.value;
    if (native?.status === 'completed' || native?.status === 'failed') return native.status;
    if (native?.status === 'cancelled' || native?.status === 'interrupted') return 'aborted';
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

  function childItem(state: NativeItem, previous: NativeItem | undefined): Promise<void> | undefined {
    const item = state.value;
    if (item.kind === 'subagent' && typeof item.subagentId === 'string') {
      const id = item.subagentId;
      const child = childItems.get(id) ?? {};
      child.state = state;
      if (typeof item.workflowRunId === 'string') child.workflowRunId = item.workflowRunId;
      childItems.set(id, child);
      if (!previous) publish({ kind: 'tool-call', toolCallId: item.subagentId, toolName: 'Task', input: childInput(item) });
      else publish({ kind: 'tool-progress', toolCallId: item.subagentId,
        progress: { toolName: 'Task', rawInput: childInput(item), status: item.status ?? 'unknown' } });
      finishChild(state, item.status);
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
        if (native.state) finishChild(native.state, child.status === 'terminal' ? child.terminal : child.status);
        changed.push([child.childId, native]);
      }
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
      : typeof item.tool === 'string' ? item.tool : typeof item.kind === 'string' ? item.kind : 'nativeItem';
    const input = item.kind === 'userShell' ? { command: item.commandText ?? '' }
      : fallback ? { text: item.fallbackText ?? '' } : nativeJson(item.args);
    state.presentation = { toolCallId, toolName, input };
    const owner = correlation(item.turnId);
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
    const output = fallback ? item.fallbackText ?? '' : item.visibleOutput === undefined
      ? { status: item.status ?? 'unknown', ...(item.failureKind === undefined ? {} : { failureKind: item.failureKind }),
        ...(item.failureReason === undefined ? {} : { failureReason: item.failureReason }) }
      : item.visibleOutput;
    publish({ kind: 'tool-result', toolCallId, output, isError: item.status !== 'completed', ...owner });
    if (item.status === 'completed') workflowLaunch(item, toolCallId);
  }

  function usageObservation(method: string, params: NativeRecord) {
    const first = readMuseRecord(readMuseRecord(params.sourceRange).first);
    const identity = typeof first.id === 'string' ? first.id : typeof params.viewCursor === 'string' ? params.viewCursor : undefined;
    if (!identity || typeof params.sessionId !== 'string') return;
    const owner = correlation(params.turnId);
    if (method === 'session/tokenUsage') {
      const usage = readMuseRecord(params.usage);
      if (typeof params.promptTokens !== 'number' || typeof usage.outputTokens !== 'number'
        || typeof usage.reasoningTokens !== 'number' || typeof usage.cacheReadTokens !== 'number'
        || typeof usage.cacheWriteTokens !== 'number' || typeof params.totalTokens !== 'number') return;
      // Muse's promptTokens is the counted-once derivation; usage.inputTokens is provider dependent.
      publish({ kind: 'usage-observed', observationId: `${params.sessionId}:${method}:${identity}`,
        source: MUSE_ACCOUNTING_SOURCE_ID, scope: 'turn_delta', ...(owner.turnId ? { turnId: owner.turnId } : {}),
        accounting: { nativeSessionId: params.sessionId, inferenceId: identity, inputIncludesCache: true, outputIncludesReasoning: true },
        ...(typeof params.modelId === 'string' ? { modelId: params.modelId } : {}),
        tokens: { input: params.promptTokens, output: usage.outputTokens, reasoning: usage.reasoningTokens,
          cacheRead: usage.cacheReadTokens, cacheWrite: usage.cacheWriteTokens, total: params.totalTokens } });
    } else if (typeof params.usedTokens === 'number') {
      publish({ kind: 'usage-observed', observationId: `${params.sessionId}:${method}:${identity}`,
        source: MUSE_ACCOUNTING_SOURCE_ID, scope: 'session_cumulative', accounting: { nativeSessionId: params.sessionId },
        context: { v: 1, modelId: typeof params.modelId === 'string' ? params.modelId : null,
          usedTokens: params.usedTokens, windowTokens: typeof params.windowTokens === 'number' ? params.windowTokens : null,
          totalProcessedTokens: null, baselineTokens: null, isAutoCompactEnabled: null, categories: null,
          observedAtMs: Date.now(), source: 'provider_live' } });
    }
  }

  function observe(message: Readonly<{ method: string; params?: JsonValue }>) {
    if (disposed) return;
    const params = readMuseRecord(message.params);
    if (message.method === 'session/tokenUsage' || message.method === 'session/contextUsage') { usageObservation(message.method, params); return; }
    if (message.method === 'session/started') { observeSession(params.session); return; }
    if (message.method === 'turn/started') {
      if (typeof params.turnId !== 'string') return;
      const admission = (typeof params.commandId === 'string' ? commands.get(params.commandId) : undefined)
        ?? turns.get(params.turnId);
      if (!admission || admission.started) return;
      admission.started = true;
      turns.set(params.turnId, admission);
      accepted(admission);
      publish({ kind: 'turn-start', turnId: admission.request.delivery.turnId, agentTurnId: params.turnId,
        startedBy: 'host' });
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
        publish({ kind: 'turn-cancelled', ...owner, cause: 'providerInterrupted' });
      } else if (params.terminal === 'failed') {
        publish({ kind: 'turn-failed', ...owner, diagnostic: { code: 'PLUGIN_EXEC_FAILED', severity: 'error' } });
      } else if (params.terminal === 'completed') {
        publish({ kind: 'turn-complete', ...owner });
      } else return;
      admission.terminal = true;
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
      if (typeof item.itemId !== 'string') return;
      const previous = items.get(item.itemId);
      const revision = typeof item.revision === 'number' ? item.revision : 0;
      if (previous && revision <= previous.revision) return;
      const state = { value: item, revision, streamedText: previous?.streamedText ?? '', committed: previous?.committed ?? false };
      items.set(item.itemId, state);
      const childPublication = childItem(state, previous);
      textItem(item.itemId, state, message.method === 'item/completed');
      toolItem(item.itemId, state, previous, message.method === 'item/completed');
      if (childPublication) return childPublication.then(() => workflowCompleted(item));
      workflowCompleted(item);
    }
  }

  return {
    publish,
    observeSession,
    admit(request: AgentSessionSendRequest, commandId: string) { commands.set(commandId, { commandId, request, accepted: false, started: false }); },
    accept(commandId: string, result: JsonValue) {
      const admission = commands.get(commandId);
      if (!admission) return;
      const response = readMuseRecord(result);
      if (response.status === 'accepted' && typeof response.turnId === 'string') {
        if (!admission.accepted) { turns.set(response.turnId, admission); accepted(admission); }
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
    watch(listener: (event: AgentSessionRuntimeEvent) => void) {
      if (disposed) return { dispose() {} };
      listeners.add(listener);
      if (firstWatch) {
        firstWatch = false;
        for (const event of pending.splice(0)) listener(event);
      }
      return { dispose() { listeners.delete(listener); } };
    },
    dispose() { disposed = true; listeners.clear(); commands.clear(); turns.clear(); items.clear(); workflows.clear(); childItems.clear(); pending.length = 0; },
  };
}
