import type { ACPMessageData } from '../sessionMessageTypes';
import { SessionMessageStreamSegmentV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageMeta';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';
import type { StreamedTranscriptSegmentRuntime, StreamedTranscriptSegmentState } from './segmentRuntime';

const StoredStreamSegmentV1Schema = createStoredReadSchema(SessionMessageStreamSegmentV1Schema);

/** The native fact can arrive after this host-owned row has checkpointed. */
export function readStreamedTranscriptSourceMessageId(localId: unknown, meta: unknown): string | null {
  if (typeof localId !== 'string' || localId.trim().length === 0) return null;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const parsed = StoredStreamSegmentV1Schema.safeParse(Reflect.get(meta, 'happierStreamSegmentV1'));
  return parsed.success && parsed.data.segmentLocalId === localId && parsed.data.segmentState === 'complete'
    ? parsed.data.sourceMessageId ?? null
    : null;
}

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

/**
 * Same ACP body shape as the full snapshot, but carrying ONLY the appended delta text. Receivers
 * reconstruct the accumulated text from per-segment assembly state.
 */
export function buildStreamedTranscriptSegmentDeltaBody(
  segment: StreamedTranscriptSegmentRuntime,
  deltaText: string,
): ACPMessageData {
  return segment.kind === 'assistant'
    ? {
        type: 'message',
        message: deltaText,
        ...(segment.sidechainId ? { sidechainId: segment.sidechainId } : {}),
      }
    : {
        type: 'thinking',
        text: deltaText,
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
    ...segment.meta,
    happierStreamSegmentV1: {
      v: 1,
      segmentKind: segment.kind,
      segmentLocalId: segment.segmentLocalId,
      segmentState: state,
      startedAtMs: segment.startedAtMs,
      updatedAtMs: nowMs,
      ...(segment.textGeneration > 0 ? { textGeneration: segment.textGeneration } : {}),
      ...(segment.sourceMessageId ? { sourceMessageId: segment.sourceMessageId } : {}),
      ...(state === 'interrupted' && typeof interruptedReason === 'string' && interruptedReason
        ? { interruptedReason }
        : {}),
    },
  };
}
