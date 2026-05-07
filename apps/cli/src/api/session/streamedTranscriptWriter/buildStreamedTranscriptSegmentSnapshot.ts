import type { ACPMessageData } from '../sessionMessageTypes';
import type { StreamedTranscriptSegmentRuntime, StreamedTranscriptSegmentState } from './segmentRuntime';

export function buildStreamedTranscriptSegmentSnapshotBody(segment: StreamedTranscriptSegmentRuntime): ACPMessageData {
  return segment.kind === 'assistant'
    ? {
        type: 'message',
        message: segment.accumulatedText,
        ...(segment.sidechainId ? { sidechainId: segment.sidechainId } : {}),
      }
    : {
        type: 'thinking',
        text: segment.accumulatedText,
        ...(segment.sidechainId ? { sidechainId: segment.sidechainId } : {}),
      };
}

export function buildStreamedTranscriptSegmentSnapshotMeta(params: {
  segment: StreamedTranscriptSegmentRuntime;
  state: StreamedTranscriptSegmentState;
  interruptedReason?: string;
  nowMs: number;
}): Record<string, unknown> {
  const { segment, state, interruptedReason, nowMs } = params;

  return {
    happierStreamSegmentV1: {
      v: 1,
      segmentKind: segment.kind,
      segmentLocalId: segment.segmentLocalId,
      segmentState: state,
      startedAtMs: segment.startedAtMs,
      updatedAtMs: nowMs,
      ...(state === 'interrupted' && typeof interruptedReason === 'string' && interruptedReason
        ? { interruptedReason }
        : {}),
    },
  };
}
