import type {
    SessionAuthService,
    SessionRuntimeAuthRefreshRequest,
    SessionRuntimeAuthRefreshResult,
} from '@happier-dev/plugin-sdk/sessions';
import {
    AgentSessionAuthRefreshErrorV1Schema,
    AgentSessionAuthRefreshPayloadV1Schema,
    AgentSessionAuthRefreshRecoveryV1Schema,
    normalizeAgentSessionAuthRefreshErrorV1,
    type AgentSessionAuthRefreshErrorV1,
    type AgentSessionAuthRefreshRecoveryV1,
} from '@happier-dev/protocol';

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

type RuntimeAuthAdapterResolver = (
    agentId: CatalogAgentId,
) => Promise<ConnectedServiceProviderRuntimeAuthAdapter | null>;

type RuntimeAuthFailureReporter = typeof reportConnectedServiceRuntimeAuthFailureToDaemon;
const RUNTIME_AUTH_REFRESH_DAEMON_ACK_TIMEOUT_MS = 120_000;

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

function readRefreshFailureReason(value: unknown, fallback: string): string {
    return readTrimmedString(isRecord(value) ? value.reason : null) ?? fallback;
}

function readRuntimeAuthRefreshError(error: unknown): AgentSessionAuthRefreshErrorV1 {
    const parsed = AgentSessionAuthRefreshErrorV1Schema.safeParse(error);
    return parsed.success ? parsed.data : normalizeAgentSessionAuthRefreshErrorV1(error);
}

function normalizeRuntimeAuthRefreshResult(
    value: unknown,
    expectedRefreshAttemptId: string | null,
): SessionRuntimeAuthRefreshResult {
    if (!isRecord(value)) {
        return Object.freeze({
            status: 'failed',
            reason: 'runtime_auth_refresh_invalid_result',
        });
    }
    if (value.status === 'refreshed') {
        const result = AgentSessionAuthRefreshPayloadV1Schema.safeParse(
            Object.prototype.hasOwnProperty.call(value, 'result') ? value.result : value,
        );
        if (!result.success) {
            return Object.freeze({
                status: 'failed',
                reason: 'runtime_auth_refresh_invalid_result',
            });
        }
        return Object.freeze({
            status: 'refreshed',
            result: result.data,
        });
    }
    if (value.status === 'pending') {
        const refreshAttemptId = readTrimmedString(value.refreshAttemptId);
        if (refreshAttemptId && refreshAttemptId === expectedRefreshAttemptId) {
            return Object.freeze({ status: 'pending', refreshAttemptId });
        }
        return Object.freeze({
            status: 'failed',
            reason: 'runtime_auth_refresh_attempt_mismatch',
        });
    }
    if (value.status === 'unavailable' || value.status === 'forbidden') {
        return Object.freeze({
            status: 'unavailable',
            reason: readRefreshFailureReason(value, 'runtime_auth_refresh_unavailable'),
        });
    }
    if (value.status === 'failed') {
        return Object.freeze({
            status: 'failed',
            reason: readRefreshFailureReason(value, 'runtime_auth_refresh_failed'),
            ...(Object.prototype.hasOwnProperty.call(value, 'error')
                ? { error: readRuntimeAuthRefreshError(value.error) }
                : {}),
        });
    }
    if (value.status === 'available' || value.status === 'unsupported') {
        return Object.freeze({
            status: 'unavailable',
            reason: 'runtime_auth_refresh_not_proven',
        });
    }
    return Object.freeze({
        status: 'failed',
        reason: 'runtime_auth_refresh_invalid_result',
    });
}

function readUnavailableDaemonRefreshErrorReason(error: unknown): string | null {
    const reason = readTrimmedString(error instanceof Error ? error.message : error);
    return reason === 'connected_service_session_refresh_forbidden'
        || reason === 'connected_service_daemon_auth_bridge_unavailable'
        || reason === 'connected_service_session_refresh_service_id_mismatch'
        ? reason
        : null;
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

function withSelectionHints(
    selection: unknown,
    request: SessionRuntimeAuthRefreshRequest,
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
        selection: withSelectionHints(request.selection, request),
        ...(request.targetMaterializedEnv ? { targetMaterializedEnv: request.targetMaterializedEnv } : {}),
        ...(request.materializedEnv ? { materializedEnv: request.materializedEnv } : {}),
        ...(request.env ? { env: request.env } : {}),
        ...(request.failingAccessTokenFingerprint
            ? { failingAccessTokenFingerprint: request.failingAccessTokenFingerprint }
            : {}),
        ...(request.expectedCredentialRevision
            ? { expectedCredentialRevision: request.expectedCredentialRevision }
            : {}),
        ...(request.reason ? { reason: request.reason } : {}),
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
                        const expectedCredentialRevision = request.expectedCredentialRevision;
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
                        // Admission is the daemon request invocation below. Caller cancellation is
                        // honored up to this point; once admitted, the canonical coordinator owns
                        // settlement and this waiter must observe that authoritative result instead
                        // of turning a detached local abort into a definitive refresh failure.
                        throwIfAborted(options?.signal);
                        const daemonResult = await (
                            params.refreshViaDaemon ?? requestDaemonSessionConnectedServiceRuntimeAuthRefresh
                        )({
                                sessionId,
                                serviceId,
                                refreshAttemptId,
                                selection: withSelectionHints(request.selection, request),
                                ...(request.planType === undefined ? {} : { planType: request.planType }),
                                ...(request.failingAccessTokenFingerprint === undefined
                                    ? {}
                                    : { failingAccessTokenFingerprint: request.failingAccessTokenFingerprint }),
                                expectedCredentialRevision,
                                ...(request.reason === undefined ? {} : { reason: request.reason }),
                            }, { timeoutMs: RUNTIME_AUTH_REFRESH_DAEMON_ACK_TIMEOUT_MS });
                        return normalizeRuntimeAuthRefreshResult(daemonResult, refreshAttemptId);
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
