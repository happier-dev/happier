import type { ACPMessageData, ACPProvider } from './sessionMessageTypes';
import type { TurnAssistantTextSnapshotStore } from './turns/assistantTextSnapshot';
import type { SendAgentSessionMediaCommittedRequest } from './client/transcript/sessionMediaBridge';
import type { EphemeralSendResult } from './client/transcript/ephemeralSendOutcome';
import type { SessionTranscriptObservationProvenanceV1, ToolNormalizationSourceV3 } from '@happier-dev/protocol';

export type CommittedTranscriptAdmission = Readonly<{
  signal: AbortSignal;
  deadlineAtMs?: number;
  /** Ordered terminal observations must reach server custody before later input acceptance. */
  requireDelivery?: boolean;
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
  /** Selected runtime provenance; independent of the transcript transport codec. */
  toolNormalizationSource?: ToolNormalizationSourceV3;
  localId: string;
  meta?: Record<string, unknown>;
  createdAt?: number;
  updatedAt?: number;
  provenance: SessionTranscriptObservationProvenanceV1;
  admission?: CommittedTranscriptAdmission;
  /** Observe the existing outbox ACK without delaying local publication. */
  observeCommitSignal?: AbortSignal;
  /** What changed since this localId's last Home-acknowledged commit; Home still stores `body`. */
  append?: CommittedTranscriptAppend;
}>;

/**
 * The text appended since the writer's last Home-acknowledged commit of the same localId. Home
 * relays it to live consumers in place of the whole message when its stored row is that base.
 */
export type CommittedTranscriptAppend = Readonly<{
  /** The full message's record shape carrying only the appended text (and the current meta). */
  body: ACPMessageData;
  /** Text length of the acknowledged base commit. */
  baseLength: number;
  /** The acknowledged base commit's source `updatedAt` (its segment meta `updatedAtMs`). */
  baseUpdatedAt: number;
  /** Text length after the append; sealed with `baseLength` and the localId inside the append. */
  length: number;
}>;

export type CommittedTranscriptOriginal = Readonly<{ localId: string; committedSequence: number }>;

/** Native child input observations retain their Run's existing transcript sidechain. */
export type CommittedTranscriptUserMessageOptions = CommittedTranscriptMessageOptions & Readonly<{
  sidechainId?: string;
}>;

export type TranscriptSessionPort = Readonly<{
  turnAssistantTextSnapshotStore?: TurnAssistantTextSnapshotStore;
  sendAgentMessageEphemeral?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: {
      toolNormalizationSource?: ToolNormalizationSourceV3;
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
      toolNormalizationSource?: ToolNormalizationSourceV3;
      localId: string;
      tick: number;
      baseLength: number;
      createdAt: number;
      updatedAt?: number;
      meta?: Record<string, unknown>;
      /** The segment's full current body, observed locally only (never sent). */
      snapshotBody?: ACPMessageData;
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
  ) => Promise<Readonly<{ persisted: boolean; delivered: boolean; committedSequence?: number }>>;
  sendAgentSessionMediaCommitted?: (
    provider: ACPProvider,
    request: SendAgentSessionMediaCommittedRequest,
  ) => Promise<void>;
}>;
