import {
    buildSystemSessionMetadataV1,
    readSystemSessionMetadataFromMetadata,
    VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_KEY,
    VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
} from '@happier-dev/protocol';

export {
    VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_KEY,
    VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
};

export function buildVoiceTranscriptHistorySessionMetadata(): Readonly<{
    systemSessionV1: Readonly<{
        v: 1;
        key: typeof VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_KEY;
        hidden: true;
    }>;
}> {
    return buildSystemSessionMetadataV1({
        key: VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_KEY,
        hidden: true,
    }) as Readonly<{
        systemSessionV1: Readonly<{
            v: 1;
            key: typeof VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_KEY;
            hidden: true;
        }>;
    }>;
}

export function isVoiceTranscriptHistorySession(session: Readonly<{
    active?: unknown;
    metadata?: unknown;
}> | null | undefined): boolean {
    if (!session || session.active !== false) return false;
    const marker = readSystemSessionMetadataFromMetadata({
        metadata: session.metadata,
    });
    return marker?.v === 1
        && marker.key === VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_KEY
        && marker.hidden === true;
}

export type DirectMediaTranscriptSessionResolutionDeps = Readonly<{
    ensureTargetSession(sessionId: string): Promise<void>;
    ensureHistorySession(): Promise<string>;
}>;

export async function resolveDirectMediaTranscriptSession(
    deps: DirectMediaTranscriptSessionResolutionDeps,
    input: Readonly<{ requestedTargetSessionId: string | null }>,
): Promise<string> {
    const targetSessionId = String(input.requestedTargetSessionId ?? '').trim();
    if (targetSessionId) {
        await deps.ensureTargetSession(targetSessionId);
        return targetSessionId;
    }
    const historySessionId = String(await deps.ensureHistorySession()).trim();
    if (!historySessionId) {
        throw new Error('Voice transcript history session acquisition returned no session');
    }
    return historySessionId;
}
