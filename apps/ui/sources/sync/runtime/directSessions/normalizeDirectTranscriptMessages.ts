import type { DirectTranscriptRawMessageV1 } from '@happier-dev/protocol';

import { normalizeRawMessage, RawRecordSchema, type NormalizedMessage } from '@/sync/typesRaw';

export function normalizeDirectTranscriptMessages(items: ReadonlyArray<DirectTranscriptRawMessageV1>): NormalizedMessage[] {
    const out: NormalizedMessage[] = [];
    for (const item of items) {
        const parsedRaw = RawRecordSchema.safeParse(item.raw);
        if (!parsedRaw.success) continue;
        const normalized = normalizeRawMessage(
            item.id,
            typeof item.localId === 'string' ? item.localId : null,
            item.createdAtMs,
            parsedRaw.data,
        );
        if (normalized) out.push(normalized);
    }
    return out;
}
