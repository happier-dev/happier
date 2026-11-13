import type { AgentBackend, SessionId } from '@/agent/core/AgentBackend';
import type { StreamedTranscriptWriter } from '@/api/session/streamedTranscriptWriter';
import type { VisibleRunControls } from '@/agent/executionRuns/runtime/visibleRuns/visibleRunRules';

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
  turnHadMeaningfulActivity?: boolean;
  recoveryAbortController?: AbortController;
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

/**
 * Controller of a visible run (plan 2A/2B): the work happens in the linked child Session; this
 * runner holds the authoritative run state and evaluates the child's transcript on wake-ups.
 */
export type ExecutionRunSessionController = {
  kind: 'session';
  linkedSessionId: string;
  binding: 'created' | 'reused';
  controls: VisibleRunControls;
  linked: boolean;
  /** Highest accepted child turn epoch; reports at or below it are stale. */
  lastReportedTurnEpoch: number;
  /** Absolute task deadline fixed at start (kept across a parent restart); null when unbounded. */
  deadlineAtMs: number | null;
  /** Highest report epoch seen on the child's own link record, so a relay found by a re-read matches it. */
  observedChildReportEpoch: number;
  /** The latest accepted child turn report said the turn failed. */
  lastTurnFailed: boolean;
  /** The current scheduled transcript re-read after the latest accepted wake-up. */
  recoveryTimer: ReturnType<typeof setTimeout> | null;
  evaluatedTurnCount: number;
  completion: Promise<void> | null;
  pendingRepair: ((finalText: string) => void) | null;
  evaluationTail: Promise<void>;
  cancelled: boolean;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  lastMarkerWriteAtMs: number;
  terminalMarkerWritePromise?: Promise<void>;
  disposalPromise?: Promise<void>;
  cancellationPromise?: Promise<void>;
  terminalPromise: Promise<void>;
  resolveTerminal: () => void;
};

export type ExecutionRunController = ExecutionRunBackendController | ExecutionRunVoiceAgentController | ExecutionRunSessionController;

export function resetExecutionRunBackendOutput(ctrl: ExecutionRunBackendController): void {
  ctrl.turnHadMeaningfulActivity = false;
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
