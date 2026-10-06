import type {
    SessionAuthService,
    SessionRuntimeAuthRefreshRequest,
    SessionRuntimeAuthRefreshResult,
} from '@happier-dev/plugin-sdk/sessions';
import {
    AgentSessionAuthRefreshErrorV1Schema,
    AgentSessionAuthRefreshPayloadV1Schema,
    normalizeAgentSessionAuthRefreshErrorV1,
} from '@happier-dev/protocol/runtime/authRefresh';
import type { AgentSessionAuthRefreshErrorV1, AgentSessionAuthRefreshRecoveryV1 } from '@happier-dev/protocol';

import { projectConnectedServiceRuntimeAuthSelection } from '@/daemon/connectedServices/runtimeAuth/projectRuntimeAuthTargetInput';
import { readTrimmedString } from './session/services/readTrimmedString';

const RUNTIME_AUTH_REFRESH_DAEMON_ACK_TIMEOUT_MS = 120_000;

export type DaemonRuntimeAuthRefreshRequest = Readonly<{
    serviceId: string;
    refreshAttemptId: string;
    selection: Readonly<Record<string, unknown>>;
    expectedCredentialRevision: string;
    planType?: string | null;
    failingAccessTokenFingerprint?: string | null;
    reason?: string | null;
}>;

export type RuntimeAuthRefreshViaDaemon = (
    request: DaemonRuntimeAuthRefreshRequest,
    options: Readonly<{ timeoutMs: number }>,
) => Promise<unknown>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function readRuntimeAuthRefreshError(error: unknown): AgentSessionAuthRefreshErrorV1 {
    const parsed = AgentSessionAuthRefreshErrorV1Schema.safeParse(error);
    return parsed.success ? parsed.data : normalizeAgentSessionAuthRefreshErrorV1(error);
}

export function normalizeRuntimeAuthRefreshResult(
    value: unknown,
    expectedRefreshAttemptId: string | null,
): SessionRuntimeAuthRefreshResult {
    if (!isRecord(value)) return Object.freeze({ status: 'failed', reason: 'runtime_auth_refresh_invalid_result' });
    if (value.status === 'refreshed') {
        const result = AgentSessionAuthRefreshPayloadV1Schema.safeParse(
            Object.prototype.hasOwnProperty.call(value, 'result') ? value.result : value,
        );
        return result.success
            ? Object.freeze({ status: 'refreshed', result: result.data })
            : Object.freeze({ status: 'failed', reason: 'runtime_auth_refresh_invalid_result' });
    }
    if (value.status === 'pending') {
        const refreshAttemptId = readTrimmedString(value.refreshAttemptId);
        return refreshAttemptId && refreshAttemptId === expectedRefreshAttemptId
            ? Object.freeze({ status: 'pending', refreshAttemptId })
            : Object.freeze({ status: 'failed', reason: 'runtime_auth_refresh_attempt_mismatch' });
    }
    if (value.status === 'unavailable' || value.status === 'forbidden') {
        return Object.freeze({ status: 'unavailable', reason: readTrimmedString(value.reason) ?? 'runtime_auth_refresh_unavailable' });
    }
    if (value.status === 'failed') {
        return Object.freeze({
            status: 'failed',
            reason: readTrimmedString(value.reason) ?? 'runtime_auth_refresh_failed',
            ...(Object.prototype.hasOwnProperty.call(value, 'error') ? { error: readRuntimeAuthRefreshError(value.error) } : {}),
        });
    }
    if (value.status === 'available' || value.status === 'unsupported') {
        return Object.freeze({ status: 'unavailable', reason: 'runtime_auth_refresh_not_proven' });
    }
    return Object.freeze({ status: 'failed', reason: 'runtime_auth_refresh_invalid_result' });
}

export function readUnavailableDaemonRefreshErrorReason(error: unknown): string | null {
    const reason = readTrimmedString(error instanceof Error ? error.message : error);
    return reason === 'connected_service_session_refresh_forbidden'
        || reason === 'connected_service_daemon_auth_bridge_unavailable'
        || reason === 'connected_service_session_refresh_service_id_mismatch'
        || reason === 'connected_service_run_refresh_forbidden'
        || reason === 'connected_service_run_activation_stale'
        || reason === 'connected_service_run_materialization_unavailable'
        ? reason : null;
}

export function withRuntimeAuthSelectionHints(
    selection: unknown,
    request: SessionRuntimeAuthRefreshRequest,
): Readonly<Record<string, unknown>> {
    if (!isRecord(selection)) return Object.freeze({ serviceId: request.serviceId });
    const next: Record<string, unknown> = { ...selection };
    if (!Object.prototype.hasOwnProperty.call(next, 'serviceId')) next.serviceId = request.serviceId;
    return projectConnectedServiceRuntimeAuthSelection(next);
}

/** Shared Session/Run daemon admission and settlement; scope is stamped by its host owner. */
export function createDaemonRuntimeAuthRefreshService(params: Readonly<{
    refreshViaDaemon: RuntimeAuthRefreshViaDaemon;
    reportRecovery?: (
        request: SessionRuntimeAuthRefreshRequest,
        signal?: AbortSignal,
    ) => Promise<AgentSessionAuthRefreshRecoveryV1 | undefined>;
}>): SessionAuthService['services'] {
    return Object.freeze({
        async refreshRuntimeAuth(request, options) {
            options?.signal?.throwIfAborted();
            const serviceId = readTrimmedString(request.serviceId);
            if (!serviceId) return Object.freeze({ status: 'unavailable', reason: 'runtime_auth_target_unavailable' });
            if (request.selection === undefined || request.selection === null) {
                return Object.freeze({ status: 'unavailable', reason: 'runtime_auth_selection_unavailable' });
            }
            if (!request.expectedCredentialRevision) {
                return Object.freeze({ status: 'unavailable', reason: 'runtime_auth_credential_revision_unavailable' });
            }
            const refreshAttemptId = readTrimmedString(request.refreshAttemptId);
            if (!refreshAttemptId) {
                return Object.freeze({ status: 'unavailable', reason: 'runtime_auth_refresh_attempt_identity_unavailable' });
            }
            // Cancellation ends admission only. Once admitted, the daemon owns settlement;
            // this waiter observes it even when the caller detaches locally.
            options?.signal?.throwIfAborted();
            try {
                const result = await params.refreshViaDaemon({
                    serviceId,
                    refreshAttemptId,
                    selection: withRuntimeAuthSelectionHints(request.selection, request),
                    expectedCredentialRevision: request.expectedCredentialRevision,
                    ...(request.planType === undefined ? {} : { planType: request.planType }),
                    ...(request.failingAccessTokenFingerprint === undefined ? {} : { failingAccessTokenFingerprint: request.failingAccessTokenFingerprint }),
                    ...(request.reason === undefined ? {} : { reason: request.reason }),
                }, { timeoutMs: RUNTIME_AUTH_REFRESH_DAEMON_ACK_TIMEOUT_MS });
                return normalizeRuntimeAuthRefreshResult(result, refreshAttemptId);
            } catch (error) {
                const recovery = await params.reportRecovery?.(request, options?.signal);
                const unavailableReason = readUnavailableDaemonRefreshErrorReason(error);
                return unavailableReason
                    ? Object.freeze({ status: 'unavailable', reason: unavailableReason, ...(recovery ? { recovery } : {}) })
                    : Object.freeze({
                        status: 'failed', reason: 'runtime_auth_refresh_failed',
                        error: readRuntimeAuthRefreshError(error),
                        ...(request.classification ? { runtimeAuthClassification: request.classification } : {}),
                        ...(recovery ? { recovery } : {}),
                    });
            }
        },
    });
}
