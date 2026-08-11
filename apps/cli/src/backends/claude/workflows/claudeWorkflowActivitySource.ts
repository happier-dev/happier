import {
  resolveStartupReconcileTargets,
  type WorkflowStartupReconcileCandidate,
} from './workflowActivityStartupReconcile';
import {
  type SessionWorkflowRunSnapshotV1,
} from '@happier-dev/protocol';

import {
  createCoalescedWorkflowActivityPublisher,
} from '@/session/systemRecords/activity/coalescedWorkflowActivityPublisher';
import {
  createWorkflowActivityPublisher,
  type SessionActivityHeadlineBundle,
} from '@/session/systemRecords/activity/publishWorkflowActivitySnapshot';
import { logger } from '@/ui/logger';

import type { BackgroundTaskRecordPublisher } from '../providerActivity/backgroundTaskRecordPublisher';
import {
  normalizeClaudeProviderTaskEvent,
  type ClaudeProviderTaskActivity,
} from '../providerActivity/createClaudeProviderActivityLedger';
import { createClaudeWorkflowActivityTracker } from './claudeWorkflowActivityTracker';
import {
  createClaudeWorkflowJournalFollower,
  type ClaudeWorkflowAgentTranscriptRegistration,
  type ClaudeWorkflowJournalFollower,
} from './claudeWorkflowJournalFollower';
import type { ClaudeWorkflowTaskReference } from './claudeWorkflowTaskReference';

/**
 * Centralized Claude Dynamic Workflow ACTIVITY source (CWF2/CWF3/CWF4).
 *
 * The ONE place that turns raw Claude transcript values into durable provider-agnostic workflow
 * activity. It mirrors `createClaudeGoalWorkStateSource`: every Claude launcher wires the SAME raw
 * transcript channel (`observeRaw`) here, so there is one normalizer observing one channel rather
 * than per-launcher routing.
 *
 * Pipeline:
 *   raw transcript value
 *     -> tracker.observe (CWF2: per-run Map, parent_tool_use_id routing, explicit-wins, phases[])
 *     -> coalesced publisher (CWF3: record-first/headline-second, per-run debounce + immediate flush)
 *
 * Boundary functions (`commitRecord`/`writeHeadlines`) are injected so this source stays Claude-clean
 * and unit-testable; the launcher/projector binds them to the session's credentials/encryption mode
 * + the metadata best-effort writer.
 */
export type ClaudeWorkflowActivitySource = Readonly<{
  /** Observe one raw transcript value (same raw channel as the goal source). Non-workflow noise is ignored. */
  observeTranscriptMessage(
    message: unknown,
    observation?: Readonly<{ historicalReplay?: boolean }>,
  ): void;
  /** Workflow-owned subagent/agent tool-use ids — the CWF4 hook to suppress duplicate work-state rows. */
  getWorkflowOwnedAgentToolUseIds(): ReadonlySet<string>;
  /** True when the native provider task id is owned by Dynamic Workflow. */
  isWorkflowOwnedProviderTaskId(taskId: string): boolean;
  /** True when a task-notification task/tool reference is owned by Dynamic Workflow. */
  isWorkflowOwnedTaskReference(reference: ClaudeWorkflowTaskReference): boolean;
  /**
   * Resolve every non-terminal run and agent because the process that owned them is going away
   * (RULING-14). Call it from an OBSERVED death — graceful teardown — immediately before `flush()`,
   * so the resolved state reaches the durable record. Never call it on a timer or on turn failure.
   */
  finalizeInterruptedActivityOnShutdown(): void;
  /** Drain pending writes immediately (terminal flush / stream close / session finalization). */
  flush(): Promise<void>;
  reconcileStartupInterruptedRuns(candidates: readonly WorkflowStartupReconcileCandidate[]): Promise<void>;
  /** Stop scheduling. */
  dispose(): void;
}>;

export function createClaudeWorkflowActivitySource(params: Readonly<{
  backendId: string;
  agentId?: string;
  /** The Claude transcript session id guard (NOT the Happier session id). Null until learned. */
  getCurrentClaudeSessionId: () => string | null;
  /** Durable per-run record write bound to the session's credentials + encryption mode/ctx. */
  commitRecord: (snapshot: SessionWorkflowRunSnapshotV1) => Promise<void>;
  /** Durable readback used to continue record revisions across source restarts. */
  readCommittedRunSnapshot?: (runId: string) => Promise<SessionWorkflowRunSnapshotV1 | null>;
  /**
   * Single best-effort metadata write carrying BOTH activity headline keys (rides the normal
   * session metadata path). One write, so the two keys can never describe different worlds.
   */
  writeHeadlines: (bundle: SessionActivityHeadlineBundle) => Promise<void> | void;
  /** Exact live provider-task facts consumed by Claude's single Runtime Activity adapter. */
  onProviderTaskActivity?: (activity: ClaudeProviderTaskActivity) => Promise<void> | void;
  /**
   * Durable `activity/background_task.v1` publisher (PLAN 4.9, R-9).
   *
   * It is fed from HERE and not from one runner, because this source is already the single place
   * every runner delivers the Claude task lifecycle to: the agent-SDK and legacy runners route
   * `task_started`/`task_progress`/`task_notification` in through `routeClaudeSdkMessageToWorkflowSource`,
   * and the unified-terminal runner feeds the same channel from `onRawTranscriptValue`. Attaching
   * the publisher to one runner's message loop would silently omit the others.
   */
  backgroundTaskRecordPublisher?: BackgroundTaskRecordPublisher | null;
  /**
   * Hand a workflow agent's sidecar transcript to the session's sidechain importer.
   *
   * The importer is owned by the launcher (it is the same one that imports `Task` sub-agent
   * transcripts), so it is injected rather than constructed here. Absent when the composition has no
   * importer; the run then keeps its naming and its agents simply have no transcript to open.
   */
  registerWorkflowAgentTranscript?: (
    registration: ClaudeWorkflowAgentTranscriptRegistration,
  ) => void | Promise<void>;
  debounceMs?: number;
  logPrefix?: string;
}>): ClaudeWorkflowActivitySource {
  const logPrefix = params.logPrefix ?? '[claude-workflow-source]';

  const tracker = createClaudeWorkflowActivityTracker({
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    getCurrentClaudeSessionId: params.getCurrentClaudeSessionId,
  });

  const publisher = createWorkflowActivityPublisher({
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.readCommittedRunSnapshot
      ? { readCommittedRunSnapshot: params.readCommittedRunSnapshot }
      : {}),
    commitRecord: async (snapshot) => {
      await params.commitRecord(snapshot);
    },
    writeHeadlines: params.writeHeadlines,
    onError: (error, ctx) => {
      logger.debug(`${logPrefix}: durable workflow record write failed for run ${ctx.runId} (will retry)`, error);
    },
  });

  const coalesced = createCoalescedWorkflowActivityPublisher({
    publisher,
    getSnapshots: () => tracker.getRunSnapshotMap(),
    ...(params.debounceMs !== undefined ? { debounceMs: params.debounceMs } : {}),
    onError: (error) => {
      logger.debug(`${logPrefix}: workflow activity publish drain failed (non-fatal)`, error);
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
          logger.debug(`${logPrefix}: exact workflow provider-task activity failed (non-fatal)`, error);
        }
      };
      providerTaskActivityTail = providerTaskActivityTail.then(publish, publish);
    }
  };

  const reconcileStartupInterruptedRuns = async (
    candidates: readonly WorkflowStartupReconcileCandidate[],
  ): Promise<void> => {
    const observedRunIds = tracker.getLiveObservedRunIds();
    const targets = resolveStartupReconcileTargets(candidates, observedRunIds);
    if (targets.length === 0) return;
    const updatedAt = Date.now();
    for (const target of targets) {
      const observation = tracker.reconcileInterruptedRunFromHeadline(target, { updatedAt });
      if (observation.changedRunIds.length === 0) continue;
      logger.debug(`${logPrefix}: reconciling interrupted workflow run ${target.runId} (stopped/interrupted)`);
      coalesced.notify(observation);
    }
    await coalesced.flush();
  };

  const observeTrackerValue = (
    message: unknown,
    observationContext?: Readonly<{ historicalReplay?: boolean }>,
  ): void => {
    const observation = tracker.observe(message, {
      updatedAt: Date.now(),
      live: observationContext?.historicalReplay !== true,
    });
    if (observationContext?.historicalReplay !== true) {
      publishProviderTaskActivities(observation.providerTaskActivities);
      // Durable projection of the same typed row. Replay is excluded for the same reason liveness
      // excludes it: a re-read transcript is not new evidence, and re-publishing would rewrite a
      // settled record with a fresh observation stamp.
      if (params.backgroundTaskRecordPublisher) {
        const backgroundTask = normalizeClaudeProviderTaskEvent(message).backgroundTask;
        if (backgroundTask) params.backgroundTaskRecordPublisher.observe(backgroundTask);
      }
    }
    if (observation.changedRunIds.length === 0) return;
    if (observationContext?.historicalReplay === true) return;
    for (const runId of observation.terminalRunIds) {
      journalFollower?.markRunCompleted(runId);
    }
    coalesced.notify(observation);
  };

  journalFollower = createClaudeWorkflowJournalFollower({
    logPrefix,
    onJournalValue: observeTrackerValue,
    ...(params.registerWorkflowAgentTranscript
      ? { registerAgentTranscript: params.registerWorkflowAgentTranscript }
      : {}),
  });

  return {
    observeTranscriptMessage(message, observationContext) {
      observeTrackerValue(message, observationContext);
      if (observationContext?.historicalReplay !== true) {
        journalFollower.observeTranscriptMessage(message);
      }
    },
    getWorkflowOwnedAgentToolUseIds() {
      return tracker.getWorkflowOwnedAgentToolUseIds();
    },
    isWorkflowOwnedProviderTaskId(taskId) {
      return tracker.isWorkflowOwnedProviderTaskId(taskId);
    },
    isWorkflowOwnedTaskReference(reference) {
      return tracker.isWorkflowOwnedTaskReference(reference);
    },
    finalizeInterruptedActivityOnShutdown() {
      const observation = tracker.finalizeInterruptedActivityOnShutdown({ updatedAt: Date.now() });
      if (observation.changedRunIds.length === 0) return;
      logger.debug(`${logPrefix}: resolving ${observation.changedRunIds.length} interrupted workflow run(s) on shutdown`);
      coalesced.notify(observation);
    },
    async flush() {
      await journalFollower?.syncAll();
      await coalesced.flush();
      await params.backgroundTaskRecordPublisher?.flush();
      await providerTaskActivityTail;
    },
    reconcileStartupInterruptedRuns,
    dispose() {
      journalFollower?.dispose();
      coalesced.dispose();
      params.backgroundTaskRecordPublisher?.dispose();
    },
  };
}
