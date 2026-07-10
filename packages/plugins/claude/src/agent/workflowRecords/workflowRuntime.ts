import type {
  PluginContextV1,
  SessionRuntimeActivityPublisher,
  SessionSystemRecordReadRequestV1,
  SessionSystemRecordReadResultV1,
  SessionSystemRecordWriteRequestV1,
  SessionMetadataWriteRequestV1,
} from '@happier-dev/plugin-sdk';
import {
  ACTIVITY_SESSION_SYSTEM_RECORD_KINDS,
  SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE,
  buildWorkflowRunSystemRecordLocalId,
  isTerminalWorkflowRunStatus,
  SessionWorkflowActivityHeadlineV1Schema,
  SessionWorkflowRunSnapshotV1Schema,
  type SessionWorkflowActivityHeadlineV1,
  type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/plugin-sdk/experimental/sessions/workState';

import {
  createClaudeWorkflowActivityTracker,
  type WorkflowInterruptedRunSeed,
} from './tracker.js';
import { createWorkflowActivityPublisher } from './publishWorkflowActivitySnapshot.js';
import { createCoalescedWorkflowActivityPublisher } from './coalescedWorkflowActivityPublisher.js';
import {
  createClaudeWorkflowJournalFollower,
  type ClaudeWorkflowJournalFollower,
} from './journalFollower.js';
import type { WorkflowActivityObservation } from './types.js';
import { buildClaudeProviderTaskRuntimeActivitySourceId } from '../runtime/remote/sdk/providerActivity.js';

/**
 * Centralized Claude Dynamic Workflow ACTIVITY runtime for the unified terminal (CWF2/CWF3/CWF4).
 *
 * The single module that turns raw Claude transcript values into durable provider-agnostic workflow
 * activity, mirroring `goalRuntime`'s SOURCE half so the workflow wiring is never scattered:
 *
 *  - SOURCE: `observeTranscriptMessage(row)` is wired into the provider transcript follow loop's
 *    `onObserveRow` (the SAME raw channel the goal source observes).
 *  - PUBLISH: the tracker's per-run snapshots flow through the coalesced publisher, which writes
 *    durable `activity/workflow_run.v1` records FIRST (via the host `writeSystemRecord` capability)
 *    and the compact `sessionWorkflowActivityHeadlineV1` metadata headline SECOND (via the host
 *    `writeMetadata` merge-safe write). The host owns credentials + the DEK + content sealing.
 *  - CWF4: `getWorkflowOwnedAgentToolUseIds()` exposes the workflow-owned subagent tool-use ids so the
 *    task work-state derivation can suppress duplicate top-level rows.
 *
 * `writeSystemRecord`/`writeMetadata` are injected so this runtime stays unit-testable without the
 * host context.
 */

const WORKFLOW_ACTIVITY_NAMESPACE = SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE;
const WORKFLOW_RUN_RECORD_KIND = ACTIVITY_SESSION_SYSTEM_RECORD_KINDS[0];
const DEFAULT_WORKFLOW_STARTUP_RECONCILE_GRACE_MS = 30_000;

/** Durable system-record write (the host-owned, host-sealed capability). */
export type ClaudeWorkflowSystemRecordWriter = (
  request: SessionSystemRecordWriteRequestV1,
) => Promise<void>;

/** Durable system-record read (the host-owned, host-opened capability). */
export type ClaudeWorkflowSystemRecordReader = (
  request: SessionSystemRecordReadRequestV1,
) => Promise<SessionSystemRecordReadResultV1 | null>;

/** Read-modify-write metadata update (the host's merge-safe write seam). */
export type ClaudeWorkflowMetadataWriter = (
  request: SessionMetadataWriteRequestV1,
) => Promise<void>;

export type ClaudeUnifiedWorkflowRuntime = Readonly<{
  /** Observe one raw transcript value (same raw channel as the goal source). Non-workflow noise ignored. */
  observeTranscriptMessage(message: unknown): WorkflowActivityObservation;
  /** Workflow-owned subagent tool-use ids — the CWF4 hook to suppress duplicate work-state rows. */
  getWorkflowOwnedAgentToolUseIds(): ReadonlySet<string>;
  /** Terminate persisted non-terminal runs that this fresh runtime did not replay live. */
  reconcileStartupInterruptedRuns(candidates: readonly WorkflowInterruptedRunSeed[]): Promise<void>;
  /** Drain pending writes immediately (turn end / stream close / session finalization). */
  flush(): Promise<void>;
  /** Stop scheduling. */
  dispose(): void;
}>;

export function createClaudeUnifiedWorkflowRuntime(params: Readonly<{
  backendId: string;
  agentId?: string;
  /** The Claude transcript session id guard (NOT the Happier session id). Null until learned. */
  getCurrentClaudeSessionId: () => string | null;
  /** Durable per-run record write, bound to the host `ctx.sessions.current.writeSystemRecord` capability. */
  writeSystemRecord: ClaudeWorkflowSystemRecordWriter;
  /** Optional durable per-run record readback, bound to the host `ctx.sessions.current.readSystemRecord` capability. */
  readSystemRecord?: ClaudeWorkflowSystemRecordReader;
  /** Headline metadata write, bound to the host `ctx.sessions.current.writeMetadata` capability. */
  writeMetadata: ClaudeWorkflowMetadataWriter;
  /** Optional host transcript file follower, used for Claude Workflow sidecar journals. */
  fileFollow?: Pick<PluginContextV1['agentRuntime']['transcripts']['fileFollow'], 'follow'>;
  /** Optional provider-neutral runtime activity projection publisher for live workflow liveness. */
  runtimeActivityPublisher?: SessionRuntimeActivityPublisher | null;
  /** Persisted headline from the session snapshot that created this fresh runtime. */
  initialWorkflowActivityHeadline?: unknown;
  /** Grace for transcript replay to re-observe a genuinely resumed persisted run. */
  startupReconcileGraceMs?: number;
  debounceMs?: number;
  logError?: (message: string, error: unknown) => void;
}>): ClaudeUnifiedWorkflowRuntime {
  const tracker = createClaudeWorkflowActivityTracker({
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    getCurrentClaudeSessionId: params.getCurrentClaudeSessionId,
  });

  // W-4 lease heartbeat: tie runtime-activity liveness to the durable write cadence. Assigned after
  // the runtime-activity helpers below exist; called on EVERY successful durable commit (not only on
  // `changedRunIds` observations) so a long-running workflow with sparse progress — or a turn-end
  // coalesced flush that commits without a fresh observation — never lets the ephemeral "working"
  // lease lapse while its durable record still says active.
  let renewRuntimeLeaseAfterCommit: (snapshot: SessionWorkflowRunSnapshotV1) => void = () => {};

  const commitRecord = async (snapshot: SessionWorkflowRunSnapshotV1): Promise<void> => {
    await params.writeSystemRecord({
      namespace: WORKFLOW_ACTIVITY_NAMESPACE,
      kind: WORKFLOW_RUN_RECORD_KIND,
      localId: buildWorkflowRunSystemRecordLocalId({ runId: snapshot.runId }),
      payload: snapshot,
      reason: 'claude_workflow_activity_record',
    });
    renewRuntimeLeaseAfterCommit(snapshot);
  };

  const readCommittedRunSnapshot = params.readSystemRecord
    ? async (runId: string): Promise<SessionWorkflowRunSnapshotV1 | null> => {
        const localId = buildWorkflowRunSystemRecordLocalId({ runId });
        const record = await params.readSystemRecord?.({
          namespace: WORKFLOW_ACTIVITY_NAMESPACE,
          localId,
          reason: 'claude_workflow_activity_record_readback',
        });
        if (!record || record.localId !== localId || record.kind !== WORKFLOW_RUN_RECORD_KIND) {
          return null;
        }
        const parsed = SessionWorkflowRunSnapshotV1Schema.safeParse(record.payload);
        return parsed.success ? parsed.data : null;
      }
    : undefined;

  const writeHeadline = async (headline: SessionWorkflowActivityHeadlineV1): Promise<void> => {
    // Merge-safe metadata write under the LOCKED key `sessionWorkflowActivityHeadlineV1` (the live
    // invalidation pointer; never full detail). Failures propagate to the publisher so the
    // coalescing layer retries the same dirty run set after the record-first commit has succeeded.
    await params.writeMetadata({
      kind: 'update',
      handler: (current) => ({ ...current, sessionWorkflowActivityHeadlineV1: headline }),
      reason: 'claude_workflow_activity_headline',
    });
  };

  const publisher = createWorkflowActivityPublisher({
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(readCommittedRunSnapshot ? { readCommittedRunSnapshot } : {}),
    commitRecord,
    writeHeadline,
    onError: (error, ctx) => {
      params.logError?.(
        `durable workflow record write failed for run ${ctx.runId} (${ctx.retryable ? 'will retry' : 'permanent'})`,
        error,
      );
    },
  });

  const coalesced = createCoalescedWorkflowActivityPublisher({
    publisher,
    getSnapshots: () => tracker.getRunSnapshotMap(),
    ...(params.debounceMs !== undefined ? { debounceMs: params.debounceMs } : {}),
    onError: (error) => {
      params.logError?.('workflow activity publish drain failed (non-fatal)', error);
    },
  });

  let journalFollower: ClaudeWorkflowJournalFollower | null = null;
  const publishedRuntimeSourceIdByRunId = new Map<string, string>();

  const runRuntimeActivityEffect = (
    message: string,
    effect: () => Promise<void> | void,
  ): void => {
    try {
      void Promise.resolve(effect()).catch((error) => {
        params.logError?.(message, error);
      });
    } catch (error) {
      params.logError?.(message, error);
    }
  };

  const workflowRuntimeSourceId = (runId: string): string | null => {
    const sourceKey = tracker.getRuntimeActivitySourceKeyForRunId(runId) ?? runId;
    return buildClaudeProviderTaskRuntimeActivitySourceId(sourceKey);
  };

  const ensurePublishedRuntimeSourceId = (
    runId: string,
    sourceId: string,
    runtimeActivityPublisher: SessionRuntimeActivityPublisher,
  ): boolean => {
    const existing = publishedRuntimeSourceIdByRunId.get(runId);
    if (existing === sourceId) return false;
    if (existing) {
      runRuntimeActivityEffect('workflow runtime activity source rekey clear failed', () => (
        runtimeActivityPublisher.clearSource(existing)
      ));
    }
    publishedRuntimeSourceIdByRunId.set(runId, sourceId);
    return true;
  };

  const publishRuntimeActivityObservation = (observation: WorkflowActivityObservation): void => {
    const runtimeActivityPublisher = params.runtimeActivityPublisher;
    if (!runtimeActivityPublisher) return;

    const terminalRunIds = new Set(observation.terminalRunIds);
    const activeRunIds = new Set([
      ...observation.startedRunIds,
      ...observation.changedRunIds,
      ...(observation.runtimeActivityRunIds ?? []),
    ]);
    for (const runId of activeRunIds) {
      if (terminalRunIds.has(runId)) continue;
      const sourceId = workflowRuntimeSourceId(runId);
      if (!sourceId) continue;
      if (ensurePublishedRuntimeSourceId(runId, sourceId, runtimeActivityPublisher)) {
        runRuntimeActivityEffect('workflow runtime activity source active failed', () => (
          runtimeActivityPublisher.markSourceActive({
            sourceId,
            sourceKind: 'provider_detached_task',
          })
        ));
      } else {
        runRuntimeActivityEffect('workflow runtime activity source renew failed', () => (
          runtimeActivityPublisher.renewSource(sourceId)
        ));
      }
    }
    for (const runId of observation.terminalRunIds) {
      const sourceId = workflowRuntimeSourceId(runId);
      if (!sourceId) continue;
      const existingSourceId = publishedRuntimeSourceIdByRunId.get(runId);
      publishedRuntimeSourceIdByRunId.delete(runId);
      if (existingSourceId && existingSourceId !== sourceId) {
        runRuntimeActivityEffect('workflow runtime activity terminal clear failed', () => (
          runtimeActivityPublisher.clearSource(existingSourceId)
        ));
      }
      runRuntimeActivityEffect('workflow runtime activity terminal clear failed', () => (
        runtimeActivityPublisher.clearSource(sourceId)
      ));
    }
  };

  const clearPublishedRuntimeSources = (): void => {
    const runtimeActivityPublisher = params.runtimeActivityPublisher;
    const sourceIds = new Set(publishedRuntimeSourceIdByRunId.values());
    publishedRuntimeSourceIdByRunId.clear();
    if (!runtimeActivityPublisher) return;
    for (const sourceId of sourceIds) {
      runRuntimeActivityEffect('workflow runtime activity dispose clear failed', () => (
        runtimeActivityPublisher.clearSource(sourceId)
      ));
    }
  };

  renewRuntimeLeaseAfterCommit = (snapshot: SessionWorkflowRunSnapshotV1): void => {
    const runtimeActivityPublisher = params.runtimeActivityPublisher;
    if (!runtimeActivityPublisher) return;
    // Terminal runs clear their source via the observation path; do not renew a lease we are about
    // to (or already did) clear.
    if (isTerminalWorkflowRunStatus(snapshot.status)) return;
    const sourceId = publishedRuntimeSourceIdByRunId.get(snapshot.runId) ?? workflowRuntimeSourceId(snapshot.runId);
    if (!sourceId) return;
    // `renewSource` is a no-op when the source is not active, so an out-of-order commit before the
    // source is announced simply does nothing — safe.
    runRuntimeActivityEffect('workflow runtime activity commit-heartbeat failed', () => (
      runtimeActivityPublisher.renewSource(sourceId)
    ));
  };

  const reconcileStartupInterruptedRuns = async (
    candidates: readonly WorkflowInterruptedRunSeed[],
  ): Promise<void> => {
    if (candidates.length === 0) return;
    const updatedAt = Date.now();
    let changed = false;
    for (const candidate of candidates) {
      const observation = tracker.reconcileInterruptedRunFromHeadline(candidate, { updatedAt });
      if (observation.changedRunIds.length === 0) continue;
      changed = true;
      publishRuntimeActivityObservation(observation);
      coalesced.notify(observation);
    }
    if (changed) await coalesced.flush();
  };

  const observeTrackerValue = (message: unknown): WorkflowActivityObservation => {
    const observation = tracker.observe(message, { updatedAt: Date.now() });
    if (
      observation.startedRunIds.length > 0
      || observation.terminalRunIds.length > 0
      || observation.changedRunIds.length > 0
      || (observation.runtimeActivityRunIds?.length ?? 0) > 0
    ) {
      publishRuntimeActivityObservation(observation);
    }
    for (const runId of observation.terminalRunIds) {
      journalFollower?.markRunCompleted(runId);
    }
    if (observation.changedRunIds.length > 0) {
      coalesced.notify(observation);
    }
    return observation;
  };

  journalFollower = createClaudeWorkflowJournalFollower({
    ...(params.fileFollow ? { fileFollow: params.fileFollow } : {}),
    onJournalValue: observeTrackerValue,
    logError: params.logError,
  });

  const parsedStartupHeadline = SessionWorkflowActivityHeadlineV1Schema.safeParse(
    params.initialWorkflowActivityHeadline,
  );
  const startupCandidates: WorkflowInterruptedRunSeed[] = parsedStartupHeadline.success
    ? parsedStartupHeadline.data.activeRuns
        .filter((run) => !isTerminalWorkflowRunStatus(run.status))
        .map((run) => ({
          runId: run.runId,
          title: run.title,
          totalAgents: run.totalAgents,
          completedAgents: run.completedAgents,
          ...(run.workflowToolUseId !== undefined ? { workflowToolUseId: run.workflowToolUseId } : {}),
          ...(run.failedAgents !== undefined ? { failedAgents: run.failedAgents } : {}),
          ...(run.blockedAgents !== undefined ? { blockedAgents: run.blockedAgents } : {}),
        }))
    : [];
  let startupReconcileTimer: ReturnType<typeof setTimeout> | null = null;
  if (startupCandidates.length > 0) {
    const graceMs = Math.max(
      0,
      Math.trunc(params.startupReconcileGraceMs ?? DEFAULT_WORKFLOW_STARTUP_RECONCILE_GRACE_MS),
    );
    startupReconcileTimer = setTimeout(() => {
      startupReconcileTimer = null;
      void reconcileStartupInterruptedRuns(startupCandidates).catch((error) => {
        params.logError?.('workflow startup interruption reconciliation failed (non-fatal)', error);
      });
    }, graceMs);
    startupReconcileTimer.unref?.();
  }

  return {
    observeTranscriptMessage(message) {
      const observation = observeTrackerValue(message);
      journalFollower?.observeTranscriptMessage(message);
      return observation;
    },
    getWorkflowOwnedAgentToolUseIds() {
      return tracker.getWorkflowOwnedAgentToolUseIds();
    },
    reconcileStartupInterruptedRuns,
    async flush() {
      await journalFollower?.syncAll();
      await coalesced.flush();
    },
    dispose() {
      if (startupReconcileTimer !== null) {
        clearTimeout(startupReconcileTimer);
        startupReconcileTimer = null;
      }
      clearPublishedRuntimeSources();
      journalFollower?.dispose();
      coalesced.dispose();
    },
  };
}
