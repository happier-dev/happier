import type { SessionId } from '@/agent/core/AgentMessage';
import type { ExecutionRunControllerFailureSignal } from './failureSignal';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { StreamedTranscriptWriter } from '@/api/session/streamedTranscriptWriter';
import type { VoiceAgentTurnStreamReadResult } from '@/agent/voice/agent/voiceAgentTypes';

export type PendingVoiceAgentTranscriptTurn = {
  mode: 'legacy_pair' | 'assistant_only';
  user: Readonly<{ text: string; localId: string; meta: Record<string, unknown> }> | null;
  assistant: Readonly<{ text: string; meta: Record<string, unknown> }> | null;
  commitInFlight: Promise<Readonly<{ persisted: boolean; delivered: boolean }>> | null;
};

export type CachedTerminalVoiceAgentTurnRead = Readonly<{
  requestedCursor: number;
  result: VoiceAgentTurnStreamReadResult;
}>;

export type ExecutionRunSendDelivery = 'prompt' | 'steer_if_supported' | 'interrupt';

export type ExecutionRunExternalMessage = Readonly<{
  message: string;
  delivery: ExecutionRunSendDelivery;
  authorizeProviderEffect?: () => Promise<void>;
  resolve: () => void;
  reject: (e: Error) => void;
}>;

export type ExecutionRunBackendController = {
  kind: 'backend';
  backend: ExecutionRunHostRuntime;
  backendSupportsResume: boolean;
  childSessionId: SessionId | null;
  buffer: string;
  sidechainStreamBuffer: string;
  sidechainStreamKey: string;
  streamWriter: StreamedTranscriptWriter | null;
  cancelled: boolean;
  turnCount: number;
  turnEpoch: number;
  turnInFlight: boolean;
  turnCancelReason: 'steer' | 'stop' | 'timeout' | null;
  turnCancelEpoch: number | null;
  pendingExternalMessages: ExecutionRunExternalMessage[];
  pendingExternalMessagesSignal: { promise: Promise<void>; resolve: () => void } | null;
  lastMarkerWriteAtMs: number;
  failureSignal?: ExecutionRunControllerFailureSignal;
  pendingHostBarrier?: Promise<void>;
  terminalMarkerWritePromise?: Promise<void>;
  settlementPromise?: Promise<void>;
  terminalPromise: Promise<void>;
  resolveTerminal: () => void;
};

export type ExecutionRunVoiceAgentController = {
  kind: 'voice_agent';
  voiceAgentId: string;
  cancelled: boolean;
  lastMarkerWriteAtMs: number;
  terminalMarkerWritePromise?: Promise<void>;
  settlementPromise?: Promise<void>;
  terminalPromise: Promise<void>;
  resolveTerminal: () => void;
  transcript: Readonly<{ persistenceMode: 'ephemeral' | 'persistent'; epoch: number }>;
  externalStreamIdByInternal: Map<string, string>;
  internalStreamIdByExternal: Map<string, string>;
  pendingTranscriptTurnByExternalStreamId: Map<string, PendingVoiceAgentTranscriptTurn>;
  terminalReadByExternalStreamId: Map<string, CachedTerminalVoiceAgentTurnRead>;
  readInFlightByExternalStreamId: Map<string, Promise<VoiceAgentTurnStreamReadResult>>;
};

export type ExecutionRunController = ExecutionRunBackendController | ExecutionRunVoiceAgentController;

export function readBackendChildSessionId(ctrl: ExecutionRunController | null): SessionId | null {
  if (!ctrl) return null;
  return ctrl.kind === 'backend' ? ctrl.childSessionId : null;
}

export function readBackendResumableChildSessionId(ctrl: ExecutionRunController | null): SessionId | null {
  if (!ctrl || ctrl.kind !== 'backend' || ctrl.backendSupportsResume !== true) return null;
  return ctrl.childSessionId;
}
