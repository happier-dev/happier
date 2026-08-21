import {
  readSessionAgentActivityHeadlineFromMetadata,
  SessionWorkflowActivityHeadlineV1Schema,
} from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import { commitBackgroundTaskActivitySystemRecord } from '@/session/systemRecords/activity/commitWorkflowActivitySystemRecords';
import { logger } from '@/ui/logger';
import {
  createSessionWorkflowActivityTransport,
  type SessionWorkflowActivityBinding,
} from '@/session/systemRecords/activity/sessionWorkflowActivityTransport';
import { createBackgroundTaskRecordPublisher } from '../providerActivity/backgroundTaskRecordPublisher';
import type { ClaudeProviderTaskActivity } from '../providerActivity/createClaudeProviderActivityLedger';
import type { ClaudeWorkflowAgentTranscriptRegistration } from './claudeWorkflowJournalFollower';

import {
  createClaudeWorkflowActivitySource,
  type ClaudeWorkflowActivitySource,
} from './claudeWorkflowActivitySource';
import {
  hasLegacyClaudeAsyncAgentWorkflowGhosts,
  pruneLegacyClaudeAsyncAgentWorkflowGhostsFromMetadata,
} from './legacyClaudeWorkflowActivityRepair';
import {
  WORKFLOW_ACTIVITY_STARTUP_RECONCILE_GRACE_MS,
  collectStartupReconcileCandidates,
} from './workflowActivityStartupReconcile';

/**
 * The single composition seam that binds the provider-clean `createClaudeWorkflowActivitySource`
 * factory to a live session's durable record + metadata transports (CWF3 wiring).
 *
 * Launchers/the projector call this ONE function and then feed `observeTranscriptMessage` from the
 * raw transcript channel (the same channel `observeRaw` already feeds the goal source). It resolves:
 * - `commitRecord` -> `commitWorkflowActivitySystemRecord` bound to the session token + encryption
 *   mode/ctx (encryption parity with memory records);
 * - `writeHeadlines` -> ONE awaited metadata update writing BOTH activity headline keys:
 *   `sessionWorkflowActivityHeadlineV1` (unchanged shape, still read by released clients and by
 *   `../dev`) and `sessionAgentActivityHeadlineV1` (the unified roster pointer). A single update
 *   keeps the keys consistent with each other and keeps metadata write traffic at one per drain.
 *   Rejections intentionally flow back to the coalesced publisher so a dropped write is retried.
 *
 * The encryption mode/ctx are resolved lazily per write via `resolveEncryption` so the wiring does
 * not need them at construction time (they may require a session fetch for the data-encryption key).
 */
export type ClaudeWorkflowActivitySessionBinding = SessionWorkflowActivityBinding & Readonly<{
  /** Happier session id (record route path + metadata target). */
  sessionId: string;
  /** Best-effort metadata writer target (the session client). */
  metadataWriter: Readonly<{
    updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
    getMetadataSnapshot?: () => Metadata | null;
  }>;
  /** The Claude transcript session id guard (NOT the Happier session id). Null until learned. */
  getCurrentClaudeSessionId: () => string | null;
}>;

export type WiredClaudeWorkflowActivitySource = ClaudeWorkflowActivitySource & Readonly<{
  /** Start the one-shot startup-absence grace window after the live observer is installed. */
  armStartupReconciliation(): void;
  /**
   * Resolve outstanding durable background-task records to `cancelled` — ORDERLY STOP ONLY.
   *
   * It lives on the WIRED source rather than inside `createClaudeWorkflowActivitySource` because
   * this seam is what constructs the background-task publisher and therefore owns its lifecycle;
   * the provider-clean source only forwards facts to it. Call it BEFORE the teardown's `flush()`,
   * so the resolved state is what gets drained.
   *
   * The caller must have OBSERVED the kill (see `finalizeOutstandingOnOrderlyStop` for why a crash
   * and a resume are both disqualifying). This seam cannot check that for itself, which is why the
   * only production caller is the explicit-stop teardown that destroyed the host.
   */
  finalizeBackgroundTaskRecordsOnOrderlyStop(): void;
}>;

/**
 * Say — once, at construction — whether the startup reconcile actually has anything to work with.
 *
 * The capture is ONE shot: `collectStartupReconcileCandidates` runs against the metadata snapshot
 * that exists at wiring time and is never retried, and `armStartupReconciliation` returns
 * immediately when it produced nothing. So an empty capture caused by MISSING EVIDENCE is not a 30
 * second delay, it is a permanent one — a run left `active` by the previous process stays `active`
 * until this session happens to publish again, and nothing anywhere says why.
 *
 * The two outcomes are reported at different levels because they are different facts:
 *
 * - **Fault** — no snapshot at all, or a headline value that will not parse. Rare, unrecoverable,
 *   and reported on a signal that is on by default. `logger.debug` would NOT be: a session process
 *   resolves its file log level to `info` (`resolveFileLogLevel`), so debug entries are opt-in via
 *   `DEBUG`/`HAPPIER_LOG_LEVEL` and this would be an unobserved fallback in production. The console
 *   line `warn` also writes is acceptable here and only here: wiring happens before the provider
 *   terminal UI starts, so it cannot land inside a running TUI.
 * - **Normal** — a readable snapshot with no non-terminal run. That is what a fresh session and a
 *   settled session both look like, i.e. almost every session; warning on it would bury the fault.
 */
function reportStartupReconcileCapture(params: Readonly<{
  logPrefix: string;
  hasMetadataSnapshot: boolean;
  hasHeadlineValue: boolean;
  headlineReadable: boolean;
  candidateCount: number;
}>): void {
  // A fault only matters when it actually cost us the capture. The roster half of the metadata can
  // still name agents a dead process left running when the workflow half is unreadable, and warning
  // that nothing was captured while candidates were in hand would report a failure that did not
  // happen.
  const fault = params.candidateCount > 0
    ? null
    : !params.hasMetadataSnapshot
      ? 'no session metadata snapshot at wiring time'
      : params.hasHeadlineValue && !params.headlineReadable
        ? 'the persisted workflow activity headline could not be read'
        : null;
  if (fault) {
    logger.warn(
      `${params.logPrefix}: startup workflow reconciliation captured no candidates (${fault}); a run left running by a previous process will not be resolved by this session`,
    );
    return;
  }
  logger.debug(
    `${params.logPrefix}: startup workflow reconciliation captured ${params.candidateCount} candidate(s)`,
  );
}

export function wireClaudeWorkflowActivitySource(params: Readonly<{
  backendId: string;
  agentId?: string;
  binding: ClaudeWorkflowActivitySessionBinding;
  debounceMs?: number;
  logPrefix?: string;
  startupReconcileGraceMs?: number;
  /** Exact live provider-task facts forwarded to Claude's single Runtime Activity adapter. */
  onProviderTaskActivity?: (activity: ClaudeProviderTaskActivity) => Promise<void> | void;
  /**
   * The provider ledger's session-ownership predicate, so the durable background-task path applies
   * the SAME identity rule as liveness admission (PLAN 4.9.1 step 2) from the one owner that knows
   * the session lineage.
   */
  isOwnedClaudeSessionId?: (sessionId: string) => boolean;
  /** Hand a workflow agent's sidecar transcript to the launcher's ONE sidechain importer. */
  registerWorkflowAgentTranscript?: (
    registration: ClaudeWorkflowAgentTranscriptRegistration,
  ) => void | Promise<void>;
}>): WiredClaudeWorkflowActivitySource {
  const { binding } = params;
  const activityTransport = createSessionWorkflowActivityTransport(binding);

  // Durable background-task records ride the SAME session binding and the same encryption
  // resolution as workflow records: one credential path, one seal policy, one commit owner.
  const backgroundTaskRecordPublisher = createBackgroundTaskRecordPublisher({
    commitRecord: async (record) => {
      const { mode, ctx } = await activityTransport.resolveEncryption();
      await commitBackgroundTaskActivitySystemRecord({
        mode,
        ...(ctx ? { ctx } : {}),
        record,
        upsertSystemRecord: binding.upsertSystemRecord,
      });
    },
    ...(params.isOwnedClaudeSessionId ? { isOwnedSessionId: params.isOwnedClaudeSessionId } : {}),
    ...(params.debounceMs !== undefined ? { debounceMs: params.debounceMs } : {}),
    onError: (error, context) => {
      logger.debug(
        `${params.logPrefix ?? '[claude-workflow-source]'}: durable background task record write failed for ${context.taskId} (${
          context.retryable ? 'will retry' : 'permanently rejected; record dropped'
        })`,
        error,
      );
    },
  });

  const currentMetadata = binding.metadataWriter.getMetadataSnapshot?.();
  const startupMetadata = currentMetadata && hasLegacyClaudeAsyncAgentWorkflowGhosts(currentMetadata)
    ? pruneLegacyClaudeAsyncAgentWorkflowGhostsFromMetadata(currentMetadata)
    : currentMetadata;
  if (startupMetadata !== currentMetadata) {
    updateMetadataBestEffort(
      binding.metadataWriter,
      (metadata) => pruneLegacyClaudeAsyncAgentWorkflowGhostsFromMetadata(metadata),
      params.logPrefix ?? '[claude-workflow-source]',
      'claude_workflow_legacy_agent_ghost_prune',
    );
  }

  const source = createClaudeWorkflowActivitySource({
    backendId: params.backendId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    getCurrentClaudeSessionId: binding.getCurrentClaudeSessionId,
    commitRecord: activityTransport.commitRecord,
    ...(activityTransport.readCommittedRunSnapshot
      ? { readCommittedRunSnapshot: activityTransport.readCommittedRunSnapshot }
      : {}),
    writeHeadlines: activityTransport.writeHeadlines,
    backgroundTaskRecordPublisher,
    ...(params.onProviderTaskActivity
      ? { onProviderTaskActivity: params.onProviderTaskActivity }
      : {}),
    // Forwarded UNWRAPPED, deliberately: the registrar is fail-closed and its rejection must reach
    // the journal follower's catch. See the fail-closed pin in
    // `createClaudeWorkflowActivitySourceForSession.test.ts`.
    ...(params.registerWorkflowAgentTranscript
      ? { registerWorkflowAgentTranscript: params.registerWorkflowAgentTranscript }
      : {}),
    ...(params.debounceMs !== undefined ? { debounceMs: params.debounceMs } : {}),
    ...(params.logPrefix ? { logPrefix: params.logPrefix } : {}),
  });

  const parsedHeadline = SessionWorkflowActivityHeadlineV1Schema.safeParse(
    startupMetadata?.sessionWorkflowActivityHeadlineV1,
  );
  // Read through the protocol owner rather than the raw key: the roster half of what the previous
  // process published is what names the agents it left running, and this build must tolerate an
  // entry a newer producer wrote instead of dropping the whole roster on one unparseable row.
  const startupAgentHeadline = readSessionAgentActivityHeadlineFromMetadata(startupMetadata);
  const reconcileCandidates = parsedHeadline.success || startupAgentHeadline
    ? collectStartupReconcileCandidates(
      parsedHeadline.success ? parsedHeadline.data : null,
      startupAgentHeadline,
    )
    : [];
  reportStartupReconcileCapture({
    logPrefix: params.logPrefix ?? '[claude-workflow-source]',
    hasMetadataSnapshot: currentMetadata != null,
    hasHeadlineValue: startupMetadata?.sessionWorkflowActivityHeadlineV1 !== undefined,
    headlineReadable: parsedHeadline.success,
    candidateCount: reconcileCandidates.length,
  });
  const graceMs = params.startupReconcileGraceMs ?? WORKFLOW_ACTIVITY_STARTUP_RECONCILE_GRACE_MS;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let reconciliationArmed = false;
  let disposed = false;

  return {
    ...source,
    finalizeBackgroundTaskRecordsOnOrderlyStop() {
      backgroundTaskRecordPublisher.finalizeOutstandingOnOrderlyStop();
    },
    armStartupReconciliation() {
      if (disposed || reconciliationArmed || reconcileCandidates.length === 0) return;
      reconciliationArmed = true;
      reconcileTimer = setTimeout(() => {
        reconcileTimer = null;
        void source.reconcileStartupInterruptedRuns(reconcileCandidates).catch((error) => {
          logger.debug(
            `${params.logPrefix ?? '[claude-workflow-source]'}: startup workflow reconciliation failed (non-fatal; will retry)`,
            error,
          );
        });
      }, graceMs);
      reconcileTimer.unref?.();
    },
    dispose() {
      disposed = true;
      if (reconcileTimer) {
        clearTimeout(reconcileTimer);
        reconcileTimer = null;
      }
      source.dispose();
    },
  };
}
