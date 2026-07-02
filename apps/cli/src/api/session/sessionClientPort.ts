import type { RpcHandlerManagerLike } from '@/api/rpc/types';
import type { ACPMessageData, ACPProvider, SessionEventMessage } from './sessionMessageTypes';
import type { AgentState, Metadata } from '../types';
import type { ProviderTranscriptDispatchRequest } from './client/transcript/providerDispatch';
import type { SessionTurnMutationV1 } from '@happier-dev/protocol';
import type { SessionRuntimeControls } from '@/rpc/handlers/sessionControls';
import type { PendingQueueState } from './pendingQueueState';
import type { RegisteredSessionStateFieldMutationV1 } from './client/transport/mutations/sessionClientDurableMutationTypes';

export type MaterializeNextPendingResult =
  | {
      type: 'materialized';
      localId: string;
      seq: number;
      content: unknown;
      createdAt?: number;
      updatedAt?: number;
    }
  | { type: 'no_pending' }
  | { type: 'deferred'; reason: 'supervisor_offline' | 'supervisor_auth_failed' };

export interface SessionClientPort {
  sessionId: string;
  rpcHandlerManager: RpcHandlerManagerLike;

  sendSessionEvent(event: SessionEventMessage, id?: string): void;
  sendProviderMessage?(request: ProviderTranscriptDispatchRequest): void;
  // Compat-only aliases for existing provider-owned callers. New callers should use sendProviderMessage().
  sendClaudeSessionMessage(message: unknown, meta?: Record<string, unknown>): void;
  // Compat-only alias for existing provider-owned callers. New callers should use sendProviderMessage().
  sendCodexMessage?(body: unknown): void;
  sendAgentMessage(provider: ACPProvider, body: ACPMessageData, opts?: { localId?: string; meta?: Record<string, unknown> }): void;
  enqueueAgentMessageCommitted?(
    provider: ACPProvider,
    body: ACPMessageData,
    opts: { localId: string; meta?: Record<string, unknown> },
  ): Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
  sendAgentMessageCommitted(provider: ACPProvider, body: ACPMessageData, opts: { localId: string; meta?: Record<string, unknown> }): Promise<void>;

  updateMetadata(updater: (metadata: Metadata) => Metadata): void | Promise<void>;
  updateAgentState(updater: (state: AgentState) => AgentState): void | Promise<void>;
  enqueueSessionTurnMutation?(mutation: SessionTurnMutationV1): void | Promise<void>;
  enqueueRegisteredSessionStateFieldMutation?(mutation: RegisteredSessionStateFieldMutationV1): void | Promise<void>;
  setSessionRuntimeControls?(controls: SessionRuntimeControls | null): void;

  keepAlive(thinking: boolean, mode: 'local' | 'remote'): void;

  getMetadataSnapshot(): Metadata | null;
  getCommittedUserMessageSeq?(localId: string): number | null;
  waitForCommittedUserMessageSeq?(
    localId: string,
    options?: Readonly<{ timeoutMs?: number; pollMs?: number }>,
  ): Promise<number | null>;
  waitForMetadataUpdate(abortSignal?: AbortSignal): Promise<boolean>;
  materializeNextPendingMessageSafely?(opts?: {
    reconcileWhenEmpty?: 'force' | 'throttled' | 'skip';
  }): Promise<MaterializeNextPendingResult>;
  popPendingMessage(): Promise<boolean>;
  shouldAttemptPendingMaterialization(): boolean;
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
