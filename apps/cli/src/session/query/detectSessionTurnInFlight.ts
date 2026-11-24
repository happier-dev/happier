import { readSessionTranscriptTurnActivity, type SessionTurnActivity } from '@happier-dev/session-core/transcript';
export { isMemoryArtifactDecryptedRow, isSessionAgentThreadTextUserMessage, isSessionAgentMessage } from '@happier-dev/session-core/transcript';

import { decodeBase64, decrypt } from '@/api/encryption';
import { fetchEncryptedTranscriptMessagesPage, MAX_TRANSCRIPT_MESSAGES_PAGE_SIZE, resolveTranscriptFetchTimeoutMs } from '@/session/replay/fetchEncryptedTranscriptMessages';
export { detectSessionTurnActivityFromProjection, readSessionProjectedPendingInputCount, readSessionProjectedPendingRequestCount,
    readSessionProjectedTurnStatus, type SessionTurnActivity } from '@happier-dev/session-core/transcript';

type SessionStoredContentEncryptionMode = 'e2ee' | 'plain';

export class SessionTurnActivityUnavailableError extends Error {
    readonly originalError: unknown;

    constructor(originalError: unknown) {
        super('Session transcript activity is unavailable');
        this.name = 'SessionTurnActivityUnavailableError';
        this.originalError = originalError;
    }
}

function tryDecryptTranscriptEnvelope(params: Readonly<{
    content: { t: 'encrypted'; c: string } | { t: 'plain'; v: unknown };
    encryptionMode: SessionStoredContentEncryptionMode;
    encryptionKey: Uint8Array | null;
    encryptionVariant: 'legacy' | 'dataKey' | null;
}>): unknown | null {
    if (params.content.t === 'plain') return params.content.v;
    if (!params.encryptionKey || !params.encryptionVariant) {
        throw new SessionTurnActivityUnavailableError(
            new Error('Session encryption material is unavailable'),
        );
    }
    try {
        return decrypt(
            params.encryptionKey,
            params.encryptionVariant,
            decodeBase64(params.content.c, 'base64'),
        );
    } catch (error) {
        throw new SessionTurnActivityUnavailableError(error);
    }
}

export async function detectSessionTurnActivity(params: Readonly<{
    token: string;
    sessionId: string;
    encryptionMode: SessionStoredContentEncryptionMode;
    encryptionKey: Uint8Array | null;
    encryptionVariant: 'legacy' | 'dataKey' | null;
    afterSeqExclusive?: number;
    readyCompletesPendingUserTurns?: boolean;
    transcriptFetchTimeoutMs?: number;
    deadlineAtMs?: number;
    resolveAuthorizationHeaders?: Parameters<typeof fetchEncryptedTranscriptMessagesPage>[0]['resolveAuthorizationHeaders'];
    signal?: AbortSignal;
}>): Promise<SessionTurnActivity> {
    if (params.signal?.aborted) throw new SessionTurnActivityUnavailableError(params.signal.reason);

    try {
        const timeoutMs = resolveTranscriptFetchTimeoutMs(params.transcriptFetchTimeoutMs);
        const deadlineAtMs = params.deadlineAtMs ?? Date.now() + timeoutMs;
        const assertReadActive = () => {
            params.signal?.throwIfAborted();
            if (Date.now() >= deadlineAtMs) throw new Error('Transcript read deadline exceeded');
        };
        assertReadActive();
        const readOptions = { timeoutMs, deadlineAtMs, ...(params.signal ? { signal: params.signal } : {}), ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}) };
        return await readSessionTranscriptTurnActivity({
            afterSeqExclusive: params.afterSeqExclusive,
            readyCompletesPendingUserTurns: params.readyCompletesPendingUserTurns,
            assertReadActive,
            maxPageSize: MAX_TRANSCRIPT_MESSAGES_PAGE_SIZE,
            readPage: pagination => fetchEncryptedTranscriptMessagesPage({
                token: params.token, sessionId: params.sessionId, projection: 'activity', ...pagination, ...readOptions,
            }),
            openRow: row => tryDecryptTranscriptEnvelope({
                content: row.content, encryptionMode: params.encryptionMode,
                encryptionKey: params.encryptionKey, encryptionVariant: params.encryptionVariant,
            }),
        });
    } catch (error) {
        if (error instanceof SessionTurnActivityUnavailableError) {
            throw error;
        }
        throw new SessionTurnActivityUnavailableError(error);
    }
}

export async function detectSessionTurnInFlight(params: Readonly<{
    token: string;
    sessionId: string;
    encryptionMode: SessionStoredContentEncryptionMode;
    encryptionKey: Uint8Array;
    encryptionVariant: 'legacy' | 'dataKey';
    afterSeqExclusive?: number;
}>): Promise<boolean> {
    const activity = await detectSessionTurnActivity(params);
    return activity.turnInFlight;
}
