import { makeExternalSessionHistoricalImportLocalId } from '@happier-dev/protocol/sessions/external/historicalImportIdentity';
import type { ExternalSessionTranscriptRawMessageV1 } from '@happier-dev/protocol/sessions/external/daemonRpcV1';

import { normalizeRawMessages, type NormalizedMessage, type RawMessageNormalizationInput } from "@happier-dev/session-core/raw";

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
        sidechainId: item.sidechainId ?? undefined,
        createdAt: item.createdAtMs,
        // The projection classifies every row it emits; forwarding that role is what lets
        // normalization drop content-less event rows here exactly as it does for synced sessions.
        messageRole: item.messageRole ?? undefined,
        raw: item.raw,
    })));
}
