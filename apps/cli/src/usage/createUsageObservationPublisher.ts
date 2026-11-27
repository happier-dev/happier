import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from '@/api/client/credentialAxios';
import type { UsageEventIngestRequest, UsageNativeAccountingSubject, UsageNativeAccountingEvidence, UsageRequestAttribution } from '@happier-dev/protocol';
import { isUsageEventIngestRefusalCode, readUsageEventIngestRefusalCode, type UsageEventIngestRefusalCode } from '@happier-dev/protocol/usage/usageAnalyticsContracts';
import { readActionCredentialScopeDeniedHttpFailureV1, type ActionCredentialScopeDeniedFailureV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { normalizeBaseUrl } from '@/diagnostics/httpClient';
import { isAuthenticationStatus, readHttpStatus } from '@/api/client/httpStatusError';
import { readAxiosResponseErrorCode } from '@/api/client/readAxiosResponseErrorCode';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { logger } from '@/ui/logger';

import type { UsageObservation } from './usageObservation';
import { buildUsageEventIngestRequest } from './buildUsageEventIngestRequest';

type PostJsonResult = Readonly<{ ok: true }>;

/** Home's v2 usage-event ingest route; the Session-socket `usage-event` is its transport twin. */
const USAGE_EVENT_INGEST_PATH = '/v2/usage-events';

type NativeIngestRefusalCode = UsageEventIngestRefusalCode | ActionCredentialScopeDeniedFailureV1['errorCode'];

export function isNativeUsageIngestRefusalCode(code: unknown): code is NativeIngestRefusalCode {
    return isUsageEventIngestRefusalCode(code) || code === 'credential_scope_denied';
}

function readNativeIngestHttpRefusal(error: unknown, status: number | null): NativeIngestRefusalCode | undefined {
    if (status === null) return undefined;
    if (status === 403 && axios.isAxiosError(error)) {
        return readActionCredentialScopeDeniedHttpFailureV1(status, error.response?.data)?.errorCode;
    }
    return readUsageEventIngestRefusalCode(readAxiosResponseErrorCode(error), status);
}

export type UsageObservationPublishResult =
    | Readonly<{ status: 'sent'; transport: 'socket' | 'http' }>
    | Readonly<{ status: 'skipped' | 'failed' | 'unsupported'; errorCode?: NativeIngestRefusalCode }>;

/** The acknowledgement of the Session-socket `usage-event`, as the Home's ingest owner returns it. */
type UsageEventSocketAck = Readonly<{ success?: unknown; error?: unknown }>;

function isUnsupportedHttpStatus(status: number | null | undefined): boolean {
    return status === 404 || status === 405 || status === 501;
}

async function defaultPostJson(params: Readonly<{
    serverUrl: string;
    token: string;
    path: string;
    body: unknown;
    signal?: AbortSignal;
}>): Promise<PostJsonResult> {
    await axios.post(
        `${normalizeBaseUrl(params.serverUrl)}${params.path}`,
        params.body,
        {
            headers: {
                ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
                Authorization: `Bearer ${params.token}`,
                'Content-Type': 'application/json',
            },
            ...(params.signal ? { signal: params.signal } : {}),
        },
    );
    return { ok: true };
}

/**
 * Publishes one v2 usage event per observation: one acknowledged emit on the
 * admitted Session socket, or the v2 HTTP ingest route while that socket is not
 * connected (each reconnect opens a new socket, so a disconnected emit is not
 * buffered across it). A failed or refused publication stays unacknowledged for
 * its producer's replay.
 */
export function createUsageObservationPublisher(params: Readonly<{
    token: string;
    apiServerUrl: string;
    resolveToken?: () => Promise<string | null>;
    postJson?: (params: Readonly<{
        serverUrl: string;
        token: string;
        path: string;
        body: unknown;
        signal?: AbortSignal;
    }>) => Promise<PostJsonResult>;
    /** Emits on the connected Session socket and resolves its acknowledgement; null while it is not connected. */
    emitUsageEvent: (request: UsageEventIngestRequest, signal?: AbortSignal) => Promise<unknown> | null;
}>) {
    let currentToken = params.token;

    function publishFailure(error: unknown): UsageObservationPublishResult {
        logger.warn('[USAGE] Failed to publish usage observation (non-fatal)', serializeAxiosErrorForLog(error));
        return { status: 'failed' };
    }

    async function publishOverSocket(
        ack: Promise<unknown>,
        native: boolean,
    ): Promise<UsageObservationPublishResult> {
        let value: UsageEventSocketAck | null;
        try {
            const raw = await ack;
            value = raw && typeof raw === 'object' ? raw as UsageEventSocketAck : null;
        } catch (error) {
            return publishFailure(error);
        }
        if (value?.success === true) return { status: 'sent', transport: 'socket' };
        const errorCode = native ? readUsageEventIngestRefusalCode(value?.error) : undefined;
        if (errorCode) return { status: 'failed', errorCode };
        return publishFailure(new Error(`Usage event refused: ${typeof value?.error === 'string' ? value.error : 'unknown'}`));
    }

    async function publishOverHttp(
        request: UsageEventIngestRequest,
        native: boolean,
        signal: AbortSignal | undefined,
    ): Promise<UsageObservationPublishResult> {
        const post = () => (params.postJson ?? defaultPostJson)({
            serverUrl: params.apiServerUrl,
            token: currentToken,
            path: USAGE_EVENT_INGEST_PATH,
            body: request,
            ...(signal ? { signal } : {}),
        });
        const refused = (error: unknown, status: number | null): UsageObservationPublishResult =>
            isUnsupportedHttpStatus(status) || (native && status === 400) ? { status: 'unsupported' } : publishFailure(error);
        try {
            await post();
            return { status: 'sent', transport: 'http' };
        } catch (error) {
            const status = readHttpStatus(error);
            const errorCode = native ? readNativeIngestHttpRefusal(error, status) : undefined;
            if (errorCode) return { status: 'failed', errorCode };
            if (!isAuthenticationStatus(status)) return refused(error, status);
            let refreshedToken: string | null;
            try {
                refreshedToken = (await params.resolveToken?.())?.trim() ?? null;
            } catch (refreshError) {
                return publishFailure(refreshError);
            }
            if (!refreshedToken) return publishFailure(error);
            currentToken = refreshedToken;
            try {
                await post();
                return { status: 'sent', transport: 'http' };
            } catch (retryError) {
                const retryStatus = readHttpStatus(retryError);
                const retryCode = native ? readNativeIngestHttpRefusal(retryError, retryStatus) : undefined;
                return retryCode ? { status: 'failed', errorCode: retryCode } : refused(retryError, retryStatus);
            }
        }
    }

    return {
        async publish(input: Readonly<{
            sessionId?: string;
            signal?: AbortSignal;
            subject?: UsageNativeAccountingSubject;
            nativeSessionLink?: UsageEventIngestRequest['nativeSessionLink'];
            accounting?: UsageNativeAccountingEvidence;
            attribution?: UsageRequestAttribution;
            observation: UsageObservation;
            observedAt?: number;
            backendMode?: string | null;
            projectKey?: string | null;
            workspaceId?: string | null;
            machineId?: string | null;
            turnId?: string | null;
            externalKey?: string | null;
            metadata?: Record<string, unknown>;
        }>): Promise<UsageObservationPublishResult> {
            if (input.signal?.aborted) return { status: 'failed' };
            const request = buildUsageEventIngestRequest({
                sessionId: input.sessionId,
                subject: input.subject,
                nativeSessionLink: input.nativeSessionLink,
                accounting: input.accounting,
                attribution: input.attribution,
                observedAt: input.observedAt ?? Date.now(),
                observation: input.observation,
                backendMode: input.backendMode,
                projectKey: input.projectKey,
                workspaceId: input.workspaceId,
                machineId: input.machineId,
                turnId: input.turnId,
                externalKey: input.externalKey,
                metadata: input.metadata,
            });
            if (!request) return { status: 'skipped' };
            const native = Boolean(input.subject);
            let ack: Promise<unknown> | null;
            try {
                ack = params.emitUsageEvent(request, input.signal);
            } catch (error) {
                return publishFailure(error);
            }
            return ack ? await publishOverSocket(ack, native) : await publishOverHttp(request, native, input.signal);
        },
    };
}
