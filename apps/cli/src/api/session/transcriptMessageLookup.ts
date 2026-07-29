import axios from 'axios';
import type { ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '../client/serverHttpBaseUrl';
import { SessionMessageContentSchema, type SessionMessageContent } from '../types';
import { readAuthenticationStatus, readHttpStatus } from '@/api/client/httpStatusError';
import { TranscriptRecoveryCoordinator, type TranscriptRecoveryResult } from './recovery/TranscriptRecoveryCoordinator';

const KEEP_ALIVE_HTTP_AGENT = new HttpAgent({ keepAlive: true, maxSockets: 16 });
const KEEP_ALIVE_HTTPS_AGENT = new HttpsAgent({ keepAlive: true, maxSockets: 16 });

export type TranscriptMessageLookupResult = {
    id: string;
    seq: number;
    localId: string | null;
    sidechainId: string | null;
    createdAt: number;
    updatedAt: number;
    content: SessionMessageContent;
};

export type TranscriptLookupOutcome =
    | { type: 'found'; message: TranscriptMessageLookupResult }
    | { type: 'not_found' }
    | { type: 'auth_failed'; statusCode: 401 | 403; error: unknown }
    | { type: 'unhealthy'; reason: 'timeout' | 'network' | 'server_5xx'; error: unknown }
    | { type: 'protocol_error'; error: unknown };

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

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function isV2MessageNotFoundError(error: unknown): boolean {
    if (!axios.isAxiosError(error)) return false;
    if (error.response?.status !== 404) return false;
    const record = asRecord(error.response?.data);
    if (!record) return false;
    return record.error === 'Message not found';
}

function isLegacyV2RouteMissingError(error: unknown): boolean {
    if (!axios.isAxiosError(error)) return false;
    if (error.response?.status !== 404) return false;
    const record = asRecord(error.response?.data);
    if (!record) return false;
    if (record.error !== 'Not found') return false;
    const method = record.method;
    if (typeof method === 'string' && method.toUpperCase() !== 'GET') return false;
    const path = typeof record.path === 'string' ? record.path : '';
    if (path) {
        return path.includes('/v2/sessions/') && path.includes('/messages/by-local-id/');
    }
    return !isV2MessageNotFoundError(error);
}

function readErrorCode(error: unknown): string | null {
    const code = asRecord(error)?.code;
    return typeof code === 'string' ? code : null;
}

function readErrorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    const message = asRecord(error)?.message;
    return typeof message === 'string' ? message : '';
}

function isTimeoutError(error: unknown): boolean {
    const code = readErrorCode(error);
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return true;
    const message = readErrorMessage(error).toLowerCase();
    return message.includes('timeout') || message.includes('timed out');
}

function isNetworkError(error: unknown): boolean {
    const code = readErrorCode(error);
    if (
        code === 'ECONNREFUSED'
        || code === 'ECONNRESET'
        || code === 'ENOTFOUND'
        || code === 'EAI_AGAIN'
        || code === 'ENETUNREACH'
        || code === 'EHOSTUNREACH'
        || code === 'ERR_NETWORK'
    ) {
        return true;
    }
    return axios.isAxiosError(error) && !error.response;
}

function createUnexpectedTranscriptLookupStatusError(status: number): Error {
    return new Error(`Unexpected transcript lookup status: ${status}`);
}

function createMalformedTranscriptLookupResponseError(): Error {
    return new Error('Malformed transcript lookup response');
}

function classifyUnhealthyTranscriptLookup(error: unknown): TranscriptLookupOutcome | null {
    if (isTimeoutError(error)) return { type: 'unhealthy', reason: 'timeout', error };
    const status = readHttpStatus(error);
    if (typeof status === 'number' && status >= 500) return { type: 'unhealthy', reason: 'server_5xx', error };
    if (isNetworkError(error)) return { type: 'unhealthy', reason: 'network', error };
    return null;
}

function parseTranscriptLookupMessageFromUnknown(found: unknown): TranscriptMessageLookupResult | null {
    const record = asRecord(found);
    if (!record) return null;
    const content = SessionMessageContentSchema.safeParse(record.content);
    if (!content.success) return null;
    if (typeof record.id !== 'string') return null;
    if (typeof record.seq !== 'number') return null;
    const foundLocalId = typeof record.localId === 'string' ? record.localId : null;
    const sidechainIdRaw = record.sidechainId;
    const sidechainId = typeof sidechainIdRaw === 'string' ? (sidechainIdRaw.trim() || null) : null;
    const createdAtRaw = record.createdAt;
    if (!(typeof createdAtRaw === 'number' && Number.isSafeInteger(createdAtRaw) && createdAtRaw >= 0)) return null;
    const updatedAtRaw = record.updatedAt;
    if (!(typeof updatedAtRaw === 'number' && Number.isSafeInteger(updatedAtRaw) && updatedAtRaw >= 0)) return null;
    return {
        id: record.id,
        seq: record.seq,
        localId: foundLocalId,
        sidechainId,
        createdAt: createdAtRaw,
        updatedAt: updatedAtRaw,
        content: content.data,
    };
}

export async function findTranscriptEncryptedMessageByLocalIdV2(params: {
    token: string;
    serverUrl: string;
    sessionId: string;
    localId: string;
    timeoutMs?: number;
}): Promise<TranscriptLookupOutcome> {
    try {
        const response = await axios.get(
            `${params.serverUrl}/v2/sessions/${params.sessionId}/messages/by-local-id/${encodeURIComponent(params.localId)}`,
            createAxiosGetConfig({ token: params.token, timeoutMs: params.timeoutMs })
        );
        const status = typeof response?.status === 'number' ? response.status : null;
        if (typeof status === 'number' && status >= 500) {
            return { type: 'unhealthy', reason: 'server_5xx', error: createUnexpectedTranscriptLookupStatusError(status) };
        }
        if (status !== 200) {
            return { type: 'protocol_error', error: createUnexpectedTranscriptLookupStatusError(status ?? 0) };
        }
        const message = asRecord(response?.data)?.message;
        const parsed = parseTranscriptLookupMessageFromUnknown(message);
        if (!parsed) return { type: 'protocol_error', error: createMalformedTranscriptLookupResponseError() };
        return { type: 'found', message: parsed };
    } catch (error) {
        if (isV2MessageNotFoundError(error)) return { type: 'not_found' };
        const authStatus = readAuthenticationStatus(error);
        if (authStatus !== null) return { type: 'auth_failed', statusCode: authStatus, error };
        const unhealthy = classifyUnhealthyTranscriptLookup(error);
        if (unhealthy) return unhealthy;
        return { type: 'protocol_error', error };
    }
}

function normalizeTranscriptLookupOutcomeForWait(outcome: TranscriptLookupOutcome): TranscriptLookupOutcome {
    if (outcome.type === 'protocol_error' && isLegacyV2RouteMissingError(outcome.error)) {
        return { type: 'not_found' };
    }
    return outcome;
}

export async function findTranscriptEncryptedMessageByLocalId(params: {
    token: string;
    sessionId: string;
    localId: string;
    onError?: (error: unknown) => void;
    timeoutMs?: number;
}): Promise<TranscriptMessageLookupResult | null> {
    const serverUrl = resolveServerHttpBaseUrl();
    const outcome = await findTranscriptEncryptedMessageByLocalIdV2({
        token: params.token,
        serverUrl,
        sessionId: params.sessionId,
        localId: params.localId,
        timeoutMs: params.timeoutMs,
    });
    switch (outcome.type) {
        case 'found':
            return outcome.message;
        case 'not_found':
            return null;
        case 'auth_failed':
            throw outcome.error;
        case 'unhealthy':
        case 'protocol_error':
            params.onError?.(outcome.error);
            return null;
    }
}

export async function waitForTranscriptEncryptedMessageByLocalId(params: {
    token: string;
    sessionId: string;
    localId: string;
    supervisor?: ManagedConnectionSupervisor;
    maxWaitMs?: number;
    onError?: (error: unknown) => void;
    pollIntervalMs?: number;
    errorBackoffBaseMs?: number;
    errorBackoffMaxMs?: number;
    requestTimeoutMs?: number;
    onUnsupported?: (error: unknown) => void;
}): Promise<TranscriptMessageLookupResult | null> {
    const maxWaitMs = params.maxWaitMs ?? 5_000;
    const pollIntervalMs = params.pollIntervalMs ?? configuration.transcriptLookupPollIntervalMs;
    const errorBackoffBaseMs = params.errorBackoffBaseMs ?? configuration.transcriptLookupErrorBackoffBaseMs;
    const errorBackoffMaxMs = params.errorBackoffMaxMs ?? configuration.transcriptLookupErrorBackoffMaxMs;
    const requestTimeoutMs = params.requestTimeoutMs ?? configuration.transcriptLookupRequestTimeoutMs;
    const serverUrl = resolveServerHttpBaseUrl();
    if (params.supervisor) {
        return await waitForTranscriptEncryptedMessageByLocalIdWithSupervisor({
            ...params,
            supervisor: params.supervisor,
            serverUrl,
            maxWaitMs,
            pollIntervalMs,
            errorBackoffBaseMs,
            requestTimeoutMs,
        });
    }

    const startedAt = Date.now();
    let currentErrorBackoffMs = errorBackoffBaseMs;
    while (Date.now() - startedAt < maxWaitMs) {
        const elapsedMs = Date.now() - startedAt;
        const remainingMs = maxWaitMs - elapsedMs;
        if (remainingMs <= 0) break;

        let hadError = false;
        const outcome = await findTranscriptEncryptedMessageByLocalIdV2({
            token: params.token,
            serverUrl,
            sessionId: params.sessionId,
            localId: params.localId,
            timeoutMs: Math.max(1, Math.min(requestTimeoutMs, remainingMs)),
        });
        switch (outcome.type) {
            case 'found':
                return outcome.message;
            case 'not_found':
                break;
            case 'auth_failed':
                throw outcome.error;
            case 'unhealthy':
                hadError = true;
                params.onError?.(outcome.error);
                break;
            case 'protocol_error':
                if (isLegacyV2RouteMissingError(outcome.error)) {
                    params.onUnsupported?.(outcome.error);
                    return null;
                }
                hadError = true;
                params.onError?.(outcome.error);
                break;
        }

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

async function waitForTranscriptEncryptedMessageByLocalIdWithSupervisor(params: {
    token: string;
    serverUrl: string;
    sessionId: string;
    localId: string;
    supervisor: ManagedConnectionSupervisor;
    maxWaitMs: number;
    pollIntervalMs: number;
    errorBackoffBaseMs: number;
    requestTimeoutMs: number;
    onError?: (error: unknown) => void;
    onUnsupported?: (error: unknown) => void;
}): Promise<TranscriptMessageLookupResult | null> {
    const coordinator = TranscriptRecoveryCoordinator.forServer(params.serverUrl);
    const startedAt = Date.now();

    while (Date.now() - startedAt < params.maxWaitMs) {
        const elapsedMs = Date.now() - startedAt;
        const remainingMs = params.maxWaitMs - elapsedMs;
        if (remainingMs <= 0) break;

        const result = await coordinator.scheduleByLocalId({
            sessionId: params.sessionId,
            localId: params.localId,
            supervisor: params.supervisor,
            runRequest: () => runSupervisedRequest({
                supervisor: params.supervisor,
                purpose: 'recovery_read',
                request: async () => await findTranscriptEncryptedMessageByLocalIdV2({
                    token: params.token,
                    serverUrl: params.serverUrl,
                    sessionId: params.sessionId,
                    localId: params.localId,
                    timeoutMs: Math.max(1, Math.min(params.requestTimeoutMs, remainingMs)),
                }),
            }),
        });

        if (result.type === 'success') return result.value;
        if (result.type === 'error' && result.reason === 'auth_failed') throw result.error;
        if (result.type === 'error') {
            if (result.reason === 'protocol_error' && isLegacyV2RouteMissingError(result.error)) {
                params.onUnsupported?.(result.error);
                return null;
            }
            params.onError?.(result.error);
        }

        const remainingAfterAttemptMs = params.maxWaitMs - (Date.now() - startedAt);
        if (remainingAfterAttemptMs <= 0) break;

        await new Promise((resolve) => setTimeout(
            resolve,
            Math.min(resolveRecoveryResultDelayMs(result, params), remainingAfterAttemptMs),
        ));
    }

    return null;
}

function resolveRecoveryResultDelayMs(
    result: TranscriptRecoveryResult<TranscriptMessageLookupResult>,
    params: { pollIntervalMs: number; errorBackoffBaseMs: number },
): number {
    switch (result.type) {
        case 'success':
            return 0;
        case 'not_found':
            return params.pollIntervalMs;
        case 'error':
            return params.errorBackoffBaseMs;
        case 'deferred':
            return Math.max(params.pollIntervalMs, params.errorBackoffBaseMs);
    }
}
