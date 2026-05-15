import { coerceSessionUserPromptV1 } from '@happier-dev/protocol';

import type { ApiMessage } from '@/sync/api/types/apiTypes';
import { ApiSessionMessagesResponseSchema } from '@/sync/api/types/apiTypes';
import { readStoredSessionMessage } from '@/sync/runtime/readStoredSessionContent';

type SessionMessagesEncryptionMode = 'e2ee' | 'plain';

type DecryptedSessionMessage = Readonly<{
    id: string;
    seq?: number | null;
    localId: string | null;
    content: unknown | null;
    createdAt: number;
}>;

type SessionMessagesEncryption = {
    decryptMessages: (messages: ApiMessage[]) => Promise<Array<DecryptedSessionMessage | null>>;
};

export const USER_MESSAGE_HISTORY_REMOTE_PAGE_SIZE = 25;

export type UserMessageHistoryRemoteEntry = Readonly<{
    seq: number;
    createdAt: number;
    text: string;
}>;

export type FetchUserMessageHistoryPageResult =
    | Readonly<{ status: 'loaded'; entries: UserMessageHistoryRemoteEntry[]; hasMore: boolean; nextBeforeSeq: number | null }>
    | Readonly<{ status: 'not_ready' | 'unsupported' | 'error' }>;

function normalizeHistoryPageLimit(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return USER_MESSAGE_HISTORY_REMOTE_PAGE_SIZE;
    return Math.min(100, Math.max(1, Math.trunc(value)));
}

function normalizeBeforeSeq(value: number | null | undefined): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.max(1, Math.trunc(value));
}

function buildUserMessageHistoryPath(params: Readonly<{
    sessionId: string;
    limit: number;
    beforeSeq: number | null;
}>): string {
    const qs = new URLSearchParams({
        scope: 'main',
        role: 'user',
        limit: String(params.limit),
    });
    if (params.beforeSeq !== null) {
        qs.set('beforeSeq', String(params.beforeSeq));
    }
    return `/v1/sessions/${encodeURIComponent(params.sessionId)}/messages?${qs.toString()}`;
}

async function decryptUserHistoryMessages(params: Readonly<{
    sessionId: string;
    messages: ApiMessage[];
    sessionEncryptionMode: SessionMessagesEncryptionMode;
    getSessionEncryption: (sessionId: string) => SessionMessagesEncryption | null;
}>): Promise<Array<DecryptedSessionMessage | null> | null> {
    if (params.sessionEncryptionMode === 'plain') {
        return Promise.all(params.messages.map((message) => readStoredSessionMessage({ message })));
    }

    const encryption = params.getSessionEncryption(params.sessionId);
    if (!encryption) return null;
    return encryption.decryptMessages(params.messages);
}

function extractUserHistoryEntries(messages: ReadonlyArray<DecryptedSessionMessage | null>): UserMessageHistoryRemoteEntry[] {
    const entries: UserMessageHistoryRemoteEntry[] = [];
    for (const message of messages) {
        if (!message || message.content === null) continue;
        const prompt = coerceSessionUserPromptV1(message.content);
        if (!prompt) continue;
        const text = prompt.text.trim();
        const seq = typeof message.seq === 'number' && Number.isFinite(message.seq) ? Math.trunc(message.seq) : null;
        if (!text || seq === null) continue;
        entries.push({
            seq,
            createdAt: message.createdAt,
            text,
        });
    }
    return entries;
}

export async function fetchUserMessageHistoryPage(params: Readonly<{
    sessionId: string;
    beforeSeq?: number | null;
    limit?: number;
    sessionEncryptionMode?: SessionMessagesEncryptionMode;
    request: (path: string) => Promise<Response>;
    getSessionEncryption: (sessionId: string) => SessionMessagesEncryption | null;
}>): Promise<FetchUserMessageHistoryPageResult> {
    const sessionId = String(params.sessionId ?? '').trim();
    if (!sessionId) return { status: 'not_ready' };

    const sessionEncryptionMode = params.sessionEncryptionMode === 'plain' ? 'plain' : 'e2ee';
    if (sessionEncryptionMode === 'e2ee' && !params.getSessionEncryption(sessionId)) {
        return { status: 'not_ready' };
    }

    const limit = normalizeHistoryPageLimit(params.limit);
    const beforeSeq = normalizeBeforeSeq(params.beforeSeq);

    try {
        const response = await params.request(buildUserMessageHistoryPath({ sessionId, limit, beforeSeq }));
        if (!response.ok) {
            return response.status === 400 || response.status === 404 || response.status === 405 || response.status === 501
                ? { status: 'unsupported' }
                : { status: 'error' };
        }

        const parsed = ApiSessionMessagesResponseSchema.safeParse(await response.json());
        if (!parsed.success) return { status: 'unsupported' };

        const decrypted = await decryptUserHistoryMessages({
            sessionId,
            messages: parsed.data.messages,
            sessionEncryptionMode,
            getSessionEncryption: params.getSessionEncryption,
        });
        if (!decrypted) return { status: 'not_ready' };

        return {
            status: 'loaded',
            entries: extractUserHistoryEntries(decrypted),
            hasMore: parsed.data.hasMore === true,
            nextBeforeSeq: typeof parsed.data.nextBeforeSeq === 'number' ? parsed.data.nextBeforeSeq : null,
        };
    } catch {
        return { status: 'error' };
    }
}
