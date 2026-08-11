import {
  buildSessionAgentActivityHeadline,
  buildSessionWorkflowActivityHeadline,
  bumpWorkflowRunRecordRevision,
  isWorkflowRunSnapshotMaterialChange,
  type SessionAgentActivityEntryV1,
  type SessionAgentActivityHeadlineV1,
  type SessionWorkflowActivityHeadlineV1,
  type SessionWorkflowRunHeadlineV1,
  type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';

import { isPermanentRequestError } from '@/api/client/httpStatusError';

import { projectWorkflowRunAgentActivityEntries } from './agentActivityHeadlineProjection';

/**
 * Provider-agnostic per-run activity publisher (CWF3, widened for agent activity).
 *
 * The ONE chokepoint that turns the normalizer's per-run snapshot map into durable
 * `activity/workflow_run.v1` records (FIRST) and the compact session-metadata headlines (SECOND).
 * Publish order and failure isolation are enforced here so the UI never observes a headline pointing
 * at a missing durable record:
 *
 * - Record FIRST, headlines SECOND.
 * - Per-run failure isolation: a failed record write for run A must not block run B's record/headline
 *   advance. A run that has never committed is omitted from the headline (no stale pointer); a run
 *   that previously committed keeps its last committed headline entry until a later write succeeds.
 * - Both headlines are derived from the SAME committed snapshots via shared protocol builders, so
 *   they are count-only, deterministically ordered, and structurally incapable of disagreeing about
 *   what exists.
 *
 * BOTH keys are handed to the transport in ONE `writeHeadlines` call. Two callbacks would mean two
 * session-metadata mutations per drain — double the write traffic on every progress tick, and a
 * window in which the two keys describe different worlds. One bundle, one write, one truth.
 *
 * Agent-activity kinds published here are exactly the ones this seam has a proven live writer for:
 * `workflow_run` and `workflow_agent`, both carried by the snapshot the tracker already commits. A
 * kind without a writer would be a dormant branch in every consumer (PLAN §5.1 item 11).
 *
 * The publisher does no scheduling/coalescing itself — the coalesced scheduler drives it. It is pure
 * orchestration over injected `commitRecord`/`writeHeadlines` boundary functions, so it is fully unit
 * testable without HTTP/metadata transport.
 */

export type WorkflowActivityPublishInput = Readonly<{
  /** Every currently-known run snapshot keyed by runId (active + terminal). */
  snapshots: ReadonlyMap<string, SessionWorkflowRunSnapshotV1>;
  /** Run ids whose normalized snapshot changed materially this drain (records to (re)commit). */
  changedRunIds: readonly string[];
}>;

export type WorkflowActivityPublishResult = Readonly<{
  /** Run ids whose durable record write failed and must be retried by the coalescing layer. */
  failedRunIds: readonly string[];
  /** Run ids whose durable record write failed permanently and must NOT be retried by the scheduler. */
  permanentFailedRunIds: readonly string[];
}>;

export type WorkflowActivityPublisher = Readonly<{
  publish(input: WorkflowActivityPublishInput): Promise<WorkflowActivityPublishResult>;
}>;

/**
 * Both headline keys for one drain, written together.
 *
 * `workflow` keeps its exact released shape and key — this program is the expand step only (PLAN
 * §5.2), so an old client reading `sessionWorkflowActivityHeadlineV1` sees precisely what it saw
 * before.
 */
export type SessionActivityHeadlineBundle = Readonly<{
  workflow: SessionWorkflowActivityHeadlineV1;
  agentActivity: SessionAgentActivityHeadlineV1;
}>;

/** The last successfully committed durable state for a run (used for revision ownership/failure isolation). */
type CommittedRunState = Readonly<{
  /** The snapshot whose durable record is committed. Owns `recordRevision`. */
  snapshot: SessionWorkflowRunSnapshotV1;
  /**
   * The newest projected snapshot for this run, used for DISPLAY fields only.
   *
   * Mirrors what the workflow headline already does for unchanged runs: display can move ahead of
   * the last durable write, the record pointer cannot. Keeping it lets the agent-activity entries
   * (which read `agents[]`) stay as fresh as the run headline's counts, from one shared value.
   */
  display: SessionWorkflowRunSnapshotV1;
  headline: SessionWorkflowRunHeadlineV1;
}>;

function buildRunHeadline(
  snapshot: SessionWorkflowRunSnapshotV1,
  recordUpdatedAt: number,
): SessionWorkflowRunHeadlineV1 {
  const headline: SessionWorkflowRunHeadlineV1 = {
    runId: snapshot.runId,
    title: snapshot.title,
    status: snapshot.status,
    updatedAt: snapshot.updatedAt,
    recordRevision: snapshot.recordRevision,
    recordUpdatedAt,
    totalAgents: snapshot.totalAgents,
    completedAgents: snapshot.completedAgents,
  };
  if (snapshot.statusReason !== undefined) headline.statusReason = snapshot.statusReason;
  if (snapshot.workflowToolUseId !== undefined) headline.workflowToolUseId = snapshot.workflowToolUseId;
  if (snapshot.failedAgents !== undefined) headline.failedAgents = snapshot.failedAgents;
  if (snapshot.blockedAgents !== undefined) headline.blockedAgents = snapshot.blockedAgents;
  return headline;
}

export function createWorkflowActivityPublisher(params: Readonly<{
  backendId: string;
  agentId?: string;
  /**
   * Optional durable readback used to seed committed revision state after a runner/source restart.
   * Without this, a recreated publisher would start from revision 1 and could overwrite a higher
   * committed record revision.
   */
  readCommittedRunSnapshot?: (runId: string) => Promise<SessionWorkflowRunSnapshotV1 | null>;
  /** Durable per-run record write. Rejection => that run's headline does not advance this drain. */
  commitRecord: (snapshot: SessionWorkflowRunSnapshotV1) => Promise<void>;
  /**
   * Single metadata write carrying BOTH headline keys. Rejection => the scheduler retries the
   * current dirty run set; the next drain rebuilds both headlines from committed state, so a retry
   * is idempotent.
   */
  writeHeadlines: (bundle: SessionActivityHeadlineBundle) => Promise<void> | void;
  /** Terminal-history bound for the agent-activity headline. Live entries are never bounded. */
  recentEntriesLimit?: number;
  /** Diagnostics sink for per-run record write failures. */
  onError?: (error: unknown, context: Readonly<{ runId: string; retryable: boolean }>) => void;
  now?: () => number;
}>): WorkflowActivityPublisher {
  const now = params.now ?? Date.now;
  // The last committed headline entry per run; the source of truth for the headline when a run's
  // current record write fails (keep its previous committed pointer instead of advancing).
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

    // 1) Record FIRST — commit each changed run independently; isolate per-run failures.
    for (const runId of input.changedRunIds) {
      const snapshot = input.snapshots.get(runId);
      if (!snapshot) continue;
      try {
        await seedCommittedRunState(runId);
      } catch (error) {
        const retryable = isRetryableWorkflowActivityRecordWriteError(error);
        if (retryable) {
          failedRunIds.push(runId);
        } else {
          permanentFailedRunIds.push(runId);
        }
        params.onError?.(error, { runId, retryable });
        continue;
      }
      const committed = committedByRun.get(runId);
      const materialChange = isWorkflowRunSnapshotMaterialChange(committed?.snapshot, snapshot);
      if (!materialChange && committed) {
        const refreshedSnapshot: SessionWorkflowRunSnapshotV1 = {
          ...snapshot,
          recordRevision: committed.snapshot.recordRevision,
        };
        committedByRun.set(runId, {
          snapshot: committed.snapshot,
          display: refreshedSnapshot,
          headline: buildRunHeadline(refreshedSnapshot, committed.headline.recordUpdatedAt),
        });
        continue;
      }
      const recordRevision = bumpWorkflowRunRecordRevision(committed?.snapshot.recordRevision, materialChange);
      const snapshotToCommit: SessionWorkflowRunSnapshotV1 = {
        ...snapshot,
        recordRevision,
      };
      try {
        await params.commitRecord(snapshotToCommit);
        committedByRun.set(runId, {
          snapshot: snapshotToCommit,
          display: snapshotToCommit,
          headline: buildRunHeadline(snapshotToCommit, now()),
        });
      } catch (error) {
        // Do NOT advance this run's committed headline pointer; it keeps its previous entry (if any).
        const retryable = isRetryableWorkflowActivityRecordWriteError(error);
        if (retryable) {
          failedRunIds.push(runId);
        } else {
          permanentFailedRunIds.push(runId);
        }
        params.onError?.(error, { runId, retryable });
      }
    }

    // Drop committed entries for runs that no longer exist (defensive; tracker keeps runs forever in
    // Phase 3, but this keeps the headline from carrying ghost runs if a run is ever removed).
    for (const runId of [...committedByRun.keys()]) {
      if (!input.snapshots.has(runId)) committedByRun.delete(runId);
    }

    // For unchanged runs that already committed, refresh their headline projection from the latest
    // snapshot WITHOUT advancing recordRevision/recordUpdatedAt (display fields like status order may
    // shift), but only when the committed revision still matches — otherwise keep the committed entry.
    for (const [runId, snapshot] of input.snapshots) {
      if (changed.has(runId)) continue;
      const committed = committedByRun.get(runId);
      if (!committed) continue;
      const refreshedSnapshot: SessionWorkflowRunSnapshotV1 = {
        ...snapshot,
        recordRevision: committed.snapshot.recordRevision,
      };
      committedByRun.set(runId, {
        snapshot: committed.snapshot,
        display: refreshedSnapshot,
        headline: buildRunHeadline(refreshedSnapshot, committed.headline.recordUpdatedAt),
      });
    }

    // 2) Headlines SECOND — both derived from committed (durable-backed) state, in one write.
    const committedStates = [...committedByRun.values()];
    const runs: SessionWorkflowRunHeadlineV1[] = committedStates.map((state) => state.headline);
    const entries: SessionAgentActivityEntryV1[] = [];
    for (const state of committedStates) {
      entries.push(...projectWorkflowRunAgentActivityEntries(state.display));
    }
    const publishedAt = now();
    await params.writeHeadlines({
      workflow: buildSessionWorkflowActivityHeadline({
        backendId: params.backendId,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        updatedAt: publishedAt,
        runs,
      }),
      agentActivity: buildSessionAgentActivityHeadline({
        backendId: params.backendId,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        updatedAt: publishedAt,
        entries,
        ...(params.recentEntriesLimit !== undefined ? { recentEntriesLimit: params.recentEntriesLimit } : {}),
      }),
    });
    return { failedRunIds, permanentFailedRunIds };
  }

  return { publish };
}

/**
 * RPC-transport rejection codes that carry no HTTP status of their own. They are this seam's
 * vocabulary on top of the canonical status rule, never a second copy of it.
 */
const NON_RETRYABLE_WORKFLOW_RECORD_ERROR_CODES = new Set([
  'conflict',
  'forbidden',
  'invalid-params',
  'session-not-found',
  'session_not_found',
]);

function isRetryableWorkflowActivityRecordWriteError(error: unknown): boolean {
  // The 4xx/5xx split and "this response was already refused" have ONE owner
  // (`httpStatusError#isPermanentRequestError`). Without it a validation 400, a 426 upgrade demand
  // and an unparseable body all read as retryable here and the coalescer re-queues them forever.
  if (isPermanentRequestError(error)) return false;
  const record = error && typeof error === 'object' ? error as Record<string, unknown> : null;
  const code = typeof record?.code === 'string'
    ? record.code
    : typeof record?.error === 'string'
      ? record.error
      : null;
  return !code || !NON_RETRYABLE_WORKFLOW_RECORD_ERROR_CODES.has(code);
}
