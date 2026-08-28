import type {
  AgentAcpExtensionContext,
  AgentAcpNotificationExtension,
  AgentSessionRuntimeContext,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { defineProtocolJsonValue } from '@happier-dev/plugin-sdk/protocol';
import {
  ACTIVITY_SESSION_SYSTEM_RECORD_KINDS,
  SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE,
  SessionWorkflowRunSnapshotV1Schema,
  buildWorkflowRunSystemRecordLocalId,
  createWorkflowActivityPublisher,
  type SessionWorkflowAgentStatusV1,
  type SessionWorkflowRunSnapshotV1,
  type SessionWorkflowRunStatusV1,
} from '@happier-dev/plugin-sdk/sessions/work-state';

type GrokCurrentSession = NonNullable<AgentSessionRuntimeContext['services']['sessions']['current']>;
type GrokSubagentsService = AgentSessionRuntimeContext['services']['sessions']['subagents'];
type GrokWorkStatePublisher = ReturnType<AgentSessionRuntimeContext['workState']['publisher']>;

type GrokSessionNotificationObserverContext = Readonly<{
  services: Readonly<{
    logger: Pick<AgentSessionRuntimeContext['services']['logger'], 'warn'>;
    sessions: Readonly<{
      current: Readonly<{
        upsertSystemRecord(
          request: Parameters<GrokCurrentSession['upsertSystemRecord']>[0],
        ): Promise<unknown>;
        readSystemRecord(
          request: Parameters<GrokCurrentSession['readSystemRecord']>[0],
        ): Promise<Readonly<{ content?: unknown }> | null>;
      }> | null;
      subagents: Readonly<{
        observe(
          input: Parameters<GrokSubagentsService['observe']>[0],
          options?: Parameters<GrokSubagentsService['observe']>[1],
        ): Promise<unknown>;
      }>;
    }>;
  }>;
  session: Readonly<{
    services: Pick<AgentSessionRuntimeContext['session']['services'], 'workflowActivity'>;
  }>;
  workState: Readonly<{
    publisher(
      declaredSourceId: string,
    ): Pick<GrokWorkStatePublisher, 'publish'>;
  }>;
}>;

export const GROK_SESSION_NOTIFICATION_METHODS = [
  'x.ai/session_notification',
  '_x.ai/session_notification',
  'x.ai/session/update',
  '_x.ai/session/update',
] as const;

type JsonObject = Readonly<Record<string, unknown>>;
const ProtocolJsonValueSchema = defineProtocolJsonValue();

function asRecord(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function string(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function integer(value: unknown): number | null {
  const parsed = number(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

function mapWorkflowStatus(value: unknown): SessionWorkflowRunStatusV1 {
  switch (value) {
    case 'active': return 'active';
    case 'complete': return 'complete';
    case 'failed': return 'failed';
    case 'cancelled': return 'cancelled';
    case 'interrupted': return 'stopped';
    case 'blocked':
    case 'user_paused':
    case 'back_off_paused':
    case 'no_progress_paused':
    case 'infra_paused':
    case 'budget_limited':
      return 'blocked';
    default: return 'unknown';
  }
}

function mapWorkflowAgentStatus(value: unknown): SessionWorkflowAgentStatusV1 {
  switch (value) {
    case 'pending': return 'pending';
    case 'running':
    case 'active': return 'active';
    case 'complete':
    case 'completed': return 'complete';
    case 'failed': return 'failed';
    case 'blocked': return 'blocked';
    case 'cancelled':
    case 'aborted': return 'cancelled';
    default: return 'unknown';
  }
}

export function projectGrokWorkflowUpdate(
  update: unknown,
  options: Readonly<{ now?: number }> = {},
): SessionWorkflowRunSnapshotV1 | null {
  const record = asRecord(update);
  if (!record || record.sessionUpdate !== 'workflow_updated') return null;
  const runId = string(record.run_id);
  const name = string(record.name);
  const objective = string(record.objective);
  const revision = integer(record.revision) ?? 0;
  const elapsedMs = integer(record.elapsed_ms) ?? 0;
  if (!runId || !name || !objective) return null;
  const now = options.now ?? Date.now();

  const rawAgents = Array.isArray(record.agents) ? record.agents : [];
  const agents = rawAgents.flatMap((rawAgent) => {
    const agent = asRecord(rawAgent);
    const id = string(agent?.agent_id);
    const title = string(agent?.label);
    if (!agent || !id || !title) return [];
    const phaseTitle = string(agent.phase);
    const phaseIndex = phaseTitle && Array.isArray(record.phases)
      ? record.phases.findIndex((phase) => string(asRecord(phase)?.title) === phaseTitle)
      : -1;
    const durationMs = integer(agent.duration_ms);
    const status = mapWorkflowAgentStatus(agent.state);
    return [{
      id,
      title,
      status,
      vendorRef: id,
      ...(phaseIndex >= 0 ? { phaseIndex } : {}),
      ...(phaseTitle ? { phaseTitle } : {}),
      ...(string(agent.model) ? { model: string(agent.model)! } : {}),
      ...(integer(agent.tokens_used) !== null ? { tokensUsed: integer(agent.tokens_used)! } : {}),
      ...(durationMs !== null ? { timeUsedSeconds: durationMs / 1_000 } : {}),
      ...(durationMs !== null ? { startedAt: Math.max(0, now - durationMs) } : {}),
      ...(status === 'complete' || status === 'failed' || status === 'cancelled'
        ? { completedAt: now }
        : {}),
      updatedAt: now,
    }];
  });

  const rawPhases = Array.isArray(record.phases) ? record.phases : [];
  const phases = rawPhases.flatMap((rawPhase, index) => {
    const phase = asRecord(rawPhase);
    const title = string(phase?.title);
    if (!title) return [];
    return [{
      id: `phase:${index}`,
      title,
      order: index,
      agentIds: agents.filter((agent) => agent.phaseTitle === title).map((agent) => agent.id),
      ...(string(phase?.state) ? { state: string(phase?.state)! } : {}),
    }];
  });
  const status = mapWorkflowStatus(record.status);
  const agentsUsed = integer(record.agents_used) ?? agents.length;
  const agentsReserved = integer(record.agents_reserved) ?? 0;
  const totalAgents = Math.max(agents.length, agentsUsed + agentsReserved);
  const completedAgents = agents.filter((agent) => agent.status === 'complete').length;
  const failedAgents = agents.filter((agent) => agent.status === 'failed').length;
  const blockedAgents = agents.filter((agent) => agent.status === 'blocked').length;
  const cancelledAgents = agents.filter((agent) => agent.status === 'cancelled').length;

  return SessionWorkflowRunSnapshotV1Schema.parse({
    v: 1,
    projectionVersion: 1,
    runId,
    backendId: 'grok',
    agentId: 'grok',
    title: name,
    status,
    ...(record.status === 'interrupted' ? { statusReason: 'interrupted' } : {}),
    vendorRef: runId,
    sourceRevision: String(revision),
    recordRevision: '0',
    startedAt: Math.max(0, now - elapsedMs),
    ...(status === 'complete' || status === 'failed' || status === 'stopped' || status === 'cancelled'
      ? { completedAt: now }
      : {}),
    updatedAt: now,
    totalAgents,
    completedAgents,
    ...(failedAgents > 0 ? { failedAgents } : {}),
    ...(blockedAgents > 0 ? { blockedAgents } : {}),
    ...(cancelledAgents > 0 ? { cancelledAgents } : {}),
    tokensUsed: agents.reduce((sum, agent) => sum + (agent.tokensUsed ?? 0), 0),
    timeUsedSeconds: elapsedMs / 1_000,
    phases,
    agents,
    objective,
    foreground: record.foreground === true,
    ...(integer(record.agent_budget) !== null ? { agentBudget: integer(record.agent_budget)! } : {}),
    agentsUsed,
    agentsReserved,
    ...(integer(record.agents_remaining) !== null ? { agentsRemaining: integer(record.agents_remaining)! } : {}),
    agentUsageIncomplete: record.agent_usage_incomplete === true,
    activeAgents: integer(record.active_agents) ?? agents.filter((agent) => agent.status === 'active').length,
    ...(string(record.current_phase) ? { currentPhase: string(record.current_phase)! } : {}),
    ...(string(record.current_agent_label) ? { currentAgentLabel: string(record.current_agent_label)! } : {}),
    ...(string(record.last_event) ? { lastEvent: string(record.last_event)! } : {}),
    ...(string(record.last_event_detail) ? { lastEventDetail: string(record.last_event_detail)! } : {}),
    ...(string(record.last_event_timestamp) ? { lastEventTimestamp: string(record.last_event_timestamp)! } : {}),
    ...(string(record.pause_message) ? { pauseMessage: string(record.pause_message)! } : {}),
    ...(string(record.result_summary) ? { resultSummary: string(record.result_summary)! } : {}),
  });
}

function unwrapSessionNotification(value: unknown): JsonObject | null {
  let current = asRecord(value);
  for (let depth = 0; current && depth < 2; depth += 1) {
    const nestedParams = asRecord(current.params);
    if (!nestedParams || (string(current.sessionId) && !string(current.method))) break;
    current = nestedParams;
  }
  return current;
}

function mapSubagentStatus(value: unknown): 'running' | 'completed' | 'failed' | 'aborted' {
  if (value === 'completed') return 'completed';
  if (value === 'failed') return 'failed';
  if (value === 'cancelled' || value === 'aborted') return 'aborted';
  return 'running';
}

function mapGoalStatus(value: unknown): 'active' | 'paused' | 'blocked' | 'complete' | 'cancelled' | 'unknown' {
  if (value === 'active') return 'active';
  if (value === 'complete') return 'complete';
  if (value === 'cleared') return 'cancelled';
  if (value === 'blocked' || value === 'budget_limited') return 'blocked';
  if (value === 'user_paused' || value === 'back_off_paused' || value === 'no_progress_paused' || value === 'infra_paused' || value === 'doom_loop_paused') return 'paused';
  return 'unknown';
}

export function createGrokSessionNotificationObserver(params: Readonly<{
  context: GrokSessionNotificationObserverContext;
  now?: () => number;
}>): AgentAcpNotificationExtension {
  const now = params.now ?? Date.now;
  const snapshots = new Map<string, SessionWorkflowRunSnapshotV1>();
  const providerRevisionByRun = new Map<string, number>();
  const subagentDetailById = new Map<string, JsonObject>();
  const workflowRecordKind = ACTIVITY_SESSION_SYSTEM_RECORD_KINDS[0];
  const currentSession = params.context.services.sessions.current;
  const workflowPublisher = currentSession ? createWorkflowActivityPublisher({
    backendId: 'grok',
    agentId: 'grok',
    async commitRecord(snapshot) {
      await currentSession.upsertSystemRecord({
        address: {
          owner: 'host',
          namespace: SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE,
          kind: workflowRecordKind,
          localId: buildWorkflowRunSystemRecordLocalId({ runId: snapshot.runId }),
        },
        content: ProtocolJsonValueSchema.parse(snapshot),
      });
    },
    async readCommittedRunSnapshot(runId) {
      const record = await currentSession.readSystemRecord({
        address: {
          owner: 'host',
          namespace: SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE,
          kind: workflowRecordKind,
          localId: buildWorkflowRunSystemRecordLocalId({ runId }),
        },
      });
      const parsed = SessionWorkflowRunSnapshotV1Schema.safeParse(record?.content);
      return parsed.success ? parsed.data : null;
    },
    writeHeadlines: (bundle) => params.context.session.services.workflowActivity.publishHeadlines(bundle),
    onError: (error, detail) => params.context.services.logger.warn('Grok workflow activity publication failed', {
      runId: detail.runId,
      retryable: detail.retryable,
      error: error instanceof Error ? error.message : String(error),
    }),
    now,
  }) : null;
  const goalPublisher = params.context.workState.publisher('goals');
  let goalSourceSequence = 0;
  let tail: Promise<void> = Promise.resolve();

  const handle = async (value: unknown, extensionContext: AgentAcpExtensionContext): Promise<void> => {
    const notification = unwrapSessionNotification(value);
    const sessionId = string(notification?.sessionId);
    const update = asRecord(notification?.update);
    if (!notification || !sessionId || !update || sessionId !== extensionContext.providerSessionId) return;

    if (update.sessionUpdate === 'workflow_updated') {
      const snapshot = projectGrokWorkflowUpdate(update, { now: now() });
      if (!snapshot || !workflowPublisher) return;
      const revision = integer(update.revision) ?? 0;
      const previousRevision = providerRevisionByRun.get(snapshot.runId);
      if (previousRevision !== undefined && revision < previousRevision) return;
      snapshots.set(snapshot.runId, snapshot);
      const result = await workflowPublisher.publish({ snapshots, changedRunIds: [snapshot.runId] });
      if (!result.failedRunIds.includes(snapshot.runId)) {
        providerRevisionByRun.set(snapshot.runId, revision);
      }
      return;
    }

    const subagentId = string(update.subagent_id);
    if (subagentId && update.sessionUpdate === 'subagent_spawned') {
      const groupId = string(update.workflow_run_id) ?? undefined;
      const detail = {
        origin: 'agent',
        kind: 'native',
        agentRef: { agentId: 'grok', agentKind: string(update.subagent_type) ?? 'subagent' },
        label: string(update.description) ?? subagentId,
        agentMetadata: {
          childSessionId: string(update.child_session_id),
          parentSessionId: string(update.parent_session_id),
          parentPromptId: string(update.parent_prompt_id),
          model: string(update.model),
          persona: string(update.persona),
          role: string(update.role),
          capabilityMode: string(update.capability_mode),
          resumedFrom: string(update.resumed_from),
          workflowRunId: groupId ?? null,
        },
      } satisfies JsonObject;
      subagentDetailById.set(subagentId, detail);
      const subagentObserver = params.context.services.sessions.subagents;
      await subagentObserver.observe({
        observationId: `grok-native:${subagentId}`,
        ...(groupId ? { groupId } : {}),
        status: 'running',
        detail,
      }, { signal: extensionContext.signal });
      return;
    }
    if (subagentId && (update.sessionUpdate === 'subagent_progress' || update.sessionUpdate === 'subagent_finished')) {
      const baseDetail = subagentDetailById.get(subagentId) ?? {
        origin: 'agent', kind: 'native', agentRef: { agentId: 'grok', agentKind: 'subagent' }, label: subagentId,
      };
      const status = update.sessionUpdate === 'subagent_finished' ? mapSubagentStatus(update.status) : 'running';
      const groupId = string((asRecord(baseDetail.agentMetadata))?.workflowRunId) ?? undefined;
      const subagentObserver = params.context.services.sessions.subagents;
      await subagentObserver.observe({
        observationId: `grok-native:${subagentId}`,
        ...(groupId ? { groupId } : {}),
        status,
        detail: {
          ...baseDetail,
          agentMetadata: {
            ...(asRecord(baseDetail.agentMetadata) ?? {}),
            childSessionId: string(update.child_session_id),
            durationMs: integer(update.duration_ms),
            turns: integer(update.turns) ?? integer(update.turn_count),
            toolCalls: integer(update.tool_calls) ?? integer(update.tool_call_count),
            tokensUsed: integer(update.tokens_used),
            contextWindowTokens: integer(update.context_window_tokens),
            contextUsagePct: integer(update.context_usage_pct),
            toolsUsed: Array.isArray(update.tools_used) ? update.tools_used.filter((tool): tool is string => typeof tool === 'string') : null,
            errorCount: integer(update.error_count),
            error: string(update.error),
            output: string(update.output),
          },
        },
      }, { signal: extensionContext.signal });
      return;
    }

    if (update.sessionUpdate === 'goal_updated') {
      const goalId = string(update.goal_id);
      const objective = string(update.objective);
      if (!goalId || !objective) return;
      goalSourceSequence = Math.max(goalSourceSequence + 1, Math.trunc(now()));
      const cleared = update.status === 'cleared';
      const totalDeliverables = integer(update.total_deliverables) ?? 0;
      const completedDeliverables = integer(update.completed_deliverables) ?? 0;
      if (!goalPublisher) return;
      await goalPublisher.publish({
        sourceSequence: goalSourceSequence,
        observedAtMs: now(),
        items: cleared ? [] : [{
          localId: `grok-goal:${goalId}`,
          kind: 'goal',
          origin: 'vendor',
          status: mapGoalStatus(update.status),
          ...(update.status === 'blocked' ? { statusReason: 'blocked' } : {}),
          ...(update.status === 'budget_limited' ? { statusReason: 'budgetLimited' } : {}),
          title: objective,
          providerRef: goalId,
          ...(totalDeliverables > 0 ? { progress: Math.min(1, completedDeliverables / totalDeliverables) } : {}),
          ...(integer(update.token_budget) !== null ? { tokenBudget: integer(update.token_budget)! } : {}),
          ...(integer(update.tokens_used) !== null ? { tokensUsed: integer(update.tokens_used)! } : {}),
          ...(integer(update.elapsed_ms) !== null ? { timeUsedSeconds: integer(update.elapsed_ms)! / 1_000 } : {}),
          updatedAtMs: now(),
          providerData: ProtocolJsonValueSchema.parse(update),
        }],
        primaryLocalId: cleared ? null : `grok-goal:${goalId}`,
      }, { signal: extensionContext.signal });
    }
  };

  return async (value, extensionContext) => {
    const run = () => handle(value, extensionContext);
    tail = tail.then(run, run);
    await tail;
  };
}
