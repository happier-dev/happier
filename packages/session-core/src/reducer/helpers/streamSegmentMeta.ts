import { SessionMessageStreamSegmentV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessageMeta';
import { createStoredReadSchema } from '@happier-dev/protocol/json/storedReadSchema';

const StreamSegmentReadSchema = createStoredReadSchema(SessionMessageStreamSegmentV1Schema);

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
  const parsed = StreamSegmentReadSchema.safeParse(segment);
  if (!parsed.success) return null;
  const { segmentKind, segmentLocalId, segmentState, updatedAtMs } = parsed.data;
  return { v: 1, segmentKind, segmentLocalId: segmentLocalId ?? null,
    segmentState: segmentState ?? null, updatedAtMs: updatedAtMs ?? null };
}
