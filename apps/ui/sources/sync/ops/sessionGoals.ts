import { SessionWorkStateGetResponseV1Schema } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import type { SessionGoalSetRequestV1 } from '@happier-dev/protocol/sessions/work/state/sessionWorkStateRpc';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { storage } from '@/sync/domains/state/storage';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { hasRuntimeSessionGoalControls, resolveSessionGoalExecutionCapabilities } from '@/sync/domains/session/control/sessionGoalExecutionCapabilities';
import { t } from '@/text';
import { readMachineControlTargetForSession } from './sessionMachineTarget';
import { readGoalOperationResult, type SessionGoalOperationResult } from './sessionGoalOperationResult';

export type { SessionGoalOperationResult } from './sessionGoalOperationResult';

export type SessionGoalMutationRequest = Readonly<{
    objective?: string;
    status?: SessionGoalSetRequestV1['status'];
    tokenBudget?: number | null;
    resumeInactiveWithInitialGoal?: boolean;
}>;

type SessionGoalOptions = Readonly<{ serverId?: string | null; signal?: AbortSignal }>;

function goalError(errorCode: string): SessionGoalOperationResult {
    return { ok: false, error: errorCode, errorCode };
}

function readGoalExecutionAvailability(sessionId: string) {
    const state = storage.getState();
    const session = state.sessions?.[sessionId];
    const target = readMachineControlTargetForSession(sessionId);
    const machine = target ? state.machines?.[target.machineId] ?? state.machineDisplayById?.[target.machineId] ?? null : null;
    return {
        ...resolveSessionGoalExecutionCapabilities({ session: session ?? { active: false }, machine }),
        machineAvailable: target !== null || (session !== undefined && hasRuntimeSessionGoalControls(session)),
    };
}

async function runGoalRpc(sessionId: string, operation: 'get' | 'set' | 'clear', payload: Record<string, unknown>, opts?: SessionGoalOptions): Promise<unknown> {
    opts?.signal?.throwIfAborted();
    const serverId = opts?.serverId ?? resolvePreferredServerIdForSessionId(sessionId);
    const session = storage.getState().sessions?.[sessionId];
    if (!hasRuntimeSessionGoalControls(session ?? { active: false })) {
        const target = readMachineControlTargetForSession(sessionId);
        if (!target) return goalError('session_goal_control_machine_unavailable');
        return await machineRpcWithServerScope({ machineId: target.machineId, serverId, operationTimeoutMs: null,
            method: operation === 'get' ? RPC_METHODS.DAEMON_SESSION_GOAL_GET
                : operation === 'clear' ? RPC_METHODS.DAEMON_SESSION_GOAL_CLEAR
                    : payload.resumeInactiveWithInitialGoal === true ? RPC_METHODS.DAEMON_SESSION_GOAL_SET_V2 : RPC_METHODS.DAEMON_SESSION_GOAL_SET,
            payload: { sessionId, ...payload }, ...(opts?.signal ? { signal: opts.signal } : {}) });
    }
    const { resumeInactiveWithInitialGoal: _wake, ...sessionPayload } = payload;
    return await sessionRpcWithServerScope({ sessionId, serverId, timeoutMs: null,
        method: operation === 'get' ? SESSION_RPC_METHODS.SESSION_GOAL_GET
            : operation === 'clear' ? SESSION_RPC_METHODS.SESSION_GOAL_CLEAR : SESSION_RPC_METHODS.SESSION_GOAL_SET,
        payload: sessionPayload, ...(opts?.signal ? { signal: opts.signal } : {}) });
}

function transportError(error: unknown): SessionGoalOperationResult {
    const errorCode = readRpcErrorCode(error);
    return { ok: false, error: error instanceof Error ? error.message : t('session.workState.goal.errorUnknown'),
        ...(errorCode ? { errorCode } : {}) };
}

export async function sessionGoalGet(sessionId: string, opts?: SessionGoalOptions): Promise<unknown> {
    try {
        const result = await runGoalRpc(sessionId, 'get', {}, opts);
        return SessionWorkStateGetResponseV1Schema.safeParse(result).success ? result : readGoalOperationResult(result);
    } catch (error) { return transportError(error); }
}

export async function sessionGoalSet(sessionId: string, request: SessionGoalMutationRequest, opts?: SessionGoalOptions): Promise<SessionGoalOperationResult> {
    const availability = readGoalExecutionAvailability(sessionId);
    if (!availability.machineAvailable) return goalError('session_goal_control_machine_unavailable');
    if (!availability.canSet) return goalError('session_goal_control_unsupported');
    const wake = typeof request.objective === 'string' && request.objective.trim().length > 0 && request.resumeInactiveWithInitialGoal !== false;
    const payload = {
        ...(typeof request.objective === 'string' ? { objective: request.objective } : {}),
        ...(request.status ? { status: request.status } : {}),
        ...('tokenBudget' in request ? { tokenBudget: request.tokenBudget } : {}),
        ...(wake ? { resumeInactiveWithInitialGoal: true } : {}),
    };
    try { return readGoalOperationResult(await runGoalRpc(sessionId, 'set', payload, opts)); }
    catch (error) { return transportError(error); }
}

export async function sessionGoalClear(sessionId: string, opts?: SessionGoalOptions): Promise<SessionGoalOperationResult> {
    const availability = readGoalExecutionAvailability(sessionId);
    if (!availability.machineAvailable) return goalError('session_goal_control_machine_unavailable');
    if (!availability.canClear) return goalError('session_goal_control_unsupported');
    try { return readGoalOperationResult(await runGoalRpc(sessionId, 'clear', {}, opts)); }
    catch (error) { return transportError(error); }
}
