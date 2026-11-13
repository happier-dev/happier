import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from '@/api/client/credentialAxios';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readRequesterAccountEncryptionCurrentness } from '@/api/client/accountEncryptionCurrentnessObservation';
import { configuration } from '@/configuration';
import { emitSocketWithAck } from '@/session/transport/shared/socketAck';
import { ExactSessionTurnEndMutationV1Schema, isExactSessionTurnMutationPositiveReceiptV1 } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';
import { SessionTurnMutationReceiptV1Schema } from '@happier-dev/protocol/sessions/turns/sessionTurnMutationV1';
import type { ExactSessionTurnEndMutationV1, SessionTurnMutationDecisionV1, SessionTurnMutationV1 } from '@happier-dev/protocol';

import { SessionTeamCredentialBindingRejectionV1Schema, type SessionTeamCredentialBindingRejectionV1 } from '@happier-dev/protocol/teams/credentials/sessionBindingV1';
import type { SessionRuntimeIssueV1 } from '@happier-dev/protocol/sessions/control/runtimeIssueV1';

import type { SessionClientDurableMutationSocket } from './sessionClientDurableMutationTypes';
import { projectRuntimeIssueForServer } from './projectRuntimeIssueForServer';

type SessionTurnMutationRejectionDiagnostic = Readonly<{
    code: 'session_team_credential_binding_rejected';
    reason?: SessionTeamCredentialBindingRejectionV1;
}>;

function readRejectionDiagnostic(value: unknown): SessionTurnMutationRejectionDiagnostic | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    if (record.code !== 'session_team_credential_binding_rejected') return undefined;
    const reason = SessionTeamCredentialBindingRejectionV1Schema.safeParse(record.reason);
    return { code: record.code, ...(reason.success ? { reason: reason.data } : {}) };
}

/** Home's final refusal ends publication; it is not a retryable missing acknowledgement. */
export class SessionTurnPublicationRejectedError extends Error {
    readonly failureCause: NonNullable<SessionRuntimeIssueV1['failureCause']> & Readonly<{ code: string }>;

    constructor(diagnostic?: unknown) {
        const rejection = readRejectionDiagnostic(diagnostic);
        const accessRemoved = rejection?.reason === 'access_removed';
        super(accessRemoved ? 'Team access was withdrawn.'
            : rejection ? 'Home refused this Session’s Team credential access.' : 'Home rejected Turn publication.');
        this.name = 'SessionTurnPublicationRejectedError';
        this.failureCause = {
            code: rejection?.code ?? 'session_turn_mutation_rejected',
            phase: 'turn_start',
            failureReason: accessRemoved ? 'permission_denied' : 'unknown',
            retryable: false,
            ...(rejection?.reason ? { providerErrorCode: rejection.reason } : {}),
        };
    }
}

function isSuccessAck(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return record.ok === true || record.result === 'success' || record.status === 'ok';
}

function isUnsupportedAck(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    const code = typeof record.errorCode === 'string' ? record.errorCode : typeof record.code === 'string' ? record.code : '';
    const message = typeof record.error === 'string' ? record.error : typeof record.message === 'string' ? record.message : '';
    return /unsupported|unknown|not[_ -]?found/i.test(code) || /unsupported|unknown event|not found/i.test(message);
}

function readUnsupportedAckCode(value: unknown): string | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const record = value as Record<string, unknown>;
    const code = typeof record.errorCode === 'string' ? record.errorCode : typeof record.code === 'string' ? record.code : '';
    return /unsupported|unknown|not[_ -]?found/i.test(code) ? code : undefined;
}

type UnsupportedSessionTurnSocketEvidence = Readonly<{
    transport: 'socket';
    evidence: 'unavailable' | 'unsupported_ack';
    code?: string;
}>;

type UnsupportedSessionTurnHttpEvidence = Readonly<{
    transport: 'http';
    evidence: 'unsupported_status';
    status: 404 | 405 | 501;
}>;

type SessionTurnMutationSocketResult =
    | Readonly<{ status: 'delivered'; beginApplied?: boolean }>
    | Readonly<{ status: 'unsupported'; evidence: UnsupportedSessionTurnSocketEvidence }>
    | Readonly<{ status: 'exact_non_delivery'; diagnostic: ExactReceiptDiagnostic }>
    | Readonly<{ status: 'receipt_mismatch' }>
    | Readonly<{ status: 'rejected'; diagnostic: SessionTurnMutationRejectionDiagnostic }>
    | Readonly<{ status: 'failed' }>;

type SessionTurnMutationHttpResult =
    | Readonly<{ status: 'delivered'; beginApplied?: boolean }>
    | Readonly<{ status: 'unsupported'; evidence: UnsupportedSessionTurnHttpEvidence }>
    | Readonly<{ status: 'exact_non_delivery'; diagnostic: ExactReceiptDiagnostic }>
    | Readonly<{ status: 'receipt_mismatch' }>
    | Readonly<{ status: 'incompatible'; statusCode: 400 | 422; diagnostic?: SessionTurnMutationRejectionDiagnostic }>
    | Readonly<{ status: 'failed' }>;

type ExactReceiptDiagnostic = Readonly<{
    classification: 'semantic_non_positive' | 'receipt_mismatch';
    decision?: SessionTurnMutationDecisionV1;
}>;

export type ExactSessionTurnMutationNonDeliveryDiagnostic = ExactReceiptDiagnostic & Readonly<{
    sessionId: string;
    mutationId: string;
    turnId: string;
    observedAt: number;
}>;

export type UnsupportedSessionTurnMutationDiagnostic = Readonly<{
    reason: 'session_turn_mutation_unsupported';
    serverOrigin: string;
    sessionId: string;
    mutationId: string;
    action: SessionTurnMutationV1['action'];
    turnId?: string;
    socket: UnsupportedSessionTurnSocketEvidence;
    http: UnsupportedSessionTurnHttpEvidence;
}>;

export type SessionTurnMutationDeliveryResult =
    | Readonly<{ delivered: true; path: 'socket' | 'http'; beginApplied?: boolean }>
    | Readonly<{
        delivered: false;
        reason: 'unsupported_capability';
        diagnostic: UnsupportedSessionTurnMutationDiagnostic;
    }>
    | Readonly<{ delivered: false; reason: 'ignored_lossy' }>
    | Readonly<{
        delivered: false;
        reason: 'session_turn_mutation_rejected';
        httpStatus?: 400 | 422;
        diagnostic?: SessionTurnMutationRejectionDiagnostic;
    }>
    | Readonly<{
        delivered: false;
        reason: 'exact_session_turn_mutation_not_delivered';
        diagnostic: ExactSessionTurnMutationNonDeliveryDiagnostic;
    }>
    | Readonly<{ delivered: false; reason: string }>;

function readMatchingReceipt(
    mutation: SessionTurnMutationV1,
    receiptValue: unknown,
) {
    const receipt = SessionTurnMutationReceiptV1Schema.safeParse(receiptValue);
    return receipt.success
        && receipt.data.v === mutation.v
        && receipt.data.sessionId === mutation.sessionId
        && receipt.data.mutationId === mutation.mutationId
        && receipt.data.action === mutation.action
        && (!('turnId' in mutation) || mutation.turnId === undefined || receipt.data.turnId === mutation.turnId)
        && receipt.data.observedAt === mutation.observedAt ? receipt.data : null;
}

function doesReceiptIdentityMatch(mutation: SessionTurnMutationV1, receiptValue: unknown): boolean {
    return readMatchingReceipt(mutation, receiptValue) !== null;
}

function classifyOrdinaryReceipt(mutation: SessionTurnMutationV1, receiptValue: unknown): Extract<SessionTurnMutationSocketResult, { status: 'delivered' | 'receipt_mismatch' }> {
    const receipt = readMatchingReceipt(mutation, receiptValue);
    if (!receipt) return { status: 'receipt_mismatch' };
    // A deterministic refusal releases ordinary journal custody, but cannot authorize
    // a brokered effect. Replayed receipts retain the original applied decision.
    return { status: 'delivered', ...(mutation.action === 'begin' ? { beginApplied: receipt.decision === 'applied' } : {}) };
}

function classifyExactReceipt(
    mutation: ExactSessionTurnEndMutationV1,
    receiptValue: unknown,
): Readonly<{ delivered: true }> | Readonly<{ delivered: false; diagnostic: ExactReceiptDiagnostic }> {
    if (isExactSessionTurnMutationPositiveReceiptV1(mutation, receiptValue)) {
        return { delivered: true };
    }
    if (doesReceiptIdentityMatch(mutation, receiptValue)) {
        const receipt = SessionTurnMutationReceiptV1Schema.parse(receiptValue);
        return {
            delivered: false,
            diagnostic: {
                classification: 'semantic_non_positive',
                decision: receipt.decision,
            },
        };
    }
    return { delivered: false, diagnostic: { classification: 'receipt_mismatch' } };
}

function readHttpErrorStatus(error: unknown): number | null {
    if (!error || typeof error !== 'object') return null;
    const response = (error as { response?: unknown }).response;
    if (!response || typeof response !== 'object') return null;
    const status = (response as { status?: unknown }).status;
    return typeof status === 'number' ? status : null;
}

function resolveServerOrigin(serverUrl: string): string {
    try {
        return new URL(serverUrl).origin;
    } catch {
        return 'configured-server';
    }
}

function buildUnsupportedDiagnostic(params: Readonly<{
    serverOrigin: string;
    mutation: SessionTurnMutationV1;
    socket: UnsupportedSessionTurnSocketEvidence;
    http: UnsupportedSessionTurnHttpEvidence;
}>): UnsupportedSessionTurnMutationDiagnostic {
    return {
        reason: 'session_turn_mutation_unsupported',
        serverOrigin: params.serverOrigin,
        sessionId: params.mutation.sessionId,
        mutationId: params.mutation.mutationId,
        action: params.mutation.action,
        ...('turnId' in params.mutation && params.mutation.turnId ? { turnId: params.mutation.turnId } : {}),
        socket: params.socket,
        http: params.http,
    };
}

async function trySocketSessionTurnMutation(params: Readonly<{
    socket: SessionClientDurableMutationSocket;
    mutation: SessionTurnMutationV1;
    exactMutation?: ExactSessionTurnEndMutationV1;
    signal?: AbortSignal;
}>): Promise<SessionTurnMutationSocketResult> {
    if (params.socket.connected === false) return { status: 'unsupported', evidence: { transport: 'socket', evidence: 'unavailable' } };
    try {
        const socket = params.socket;
        if (typeof socket.emitWithAck !== 'function') {
            return { status: 'unsupported', evidence: { transport: 'socket', evidence: 'unavailable' } };
        }
        const ack = await emitSocketWithAck({ socket, event: 'session-turn-mutation',
            payload: params.mutation, timeoutMs: null, signal: params.signal });
        if (isUnsupportedAck(ack)) {
            const code = readUnsupportedAckCode(ack);
            return {
                status: 'unsupported',
                evidence: {
                    transport: 'socket',
                    evidence: 'unsupported_ack',
                    ...(code ? { code } : {}),
                },
            };
        }
        const record = ack && typeof ack === 'object' ? ack as Record<string, unknown> : null;
        const rejection = readRejectionDiagnostic(record);
        if (rejection) return { status: 'rejected', diagnostic: rejection };
        if (params.exactMutation) {
            const classified = classifyExactReceipt(params.exactMutation, record?.receipt);
            return classified.delivered
                ? { status: 'delivered' }
                : { status: 'exact_non_delivery', diagnostic: classified.diagnostic };
        }
        if (isSuccessAck(ack)) {
            return classifyOrdinaryReceipt(params.mutation, record?.receipt);
        }
        return { status: 'failed' };
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        return { status: 'failed' };
    }
}

async function tryHttpSessionTurnMutation(params: Readonly<{
    token: string;
    mutation: SessionTurnMutationV1;
    serverUrl: string;
    exactMutation?: ExactSessionTurnEndMutationV1;
    resolveAuthorizationHeaders?: (request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
}>): Promise<SessionTurnMutationHttpResult> {
    try {
        const path = `/v1/sessions/${encodeURIComponent(params.mutation.sessionId)}/turns/mutations`;
        const authorizationHeaders = params.resolveAuthorizationHeaders?.({ method: 'POST', path, body: params.mutation })
            ?? (params.resolveAuthorizationHeaders ? null : { Authorization: `Bearer ${params.token}` });
        if (!authorizationHeaders) return { status: 'failed' };
        const response = await axios.post(
            `${params.serverUrl}${path}`,
            params.mutation,
            {
                headers: {
                    ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                    ...authorizationHeaders,
                    'Content-Type': 'application/json',
                },
                timeout: configuration.sessionControlHttpTimeoutMs,
            },
        );
        const data = response?.data as Record<string, unknown> | undefined;
        if (params.exactMutation) {
            const classified = classifyExactReceipt(params.exactMutation, data?.receipt);
            return classified.delivered
                ? { status: 'delivered' }
                : { status: 'exact_non_delivery', diagnostic: classified.diagnostic };
        }
        if (data && (data.ok === false || data.result === 'error')) return { status: 'failed' };
        return classifyOrdinaryReceipt(params.mutation, data?.receipt);
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        const status = readHttpErrorStatus(error);
        if (status === 404 || status === 405 || status === 501) {
            return { status: 'unsupported', evidence: { transport: 'http', evidence: 'unsupported_status', status } };
        }
        if (status === 400 || status === 422) {
            const response = (error as { response?: { data?: unknown } }).response;
            const diagnostic = readRejectionDiagnostic(response?.data);
            return { status: 'incompatible', statusCode: status, ...(diagnostic ? { diagnostic } : {}) };
        }
        return { status: 'failed' };
    }
}

export async function deliverSessionTurnMutation(params: Readonly<{
    token: string;
    socket: SessionClientDurableMutationSocket | null;
    mutation: SessionTurnMutationV1;
    getAccountEncryptionMode?: () => Promise<'plain' | 'e2ee' | 'unknown'>;
    signal?: AbortSignal;
    /** Exact admitted requester headers for the HTTP boundary; never an installed-token fallback. */
    resolveAuthorizationHeaders?: (request: Readonly<{ method: string; path: string; body?: unknown }>) => Readonly<Record<string, string>> | null;
}>): Promise<SessionTurnMutationDeliveryResult> {
    const serverUrl = resolveServerHttpBaseUrl();
    // This boundary also covers daemon writers, persisted replay and HTTP fallback.
    let mutation = params.mutation;
    if (mutation.action === 'fail') {
        const publicIssue = projectRuntimeIssueForServer(mutation.issue);
        // A closed issue already containing no private diagnostic needs no mode read.
        if (publicIssue !== mutation.issue) {
            const accountMode = params.getAccountEncryptionMode
                ? await params.getAccountEncryptionMode()
                : (await readRequesterAccountEncryptionCurrentness({
                    token: params.token,
                    serverBaseUrl: serverUrl,
                    signal: params.signal,
                    ...(params.resolveAuthorizationHeaders ? {
                        authorizationHeaders: params.resolveAuthorizationHeaders({
                            method: 'GET', path: '/v1/account/encryption/currentness',
                        }) ?? {},
                    } : {}),
                })).mode;
            if (accountMode !== 'plain') mutation = { ...mutation, issue: publicIssue };
        }
    }
    const parsedExactMutation = ExactSessionTurnEndMutationV1Schema.safeParse(params.mutation);
    const exactMutation = parsedExactMutation.success ? parsedExactMutation.data : undefined;
    const socketResult = params.socket?.connected === true
        ? await trySocketSessionTurnMutation({ socket: params.socket, mutation, exactMutation, signal: params.signal })
        : { status: 'failed' as const };
    if (socketResult.status === 'delivered') return { delivered: true, path: 'socket', ...(socketResult.beginApplied === undefined ? {} : { beginApplied: socketResult.beginApplied }) };

    if (socketResult.status === 'rejected') {
        return { delivered: false, reason: 'session_turn_mutation_rejected', diagnostic: socketResult.diagnostic };
    }

    if (params.signal?.aborted) return { delivered: false, reason: 'session_turn_mutation_transport_unavailable' };

    const httpResult = await tryHttpSessionTurnMutation({
        token: params.token,
        mutation,
        serverUrl,
        exactMutation,
        ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
    });
    if (httpResult.status === 'delivered') return { delivered: true, path: 'http', ...(httpResult.beginApplied === undefined ? {} : { beginApplied: httpResult.beginApplied }) };
    if (socketResult.status === 'unsupported' && httpResult.status === 'unsupported') {
        return {
            delivered: false,
            reason: 'unsupported_capability',
            diagnostic: buildUnsupportedDiagnostic({
                serverOrigin: resolveServerOrigin(serverUrl),
                mutation: params.mutation,
                socket: socketResult.evidence,
                http: httpResult.evidence,
            }),
        };
    }
    if (httpResult.status === 'incompatible' && params.mutation.action === 'touch_active') {
        return { delivered: false, reason: 'ignored_lossy' };
    }
    if (httpResult.status === 'incompatible') {
        return { delivered: false, reason: 'session_turn_mutation_rejected', httpStatus: httpResult.statusCode,
            ...(httpResult.diagnostic ? { diagnostic: httpResult.diagnostic } : {}) };
    }
    if (socketResult.status === 'receipt_mismatch' || httpResult.status === 'receipt_mismatch') {
        return { delivered: false, reason: 'session_turn_mutation_receipt_mismatch' };
    }
    if (exactMutation) {
        const exactNonDelivery = httpResult.status === 'exact_non_delivery'
            ? httpResult.diagnostic
            : socketResult.status === 'exact_non_delivery'
                ? socketResult.diagnostic
                : { classification: 'receipt_mismatch' as const };
        return {
            delivered: false,
            reason: 'exact_session_turn_mutation_not_delivered',
            diagnostic: {
                ...exactNonDelivery,
                sessionId: exactMutation.sessionId,
                mutationId: exactMutation.mutationId,
                turnId: exactMutation.turnId,
                observedAt: exactMutation.observedAt,
            },
        };
    }
    return { delivered: false, reason: 'session_turn_mutation_transport_unavailable' };
}
