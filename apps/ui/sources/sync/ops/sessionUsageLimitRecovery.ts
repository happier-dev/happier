import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import {
    type ConnectedServiceUxDiagnosticV1,
    normalizeSessionUsageLimitRecoveryOperationResultV1,
    type SessionUsageLimitRecoveryOperationResultErrorStatusV1,
    type SessionUsageLimitRecoveryOperationResultV1,
} from '@happier-dev/protocol';

import { storage } from '@/sync/domains/state/storage';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { readMachineControlTargetForSession, type SessionMachineControlTarget } from './sessionMachineTarget';

export type SessionUsageLimitRecoveryOperationResult =
    | Readonly<{
        ok: true;
        status?: SessionUsageLimitRecoveryOperationStatus;
        retryAfterMs?: number;
        uxDiagnostic?: ConnectedServiceUxDiagnosticV1;
        diagnostics?: SessionUsageLimitRecoveryOperationDiagnostics;
    }>
    | Readonly<{
        ok: false;
        status?: SessionUsageLimitRecoveryOperationResultErrorStatusV1;
        error: string;
        errorCode?: string;
        retryAfterMs?: number;
        uxDiagnostic?: ConnectedServiceUxDiagnosticV1;
        diagnostics?: SessionUsageLimitRecoveryOperationDiagnostics;
    }>;

type SessionUsageLimitRecoveryOperationDiagnostics =
    NonNullable<SessionUsageLimitRecoveryOperationResultV1['diagnostics']>;

// Ok-result statuses producible by `mapProtocolUsageLimitRecoveryOkStatus`.
// Exhausted/inactive/rate-limited outcomes always arrive as typed failures.
type SessionUsageLimitRecoveryOperationStatus =
    | 'ready'
    | 'waiting'
    | 'resumed'
    | 'cancelled';

type UsageLimitRecoveryPayload = Readonly<{
    sessionId: string;
    issueFingerprint?: string | null;
    rememberPreference?: boolean;
    resumePromptMode?: 'standard' | 'off' | 'custom';
    operation?: 'check_now' | 'switch_account_now' | 'consume_reset_credit';
    provider?: string;
}>;

type UsageLimitRecoveryOperationOptions = Readonly<{
    serverId?: string | null;
    refreshMachineTargets?: () => Promise<void>;
}>;

type UsageLimitRecoveryAttemptIdentity = Readonly<{
    issueFingerprint: string;
    armedAtMs: number;
    runtimeAuthRecoveryAttemptId?: string;
}>;

type UsageLimitRecoveryResumePromptMode = 'standard' | 'off' | 'custom';

const STALE_ACTIVE_SESSION_RPC_FALLBACK_ERRORS = new Set<string>([
    RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    RPC_ERROR_CODES.METHOD_NOT_FOUND,
    'session_rpc_failed',
    'unsupported',
    'unsupported_session_runtime_method',
    'session_usage_limit_recovery_inert_waiting',
    'operation has timed out',
]);

function readRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readNestedRecoveryRecord(response: unknown): Record<string, unknown> | null {
    const raw = readRecord(response);
    if (!raw) return null;

    const recovery = readRecord(raw.recovery);
    if (recovery) return recovery;

    const result = readRecord(raw.result);
    return readRecord(result?.recovery);
}

function isNullishTiming(value: unknown): boolean {
    return value === null || value === undefined;
}

function isInertWaitingRecoveryResponse(response: unknown): boolean {
    const raw = readRecord(response);
    const recovery = readNestedRecoveryRecord(response);
    if (!raw || !recovery) return false;

    const status = readString(raw.status) ?? readString(recovery.status);
    if (status !== 'waiting') return false;
    if (recovery.maxAttempts !== 0) return false;
    if (!isNullishTiming(recovery.resetAtMs) || !isNullishTiming(recovery.nextCheckAtMs)) return false;

    return typeof raw.retryAfterMs !== 'number'
        && typeof recovery.retryAfterMs !== 'number';
}

function mapProtocolUsageLimitRecoveryOkStatus(
    status: SessionUsageLimitRecoveryOperationResultV1['status'],
): SessionUsageLimitRecoveryOperationStatus | undefined {
    switch (status) {
        case 'ready':
        case 'waiting':
        case 'resumed':
        case 'cancelled':
            return status;
        case 'already_ready':
            return 'ready';
        case 'no_recovery_needed':
            return 'resumed';
        case 'switch_attempted':
        case 'switch_applied':
        case 'switch_observed':
            return 'waiting';
        default:
            return undefined;
    }
}

function readUsageLimitRecoveryOperationResult(
    response: unknown,
    sessionId: string,
): SessionUsageLimitRecoveryOperationResult {
    if (isInertWaitingRecoveryResponse(response)) {
        return {
            ok: false,
            status: 'unsupported',
            error: 'session_usage_limit_recovery_inert_waiting',
            errorCode: 'session_usage_limit_recovery_inert_waiting',
        };
    }

    const result = normalizeSessionUsageLimitRecoveryOperationResultV1(response, { sessionId });
    if (result.ok) {
        const status = mapProtocolUsageLimitRecoveryOkStatus(result.status);
        return {
            ok: true,
            ...(status ? { status } : {}),
            ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
            ...(result.uxDiagnostic ? { uxDiagnostic: result.uxDiagnostic } : {}),
            ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
        };
    }

    return {
        ok: false,
        status: result.status,
        error: result.errorCode,
        errorCode: result.errorCode,
        ...(result.retryAfterMs !== undefined ? { retryAfterMs: result.retryAfterMs } : {}),
        ...(result.uxDiagnostic ? { uxDiagnostic: result.uxDiagnostic } : {}),
        ...(result.diagnostics ? { diagnostics: result.diagnostics } : {}),
    };
}

function readFallbackErrorTokens(value: unknown): ReadonlyArray<string> {
    const tokens: string[] = [];
    const rpcErrorCode = readRpcErrorCode(value);
    if (rpcErrorCode) tokens.push(rpcErrorCode);

    if (value && typeof value === 'object') {
        const raw = value as Record<string, unknown>;
        if (typeof raw.errorCode === 'string') tokens.push(raw.errorCode);
        if (typeof raw.error === 'string') tokens.push(raw.error);
        if (typeof raw.message === 'string') tokens.push(raw.message);
    } else if (typeof value === 'string') {
        tokens.push(value);
    }

    return tokens;
}

function shouldFallbackFromStaleActiveSessionRpcFailure(value: unknown): boolean {
    return readFallbackErrorTokens(value).some((token) => (
        STALE_ACTIVE_SESSION_RPC_FALLBACK_ERRORS.has(token)
        || token.startsWith('unsupported_session_runtime_method:')
    ));
}

function isInactiveSession(sessionId: string): boolean {
    return storage.getState().sessions?.[sessionId]?.active === false;
}

async function resolveUsageLimitRecoveryMachineControlTarget(
    sessionId: string,
    opts?: UsageLimitRecoveryOperationOptions,
): Promise<SessionMachineControlTarget | null> {
    const target = readMachineControlTargetForSession(sessionId);
    if (target?.confidence === 'reachable' || !opts?.refreshMachineTargets) {
        return target;
    }

    try {
        await opts.refreshMachineTargets();
    } catch {
        return target;
    }

    return readMachineControlTargetForSession(sessionId) ?? target;
}

async function runUsageLimitRecoveryMachineRpc(
    sessionId: string,
    method: string,
    payload: UsageLimitRecoveryPayload,
    opts?: UsageLimitRecoveryOperationOptions,
    resolvedTarget?: SessionMachineControlTarget | null,
): Promise<SessionUsageLimitRecoveryOperationResult> {
    const target = resolvedTarget ?? await resolveUsageLimitRecoveryMachineControlTarget(sessionId, opts);
    if (!target) {
        return {
            ok: false,
            error: 'session_usage_limit_recovery_control_machine_unavailable',
            errorCode: 'session_usage_limit_recovery_control_machine_unavailable',
        };
    }

    try {
        const response = await machineRpcWithServerScope<unknown, UsageLimitRecoveryPayload>({
            machineId: target.machineId,
            serverId: opts?.serverId ?? resolvePreferredServerIdForSessionId(sessionId),
            method,
            payload,
        });
        return readUsageLimitRecoveryOperationResult(response, sessionId);
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}

async function runUsageLimitRecoveryRpc(
    sessionId: string,
    method: string,
    payload: UsageLimitRecoveryPayload,
    opts?: UsageLimitRecoveryOperationOptions,
): Promise<SessionUsageLimitRecoveryOperationResult> {
    try {
        const response = await sessionRpcWithServerScope<unknown, UsageLimitRecoveryPayload>({
            sessionId,
            serverId: opts?.serverId ?? resolvePreferredServerIdForSessionId(sessionId),
            method,
            payload,
        });
        return readUsageLimitRecoveryOperationResult(response, sessionId);
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}

async function runUsageLimitRecoveryRpcWithMachineFallback(
    sessionId: string,
    sessionMethod: string,
    machineMethod: string,
    payload: UsageLimitRecoveryPayload,
    opts?: UsageLimitRecoveryOperationOptions,
): Promise<SessionUsageLimitRecoveryOperationResult> {
    const result = await runUsageLimitRecoveryRpc(sessionId, sessionMethod, payload, opts);
    if (result.ok === false && shouldFallbackFromStaleActiveSessionRpcFailure(result)) {
        const target = await resolveUsageLimitRecoveryMachineControlTarget(sessionId, opts);
        if (!target) {
            return result;
        }
        return await runUsageLimitRecoveryMachineRpc(sessionId, machineMethod, payload, opts, target);
    }
    return result;
}

export function sessionUsageLimitWaitResumeEnable(
    sessionId: string,
    request?: Readonly<{
        issueFingerprint?: string | null;
        rememberPreference?: boolean;
        resumePromptMode?: 'standard' | 'off' | 'custom' | null;
    }>,
    opts?: UsageLimitRecoveryOperationOptions,
): Promise<SessionUsageLimitRecoveryOperationResult> {
    const payload = {
        sessionId,
        ...(typeof request?.issueFingerprint === 'string' && request.issueFingerprint.trim().length > 0
            ? { issueFingerprint: request.issueFingerprint.trim() }
            : request?.issueFingerprint === null
                ? { issueFingerprint: null }
                : {}),
        ...(request?.rememberPreference === true ? { rememberPreference: true } : {}),
        ...(request?.resumePromptMode === 'standard' || request?.resumePromptMode === 'off' || request?.resumePromptMode === 'custom'
            ? { resumePromptMode: request.resumePromptMode }
            : {}),
    };
    if (isInactiveSession(sessionId)) {
        return runUsageLimitRecoveryMachineRpc(
            sessionId,
            RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE,
            payload,
            opts,
        );
    }
    return runUsageLimitRecoveryRpcWithMachineFallback(
        sessionId,
        SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE,
        RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE,
        payload,
        opts,
    );
}

export function sessionUsageLimitWaitResumeCancel(
    sessionId: string,
    attempt: UsageLimitRecoveryAttemptIdentity,
    opts?: UsageLimitRecoveryOperationOptions,
): Promise<SessionUsageLimitRecoveryOperationResult> {
    const payload = { sessionId, ...attempt };
    if (isInactiveSession(sessionId)) {
        return runUsageLimitRecoveryMachineRpc(
            sessionId,
            RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL,
            payload,
            opts,
        );
    }
    return runUsageLimitRecoveryRpcWithMachineFallback(
        sessionId,
        SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL,
        RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL,
        payload,
        opts,
    );
}

export async function sessionUsageLimitCheckNow(
    sessionId: string,
    opts?: UsageLimitRecoveryOperationOptions & Readonly<{
        provider?: string | null;
        resumePromptMode?: UsageLimitRecoveryResumePromptMode | null;
    }>,
): Promise<SessionUsageLimitRecoveryOperationResult> {
    const provider = typeof opts?.provider === 'string' ? opts.provider.trim() : '';
    const payload = {
        sessionId,
        ...(provider.length > 0 ? { provider } : {}),
        ...(opts?.resumePromptMode === 'standard' || opts?.resumePromptMode === 'off' || opts?.resumePromptMode === 'custom'
            ? { resumePromptMode: opts.resumePromptMode }
            : {}),
    };
    if (isInactiveSession(sessionId)) {
        const target = await resolveUsageLimitRecoveryMachineControlTarget(sessionId, opts);
        if (!target) {
            return await runUsageLimitRecoveryRpc(
                sessionId,
                SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW,
                payload,
                opts,
            );
        }
        return await runUsageLimitRecoveryMachineRpc(
            sessionId,
            RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
            payload,
            opts,
            target,
        );
    }
    return runUsageLimitRecoveryRpcWithMachineFallback(
        sessionId,
        SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW,
        RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
        payload,
        opts,
    );
}

export async function sessionUsageLimitSwitchAccountNow(
    sessionId: string,
    opts?: UsageLimitRecoveryOperationOptions & Readonly<{
        provider?: string | null;
        resumePromptMode?: UsageLimitRecoveryResumePromptMode | null;
    }>,
): Promise<SessionUsageLimitRecoveryOperationResult> {
    const provider = typeof opts?.provider === 'string' ? opts.provider.trim() : '';
    const payload = {
        sessionId,
        ...(provider.length > 0 ? { provider } : {}),
        ...(opts?.resumePromptMode === 'standard' || opts?.resumePromptMode === 'off' || opts?.resumePromptMode === 'custom'
            ? { resumePromptMode: opts.resumePromptMode }
            : {}),
        operation: 'switch_account_now' as const,
    };
    if (isInactiveSession(sessionId)) {
        const target = await resolveUsageLimitRecoveryMachineControlTarget(sessionId, opts);
        if (!target) {
            return await runUsageLimitRecoveryRpc(
                sessionId,
                SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW,
                payload,
                opts,
            );
        }
        return await runUsageLimitRecoveryMachineRpc(
            sessionId,
            RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
            payload,
            opts,
            target,
        );
    }
    return await runUsageLimitRecoveryRpcWithMachineFallback(
        sessionId,
        SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW,
        RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
        payload,
        opts,
    );
}

export async function sessionUsageLimitConsumeResetCredit(
    sessionId: string,
    opts?: UsageLimitRecoveryOperationOptions & Readonly<{
        provider?: string | null;
        resumePromptMode?: UsageLimitRecoveryResumePromptMode | null;
    }>,
): Promise<SessionUsageLimitRecoveryOperationResult> {
    const provider = typeof opts?.provider === 'string' ? opts.provider.trim() : '';
    const payload = {
        sessionId,
        ...(provider.length > 0 ? { provider } : {}),
        ...(opts?.resumePromptMode === 'standard' || opts?.resumePromptMode === 'off' || opts?.resumePromptMode === 'custom'
            ? { resumePromptMode: opts.resumePromptMode }
            : {}),
        operation: 'consume_reset_credit' as const,
    };
    if (isInactiveSession(sessionId)) {
        const target = await resolveUsageLimitRecoveryMachineControlTarget(sessionId, opts);
        if (!target) {
            return await runUsageLimitRecoveryRpc(
                sessionId,
                SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW,
                payload,
                opts,
            );
        }
        return await runUsageLimitRecoveryMachineRpc(
            sessionId,
            RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
            payload,
            opts,
            target,
        );
    }
    return await runUsageLimitRecoveryRpcWithMachineFallback(
        sessionId,
        SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CHECK_NOW,
        RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CHECK_NOW,
        payload,
        opts,
    );
}
