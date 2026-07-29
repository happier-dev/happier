import { EXTERNAL_SESSION_HISTORICAL_IMPORT_LOCAL_ID_PREFIX } from '@happier-dev/protocol';

import type { NormalizedMessage } from '@/sync/typesRaw';

import type { ExternalSessionTranscriptAuthority } from './externalSessionTranscriptAuthority';

function hasHistoricalImportIdentity(value: unknown): value is string {
    return typeof value === 'string'
        && value.startsWith(EXTERNAL_SESSION_HISTORICAL_IMPORT_LOCAL_ID_PREFIX);
}

function isWithinServerBound(message: NormalizedMessage, maxServerSeq: number): boolean {
    return typeof message.seq === 'number'
        && Number.isSafeInteger(message.seq)
        && message.seq >= 0
        && message.seq <= maxServerSeq;
}

export function filterExternalSessionTranscriptAuthorityMessages(
    messages: readonly NormalizedMessage[],
    authority: ExternalSessionTranscriptAuthority,
): NormalizedMessage[] {
    if (authority.kind === 'unavailable') return [];
    if (authority.kind === 'hosted') return messages.slice();
    if (authority.kind === 'live_agent') {
        // Persisted rows keep their server id even when their localId records the
        // imported identity. Only Agent normalization emits that identity as id.
        return messages.filter((message) => hasHistoricalImportIdentity(message.id));
    }

    return messages
        .filter((message) => isWithinServerBound(message, authority.maxServerSeq))
        .map((message) => (
            hasHistoricalImportIdentity(message.localId)
                ? { ...message, id: message.localId }
                : message
        ));
}
