import type { ACPMessageData, ACPProvider } from '../sessionMessageTypes';
import type { StreamedTranscriptSegmentKind } from './segmentKey';
import type { StreamedTranscriptSegmentState } from './segmentRuntime';

export type StreamedTranscriptWriterSession = Readonly<{
  sendAgentMessage?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts?: { localId?: string; meta?: Record<string, unknown> },
  ) => void;
  sendAgentMessageCommitted?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: { localId: string; meta?: Record<string, unknown> },
  ) => Promise<void>;
  sendAgentMessageEphemeral?: (
    provider: ACPProvider,
    body: ACPMessageData,
    opts: { localId: string; createdAt: number; updatedAt?: number; meta?: Record<string, unknown> },
  ) => void;
}>;

export type StreamedTranscriptWriter = Readonly<{
  appendAssistantDelta: (deltaText: string, opts?: { sidechainId?: string | null }) => void;
  appendThinkingDelta: (deltaText: string, opts?: { sidechainId?: string | null }) => void;
  overrideAssistantText: (text: string, opts?: { sidechainId?: string | null }) => boolean;
  overrideThinkingText: (text: string, opts?: { sidechainId?: string | null }) => boolean;
  flushAll: (opts: {
    reason: 'tool-call-boundary' | 'turn-end' | 'abort';
    interruptedReason?: string;
  }) => Promise<StreamedTranscriptFlushSummary>;
}>;

export type StreamedTranscriptSegmentFlushSummary = Readonly<{
  kind: StreamedTranscriptSegmentKind;
  sidechainId: string | null;
  sawText: boolean;
  didDurablyFlush: boolean;
  lastCommittedState: StreamedTranscriptSegmentState | null;
}>;

export type StreamedTranscriptFlushSummary = Readonly<{
  assistant: Readonly<{ sawText: boolean; didDurablyFlush: boolean }>;
  assistantRoot: Readonly<{ sawText: boolean; didDurablyFlush: boolean }>;
  thinking: Readonly<{ sawText: boolean; didDurablyFlush: boolean }>;
  thinkingRoot: Readonly<{ sawText: boolean; didDurablyFlush: boolean }>;
  segments: ReadonlyArray<StreamedTranscriptSegmentFlushSummary>;
}>;
