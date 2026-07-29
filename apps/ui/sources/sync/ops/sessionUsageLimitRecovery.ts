import { RPC_ERROR_CODES, RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';
import {
    normalizeSessionUsageLimitRecoveryOperationResultV1,
    type SessionUsageLimitRecoveryOperationResultV1,
} from '@happier-dev/protocol';

import { storage } from '@/sync/domains/state/storage';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { readMachineControlTargetForSession, type SessionMachineControlTarget } from './sessionMachineTarget';

export type SessionUsageLimitRecoveryOperationResult = SessionUsageLimitRecoveryOperationResultV1;

const STALE_ACTIVE_SESSION_RPC_FALLBACK_ERRORS = new Set<string>([
    RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    RPC_ERROR_CODES.METHOD_NOT_FOUND,
    'session_rpc_failed',
    'unsupported',
    'unsupported_session_runtime_method',
    'operation has timed out',
]);

type UsageLimitRecoveryPayload = Readonly<{
    sessionId: string;
    issueFingerprint?: string | null;
    remember?: boolean;
    provider?: string;
    operation?: 'check_now' | 'switch_account_now' | 'consume_reset_credit';
    resumePromptMode?: UsageLimitRecoveryResumePromptMode;
}>;

type UsageLimitRecoveryResumePromptMode = 'standard' | 'off' | 'custom';

type UsageLimitRecoveryOperationOptions = Readonly<{
    serverId?: string | null;
    refreshMachineTargets?: () => Promise<void>;
}>;

function readResumePromptMode(value: unknown): UsageLimitRecoveryResumePromptMode | undefined {
    return value === 'standard' || value === 'off' || value === 'custom' ? value : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readOperationResult(response: unknown, sessionId: string): SessionUsageLimitRecoveryOperationResult {
    return normalizeSessionUsageLimitRecoveryOperationResultV1(response, { sessionId });
}

function buildOperationError(params: Readonly<{
    sessionId: string;
    errorCode: string;
    error?: string;
}>): SessionUsageLimitRecoveryOperationResult {
    return normalizeSessionUsageLimitRecoveryOperationResultV1({
        ok: false,
        errorCode: params.errorCode,
        error: params.error ?? params.errorCode,
    }, { sessionId: params.sessionId });
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
        if (typeof raw.status === 'string') tokens.push(raw.status);
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

function resolveOperationErrorCode(
    error: unknown,
    fallback: string,
): string {
    const rpcErrorCode = readRpcErrorCode(error);
    if (rpcErrorCode) return rpcErrorCode;
    const message = error instanceof Error ? error.message.trim() : '';
    return message.length > 0 ? message : fallback;
}

function isInactiveSession(sessionId: string): boolean {
    return storage.getState().sessions?.[sessionId]?.active === false;
}

async function resolveUsageLimitRecoveryMachineControlTarget(
    sessionId: string,
    opts?: UsageLimitRecoveryOperationOptions,
): Promise<SessionMachineControlTarget | null> {
    const target = readMachineControlTargetForSession(sessionId);
    if (target || !opts?.refreshMachineTargets) {
        return target;
    }

    try {
        await opts.refreshMachineTargets();
    } catch {
        return null;
    }

    return readMachineControlTargetForSession(sessionId);
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
        return buildOperationError({
            sessionId,
            errorCode: 'session_usage_limit_recovery_control_machine_unavailable',
        });
    }

    try {
        const response = await machineRpcWithServerScope<SessionUsageLimitRecoveryOperationResult, UsageLimitRecoveryPayload>({
            machineId: target.machineId,
            serverId: opts?.serverId ?? resolvePreferredServerIdForSessionId(sessionId),
            method,
            payload,
        });
        return readOperationResult(response, sessionId);
    } catch (error) {
        const errorCode = resolveOperationErrorCode(error, 'session_usage_limit_recovery_machine_rpc_failed');
        return buildOperationError({
            sessionId,
            errorCode,
            error: error instanceof Error ? error.message : errorCode,
        });
    }
}

async function runUsageLimitRecoveryRpc(
    sessionId: string,
    method: string,
    payload: UsageLimitRecoveryPayload,
    opts?: UsageLimitRecoveryOperationOptions,
): Promise<SessionUsageLimitRecoveryOperationResult> {
    try {
        const response = await sessionRpcWithServerScope<SessionUsageLimitRecoveryOperationResult, UsageLimitRecoveryPayload>({
            sessionId,
            serverId: opts?.serverId ?? resolvePreferredServerIdForSessionId(sessionId),
            method,
            payload,
        });
        return readOperationResult(response, sessionId);
    } catch (error) {
        const errorCode = resolveOperationErrorCode(error, 'session_usage_limit_recovery_session_rpc_failed');
        return buildOperationError({
            sessionId,
            errorCode,
            error: error instanceof Error ? error.message : errorCode,
        });
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

export async function sessionUsageLimitWaitResumeEnable(
    sessionId: string,
    params: Readonly<{
        issueFingerprint?: string | null;
        remember?: boolean;
        resumePromptMode?: UsageLimitRecoveryResumePromptMode;
    }>,
    opts?: UsageLimitRecoveryOperationOptions,
): Promise<SessionUsageLimitRecoveryOperationResult> {
    const resumePromptMode = readResumePromptMode(params.resumePromptMode);
    const payload = {
        sessionId,
        issueFingerprint: params.issueFingerprint ?? null,
        remember: params.remember === true,
        ...(resumePromptMode ? { resumePromptMode } : {}),
    };
    if (isInactiveSession(sessionId)) {
        return await runUsageLimitRecoveryMachineRpc(
            sessionId,
            RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE,
            payload,
            opts,
        );
    }
    return await runUsageLimitRecoveryRpcWithMachineFallback(
        sessionId,
        SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE,
        RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_ENABLE,
        payload,
        opts,
    );
}

export async function sessionUsageLimitWaitResumeCancel(
    sessionId: string,
    params: Readonly<{
        issueFingerprint: string;
        armedAtMs: number;
        runtimeAuthRecoveryAttemptId?: string;
    }>,
    opts?: UsageLimitRecoveryOperationOptions,
): Promise<SessionUsageLimitRecoveryOperationResult> {
    const payload = {
        sessionId,
        issueFingerprint: params.issueFingerprint,
        armedAtMs: params.armedAtMs,
        ...(params.runtimeAuthRecoveryAttemptId
            ? { runtimeAuthRecoveryAttemptId: params.runtimeAuthRecoveryAttemptId }
            : {}),
    };
    if (isInactiveSession(sessionId)) {
        return await runUsageLimitRecoveryMachineRpc(
            sessionId,
            RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL,
            payload,
            opts,
        );
    }
    return await runUsageLimitRecoveryRpcWithMachineFallback(
        sessionId,
        SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL,
        RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_WAIT_RESUME_CANCEL,
        payload,
        opts,
    );
}

export async function sessionUsageLimitCheckNow(
    sessionId: string,
    opts?: Readonly<{
        provider?: string | null;
        resumePromptMode?: UsageLimitRecoveryResumePromptMode;
    }> & UsageLimitRecoveryOperationOptions,
): Promise<SessionUsageLimitRecoveryOperationResult> {
    const provider = typeof opts?.provider === 'string' ? opts.provider.trim() : '';
    const resumePromptMode = readResumePromptMode(opts?.resumePromptMode);
    const payload = {
        sessionId,
        ...(provider.length > 0 ? { provider } : {}),
        ...(resumePromptMode ? { resumePromptMode } : {}),
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

export async function sessionUsageLimitSwitchAccountNow(
    sessionId: string,
    opts?: Readonly<{
        provider?: string | null;
    }> & UsageLimitRecoveryOperationOptions,
): Promise<SessionUsageLimitRecoveryOperationResult> {
    const provider = typeof opts?.provider === 'string' ? opts.provider.trim() : '';
    const payload = {
        sessionId,
        ...(provider.length > 0 ? { provider } : {}),
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
    opts?: Readonly<{
        provider?: string | null;
        issueFingerprint?: string | null;
    }> & UsageLimitRecoveryOperationOptions,
): Promise<SessionUsageLimitRecoveryOperationResult> {
    const provider = typeof opts?.provider === 'string' ? opts.provider.trim() : '';
    const issueFingerprint = readString(opts?.issueFingerprint);
    const payload = {
        sessionId,
        ...(provider.length > 0 ? { provider } : {}),
        ...(issueFingerprint ? { issueFingerprint } : {}),
    };
    if (isInactiveSession(sessionId)) {
        const target = await resolveUsageLimitRecoveryMachineControlTarget(sessionId, opts);
        if (!target) {
            return await runUsageLimitRecoveryRpc(
                sessionId,
                SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT,
                payload,
                opts,
            );
        }
        return await runUsageLimitRecoveryMachineRpc(
            sessionId,
            RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT,
            payload,
            opts,
            target,
        );
    }
    return await runUsageLimitRecoveryRpcWithMachineFallback(
        sessionId,
        SESSION_RPC_METHODS.SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT,
        RPC_METHODS.DAEMON_SESSION_USAGE_LIMIT_CONSUME_RESET_CREDIT,
        payload,
        opts,
    );
}
