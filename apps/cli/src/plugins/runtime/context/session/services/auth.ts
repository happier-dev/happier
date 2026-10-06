import type {
    SessionAuthService,
    SessionRuntimeAuthRefreshRequest,
    SessionRuntimeAuthRefreshResult,
} from '@happier-dev/plugin-sdk/sessions';
import { AgentSessionAuthRefreshRecoveryV1Schema } from '@happier-dev/protocol/runtime/authRefresh';
import type { AgentSessionAuthRefreshRecoveryV1 } from '@happier-dev/protocol';

import {
    type CatalogAgentId,
} from '@/agent/catalog/ids';
import { isCatalogAgentId } from '@/agent/catalog/resolution';
import { getConnectedServiceRuntimeAuthAdapter } from '@/daemon/connectedServices/catalogHooks';
import { reportConnectedServiceRuntimeAuthFailureToDaemon } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { hasConnectedServiceRuntimeAuthRecoveryContext } from '@/agent/runtime/session/errors/connectedServiceRuntimeAuthRecoveryContext';
import { requestDaemonSessionConnectedServiceRuntimeAuthRefresh } from '@/daemon/controlClient';
import type {
    ConnectedServiceProviderRuntimeAuthAdapter,
    ConnectedServiceRuntimeAuthTargetInput,
} from '@/daemon/connectedServices/runtimeAuth/types';
import { readTrimmedString } from './readTrimmedString';
import { createDaemonRuntimeAuthRefreshService, normalizeRuntimeAuthRefreshResult, readRuntimeAuthRefreshError, readUnavailableDaemonRefreshErrorReason, withRuntimeAuthSelectionHints } from '../../runtimeAuthRefresh';

type RuntimeAuthAdapterResolver = (
    agentId: CatalogAgentId,
) => Promise<ConnectedServiceProviderRuntimeAuthAdapter | null>;

type RuntimeAuthFailureReporter = typeof reportConnectedServiceRuntimeAuthFailureToDaemon;

export type CreateSessionHandleAuthServiceParams = Readonly<{
    readSessionId: (signal?: AbortSignal) => Promise<string | null>;
    readAgentId: (signal?: AbortSignal) => Promise<string | null>;
    resolveAdapter?: RuntimeAuthAdapterResolver;
    reportFailure?: RuntimeAuthFailureReporter;
    refreshViaDaemon?: typeof requestDaemonSessionConnectedServiceRuntimeAuthRefresh;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readCatalogAgentId(value: unknown): CatalogAgentId | null {
    const agentId = readTrimmedString(value);
    if (!agentId) {
        return null;
    }
    return isCatalogAgentId(agentId) ? agentId : null;
}

function createAbortError(signal: AbortSignal): Error {
    const reason = signal.reason;
    if (reason instanceof Error) {
        return reason;
    }
    const error = new Error(typeof reason === 'string' && reason.trim().length > 0
        ? reason.trim()
        : 'Session runtime auth refresh was aborted');
    error.name = 'AbortError';
    return error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) {
        throw createAbortError(signal);
    }
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
    if (!signal) {
        return await operation;
    }
    throwIfAborted(signal);
    return await new Promise<T>((resolve, reject) => {
        const onAbort = () => reject(createAbortError(signal));
        signal.addEventListener('abort', onAbort, { once: true });
        operation.then(resolve, reject).finally(() => {
            signal.removeEventListener('abort', onAbort);
        });
    });
}

async function reportRecoveryIfPossible(
    params: CreateSessionHandleAuthServiceParams,
    request: SessionRuntimeAuthRefreshRequest,
    signal: AbortSignal | undefined,
): Promise<AgentSessionAuthRefreshRecoveryV1 | undefined> {
    if (
        !request.classification
        || !hasConnectedServiceRuntimeAuthRecoveryContext(request.classification)
    ) {
        return undefined;
    }
    const sessionId = await params.readSessionId(signal);
    if (!sessionId) {
        return undefined;
    }
    const recovery = await (params.reportFailure ?? reportConnectedServiceRuntimeAuthFailureToDaemon)({
        sessionId,
        classification: request.classification,
    });
    const parsed = AgentSessionAuthRefreshRecoveryV1Schema.safeParse(recovery);
    return parsed.success ? parsed.data : undefined;
}

function buildRefreshInput(
    agentId: CatalogAgentId,
    request: SessionRuntimeAuthRefreshRequest,
): ConnectedServiceRuntimeAuthTargetInput {
    return Object.freeze({
        target: Object.freeze({
            agentId,
            ...(request.targetId ? { targetId: request.targetId } : {}),
        }),
        selection: withRuntimeAuthSelectionHints(request.selection, request),
    });
}

export function createSessionHandleAuthService(
    params: CreateSessionHandleAuthServiceParams,
): SessionAuthService {
    const resolveAdapter = params.resolveAdapter ?? getConnectedServiceRuntimeAuthAdapter;
    return Object.freeze({
        services: Object.freeze({
            async refreshRuntimeAuth(
                request: SessionRuntimeAuthRefreshRequest,
                options?: Readonly<{ signal?: AbortSignal }>,
            ): Promise<SessionRuntimeAuthRefreshResult> {
                throwIfAborted(options?.signal);
                const agentId = readCatalogAgentId(await params.readAgentId(options?.signal));
                throwIfAborted(options?.signal);
                const serviceId = readTrimmedString(request.serviceId);
                if (!agentId || !serviceId) {
                    return Object.freeze({
                        status: 'unavailable',
                        reason: 'runtime_auth_target_unavailable',
                    });
                }
                if (request.selection === undefined || request.selection === null) {
                    const recovery = await reportRecoveryIfPossible(params, request, options?.signal);
                    return Object.freeze({
                        status: 'unavailable',
                        reason: 'runtime_auth_selection_unavailable',
                        ...(recovery ? { recovery } : {}),
                    });
                }
                const adapter = await raceWithAbort(resolveAdapter(agentId), options?.signal);
                if (!adapter) {
                    const recovery = await reportRecoveryIfPossible(params, request, options?.signal);
                    return Object.freeze({
                        status: 'unavailable',
                        reason: 'runtime_auth_adapter_unavailable',
                        ...(recovery ? { recovery } : {}),
                    });
                }
                try {
                    const result = await raceWithAbort(
                        adapter.refreshActiveProfile(buildRefreshInput(agentId, request)),
                        options?.signal,
                    );
                    if (isRecord(result) && result.status === 'unsupported') {
                        if (!request.expectedCredentialRevision) {
                            return Object.freeze({
                                status: 'unavailable',
                                reason: 'runtime_auth_credential_revision_unavailable',
                            });
                        }
                        const refreshAttemptId = readTrimmedString(request.refreshAttemptId);
                        if (!refreshAttemptId) {
                            return Object.freeze({
                                status: 'unavailable',
                                reason: 'runtime_auth_refresh_attempt_identity_unavailable',
                            });
                        }
                        const sessionId = await params.readSessionId(options?.signal);
                        if (!sessionId) {
                            return Object.freeze({
                                status: 'unavailable',
                                reason: 'runtime_auth_session_unavailable',
                            });
                        }
                        const services = createDaemonRuntimeAuthRefreshService({
                            refreshViaDaemon: (body, options) => (
                                params.refreshViaDaemon ?? requestDaemonSessionConnectedServiceRuntimeAuthRefresh
                            )({ ...body, sessionId }, options),
                            reportRecovery: (request, signal) => reportRecoveryIfPossible(params, request, signal),
                        });
                        return await services.refreshRuntimeAuth(request, options);
                    }
                    return normalizeRuntimeAuthRefreshResult(
                        result,
                        readTrimmedString(request.refreshAttemptId),
                    );
                } catch (error) {
                    throwIfAborted(options?.signal);
                    const recovery = await reportRecoveryIfPossible(params, request, options?.signal);
                    const unavailableReason = readUnavailableDaemonRefreshErrorReason(error);
                    if (unavailableReason) {
                        return Object.freeze({
                            status: 'unavailable',
                            reason: unavailableReason,
                            ...(recovery ? { recovery } : {}),
                        });
                    }
                    return Object.freeze({
                        status: 'failed',
                        reason: 'runtime_auth_refresh_failed',
                        error: readRuntimeAuthRefreshError(error),
                        ...(request.classification ? { runtimeAuthClassification: request.classification } : {}),
                        ...(recovery ? { recovery } : {}),
                    });
                }
            },
        }),
    });
}
