import {
  SessionWorkflowRunSnapshotV1Schema,
  type SessionWorkflowAgentSnapshotV1,
  type SessionWorkStateStatusV1,
  type SessionWorkStateV1,
  type SessionWorkflowAgentStatusV1,
  type SessionWorkflowRunSnapshotV1,
  type SessionWorkflowRunStatusV1,
} from '@happier-dev/protocol';

import type { AcpExtensionHandlerContext } from '@/agent/acp/AcpBackend';

export const GROK_SESSION_NOTIFICATION_METHODS = [
  'x.ai/session_notification',
  '_x.ai/session_notification',
  'x.ai/session/update',
  '_x.ai/session/update',
] as const;

type JsonObject = Readonly<Record<string, unknown>>;

const GROK_IMPLICIT_SUBAGENT_RUN_ID = 'implicit:grok-agent-activity';
const GROK_IMPLICIT_SUBAGENT_RUN_TITLE = 'Agent activity';

type TrackedGrokSubagent = SessionWorkflowAgentSnapshotV1;

function asRecord(value: unknown): JsonObject | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function readNonNegativeNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  const parsed = readNonNegativeNumber(value);
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
    default:
      return 'unknown';
  }
}

function mapWorkflowAgentStatus(value: unknown): SessionWorkflowAgentStatusV1 {
  switch (value) {
    case 'pending': return 'pending';
    case 'running':
    case 'active':
      return 'active';
    case 'complete':
    case 'completed':
      return 'complete';
    case 'failed': return 'failed';
    case 'blocked': return 'blocked';
    case 'cancelled':
    case 'aborted':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

function mapGoalStatus(value: unknown): SessionWorkStateStatusV1 {
  switch (value) {
    case 'active': return 'active';
    case 'complete': return 'complete';
    case 'cleared': return 'cancelled';
    case 'blocked':
    case 'budget_limited':
      return 'blocked';
    case 'user_paused':
    case 'back_off_paused':
    case 'no_progress_paused':
    case 'infra_paused':
    case 'doom_loop_paused':
      return 'paused';
    default:
      return 'unknown';
  }
}

function mapSubagentTerminalStatus(value: unknown): SessionWorkflowAgentStatusV1 {
  switch (value) {
    case 'failed': return 'failed';
    case 'cancelled':
    case 'aborted':
    case 'stopped':
      return 'cancelled';
    default:
      return 'complete';
  }
}

function isTerminalAgentStatus(status: SessionWorkflowAgentStatusV1): boolean {
  return status === 'complete' || status === 'failed' || status === 'cancelled';
}

function projectStandaloneSubagentRun(params: Readonly<{
  agents: ReadonlyMap<string, TrackedGrokSubagent>;
  revision: number;
  now: number;
}>): SessionWorkflowRunSnapshotV1 {
  const agents = [...params.agents.values()];
  const terminal = agents.filter((agent) => isTerminalAgentStatus(agent.status));
  const failedAgents = agents.filter((agent) => agent.status === 'failed').length;
  const cancelledAgents = agents.filter((agent) => agent.status === 'cancelled').length;
  const allTerminal = agents.length > 0 && terminal.length === agents.length;
  const status: SessionWorkflowRunStatusV1 = !allTerminal
    ? 'active'
    : failedAgents > 0
      ? 'failed'
      : cancelledAgents === agents.length
        ? 'cancelled'
        : 'complete';
  return SessionWorkflowRunSnapshotV1Schema.parse({
    v: 1,
    projectionVersion: 1,
    runId: GROK_IMPLICIT_SUBAGENT_RUN_ID,
    backendId: 'grok',
    agentId: 'grok',
    title: GROK_IMPLICIT_SUBAGENT_RUN_TITLE,
    status,
    vendorRef: GROK_IMPLICIT_SUBAGENT_RUN_ID,
    sourceRevision: String(params.revision),
    recordRevision: '0',
    startedAt: Math.min(...agents.map((agent) => agent.startedAt ?? agent.updatedAt)),
    ...(allTerminal ? { completedAt: params.now } : {}),
    updatedAt: params.now,
    totalAgents: agents.length,
    completedAgents: agents.filter((agent) => agent.status === 'complete').length,
    ...(failedAgents > 0 ? { failedAgents } : {}),
    ...(cancelledAgents > 0 ? { cancelledAgents } : {}),
    tokensUsed: agents.reduce((sum, agent) => sum + (agent.tokensUsed ?? 0), 0),
    toolCalls: agents.reduce((sum, agent) => sum + (agent.toolCalls ?? 0), 0),
    timeUsedSeconds: agents.reduce((sum, agent) => sum + (agent.timeUsedSeconds ?? 0), 0),
    phases: [],
    agents,
    objective: 'Grok subagent activity',
    foreground: false,
    activeAgents: agents.filter((agent) => agent.status === 'active').length,
  });
}

export function projectGrokWorkflowUpdate(
  update: unknown,
  options: Readonly<{ now?: number }> = {},
): SessionWorkflowRunSnapshotV1 | null {
  const record = asRecord(update);
  if (!record || record.sessionUpdate !== 'workflow_updated') return null;
  const runId = readString(record.run_id);
  const name = readString(record.name);
  const objective = readString(record.objective);
  if (!runId || !name || !objective) return null;

  const now = options.now ?? Date.now();
  const revision = readNonNegativeInteger(record.revision) ?? 0;
  const elapsedMs = readNonNegativeInteger(record.elapsed_ms) ?? 0;
  const rawPhases = Array.isArray(record.phases) ? record.phases : [];
  const agents = (Array.isArray(record.agents) ? record.agents : []).flatMap((value) => {
    const agent = asRecord(value);
    const id = readString(agent?.agent_id);
    const title = readString(agent?.label);
    if (!agent || !id || !title) return [];
    const phaseTitle = readString(agent.phase);
    const phaseIndex = phaseTitle
      ? rawPhases.findIndex((phase) => readString(asRecord(phase)?.title) === phaseTitle)
      : -1;
    const durationMs = readNonNegativeInteger(agent.duration_ms);
    const status = mapWorkflowAgentStatus(agent.state);
    const model = readString(agent.model);
    const tokensUsed = readNonNegativeInteger(agent.tokens_used);
    return [{
      id,
      title,
      status,
      vendorRef: id,
      ...(phaseIndex >= 0 ? { phaseIndex } : {}),
      ...(phaseTitle ? { phaseTitle } : {}),
      ...(model ? { model } : {}),
      ...(tokensUsed !== null ? { tokensUsed } : {}),
      ...(durationMs !== null ? {
        timeUsedSeconds: durationMs / 1_000,
        startedAt: Math.max(0, now - durationMs),
      } : {}),
      ...(status === 'complete' || status === 'failed' || status === 'cancelled'
        ? { completedAt: now }
        : {}),
      updatedAt: now,
    }];
  });
  const phases = rawPhases.flatMap((value, index) => {
    const phase = asRecord(value);
    const title = readString(phase?.title);
    if (!phase || !title) return [];
    const state = readString(phase.state);
    return [{
      id: `phase:${index}`,
      title,
      order: index,
      agentIds: agents.filter((agent) => agent.phaseTitle === title).map((agent) => agent.id),
      ...(state ? { state } : {}),
    }];
  });
  const status = mapWorkflowStatus(record.status);
  const agentsUsed = readNonNegativeInteger(record.agents_used) ?? agents.length;
  const agentsReserved = readNonNegativeInteger(record.agents_reserved) ?? 0;
  const failedAgents = agents.filter((agent) => agent.status === 'failed').length;
  const blockedAgents = agents.filter((agent) => agent.status === 'blocked').length;
  const cancelledAgents = agents.filter((agent) => agent.status === 'cancelled').length;
  const currentPhase = readString(record.current_phase);
  const currentAgentLabel = readString(record.current_agent_label);
  const lastEvent = readString(record.last_event);
  const lastEventDetail = readString(record.last_event_detail);
  const lastEventTimestamp = readString(record.last_event_timestamp);
  const pauseMessage = readString(record.pause_message);
  const resultSummary = readString(record.result_summary);
  const agentBudget = readNonNegativeInteger(record.agent_budget);
  const agentsRemaining = readNonNegativeInteger(record.agents_remaining);

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
    totalAgents: Math.max(agents.length, agentsUsed + agentsReserved),
    completedAgents: agents.filter((agent) => agent.status === 'complete').length,
    ...(failedAgents > 0 ? { failedAgents } : {}),
    ...(blockedAgents > 0 ? { blockedAgents } : {}),
    ...(cancelledAgents > 0 ? { cancelledAgents } : {}),
    tokensUsed: agents.reduce((sum, agent) => sum + (agent.tokensUsed ?? 0), 0),
    timeUsedSeconds: elapsedMs / 1_000,
    phases,
    agents,
    objective,
    foreground: record.foreground === true,
    ...(agentBudget !== null ? { agentBudget } : {}),
    agentsUsed,
    agentsReserved,
    ...(agentsRemaining !== null ? { agentsRemaining } : {}),
    agentUsageIncomplete: record.agent_usage_incomplete === true,
    activeAgents: readNonNegativeInteger(record.active_agents)
      ?? agents.filter((agent) => agent.status === 'active').length,
    ...(currentPhase ? { currentPhase } : {}),
    ...(currentAgentLabel ? { currentAgentLabel } : {}),
    ...(lastEvent ? { lastEvent } : {}),
    ...(lastEventDetail ? { lastEventDetail } : {}),
    ...(lastEventTimestamp ? { lastEventTimestamp } : {}),
    ...(pauseMessage ? { pauseMessage } : {}),
    ...(resultSummary ? { resultSummary } : {}),
  });
}

function unwrapSessionNotification(value: unknown): JsonObject | null {
  let current = asRecord(value);
  for (let depth = 0; current && depth < 2; depth += 1) {
    const params = asRecord(current.params);
    if (!params || (readString(current.sessionId) && !readString(current.method))) break;
    current = params;
  }
  return current;
}

function buildGrokGoalWorkState(update: JsonObject, now: number): SessionWorkStateV1 | null {
  if (update.sessionUpdate !== 'goal_updated') return null;
  const goalId = readString(update.goal_id);
  const objective = readString(update.objective);
  if (!goalId || !objective) return null;
  const cleared = update.status === 'cleared';
  const itemId = `grok.goal:${goalId}`;
  const totalDeliverables = readNonNegativeInteger(update.total_deliverables) ?? 0;
  const completedDeliverables = readNonNegativeInteger(update.completed_deliverables) ?? 0;
  const tokenBudget = readNonNegativeNumber(update.token_budget);
  const tokensUsed = readNonNegativeInteger(update.tokens_used);
  const elapsedMs = readNonNegativeNumber(update.elapsed_ms);
  const status = mapGoalStatus(update.status);
  return {
    v: 1,
    backendId: 'grok',
    agentId: 'grok',
    updatedAt: now,
    items: cleared ? [] : [{
      id: itemId,
      kind: 'goal',
      origin: 'vendor',
      status,
      ...(status === 'blocked' && update.status === 'budget_limited'
        ? { statusReason: 'budgetLimited' as const }
        : status === 'blocked'
          ? { statusReason: 'blocked' as const }
          : {}),
      title: objective,
      backendId: 'grok',
      agentId: 'grok',
      vendorRef: goalId,
      ...(totalDeliverables > 0
        ? { progress: Math.min(1, completedDeliverables / totalDeliverables) }
        : {}),
      ...(tokenBudget !== null && tokenBudget > 0 ? { tokenBudget } : {}),
      ...(tokensUsed !== null ? { tokensUsed } : {}),
      ...(elapsedMs !== null ? { timeUsedSeconds: elapsedMs / 1_000 } : {}),
      updatedAt: now,
      providerData: update,
    }],
    primaryItemId: cleared ? null : itemId,
  };
}

export type GrokSessionNotificationObserver = (
  value: unknown,
  context: AcpExtensionHandlerContext,
) => Promise<void>;

export function createGrokSessionNotificationObserver(params: Readonly<{
  publishWorkflowSnapshot: (
    snapshot: SessionWorkflowRunSnapshotV1,
    providerRevision: number,
  ) => Promise<boolean | void> | boolean | void;
  publishGoalWorkState: (snapshot: SessionWorkStateV1) => Promise<void> | void;
  now?: () => number;
}>): GrokSessionNotificationObserver {
  const now = params.now ?? Date.now;
  const providerRevisionByRun = new Map<string, number>();
  const standaloneSubagents = new Map<string, TrackedGrokSubagent>();
  const workflowSubagentIds = new Set<string>();
  let standaloneSubagentRevision = 0;
  let tail: Promise<void> = Promise.resolve();

  const handle = async (value: unknown, context: AcpExtensionHandlerContext): Promise<void> => {
    const notification = unwrapSessionNotification(value);
    const providerSessionId = readString(notification?.sessionId);
    const update = asRecord(notification?.update);
    if (!notification || !providerSessionId || !update || providerSessionId !== context.sessionId) return;

    if (update.sessionUpdate === 'workflow_updated') {
      const snapshot = projectGrokWorkflowUpdate(update, { now: now() });
      if (!snapshot) return;
      const revision = readNonNegativeInteger(update.revision) ?? 0;
      const previousRevision = providerRevisionByRun.get(snapshot.runId);
      if (previousRevision !== undefined && revision < previousRevision) return;
      const published = await params.publishWorkflowSnapshot(snapshot, revision);
      if (published !== false) providerRevisionByRun.set(snapshot.runId, revision);
      return;
    }

    if (
      update.sessionUpdate === 'subagent_spawned'
      || update.sessionUpdate === 'subagent_progress'
      || update.sessionUpdate === 'subagent_finished'
    ) {
      const subagentId = readString(update.subagent_id);
      if (!subagentId) return;
      if (update.sessionUpdate === 'subagent_spawned' && readString(update.workflow_run_id)) {
        workflowSubagentIds.add(subagentId);
        standaloneSubagents.delete(subagentId);
        return;
      }
      if (workflowSubagentIds.has(subagentId)) return;

      const observedAt = now();
      const existing = standaloneSubagents.get(subagentId);
      const durationMs = readNonNegativeInteger(update.duration_ms);
      const tokensUsed = readNonNegativeInteger(update.tokens_used);
      const toolCalls = readNonNegativeInteger(update.tool_call_count)
        ?? readNonNegativeInteger(update.tool_calls);
      const description = readString(update.description);
      const role = readString(update.role) ?? readString(update.subagent_type);
      const model = readString(update.model);
      const terminal = update.sessionUpdate === 'subagent_finished';
      const status = terminal
        ? mapSubagentTerminalStatus(update.status)
        : existing && isTerminalAgentStatus(existing.status)
          ? existing.status
          : 'active';
      const resultPreview = terminal
        ? (readString(update.error) ?? readString(update.output))?.slice(0, 2_000)
        : null;
      standaloneSubagents.set(subagentId, {
        id: subagentId,
        title: (description ?? existing?.title ?? role ?? subagentId).slice(0, 400),
        status,
        vendorRef: subagentId,
        ...(model ? { model: model.slice(0, 400) } : existing?.model ? { model: existing.model } : {}),
        ...(role ? { summary: role.slice(0, 2_000) } : existing?.summary ? { summary: existing.summary } : {}),
        ...(resultPreview ? { resultPreview } : existing?.resultPreview ? { resultPreview: existing.resultPreview } : {}),
        ...(tokensUsed !== null ? { tokensUsed } : existing?.tokensUsed !== undefined ? { tokensUsed: existing.tokensUsed } : {}),
        ...(toolCalls !== null ? { toolCalls } : existing?.toolCalls !== undefined ? { toolCalls: existing.toolCalls } : {}),
        ...(durationMs !== null
          ? { timeUsedSeconds: durationMs / 1_000 }
          : existing?.timeUsedSeconds !== undefined
            ? { timeUsedSeconds: existing.timeUsedSeconds }
            : {}),
        startedAt: existing?.startedAt ?? Math.max(0, observedAt - (durationMs ?? 0)),
        ...(terminal ? { completedAt: observedAt } : existing?.completedAt !== undefined ? { completedAt: existing.completedAt } : {}),
        updatedAt: observedAt,
      });
      standaloneSubagentRevision += 1;
      await params.publishWorkflowSnapshot(projectStandaloneSubagentRun({
        agents: standaloneSubagents,
        revision: standaloneSubagentRevision,
        now: observedAt,
      }), standaloneSubagentRevision);
      return;
    }

    const goal = buildGrokGoalWorkState(update, now());
    if (goal) await params.publishGoalWorkState(goal);
  };

  return async (value, context) => {
    const run = () => handle(value, context);
    tail = tail.then(run, run);
    await tail;
  };
}
