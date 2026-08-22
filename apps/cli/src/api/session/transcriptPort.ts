import type { ACPMessageData, ACPProvider } from './sessionMessageTypes';
import type { TurnAssistantTextSnapshotStore } from './turns/assistantTextSnapshot';
import type { SendAgentSessionMediaCommittedRequest } from './client/transcript/sessionMediaBridge';
import type { EphemeralSendResult } from './client/transcript/ephemeralSendOutcome';
import type { SessionTranscriptObservationProvenanceV1 } from '@happier-dev/protocol';

export type CommittedTranscriptAdmission = Readonly<{
  signal: AbortSignal;
  deadlineAtMs?: number;
}>;

export class CommittedTranscriptAdmissionExpiredError extends Error {
  readonly code = 'committed_transcript_admission_expired';

  constructor() {
    super('Committed transcript admission expired');
    this.name = 'CommittedTranscriptAdmissionExpiredError';
  }
}

export function assertCommittedTranscriptAdmission(
  admission: CommittedTranscriptAdmission | undefined,
): void {
  if (
    !admission
    || (
      !admission.signal.aborted
      && (
        admission.deadlineAtMs === undefined
        || Date.now() < admission.deadlineAtMs
      )
    )
  ) {
    return;
  }
  throw new CommittedTranscriptAdmissionExpiredError();
}

export type CommittedTranscriptMessageOptions = Readonly<{
  localId: string;
  meta?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
  provenance: SessionTranscriptObservationProvenanceV1;
  admission?: CommittedTranscriptAdmission;
}>;

export type TranscriptSessionPort = Readonly<{
  turnAssistantTextSnapshotStore?: TurnAssistantTextSnapshotStore;
  sendAgentMessageEphemeral?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: {
      localId: string;
      meta?: Record<string, unknown>;
      createdAt: number;
      updatedAt?: number;
      /** Live-stream tick this full snapshot corresponds to (delta-chaining checkpoint anchor). */
      tick?: number;
    },
  ) => EphemeralSendResult;
  /**
   * Emit a live delta tick: `body` carries ONLY the text appended since the previous live emission
   * for this segment. Sessions that do not implement this receive full snapshots on every live
   * emission (the pre-delta behavior); the streamed transcript writer only emits deltas when this
   * method exists.
   */
  sendAgentMessageEphemeralDelta?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: {
      localId: string;
      tick: number;
      baseLength: number;
      createdAt: number;
      updatedAt?: number;
      meta?: Record<string, unknown>;
    },
  ) => EphemeralSendResult;
  /**
   * Monotonic counter that increases whenever the underlying live transport (re)connects. The
   * streamed transcript writer emits a full snapshot after an epoch change so receivers resync
   * after reconnects.
   */
  getEphemeralStreamConnectionEpoch?: () => number;
  enqueueAgentMessageCommitted?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: CommittedTranscriptMessageOptions,
  ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
  sendAgentSessionMediaCommitted?: (
    provider: ACPProvider,
    request: SendAgentSessionMediaCommittedRequest,
  ) => Promise<void>;
}>;
