import {
  SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY,
  SessionWorkflowActivityHeadlineV1Schema,
  type SessionWorkflowRunSnapshotV1,
  type SessionSystemRecord,
  type SessionSystemRecordNamespace,
  type SessionSystemRecordUpsertRequest,
} from '@happier-dev/protocol';

import type { Metadata } from '@/api/types';
import { updateMetadataBestEffort } from '@/api/session/sessionWritesBestEffort';
import {
  ACTIVITY_SYSTEM_RECORD_NAMESPACE,
  buildWorkflowRunSystemRecordLocalId,
  openWorkflowRunSystemRecordPayload,
} from '@/session/systemRecords/activity/activitySystemRecords';
import {
  commitBackgroundTaskActivitySystemRecord,
  commitWorkflowActivitySystemRecord,
} from '@/session/systemRecords/activity/commitWorkflowActivitySystemRecords';
import type {
  SessionEncryptionContext,
  SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { logger } from '@/ui/logger';
import type { SessionActivityHeadlineBundle } from '@/session/systemRecords/activity/publishWorkflowActivitySnapshot';
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
export type ClaudeWorkflowActivitySessionBinding = Readonly<{
  /** Happier session id (record route path + metadata target). */
  sessionId: string;
  /** Best-effort metadata writer target (the session client). */
  metadataWriter: Readonly<{
    updateMetadata: (updater: (metadata: Metadata) => Metadata) => Promise<void> | void;
    getMetadataSnapshot?: () => Metadata | null;
  }>;
  /** Durable system-record writer target (the session client). */
  upsertSystemRecord: (request: SessionSystemRecordUpsertRequest) => Promise<void>;
  /** Durable system-record reader target (the session client), used to seed publisher revisions. */
  fetchSystemRecord?: (params: Readonly<{
    namespace: SessionSystemRecordNamespace;
    localId: string;
  }>) => Promise<SessionSystemRecord | null>;
  /** Lazily resolve the session's stored-content encryption mode + context for record sealing. */
  resolveEncryption: () => Promise<Readonly<{ mode: SessionStoredContentEncryptionMode; ctx?: SessionEncryptionContext }>>;
  /** The Claude transcript session id guard (NOT the Happier session id). Null until learned. */
  getCurrentClaudeSessionId: () => string | null;
}>;

export type WiredClaudeWorkflowActivitySource = ClaudeWorkflowActivitySource & Readonly<{
  /** Start the one-shot startup-absence grace window after the live observer is installed. */
  armStartupReconciliation(): void;
}>;

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

  // Memoize the encryption resolution. `binding.resolveEncryption` may perform a session fetch to
  // open the data-encryption key; CWF3 requires bounded writes, so it must run AT MOST ONCE for the
  // session's lifetime — never per `commitRecord` (which fires on every changed run). The session's
  // stored-content encryption mode/ctx are stable for the session, so caching the first resolution
  // (including its in-flight promise) keeps record writes from amplifying into N session fetches.
  let encryptionResolution: ReturnType<ClaudeWorkflowActivitySessionBinding['resolveEncryption']> | null = null;
  const resolveEncryptionOnce = (): ReturnType<ClaudeWorkflowActivitySessionBinding['resolveEncryption']> => {
    if (!encryptionResolution) {
      encryptionResolution = Promise.resolve(binding.resolveEncryption()).catch((error) => {
        // Allow a later commit to retry if the first resolution failed (e.g. transient session fetch).
        encryptionResolution = null;
        throw error;
      });
    }
    return encryptionResolution;
  };

  const commitRecord = async (snapshot: SessionWorkflowRunSnapshotV1): Promise<void> => {
    const { mode, ctx } = await resolveEncryptionOnce();
    await commitWorkflowActivitySystemRecord({
      sessionId: binding.sessionId,
      mode,
      ...(ctx ? { ctx } : {}),
      snapshot,
      upsertSystemRecord: binding.upsertSystemRecord,
    });
  };

  // Durable background-task records ride the SAME session binding and the same encryption
  // resolution as workflow records: one credential path, one seal policy, one commit owner.
  const backgroundTaskRecordPublisher = createBackgroundTaskRecordPublisher({
    commitRecord: async (record) => {
      const { mode, ctx } = await resolveEncryptionOnce();
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

  const readCommittedRunSnapshot = binding.fetchSystemRecord
    ? async (runId: string): Promise<SessionWorkflowRunSnapshotV1 | null> => {
      const record = await binding.fetchSystemRecord?.({
        namespace: ACTIVITY_SYSTEM_RECORD_NAMESPACE,
        localId: buildWorkflowRunSystemRecordLocalId({ runId }),
      });
      if (!record || record.namespace !== ACTIVITY_SYSTEM_RECORD_NAMESPACE) return null;
      const { ctx } = await resolveEncryptionOnce();
      return openWorkflowRunSystemRecordPayload({
        namespace: record.namespace,
        content: record.content,
        ...(ctx ? { ctx } : {}),
      });
    }
    : undefined;

  const writeHeadlines = async (bundle: SessionActivityHeadlineBundle): Promise<void> => {
    await binding.metadataWriter.updateMetadata(
      (metadata) => ({
        ...metadata,
        sessionWorkflowActivityHeadlineV1: bundle.workflow,
        [SESSION_AGENT_ACTIVITY_HEADLINE_METADATA_KEY]: bundle.agentActivity,
      }),
    );
  };

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
    commitRecord,
    ...(readCommittedRunSnapshot ? { readCommittedRunSnapshot } : {}),
    writeHeadlines,
    backgroundTaskRecordPublisher,
    ...(params.onProviderTaskActivity
      ? { onProviderTaskActivity: params.onProviderTaskActivity }
      : {}),
    ...(params.registerWorkflowAgentTranscript
      ? { registerWorkflowAgentTranscript: params.registerWorkflowAgentTranscript }
      : {}),
    ...(params.debounceMs !== undefined ? { debounceMs: params.debounceMs } : {}),
    ...(params.logPrefix ? { logPrefix: params.logPrefix } : {}),
  });

  const parsedHeadline = SessionWorkflowActivityHeadlineV1Schema.safeParse(
    startupMetadata?.sessionWorkflowActivityHeadlineV1,
  );
  const reconcileCandidates = parsedHeadline.success
    ? collectStartupReconcileCandidates(parsedHeadline.data)
    : [];
  const graceMs = params.startupReconcileGraceMs ?? WORKFLOW_ACTIVITY_STARTUP_RECONCILE_GRACE_MS;
  let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  let reconciliationArmed = false;
  let disposed = false;

  return {
    ...source,
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
