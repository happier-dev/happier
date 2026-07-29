import {
    makeExternalSessionHistoricalImportLocalId,
    type ExternalSessionTranscriptRawMessageV1,
} from '@happier-dev/protocol';

import { normalizeRawMessages, type NormalizedMessage, type RawMessageNormalizationInput } from '@/sync/typesRaw';

export function normalizeExternalSessionTranscriptMessages(
    items: ReadonlyArray<ExternalSessionTranscriptRawMessageV1>,
    sourceIdentity?: Readonly<{ agentId: string; remoteSessionId: string }>,
): NormalizedMessage[] {
    return normalizeRawMessages(items.map((item): RawMessageNormalizationInput => ({
        id: sourceIdentity
            ? makeExternalSessionHistoricalImportLocalId({
                ...sourceIdentity,
                directItemId: item.id,
            })
            : item.id,
        localId: typeof item.localId === 'string' ? item.localId : null,
        createdAt: item.createdAtMs,
        // The projection classifies every row it emits; forwarding that role is what lets
        // normalization drop content-less event rows here exactly as it does for synced sessions.
        messageRole: item.messageRole ?? undefined,
        raw: item.raw,
    })));
}
