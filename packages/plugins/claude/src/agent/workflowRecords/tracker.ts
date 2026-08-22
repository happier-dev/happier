import {
  isWorkflowRunSnapshotMaterialChange,
  SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
  type SessionWorkflowAgentSnapshotV1,
  type SessionWorkflowAgentStatusV1,
  type SessionWorkflowPhaseSnapshotV1,
  type SessionWorkflowRunSnapshotV1,
  type SessionWorkflowRunStatusReasonV1,
  type SessionWorkflowRunStatusV1,
} from '@happier-dev/plugin-sdk/sessions/work-state';

import type { ClaudeProviderTaskActivity } from '../runtime/remote/sdk/providerActivity.js';
import {
  parseClaudeWorkflowFact,
  type ClaudeWorkflowShapeDriftReporter,
  type SubagentStartFact,
  type TaskLifecycleFact,
  type WorkflowJournalFact,
  type WorkflowJournalAgentSpecFact,
  type WorkflowLaunchFact,
  type WorkflowProgressAgentFact,
  type WorkflowRunRecordFact,
  type WorkflowStartFact,
} from './correlation.js';
import {
  CLAUDE_IMPLICIT_WORKFLOW_AGENT_THRESHOLD,
  CLAUDE_IMPLICIT_WORKFLOW_RUN_ID,
  CLAUDE_IMPLICIT_WORKFLOW_RUN_TITLE,
  type WorkflowActivityObservation,
} from './types.js';

/**
 * CWF2 in-memory workflow activity tracker.
 *
 * Folds raw Claude transcript values into a PER-RUN `Map<runId>` and projects each changed run into
 * a provider-agnostic `SessionWorkflowRunSnapshotV1`. This is the single owner of run/phase/agent
 * correlation, status mapping (delegated to the protocol Claude status mapper via the fact parser),
 * and per-run material-change detection. It uses mutable maps internally for O(new events) updates
 * but exposes only immutable unpublished per-run snapshots and a per-run change observation. The
 * publisher is the only owner of committed `recordRevision` values.
 *
 * Invariants enforced here (never in UI):
 * - Two concurrent `Workflow` runs never merge phases/agents — agent rows are namespaced by run.
 * - Explicit `Workflow` runs win over the implicit "Agent activity" run: a child proven to belong to
 *   an explicit run is migrated off the implicit run.
 * - `phases[]` are authoritative for phase title/order; an agent's `phaseTitle` is supplementary.
 * - A single plain subagent stays a task (no implicit promotion); >=2 correlated subagents promote.
 * - `changedRunIds` advances only on a material normalized-snapshot change.
 */

type MutablePhase = {
  id: string;
  index: number;
  title?: string;
  agentIds: string[];
};

type MutableAgent = {
  id: string;
  vendorRef?: string;
  title: string;
  status: SessionWorkflowAgentStatusV1;
  attempt?: number;
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
  startedAt?: number;
  completedAt?: number;
  tokensUsed?: number;
  toolCalls?: number;
  timeUsedSeconds?: number;
  phasesByIndex: Map<number, MutablePhase>;
  agentsById: Map<string, MutableAgent>;
  /**
   * The other name each agent row answers to.
   *
   * The live `task_progress` stream keys an agent by position while the sidecar journal keys the
   * same agent by its concrete hex id, and both feed this one tracker. This map is what lets the
   * second source find the row the first source already filed instead of opening a second one.
   */
  agentIdByVendorRef: Map<string, string>;
  /** Arrival order of agent ids, so snapshot agent order is stable/deterministic. */
  agentOrder: string[];
  journalAgentSpecs: WorkflowJournalAgentSpecFact[];
  journalSpecIndexByKey: Map<string, number>;
  journalSpecIndexByAgentId: Map<string, number>;
  nextJournalSpecIndex: number;
  childToolUseIds: Set<string>;
  reconciledCounts?: Readonly<{
    totalAgents: number;
    completedAgents: number;
    failedAgents?: number;
    blockedAgents?: number;
  }>;
  updatedAt: number;
};

/** One agent a dead process published as running, named by the roster it left behind. */
export type WorkflowInterruptedAgentSeed = Readonly<{
  agentId: string;
  title: string;
  /** The agent's own last observed instant — never the moment recovery ran. */
  updatedAt: number;
  startedAt?: number;
}>;

export type WorkflowInterruptedRunSeed = Readonly<{
  runId: string;
  title: string;
  workflowToolUseId?: string;
  totalAgents: number;
  completedAgents: number;
  failedAgents?: number;
  blockedAgents?: number;
  /**
   * The agents that run left behind, when the evidence names them.
   *
   * The workflow headline is count-only, so a run rebuilt from it alone can name no agent at all.
   * The agent-activity headline published beside it DOES carry identities, and carrying them here is
   * the whole reason crash recovery can reach an agent-scoped surface.
   */
  orphanAgents?: readonly WorkflowInterruptedAgentSeed[];
}>;

export type ClaudeWorkflowActivityTracker = Readonly<{
  /** Fold one raw transcript value; returns the per-run change observation for the publisher. */
  observe(value: unknown, params: Readonly<{ updatedAt: number; live?: boolean }>): WorkflowActivityObservation;
  /** Materialize one stale persisted headline as a terminal run after startup replay missed it. */
  reconcileInterruptedRunFromHeadline(
    run: WorkflowInterruptedRunSeed,
    params: Readonly<{ updatedAt: number }>,
  ): WorkflowActivityObservation;
  /**
   * Resolve every non-terminal run and agent because the process that owned them is going away.
   *
   * Called from an OBSERVED death — a graceful query teardown — never from a timer or a silence
   * threshold. Runs, their agents and their `Task` children all live INSIDE the Claude query, so its
   * teardown IS the evidence that they are over. A run that already terminalized keeps its outcome.
   */
  finalizeInterruptedActivityOnShutdown(
    params: Readonly<{ updatedAt: number }>,
  ): WorkflowActivityObservation;
  /** Current projected snapshot for one run, or null if unknown. */
  getRunSnapshot(runId: string): SessionWorkflowRunSnapshotV1 | null;
  /** All current run snapshots keyed by runId. */
  getRunSnapshotMap(): ReadonlyMap<string, SessionWorkflowRunSnapshotV1>;
  /** Run ids whose latest published agents are workflow-owned (CWF4 suppression hook). */
  getWorkflowOwnedAgentToolUseIds(): ReadonlySet<string>;
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
  /**
   * Report that a Claude-native shape this tracker folds is no longer readable.
   *
   * This tracker is the only reader that folds the WHOLE live stream, so it is where an undeclared
   * provider field going away becomes visible at all. Absent, the drift is simply not reported —
   * parsing is unchanged either way.
   */
  reportShapeDrift?: ClaudeWorkflowShapeDriftReporter;
}>): ClaudeWorkflowActivityTracker {
  const runs = new Map<string, MutableRun>();
  const runIdByWorkflowToolUseId = new Map<string, string>();
  const runIdByProviderRunId = new Map<string, string>();
  const runIdByChildToolUseId = new Map<string, string>();
  // Claude `task_updated` terminal events carry only `task_id` (no `tool_use_id`), so the run's
  // provider task id is learned from earlier lifecycle events that carry both and used to route.
  const runIdByTaskId = new Map<string, string>();
  const liveObservedRunIds = new Set<string>();
  let implicitRunId: string | undefined;

  // Cache the last projected snapshot per run so revision bumps + change detection are stable.
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
      agentIdByVendorRef: new Map(),
      agentOrder: [],
      journalAgentSpecs: [],
      journalSpecIndexByKey: new Map(),
      journalSpecIndexByAgentId: new Map(),
      nextJournalSpecIndex: 0,
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

  /**
   * Resolve the ONE roster row an incoming agent fact belongs to.
   *
   * Two sources are active at once on the journal-backed path and they name the same agent
   * differently: the live `task_progress` stream keys by POSITION (it can emit an agent before that
   * agent has a concrete id at all), while the sidecar journal keys by the concrete hex id. Left
   * alone that files `workflow-agent:1` BESIDE `ada15d97cdea9c7fd` — two rows, one agent, on every
   * agent of every journal-backed run.
   *
   * Whichever source named the agent FIRST owns the row identity, and the other name joins it as
   * `vendorRef`. The id is not rewritten, because this id is what `buildAgentActivityEntryId`
   * publishes into the agent-activity headline and what the client merges its local entries onto —
   * renaming a row that is already on screen would remount it and split its handle. Addressability
   * by either name is preserved separately, through `childToolUseIds` / `runIdByChildToolUseId`,
   * which already register both.
   */
  function resolveAgentRowId(run: MutableRun, id: string, vendorRef: string | undefined): string {
    if (run.agentsById.has(id)) return id;
    if (vendorRef) {
      const joined = run.agentIdByVendorRef.get(vendorRef);
      if (joined !== undefined && run.agentsById.has(joined)) return joined;
      if (run.agentsById.has(vendorRef)) return vendorRef;
    }
    return id;
  }

  function upsertAgent(run: MutableRun, agent: Readonly<{
    id: string;
    vendorRef?: string;
    title: string;
    status: SessionWorkflowAgentStatusV1;
    attempt?: number;
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
    updatedAt: number;
  }>): void {
    const rowId = resolveAgentRowId(run, agent.id, agent.vendorRef);
    if (agent.vendorRef) run.agentIdByVendorRef.set(agent.vendorRef, rowId);
    const vendorRef = agent.vendorRef && agent.vendorRef !== rowId ? agent.vendorRef : undefined;
    const existing = run.agentsById.get(rowId);
    if (!existing) {
      const created: MutableAgent = {
        id: rowId,
        ...(vendorRef ? { vendorRef } : {}),
        title: agent.title,
        status: agent.status,
        ...(agent.attempt !== undefined ? { attempt: agent.attempt } : {}),
        updatedAt: agent.updatedAt,
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
      };
      run.agentsById.set(rowId, created);
      run.agentOrder.push(rowId);
      assignAgentToPhase(run, rowId, agent.phaseIndex);
      return;
    }
    const existingAttempt = existing.attempt;
    const incomingAttempt = agent.attempt;
    const isNewAttempt = incomingAttempt !== undefined
      && (existingAttempt === undefined || incomingAttempt > existingAttempt);
    const shouldPreserveTerminalStatus = isTerminalAgentStatus(existing.status)
      && !isTerminalAgentStatus(agent.status)
      && !isNewAttempt;

    // Latest-wins merge for identity/detail fields; terminal status is sticky unless Claude reports
    // a strictly newer retry attempt. This suppresses stale progress replay after a done/failed row.
    existing.title = agent.title || existing.title;
    if (vendorRef) existing.vendorRef = vendorRef;
    if (incomingAttempt !== undefined && (existingAttempt === undefined || incomingAttempt >= existingAttempt)) {
      existing.attempt = incomingAttempt;
    }
    if (!shouldPreserveTerminalStatus) {
      existing.status = agent.status;
      if (isNewAttempt && !isTerminalAgentStatus(agent.status)) {
        delete existing.resultPreview;
        delete existing.summary;
        delete existing.completedAt;
      }
    }
    existing.updatedAt = agent.updatedAt;
    if (agent.parentId) existing.parentId = agent.parentId;
    if (agent.phaseIndex !== undefined) existing.phaseIndex = agent.phaseIndex;
    if (agent.phaseTitle) existing.phaseTitle = agent.phaseTitle;
    if (agent.model) existing.model = agent.model;
    if (agent.summary) existing.summary = agent.summary;
    if (agent.resultPreview) existing.resultPreview = agent.resultPreview;
    if (agent.tokensUsed !== undefined) existing.tokensUsed = agent.tokensUsed;
    if (agent.toolCalls !== undefined) existing.toolCalls = agent.toolCalls;
    if (agent.timeUsedSeconds !== undefined) existing.timeUsedSeconds = agent.timeUsedSeconds;
    if (agent.startedAt !== undefined) existing.startedAt = agent.startedAt;
    if (agent.completedAt !== undefined) existing.completedAt = agent.completedAt;
    assignAgentToPhase(run, rowId, agent.phaseIndex);
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
      run.nextJournalSpecIndex = 0;
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
    const existingRunId = runIdByWorkflowToolUseId.get(fact.workflowToolUseId)
      ?? fact.workflowToolUseId;
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
      delete run.statusReason;
      delete run.reconciledCounts;
    } else if (!isTerminalRunStatus(run.status)) {
      run.status = runSignal === 'unknown' ? run.status : runSignal;
    }
    if (
      !isTerminalRunStatus(priorStatus)
      && isTerminalRunStatus(run.status)
      && run.sourceSessionId
      && run.providerTaskId
    ) {
      providerTaskActivities.push({
        type: 'terminal',
        terminalStatus: run.status === 'complete'
          ? 'completed'
          : run.status === 'failed'
            ? 'failed'
            : 'stopped',
        sessionId: run.sourceSessionId,
        taskId: run.providerTaskId,
      });
    }
    return run.runId;
  }

  function applyWorkflowProgressAgent(run: MutableRun, entry: WorkflowProgressAgentFact, updatedAt: number): void {
    // Explicit-wins: if this agent currently lives on the implicit run, migrate it here.
    migrateImplicitAgentToExplicit(entry.id, run);
    upsertAgent(run, {
      id: entry.id,
      ...(entry.vendorRef ? { vendorRef: entry.vendorRef } : {}),
      title: entry.title,
      status: entry.status,
      ...(entry.attempt !== undefined ? { attempt: entry.attempt } : {}),
      updatedAt,
      ...(entry.phaseIndex !== undefined ? { phaseIndex: entry.phaseIndex } : {}),
      ...(entry.phaseTitle ? { phaseTitle: entry.phaseTitle } : {}),
      ...(entry.model ? { model: entry.model } : {}),
      ...(entry.resultPreview ? { resultPreview: entry.resultPreview } : {}),
      ...(entry.tokensUsed !== undefined ? { tokensUsed: entry.tokensUsed } : {}),
      ...(entry.toolCalls !== undefined ? { toolCalls: entry.toolCalls } : {}),
      ...(entry.timeUsedSeconds !== undefined ? { timeUsedSeconds: entry.timeUsedSeconds } : {}),
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
    const index = matchingIndex >= 0 ? matchingIndex : run.nextJournalSpecIndex;
    const spec = run.journalAgentSpecs[index];
    if (!spec) return undefined;
    if (matchingIndex < 0) run.nextJournalSpecIndex = index + 1;
    if (fact.journalKey) run.journalSpecIndexByKey.set(fact.journalKey, index);
    run.journalSpecIndexByAgentId.set(fact.agentId, index);
    return spec;
  }

  /**
   * Apply the run's durable record: the same structure the live stream reports, from the artifact
   * that outlived the process.
   *
   * Never synthesizes a run — the record is discovered from a run we already observed launching —
   * and never restates the run's ending: the record is written at terminal state, so a run whose
   * outcome the transcript already decided keeps it. Only phases and agents are filled in.
   *
   * The record's agents reach the SAME rows the journal filed: it carries both `index` and
   * `agentId`, and `resolveAgentRowId` joins on the second whichever name the row already answers
   * to.
   */
  function applyWorkflowRunRecord(fact: WorkflowRunRecordFact, updatedAt: number): string | null {
    if (isForeignSource(fact.sourceSessionId)) return null;
    const workflowRunId = runIdByWorkflowToolUseId.get(fact.workflowToolUseId) ?? fact.workflowToolUseId;
    const run = runs.get(workflowRunId);
    if (!run) return null;
    if (fact.sourceSessionId && !run.sourceSessionId) run.sourceSessionId = fact.sourceSessionId;
    for (const entry of fact.workflowProgress) {
      if (entry.kind === 'phase') {
        upsertPhase(run, entry.index, entry.title);
        continue;
      }
      applyWorkflowProgressAgent(run, entry, updatedAt);
    }
    run.updatedAt = updatedAt;
    return run.runId;
  }

  function applyWorkflowJournal(fact: WorkflowJournalFact, updatedAt: number): string | null {
    if (isForeignSource(fact.sourceSessionId)) return null;
    const workflowRunId = runIdByWorkflowToolUseId.get(fact.workflowToolUseId)
      ?? fact.workflowToolUseId;
    const run = runs.get(workflowRunId);
    if (!run) return null;
    if (fact.sourceSessionId && !run.sourceSessionId) run.sourceSessionId = fact.sourceSessionId;
    const journalSpec = resolveJournalSpec(run, fact);
    const effectiveFact = journalSpec
      ? {
        ...fact,
        title: fact.title === fact.agentId ? journalSpec.label : fact.title,
        phaseTitle: fact.phaseTitle ?? journalSpec.phaseTitle,
      }
      : fact;
    const phaseIndex = resolveJournalPhaseIndex(run, effectiveFact);
    upsertAgent(run, {
      id: effectiveFact.agentId,
      // The journal's own key IS the concrete id, so it is also the join key: if the live stream
      // already filed this agent by position, the row is found rather than duplicated.
      vendorRef: effectiveFact.agentId,
      title: effectiveFact.title,
      status: effectiveFact.status,
      updatedAt,
      parentId: effectiveFact.workflowToolUseId,
      ...(phaseIndex !== undefined ? { phaseIndex } : {}),
      ...(effectiveFact.phaseTitle ? { phaseTitle: effectiveFact.phaseTitle } : {}),
      ...(effectiveFact.summary ? { summary: effectiveFact.summary } : {}),
      ...(effectiveFact.resultPreview ? { resultPreview: effectiveFact.resultPreview } : {}),
    });
    run.childToolUseIds.add(effectiveFact.agentId);
    runIdByChildToolUseId.set(effectiveFact.agentId, run.runId);
    run.updatedAt = updatedAt;
    return run.runId;
  }

  function applySubagentStart(fact: SubagentStartFact, updatedAt: number): string | null {
    if (isForeignSource(fact.sourceSessionId)) return null;
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
  // once >= threshold are seen, so a single plain subagent stays a task (CWF4).
  const pendingImplicitSubagents = new Map<string, SubagentStartFact & { updatedAt: number }>();

  function promoteImplicitSubagent(fact: SubagentStartFact, updatedAt: number): string | null {
    if (implicitRunId) {
      const run = runs.get(implicitRunId);
      if (run) {
        upsertAgent(run, { id: fact.toolUseId, title: fact.title, status: 'active', updatedAt });
        run.childToolUseIds.add(fact.toolUseId);
        runIdByChildToolUseId.set(fact.toolUseId, run.runId);
        run.updatedAt = updatedAt;
        return run.runId;
      }
    }

    pendingImplicitSubagents.set(fact.toolUseId, { ...fact, updatedAt });
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
      upsertAgent(run, { id: pending.toolUseId, title: pending.title, status: 'active', updatedAt: pending.updatedAt });
      run.childToolUseIds.add(pending.toolUseId);
      runIdByChildToolUseId.set(pending.toolUseId, run.runId);
    }
    pendingImplicitSubagents.clear();
    run.updatedAt = updatedAt;
    return run.runId;
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
        ...(agent.vendorRef ? { vendorRef: agent.vendorRef } : {}),
        title: agent.title,
        status: agent.status,
        updatedAt: agent.updatedAt,
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
   * Project the mutable run into an unpublished snapshot and report material change vs the last
   * projection. The publisher overwrites the placeholder recordRevision with the committed value.
   */
  function projectRun(run: MutableRun): { snapshot: SessionWorkflowRunSnapshotV1; material: boolean } {
    const phases = projectPhases(run);
    const agents = projectAgents(run);
    const previous = lastSnapshotByRun.get(run.runId);

    const completedAgents = run.reconciledCounts?.completedAgents ?? countAgents(agents, 'complete');
    const failedAgents = run.reconciledCounts?.failedAgents ?? countAgents(agents, 'failed');
    const blockedAgents = run.reconciledCounts?.blockedAgents ?? countAgents(agents, 'blocked');
    const cancelledAgents = countAgents(agents, 'cancelled');

    const base: SessionWorkflowRunSnapshotV1 = {
      v: 1,
      projectionVersion: SESSION_WORKFLOW_RUN_SNAPSHOT_PROJECTION_VERSION,
      runId: run.runId,
      backendId: params.backendId,
      title: run.title,
      status: run.status,
      ...(run.statusReason ? { statusReason: run.statusReason } : {}),
      recordRevision: '0',
      updatedAt: run.updatedAt,
      totalAgents: run.reconciledCounts?.totalAgents ?? agents.length,
      completedAgents,
      phases,
      agents,
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
      // A finished run can still owe the roster rows: the previous process published agents that
      // never reported, and this process rebuilt the run from a transcript that closed it without
      // ever naming them. They are re-attached here so the republish REPLACES those rows rather
      // than leaving the metadata roster's copy of them spinning.
      materializeInterruptedAgents(existing, seed, reconcileParams.updatedAt);
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
      ...(seed.workflowToolUseId ? { workflowToolUseId: seed.workflowToolUseId } : {}),
      updatedAt: reconcileParams.updatedAt,
      startedAt: reconcileParams.updatedAt,
    });
    run.status = 'stopped';
    run.statusReason = 'interrupted';
    run.completedAt = reconcileParams.updatedAt;
    run.updatedAt = reconcileParams.updatedAt;
    // Attached BEFORE the sweep, so the agents the previous process left running are resolved by the
    // same rule as any other agent inside a finished run instead of quietly vanishing from the
    // roster.
    materializeInterruptedAgents(run, seed, reconcileParams.updatedAt);
    // The run is resolved, so its agents are too. Without this a run rebuilt by transcript replay
    // publishes `active` agents underneath a `stopped` run — one card contradicting itself.
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
   * Re-attach the agents a dead process published as running but this process never observed.
   *
   * The counterpart to `terminalizeRunAgents`, and the reason crash recovery can reach an
   * agent-scoped surface at all. A restarted process rebuilds a run from evidence that outlived it —
   * a transcript, or a headline seed — and that evidence names agents only when it happens to.
   * Everything else the previous process had already published about them lives in the roster it
   * left behind, and the seed carries it back so those rows are REPLACED with a truthful ending
   * instead of either spinning forever or disappearing from the session's history.
   *
   * Only agents this process has no record of are added: an agent already held here has been
   * observed by something with better evidence than a headline, and the sweep resolves it.
   */
  function materializeInterruptedAgents(
    run: MutableRun,
    seed: WorkflowInterruptedRunSeed,
    updatedAt: number,
  ): void {
    let touched = false;
    for (const orphan of seed.orphanAgents ?? []) {
      if (run.agentsById.has(orphan.agentId)) continue;
      upsertAgent(run, {
        id: orphan.agentId,
        title: orphan.title,
        status: 'cancelled',
        // The agent's own last evidence, not the moment recovery ran: stamping the sweep clock here
        // would inflate every rebuilt row's elapsed time by however long the session was down.
        updatedAt: orphan.updatedAt,
        completedAt: orphan.updatedAt,
        ...(run.workflowToolUseId ? { parentId: run.workflowToolUseId } : {}),
        ...(orphan.startedAt !== undefined ? { startedAt: orphan.startedAt } : {}),
      });
      run.childToolUseIds.add(orphan.agentId);
      runIdByChildToolUseId.set(orphan.agentId, run.runId);
      touched = true;
    }
    if (touched) run.updatedAt = updatedAt;
  }

  /**
   * Resolve one run's still-running agents because the process that owned them is going away.
   *
   * `cancelled`, never `failed`: the agents did not fail, their host went away. A completion instant
   * that was never observed is dated at the agent's last observed instant rather than at the sweep's
   * — the teardown proves the agent stopped, not when it stopped doing work.
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

  function finalizeInterruptedActivityOnShutdown(
    finalizeParams: Readonly<{ updatedAt: number }>,
  ): WorkflowActivityObservation {
    const changedRunIds: string[] = [];
    const terminalRunIds: string[] = [];
    const statusChangedRunIds: string[] = [];

    for (const run of runs.values()) {
      const priorStatus = run.status;
      // A run that already terminalized normally has nothing left here; what this still catches is
      // an agent whose journal `started` landed during the follower's post-completion grace drain.
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

  function observe(
    value: unknown,
    observeParams: Readonly<{ updatedAt: number; live?: boolean }>,
  ): WorkflowActivityObservation {
    const fact = parseClaudeWorkflowFact(value, params.reportShapeDrift);
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
    } else if (fact.kind === 'workflow-run-record') {
      touchedRunId = applyWorkflowRunRecord(fact, observeParams.updatedAt);
    } else if (fact.kind === 'workflow-journal') {
      touchedRunId = applyWorkflowJournal(fact, observeParams.updatedAt);
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

  function getWorkflowOwnedAgentToolUseIds(): ReadonlySet<string> {
    const owned = new Set<string>();
    for (const run of runs.values()) {
      for (const childId of run.childToolUseIds) owned.add(childId);
    }
    return owned;
  }

  return {
    observe,
    reconcileInterruptedRunFromHeadline,
    finalizeInterruptedActivityOnShutdown,
    getRunSnapshot,
    getRunSnapshotMap,
    getWorkflowOwnedAgentToolUseIds,
  };
}
