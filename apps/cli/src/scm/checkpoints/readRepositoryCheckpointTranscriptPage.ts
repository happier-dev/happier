import { SessionMessageV1Schema } from '@happier-dev/protocol';
import { SESSION_TRANSCRIPT_GET_MAX_LIMIT } from '@happier-dev/protocol/actions';
import type { StoredCredentials } from '@/persistence';
import { resolveSessionTransportContext } from '@/session/services/resolveSessionTransportContext';
import { fetchEncryptedTranscriptMessagesPage } from '@/session/replay/fetchEncryptedTranscriptMessages';
import { openSessionMessageContent } from '@/session/transport/encryption/sessionEncryptionContext';

export type ReadRepositoryCheckpointTranscriptPage = (input: Readonly<{
    sessionId: string; afterSeq?: number;
}>) => Promise<Readonly<{
    messages: readonly Readonly<{ content: unknown; seq: number; createdAt: number; localId?: string | null }>[];
    hasMore: boolean; nextAfterSeq: number | null;
}>>;

/** Transport adapter: reuse currentness, authorization and the one mode-aware content opener. */
export function createRepositoryCheckpointTranscriptPageReader(input: Readonly<{
    credentials: StoredCredentials;
    resolveAuthorizationHeaders?: (request: Readonly<{ method: 'GET' | 'POST'; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
    signal?: AbortSignal;
}>): ReadRepositoryCheckpointTranscriptPage {
    return async ({ sessionId, afterSeq }) => {
        const target = await resolveSessionTransportContext({ ...input, idOrPrefix: sessionId });
        if (!target.ok || target.sessionId !== sessionId) throw new Error(target.ok ? 'Checkpoint transcript resolved a different session' : target.code);
        const page = await fetchEncryptedTranscriptMessagesPage({ token: input.credentials.token, sessionId,
            limit: SESSION_TRANSCRIPT_GET_MAX_LIMIT, afterSeq: afterSeq ?? 0, scope: 'main',
            ...(input.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: input.resolveAuthorizationHeaders } : {}),
            ...(input.signal ? { signal: input.signal } : {}) });
        return { messages: page.messages.map((row) => {
            const parsed = SessionMessageV1Schema.parse(row);
            return { content: openSessionMessageContent({ ...target, content: parsed.content }), seq: parsed.seq,
                createdAt: parsed.createdAt, localId: parsed.localId };
        }), hasMore: page.hasMore, nextAfterSeq: page.nextAfterSeq };
    };
}
