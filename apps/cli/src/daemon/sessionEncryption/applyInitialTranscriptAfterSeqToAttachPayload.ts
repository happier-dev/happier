import type { SessionAttachFilePayload } from '@/agent/runtime/sessionAttachPayload';

export function normalizeInitialTranscriptAfterSeq(value: unknown): number | undefined {
  if (typeof value !== 'number') return undefined;
  if (!Number.isInteger(value)) return undefined;
  if (value < 0) return undefined;
  return value;
}

export function applyInitialTranscriptAfterSeqToAttachPayload(
  payload: SessionAttachFilePayload,
  initialTranscriptAfterSeq: unknown,
): SessionAttachFilePayload {
  const normalizedInitialTranscriptAfterSeq = normalizeInitialTranscriptAfterSeq(initialTranscriptAfterSeq);
  if (normalizedInitialTranscriptAfterSeq === undefined) {
    return payload;
  }

  return {
    ...payload,
    lastObservedMessageSeq: normalizedInitialTranscriptAfterSeq,
    initialTranscriptAfterSeq: normalizedInitialTranscriptAfterSeq,
  };
}
