import axios from 'axios';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

import { configuration } from '@/configuration';
import { resolveLoopbackHttpUrl } from '../client/loopbackUrl';
import { SessionMessageContentSchema, type SessionMessageContent } from '../types';

const KEEP_ALIVE_HTTP_AGENT = new HttpAgent({ keepAlive: true, maxSockets: 16 });
const KEEP_ALIVE_HTTPS_AGENT = new HttpsAgent({ keepAlive: true, maxSockets: 16 });

export type TranscriptMessageLookupResult = {
    id: string;
    seq: number;
    localId: string | null;
    content: SessionMessageContent;
};

function createAxiosGetConfig(params: { token: string; timeoutMs?: number }) {
    return {
        headers: {
            Authorization: `Bearer ${params.token}`,
            'Content-Type': 'application/json',
        },
        timeout: params.timeoutMs ?? configuration.transcriptLookupRequestTimeoutMs,
        ...(configuration.transcriptLookupKeepAliveEnabled
            ? { httpAgent: KEEP_ALIVE_HTTP_AGENT, httpsAgent: KEEP_ALIVE_HTTPS_AGENT }
            : null),
    } as const;
}

function isV2MessageNotFoundError(error: unknown): boolean {
    if (!axios.isAxiosError(error)) return false;
    if (error.response?.status !== 404) return false;
    const data = error.response?.data as unknown;
    if (!data || typeof data !== 'object') return false;
    const record = data as Record<string, unknown>;
    return record.error === 'Message not found';
}

function parseTranscriptLookupMessageFromUnknown(found: any): TranscriptMessageLookupResult | null {
    if (!found || typeof found !== 'object') return null;
    const content = SessionMessageContentSchema.safeParse(found.content);
    if (!content.success) return null;
    if (typeof found.id !== 'string') return null;
    if (typeof found.seq !== 'number') return null;
    const foundLocalId = typeof found.localId === 'string' ? found.localId : null;
    return { id: found.id, seq: found.seq, localId: foundLocalId, content: content.data };
}

async function findTranscriptEncryptedMessageByLocalIdV2(params: {
    token: string;
    serverUrl: string;
    sessionId: string;
    localId: string;
    onError?: (error: unknown) => void;
    timeoutMs?: number;
}): Promise<TranscriptMessageLookupResult | null> {
    try {
        const response = await axios.get(
            `${params.serverUrl}/v2/sessions/${params.sessionId}/messages/by-local-id/${encodeURIComponent(params.localId)}`,
            createAxiosGetConfig({ token: params.token, timeoutMs: params.timeoutMs })
        );
        const data = response?.data as unknown;
        const message = data && typeof data === 'object' ? (data as Record<string, unknown>).message : null;
        const parsed = parseTranscriptLookupMessageFromUnknown(message as any);
        if (!parsed) return null;
        return parsed;
    } catch (error) {
        if (isV2MessageNotFoundError(error)) return null;
        params.onError?.(error);
        return null;
    }
}

export async function findTranscriptEncryptedMessageByLocalId(params: {
    token: string;
    sessionId: string;
    localId: string;
    onError?: (error: unknown) => void;
    timeoutMs?: number;
}): Promise<TranscriptMessageLookupResult | null> {
    const serverUrl = resolveLoopbackHttpUrl(configuration.serverUrl).replace(/\/+$/, '');
    return await findTranscriptEncryptedMessageByLocalIdV2({
        token: params.token,
        serverUrl,
        sessionId: params.sessionId,
        localId: params.localId,
        timeoutMs: params.timeoutMs,
        onError: params.onError,
    });
}

export async function waitForTranscriptEncryptedMessageByLocalId(params: {
    token: string;
    sessionId: string;
    localId: string;
    maxWaitMs?: number;
    onError?: (error: unknown) => void;
    pollIntervalMs?: number;
    errorBackoffBaseMs?: number;
    errorBackoffMaxMs?: number;
    requestTimeoutMs?: number;
}): Promise<TranscriptMessageLookupResult | null> {
    const maxWaitMs = params.maxWaitMs ?? 5_000;
    const pollIntervalMs = params.pollIntervalMs ?? configuration.transcriptLookupPollIntervalMs;
    const errorBackoffBaseMs = params.errorBackoffBaseMs ?? configuration.transcriptLookupErrorBackoffBaseMs;
    const errorBackoffMaxMs = params.errorBackoffMaxMs ?? configuration.transcriptLookupErrorBackoffMaxMs;
    const requestTimeoutMs = params.requestTimeoutMs ?? configuration.transcriptLookupRequestTimeoutMs;
    const startedAt = Date.now();
    let currentErrorBackoffMs = errorBackoffBaseMs;
    while (Date.now() - startedAt < maxWaitMs) {
        const elapsedMs = Date.now() - startedAt;
        const remainingMs = maxWaitMs - elapsedMs;
        if (remainingMs <= 0) break;

        let hadError = false;
        const found = await findTranscriptEncryptedMessageByLocalId({
            token: params.token,
            sessionId: params.sessionId,
            localId: params.localId,
            timeoutMs: Math.max(1, Math.min(requestTimeoutMs, remainingMs)),
            onError: (error) => {
                hadError = true;
                params.onError?.(error);
            },
        });
        if (found) return found;

        const delayMs = hadError ? currentErrorBackoffMs : pollIntervalMs;
        if (hadError) {
            currentErrorBackoffMs = Math.min(errorBackoffMaxMs, currentErrorBackoffMs * 2);
        } else {
            currentErrorBackoffMs = errorBackoffBaseMs;
        }

        const remainingAfterAttemptMs = maxWaitMs - (Date.now() - startedAt);
        if (remainingAfterAttemptMs <= 0) break;

        await new Promise((r) => setTimeout(r, Math.min(delayMs, remainingAfterAttemptMs)));
    }
    return null;
}
