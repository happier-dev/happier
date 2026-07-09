import type { RpcHandlerManagerLike } from '@/api/rpc/types';
import type { ACPMessageData, ACPProvider, SessionEventMessage } from './sessionMessageTypes';
import type { AgentState, Metadata } from '../types';
import type { ProviderTranscriptDispatchRequest } from './client/transcript/providerDispatch';
import type {
  SessionRuntimeActivitySourceClassV1,
  SessionSystemRecord,
  SessionSystemRecordNamespace,
  SessionSystemRecordUpsertRequest,
  SessionTurnMutationV1,
} from '@happier-dev/protocol';
import type {
  SessionEncryptionContext,
  SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import type { PendingQueueState } from './pendingQueueState';
import type { RegisteredSessionStateFieldMutationV1 } from './client/transport/mutations/sessionClientDurableMutationTypes';
import type {
  PendingMaterializationActiveTurnPolicy,
  ProviderAcceptancePendingMaterializationPolicy,
} from './pendingMaterializationActiveTurnPolicy';
import type {
  PendingMaterializationDeliveryState,
  PendingMaterializationDeliveryTiming,
  PendingQueueDeliveryBlockedReason,
} from './pendingQueueV2Transport';

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
  | { type: 'deferred'; reason: 'supervisor_offline' | 'supervisor_auth_failed' | 'runtime_activity_active' };

export type ProviderUserMessageDeliveryAcceptance = Readonly<{
  localIds?: readonly string[] | null;
  userMessageSeq?: number | null;
  userMessageSeqs?: readonly number[] | null;
}>;

export type UserMessageProviderAcceptanceQuery = Readonly<{
  localIds?: readonly string[] | null;
  userMessageSeq?: number | null;
  userMessageSeqs?: readonly number[] | null;
}>;

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
    opts: { localId: string; meta?: Record<string, unknown> },
  ): Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
  sendAgentMessageCommitted(provider: ACPProvider, body: ACPMessageData, opts: { localId: string; meta?: Record<string, unknown> }): Promise<void>;

  updateMetadata(updater: (metadata: Metadata) => Metadata): void | Promise<void>;
  updateAgentState(updater: (state: AgentState) => AgentState): void | Promise<void>;
  updateRuntimeActivityProjection?(projection: Readonly<{
    runtimeActivityActiveCount: number;
    runtimeActivityObservedAt: number | null;
    runtimeActivityExpiresAt: number | null;
    runtimeActivitySourceClass: SessionRuntimeActivitySourceClassV1 | null;
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
  hasCanonicalPendingDeliveryLocalId?(localId: string): boolean;
  getDeliveredUserMessageSeq?(): number | null;
  getProviderAcceptedUserMessageSeq?(): number | null;
  hasUserMessageProviderAcceptance?(query: UserMessageProviderAcceptanceQuery): boolean;
  hasUserMessageLocalConsumption?(query: UserMessageLocalConsumptionQuery): boolean;
  /**
   * HF-1 owed-delivery watermark, provider-acceptance shape: a runtime with an acceptance seam
   * opts in (queue-handoff persist stops) and confirms accepted row seqs explicitly.
   */
  deferDeliveredUserMessageWatermarkToProviderAcceptance?(opts?: {
    pendingMaterialization?: ProviderAcceptancePendingMaterializationPolicy;
  }): void;
  confirmUserMessageDeliveredToProvider?(acceptance: ProviderUserMessageDeliveryAcceptance): void;
  confirmUserMessageLocallyConsumed?(confirmation: LocallyConsumedUserMessageConfirmation): void;
  blockPendingMessageDelivery?(params: Readonly<{
    localIds?: readonly string[] | null;
    reason: PendingQueueDeliveryBlockedReason;
  }>): Promise<boolean>;
  retryPendingMessageDelivery?(params: Readonly<{
    localId: string;
  }>): Promise<boolean>;
  waitForCommittedUserMessageSeq?(
    localId: string,
    options?: Readonly<{ timeoutMs?: number; pollMs?: number }>,
  ): Promise<number | null>;
  waitForMetadataUpdate(abortSignal?: AbortSignal): Promise<boolean>;
  materializeNextPendingMessageSafely?(opts?: {
    reconcileWhenEmpty?: 'force' | 'throttled' | 'skip';
    activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
    deliveryTiming?: PendingMaterializationDeliveryTiming;
  }): Promise<MaterializeNextPendingResult>;
  popPendingMessage(): Promise<boolean>;
  shouldAttemptPendingMaterialization(opts?: {
    activeTurnDeliveryPolicy?: PendingMaterializationActiveTurnPolicy;
  }): boolean;
  getPendingQueueState?(): PendingQueueState;
  reconcilePendingQueueState?(opts?: { force?: boolean }): Promise<boolean>;

  peekPendingMessageQueueV2Count(): Promise<number>;
  discardPendingMessageQueueV2All(opts: { reason: 'switch_to_local' | 'manual' }): Promise<number>;
  discardCommittedMessageLocalIds(opts: { localIds: string[]; reason: 'switch_to_local' | 'manual' }): Promise<number>;

  sendSessionDeath(): void;
  flush(): Promise<void>;
  close(): Promise<void>;

  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
}
