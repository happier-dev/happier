import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import axios from '@/api/client/credentialAxios';
import type { UsageEventIngestRequest, UsageNativeAccountingSubject, UsageNativeAccountingEvidence, UsageRequestAttribution } from '@happier-dev/protocol';
import { normalizeBaseUrl } from '@/diagnostics/httpClient';
import { isAuthenticationStatus, readHttpStatus } from '@/api/client/httpStatusError';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { logger } from '@/ui/logger';

import type { UsageObservation } from './usageObservation';
import { buildUsageEventIngestRequest } from './buildUsageEventIngestRequest';

type PostJsonResult = Readonly<{ ok: true }>;

/** Home's v2 usage-event ingest route; the Session-socket `usage-event` is its transport twin. */
const USAGE_EVENT_INGEST_PATH = '/v2/usage-events';

export type UsageObservationPublishResult =
    | Readonly<{ status: 'sent'; transport: 'socket' | 'http' }>
    | Readonly<{ status: 'skipped' | 'failed' | 'unsupported' }>;

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
        if (native && (value?.error === 'Invalid parameters' || value?.error === 'Native Session link not found')) {
            return { status: 'unsupported' };
        }
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
        const refused = (error: unknown): UsageObservationPublishResult => {
            const status = readHttpStatus(error);
            return isUnsupportedHttpStatus(status) || (native && status === 400)
                ? { status: 'unsupported' } : publishFailure(error);
        };
        try {
            await post();
            return { status: 'sent', transport: 'http' };
        } catch (error) {
            if (!isAuthenticationStatus(readHttpStatus(error))) return refused(error);
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
                return refused(retryError);
            }
        }
    }

    return {
        async publish(input: Readonly<{
            sessionId?: string;
            signal?: AbortSignal;
            subject?: UsageNativeAccountingSubject;
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
