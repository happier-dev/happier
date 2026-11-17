import type { CommittedTranscriptAdmission, TranscriptSessionPort } from '../transcriptPort';
import type { StreamedTranscriptSegmentKind } from './segmentKey';
import type { StreamedTranscriptSegmentState } from './segmentRuntime';

export type StreamedTranscriptWriterSession = TranscriptSessionPort;

export type StreamedTranscriptWriter = Readonly<{
  appendAssistantDelta: (deltaText: string, opts?: { sidechainId?: string | null; meta?: Readonly<Record<string, unknown>> }) => void;
  appendThinkingDelta: (deltaText: string, opts?: { sidechainId?: string | null }) => void;
  overrideAssistantText: (text: string, opts?: { sidechainId?: string | null }) => boolean;
  overrideThinkingText: (text: string, opts?: { sidechainId?: string | null }) => boolean;
  enableDurableCommits: () => void;
  discard: () => void;
  hasPendingSegments: () => boolean;
  finalizeSegment: (opts: {
    kind: StreamedTranscriptSegmentKind;
    sidechainId: string | null;
    text: string;
    sourceMessageId: string;
    admission?: CommittedTranscriptAdmission;
    /** Keep the acknowledged segment until its existing foreground boundary consumes it. */
    retainForTurnEnd?: boolean;
  }) => Promise<StreamedTranscriptFlushSummary | null>;
  flushAll: (opts: {
    reason: 'tool-call-boundary' | 'turn-end' | 'abort';
    interruptedReason?: string;
    keepOpen?: boolean;
  }) => Promise<StreamedTranscriptFlushSummary>;
}>;

export type StreamedTranscriptSegmentFlushSummary = Readonly<{
  kind: StreamedTranscriptSegmentKind;
  sidechainId: string | null;
  sawText: boolean;
  didDurablyFlush: boolean;
  /** The final snapshot reached Home, rather than only the local durable outbox. */
  didDeliver: boolean;
  /** Home's receipt for this exact snapshot; absent for journal-only custody. */
  committedSequence?: number;
  lastCommittedState: StreamedTranscriptSegmentState | null;
}>;

export type StreamedTranscriptFlushSummary = Readonly<{
  assistant: Readonly<{ sawText: boolean; didDurablyFlush: boolean }>;
  assistantRoot: Readonly<{ sawText: boolean; didDurablyFlush: boolean }>;
  thinking: Readonly<{ sawText: boolean; didDurablyFlush: boolean }>;
  thinkingRoot: Readonly<{ sawText: boolean; didDurablyFlush: boolean }>;
  segments: ReadonlyArray<StreamedTranscriptSegmentFlushSummary>;
}>;
