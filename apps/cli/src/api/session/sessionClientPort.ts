import type { RpcHandlerManagerLike } from '@/api/rpc/types';
import type { ACPMessageData, ACPProvider, SessionEventMessage } from './sessionMessageTypes';
import type { AgentState, Metadata } from '../types';
import type { ProviderTranscriptDispatchRequest } from './client/transcript/providerDispatch';
import type {
  SessionSystemRecord,
  SessionSystemRecordNamespace,
  SessionSystemRecordUpsertRequest,
  SessionTurnMutationV1,
  SessionTranscriptObservationProvenanceV1,
} from '@happier-dev/protocol';
import type {
  SessionEncryptionContext,
  SessionStoredContentEncryptionMode,
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
  | { type: 'retryable_transport' }
  | { type: 'auth_failure' }
  | { type: 'deferred'; reason: 'supervisor_offline' | 'supervisor_auth_failed' | 'runtime_activity_active' | 'runtime_activity_unknown' };

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

  sendSessionEvent(event: SessionEventMessage, id?: string): void;
  sendProviderMessage(request: ProviderTranscriptDispatchRequest): void;
  sendAgentMessage(provider: ACPProvider, body: ACPMessageData, opts?: { localId?: string; meta?: Record<string, unknown> }): void;
  enqueueAgentMessageCommitted?(
    provider: ACPProvider,
    body: ACPMessageData,
    opts: { localId: string; meta?: Record<string, unknown>; provenance: SessionTranscriptObservationProvenanceV1 },
  ): Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
  sendAgentMessageCommitted(provider: ACPProvider, body: ACPMessageData, opts: { localId: string; meta?: Record<string, unknown> }): Promise<void>;

  updateMetadata(updater: (metadata: Metadata) => Metadata): void | Promise<void>;
  updateAgentState(updater: (state: AgentState) => AgentState): void | Promise<void>;
  updateRuntimeActivityProjection?(projection: Readonly<{
    runtimeActivityState: 'active' | 'idle' | 'unknown';
    runtimeActivityActiveCount: number;
  }>): Promise<void>;
  upsertSessionSystemRecord?(request: SessionSystemRecordUpsertRequest): Promise<void>;
  fetchSessionSystemRecord?(params: Readonly<{
    namespace: SessionSystemRecordNamespace;
    localId: string;
  }>): Promise<SessionSystemRecord | null>;
  getStoredContentEncryptionContext?(): Readonly<{
    mode: SessionStoredContentEncryptionMode;
    ctx?: SessionEncryptionContext;
  }>;
  enqueueSessionTurnMutation?(mutation: SessionTurnMutationV1): void | Promise<void>;
  enqueueRegisteredSessionStateFieldMutation?(mutation: RegisteredSessionStateFieldMutationV1): void | Promise<void>;
  setSessionRuntimeControls?(controls: SessionRuntimeControls | null): void;

  keepAlive(thinking: boolean, mode: 'local' | 'remote'): void;

  getMetadataSnapshot(): Metadata | null;
  getCommittedUserMessageSeq?(localId: string): number | null;
  subscribeCommittedUserMessageSeq?(listener: CommittedUserMessageSeqListener): () => void;
  hasUserMessageLocalConsumption?(query: UserMessageLocalConsumptionQuery): boolean;
  confirmUserMessageLocallyConsumed?(confirmation: LocallyConsumedUserMessageConfirmation): void;
  waitForMetadataUpdate(abortSignal?: AbortSignal): Promise<boolean>;
  readRuntimeActivitySnapshotTail?(): RuntimeActivitySnapshotTail;
  waitForRuntimeActivitySnapshotTailChange?(
    sequence: number,
    abortSignal?: AbortSignal,
  ): Promise<boolean>;
  materializeNextPendingMessageSafely?(opts?: {
    reconcileWhenEmpty?: 'force' | 'throttled' | 'skip';
    deliveryTiming?: PendingMaterializationDeliveryTiming;
    expectedRuntimeActivityRevision?: number;
  }): Promise<MaterializeNextPendingResult>;
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
