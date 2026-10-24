import type { AgentBackend, SessionId } from '@/agent/core/AgentBackend';
import type { StreamedTranscriptWriter } from '@/api/session/streamedTranscriptWriter';

export type ExecutionRunSendDelivery = 'prompt' | 'steer_if_supported' | 'interrupt';

export type ExecutionRunExternalMessage = Readonly<{
  message: string;
  delivery: ExecutionRunSendDelivery;
  resolve: () => void;
  reject: (e: Error) => void;
}>;

export type ExecutionRunBackendController = {
  kind: 'backend';
  backend: AgentBackend;
  backendSupportsResume: boolean;
  childSessionId: SessionId | null;
  buffer: string;
  /** Provider-scoped cumulative snapshot state for the current assistant segment. */
  modelOutputSegmentSnapshot?: string;
  sidechainStreamBuffer: string;
  sidechainStreamKey: string;
  streamWriter: StreamedTranscriptWriter | null;
  cancelled: boolean;
  turnCount: number;
  turnEpoch: number;
  turnInFlight: boolean;
  turnCancelReason: 'steer' | 'stop' | 'timeout' | 'outcome_unknown' | null;
  turnCancelEpoch: number | null;
  pendingExternalMessages: ExecutionRunExternalMessage[];
  pendingExternalMessagesSignal: { promise: Promise<void>; resolve: () => void } | null;
  lastMarkerWriteAtMs: number;
  terminalMarkerWritePromise?: Promise<void>;
  disposalPromise?: Promise<void>;
  cancellationPromise?: Promise<void>;
  /**
   * Run-owned readiness for the initially admitted backend occurrence. A send arriving after the
   * durable run handle is returned waits here instead of racing session provisioning.
   */
  provisioningPromise?: Promise<void>;
  terminalPromise: Promise<void>;
  resolveTerminal: () => void;
};

export type ExecutionRunVoiceAgentController = {
  kind: 'voice_agent';
  voiceAgentId: string;
  cancelled: boolean;
  lastMarkerWriteAtMs: number;
  terminalMarkerWritePromise?: Promise<void>;
  disposalPromise?: Promise<void>;
  cancellationPromise?: Promise<void>;
  terminalPromise: Promise<void>;
  resolveTerminal: () => void;
  transcript: Readonly<{ persistenceMode: 'ephemeral' | 'persistent'; epoch: number }>;
  externalStreamIdByInternal: Map<string, string>;
  internalStreamIdByExternal: Map<string, string>;
  persistedDoneByExternalStreamId: Set<string>;
};

export type ExecutionRunController = ExecutionRunBackendController | ExecutionRunVoiceAgentController;

export function resetExecutionRunBackendOutput(ctrl: ExecutionRunBackendController): void {
  ctrl.buffer = '';
  ctrl.modelOutputSegmentSnapshot = undefined;
  ctrl.sidechainStreamBuffer = '';
  ctrl.sidechainStreamKey = '';
}

export function readBackendChildSessionId(ctrl: ExecutionRunController | null): SessionId | null {
  if (!ctrl) return null;
  return ctrl.kind === 'backend' ? ctrl.childSessionId : null;
}

export function readBackendResumableChildSessionId(ctrl: ExecutionRunController | null): SessionId | null {
  if (!ctrl || ctrl.kind !== 'backend' || ctrl.backendSupportsResume !== true) return null;
  return ctrl.childSessionId;
}
