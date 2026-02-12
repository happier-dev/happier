import axios from 'axios';

import { configuration } from '@/configuration';
import { resolveLoopbackHttpUrl } from '../client/loopbackUrl';

export type TranscriptMessageLookupResult = {
    id: string;
    seq: number;
    localId: string | null;
    content: { t: 'encrypted'; c: string };
};

export async function findTranscriptEncryptedMessageByLocalId(params: {
    token: string;
    sessionId: string;
    localId: string;
    onError?: (error: unknown) => void;
}): Promise<TranscriptMessageLookupResult | null> {
    try {
        const serverUrl = resolveLoopbackHttpUrl(configuration.serverUrl).replace(/\/+$/, '');
        const response = await axios.get(`${serverUrl}/v1/sessions/${params.sessionId}/messages`, {
            headers: {
                Authorization: `Bearer ${params.token}`,
                'Content-Type': 'application/json',
            },
            timeout: 10_000,
        });
        const messages = (response?.data as any)?.messages;
        if (!Array.isArray(messages)) return null;
        const found = messages.find((m: any) => m && typeof m === 'object' && m.localId === params.localId);
        if (!found) return null;
        const content = found.content;
        if (!content || content.t !== 'encrypted' || typeof content.c !== 'string') return null;
        if (typeof found.id !== 'string') return null;
        if (typeof found.seq !== 'number') return null;
        const foundLocalId = typeof found.localId === 'string' ? found.localId : null;
        return { id: found.id, seq: found.seq, localId: foundLocalId, content: { t: 'encrypted', c: content.c } };
    } catch (error) {
        params.onError?.(error);
        return null;
    }
}

export async function waitForTranscriptEncryptedMessageByLocalId(params: {
    token: string;
    sessionId: string;
    localId: string;
    maxWaitMs?: number;
    onError?: (error: unknown) => void;
}): Promise<TranscriptMessageLookupResult | null> {
    const maxWaitMs = params.maxWaitMs ?? 5_000;
    const startedAt = Date.now();
    while (Date.now() - startedAt < maxWaitMs) {
        const found = await findTranscriptEncryptedMessageByLocalId({
            token: params.token,
            sessionId: params.sessionId,
            localId: params.localId,
            onError: params.onError,
        });
        if (found) return found;
        await new Promise((r) => setTimeout(r, 150));
    }
    return null;
}
