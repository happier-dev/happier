import type {
    ExecutionRunActionRequest,
    ExecutionRunActionResponse,
    ExecutionRunCancelTurnRequest,
    ExecutionRunCancelTurnResponse,
    ExecutionRunEnsureRequest,
    ExecutionRunEnsureResponse,
    ExecutionRunEnsureOrStartRequest,
    ExecutionRunGetRequest,
    ExecutionRunGetResponse,
    ExecutionRunListRequest,
    ExecutionRunListResponse,
    ExecutionRunStartRequest,
    ExecutionRunStartResponse,
    ExecutionRunStopRequest,
    ExecutionRunStopResponse,
} from '@happier-dev/protocol';
import {
    ExecutionRunGetResponseSchema,
    ExecutionRunListResponseSchema,
    ExecutionRunStartResponseSchema,
    ExecutionRunStartFailureDetailsV1Schema,
    withExecutionRunStartFailureDetails,
} from '@happier-dev/protocol/execution/runs/responseSchemas';
import { requiresProviderSafeExecutionRunStartRpc } from '@happier-dev/protocol/execution/runs/startRequest';
import { RPC_ERROR_CODES, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { sessionRpcWithServerAccountScope, sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ActionExecutorContext } from '@happier-dev/protocol/actions/executor/types';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { createUiAccountAction } from '@/sync/ops/actions/accountActionDeps';
import { runWithServerRequestAuthorityForServerAccountScope } from '@/sync/runtime/orchestration/serverScopedRpc/createServerRequestWithServerScope';
import { SessionSnapshotReadError } from '@/sync/runtime/orchestration/serverScopedRpc/readSessionSnapshotForAuthority';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { isActionAccountScopeChangedError } from '@/sync/domains/scope/actionAccountScopeError';
import { notifyExecutionRunActivity } from '@/sync/runtime/executionRuns/executionRunActivityBus';
import {
    INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
    canUseSessionRpc,
    readMachineControlTargetForSession,
} from '@/sync/ops/sessionMachineTarget';
import { storage } from '@/sync/domains/state/storage';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import {
    canSendUserMessageToSession,
    SESSION_MESSAGE_SEND_NOT_RESUMABLE_ERROR_CODE,
} from '@/sync/domains/session/input/sessionMessageSendEligibility';

export type SessionExecutionRunActionResult =
    | ExecutionRunActionResponse
    | { ok: false; error: string; errorCode?: string };

export type SessionExecutionRunStartResult =
    | ExecutionRunStartResponse
    | { ok: false; error: string; errorCode?: string; details?: unknown };

export type SessionExecutionRunStopResult =
    | ExecutionRunStopResponse
    | { ok: false; error: string; errorCode?: string };

export type SessionExecutionRunCancelTurnResult =
    | ExecutionRunCancelTurnResponse
    | { ok: false; error: string; errorCode?: string };

export type SessionExecutionRunEnsureResult =
    | ExecutionRunEnsureResponse
    | { ok: false; error: string; errorCode?: string };

export type SessionExecutionRunListResult =
    | ExecutionRunListResponse
    | { ok: false; error: string; errorCode?: string };

export type SessionExecutionRunGetResult =
    | ExecutionRunGetResponse
    | { ok: false; error: string; errorCode?: string };

function executionRunSessionRpc<R, A>(params: Readonly<{
    sessionId: string;
    serverId: string;
    scope?: ServerAccountScope;
    method: string;
    payload: A;
    timeoutMs?: number | null;
    signal?: AbortSignal;
    onIssued?: () => void;
}>): Promise<R> {
    return params.scope
        ? sessionRpcWithServerAccountScope<R, A>({ ...params, scope: params.scope })
        : sessionRpcWithServerScope<R, A>(params);
}

function readErrorResponseShape(response: unknown): { ok: false; error: string; errorCode?: string; details?: unknown } | null {
    if (!response || typeof response !== 'object') return null;
    if (typeof (response as any).error !== 'string') return null;
    return {
        ok: false,
        error: String((response as any).error),
        ...(typeof (response as any).errorCode === 'string' ? { errorCode: String((response as any).errorCode) } : {}),
        ...('details' in response ? { details: (response as { details?: unknown }).details } : {}),
    };
}

type SessionExecutionRunReadOptions = Readonly<{
    serverId?: string | null;
    scope?: ServerAccountScope;
    signal?: AbortSignal;
    account?: LazyActionAccountContext;
    context?: ActionExecutorContext;
}>;

/** Live Session RPC and retained reads share the CLI source owner after a typed route loss. */
async function readSessionExecutionRun(
    actionId: 'execution.run.get' | 'execution.run.list' | 'execution.run.wait',
    sessionId: string,
    request: unknown,
    serverId: string,
    opts?: SessionExecutionRunReadOptions,
): Promise<unknown> {
    let account: LazyActionAccountContext | undefined;
    try {
        // Capture before the first suspension: a late route failure must not
        // borrow a replacement Account's credentials for its retained read.
        try { account = opts?.account ?? await captureLazyActionAccountContext(serverId, opts?.signal); }
        catch { /* Session-scoped viewers retain their existing live RPC path. */ }
        account?.assertCurrent();
        if (account && (opts?.scope && opts.scope.accountId !== account.accountId
            || opts?.context?.runtimeAccountId && opts.context.runtimeAccountId !== account.accountId
            || !areServerProfileIdentifiersEquivalent(account.serverId, serverId))) {
            return { ok: false, error: 'action_account_scope_changed', errorCode: 'action_account_scope_changed' };
        }
        let response: unknown;
        try {
            response = await executionRunSessionRpc({ sessionId, serverId, scope: opts?.scope,
                method: actionId, payload: request, signal: opts?.signal,
                ...(actionId === 'execution.run.get' && request && typeof request === 'object'
                    && ('waitForInputId' in request && request.waitForInputId || 'waitForOutput' in request && request.waitForOutput)
                    ? { timeoutMs: null } : {}) });
        } catch (error) {
            response = { ok: false, error: error instanceof Error ? error.message : 'Unknown error', errorCode: readRpcErrorCode(error) };
        }
        account?.assertCurrent();
        const failure = readErrorResponseShape(response);
        if (!failure || ![RPC_ERROR_CODES.METHOD_NOT_AVAILABLE, RPC_ERROR_CODES.METHOD_NOT_FOUND,
            RPC_ERROR_CODES.CLIENT_NOT_AVAILABLE, RPC_ERROR_CODES.TRANSPORT_UNAVAILABLE,
            'target_unavailable', 'execution_run_target_unavailable', 'execution_run_not_found'].includes(failure.errorCode ?? '')) return response;
        // A restricted invocation cannot borrow the app's private Account authority.
        if (opts?.signal?.aborted || opts?.context?.externalActionCredential || opts?.context?.externalActionExecutionAuthorization
            || opts?.context?.rpcSessionAuthorization) return response;
        if (!account) return response;
        account.assertCurrent();
        const captured = account;
        const { sync } = await import('@/sync/sync');
        const hydrated = await runWithServerRequestAuthorityForServerAccountScope({ scope: account.accountLifetime.scope,
            activeRequest: account.request }, authority => sync.ensureSessionVisibleForMessageRoute(sessionId, {
                serverId: authority.scope.serverId, authority, hydrateMessages: false,
                scopeCurrentness: captured.accountLifetime.isCurrent, signal: opts?.signal,
            }));
        account.assertCurrent();
        opts?.signal?.throwIfAborted();
        if (hydrated.kind !== 'available') {
            throw new SessionSnapshotReadError(hydrated.errorCode
                ?? (hydrated.kind === 'missing' ? hydrated.cause : 'content_unavailable'));
        }
        const session = storage.getState().sessions[sessionId];
        if (!session || !areServerProfileIdentifiersEquivalent(session.serverId, account.serverId)) return response;
        const machineId = readSessionOwnerMetadataView(session)?.machineId?.trim();
        if (!machineId) return response;
        const target = opts?.context?.externalActionTarget;
        if (target && (target.kind === 'machine' ? target.machineId !== machineId : target.sessionId !== sessionId)) {
            return { ok: false, error: 'target_not_local', errorCode: 'target_not_local' };
        }
        if (!request || typeof request !== 'object' || Array.isArray(request)) {
            return { ok: false, error: 'invalid_parameters', errorCode: 'invalid_parameters' };
        }
        return await createUiAccountAction({ account })({ actionId, input: { ...request, sessionId },
            context: { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' }, ...opts?.context,
                serverId: account.serverId, runtimeAccountId: account.accountId,
                externalActionTarget: { kind: 'machine', machineId }, signal: opts?.signal } });
    } catch (error) {
        const code = isActionAccountScopeChangedError(error) ? 'action_account_scope_changed'
            : error instanceof SessionSnapshotReadError ? error.errorCode : readRpcErrorCode(error) ?? 'content_unavailable';
        return { ok: false, error: code, errorCode: code };
    } finally {
        if (account && account !== opts?.account) account.dispose();
    }
}

export function isExecutionRunNotRunningMutationError(result: unknown): boolean {
    if (!result || typeof result !== 'object') return false;
    if ((result as any).ok !== false) return false;

    const errorCode = typeof (result as any).errorCode === 'string' ? String((result as any).errorCode).trim().toLowerCase() : '';
    if (errorCode === 'execution_run_not_allowed' || errorCode === 'execution_run_not_running') return true;

    const error = typeof (result as any).error === 'string' ? String((result as any).error).trim().toLowerCase() : '';
    return error.includes('not running') || error.includes('already finished');
}

/** Withdrawal of a caller's observation is not a daemon refusal and must not offer destructive fallback. */
export function isExecutionRunMutationCancelled(result: unknown): boolean {
    const errorCode = result && typeof result === 'object' && 'errorCode' in result
        ? result.errorCode : readRpcErrorCode(result);
    return errorCode === 'SOCKET_RPC_ABORTED' || errorCode === 'MACHINE_RPC_ABORTED';
}

function createInactiveSessionRpcUnavailableResult(): { ok: false; error: string; errorCode: string } {
    return {
        ok: false,
        error: INACTIVE_SESSION_RPC_UNAVAILABLE_ERROR,
        errorCode: RPC_ERROR_CODES.METHOD_NOT_AVAILABLE,
    };
}

function resolveExecutionRunSessionServerId(
    sessionId: string,
    requestedServerId?: string | null,
    access: 'read' | 'mutate' = 'mutate',
): string | null {
    const explicitServerId = typeof requestedServerId === 'string' ? requestedServerId.trim() : '';
    const session = storage.getState().sessions[sessionId] ?? null;
    const storedServerId = typeof session?.serverId === 'string' ? session.serverId.trim() : '';
    if (explicitServerId) {
        // Reads authenticate the exact requested Home below; an ambient row on
        // another Home cannot revoke that address or supply mutation eligibility.
        if (access === 'mutate' && storedServerId && !areServerProfileIdentifiersEquivalent(storedServerId, explicitServerId)) {
            return null;
        }
        return explicitServerId;
    }
    return storedServerId || null;
}

function createExecutionRunHomeUnavailableResult(): { ok: false; error: string; errorCode: string } {
    return {
        ok: false,
        error: 'Execution Run Home is unavailable',
        errorCode: 'execution_run_home_unavailable',
    };
}

function ensureExecutionRunMutationAllowed(sessionId: string): { ok: false; error: string; errorCode: string } | null {
    if (canUseSessionRpc(sessionId)) return null;
    return createInactiveSessionRpcUnavailableResult();
}

function createSessionMessageNotResumableResult(): { ok: false; error: string; errorCode: string } {
    return {
        ok: false,
        error: SESSION_MESSAGE_SEND_NOT_RESUMABLE_ERROR_CODE,
        errorCode: SESSION_MESSAGE_SEND_NOT_RESUMABLE_ERROR_CODE,
    };
}

function ensureExecutionRunUserMessageAllowed(sessionId: string): { ok: false; error: string; errorCode: string } | null {
    const state = storage.getState();
    const session = state.sessions[sessionId] ?? null;
    if (!session) return null;
    return canSendUserMessageToSession(session, {
        resumeCapabilityOptions: { accountSettings: state.settings },
    }) ? null : createSessionMessageNotResumableResult();
}

function notifyExecutionRunMutationSuccess(
    sessionId: string,
    serverId: string,
    response: ExecutionRunStopResponse | ExecutionRunActionResponse,
): void {
    if (response && typeof response === 'object' && (response as any).ok === true) {
        notifyExecutionRunActivity({ serverId, sessionId });
    }
}

export async function sessionExecutionRunStart(
    sessionId: string,
    request: ExecutionRunStartRequest,
    opts?: Readonly<{ serverId?: string | null; expectedMachineId?: string | null; scope?: ServerAccountScope;
        signal?: AbortSignal; onIssued?: () => void }>,
): Promise<SessionExecutionRunStartResult> {
    const protectedSelection = requiresProviderSafeExecutionRunStartRpc(request, true);
    try {
        const serverId = resolveExecutionRunSessionServerId(sessionId, opts?.serverId);
        if (!serverId) return createExecutionRunHomeUnavailableResult();
        const expectedMachineId = opts?.expectedMachineId?.trim() || null;
        if (expectedMachineId) {
            const currentTarget = readMachineControlTargetForSession({ serverId, sessionId });
            if (currentTarget?.machineId !== expectedMachineId) {
                return {
                    ok: false,
                    error: 'execution_run_target_changed',
                    errorCode: 'execution_run_target_changed',
                    details: withExecutionRunStartFailureDetails(undefined, 'noRunCreated'),
                };
            }
        }
        const inactiveSessionResult = ensureExecutionRunMutationAllowed(sessionId);
        if (inactiveSessionResult) return inactiveSessionResult;
        const response = await executionRunSessionRpc<unknown, ExecutionRunStartRequest | ExecutionRunEnsureOrStartRequest>({
            sessionId,
            serverId,
            ...(opts?.scope ? { scope: opts.scope } : {}),
            method: protectedSelection ? SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE_OR_START_PROVIDER_SAFE_V1 : SESSION_RPC_METHODS.EXECUTION_RUN_START,
            payload: protectedSelection ? { runId: null, resume: false, start: request } : request,
            // Admission owns its preparation lifetime; progress follows the returned Run.
            timeoutMs: null,
            signal: opts?.signal,
            onIssued: opts?.onIssued,
        });
        const errorResponse = readErrorResponseShape(response);
        if (errorResponse) return errorResponse;
        const parsed = ExecutionRunStartResponseSchema.safeParse(response);
        if (!parsed.success) {
            return { ok: false, error: 'Unsupported response from session RPC' };
        }
        notifyExecutionRunActivity({ serverId, sessionId });
        return parsed.data;
    } catch (error) {
        const details = ExecutionRunStartFailureDetailsV1Schema.safeParse(error && typeof error === 'object'
            && 'details' in error ? error.details : undefined);
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
            ...(details.success ? { details: details.data } : {}),
        };
    }
}

export async function sessionExecutionRunStop(
    sessionId: string,
    request: ExecutionRunStopRequest,
    opts?: Readonly<{ serverId?: string | null; scope?: ServerAccountScope; onIssued?: () => void; signal?: AbortSignal }>,
): Promise<SessionExecutionRunStopResult> {
    try {
        const serverId = opts?.scope?.serverId ?? resolveExecutionRunSessionServerId(sessionId, opts?.serverId);
        if (!serverId) return createExecutionRunHomeUnavailableResult();
        const response = await executionRunSessionRpc<ExecutionRunStopResponse, ExecutionRunStopRequest>({
            sessionId,
            serverId,
            scope: opts?.scope,
            method: SESSION_RPC_METHODS.EXECUTION_RUN_STOP,
            payload: request,
            ...(opts?.onIssued ? { onIssued: opts.onIssued } : {}),
            ...(opts?.signal ? { signal: opts.signal } : {}),
        });
        const errorResponse = readErrorResponseShape(response);
        if (errorResponse) return errorResponse;
        if (!response || typeof response !== 'object' || (response as any).ok !== true) {
            return { ok: false, error: 'Unsupported response from session RPC' };
        }
        notifyExecutionRunMutationSuccess(sessionId, serverId, response);
        return response;
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}

export async function sessionExecutionRunCancelTurn(
    sessionId: string,
    request: ExecutionRunCancelTurnRequest,
    opts?: Readonly<{ serverId?: string | null; scope?: ServerAccountScope; signal?: AbortSignal }>,
): Promise<SessionExecutionRunCancelTurnResult> {
    try {
        const serverId = opts?.scope?.serverId ?? resolveExecutionRunSessionServerId(sessionId, opts?.serverId);
        if (!serverId) return createExecutionRunHomeUnavailableResult();
        const response = await executionRunSessionRpc<ExecutionRunCancelTurnResponse, ExecutionRunCancelTurnRequest>({
            sessionId,
            serverId,
            scope: opts?.scope,
            method: SESSION_RPC_METHODS.EXECUTION_RUN_CANCEL_TURN_V1,
            payload: request,
            signal: opts?.signal,
        });
        const errorResponse = readErrorResponseShape(response);
        if (errorResponse) return errorResponse;
        if (!response || typeof response !== 'object' || (response as { ok?: unknown }).ok !== true) {
            return { ok: false, error: 'Unsupported response from session RPC' };
        }
        notifyExecutionRunActivity({ serverId, sessionId });
        return response;
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}

/** Transport for the canonical Run ensure/resume owner. */
export async function sessionExecutionRunEnsure(
    sessionId: string,
    request: ExecutionRunEnsureRequest,
    opts?: Readonly<{ serverId?: string | null; scope?: ServerAccountScope; signal?: AbortSignal }>,
): Promise<SessionExecutionRunEnsureResult> {
    try {
        const serverId = opts?.scope?.serverId ?? resolveExecutionRunSessionServerId(sessionId, opts?.serverId);
        if (!serverId) return createExecutionRunHomeUnavailableResult();
        const response = await executionRunSessionRpc<ExecutionRunEnsureResponse, ExecutionRunEnsureRequest>({
            sessionId,
            serverId,
            scope: opts?.scope,
            method: SESSION_RPC_METHODS.EXECUTION_RUN_ENSURE,
            payload: request,
            signal: opts?.signal,
        });
        const errorResponse = readErrorResponseShape(response);
        if (errorResponse) return errorResponse;
        if (!response || typeof response !== 'object' || (response as { ok?: unknown }).ok !== true) {
            return { ok: false, error: 'Unsupported response from session RPC' };
        }
        notifyExecutionRunActivity({ serverId, sessionId });
        return response;
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}

export async function sessionExecutionRunList(
    sessionId: string,
    request: ExecutionRunListRequest,
    opts?: SessionExecutionRunReadOptions,
): Promise<SessionExecutionRunListResult> {
    try {
        const serverId = opts?.scope?.serverId ?? resolveExecutionRunSessionServerId(sessionId, opts?.serverId, 'read');
        if (!serverId) return createExecutionRunHomeUnavailableResult();
        const response = await readSessionExecutionRun('execution.run.list', sessionId, request, serverId, opts);
        const errorResponse = readErrorResponseShape(response);
        if (errorResponse) return errorResponse;
        const parsed = ExecutionRunListResponseSchema.safeParse(response);
        if (!parsed.success) {
            return { ok: false, error: 'Unsupported response from session RPC' };
        }
        return parsed.data;
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}

export async function sessionExecutionRunGet(
    sessionId: string,
    request: ExecutionRunGetRequest,
    opts?: SessionExecutionRunReadOptions,
): Promise<SessionExecutionRunGetResult> {
    try {
        const serverId = opts?.scope?.serverId ?? resolveExecutionRunSessionServerId(sessionId, opts?.serverId, 'read');
        if (!serverId) return createExecutionRunHomeUnavailableResult();
        const response = await readSessionExecutionRun('execution.run.get', sessionId, request, serverId, opts);
        const errorResponse = readErrorResponseShape(response);
        if (errorResponse) return errorResponse;
        const parsed = ExecutionRunGetResponseSchema.safeParse(response);
        if (!parsed.success) {
            return { ok: false, error: 'Unsupported response from session RPC' };
        }
        return parsed.data;
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}

export async function sessionExecutionRunWait(
    sessionId: string,
    request: unknown,
    opts?: SessionExecutionRunReadOptions,
): Promise<unknown> {
    try {
        const serverId = opts?.scope?.serverId ?? resolveExecutionRunSessionServerId(sessionId, opts?.serverId, 'read');
        if (!serverId) return createExecutionRunHomeUnavailableResult();
        return await readSessionExecutionRun('execution.run.wait', sessionId, request, serverId, opts);
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error),
        };
    }
}

export async function sessionExecutionRunAction(
    sessionId: string,
    request: ExecutionRunActionRequest,
    opts?: Readonly<{ serverId?: string | null; scope?: ServerAccountScope; signal?: AbortSignal }>,
): Promise<SessionExecutionRunActionResult> {
    try {
        const serverId = opts?.scope?.serverId ?? resolveExecutionRunSessionServerId(sessionId, opts?.serverId);
        if (!serverId) return createExecutionRunHomeUnavailableResult();
        const sessionMessageResult = ensureExecutionRunUserMessageAllowed(sessionId);
        if (sessionMessageResult) return sessionMessageResult;
        const response = await executionRunSessionRpc<ExecutionRunActionResponse, ExecutionRunActionRequest>({
            sessionId,
            serverId,
            scope: opts?.scope,
            method: SESSION_RPC_METHODS.EXECUTION_RUN_ACTION,
            payload: request,
            signal: opts?.signal,
        });
        const errorResponse = readErrorResponseShape(response);
        if (errorResponse) return errorResponse;
        if (!response || typeof response !== 'object' || typeof (response as any).ok !== 'boolean') {
            return { ok: false, error: 'Unsupported response from session RPC' };
        }
        notifyExecutionRunMutationSuccess(sessionId, serverId, response);
        return response;
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            errorCode: readRpcErrorCode(error) ?? 'execution_run_target_unavailable',
        };
    }
}
