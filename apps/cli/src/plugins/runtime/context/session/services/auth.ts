import type {
    SessionAuthServiceV1,
    SessionRuntimeAuthRefreshRequestV1,
    SessionRuntimeAuthRefreshResultV1,
} from '@happier-dev/plugin-sdk';

import {
    CATALOG_AGENT_IDS,
    type CatalogAgentId,
} from '@/agent/catalog/ids';
import { getConnectedServiceRuntimeAuthAdapter } from '@/daemon/connectedServices/catalogHooks';
import { reportConnectedServiceRuntimeAuthFailureToDaemon } from '@/daemon/connectedServices/runtimeAuth/reportConnectedServiceRuntimeAuthFailureToDaemon';
import { hasConnectedServiceRuntimeAuthRecoveryContext } from '@/agent/runtime/session/errors/connectedServiceRuntimeAuthRecoveryContext';
import type {
    ConnectedServiceProviderRuntimeAuthAdapter,
    ConnectedServiceRuntimeAuthTargetInput,
} from '@/daemon/connectedServices/runtimeAuth/types';

type RuntimeAuthAdapterResolver = (
    agentId: CatalogAgentId,
) => Promise<ConnectedServiceProviderRuntimeAuthAdapter | null>;

type RuntimeAuthFailureReporter = typeof reportConnectedServiceRuntimeAuthFailureToDaemon;

export type CreateSessionScopedAuthServicesParams = Readonly<{
    readSessionId: (signal?: AbortSignal) => Promise<string | null>;
    resolveAdapter?: RuntimeAuthAdapterResolver;
    reportFailure?: RuntimeAuthFailureReporter;
}>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readTrimmedString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readCatalogAgentId(value: unknown): CatalogAgentId | null {
    const agentId = readTrimmedString(value);
    if (!agentId) {
        return null;
    }
    return (CATALOG_AGENT_IDS as readonly string[]).includes(agentId)
        ? agentId as CatalogAgentId
        : null;
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

function withSelectionHints(
    selection: unknown,
    request: SessionRuntimeAuthRefreshRequestV1,
): unknown {
    if (!isRecord(selection)) {
        return selection;
    }
    const next: Record<string, unknown> = { ...selection };
    if (!Object.prototype.hasOwnProperty.call(next, 'serviceId')) {
        next.serviceId = request.serviceId;
    }
    if (request.planType && !Object.prototype.hasOwnProperty.call(next, 'planType')) {
        next.planType = request.planType;
    }
    return Object.freeze(next);
}

async function reportRecoveryIfPossible(
    params: CreateSessionScopedAuthServicesParams,
    request: SessionRuntimeAuthRefreshRequestV1,
    signal: AbortSignal | undefined,
): Promise<unknown | undefined> {
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
    return await (params.reportFailure ?? reportConnectedServiceRuntimeAuthFailureToDaemon)({
        sessionId,
        classification: request.classification,
    });
}

function buildRefreshInput(
    agentId: CatalogAgentId,
    request: SessionRuntimeAuthRefreshRequestV1,
): ConnectedServiceRuntimeAuthTargetInput {
    return Object.freeze({
        target: Object.freeze({
            agentId,
            ...(request.targetId ? { targetId: request.targetId } : {}),
        }),
        selection: withSelectionHints(request.selection, request),
        ...(request.targetMaterializedEnv ? { targetMaterializedEnv: request.targetMaterializedEnv } : {}),
        ...(request.materializedEnv ? { materializedEnv: request.materializedEnv } : {}),
        ...(request.env ? { env: request.env } : {}),
    });
}

export function createSessionScopedAuthServices(
    params: CreateSessionScopedAuthServicesParams,
): SessionAuthServiceV1 {
    const resolveAdapter = params.resolveAdapter ?? getConnectedServiceRuntimeAuthAdapter;
    return Object.freeze({
        services: Object.freeze({
            async refreshRuntimeAuth(
                request: SessionRuntimeAuthRefreshRequestV1,
                options?: Readonly<{ signal?: AbortSignal }>,
            ): Promise<SessionRuntimeAuthRefreshResultV1> {
                throwIfAborted(options?.signal);
                const agentId = readCatalogAgentId(request.agentId);
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
                    return Object.freeze({
                        status: 'refreshed',
                        result,
                    });
                } catch (error) {
                    throwIfAborted(options?.signal);
                    const recovery = await reportRecoveryIfPossible(params, request, options?.signal);
                    return Object.freeze({
                        status: 'failed',
                        reason: 'runtime_auth_refresh_failed',
                        error,
                        ...(request.classification ? { runtimeAuthClassification: request.classification } : {}),
                        ...(recovery ? { recovery } : {}),
                    });
                }
            },
        }),
    });
}
