import { EXTERNAL_SESSION_HISTORICAL_IMPORT_LOCAL_ID_PREFIX } from '@happier-dev/protocol/sessions/external/historicalImportIdentity';

import type { NormalizedMessage } from "@happier-dev/session-core/raw";

import type { ExternalSessionTranscriptAuthority } from './externalSessionTranscriptAuthority';
import { readVoiceContinuationProvenance } from '@/voice/transcript/voiceTranscriptNoteMeta';

function hasHistoricalImportIdentity(value: unknown): value is string {
    return typeof value === 'string'
        && value.startsWith(EXTERNAL_SESSION_HISTORICAL_IMPORT_LOCAL_ID_PREFIX);
}

type TranscriptRowIdentity = Pick<NormalizedMessage, 'id' | 'localId' | 'seq'> & Readonly<{ meta?: unknown }>;

function isAcknowledgedHostContinuation(message: TranscriptRowIdentity): boolean {
    return typeof message.seq === 'number' && Number.isSafeInteger(message.seq) && message.seq >= 0
        && readVoiceContinuationProvenance(message.meta) !== null;
}

function isWithinServerBound(message: TranscriptRowIdentity, maxServerSeq: number): boolean {
    return typeof message.seq === 'number'
        && Number.isSafeInteger(message.seq)
        && message.seq >= 0
        && message.seq <= maxServerSeq;
}

export function filterExternalSessionTranscriptAuthorityMessages<T extends TranscriptRowIdentity>(
    messages: readonly T[],
    authority: ExternalSessionTranscriptAuthority,
): T[] {
    if (authority.kind === 'unavailable') return [];
    if (authority.kind === 'hosted') return messages.slice();
    if (authority.kind === 'live_agent') {
        // Persisted rows keep their server id even when their localId records the
        // imported identity. Only Agent normalization emits that identity as id.
        // A connected-device note is Account-authored conversation metadata,
        // not a competing persisted copy of the Agent's native transcript.
        return messages.filter((message) => hasHistoricalImportIdentity(message.id) || isAcknowledgedHostContinuation(message));
    }

    return messages
        .filter((message) => isWithinServerBound(message, authority.maxServerSeq) || isAcknowledgedHostContinuation(message))
        .map((message) => (
            hasHistoricalImportIdentity(message.localId)
                ? { ...message, id: message.localId }
                : message
        ));
}
