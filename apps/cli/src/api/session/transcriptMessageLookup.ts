import { createExternalActionHeaderRefusalError } from '@/api/externalActionHeaderRefusal';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from '@/api/client/credentialAxios';
import { type AxiosError } from 'axios';
import type { ManagedConnectionSupervisor } from '@happier-dev/connection-supervisor';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';

import { runSupervisedRequest } from '@/api/connection/requestSupervision/runSupervisedRequest';
import { configuration } from '@/configuration';
import { resolveServerHttpBaseUrl } from '../client/serverHttpBaseUrl';
import { SessionMessageContentSchema, type SessionMessageContent } from '../types';
import { readAuthenticationStatus, readHttpStatus } from '@/api/client/httpStatusError';
import { isNetworkConnectionErrorCode } from '@/api/client/classifyServerEndpointError';
import { TranscriptRecoveryCoordinator } from './recovery/TranscriptRecoveryCoordinator';
import { openSessionEventSource } from '@/session/transport/socket/sessionSocketAgentState';
import { SessionInputAdmissionReceiptV1Schema, SessionInputRefusalDispositionV1Schema, type SessionInputAdmissionReceiptV1, type SessionInputRefusalDispositionV1 } from '@happier-dev/protocol/sessions/messages/sessionInputAdmission';
import { SessionMessageRoleSchema, type SessionMessageRole } from '@happier-dev/protocol/sessions/messages/sessionMessageRole';
import { SessionTurnV1Schema, type SessionTurnV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnV1';
import { readStoredSessionMessageDeliveryResolutionV1, type SessionMessageDeliveryResolutionV1 } from '@happier-dev/protocol/sessions/messages/sessionMessageDeliveryResolutionV1';

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
    messageRole?: SessionMessageRole;
    inputAdmissionReceipt?: SessionInputAdmissionReceiptV1;
    deliveryResolution?: SessionMessageDeliveryResolutionV1;
    acceptedTurnId?: string;
    turnStartWitnessId?: string;
    turn?: SessionTurnV1;
};

export type TranscriptLookupOutcome =
    | { type: 'found'; message: TranscriptMessageLookupResult }
    | { type: 'not_found'; inputDisposition?: SessionInputRefusalDispositionV1['result'] }
    | { type: 'auth_failed'; statusCode: 401 | 403; error: unknown }
    | { type: 'unhealthy'; reason: 'timeout' | 'network' | 'server_5xx'; error: unknown }
    | { type: 'protocol_error'; error: unknown };

type ResolveTranscriptLookupAuthorizationHeaders = (request: Readonly<{
    method: 'GET';
    path: string;
}>) => Readonly<Record<string, string>> | null;

function createAxiosGetConfig(params: {
    token: string;
    path: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    resolveAuthorizationHeaders?: ResolveTranscriptLookupAuthorizationHeaders;
}) {
    const authorizationHeaders = params.resolveAuthorizationHeaders?.({ method: 'GET', path: params.path })
        ?? (params.resolveAuthorizationHeaders ? null : { Authorization: `Bearer ${params.token}` });
    if (!authorizationHeaders) throw createExternalActionHeaderRefusalError();
    return {
        headers: {
            ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
            ...authorizationHeaders,
            'Content-Type': 'application/json',
        },
        timeout: params.timeoutMs ?? configuration.transcriptLookupRequestTimeoutMs,
        ...(params.signal ? { signal: params.signal } : {}),
        ...(configuration.transcriptLookupKeepAliveEnabled
            ? { httpAgent: KEEP_ALIVE_HTTP_AGENT, httpsAgent: KEEP_ALIVE_HTTPS_AGENT }
            : null),
    } as const;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

function isV2MessageNotFoundError(error: unknown): error is AxiosError<unknown> {
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
    if (isNetworkConnectionErrorCode(code)) return true;
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
    const role = record.messageRole == null ? null : SessionMessageRoleSchema.safeParse(record.messageRole);
    if (role && !role.success) return null;
    const receipt = record.inputAdmissionReceipt === undefined ? null
        : SessionInputAdmissionReceiptV1Schema.safeParse(record.inputAdmissionReceipt);
    if (receipt && !receipt.success) return null;
    const turn = record.turn === undefined ? null : SessionTurnV1Schema.safeParse(record.turn);
    if (turn && !turn.success) return null;
    const deliveryResolution = record.deliveryResolution === undefined ? null
        : readStoredSessionMessageDeliveryResolutionV1(record.deliveryResolution);
    if (record.deliveryResolution !== undefined && !deliveryResolution) return null;
    for (const key of ['acceptedTurnId', 'turnStartWitnessId']) {
        const value = record[key];
        if (value !== undefined && (typeof value !== 'string' || value.length === 0)) return null;
    }
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
        ...(role?.success ? { messageRole: role.data } : {}),
        ...(receipt?.success ? { inputAdmissionReceipt: receipt.data } : {}),
        ...(deliveryResolution ? { deliveryResolution } : {}),
        ...(typeof record.acceptedTurnId === 'string' ? { acceptedTurnId: record.acceptedTurnId } : {}),
        ...(typeof record.turnStartWitnessId === 'string' ? { turnStartWitnessId: record.turnStartWitnessId } : {}),
        ...(turn?.success ? { turn: turn.data } : {}),
    };
}

export async function findTranscriptEncryptedMessageByLocalIdV2(params: {
    token: string;
    serverUrl: string;
    sessionId: string;
    localId: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    resolveAuthorizationHeaders?: ResolveTranscriptLookupAuthorizationHeaders;
}): Promise<TranscriptLookupOutcome> {
    try {
        const path = `/v2/sessions/${params.sessionId}/messages/by-local-id/${encodeURIComponent(params.localId)}`;
        const response = await axios.get(
            `${params.serverUrl}${path}`,
            createAxiosGetConfig({
                token: params.token,
                path,
                timeoutMs: params.timeoutMs,
                ...(params.signal ? { signal: params.signal } : {}),
                ...(params.resolveAuthorizationHeaders
                    ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
                    : {}),
            })
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
        if (!parsed || parsed.localId !== params.localId) return { type: 'protocol_error', error: createMalformedTranscriptLookupResponseError() };
        return { type: 'found', message: parsed };
    } catch (error) {
        if (isV2MessageNotFoundError(error)) {
            const rawDisposition = asRecord(error.response?.data)?.inputDisposition;
            if (rawDisposition === undefined) return { type: 'not_found' };
            const disposition = SessionInputRefusalDispositionV1Schema.safeParse(rawDisposition);
            if (!disposition.success || disposition.data.localId !== params.localId) {
                return { type: 'protocol_error', error: createMalformedTranscriptLookupResponseError() };
            }
            return { type: 'not_found', inputDisposition: disposition.data.result };
        }
        const authStatus = readAuthenticationStatus(error);
        if (authStatus !== null) return { type: 'auth_failed', statusCode: authStatus, error };
        const unhealthy = classifyUnhealthyTranscriptLookup(error);
        if (unhealthy) return unhealthy;
        return { type: 'protocol_error', error };
    }
}

export async function findTranscriptEncryptedMessageByLocalId(params: {
    token: string;
    sessionId: string;
    localId: string;
    onError?: (error: unknown) => void;
    timeoutMs?: number;
    signal?: AbortSignal;
    resolveAuthorizationHeaders?: ResolveTranscriptLookupAuthorizationHeaders;
}): Promise<TranscriptMessageLookupResult | null> {
    const serverUrl = resolveServerHttpBaseUrl();
    const outcome = await findTranscriptEncryptedMessageByLocalIdV2({
        token: params.token,
        serverUrl,
        sessionId: params.sessionId,
        localId: params.localId,
        timeoutMs: params.timeoutMs,
        ...(params.signal ? { signal: params.signal } : {}),
        ...(params.resolveAuthorizationHeaders
            ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
            : {}),
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
    requestTimeoutMs?: number;
    signal?: AbortSignal;
    onUnsupported?: (error: unknown) => void;
    resolveAuthorizationHeaders?: ResolveTranscriptLookupAuthorizationHeaders;
}): Promise<TranscriptMessageLookupResult | null> {
    const deadlineMs = Date.now() + (params.maxWaitMs ?? 5_000);
    const events = openSessionEventSource(params);
    const serverUrl = resolveServerHttpBaseUrl();
    try {
        while (!params.signal?.aborted && Date.now() < deadlineMs) {
            const revision = events.currentRevision();
            const request = () => findTranscriptEncryptedMessageByLocalIdV2({
                token: params.token, serverUrl, sessionId: params.sessionId, localId: params.localId,
                timeoutMs: Math.max(1, Math.min(params.requestTimeoutMs ?? configuration.transcriptLookupRequestTimeoutMs, deadlineMs - Date.now())),
                ...(params.signal ? { signal: params.signal } : {}),
                ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
            });
            if (params.supervisor) {
                const supervisor = params.supervisor;
                const result = await TranscriptRecoveryCoordinator.forServer(serverUrl).scheduleByLocalId({
                    sessionId: params.sessionId, localId: params.localId, supervisor,
                    runRequest: () => runSupervisedRequest({ supervisor, purpose: 'recovery_read', request }),
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
            } else {
                const outcome = await request();
                if (outcome.type === 'found') return outcome.message;
                if (outcome.type === 'auth_failed') throw outcome.error;
                if (outcome.type === 'protocol_error' && isLegacyV2RouteMissingError(outcome.error)) {
                    params.onUnsupported?.(outcome.error);
                    return null;
                }
                if (outcome.type === 'protocol_error' || outcome.type === 'unhealthy') params.onError?.(outcome.error);
            }
            if (!(await events.waitForChange(revision, { deadlineMs, signal: params.signal }))) break;
        }
        return null;
    } finally {
        await events.close();
    }
}
