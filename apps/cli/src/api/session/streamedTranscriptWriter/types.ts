import type { ACPMessageData, ACPProvider } from '../sessionMessageTypes';
import type { StreamedTranscriptSegmentKind } from './segmentKey';
import type { StreamedTranscriptSegmentState } from './segmentRuntime';
import type { EphemeralSendResult } from '../ephemeralSendOutcome';
import type { SessionTranscriptObservationProvenanceV1 } from '@happier-dev/protocol';
import type { SessionMessageCommitResult } from '../sessionMessageCommitResult';
import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';

export type StreamedTranscriptCommitOptions = {
  localId: string;
  meta?: Record<string, unknown>;
  provenance?: SessionTranscriptObservationProvenanceV1;
};

export type StreamedTranscriptEnqueueOptions = StreamedTranscriptCommitOptions & Readonly<{
  provenance: SessionTranscriptObservationProvenanceV1;
}>;

export type StreamedTranscriptWriterSession = Readonly<{
  subscribeToSessionConnectionState?: (listener: (state: ManagedConnectionState) => void) => () => void;
  sendAgentMessage?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts?: { localId?: string; meta?: Record<string, unknown> },
  ) => void;
  sendAgentMessageCommitted?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: StreamedTranscriptCommitOptions,
  ) => Promise<void>;
  sendAgentMessageCommittedExact?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: StreamedTranscriptCommitOptions,
  ) => Promise<SessionMessageCommitResult>;
  enqueueAgentMessageCommitted?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: StreamedTranscriptEnqueueOptions,
  ) => Promise<Readonly<{ persisted: boolean; delivered: boolean }>>;
  sendAgentMessageEphemeral?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: {
      localId: string;
      createdAt: number;
      updatedAt?: number;
      meta?: Record<string, unknown>;
      /** Live-stream tick this full snapshot corresponds to (delta-chaining checkpoint anchor). */
      tick?: number;
    },
  ) => EphemeralSendResult;
  /**
   * Emit a live delta tick: `body` carries ONLY the text appended since the previous live emission
   * for this segment. Sessions that do not implement this receive full snapshots on every live
   * emission (the pre-delta behavior); the writer only emits deltas when this method exists.
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
   * writer emits a full snapshot after an epoch change so receivers resync after reconnects.
   */
  getEphemeralStreamConnectionEpoch?: () => number;
}>;

export type StreamedTranscriptWriter = Readonly<{
  appendAssistantDelta: (deltaText: string, opts?: { sidechainId?: string | null }) => void;
  appendAssistantDeltaExact: (deltaText: string, opts: { localId: string; sidechainId?: string | null }) => void;
  appendThinkingDelta: (deltaText: string, opts?: { sidechainId?: string | null }) => void;
  overrideAssistantText: (text: string, opts?: { sidechainId?: string | null }) => boolean;
  overrideThinkingText: (text: string, opts?: { sidechainId?: string | null }) => boolean;
  mergeAssistantMeta: (meta: Record<string, unknown>, opts?: { sidechainId?: string | null }) => boolean;
  setCommitProvenance: (provenance: SessionTranscriptObservationProvenanceV1 | null) => void;
  enableDurableCommits: () => void;
  discard: () => void;
  hasPendingSegments: () => boolean;
  flushAll: (opts: {
    reason: 'tool-call-boundary' | 'turn-end' | 'abort';
    interruptedReason?: string;
  }) => Promise<StreamedTranscriptFlushSummary>;
  flushAllThroughDurableAdmission: (opts: {
    reason: 'tool-call-boundary' | 'turn-end' | 'abort';
    interruptedReason?: string;
  }) => Promise<void>;
}>;

export type StreamedTranscriptSegmentFlushSummary = Readonly<{
  kind: StreamedTranscriptSegmentKind;
  sidechainId: string | null;
  localId: string;
  sawText: boolean;
  didDurablyFlush: boolean;
  lastCommittedState: StreamedTranscriptSegmentState | null;
  commitResult: SessionMessageCommitResult | null;
}>;

export type StreamedTranscriptFlushSummary = Readonly<{
  assistant: Readonly<{ sawText: boolean; didDurablyFlush: boolean }>;
  assistantRoot: Readonly<{ sawText: boolean; didDurablyFlush: boolean }>;
  thinking: Readonly<{ sawText: boolean; didDurablyFlush: boolean }>;
  thinkingRoot: Readonly<{ sawText: boolean; didDurablyFlush: boolean }>;
  segments: ReadonlyArray<StreamedTranscriptSegmentFlushSummary>;
}>;
