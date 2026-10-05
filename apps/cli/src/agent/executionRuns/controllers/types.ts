import type { ExecutionRunControllerFailureSignal } from './failureSignal';
import type { ExecutionRunHostRuntime } from '@/agent/runtime/bridges/executionRun/executionRunHostRuntime';
import type { StreamedTranscriptWriter } from '@/api/session/streamedTranscriptWriter';
import type { VoiceAgentTurnStreamReadResult } from '@/agent/voice/agent/voiceAgentTypes';
import type { ExecutionRunInputTurnV1, ExecutionRunResumeHandle, SessionInputCausalPermissionAuthorityV1, SessionRunPromptReadActionIdV1 } from '@happier-dev/protocol';
import type { DurableProviderInputAcceptanceV1 } from '@/agent/runtime/session/input/providerInputOutcome';
import type { AgentInvocationTurnAdmissionWitness } from '@/plugins/runtime/invocation/services/types';
import type { ExecutionRunPermissionRequestStore } from '@/agent/runtime/bridges/executionRun/executionRunPermissionResponseTarget';
import type { ExecutionRunWorkflowObservationBinding } from '@/agent/runtime/bridges/executionRun/executionRunWorkflowObservation';

export type ExecutionRunControllerOccurrenceV1 = Readonly<{
  runId: string;
  sidechainId: string;
  occurrenceId: string;
  runtimeLifetimeSignal: AbortSignal;
  isCurrent: () => boolean;
  readActiveTurnAdmissionWitness: () => AgentInvocationTurnAdmissionWitness | null;
}>;

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

export type ExecutionRunLiveIntervention = Readonly<{
  message: string;
  delivery: ExecutionRunSendDelivery;
  causalPermissionAuthority?: SessionInputCausalPermissionAuthorityV1;
  authorizeProviderEffect?: () => Promise<void>;
  resolve: () => void;
  reject: (e: Error) => void;
}>;

export type ExecutionRunBackendController = {
  kind: 'backend';
  /** Stable identity for this exact controller lifetime, including resume replacements. */
  controllerOccurrenceId: string;
  backend: ExecutionRunHostRuntime;
  backendSupportsResume: boolean;
  /** Runtime-private address used to deliver input and lifecycle controls. */
  runtimeId: string | null;
  buffer: string;
  sidechainStreamBuffer: string;
  sidechainStreamKey: string;
  streamWriter: StreamedTranscriptWriter | null;
  cancelled: boolean;
  turnCount: number;
  turnEpoch: number;
  turnInFlight: boolean;
  /** Native evidence for the current and most recently settled input turn, never a history ledger. */
  currentInputTurn?: ExecutionRunInputTurnV1;
  /** Host-private interaction binding for exactly `currentInputTurn`. */
  currentInputPermissionRequestStore?: Readonly<{
    localInputId: string;
    turnId: string;
    store: ExecutionRunPermissionRequestStore;
    releaseResponseTarget: () => void;
  }>;
  /** Host-private Workflow persistence route for exactly `currentInputTurn`. */
  workflowObservation?: ExecutionRunWorkflowObservationBinding;
  /** Admitted Workflow Action leaf identity retained only by this live controller. */
  workflowRunId?: string;
  /** The first provider-emitted resume identity won over any provisional runtime address. */
  providerResumeIdentityObserved?: boolean;
  lastInputTurn?: ExecutionRunInputTurnV1;
  /** Stable exact-result observation occurrence for this controller lifetime. */
  inputTurnOccurrenceId?: string;
  /**
   * Stable identity and lifetime witness for this exact controller occurrence.
   * Currentness is still decided by the host controller map; this field only
   * projects the occurrence owned by that canonical entry.
   */
  executionRunOccurrence?: ExecutionRunControllerOccurrenceV1;
  /** Descriptive read capabilities from this occurrence's exact admitted tool profile. */
  supportedSessionReadActions?: readonly SessionRunPromptReadActionIdV1[];
  turnCancelReason: 'steer' | 'cancel' | 'stop' | 'timeout' | 'outcome_unknown' | null;
  turnCancelEpoch: number | null;
  admittedLiveInterventions: ExecutionRunLiveIntervention[];
  /** One live intervention adopted by the bounded loop and awaiting provider admission. */
  activeLiveIntervention?: ExecutionRunLiveIntervention;
  admittedLiveInterventionsSignal: { promise: Promise<void>; resolve: () => void } | null;
  lastMarkerWriteAtMs: number;
  /**
   * Lifecycle-bound release for this exact controller occurrence's Session-input
   * attachment (target pending consumer plus occurrence witness registration).
   * Retirement runs with the controller so a superseded or resumed occurrence can
   * never keep claiming, settling, or supplying turn authority.
   */
  releaseSessionInputAttachment?: () => Promise<void>;
  failureSignal?: ExecutionRunControllerFailureSignal;
  pendingHostBarrier?: Promise<void>;
  /**
   * Readiness of this admitted long-lived occurrence. Detached sends arriving
   * before a runtime exists wait here so they cannot overtake the initial
   * instruction; Session-owned input remains ordered by canonical Pending.
   */
  provisioningPromise?: Promise<void>;
  /**
   * Durable admission of this occurrence's retained initial Pending input.
   * A direct execution.run.send must not overtake that Session-owned input.
   */
  initialPendingInputAdmission?: Promise<DurableProviderInputAcceptanceV1>;
  /** Provider output waits for the existing Pending owner's exact user anchor. */
  pendingInputAcceptance?: Promise<DurableProviderInputAcceptanceV1>;
  terminalMarkerWritePromise?: Promise<void>;
  settlementPromise?: Promise<void>;
  terminalPromise: Promise<void>;
  resolveTerminal: () => void;
};

export type ExecutionRunVoiceAgentController = {
  kind: 'voice_agent';
  controllerOccurrenceId: string;
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

export function readBackendRuntimeId(ctrl: ExecutionRunController | null): string | null {
  if (!ctrl) return null;
  return ctrl.kind === 'backend' ? ctrl.runtimeId : null;
}

export function readBackendResumableRuntimeId(
  ctrl: ExecutionRunController | null,
  resumeHandle?: ExecutionRunResumeHandle | null,
): string | null {
  if (!ctrl || ctrl.kind !== 'backend' || ctrl.backendSupportsResume !== true) return null;
  // Native checkpoint observations belong to the retained Run. Its live control
  // address can be a host Run id and must never replace that vendor identity.
  if (resumeHandle?.kind === 'provider_session.v1') return resumeHandle.providerSessionId;
  return ctrl.backend.readProviderSessionId?.() ?? null;
}
