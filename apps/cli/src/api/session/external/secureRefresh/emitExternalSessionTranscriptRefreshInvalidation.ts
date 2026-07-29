import {
    EXTERNAL_SESSION_TRANSCRIPT_INVALIDATION_EVENT_V1,
    type ExternalSessionTranscriptInvalidationV1,
    type ExternalSessionTranscriptRefreshBindingV1,
} from '@happier-dev/protocol';

import {
    resolveExternalSessionTranscriptRefreshBinding as resolveCurrentTranscriptRefreshBinding,
} from './resolveExternalSessionTranscriptRefreshBinding';

export async function emitExternalSessionTranscriptRefreshInvalidation(params: Readonly<{
    sessionId: string;
    cursor: string | null;
    isCurrent?: () => boolean;
    emitExternalSessionTranscriptUpdate?: (
        payload: ExternalSessionTranscriptInvalidationV1,
    ) => void | Promise<void>;
    resolveTranscriptRefreshBinding?: (input: Readonly<{
        sessionId: string;
        cursor: string;
    }>) => Promise<ExternalSessionTranscriptRefreshBindingV1 | null>;
}>): Promise<void> {
    if (
        !params.emitExternalSessionTranscriptUpdate
        || !params.cursor
        || params.isCurrent?.() === false
    ) {
        return;
    }
    const resolveTranscriptRefreshBinding =
        params.resolveTranscriptRefreshBinding ?? resolveCurrentTranscriptRefreshBinding;
    const binding = await resolveTranscriptRefreshBinding({
        sessionId: params.sessionId,
        cursor: params.cursor,
    }).catch(() => null);
    if (!binding || params.isCurrent?.() === false) return;
    await Promise.resolve(params.emitExternalSessionTranscriptUpdate({
        v: 1,
        type: EXTERNAL_SESSION_TRANSCRIPT_INVALIDATION_EVENT_V1,
        binding,
    })).catch(() => undefined);
}
