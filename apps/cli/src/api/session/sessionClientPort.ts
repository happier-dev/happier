import type { RpcHandlerManagerLike } from '@/api/rpc/types';
import type { QuestionSessionSnapshot } from '@/agent/permissions/sessionQuestionManager';
import type { ACPMessageData, ACPProvider, SessionEventMessage } from './sessionMessageTypes';
import type { AgentState, Metadata, UserMessage } from '../types';
import type {
  LegacyHostSessionSystemRecord as SessionSystemRecord,
  LegacyHostSessionSystemRecordUpsertRequest as SessionSystemRecordUpsertRequest,
  SessionTurnMutationV1,
  SessionPermissionMediationRecordIdentityV1,
  SessionPermissionMediationRecordListQuery,
  SessionPermissionMediationRecordPruneRequest,
  SessionPermissionMediationRecordStored,
  SessionPermissionMediationRecordWriteRequest,
} from '@happier-dev/protocol';
import type { CommittedTranscriptMessageOptions, CommittedTranscriptUserMessageOptions } from './transcriptPort';
import type {
  SessionStoredContentCryptoContext,
} from '@/session/transport/encryption/sessionEncryptionContext';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import type { PendingQueueState } from './pendingQueueState';
import type { RegisteredSessionStateFieldMutationV1 } from './client/transport/mutations/sessionClientDurableMutationTypes';
import type { RuntimeActivitySnapshotTail } from './client/transport/mutations/createSessionClientDurableMutationOutbox';
import type {
  PendingMaterializationDeliveryState,
  PendingMaterializationDeliveryTiming,
} from './pendingQueueV2Transport';
import type { CommittedUserMessageSeqListener } from './committedUserMessageSeqTracker';
import type { CommittedTranscriptLocalIdBaseline } from './client/transcript/committedTranscriptLocalIdBaseline';
import type { SessionActivityChangedResult } from '@/daemon/sessions/sessionActivityChangedContract';

/** Source-local notification continuation; the outbox still owns commit and cancellation. */
export type SessionPersonalFollowCommit = Readonly<{ localId: string; committedSequence: number;
  personalFollow?: SessionActivityChangedResult['personalFollow'] }>;

export type SessionProviderInputConsumer = ((message: UserMessage) => boolean | void) & Readonly<{
  /** Must read the live queue: collected/dispatched inputs are not retained context. */
  readRetainedContextLocalIds?: () => readonly string[];
}>;

export type MaterializeNextPendingResult =
  | {
      type: 'materialized';
      localId: string;
      seq: number | null;
      content: unknown;
      createdAt?: number;
      updatedAt?: number;
      deliveryState?: PendingMaterializationDeliveryState;
    }
  | { type: 'no_pending' }
  | { type: 'retryable_transport'; retryAfterMs?: number }
  | { type: 'unsupported'; code: 'session_input_target_update_required' }
  | { type: 'auth_failure' }
  | { type: 'deferred'; reason: 'supervisor_offline' | 'supervisor_auth_failed' | 'runtime_activity_active' | 'runtime_activity_unknown' | 'waiting_for_quota_reset' };

export type PendingMaterializationDiagnosticPhase =
  | 'materialize.pending_snapshot'
  | 'materialize.turn_status'
  | 'materialize.server_claim'
  | 'materialize.compatibility_transcript_lookup'
  | 'materialize.input_admission';

export type MaterializeNextPendingOptions = {
  reconcileWhenEmpty?: 'force' | 'throttled' | 'skip';
  deliveryTiming?: PendingMaterializationDeliveryTiming;
  expectedRuntimeActivityRevision?: number;
  onDiagnosticPhase?: (phase: PendingMaterializationDiagnosticPhase) => void;
};

export type { RuntimeActivitySnapshotTail } from './client/transport/mutations/createSessionClientDurableMutationOutbox';

export type LocallyConsumedUserMessageConfirmation = Readonly<{
  localIds?: readonly string[] | null;
  userMessageSeq?: number | null;
  userMessageSeqs?: readonly number[] | null;
}>;

export type UserMessageLocalConsumptionQuery = Readonly<{
  localIds?: readonly string[] | null;
  userMessageSeq?: number | null;
  userMessageSeqs?: readonly number[] | null;
}>;

export interface SessionClientPort {
  sessionId: string;
  rpcHandlerManager: RpcHandlerManagerLike;
  readQuestionSessionSnapshot?(sessionId: string): Promise<QuestionSessionSnapshot | null>;
  yieldQuestionTurn?(sourceTurnId: string): Promise<boolean>;
  readQuestionWaitTurnId?(): string | null;
  clearQuestionWaitTurn?(sourceTurnIds?: readonly string[]): void | Promise<void>;

  enqueueSessionEventCommitted?(
    event: SessionEventMessage,
    id?: string,
  ): Promise<Readonly<{ persisted: boolean; delivered: boolean; localId?: string; committedSequence?: number;
    personalFollow?: SessionActivityChangedResult['personalFollow']; whenCommitted?: Promise<SessionPersonalFollowCommit | null> }>>;
  enqueueUserTextMessageCommitted?(
    text: string,
    opts: CommittedTranscriptUserMessageOptions,
  ): Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
  enqueueAgentMessageCommitted?(
    provider: ACPProvider,
    body: ACPMessageData,
    opts: CommittedTranscriptMessageOptions,
  ): Promise<Readonly<{ persisted: boolean; delivered: boolean; committedSequence?: number;
    personalFollow?: SessionActivityChangedResult['personalFollow']; whenCommitted?: Promise<SessionPersonalFollowCommit | null> }>>;
  fetchCommittedTranscriptLocalIdBaseline?(
    opts?: {
      signal?: AbortSignal;
      deadlineAtMs?: number;
    },
  ): Promise<CommittedTranscriptLocalIdBaseline>;

  updateMetadata(updater: (metadata: Metadata) => Metadata): void | Promise<void>;
  updateAgentStateRequestSettlement(updater: (state: AgentState) => AgentState): Promise<void>;
  updateAgentState(updater: (state: AgentState) => AgentState): void | Promise<void>;
  /** Runtime-owned availability of the incumbent rich Activity alert sender. */
  setOwnerActivityDelivery?(delivery: 'rich_sender' | 'home_required'): void;
  updateRuntimeActivityProjection?(projection: Readonly<{
    runtimeActivityState: 'active' | 'idle' | 'unknown';
    runtimeActivityActiveCount: number;
  }>): Promise<void>;
  upsertSessionSystemRecord?(request: SessionSystemRecordUpsertRequest): Promise<void>;
  fetchSessionSystemRecord?(params: Readonly<{
    namespace: SessionSystemRecord['namespace'];
    localId: string;
  }>): Promise<SessionSystemRecord | null>;
  readPermissionMediationRecord?(params: Readonly<{
    identity: SessionPermissionMediationRecordIdentityV1;
    signal?: AbortSignal;
  }>): Promise<SessionPermissionMediationRecordStored | null>;
  writePermissionMediationRecord?(params: Readonly<{
    identity: SessionPermissionMediationRecordIdentityV1;
    request: SessionPermissionMediationRecordWriteRequest;
    signal?: AbortSignal;
  }>): Promise<SessionPermissionMediationRecordStored>;
  prunePermissionMediationRecord?(params: Readonly<{
    identity: SessionPermissionMediationRecordIdentityV1;
    request: SessionPermissionMediationRecordPruneRequest;
    signal?: AbortSignal;
  }>): Promise<void>;
  listPermissionMediationRecords?(params?: Readonly<{
    query?: SessionPermissionMediationRecordListQuery;
    signal?: AbortSignal;
  }>): Promise<Readonly<{
    records: readonly SessionPermissionMediationRecordStored[];
    nextCursor: string | null;
    hasNext: boolean;
  }>>;
  getStoredContentEncryptionContext?(): Readonly<{
    mode: SessionStoredContentCryptoContext['mode'];
    ctx?: SessionStoredContentCryptoContext['ctx'];
  }>;
  getAuthenticatedAccountId?(): Promise<string | null>;
  enqueueSessionTurnMutation?(mutation: SessionTurnMutationV1): void | Promise<void>;
  enqueueRegisteredSessionStateFieldMutation?(mutation: RegisteredSessionStateFieldMutationV1): void | Promise<void>;
  setSessionRuntimeControls?(controls: SessionRuntimeControls | null): void;

  keepAlive(thinking: boolean, mode: 'local' | 'remote'): void;

  getMetadataSnapshot(): Metadata | null;
  getPendingMessageEditHoldIds?(): readonly string[] | null;
  getCommittedUserMessageSeq?(localId: string): number | null;
  subscribeCommittedUserMessageSeq?(listener: CommittedUserMessageSeqListener): () => void;
  subscribePendingProviderInputRetirement?(listener: (localId: string) => void): () => void;
  hasUserMessageLocalConsumption?(query: UserMessageLocalConsumptionQuery): boolean;
  confirmUserMessageLocallyConsumed?(confirmation: LocallyConsumedUserMessageConfirmation): void;
  waitForMetadataUpdate(abortSignal?: AbortSignal): Promise<boolean>;
  readRuntimeActivitySnapshotTail?(): RuntimeActivitySnapshotTail;
  waitForRuntimeActivitySnapshotTailChange?(
    sequence: number,
    abortSignal?: AbortSignal,
  ): Promise<boolean>;
  materializeNextPendingMessageSafely?(opts?: MaterializeNextPendingOptions): Promise<MaterializeNextPendingResult>;
  wakePendingMaterialization?(): void;
  popPendingMessage(): Promise<boolean>;
  shouldAttemptPendingMaterialization(): boolean;
  getPendingQueueState?(): PendingQueueState;
  reconcilePendingQueueState?(opts?: { force?: boolean }): Promise<boolean>;

  peekPendingMessageQueueV2Count(): Promise<number>;
  discardPendingMessageQueueV2All(opts: { reason: 'switch_to_local' | 'manual' }): Promise<number>;
  discardCommittedMessageLocalIds(opts: { localIds: string[]; reason: 'switch_to_local' | 'manual' }): Promise<number>;

  flush(): Promise<void>;
  close(): Promise<void>;

  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
}
