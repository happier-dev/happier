export type StreamSegmentKind = 'assistant' | 'thinking';
export type StreamSegmentState = 'streaming' | 'complete' | 'interrupted';

export type StreamSegmentMetaV1 = Readonly<{
  v: 1;
  segmentKind: StreamSegmentKind;
  segmentLocalId: string | null;
  segmentState: StreamSegmentState | null;
  updatedAtMs: number | null;
}>;

export function readStreamSegmentMetaV1(meta: unknown): StreamSegmentMetaV1 | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return null;
  const segment = (meta as Record<string, unknown>).happierStreamSegmentV1;
  if (!segment || typeof segment !== 'object' || Array.isArray(segment)) return null;
  const segmentRecord = segment as Record<string, unknown>;
  if (segmentRecord.v !== 1) return null;
  const segmentKind = segmentRecord.segmentKind;
  if (segmentKind !== 'assistant' && segmentKind !== 'thinking') return null;
  const segmentLocalIdRaw = segmentRecord.segmentLocalId;
  const segmentLocalId = typeof segmentLocalIdRaw === 'string' && segmentLocalIdRaw.length > 0
    ? segmentLocalIdRaw
    : null;
  const updatedAtMsRaw = segmentRecord.updatedAtMs;
  const updatedAtMs =
    typeof updatedAtMsRaw === 'number' && Number.isFinite(updatedAtMsRaw) ? updatedAtMsRaw : null;
  const segmentStateRaw = segmentRecord.segmentState;
  const segmentState =
    segmentStateRaw === 'streaming' || segmentStateRaw === 'complete' || segmentStateRaw === 'interrupted'
      ? segmentStateRaw
      : null;
  return { v: 1, segmentKind, segmentLocalId, segmentState, updatedAtMs };
}
