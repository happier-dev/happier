import type { RpcHandlerManagerLike } from '@/api/rpc/types';
import type { RawJSONLines } from '@/backends/claude/contracts/rawJsonLines';
import type { ACPMessageData, ACPProvider, SessionEventMessage } from './sessionMessageTypes';
import type { AgentState, Metadata } from '../types';
import type { ProviderTranscriptDispatchRequest } from './client/transcript/providerDispatch';

export interface SessionClientPort {
  sessionId: string;
  rpcHandlerManager: RpcHandlerManagerLike;

  sendSessionEvent(event: SessionEventMessage, id?: string): void;
  sendProviderMessage?(request: ProviderTranscriptDispatchRequest): void;
  // Compat-only aliases for existing provider-owned callers. New callers should use sendProviderMessage().
  sendClaudeSessionMessage(message: RawJSONLines, meta?: Record<string, unknown>): void;
  // Compat-only alias for existing provider-owned callers. New callers should use sendProviderMessage().
  sendCodexMessage?(body: unknown): void;
  sendAgentMessage(provider: ACPProvider, body: ACPMessageData, opts?: { localId?: string; meta?: Record<string, unknown> }): void;
  sendAgentMessageCommitted(provider: ACPProvider, body: ACPMessageData, opts: { localId: string; meta?: Record<string, unknown> }): Promise<void>;

  updateMetadata(updater: (metadata: Metadata) => Metadata): void | Promise<void>;
  updateAgentState(updater: (state: AgentState) => AgentState): void | Promise<void>;

  keepAlive(thinking: boolean, mode: 'local' | 'remote'): void;

  getMetadataSnapshot(): Metadata | null;
  waitForMetadataUpdate(abortSignal?: AbortSignal): Promise<boolean>;
  popPendingMessage(): Promise<boolean>;

  peekPendingMessageQueueV2Count(): Promise<number>;
  discardPendingMessageQueueV2All(opts: { reason: 'switch_to_local' | 'manual' }): Promise<number>;
  discardCommittedMessageLocalIds(opts: { localIds: string[]; reason: 'switch_to_local' | 'manual' }): Promise<number>;

  sendSessionDeath(): void;
  flush(): Promise<void>;
  close(): Promise<void>;

  on?(event: string, listener: (...args: unknown[]) => void): unknown;
  off?(event: string, listener: (...args: unknown[]) => void): unknown;
}
