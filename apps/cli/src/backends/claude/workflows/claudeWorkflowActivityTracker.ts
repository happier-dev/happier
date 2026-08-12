import {
  isWorkflowRunSnapshotMaterialChange,
  SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
  type SessionWorkflowAgentSnapshotV1,
  type SessionWorkflowAgentStatusV1,
  type SessionWorkflowPhaseSnapshotV1,
  type SessionWorkflowRunSnapshotV1,
  type SessionWorkflowRunStatusReasonV1,
  type SessionWorkflowRunStatusV1,
} from '@happier-dev/protocol';

import type { ClaudeWorkflowTaskReference } from './claudeWorkflowTaskReference';
import type { ClaudeProviderTaskActivity } from '../providerActivity/createClaudeProviderActivityLedger';

import {
  parseClaudeWorkflowFact,
  type SubagentResultFact,
  type SubagentStartFact,
  type TaskLifecycleFact,
  type WorkflowAgentProfileFact,
  type WorkflowJournalFact,
  type WorkflowJournalAgentSpecFact,
  type WorkflowLaunchFact,
  type WorkflowProgressAgentFact,
  type WorkflowStartFact,
} from './claudeWorkflowCorrelation';
import {
  CLAUDE_IMPLICIT_WORKFLOW_AGENT_THRESHOLD,
  CLAUDE_IMPLICIT_WORKFLOW_RUN_ID,
  CLAUDE_IMPLICIT_WORKFLOW_RUN_TITLE,
  type WorkflowActivityObservation,
} from './claudeWorkflowActivityTypes';

/**
 * CWF2 in-memory workflow activity tracker.
 *
 * Folds raw Claude transcript values into a PER-RUN `Map<runId>` and projects each changed run into
 * a provider-agnostic `SessionWorkflowRunSnapshotV1`. This is the single owner of run/phase/agent
 * correlation, status mapping (delegated to the protocol Claude status mapper via the fact parser),
 * and material-change detection. It uses mutable maps internally for O(new events) updates but
 * exposes only immutable per-run snapshots and a per-run change observation. The durable activity
 * publisher is the sole owner of `recordRevision`.
 *
 * Invariants enforced here (never in UI):
 * - Two concurrent `Workflow` runs never merge phases/agents — agent rows are namespaced by run.
 * - Explicit `Workflow` runs win over the implicit "Agent activity" run: a child proven to belong to
 *   an explicit run is migrated off the implicit run.
 * - `phases[]` are authoritative for phase title/order; an agent's `phaseTitle` is supplementary.
 * - A single plain subagent stays a task (no implicit promotion); >=2 correlated subagents promote.
 * - Duplicate normalized snapshots do not produce changed-run observations.
 */

type MutablePhase = {
  id: string;
  index: number;
  title?: string;
  agentIds: string[];
};

/**
 * Where an agent's current title came from, highest authority first (RULING-13).
 *
 * - `journal`: the agent named ITSELF (a journal `result.lane`/`label`/`item`/`message`) or the
 *   provider handed us a title (`workflow_progress` label, `Task` description).
 * - `label`: a script-declared label matched to this agent by identity — never by position.
 * - `prompt`: the lane the agent's own sidecar prompt declares about itself.
 * - `ordinal`: `Workflow agent N`. Says nothing, but never says something false.
 *
 * A lower-authority source may fill a title but must never overwrite a higher-authority one, so a
 * late sidecar read cannot clobber the name an agent published for itself.
 */
type AgentTitleSource = 'journal' | 'label' | 'prompt' | 'ordinal';

const AGENT_TITLE_AUTHORITY: Readonly<Record<AgentTitleSource, number>> = {
  journal: 3,
  label: 2,
  prompt: 1,
  ordinal: 0,
};

/**
 * Everything one agent's own sidecar transcript has proven so far, kept whole.
 *
 * A journal `started` entry carries only `{type, key, agentId}` and no clock at all, so the sidecar
 * beside it is the only source for everything else about an anonymous agent: its name, its model,
 * the sidechain its transcript was imported under, its own start, and whether it died of a terminal
 * API error. The memo exists because a profile can be observed while the agent itself is not yet on
 * the roster — remembering only part of it would silently discard evidence we already hold, which
 * is how a proven start becomes "the moment we happened to look".
 */
type WorkflowAgentProfileMemo = Readonly<{
  title?: string;
  model?: string;
  sidechainId?: string;
  startedAt?: number;
  endedByApiError?: boolean;
  endedAt?: number;
}>;

/**
 * Fold one sidecar observation into the memo, keeping the BEST evidence per field, not the last.
 *
 * The follower re-emits accumulated facts rather than deltas, but it also stops re-reading a fact
 * the moment re-reading it could not change the answer — so a field proven by an early read and
 * absent from a later emission is still true, and a later emission is never a correction.
 */
function mergeAgentProfileMemo(
  previous: WorkflowAgentProfileMemo | undefined,
  fact: WorkflowAgentProfileFact,
): WorkflowAgentProfileMemo {
  const title = fact.title ?? previous?.title;
  const model = fact.model ?? previous?.model;
  // First import wins, for the same reason `upsertAgent` adopts a sidechain once: a second value
  // would mean a second transcript for one agent, and adopting it would orphan whatever was filed.
  const sidechainId = previous?.sidechainId ?? fact.sidechainId;
  // Earliest wins. A start may only move backwards — towards the instant the agent actually began.
  const startedAt = fact.startedAt !== undefined && previous?.startedAt !== undefined
    ? Math.min(fact.startedAt, previous.startedAt)
    : fact.startedAt ?? previous?.startedAt;
  // A death does not un-prove itself: the follower latches it, and every emission after it omits
  // nothing, but a memo that forgot it would resurrect a row the transcript already closed.
  const endedByApiError = fact.endedByApiError === true || previous?.endedByApiError === true;
  const endedAt = fact.endedAt ?? previous?.endedAt;
  return {
    ...(title ? { title } : {}),
    ...(model ? { model } : {}),
    ...(sidechainId ? { sidechainId } : {}),
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedByApiError ? { endedByApiError } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
}

type MutableAgent = {
  id: string;
  title: string;
  titleSource: AgentTitleSource;
  status: SessionWorkflowAgentStatusV1;
  vendorRef?: string;
  /** The sidechain this agent's own transcript was imported under. Set once, and only by proof. */
  sidechainId?: string;
  parentId?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  model?: string;
  summary?: string;
  resultPreview?: string;
  tokensUsed?: number;
  toolCalls?: number;
  timeUsedSeconds?: number;
  startedAt?: number;
  completedAt?: number;
  attempt?: number;
  updatedAt: number;
};

type MutableRun = {
  runId: string;
  workflowToolUseId?: string;
  providerTaskId?: string;
  providerRunId?: string;
  explicit: boolean;
  status: SessionWorkflowRunStatusV1;
  statusReason?: SessionWorkflowRunStatusReasonV1;
  title: string;
  sourceSessionId?: string;
  reconciledCounts?: Readonly<{
    totalAgents: number;
    completedAgents: number;
    failedAgents?: number;
    blockedAgents?: number;
  }>;
  startedAt?: number;
  completedAt?: number;
  tokensUsed?: number;
  toolCalls?: number;
  timeUsedSeconds?: number;
  phasesByIndex: Map<number, MutablePhase>;
  agentsById: Map<string, MutableAgent>;
  /** Arrival order of agent ids, so snapshot agent order is stable/deterministic. */
  agentOrder: string[];
  journalAgentSpecs: WorkflowJournalAgentSpecFact[];
  journalSpecIndexByKey: Map<string, number>;
  journalSpecIndexByAgentId: Map<string, number>;
  /** What each agent's own sidecar transcript says about itself, keyed by agent id. */
  agentProfilesById: Map<string, WorkflowAgentProfileMemo>;
  childToolUseIds: Set<string>;
  updatedAt: number;
};

export type ClaudeWorkflowActivityTracker = Readonly<{
  /** Fold one raw transcript value; returns the per-run change observation for the publisher. */
  observe(value: unknown, params: Readonly<{ updatedAt: number; live?: boolean }>): WorkflowActivityObservation;
  /** Runs proven by post-start live observation, excluding startup snapshot replay. */
  getLiveObservedRunIds(): ReadonlySet<string>;
  /** Current projected snapshot for one run, or null if unknown. */
  getRunSnapshot(runId: string): SessionWorkflowRunSnapshotV1 | null;
  /** All current run snapshots keyed by runId. */
  getRunSnapshotMap(): ReadonlyMap<string, SessionWorkflowRunSnapshotV1>;
  reconcileInterruptedRunFromHeadline(
    run: WorkflowInterruptedRunSeed,
    params: Readonly<{ updatedAt: number }>,
  ): WorkflowActivityObservation;
  /**
   * Resolve every non-terminal run and agent because the process that owned them is going away
   * (RULING-14). Called from an OBSERVED death — graceful teardown — never from a timer.
   */
  finalizeInterruptedActivityOnShutdown(
    params: Readonly<{ updatedAt: number }>,
  ): WorkflowActivityObservation;
  /** Run ids whose latest published agents are workflow-owned (CWF4 suppression hook). */
  getWorkflowOwnedAgentToolUseIds(): ReadonlySet<string>;
  /** True when the native provider task id is correlated to a Dynamic Workflow run. */
  isWorkflowOwnedProviderTaskId(taskId: string): boolean;
  /** True when either notification reference is owned by a Dynamic Workflow run. */
  isWorkflowOwnedTaskReference(reference: ClaudeWorkflowTaskReference): boolean;
}>;

export type WorkflowInterruptedRunSeed = Readonly<{
  runId: string;
  title: string;
  workflowToolUseId?: string;
  totalAgents: number;
  completedAgents: number;
  failedAgents?: number;
  blockedAgents?: number;
}>;

const TERMINAL_RUN_STATUSES: ReadonlySet<SessionWorkflowRunStatusV1> = new Set([
  'complete',
  'failed',
  'stopped',
  'cancelled',
]);

function isTerminalRunStatus(status: SessionWorkflowRunStatusV1): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

const TERMINAL_AGENT_STATUSES: ReadonlySet<SessionWorkflowAgentStatusV1> = new Set([
  'complete',
  'failed',
  'cancelled',
]);

function isTerminalAgentStatus(status: SessionWorkflowAgentStatusV1): boolean {
  return TERMINAL_AGENT_STATUSES.has(status);
}

/** Map an agent status signal up to a whole-run status when a lifecycle/terminal event lands. */
function runStatusFromSignal(signal: SessionWorkflowAgentStatusV1): SessionWorkflowRunStatusV1 {
  switch (signal) {
    case 'complete':
      return 'complete';
    case 'failed':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    case 'blocked':
      return 'blocked';
    case 'pending':
    case 'active':
      return 'active';
    default:
      return 'unknown';
  }
}

export function createClaudeWorkflowActivityTracker(params: Readonly<{
  backendId: string;
  agentId?: string;
  /**
   * Optional foreign-session guard. When provided and non-null, events whose source Claude session id
   * differs are rejected (mirrors the goal source's cross-session guard). Null/absent => accept all.
   */
  getCurrentClaudeSessionId?: () => string | null;
}>): ClaudeWorkflowActivityTracker {
  const runs = new Map<string, MutableRun>();
  const runIdByWorkflowToolUseId = new Map<string, string>();
  const runIdByProviderRunId = new Map<string, string>();
  const runIdByChildToolUseId = new Map<string, string>();
  // Claude `task_updated` terminal events carry only `task_id` (no `tool_use_id`), so the run's
  // provider task id is learned from earlier lifecycle events that carry both and used to route.
  const runIdByTaskId = new Map<string, string>();
  // Tool-use ids proven to be plain `Task` subagents. A successful subagent `tool_result` is
  // payload-identical to any other successful tool result, so this set is the only thing that makes
  // it recognisable — see `parseSubagentToolResult`.
  const subagentToolUseIds = new Set<string>();
  const liveObservedRunIds = new Set<string>();
  let implicitRunId: string | undefined;

  // Cache the last projected candidate per run so material-change detection is stable.
  const lastSnapshotByRun = new Map<string, SessionWorkflowRunSnapshotV1>();

  function resolveGuardSessionId(): string | null {
    return params.getCurrentClaudeSessionId?.() ?? null;
  }

  function isForeignSource(sourceSessionId: string | undefined): boolean {
    const guard = resolveGuardSessionId();
    if (!guard) return false;
    if (!sourceSessionId) return false;
    return sourceSessionId !== guard;
  }

  function ensureRun(runId: string, init: Partial<MutableRun> & { title: string; explicit: boolean }): MutableRun {
    const existing = runs.get(runId);
    if (existing) {
      if (init.explicit && !existing.explicit) existing.explicit = true;
      return existing;
    }
    const run: MutableRun = {
      runId,
      explicit: init.explicit,
      status: init.status ?? 'active',
      title: init.title,
      phasesByIndex: new Map(),
      agentsById: new Map(),
      agentOrder: [],
      journalAgentSpecs: [],
      journalSpecIndexByKey: new Map(),
      journalSpecIndexByAgentId: new Map(),
      agentProfilesById: new Map(),
      childToolUseIds: new Set(),
      updatedAt: init.updatedAt ?? 0,
      ...(init.workflowToolUseId ? { workflowToolUseId: init.workflowToolUseId } : {}),
      ...(init.sourceSessionId ? { sourceSessionId: init.sourceSessionId } : {}),
      ...(init.startedAt !== undefined ? { startedAt: init.startedAt } : {}),
    };
    runs.set(runId, run);
    return run;
  }

  function upsertPhase(run: MutableRun, index: number, title: string | undefined): void {
    const existing = run.phasesByIndex.get(index);
    if (existing) {
      // `phases[]` are authoritative: a present phase title is preserved; only fill when missing.
      if (title && !existing.title) existing.title = title;
      return;
    }
    run.phasesByIndex.set(index, {
      id: `phase:${index}`,
      index,
      ...(title ? { title } : {}),
      agentIds: [],
    });
  }

  function assignAgentToPhase(run: MutableRun, agentId: string, phaseIndex: number | undefined): void {
    if (phaseIndex === undefined) return;
    let phase = run.phasesByIndex.get(phaseIndex);
    if (!phase) {
      upsertPhase(run, phaseIndex, undefined);
      phase = run.phasesByIndex.get(phaseIndex);
    }
    if (phase && !phase.agentIds.includes(agentId)) {
      phase.agentIds.push(agentId);
    }
  }

  function upsertAgent(run: MutableRun, incoming: Readonly<{
    id: string;
    title: string;
    /** Defaults to `journal`: a provider-given title outranks anything we derived ourselves. */
    titleSource?: AgentTitleSource;
    status: SessionWorkflowAgentStatusV1;
    vendorRef?: string;
    sidechainId?: string;
    parentId?: string;
    phaseIndex?: number;
    phaseTitle?: string;
    model?: string;
    summary?: string;
    resultPreview?: string;
    tokensUsed?: number;
    toolCalls?: number;
    timeUsedSeconds?: number;
    startedAt?: number;
    completedAt?: number;
    attempt?: number;
    updatedAt: number;
  }>): void {
    // A run that has already finished holds no running work — the same rule `terminalizeRunAgents`
    // applies at the transition, applied to whatever arrives after it. The sweep runs once, but a
    // journal `started` keeps arriving during the follower's post-completion grace drain, and a
    // resumed process reads the sidecar only after replaying the transcript that closed the run:
    // over the real 3 064-record session, 37 of 39 runs are terminal before their journals drain.
    // An explicit run's status never reopens, so this cannot mislabel live work. The synthesized
    // implicit run is excluded deliberately: it is closed BY its agents and reopens when new work
    // joins it (`rollUpImplicitRunStatus`).
    const closedByFinishedRun = run.explicit
      && isTerminalRunStatus(run.status)
      && !isTerminalAgentStatus(incoming.status);
    const agent = closedByFinishedRun
      ? { ...incoming, status: 'cancelled' as SessionWorkflowAgentStatusV1 }
      : incoming;
    const existing = run.agentsById.get(agent.id);
    const titleSource = agent.titleSource ?? 'journal';
    if (!existing) {
      // The elapsed-time slot: an agent first seen ALIVE started when we first saw it. An agent
      // first seen already finished has no knowable start, and an invented one would paint a
      // fabricated elapsed figure — so it stays blank.
      const observedStartedAt = agent.startedAt
        ?? (isTerminalAgentStatus(agent.status) ? undefined : agent.updatedAt);
      // The other half of the slot. A row shows an interval, not a start, and the channels that
      // close an agent carry no time of their own (a journal `result` is `{type,key,agentId,result}`),
      // so the instant we OBSERVED the terminal transition is the only end available. Without it
      // every finished row is blank in both slots.
      const observedCompletedAt = agent.completedAt
        ?? (isTerminalAgentStatus(agent.status) ? agent.updatedAt : undefined);
      const created: MutableAgent = {
        id: agent.id,
        title: agent.title,
        titleSource,
        status: agent.status,
        updatedAt: agent.updatedAt,
        ...(agent.vendorRef ? { vendorRef: agent.vendorRef } : {}),
        ...(agent.sidechainId ? { sidechainId: agent.sidechainId } : {}),
        ...(agent.parentId ? { parentId: agent.parentId } : {}),
        ...(agent.phaseIndex !== undefined ? { phaseIndex: agent.phaseIndex } : {}),
        ...(agent.phaseTitle ? { phaseTitle: agent.phaseTitle } : {}),
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.summary ? { summary: agent.summary } : {}),
        ...(agent.resultPreview ? { resultPreview: agent.resultPreview } : {}),
        ...(agent.tokensUsed !== undefined ? { tokensUsed: agent.tokensUsed } : {}),
        ...(agent.toolCalls !== undefined ? { toolCalls: agent.toolCalls } : {}),
        ...(agent.timeUsedSeconds !== undefined ? { timeUsedSeconds: agent.timeUsedSeconds } : {}),
        ...(observedStartedAt !== undefined ? { startedAt: observedStartedAt } : {}),
        ...(observedCompletedAt !== undefined ? { completedAt: observedCompletedAt } : {}),
        ...(agent.attempt !== undefined ? { attempt: agent.attempt } : {}),
      };
      run.agentsById.set(agent.id, created);
      run.agentOrder.push(agent.id);
      assignAgentToPhase(run, agent.id, agent.phaseIndex);
      return;
    }
    // Latest-wins merge: newer non-empty fields overwrite; ids/order preserved.
    const isNewerAttempt = agent.attempt !== undefined && (existing.attempt === undefined || agent.attempt > existing.attempt);
    const shouldPreserveTerminalStatus = isTerminalAgentStatus(existing.status)
      && !isTerminalAgentStatus(agent.status)
      && !isNewerAttempt;
    if (agent.title && AGENT_TITLE_AUTHORITY[titleSource] >= AGENT_TITLE_AUTHORITY[existing.titleSource]) {
      existing.title = agent.title;
      existing.titleSource = titleSource;
    }
    if (!shouldPreserveTerminalStatus) {
      existing.status = agent.status;
      existing.updatedAt = agent.updatedAt;
      if (isNewerAttempt && !isTerminalAgentStatus(agent.status)) {
        delete existing.resultPreview;
        delete existing.summary;
        delete existing.completedAt;
      }
      // Same rule as the create path: the transition we just observed is the end, unless the fact
      // carried a real one (applied below) or a retry just cleared it.
      if (
        isTerminalAgentStatus(agent.status)
        && agent.completedAt === undefined
        && existing.completedAt === undefined
      ) {
        existing.completedAt = agent.updatedAt;
      }
    }
    if (agent.vendorRef) existing.vendorRef = agent.vendorRef;
    // First import wins. The id is composed from identifiers that do not change, so a SECOND value
    // would mean a second transcript for one agent; adopting it would orphan whatever was filed.
    if (agent.sidechainId && !existing.sidechainId) existing.sidechainId = agent.sidechainId;
    if (agent.parentId) existing.parentId = agent.parentId;
    if (agent.phaseIndex !== undefined) existing.phaseIndex = agent.phaseIndex;
    if (agent.phaseTitle) existing.phaseTitle = agent.phaseTitle;
    if (agent.model) existing.model = agent.model;
    if (agent.summary) existing.summary = agent.summary;
    if (agent.resultPreview) existing.resultPreview = agent.resultPreview;
    if (agent.tokensUsed !== undefined) existing.tokensUsed = agent.tokensUsed;
    if (agent.toolCalls !== undefined) existing.toolCalls = agent.toolCalls;
    if (agent.timeUsedSeconds !== undefined) existing.timeUsedSeconds = agent.timeUsedSeconds;
    // Earliest evidence wins. Moving a start time FORWARD would silently shrink an elapsed figure
    // already on screen, so a re-observation is ignored; moving it BACK can only be the agent's own
    // transcript proving it was already running before we noticed it, which is strictly better
    // evidence than the moment we looked.
    if (agent.startedAt !== undefined && (existing.startedAt === undefined || agent.startedAt < existing.startedAt)) {
      existing.startedAt = agent.startedAt;
    }
    if (agent.completedAt !== undefined) existing.completedAt = agent.completedAt;
    if (agent.attempt !== undefined) existing.attempt = agent.attempt;
    assignAgentToPhase(run, agent.id, agent.phaseIndex);
  }

  /**
   * Resolve every agent a finished run left mid-flight. Returns whether anything changed.
   *
   * A run that is over holds no running work, and this is the one place that says so. Three
   * different observations reach it — the run's own terminal lifecycle event, a reconcile from a
   * stale headline, and process death (RULING-14) — and they must resolve an agent identically, or
   * the roster contradicts itself depending on how the run ended.
   *
   * `cancelled`, never `failed`: the run contract already ruled that a run reconciled after a crash
   * lands as a stop rather than a failure, and an agent that produced no result while its run closed
   * did not fail — it was cut off. `completedAt` is the last instant that agent actually evidenced,
   * never the moment of the sweep, so an elapsed figure stays honest.
   */
  function terminalizeRunAgents(run: MutableRun, updatedAt: number): boolean {
    let touched = false;
    for (const agent of run.agentsById.values()) {
      if (isTerminalAgentStatus(agent.status)) continue;
      agent.status = 'cancelled';
      if (agent.completedAt === undefined) agent.completedAt = agent.updatedAt;
      agent.updatedAt = updatedAt;
      touched = true;
    }
    return touched;
  }

  /** Migrate an agent and its child tool-use routing off the implicit run onto an explicit run. */
  function migrateImplicitAgentToExplicit(agentId: string, explicitRun: MutableRun): void {
    if (!implicitRunId) return;
    const implicit = runs.get(implicitRunId);
    if (!implicit || implicit.runId === explicitRun.runId) return;
    if (!implicit.agentsById.has(agentId)) return;
    implicit.agentsById.delete(agentId);
    implicit.agentOrder = implicit.agentOrder.filter((id) => id !== agentId);
    for (const phase of implicit.phasesByIndex.values()) {
      phase.agentIds = phase.agentIds.filter((id) => id !== agentId);
    }
    implicit.childToolUseIds.delete(agentId);
    runIdByChildToolUseId.set(agentId, explicitRun.runId);
    // Drop the implicit run entirely once it no longer has enough agents to justify a card.
    if (implicit.agentsById.size === 0) {
      runs.delete(implicit.runId);
      lastSnapshotByRun.delete(implicit.runId);
      implicitRunId = undefined;
    }
  }

  function applyWorkflowStart(fact: WorkflowStartFact, updatedAt: number): string | null {
    if (isForeignSource(fact.sourceSessionId)) return null;
    const correlatedRunId = runIdByWorkflowToolUseId.get(fact.workflowToolUseId)
      ?? fact.workflowToolUseId;
    const run = ensureRun(correlatedRunId, {
      title: fact.title,
      explicit: true,
      status: 'active',
      workflowToolUseId: fact.workflowToolUseId,
      ...(fact.sourceSessionId ? { sourceSessionId: fact.sourceSessionId } : {}),
      updatedAt,
      startedAt: updatedAt,
    });
    runIdByWorkflowToolUseId.set(fact.workflowToolUseId, run.runId);
    for (const phase of fact.phases ?? []) {
      upsertPhase(run, phase.index, phase.title);
    }
    if (fact.journalAgentSpecs?.length) {
      run.journalAgentSpecs = [...fact.journalAgentSpecs];
      run.journalSpecIndexByKey.clear();
      run.journalSpecIndexByAgentId.clear();
    }
    run.updatedAt = updatedAt;
    return run.runId;
  }

  function applyWorkflowLaunch(
    fact: WorkflowLaunchFact,
    updatedAt: number,
    providerTaskActivities: ClaudeProviderTaskActivity[],
  ): string | null {
    if (isForeignSource(fact.sourceSessionId)) return null;
    const existingRunId = runIdByWorkflowToolUseId.get(fact.workflowToolUseId) ?? fact.workflowToolUseId;
    const existing = runs.get(existingRunId);
    if (!existing && !fact.confirmedLocalWorkflow) return null;
    let run = ensureRun(existingRunId, {
      title: fact.title ?? 'Workflow',
      explicit: true,
      status: 'active',
      workflowToolUseId: fact.workflowToolUseId,
      ...(fact.sourceSessionId ? { sourceSessionId: fact.sourceSessionId } : {}),
      updatedAt,
      startedAt: updatedAt,
    });
    runIdByWorkflowToolUseId.set(fact.workflowToolUseId, run.runId);

    if (fact.providerRunId) {
      const correlatedRunId = runIdByProviderRunId.get(fact.providerRunId);
      const correlatedRun = correlatedRunId ? runs.get(correlatedRunId) : undefined;
      if (correlatedRun && correlatedRun.runId !== run.runId) {
        const supersededRunId = run.runId;
        const priorProviderTaskId = correlatedRun.providerTaskId;
        const providerSessionId = correlatedRun.sourceSessionId ?? fact.sourceSessionId;
        if (priorProviderTaskId && priorProviderTaskId !== fact.taskId && providerSessionId) {
          providerTaskActivities.push({
            type: 'terminal',
            sessionId: providerSessionId,
            taskId: priorProviderTaskId,
            rememberIfUnknown: true,
          });
          runIdByTaskId.delete(priorProviderTaskId);
        }

        for (const [toolUseId, ownedRunId] of runIdByWorkflowToolUseId) {
          if (ownedRunId === supersededRunId) {
            runIdByWorkflowToolUseId.set(toolUseId, correlatedRun.runId);
          }
        }
        for (const [taskId, ownedRunId] of runIdByTaskId) {
          if (ownedRunId === supersededRunId) {
            runIdByTaskId.set(taskId, correlatedRun.runId);
          }
        }
        for (const [childToolUseId, ownedRunId] of runIdByChildToolUseId) {
          if (ownedRunId === supersededRunId) {
            runIdByChildToolUseId.set(childToolUseId, correlatedRun.runId);
          }
        }
        runs.delete(supersededRunId);
        lastSnapshotByRun.delete(supersededRunId);
        liveObservedRunIds.delete(supersededRunId);
        run = correlatedRun;
        runIdByWorkflowToolUseId.set(fact.workflowToolUseId, run.runId);
      }
      run.providerRunId = fact.providerRunId;
      runIdByProviderRunId.set(fact.providerRunId, run.runId);
    }

    if (fact.title) run.title = fact.title;
    if (fact.sourceSessionId && !run.sourceSessionId) run.sourceSessionId = fact.sourceSessionId;
    if (fact.taskId) {
      run.providerTaskId = fact.taskId;
      runIdByTaskId.set(fact.taskId, run.runId);
    }
    if (!isTerminalRunStatus(run.status)) run.status = 'active';
    run.updatedAt = updatedAt;
    return run.runId;
  }

  function applyTaskLifecycle(
    fact: TaskLifecycleFact,
    updatedAt: number,
    providerTaskActivities: ClaudeProviderTaskActivity[],
  ): string | null {
    if (isForeignSource(fact.sourceSessionId)) return null;
    const toolUseId = fact.toolUseId;
    // Route to an explicit Workflow run if the tool-use id names one, else to a child's owning run,
    // else via the run's learned provider task id (terminal `task_updated` carries only `task_id`).
    let run: MutableRun | undefined;
    if (toolUseId) {
      const workflowRunId = runIdByWorkflowToolUseId.get(toolUseId);
      run = workflowRunId ? runs.get(workflowRunId) : runs.get(toolUseId);
      if (!run) {
        const childRunId = runIdByChildToolUseId.get(toolUseId);
        if (childRunId) run = runs.get(childRunId);
      }
    }
    if (!run && fact.taskId) {
      const taskRunId = runIdByTaskId.get(fact.taskId);
      if (taskRunId) run = runs.get(taskRunId);
    }
    if (!run) return null;
    if (
      fact.taskId
      && run.providerTaskId
      && fact.taskId !== run.providerTaskId
      && !runIdByTaskId.has(fact.taskId)
    ) {
      return null;
    }

    // A lifecycle event addressed to a CHILD agent's tool-use id closes that agent, never the run.
    // Without this, one failed subagent inside a fan-out marked the whole run failed, and a plain
    // subagent's own `task_notification` closed the synthesized "Agent activity" run around it.
    if (
      toolUseId
      && toolUseId !== run.runId
      && toolUseId !== run.workflowToolUseId
      && runIdByChildToolUseId.get(toolUseId) === run.runId
      && run.agentsById.has(toolUseId)
    ) {
      const childStatus = runStatusFromSignal(fact.status);
      if (!isTerminalRunStatus(childStatus)) return run.runId;
      applyChildAgentTerminal(run, {
        agentId: toolUseId,
        status: fact.status === 'unknown' ? 'unknown' : fact.status,
        updatedAt,
        ...(fact.summary ? { summary: fact.summary } : {}),
        ...(fact.resultPreview ? { resultPreview: fact.resultPreview } : {}),
        ...(fact.completedAt !== undefined ? { completedAt: fact.completedAt } : {}),
        ...(fact.usage.timeUsedSeconds !== undefined ? { timeUsedSeconds: fact.usage.timeUsedSeconds } : {}),
      });
      return run.runId;
    }

    // Learn the run's provider task id so a later id-only terminal event can route back to it.
    if (fact.taskId) {
      run.providerTaskId = fact.taskId;
      runIdByTaskId.set(fact.taskId, run.runId);
    }

    run.updatedAt = updatedAt;
    if (fact.sourceSessionId && !run.sourceSessionId) run.sourceSessionId = fact.sourceSessionId;
    if (fact.usage.tokensUsed !== undefined) run.tokensUsed = fact.usage.tokensUsed;
    if (fact.usage.toolCalls !== undefined) run.toolCalls = fact.usage.toolCalls;
    if (fact.usage.timeUsedSeconds !== undefined) run.timeUsedSeconds = fact.usage.timeUsedSeconds;
    if (fact.startedAt !== undefined && run.startedAt === undefined) run.startedAt = fact.startedAt;
    if (fact.completedAt !== undefined) run.completedAt = fact.completedAt;

    // Workflow phase/agent rows are the canonical Dynamic Workflow structure.
    for (const entry of fact.workflowProgress ?? []) {
      if (entry.kind === 'phase') {
        upsertPhase(run, entry.index, entry.title);
        continue;
      }
      applyWorkflowProgressAgent(run, entry, updatedAt);
    }

    // Whole-run status: a terminal lifecycle event closes the run; otherwise it stays active.
    const priorStatus = run.status;
    const runSignal = runStatusFromSignal(fact.status);
    if (isTerminalRunStatus(runSignal)) {
      run.status = runSignal;
      // A real terminal transition supersedes any older diagnostic qualifier.
      delete run.statusReason;
    } else if (!isTerminalRunStatus(run.status)) {
      run.status = runSignal === 'unknown' ? run.status : runSignal;
    }
    if (!isTerminalRunStatus(priorStatus) && isTerminalRunStatus(run.status)) {
      // The run just ended, so nothing inside it is still running. The journal closes 81% of agents
      // itself; the rest are cut off mid-flight and have no other terminal channel at all.
      terminalizeRunAgents(run, updatedAt);
      if (run.sourceSessionId && run.providerTaskId) {
        const terminalStatus = run.status === 'complete'
          ? 'completed'
          : run.status === 'failed'
            ? 'failed'
            : 'stopped';
        providerTaskActivities.push({
          type: 'terminal',
          terminalStatus,
          sessionId: run.sourceSessionId,
          taskId: run.providerTaskId,
        });
      }
    }
    return run.runId;
  }

  function applyWorkflowProgressAgent(run: MutableRun, entry: WorkflowProgressAgentFact, updatedAt: number): void {
    // Explicit-wins: if this agent currently lives on the implicit run, migrate it here.
    migrateImplicitAgentToExplicit(entry.id, run);
    upsertAgent(run, {
      id: entry.id,
      title: entry.title,
      status: entry.status,
      updatedAt,
      ...(entry.vendorRef ? { vendorRef: entry.vendorRef } : {}),
      ...(entry.phaseIndex !== undefined ? { phaseIndex: entry.phaseIndex } : {}),
      ...(entry.phaseTitle ? { phaseTitle: entry.phaseTitle } : {}),
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.resultPreview ? { resultPreview: entry.resultPreview } : {}),
      ...(entry.tokensUsed !== undefined ? { tokensUsed: entry.tokensUsed } : {}),
      ...(entry.toolCalls !== undefined ? { toolCalls: entry.toolCalls } : {}),
      ...(entry.timeUsedSeconds !== undefined ? { timeUsedSeconds: entry.timeUsedSeconds } : {}),
      ...(entry.attempt !== undefined ? { attempt: entry.attempt } : {}),
    });
    run.childToolUseIds.add(entry.id);
    if (entry.vendorRef) run.childToolUseIds.add(entry.vendorRef);
    runIdByChildToolUseId.set(entry.id, run.runId);
    if (entry.vendorRef) runIdByChildToolUseId.set(entry.vendorRef, run.runId);
  }

  function resolveJournalPhaseIndex(run: MutableRun, fact: WorkflowJournalFact): number | undefined {
    if (fact.phaseTitle) {
      const normalized = fact.phaseTitle.toLocaleLowerCase();
      for (const phase of run.phasesByIndex.values()) {
        if (phase.title?.toLocaleLowerCase() === normalized) return phase.index;
      }
      const nextIndex = Math.max(0, ...[...run.phasesByIndex.keys()]) + 1;
      upsertPhase(run, nextIndex, fact.phaseTitle);
      return nextIndex;
    }
    if (run.phasesByIndex.size === 1) {
      return [...run.phasesByIndex.keys()][0];
    }
    return undefined;
  }

  /**
   * The script-declared label for THIS agent, or nothing.
   *
   * RULING-13: a label is attached only through a stable identity — the journal key or the agent id
   * (both learned from an earlier identity match), or the agent naming the label ITSELF in its
   * result. There is deliberately no positional fallback: the journal delivers agents in completion
   * order while a script declares them in text order, and for any `parallel()`/`pipeline()` stage
   * those orders are unrelated. Zipping the two gave 4 of 6 agents ANOTHER lane's name in a real
   * production run. The journal key is an opaque `v2:<sha256>` that cannot be reconstructed from the
   * script, and only 49 of 720 real script labels appear verbatim in exactly one agent prompt, so no
   * derivable key exists — which is why the positional path was deleted rather than repaired.
   */
  function resolveJournalSpec(run: MutableRun, fact: WorkflowJournalFact): WorkflowJournalAgentSpecFact | undefined {
    if (fact.journalKey) {
      const existingIndex = run.journalSpecIndexByKey.get(fact.journalKey);
      if (existingIndex !== undefined) return run.journalAgentSpecs[existingIndex];
    }
    const existingAgentIndex = run.journalSpecIndexByAgentId.get(fact.agentId);
    if (existingAgentIndex !== undefined) {
      if (fact.journalKey) run.journalSpecIndexByKey.set(fact.journalKey, existingAgentIndex);
      return run.journalAgentSpecs[existingAgentIndex];
    }

    const assignedIndexes = new Set([...run.journalSpecIndexByKey.values(), ...run.journalSpecIndexByAgentId.values()]);
    const titleNormalized = fact.title.toLocaleLowerCase();
    const matchingIndex = run.journalAgentSpecs.findIndex((spec, index) => {
      if (assignedIndexes.has(index)) return false;
      return spec.label.toLocaleLowerCase() === titleNormalized;
    });
    if (matchingIndex < 0) return undefined;
    const spec = run.journalAgentSpecs[matchingIndex];
    if (!spec) return undefined;
    if (fact.journalKey) run.journalSpecIndexByKey.set(fact.journalKey, matchingIndex);
    run.journalSpecIndexByAgentId.set(fact.agentId, matchingIndex);
    return spec;
  }

  function applyWorkflowJournal(fact: WorkflowJournalFact, updatedAt: number): string | null {
    if (isForeignSource(fact.sourceSessionId)) return null;
    const workflowRunId = runIdByWorkflowToolUseId.get(fact.workflowToolUseId)
      ?? fact.workflowToolUseId;
    const run = runs.get(workflowRunId);
    if (!run) return null;
    if (fact.sourceSessionId && !run.sourceSessionId) run.sourceSessionId = fact.sourceSessionId;
    const journalSpec = resolveJournalSpec(run, fact);
    const existingAgentIndex = run.agentOrder.indexOf(fact.agentId);
    const fallbackOrdinal = existingAgentIndex >= 0 ? existingAgentIndex + 1 : run.agentOrder.length + 1;
    // W-7: a journal fact whose title is just the raw agent id is opaque — regardless of status. A
    // terminal `result` entry with no lane/label/message fields falls back to the agentId in the
    // parser, so gating this on `status === 'active'` (the old code) leaked the RAW HEX AGENT ID as
    // the row title for completed agents. Never display a raw agent id.
    const isOpaqueJournalTitle = fact.title === fact.agentId;
    // RULING-13 naming priority, highest first:
    //   1. the name the agent published for ITSELF (a journal result lane/label/item/message);
    //   2. a script label matched by stable identity (never by position — see `resolveJournalSpec`);
    //   3. the lane the agent's own sidecar prompt declares (`workflow-agent-profile`);
    //   4. `Workflow agent N` — stable, and never false.
    const journalLabel = journalSpec && journalSpec.label !== fact.agentId ? journalSpec.label : undefined;
    const profile = run.agentProfilesById.get(fact.agentId);
    const resolved: { title: string; source: AgentTitleSource } = isOpaqueJournalTitle
      ? journalLabel
        ? { title: journalLabel, source: 'label' }
        : profile?.title
          ? { title: profile.title, source: 'prompt' }
          : { title: `Workflow agent ${fallbackOrdinal}`, source: 'ordinal' }
      : { title: fact.title, source: 'journal' };
    const effectiveFact = journalSpec
      ? {
        ...fact,
        title: resolved.title,
        phaseTitle: fact.phaseTitle ?? journalSpec.phaseTitle,
      }
      : {
        ...fact,
        title: resolved.title,
      };
    const phaseIndex = resolveJournalPhaseIndex(run, effectiveFact);
    upsertAgent(run, {
      id: effectiveFact.agentId,
      title: effectiveFact.title,
      titleSource: resolved.source,
      status: effectiveFact.status,
      updatedAt,
      parentId: effectiveFact.workflowToolUseId,
      ...(phaseIndex !== undefined ? { phaseIndex } : {}),
      ...(effectiveFact.phaseTitle ? { phaseTitle: effectiveFact.phaseTitle } : {}),
      ...(effectiveFact.summary ? { summary: effectiveFact.summary } : {}),
      ...(effectiveFact.resultPreview ? { resultPreview: effectiveFact.resultPreview } : {}),
    });
    // Everything the agent's own sidecar already proved, folded on by its single owner. The agent
    // may have existed for the first time one line ago, so this is also the pre-journal path: a
    // memo remembered before the roster knew this agent is applied here, whole.
    const agent = run.agentsById.get(effectiveFact.agentId);
    if (agent && profile) applyAgentProfileMemo(run, agent, profile, updatedAt);
    run.childToolUseIds.add(effectiveFact.agentId);
    runIdByChildToolUseId.set(effectiveFact.agentId, run.runId);
    run.updatedAt = updatedAt;
    return run.runId;
  }

  /**
   * Fold everything one agent's sidecar has proven onto that agent — the single owner of what a
   * sidecar MEANS, so the two orderings that reach it cannot disagree.
   *
   * Both are supported: the profile arriving after the agent is on the roster (the follower's own
   * ordering — 154 of 154 profile emissions over the real 144-agent session `15a64b1f`), and a
   * memo remembered before it, applied by `applyWorkflowJournal` the moment the agent appears.
   */
  function applyAgentProfileMemo(
    run: MutableRun,
    existing: MutableAgent,
    memo: WorkflowAgentProfileMemo,
    updatedAt: number,
  ): void {
    // The agent's own transcript ended in a terminal API error while this process kept running and
    // its run stayed open — the one death neither a stop nor a resume can ever observe. Per
    // RULING-14 that is a STOP, not a failure, ending at the last instant the file evidences.
    //
    // An agent that reported its OWN outcome keeps it; one that a sweep resolved does not, because
    // the sweep could only date it from the last journal line we happened to see while the
    // transcript names the instant the agent actually stopped. Better evidence for the same event.
    const reportedOwnOutcome = existing.status === 'complete' || existing.status === 'failed';
    const died = memo.endedByApiError === true && !reportedOwnOutcome;
    upsertAgent(run, {
      id: existing.id,
      title: memo.title ?? existing.title,
      // Rank 3 in the RULING-13 ladder: a prompt-declared lane fills an ordinal but never displaces
      // the name an agent published for itself, which `upsertAgent` enforces by authority.
      titleSource: memo.title ? 'prompt' : existing.titleSource,
      status: died ? 'cancelled' : existing.status,
      updatedAt: died ? updatedAt : existing.updatedAt,
      ...(memo.model ? { model: memo.model } : {}),
      ...(memo.sidechainId ? { sidechainId: memo.sidechainId } : {}),
      // Never fabricated: only a start the sidecar's first record actually carries, and
      // `upsertAgent` keeps the earliest of it and anything already on screen.
      ...(memo.startedAt !== undefined ? { startedAt: memo.startedAt } : {}),
      ...(died ? { completedAt: memo.endedAt ?? existing.completedAt ?? existing.updatedAt } : {}),
    });
  }

  /**
   * What one workflow agent's own sidecar transcript proves about it.
   *
   * A journal `started` entry carries only `{type, key, agentId}`, so 100% of workflow agents are
   * anonymous while they run. The agent's own `agent-<id>.jsonl`/`.meta.json` sit in the directory
   * the journal follower already watches; this folds them in. It never creates an agent — reading a
   * file is not evidence of a lifecycle transition — but a profile that lands before the journal
   * entry is remembered WHOLE and applied the moment the agent appears.
   */
  function applyWorkflowAgentProfile(fact: WorkflowAgentProfileFact, updatedAt: number): string | null {
    if (isForeignSource(fact.sourceSessionId)) return null;
    // An import with no readable prompt and no model is still evidence: it makes the agent openable.
    // So is a start the agent's own transcript records, and so is that transcript ending in a
    // terminal API error.
    if (
      !fact.title
      && !fact.model
      && !fact.sidechainId
      && fact.startedAt === undefined
      && !fact.endedByApiError
    ) return null;
    const workflowRunId = runIdByWorkflowToolUseId.get(fact.workflowToolUseId) ?? fact.workflowToolUseId;
    const run = runs.get(workflowRunId);
    if (!run) return null;

    const memo = mergeAgentProfileMemo(run.agentProfilesById.get(fact.agentId), fact);
    run.agentProfilesById.set(fact.agentId, memo);

    const existing = run.agentsById.get(fact.agentId);
    if (!existing) return run.runId;
    applyAgentProfileMemo(run, existing, memo, updatedAt);
    run.updatedAt = updatedAt;
    return run.runId;
  }

  function applySubagentStart(fact: SubagentStartFact, updatedAt: number): string | null {
    if (isForeignSource(fact.sourceSessionId)) return null;
    subagentToolUseIds.add(fact.toolUseId);
    // A child whose explicit parent is a known Workflow run attaches there (explicit-wins).
    if (fact.parentToolUseId) {
      const parentRunId = runIdByWorkflowToolUseId.get(fact.parentToolUseId)
        ?? fact.parentToolUseId;
      const parentRun = runs.get(parentRunId);
      if (parentRun) {
        migrateImplicitAgentToExplicit(fact.toolUseId, parentRun);
        upsertAgent(parentRun, {
          id: fact.toolUseId,
          title: fact.title,
          status: 'active',
          updatedAt,
          parentId: fact.parentToolUseId,
        });
        parentRun.childToolUseIds.add(fact.toolUseId);
        runIdByChildToolUseId.set(fact.toolUseId, parentRun.runId);
        parentRun.updatedAt = updatedAt;
        return parentRun.runId;
      }
    }

    // Otherwise this is implicit-run material. Buffer it; promote to a run only at the threshold.
    return promoteImplicitSubagent(fact, updatedAt);
  }

  // Plain subagents that are not (yet) owned by an explicit run. They become an implicit run only
  // once >= threshold are seen, so a single plain subagent stays a task (CWF4). A buffered entry
  // keeps any terminal result observed while it waited, so a promotion later cannot resurrect a
  // finished subagent as `active`.
  //
  // `startedAt` is carried separately from `updatedAt` because the buffer is the only place that
  // still remembers it: an entry that finished while waiting is created ALREADY TERMINAL at
  // promotion, and `upsertAgent` deliberately defaults a start time only for an agent created
  // alive. Without this the observation is simply dropped — and it is a real observation, not a
  // guess, so carrying it does not weaken that rule.
  type PendingImplicitSubagent = SubagentStartFact & {
    updatedAt: number;
    startedAt: number;
    status: SessionWorkflowAgentStatusV1;
    resultPreview?: string;
    timeUsedSeconds?: number;
  };
  const pendingImplicitSubagents = new Map<string, PendingImplicitSubagent>();

  function promoteImplicitSubagent(fact: SubagentStartFact, updatedAt: number): string | null {
    if (implicitRunId) {
      const run = runs.get(implicitRunId);
      if (run) {
        upsertAgent(run, { id: fact.toolUseId, title: fact.title, status: 'active', updatedAt });
        run.childToolUseIds.add(fact.toolUseId);
        runIdByChildToolUseId.set(fact.toolUseId, run.runId);
        run.updatedAt = updatedAt;
        // The synthesized run has no lifecycle of its own: its agents decide its status in BOTH
        // directions. Without this, a run closed when its last subagent finished stays `complete`
        // around live work, and the new agent is drawn as a loose live row outside a finished card.
        rollUpImplicitRunStatus(run);
        return run.runId;
      }
    }

    // Buffer it once. The raw transcript channel is not key-deduplicated (`sessionScanner` observes
    // the raw value before `processedMessageKeys` is consulted) and every observation is stamped
    // with the wall clock, so one `Task` line can arrive here twice. A re-observed start is not new
    // evidence: overwriting would push the start time forward AND wipe a result recorded while the
    // agent waited, resurrecting a finished subagent as `active` — the very thing this buffer
    // exists to prevent. A duplicate does not grow the map, so it cannot promote on its own either.
    if (!pendingImplicitSubagents.has(fact.toolUseId)) {
      pendingImplicitSubagents.set(fact.toolUseId, { ...fact, updatedAt, startedAt: updatedAt, status: 'active' });
    }
    if (pendingImplicitSubagents.size < CLAUDE_IMPLICIT_WORKFLOW_AGENT_THRESHOLD) {
      return null;
    }
    // Threshold reached: synthesize the implicit run from all buffered subagents.
    implicitRunId = CLAUDE_IMPLICIT_WORKFLOW_RUN_ID;
    const run = ensureRun(implicitRunId, {
      title: CLAUDE_IMPLICIT_WORKFLOW_RUN_TITLE,
      explicit: false,
      status: 'active',
      updatedAt,
      startedAt: updatedAt,
    });
    for (const pending of pendingImplicitSubagents.values()) {
      upsertAgent(run, {
        id: pending.toolUseId,
        title: pending.title,
        status: pending.status,
        updatedAt: pending.updatedAt,
        startedAt: pending.startedAt,
        ...(pending.resultPreview ? { resultPreview: pending.resultPreview } : {}),
        ...(pending.timeUsedSeconds !== undefined ? { timeUsedSeconds: pending.timeUsedSeconds } : {}),
      });
      run.childToolUseIds.add(pending.toolUseId);
      runIdByChildToolUseId.set(pending.toolUseId, run.runId);
    }
    pendingImplicitSubagents.clear();
    run.updatedAt = updatedAt;
    rollUpImplicitRunStatus(run);
    return run.runId;
  }

  /**
   * A plain subagent's `Task` tool_result — the only terminal evidence a SYNCHRONOUS subagent emits.
   *
   * Applied strictly to tool-use ids already observed as `subagent-start`, so a `Read`/`Bash` result
   * (which parses identically) can never close an agent. The error case arrives upstream as a
   * `task-lifecycle` fact and is handled in `applyTaskLifecycle`'s child branch.
   */
  function applySubagentResult(fact: SubagentResultFact, updatedAt: number): string | null {
    if (isForeignSource(fact.sourceSessionId)) return null;

    const pending = pendingImplicitSubagents.get(fact.toolUseId);
    if (pending) {
      // Not promoted yet: remember the outcome so a later promotion publishes the truth, but do not
      // synthesize a run for it (CWF4 — a single plain subagent is a task, not a run).
      pendingImplicitSubagents.set(fact.toolUseId, {
        ...pending,
        status: fact.status,
        updatedAt,
        ...(fact.resultPreview ? { resultPreview: fact.resultPreview } : {}),
        ...(fact.timeUsedSeconds !== undefined ? { timeUsedSeconds: fact.timeUsedSeconds } : {}),
      });
      return null;
    }

    const runId = runIdByChildToolUseId.get(fact.toolUseId);
    if (!runId) return null;
    const run = runs.get(runId);
    if (!run?.agentsById.has(fact.toolUseId)) return null;

    applyChildAgentTerminal(run, {
      agentId: fact.toolUseId,
      status: fact.status,
      updatedAt,
      ...(fact.resultPreview ? { resultPreview: fact.resultPreview } : {}),
      ...(fact.timeUsedSeconds !== undefined ? { timeUsedSeconds: fact.timeUsedSeconds } : {}),
    });
    return run.runId;
  }

  /**
   * Close ONE agent inside a run. A child's outcome never decides its parent run's status: an
   * explicit run's status is owned by its own workflow lifecycle events, and the synthesized
   * implicit run is closed only by the all-children-terminal roll-up below.
   */
  function applyChildAgentTerminal(run: MutableRun, params: Readonly<{
    agentId: string;
    status: SessionWorkflowAgentStatusV1;
    updatedAt: number;
    summary?: string;
    resultPreview?: string;
    completedAt?: number;
    timeUsedSeconds?: number;
  }>): void {
    const existing = run.agentsById.get(params.agentId);
    upsertAgent(run, {
      id: params.agentId,
      title: existing?.title ?? params.agentId,
      // Re-asserting an existing title must not promote its authority, or a late sidecar read could
      // no longer replace an ordinal.
      ...(existing ? { titleSource: existing.titleSource } : {}),
      status: params.status,
      updatedAt: params.updatedAt,
      ...(params.summary ? { summary: params.summary } : {}),
      ...(params.resultPreview ? { resultPreview: params.resultPreview } : {}),
      ...(params.completedAt !== undefined ? { completedAt: params.completedAt } : {}),
      ...(params.timeUsedSeconds !== undefined ? { timeUsedSeconds: params.timeUsedSeconds } : {}),
    });
    run.updatedAt = params.updatedAt;
    rollUpImplicitRunStatus(run);
  }

  /**
   * The implicit "Agent activity" run is a synthesized grouping of plain subagents, so it has no
   * lifecycle events of its own. Without this it would claim liveness forever once created. Explicit
   * runs are untouched — their status comes from real Workflow lifecycle evidence.
   */
  function rollUpImplicitRunStatus(run: MutableRun): void {
    if (run.explicit || run.runId !== implicitRunId) return;
    const agents = [...run.agentsById.values()];
    if (agents.length === 0) return;
    if (!agents.every((agent) => isTerminalAgentStatus(agent.status))) {
      if (!isTerminalRunStatus(run.status)) return;
      // A previously-closed run gained live work again (a resumed/new subagent).
      run.status = 'active';
      delete run.completedAt;
      return;
    }
    run.status = agents.some((agent) => agent.status === 'failed')
      ? 'failed'
      : agents.every((agent) => agent.status === 'cancelled')
        ? 'cancelled'
        : 'complete';
    run.completedAt = run.updatedAt;
  }

  function projectPhases(run: MutableRun): SessionWorkflowPhaseSnapshotV1[] {
    return [...run.phasesByIndex.values()]
      .sort((a, b) => a.index - b.index)
      .map((phase) => ({
        id: phase.id,
        order: phase.index,
        agentIds: [...phase.agentIds],
        ...(phase.title ? { title: phase.title } : {}),
      }));
  }

  function projectAgents(run: MutableRun): SessionWorkflowAgentSnapshotV1[] {
    return run.agentOrder
      .map((id) => run.agentsById.get(id))
      .filter((agent): agent is MutableAgent => agent !== undefined)
      .map((agent) => ({
        id: agent.id,
        title: agent.title,
        status: agent.status,
        updatedAt: agent.updatedAt,
        ...(agent.vendorRef ? { vendorRef: agent.vendorRef } : {}),
        ...(agent.sidechainId ? { sidechainId: agent.sidechainId } : {}),
        ...(agent.parentId ? { parentId: agent.parentId } : {}),
        ...(agent.phaseIndex !== undefined ? { phaseIndex: agent.phaseIndex } : {}),
        ...(agent.phaseTitle ? { phaseTitle: agent.phaseTitle } : {}),
        ...(agent.model ? { model: agent.model } : {}),
        ...(agent.summary ? { summary: agent.summary } : {}),
        ...(agent.resultPreview ? { resultPreview: agent.resultPreview } : {}),
        ...(agent.tokensUsed !== undefined ? { tokensUsed: agent.tokensUsed } : {}),
        ...(agent.toolCalls !== undefined ? { toolCalls: agent.toolCalls } : {}),
        ...(agent.timeUsedSeconds !== undefined ? { timeUsedSeconds: agent.timeUsedSeconds } : {}),
        ...(agent.startedAt !== undefined ? { startedAt: agent.startedAt } : {}),
        ...(agent.completedAt !== undefined ? { completedAt: agent.completedAt } : {}),
      }));
  }

  function countAgents(agents: readonly SessionWorkflowAgentSnapshotV1[], status: SessionWorkflowAgentStatusV1): number {
    return agents.reduce((acc, agent) => (agent.status === status ? acc + 1 : acc), 0);
  }

  /**
   * Project the mutable run into a publication candidate and report whether it changed materially
   * from the last projection. The durable publisher replaces the placeholder revision.
   */
  function projectRun(run: MutableRun): { snapshot: SessionWorkflowRunSnapshotV1; material: boolean } {
    const phases = projectPhases(run);
    const agents = projectAgents(run);
    const previous = lastSnapshotByRun.get(run.runId);

    const reconciled = agents.length === 0 ? run.reconciledCounts : undefined;
    const totalAgents = reconciled?.totalAgents ?? agents.length;
    const completedAgents = reconciled?.completedAgents ?? countAgents(agents, 'complete');
    const failedAgents = reconciled?.failedAgents ?? countAgents(agents, 'failed');
    const blockedAgents = reconciled?.blockedAgents ?? countAgents(agents, 'blocked');
    const cancelledAgents = countAgents(agents, 'cancelled');

    const base: SessionWorkflowRunSnapshotV1 = {
      v: 1,
      projectionVersion: SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
      runId: run.runId,
      backendId: params.backendId,
      title: run.title,
      status: run.status,
      recordRevision: '0',
      updatedAt: run.updatedAt,
      totalAgents,
      completedAgents,
      phases,
      agents,
      ...(run.statusReason ? { statusReason: run.statusReason } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(run.workflowToolUseId ? { workflowToolUseId: run.workflowToolUseId } : {}),
      ...(run.sourceSessionId ? { sourceSessionId: run.sourceSessionId } : {}),
      ...(run.startedAt !== undefined ? { startedAt: run.startedAt } : {}),
      ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
      ...(failedAgents > 0 ? { failedAgents } : {}),
      ...(blockedAgents > 0 ? { blockedAgents } : {}),
      ...(cancelledAgents > 0 ? { cancelledAgents } : {}),
      ...(run.tokensUsed !== undefined ? { tokensUsed: run.tokensUsed } : {}),
      ...(run.toolCalls !== undefined ? { toolCalls: run.toolCalls } : {}),
      ...(run.timeUsedSeconds !== undefined ? { timeUsedSeconds: run.timeUsedSeconds } : {}),
    };

    const material = isWorkflowRunSnapshotMaterialChange(previous, base);
    if (material) {
      lastSnapshotByRun.set(run.runId, base);
    }
    return { snapshot: base, material };
  }

  function observe(
    value: unknown,
    observeParams: Readonly<{ updatedAt: number; live?: boolean }>,
  ): WorkflowActivityObservation {
    const fact = parseClaudeWorkflowFact(value, {
      isKnownSubagentToolUseId: (toolUseId) => subagentToolUseIds.has(toolUseId),
    });
    if (!fact) {
      return { changedRunIds: [], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] };
    }

    const priorRunIds = new Set(runs.keys());
    const priorStatusByRun = new Map<string, SessionWorkflowRunStatusV1>();
    for (const [runId, run] of runs) priorStatusByRun.set(runId, run.status);

    let touchedRunId: string | null = null;
    const providerTaskActivities: ClaudeProviderTaskActivity[] = [];
    if (fact.kind === 'workflow-start') {
      touchedRunId = applyWorkflowStart(fact, observeParams.updatedAt);
    } else if (fact.kind === 'workflow-launch') {
      touchedRunId = applyWorkflowLaunch(fact, observeParams.updatedAt, providerTaskActivities);
    } else if (fact.kind === 'task-lifecycle') {
      touchedRunId = applyTaskLifecycle(fact, observeParams.updatedAt, providerTaskActivities);
    } else if (fact.kind === 'workflow-journal') {
      touchedRunId = applyWorkflowJournal(fact, observeParams.updatedAt);
    } else if (fact.kind === 'workflow-agent-profile') {
      touchedRunId = applyWorkflowAgentProfile(fact, observeParams.updatedAt);
    } else if (fact.kind === 'subagent-result') {
      touchedRunId = applySubagentResult(fact, observeParams.updatedAt);
    } else {
      touchedRunId = applySubagentStart(fact, observeParams.updatedAt);
    }

    if (!touchedRunId) {
      return { changedRunIds: [], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] };
    }
    if (observeParams.live !== false) {
      liveObservedRunIds.add(touchedRunId);
    }

    // Migration may have dropped the implicit run; recompute change set across all current runs that
    // were touched this event (the touched run plus a possibly-pruned implicit run).
    const changedRunIds: string[] = [];
    const startedRunIds: string[] = [];
    const terminalRunIds: string[] = [];
    const statusChangedRunIds: string[] = [];

    const candidateRunIds = new Set<string>([touchedRunId]);
    // The implicit run may have lost an agent this event; re-project it too so counts stay correct.
    if (implicitRunId && runs.has(implicitRunId)) candidateRunIds.add(implicitRunId);

    for (const runId of candidateRunIds) {
      const run = runs.get(runId);
      if (!run) continue;
      const { material } = projectRun(run);
      const isNewRun = !priorRunIds.has(runId);
      if (material || isNewRun) changedRunIds.push(runId);
      if (isNewRun) startedRunIds.push(runId);
      const priorStatus = priorStatusByRun.get(runId);
      if (priorStatus !== undefined && priorStatus !== run.status) statusChangedRunIds.push(runId);
      if (isTerminalRunStatus(run.status) && (isNewRun || priorStatus !== run.status)) {
        terminalRunIds.push(runId);
      }
    }

    for (const priorRunId of priorRunIds) {
      if (!runs.has(priorRunId) && !changedRunIds.includes(priorRunId)) {
        changedRunIds.push(priorRunId);
      }
    }

    return {
      changedRunIds,
      startedRunIds,
      terminalRunIds,
      statusChangedRunIds,
      ...(providerTaskActivities.length > 0 ? { providerTaskActivities } : {}),
    };
  }

  function getRunSnapshot(runId: string): SessionWorkflowRunSnapshotV1 | null {
    const run = runs.get(runId);
    if (!run) return null;
    return lastSnapshotByRun.get(runId) ?? projectRun(run).snapshot;
  }

  function getRunSnapshotMap(): ReadonlyMap<string, SessionWorkflowRunSnapshotV1> {
    const map = new Map<string, SessionWorkflowRunSnapshotV1>();
    for (const runId of runs.keys()) {
      const snapshot = getRunSnapshot(runId);
      if (snapshot) map.set(runId, snapshot);
    }
    return map;
  }

  function reconcileInterruptedRunFromHeadline(
    seed: WorkflowInterruptedRunSeed,
    reconcileParams: Readonly<{ updatedAt: number }>,
  ): WorkflowActivityObservation {
    const aliasedRunId = runIdByWorkflowToolUseId.get(seed.workflowToolUseId ?? seed.runId);
    if (aliasedRunId && aliasedRunId !== seed.runId) {
      return {
        changedRunIds: [seed.runId],
        startedRunIds: [],
        terminalRunIds: [],
        statusChangedRunIds: [],
      };
    }
    const existing = runs.get(seed.runId);
    if (existing && liveObservedRunIds.has(seed.runId)) {
      return { changedRunIds: [], startedRunIds: [], terminalRunIds: [], statusChangedRunIds: [] };
    }
    if (existing && isTerminalRunStatus(existing.status)) {
      projectRun(existing);
      return {
        changedRunIds: [existing.runId],
        startedRunIds: [],
        terminalRunIds: [existing.runId],
        statusChangedRunIds: [existing.runId],
      };
    }
    const run = existing ?? ensureRun(seed.runId, {
      title: seed.title,
      explicit: true,
      status: 'stopped',
      updatedAt: reconcileParams.updatedAt,
      startedAt: reconcileParams.updatedAt,
      ...(seed.workflowToolUseId ? { workflowToolUseId: seed.workflowToolUseId } : {}),
    });
    run.status = 'stopped';
    run.statusReason = 'interrupted';
    run.completedAt = reconcileParams.updatedAt;
    run.updatedAt = reconcileParams.updatedAt;
    // The run is resolved, so its agents are too. Without this an implicit run rebuilt by transcript
    // replay publishes `active` agents underneath a `stopped` run — one card contradicting itself.
    terminalizeRunAgents(run, reconcileParams.updatedAt);
    if (run.agentsById.size === 0) {
      run.reconciledCounts = {
        totalAgents: seed.totalAgents,
        completedAgents: seed.completedAgents,
        ...(seed.failedAgents !== undefined ? { failedAgents: seed.failedAgents } : {}),
        ...(seed.blockedAgents !== undefined ? { blockedAgents: seed.blockedAgents } : {}),
      };
    }
    projectRun(run);
    return {
      changedRunIds: [run.runId],
      startedRunIds: [],
      terminalRunIds: [run.runId],
      statusChangedRunIds: [run.runId],
    };
  }

  /**
   * RULING-14 — terminal state on PROCESS DEATH, not on turn failure and never on inactivity.
   *
   * Every kind this tracker holds — workflow runs, workflow agents, `Task` sidechains — runs INSIDE
   * the Claude query. When that query is gone the work is over: that is a recorded observation, not
   * an inference, so no timer and no turn outcome is consulted. A turn can
   * fail with the process alive and its children still working (an auth failure scoped to a subagent
   * is deliberately not surfaced as a primary-session failure), which is exactly why turn failure is
   * the wrong trigger.
   *
   * Background shells are NOT held here (this file has zero `backgroundTask` references). They are a
   * genuinely different lifecycle — a detached OS process can outlive the query — and they resolve
   * at `backgroundTaskRecordPublisher.finalizeOutstandingOnOrderlyStop`, on an orderly stop only.
   *
   * Never `failed`: the adapter contract already ruled that a run reconciled after a CLI crash lands
   * as a stop, never a failure. Agents inherit that ruling as `cancelled`, and each agent's
   * `completedAt` is the last instant we actually have evidence for — never a fabricated end.
   *
   * Happier execution runs are structurally exempt: they create their own backend and query owned by
   * the CLI session process, so they genuinely outlive a provider death — and they are not in this
   * tracker at all. Their liveness is answered by their own pid-backed marker registry.
   */
  function finalizeInterruptedActivityOnShutdown(
    finalizeParams: Readonly<{ updatedAt: number }>,
  ): WorkflowActivityObservation {
    const changedRunIds: string[] = [];
    const terminalRunIds: string[] = [];
    const statusChangedRunIds: string[] = [];

    for (const run of runs.values()) {
      const priorStatus = run.status;
      // Same resolution the run's own completion applies — one helper, so a crash and a clean finish
      // cannot disagree about what happened to an agent. A run that already terminalized normally
      // has nothing left here; what this still catches is an agent whose journal `started` landed
      // during the follower's post-completion grace drain.
      let touched = terminalizeRunAgents(run, finalizeParams.updatedAt);

      if (!isTerminalRunStatus(run.status)) {
        run.status = 'stopped';
        run.statusReason = 'interrupted';
        run.completedAt = finalizeParams.updatedAt;
        touched = true;
      }

      if (!touched) continue;
      run.updatedAt = finalizeParams.updatedAt;
      const { material } = projectRun(run);
      if (material) changedRunIds.push(run.runId);
      if (run.status !== priorStatus) {
        statusChangedRunIds.push(run.runId);
        if (isTerminalRunStatus(run.status)) terminalRunIds.push(run.runId);
      }
    }

    return { changedRunIds, startedRunIds: [], terminalRunIds, statusChangedRunIds };
  }

  function getWorkflowOwnedAgentToolUseIds(): ReadonlySet<string> {
    const owned = new Set<string>();
    for (const run of runs.values()) {
      for (const childId of run.childToolUseIds) owned.add(childId);
    }
    return owned;
  }

  function isWorkflowOwnedProviderTaskId(taskId: string): boolean {
    for (const run of runs.values()) {
      if (run.providerTaskId === taskId) return true;
    }
    return false;
  }

  function isWorkflowOwnedTaskReference(reference: ClaudeWorkflowTaskReference): boolean {
    if (reference.taskId && isWorkflowOwnedProviderTaskId(reference.taskId)) return true;
    if (!reference.toolUseId) return false;
    return runIdByWorkflowToolUseId.has(reference.toolUseId)
      || runs.has(reference.toolUseId)
      || runIdByChildToolUseId.has(reference.toolUseId);
  }

  return {
    observe,
    getLiveObservedRunIds() {
      return new Set(liveObservedRunIds);
    },
    getRunSnapshot,
    getRunSnapshotMap,
    reconcileInterruptedRunFromHeadline,
    finalizeInterruptedActivityOnShutdown,
    getWorkflowOwnedAgentToolUseIds,
    isWorkflowOwnedProviderTaskId,
    isWorkflowOwnedTaskReference,
  };
}
