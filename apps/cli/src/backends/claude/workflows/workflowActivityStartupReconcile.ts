import {
  isTerminalWorkflowRunStatus,
  parseAgentActivityEntryId,
  type SessionAgentActivityEntryV1,
  type SessionAgentActivityHeadlineV1,
  type SessionWorkflowActivityHeadlineV1,
  type SessionWorkflowRunHeadlineV1,
  type SessionWorkflowRunStatusV1,
} from '@happier-dev/protocol';

export const WORKFLOW_ACTIVITY_STARTUP_RECONCILE_GRACE_MS = 30_000;

/**
 * One agent a dead process left non-terminal, as the published roster still describes it.
 *
 * Identities, not counts. The run-scoped seed below can rebuild a run's totals from
 * `totalAgents`/`completedAgents`, but the surface a person reads is the per-agent roster, and a
 * count cannot resolve a row. Title/`startedAt`/`sidechainId` come along so recovery replaces each
 * row in place instead of renaming it to a hex id or dropping it out of the session's history.
 */
export type WorkflowStartupReconcileAgent = Readonly<{
  agentId: string;
  title: string;
  /** The instant of the last evidence about this agent — the honest end for a row that never ended. */
  updatedAt: number;
  startedAt?: number;
  sidechainId?: string;
}>;

export type WorkflowStartupReconcileCandidate = Readonly<{
  runId: string;
  title: string;
  workflowToolUseId?: string;
  totalAgents: number;
  completedAgents: number;
  failedAgents?: number;
  blockedAgents?: number;
  /**
   * The status the run itself last published, when that status was already TERMINAL.
   *
   * Recovery must then resolve the agents WITHOUT restating the run: a workflow that genuinely
   * completed is not interrupted just because one of its agents never reported, and overwriting its
   * status with `stopped`/`interrupted` would replace one wrong row with a wrong card. Absent when
   * the run is non-terminal or is no longer named by the headline at all — the run's own end is then
   * genuinely unknown, and an interrupted stop is the honest reconstruction.
   */
  runTerminalStatus?: SessionWorkflowRunStatusV1;
  /** Present only when the previous process left agents non-terminal. */
  orphanAgents?: readonly WorkflowStartupReconcileAgent[];
}>;

function readRunHeadlineSeed(
  run: SessionWorkflowRunHeadlineV1,
): Omit<WorkflowStartupReconcileCandidate, 'runTerminalStatus' | 'orphanAgents'> {
  return {
    runId: run.runId,
    title: run.title,
    totalAgents: run.totalAgents,
    completedAgents: run.completedAgents,
    ...(run.workflowToolUseId !== undefined ? { workflowToolUseId: run.workflowToolUseId } : {}),
    ...(run.failedAgents !== undefined ? { failedAgents: run.failedAgents } : {}),
    ...(run.blockedAgents !== undefined ? { blockedAgents: run.blockedAgents } : {}),
  };
}

function readOrphanAgent(entry: SessionAgentActivityEntryV1): Readonly<{ runId: string; agent: WorkflowStartupReconcileAgent }> | null {
  if (entry.kind !== 'workflow_agent') return null;
  // Through the protocol owner: the agent id is a COMPONENT of the entry id, escaped, and a local
  // split on ':' reads `workflow-agent:1` (a real journal fallback id) back as a different agent.
  const ref = parseAgentActivityEntryId(entry.entryId);
  if (ref === null || ref.kind !== 'workflow_agent') return null;
  return {
    runId: entry.runId ?? ref.runId,
    agent: {
      agentId: ref.agentId,
      title: entry.title,
      updatedAt: entry.updatedAt,
      ...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
      ...(entry.sidechainId !== undefined ? { sidechainId: entry.sidechainId } : {}),
    },
  };
}

/**
 * Everything the previous process left running, from BOTH halves of what it published.
 *
 * The two headlines are written in one metadata update and derived from the same committed
 * snapshots, but they are partitioned independently: a run is `active`/`recent` by ITS status, and
 * an agent entry is `active`/`recent` by its own. A process killed after a run reached a terminal
 * status but before its agents did therefore leaves a terminal run beside live agent entries —
 * and reading only `activeRuns`, as this collector used to, captures nothing at all for it. That is
 * the observed `captured 0 candidate(s)` on a session still showing sixteen agents at work: the
 * recovery was run-scoped and count-only while the surface is agent-scoped, so no later restart
 * ever revisited the rows.
 *
 * `activeEntries` is the right evidence for the agent half and needs no bound: the producer never
 * caps live work, only terminal history.
 */
export function collectStartupReconcileCandidates(
  headline: SessionWorkflowActivityHeadlineV1 | null | undefined,
  agentHeadline?: SessionAgentActivityHeadlineV1 | null | undefined,
): WorkflowStartupReconcileCandidate[] {
  const orphansByRunId = new Map<string, WorkflowStartupReconcileAgent[]>();
  for (const entry of agentHeadline?.activeEntries ?? []) {
    const orphan = readOrphanAgent(entry);
    if (!orphan) continue;
    const bucket = orphansByRunId.get(orphan.runId);
    if (bucket) bucket.push(orphan.agent);
    else orphansByRunId.set(orphan.runId, [orphan.agent]);
  }

  const runHeadlinesById = new Map<string, SessionWorkflowRunHeadlineV1>();
  for (const run of [...(headline?.activeRuns ?? []), ...(headline?.recentRuns ?? [])]) {
    if (!runHeadlinesById.has(run.runId)) runHeadlinesById.set(run.runId, run);
  }

  // The roster's own name for each run, which is REACHABLE when the workflow headline's is not: the
  // workflow headline bounds its terminal history, while the roster never bounds live entries, so a
  // finished run can age out of `recentRuns` while the agents it left running are still listed. The
  // run title is the card's heading, and falling back to a raw run id there is the same defect W-7
  // fixed for agent rows.
  const runTitlesFromRoster = new Map<string, string>();
  for (const entry of [...(agentHeadline?.activeEntries ?? []), ...(agentHeadline?.recentEntries ?? [])]) {
    if (entry.kind !== 'workflow_run') continue;
    const ref = parseAgentActivityEntryId(entry.entryId);
    if (ref?.kind !== 'workflow_run') continue;
    if (!runTitlesFromRoster.has(ref.runId)) runTitlesFromRoster.set(ref.runId, entry.title);
  }

  const candidates: WorkflowStartupReconcileCandidate[] = [];
  const claimedRunIds = new Set<string>();

  for (const run of headline?.activeRuns ?? []) {
    if (isTerminalWorkflowRunStatus(run.status)) continue;
    claimedRunIds.add(run.runId);
    const orphanAgents = orphansByRunId.get(run.runId);
    candidates.push({
      ...readRunHeadlineSeed(run),
      ...(orphanAgents?.length ? { orphanAgents } : {}),
    });
  }

  for (const [runId, orphanAgents] of orphansByRunId) {
    if (claimedRunIds.has(runId)) continue;
    const run = runHeadlinesById.get(runId);
    candidates.push({
      ...(run
        ? readRunHeadlineSeed(run)
        // The run aged out of the workflow headline's bounded history and only its agents survive.
        // Its counts are unknown, and the reconcile derives them from the agents it rebuilds, so a
        // zero here is not a claim about the run.
        : { runId, title: runTitlesFromRoster.get(runId) ?? runId, totalAgents: 0, completedAgents: 0 }),
      ...(run && isTerminalWorkflowRunStatus(run.status) ? { runTerminalStatus: run.status } : {}),
      orphanAgents,
    });
  }

  return candidates;
}

export function resolveStartupReconcileTargets(
  candidates: readonly WorkflowStartupReconcileCandidate[],
  observedRunIds: ReadonlySet<string>,
): WorkflowStartupReconcileCandidate[] {
  return candidates.filter((candidate) => !observedRunIds.has(candidate.runId));
}
