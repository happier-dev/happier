import {
  buildAgentActivityEntryId,
  buildSessionAgentActivityHeadline,
  buildSessionWorkflowActivityHeadline,
  bumpWorkflowRunRecordRevision,
  fromWorkflowAgentStatus,
  fromWorkflowRunStatus,
  isWorkflowRunSnapshotMaterialChange,
  type SessionActivityHeadlineBundleV1,
  type SessionAgentActivityEntryV1,
  type SessionWorkflowRunHeadlineV1,
  type SessionWorkflowRunSnapshotV1,
} from './workState.js';

export type WorkflowActivityPublishInput = Readonly<{
  snapshots: ReadonlyMap<string, SessionWorkflowRunSnapshotV1>;
  changedRunIds: readonly string[];
}>;

export type WorkflowActivityPublishResult = Readonly<{
  failedRunIds: readonly string[];
  permanentFailedRunIds: readonly string[];
}>;

export type WorkflowActivityPublisher = Readonly<{
  publish(input: WorkflowActivityPublishInput): Promise<WorkflowActivityPublishResult>;
}>;

type CommittedRunState = Readonly<{
  snapshot: SessionWorkflowRunSnapshotV1;
  display: SessionWorkflowRunSnapshotV1;
  headline: SessionWorkflowRunHeadlineV1;
}>;

function buildRunHeadline(
  snapshot: SessionWorkflowRunSnapshotV1,
  recordUpdatedAt: number,
): SessionWorkflowRunHeadlineV1 {
  return {
    runId: snapshot.runId,
    title: snapshot.title,
    status: snapshot.status,
    updatedAt: snapshot.updatedAt,
    recordRevision: snapshot.recordRevision,
    recordUpdatedAt,
    totalAgents: snapshot.totalAgents,
    completedAgents: snapshot.completedAgents,
    ...(snapshot.statusReason !== undefined ? { statusReason: snapshot.statusReason } : {}),
    ...(snapshot.workflowToolUseId !== undefined ? { workflowToolUseId: snapshot.workflowToolUseId } : {}),
    ...(snapshot.failedAgents !== undefined ? { failedAgents: snapshot.failedAgents } : {}),
    ...(snapshot.blockedAgents !== undefined ? { blockedAgents: snapshot.blockedAgents } : {}),
  };
}

export function projectWorkflowRunAgentActivityEntries(
  snapshot: SessionWorkflowRunSnapshotV1,
): SessionAgentActivityEntryV1[] {
  const runEntryId = buildAgentActivityEntryId({ kind: 'workflow_run', runId: snapshot.runId });
  const entries: SessionAgentActivityEntryV1[] = [{
    entryId: runEntryId,
    kind: 'workflow_run',
    title: snapshot.title,
    status: fromWorkflowRunStatus(snapshot.status),
    updatedAt: snapshot.updatedAt,
    runId: snapshot.runId,
    recordRevision: snapshot.recordRevision,
    ...(snapshot.startedAt !== undefined ? { startedAt: snapshot.startedAt } : {}),
  }];
  for (const agent of snapshot.agents) {
    entries.push({
      entryId: buildAgentActivityEntryId({
        kind: 'workflow_agent',
        runId: snapshot.runId,
        agentId: agent.id,
      }),
      kind: 'workflow_agent',
      title: agent.title,
      status: fromWorkflowAgentStatus(agent.status),
      updatedAt: agent.updatedAt,
      runId: snapshot.runId,
      parentId: runEntryId,
      ...(agent.startedAt !== undefined ? { startedAt: agent.startedAt } : {}),
      ...('sidechainId' in agent && typeof agent.sidechainId === 'string'
        ? { sidechainId: agent.sidechainId }
        : {}),
    });
  }
  return entries;
}

const NON_RETRYABLE_WORKFLOW_RECORD_ERROR_CODES = new Set([
  'conflict',
  'forbidden',
  'invalid-params',
  'session-not-found',
  'session_not_found',
]);

function isRetryableWorkflowActivityRecordWriteError(error: unknown): boolean {
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : null;
  const code = typeof record?.code === 'string'
    ? record.code
    : typeof record?.error === 'string'
      ? record.error
      : null;
  return !code || !NON_RETRYABLE_WORKFLOW_RECORD_ERROR_CODES.has(code);
}

export function createWorkflowActivityPublisher(params: Readonly<{
  backendId: string;
  agentId?: string;
  readCommittedRunSnapshot?: (runId: string) => Promise<SessionWorkflowRunSnapshotV1 | null>;
  commitRecord: (snapshot: SessionWorkflowRunSnapshotV1) => Promise<void>;
  writeHeadlines: (bundle: SessionActivityHeadlineBundleV1) => Promise<void> | void;
  recentEntriesLimit?: number;
  onError?: (error: unknown, context: Readonly<{ runId: string; retryable: boolean }>) => void;
  now?: () => number;
}>): WorkflowActivityPublisher {
  const now = params.now ?? Date.now;
  const committedByRun = new Map<string, CommittedRunState>();
  const seededRunIds = new Set<string>();

  async function seedCommittedRunState(runId: string): Promise<void> {
    if (committedByRun.has(runId) || seededRunIds.has(runId) || !params.readCommittedRunSnapshot) return;
    const snapshot = await params.readCommittedRunSnapshot(runId);
    seededRunIds.add(runId);
    if (!snapshot) return;
    committedByRun.set(runId, {
      snapshot,
      display: snapshot,
      headline: buildRunHeadline(snapshot, now()),
    });
  }

  async function publish(input: WorkflowActivityPublishInput): Promise<WorkflowActivityPublishResult> {
    const changed = new Set(input.changedRunIds);
    const failedRunIds: string[] = [];
    const permanentFailedRunIds: string[] = [];

    for (const runId of input.changedRunIds) {
      const snapshot = input.snapshots.get(runId);
      if (!snapshot) continue;
      try {
        await seedCommittedRunState(runId);
      } catch (error) {
        const retryable = isRetryableWorkflowActivityRecordWriteError(error);
        (retryable ? failedRunIds : permanentFailedRunIds).push(runId);
        params.onError?.(error, { runId, retryable });
        continue;
      }
      const committed = committedByRun.get(runId);
      const materialChange = isWorkflowRunSnapshotMaterialChange(committed?.snapshot, snapshot);
      if (!materialChange && committed) {
        const display = { ...snapshot, recordRevision: committed.snapshot.recordRevision };
        committedByRun.set(runId, {
          snapshot: committed.snapshot,
          display,
          headline: buildRunHeadline(display, committed.headline.recordUpdatedAt),
        });
        continue;
      }
      const snapshotToCommit = {
        ...snapshot,
        recordRevision: bumpWorkflowRunRecordRevision(committed?.snapshot.recordRevision, materialChange),
      };
      try {
        await params.commitRecord(snapshotToCommit);
        committedByRun.set(runId, {
          snapshot: snapshotToCommit,
          display: snapshotToCommit,
          headline: buildRunHeadline(snapshotToCommit, now()),
        });
      } catch (error) {
        const retryable = isRetryableWorkflowActivityRecordWriteError(error);
        (retryable ? failedRunIds : permanentFailedRunIds).push(runId);
        params.onError?.(error, { runId, retryable });
      }
    }

    for (const runId of [...committedByRun.keys()]) {
      if (!input.snapshots.has(runId)) committedByRun.delete(runId);
    }
    for (const [runId, snapshot] of input.snapshots) {
      if (changed.has(runId)) continue;
      const committed = committedByRun.get(runId);
      if (!committed) continue;
      const display = { ...snapshot, recordRevision: committed.snapshot.recordRevision };
      committedByRun.set(runId, {
        snapshot: committed.snapshot,
        display,
        headline: buildRunHeadline(display, committed.headline.recordUpdatedAt),
      });
    }

    const committedStates = [...committedByRun.values()];
    const updatedAt = now();
    await params.writeHeadlines({
      workflow: buildSessionWorkflowActivityHeadline({
        backendId: params.backendId,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        updatedAt,
        runs: committedStates.map((state) => state.headline),
      }),
      agentActivity: buildSessionAgentActivityHeadline({
        backendId: params.backendId,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        updatedAt,
        entries: committedStates.flatMap((state) => projectWorkflowRunAgentActivityEntries(state.display)),
        ...(params.recentEntriesLimit !== undefined
          ? { recentEntriesLimit: params.recentEntriesLimit }
          : {}),
      }),
    });
    return { failedRunIds, permanentFailedRunIds };
  }

  return { publish };
}
