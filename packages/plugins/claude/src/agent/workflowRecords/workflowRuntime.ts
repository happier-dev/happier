import {
  AgentRuntimeJsonValueSchema,
  type AgentTranscriptFileFollowService,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type {
  SessionHandle,
  SessionSystemRecordReadRequestV1,
  SessionSystemRecordReadResultV1,
  SessionSystemRecordWriteRequestV1,
} from '@happier-dev/plugin-sdk/sessions';
import {
  ACTIVITY_SESSION_SYSTEM_RECORD_KINDS,
  SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE,
  buildWorkflowRunSystemRecordLocalId,
  isTerminalAgentActivityStatus,
  isTerminalWorkflowRunStatus,
  parseAgentActivityEntryId,
  SessionAgentActivityHeadlineV1Schema,
  SessionWorkflowActivityHeadlineV1Schema,
  SessionWorkflowRunSnapshotV1Schema,
  type SessionActivityHeadlineBundleV1,
  type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/plugin-sdk/sessions/work-state';

import {
  createClaudeWorkflowActivityTracker,
  type WorkflowInterruptedAgentSeed,
  type WorkflowInterruptedRunSeed,
} from './tracker.js';
import { createWorkflowActivityPublisher } from './publishWorkflowActivitySnapshot.js';
import { createCoalescedWorkflowActivityPublisher } from './coalescedWorkflowActivityPublisher.js';
import {
  createClaudeWorkflowJournalFollower,
  type ClaudeWorkflowJournalFollower,
} from './journalFollower.js';
import {
  readClaudeRecordTimestampMs,
  type ClaudeWorkflowShapeDriftReporter,
} from './correlation.js';
import type { WorkflowActivityObservation } from './types.js';
import type { ClaudeProviderTaskActivity } from '../runtime/remote/sdk/providerActivity.js';

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
 *    and BOTH compact metadata headlines — `sessionWorkflowActivityHeadlineV1` and
 *    `sessionAgentActivityHeadlineV1` — SECOND, in ONE write (via the typed activity-headline owner).
 *    The host owns credentials + the DEK + content sealing.
 *  - CWF4: `getWorkflowOwnedAgentToolUseIds()` exposes the workflow-owned subagent tool-use ids so the
 *    task work-state derivation can suppress duplicate top-level rows.
 *
 * `writeSystemRecord`/`publishHeadlines` are injected so this runtime stays unit-testable without the
 * host context.
 */

const WORKFLOW_ACTIVITY_NAMESPACE = SESSION_SYSTEM_RECORD_ACTIVITY_NAMESPACE;
const WORKFLOW_RUN_RECORD_KIND = ACTIVITY_SESSION_SYSTEM_RECORD_KINDS[0];
const DEFAULT_WORKFLOW_STARTUP_RECONCILE_GRACE_MS = 30_000;

/**
 * The only workflow-record adapter. It narrows the already-bound public
 * SessionHandle to the one registered host record this runtime owns; the
 * Session owner retains encryption, currentness, capability, CAS, and schema
 * authority.
 */
type ClaudeWorkflowRunRecordHandle = Pick<
  SessionHandle,
  'upsertSystemRecord' | 'readSystemRecord'
>;

export function createClaudeWorkflowSystemRecordBridge(
  systemRecords?: ClaudeWorkflowRunRecordHandle | null,
): Readonly<{
  write: ClaudeWorkflowSystemRecordWriter;
  read: ClaudeWorkflowSystemRecordReader;
}> | null {
  if (!systemRecords) return null;
  return Object.freeze({
    async write(request) {
      if (
        request.namespace !== WORKFLOW_ACTIVITY_NAMESPACE
        || request.kind !== WORKFLOW_RUN_RECORD_KIND
      ) {
        throw new Error('Claude workflow system-record bridge accepts only activity/workflow_run.v1 records');
      }
      await systemRecords.upsertSystemRecord({
        address: {
          owner: 'host',
          namespace: WORKFLOW_ACTIVITY_NAMESPACE,
          kind: WORKFLOW_RUN_RECORD_KIND,
          localId: request.localId,
        },
        content: AgentRuntimeJsonValueSchema.parse(request.payload),
      });
    },
    async read(request) {
      if (request.namespace !== WORKFLOW_ACTIVITY_NAMESPACE) {
        throw new Error('Claude workflow system-record bridge accepts only activity records');
      }
      const record = await systemRecords.readSystemRecord({
        address: {
          owner: 'host',
          namespace: WORKFLOW_ACTIVITY_NAMESPACE,
          kind: WORKFLOW_RUN_RECORD_KIND,
          localId: request.localId,
        },
      });
      if (!record) return null;
      if (
        record.address.owner !== 'host'
        || record.address.namespace !== WORKFLOW_ACTIVITY_NAMESPACE
        || record.address.kind !== WORKFLOW_RUN_RECORD_KIND
        || record.address.localId !== request.localId
      ) {
        throw new Error('Claude workflow system-record bridge received a non-workflow record');
      }
      return Object.freeze({
        namespace: WORKFLOW_ACTIVITY_NAMESPACE,
        kind: WORKFLOW_RUN_RECORD_KIND,
        localId: record.address.localId,
        payload: AgentRuntimeJsonValueSchema.parse(record.content),
      });
    },
  });
}

/** Durable system-record write through the host-owned, host-sealed capability. */
export type ClaudeWorkflowSystemRecordWriter = (
  request: SessionSystemRecordWriteRequestV1,
) => Promise<void>;

/** Durable system-record read through the host-owned, host-opened capability. */
export type ClaudeWorkflowSystemRecordReader = (
  request: SessionSystemRecordReadRequestV1,
) => Promise<SessionSystemRecordReadResultV1 | null>;

/**
 * Read-modify-write metadata update (the host's merge-safe write seam).
 *
 * Carries BOTH session-activity headline keys in one call, because they describe the same committed
 * run snapshots in two vocabularies: two publications would be two metadata mutations per drain and
 * a window in which the keys disagree about what exists.
 */
export type ClaudeWorkflowHeadlinePublisher = (
  bundle: SessionActivityHeadlineBundleV1,
) => Promise<void>;

export type ClaudeUnifiedWorkflowRuntime = Readonly<{
  /** Observe one raw transcript value (same raw channel as the goal source). Non-workflow noise ignored. */
  observeTranscriptMessage(
    message: unknown,
    context?: Readonly<{ historicalReplay?: boolean }>,
  ): WorkflowActivityObservation;
  /** Workflow-owned subagent tool-use ids — the CWF4 hook to suppress duplicate work-state rows. */
  getWorkflowOwnedAgentToolUseIds(): ReadonlySet<string>;
  /** Terminate persisted non-terminal runs that this fresh runtime did not replay live. */
  reconcileStartupInterruptedRuns(candidates: readonly WorkflowInterruptedRunSeed[]): Promise<void>;
  /**
   * Resolve runs and agents still active as the owning query tears down.
   *
   * Call it from an OBSERVED orderly shutdown, immediately before `flush()`, so the resolution is in
   * the same drain that publishes the query's last rows. An abrupt kill reaches nothing here — that
   * case is the startup reconcile's, which is why this is not a timer.
   */
  finalizeInterruptedActivityOnShutdown(): void;
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
  /** Optional durable per-run readback, bound to the host `ctx.sessions.current.readSystemRecord` capability. */
  readSystemRecord?: ClaudeWorkflowSystemRecordReader;
  /** Typed headline publication through the host workflow-activity owner. */
  publishHeadlines: ClaudeWorkflowHeadlinePublisher;
  /** Optional host transcript file follower, used for Claude Workflow sidecar journals. */
  fileFollow?: Pick<AgentTranscriptFileFollowService, 'follow'>;
  /** Persisted headline from the session snapshot that created this fresh runtime. */
  initialWorkflowActivityHeadline?: unknown;
  /**
   * The agent-scoped half of that same persisted pointer.
   *
   * Both keys are written in one metadata update, so they can never disagree about what exists. Only
   * this one names the agents: the workflow headline carries counts, and a crash-residue run
   * reconciled from counts alone can put no agent back on the roster.
   */
  initialAgentActivityHeadline?: unknown;
  /** Feed exact Workflow membership changes into the runtime's existing provider-activity ledger. */
  onProviderTaskActivity?: (activity: ClaudeProviderTaskActivity) => Promise<void> | void;
  /** Grace for transcript replay to re-observe a genuinely resumed persisted run. */
  startupReconcileGraceMs?: number;
  debounceMs?: number;
  logError?: (message: string, error: unknown) => void;
  /**
   * Report that a Claude-native shape this runtime depends on is no longer readable.
   *
   * Deliberately separate from `logError`: nothing failed and there is nothing to retry, and the
   * hosts bind `logError` to `logger.debug`, which is off in a session process. A degradation that
   * only a debug build can observe is the same silent failure this reporting exists to remove, so
   * this one is bound to `logger.warn`.
   */
  reportShapeDrift?: ClaudeWorkflowShapeDriftReporter;
}>): ClaudeUnifiedWorkflowRuntime {
  const tracker = createClaudeWorkflowActivityTracker({
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    getCurrentClaudeSessionId: params.getCurrentClaudeSessionId,
    ...(params.reportShapeDrift ? { reportShapeDrift: params.reportShapeDrift } : {}),
  });

  const commitRecord = async (snapshot: SessionWorkflowRunSnapshotV1): Promise<void> => {
    await params.writeSystemRecord({
      namespace: WORKFLOW_ACTIVITY_NAMESPACE,
      kind: WORKFLOW_RUN_RECORD_KIND,
      localId: buildWorkflowRunSystemRecordLocalId({ runId: snapshot.runId }),
      payload: snapshot,
      reason: 'claude_workflow_activity_record',
    });
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

  const writeHeadlines = async (bundle: SessionActivityHeadlineBundleV1): Promise<void> => {
    // Merge-safe metadata write under the LOCKED keys `sessionWorkflowActivityHeadlineV1` and
    // `sessionAgentActivityHeadlineV1` (live invalidation pointers; never full detail), in ONE
    // mutation. Failures propagate to the publisher so the coalescing layer retries the same dirty
    // run set after the record-first commit has succeeded.
    await params.publishHeadlines(bundle);
  };

  const publisher = createWorkflowActivityPublisher({
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(readCommittedRunSnapshot ? { readCommittedRunSnapshot } : {}),
    commitRecord,
    writeHeadlines,
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
  let providerTaskActivityTail: Promise<void> = Promise.resolve();
  const publishProviderTaskActivities = (
    activities: readonly ClaudeProviderTaskActivity[] | undefined,
  ): void => {
    if (!params.onProviderTaskActivity || !activities?.length) return;
    for (const activity of activities) {
      const publish = async (): Promise<void> => {
        try {
          await params.onProviderTaskActivity?.(activity);
        } catch (error) {
          params.logError?.('exact workflow provider-task activity failed (non-fatal)', error);
        }
      };
      providerTaskActivityTail = providerTaskActivityTail.then(publish, publish);
    }
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
      coalesced.notify(observation);
    }
    if (changed) await coalesced.flush();
  };

  const observeTrackerValue = (
    message: unknown,
    context?: Readonly<{ historicalReplay?: boolean }>,
  ): WorkflowActivityObservation => {
    const historicalReplay = context?.historicalReplay === true;
    const observation = tracker.observe(message, {
      // Resumed work is not fresh work: a replayed row is dated by the record itself, so reopening a
      // transcript cannot move a workflow's start to the moment it was re-read. A live row's instant
      // IS the clock, and records without a timestamp still fall back to it.
      updatedAt: (historicalReplay ? readClaudeRecordTimestampMs(message) : undefined) ?? Date.now(),
      live: !historicalReplay,
    });
    if (!historicalReplay) {
      publishProviderTaskActivities(observation.providerTaskActivities);
      for (const runId of observation.terminalRunIds) {
        journalFollower?.markRunCompleted(runId);
      }
      if (observation.changedRunIds.length > 0) {
        coalesced.notify(observation);
      }
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
  /**
   * The agents the previous process published as still running, indexed by the run they belong to.
   *
   * Read through `parseAgentActivityEntryId` rather than by splitting the id here: the id owner
   * percent-escapes its components precisely because a real agent id IS `workflow-agent:1`, so a
   * local split would read one agent back as a different one and either merge two rows or invent a
   * third. A terminal entry is skipped — its ending is already published and is better evidence
   * than a sweep.
   */
  const parsedAgentHeadline = SessionAgentActivityHeadlineV1Schema.safeParse(
    params.initialAgentActivityHeadline,
  );
  const orphanAgentsByRunId = new Map<string, WorkflowInterruptedAgentSeed[]>();
  if (parsedAgentHeadline.success) {
    for (const entry of parsedAgentHeadline.data.activeEntries) {
      if (entry.kind !== 'workflow_agent') continue;
      if (isTerminalAgentActivityStatus(entry.status)) continue;
      const ref = parseAgentActivityEntryId(entry.entryId);
      if (ref?.kind !== 'workflow_agent') continue;
      const orphans = orphanAgentsByRunId.get(ref.runId) ?? [];
      orphans.push({
        agentId: ref.agentId,
        title: entry.title,
        updatedAt: entry.updatedAt,
        ...(entry.startedAt !== undefined ? { startedAt: entry.startedAt } : {}),
      });
      orphanAgentsByRunId.set(ref.runId, orphans);
    }
  }
  const startupCandidates: WorkflowInterruptedRunSeed[] = parsedStartupHeadline.success
    ? parsedStartupHeadline.data.activeRuns
        .filter((run) => !isTerminalWorkflowRunStatus(run.status))
        .map((run) => {
          const orphanAgents = orphanAgentsByRunId.get(run.runId);
          return {
            runId: run.runId,
            title: run.title,
            totalAgents: run.totalAgents,
            completedAgents: run.completedAgents,
            ...(run.workflowToolUseId !== undefined ? { workflowToolUseId: run.workflowToolUseId } : {}),
            ...(run.failedAgents !== undefined ? { failedAgents: run.failedAgents } : {}),
            ...(run.blockedAgents !== undefined ? { blockedAgents: run.blockedAgents } : {}),
            ...(orphanAgents?.length ? { orphanAgents } : {}),
          };
        })
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
    observeTranscriptMessage(message, context) {
      const observation = observeTrackerValue(message, context);
      if (context?.historicalReplay !== true) {
        journalFollower?.observeTranscriptMessage(message);
      }
      return observation;
    },
    getWorkflowOwnedAgentToolUseIds() {
      return tracker.getWorkflowOwnedAgentToolUseIds();
    },
    reconcileStartupInterruptedRuns,
    finalizeInterruptedActivityOnShutdown() {
      const observation = tracker.finalizeInterruptedActivityOnShutdown({ updatedAt: Date.now() });
      if (observation.changedRunIds.length === 0) return;
      // The followers are drained by the `flush()` that follows and closed by `dispose()`; closing
      // them here would only move which mechanism delivers the same last lines, while letting a
      // post-verdict journal entry land after the resolution it is supposed to precede.
      coalesced.notify(observation);
    },
    async flush() {
      await journalFollower?.syncAll();
      await coalesced.flush();
      await providerTaskActivityTail;
    },
    dispose() {
      if (startupReconcileTimer !== null) {
        clearTimeout(startupReconcileTimer);
        startupReconcileTimer = null;
      }
      journalFollower?.dispose();
      coalesced.dispose();
    },
  };
}
