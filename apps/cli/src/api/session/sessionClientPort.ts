import type { RpcHandlerManagerLike } from '@/api/rpc/types';
import type { RawJSONLines } from '@/backends/claude/types';
import type { ACPMessageData, ACPProvider, SessionEventMessage } from './sessionMessageTypes';
import type { AgentState, Metadata } from '../types';
import type { TurnAssistantTextSnapshot } from './turnAssistantTextSnapshot';
import type { CommittedUserMessageSeqWaitOptions } from './committedUserMessageSeqTracker';
import type { SessionTurnLifecycleController } from '@/agent/runtime/session/turn/types';
import type { PendingQueueReadOptions, PendingQueueReconcileWhenEmpty } from './pendingQueueReadPolicy';
import type { PendingForegroundSteerability } from './pendingForegroundSteerability';
import type { ProviderOwnedUserMessageEchoClassifier } from './providerOwnedUserMessageEcho';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import type {
  SessionRuntimeActivitySnapshotPublisher,
} from '@/session/runtimeActivity/types';
import type {
  SessionEncryptionContext,
  SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import type {
  PendingMaterializationDeliveryState,
  PendingQueueDeliveryBlockedReason,
} from './pendingQueueV2Transport';
import type {
  PendingProviderAction,
  SessionTranscriptObservationProvenanceV1,
  SessionPendingQueueDeliveryTiming,
  SessionSystemRecord,
  SessionSystemRecordKind,
  SessionSystemRecordNamespace,
  SessionSystemRecordUpsertRequest,
} from '@happier-dev/protocol';
import type { EphemeralSendResult } from './ephemeralSendOutcome';
import type { RuntimeActivitySnapshotTail } from './mutations/createSessionMutationOutbox';

export type MaterializeNextPendingResult =
  | {
    type: 'materialized';
    localId: string;
    seq: number | null;
    content: unknown | null;
    createdAt?: number;
    updatedAt?: number;
    deliveryState?: PendingMaterializationDeliveryState;
  }
  | { type: 'no_pending' }
  | { type: 'retryable_transport'; retryAfterMs?: number }
  | { type: 'auth_failure'; statusCode: 401 | 403 }
  | {
    type: 'deferred';
    reason: 'supervisor_offline' | 'supervisor_auth_failed' | 'waiting_for_runtime_activity' | 'runtime_activity_unknown' | 'pending_version_mismatch' | 'waiting_for_predecessor' | 'waiting_for_foreground_turn' | 'local_input_queued' | 'request_auth_source_cutover';
    retryAfterMs?: number;
  };

export type SessionUserMessageDeliveryInfo = Readonly<{
  seq: number | null;
  providerAcceptancePending?: boolean | undefined;
  pendingProviderAction?: PendingProviderAction | undefined;
}>;

export interface SessionClientPort {
  sessionId: string;
  rpcHandlerManager: RpcHandlerManagerLike;

  /** Synchronously reject new provider input before runner termination cleanup begins. */
  beginRuntimeTermination?(): void;
  /** Read the canonical runner-termination fence without inferring intent from child exit codes. */
  hasRuntimeTerminationStarted?(): boolean;

  sendSessionEvent(event: SessionEventMessage, id?: string): void;
  sendClaudeSessionMessage(message: RawJSONLines, meta?: Record<string, unknown>): void;
  sendClaudeSessionMessageCommitted?(
    message: RawJSONLines,
    opts: Readonly<{
      createdAt: number;
      updatedAt?: number;
      provenance: SessionTranscriptObservationProvenanceV1;
      meta?: Record<string, unknown>;
    }>,
  ): Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
  recordClaudeJsonlMessageConsumed?(message: RawJSONLines, meta?: Record<string, unknown>): void;
  setSessionRuntimeControls?(controls: SessionRuntimeControls | null): void;
  registerSessionRuntimeControls?(controls: Partial<SessionRuntimeControls> | null): () => void;
  wakePendingMaterialization?(): void;
  setProviderOwnedUserMessageEchoClassifier?(classifier: ProviderOwnedUserMessageEchoClassifier | null): void;
  hasActiveCanonicalTurn?(): boolean;
  fetchCommittedClaudeJsonlMessageBaseline?(opts?: { take?: number }): Promise<import('@/backends/claude/utils/claudeJsonlMessageKey').CommittedClaudeJsonlMessageBaseline>;
  fetchRecentTranscriptTextItemsForAcpImport?(opts?: { take?: number }): Promise<Array<{ role: 'user' | 'agent'; text: string }>>;
  sendAgentMessage(provider: ACPProvider, body: ACPMessageData, opts?: { localId?: string; meta?: Record<string, unknown> }): void;
  sendAgentMessageCommitted(provider: ACPProvider, body: ACPMessageData, opts: { localId: string; meta?: Record<string, unknown> }): Promise<void>;
  sendAgentMessageEphemeral?(
    provider: ACPProvider,
    body: ACPMessageData,
    opts: { localId: string; createdAt: number; updatedAt?: number; meta?: Record<string, unknown>; tick?: number },
  ): EphemeralSendResult;
  sendAgentMessageEphemeralDelta?(
    provider: ACPProvider,
    body: ACPMessageData,
    opts: { localId: string; tick: number; baseLength: number; createdAt: number; updatedAt?: number; meta?: Record<string, unknown> },
  ): EphemeralSendResult;
  getEphemeralStreamConnectionEpoch?(): number;

  updateMetadata(updater: (metadata: Metadata) => Metadata): void | Promise<void>;
  updateAgentState(updater: (state: AgentState) => AgentState): void | Promise<void>;
  /** Phase-5 transport seam; absent until a client owns a real journal-backed snapshot handle. */
  getRuntimeActivitySnapshotPublisher?(): SessionRuntimeActivitySnapshotPublisher | null;
  readRuntimeActivitySnapshotTail?(): RuntimeActivitySnapshotTail;
  waitForRuntimeActivitySnapshotTailChange?(sequence: number, signal?: AbortSignal): Promise<boolean>;
  upsertSessionSystemRecord?(request: SessionSystemRecordUpsertRequest): Promise<void>;
  fetchSessionSystemRecord?(params: Readonly<{
    namespace: SessionSystemRecordNamespace;
    localId: string;
  }>): Promise<SessionSystemRecord | null>;
  fetchSessionSystemRecordsPage?(params: Readonly<{
    namespace: SessionSystemRecordNamespace;
    kind: SessionSystemRecordKind;
    cursor?: string;
  }>): Promise<Readonly<{
    records: SessionSystemRecord[];
    nextCursor: string | null;
    hasNext: boolean;
  }>>;
  getStoredContentEncryptionContext?(): Readonly<{
    mode: SessionStoredContentEncryptionMode;
    ctx?: SessionEncryptionContext;
  }>;
  getAgentStateSnapshot?(): AgentState | null;
  sessionTurnLifecycle?: SessionTurnLifecycleController;

  keepAlive(thinking: boolean, mode: 'local' | 'remote'): void;

  getMetadataSnapshot(): Metadata | null;
  hasPendingProviderInputAcceptance?(localId: string): boolean;
  hasCanonicalPendingProviderInputDelivery?(localId: string): boolean;
  blockPendingMessageDelivery?(params: Readonly<{
    localIds: readonly string[] | null | undefined;
    reason: PendingQueueDeliveryBlockedReason;
  }>): Promise<boolean>;
  getLastObservedMessageSeq?(): number;
  getCommittedUserMessageSeq?(localId: string): number | null;
  waitForCommittedUserMessageSeq?(
    localId: string,
    options?: CommittedUserMessageSeqWaitOptions,
  ): Promise<number | null>;
  beginTurnAssistantTextSnapshot?(params?: { turnToken?: string; startSeqExclusive?: number | null }): string;
  getTurnAssistantTextSnapshot?(params: {
    turnToken?: string | null;
    startSeqExclusive?: number | null;
  }): TurnAssistantTextSnapshot | null;
  waitForMetadataUpdate(abortSignal?: AbortSignal): Promise<boolean>;
  waitForPendingEligibilityUpdate(abortSignal?: AbortSignal): Promise<boolean>;
  shouldAttemptPendingMaterialization?(opts?: {
    activeTurnSteerability?: PendingForegroundSteerability;
    pendingQueueDeliveryTiming?: SessionPendingQueueDeliveryTiming;
  }): boolean;
  /**
   * True when the canonical pending queue holds rows but every one is blocked (undeliverable).
   * Such work can never advance the session, so a completed turn must not defer its ready/push to
   * it. Optional so lightweight port stubs may omit it (callers treat absence as "not all blocked").
   */
  hasOnlyBlockedPendingWork?(): boolean;
  reconcilePendingQueueState?(opts?: { force?: boolean }): Promise<boolean>;
  materializeNextPendingMessageSafely?(opts?: {
    expectedPendingVersion?: number;
    expectedRuntimeActivityRevision?: number;
    reconcileWhenEmpty?: PendingQueueReconcileWhenEmpty;
    activeTurnSteerability?: PendingForegroundSteerability;
    pendingQueueDeliveryTiming?: SessionPendingQueueDeliveryTiming;
  }): Promise<MaterializeNextPendingResult>;
  popPendingMessage(): Promise<boolean>;

  peekPendingMessageQueueV2Count(opts?: PendingQueueReadOptions): Promise<number>;
  discardPendingMessageQueueV2All(opts: { reason: 'switch_to_local' | 'manual' }): Promise<number>;
  discardCommittedMessageLocalIds(opts: { localIds: string[]; reason: 'switch_to_local' | 'manual' }): Promise<number>;

  sendSessionDeath(): void;
  flush(): Promise<void>;
  close(): Promise<void>;

  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
}
