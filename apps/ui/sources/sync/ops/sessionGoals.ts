import { SessionWorkStateGetResponseV1Schema } from '@happier-dev/protocol';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { RPC_METHODS, SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { readRpcErrorCode } from '@happier-dev/protocol/rpcErrors';

import { buildWakeResumeExtras } from '@/agents/catalog/catalog';
import { buildResumeCapabilityOptionsFromUiState } from '@/agents/registry/registryUiBehavior';
import { storage } from '@/sync/domains/state/storage';
import { buildResumeSessionBaseOptionsFromSession } from '@/sync/domains/session/resume/resumeSessionBase';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import { t } from '@/text';
import { readMachineControlTargetForSession } from './sessionMachineTarget';
import { resumeSession } from './sessions';

export type SessionGoalMutationRequest = Readonly<{
    objective?: string;
    status?: 'active' | 'paused' | 'complete';
    tokenBudget?: number | null;
    resumeInactiveWithInitialGoal?: boolean;
}>;

export type SessionGoalOperationResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; error: string; errorCode?: string }>;

const SESSION_GOAL_SET_METHOD = SESSION_RPC_METHODS.SESSION_GOAL_SET;
const SESSION_GOAL_CLEAR_METHOD = SESSION_RPC_METHODS.SESSION_GOAL_CLEAR;
const SESSION_GOAL_CONTROL_MACHINE_UNAVAILABLE = 'session_goal_control_machine_unavailable';

type SessionMessagesSeqState = Readonly<{
    messageIdsOldestFirst?: readonly string[];
    messagesById?: Readonly<Record<string, Readonly<{ seq?: unknown }> | undefined>>;
}>;

function normalizeTranscriptSeq(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return Math.max(0, Math.trunc(value));
}

function resolveInitialTranscriptAfterSeq(
    state: Readonly<{ sessionMessages?: Readonly<Record<string, SessionMessagesSeqState | undefined>> }>,
    sessionId: string,
): number | undefined {
    const sessionMessages = state.sessionMessages?.[sessionId];
    if (!sessionMessages?.messagesById) return undefined;

    let maxSeq: number | null = null;
    const visitSeq = (value: unknown): void => {
        const seq = normalizeTranscriptSeq(value);
        if (seq === null) return;
        maxSeq = maxSeq === null ? seq : Math.max(maxSeq, seq);
    };

    for (const messageId of sessionMessages.messageIdsOldestFirst ?? []) {
        visitSeq(sessionMessages.messagesById[messageId]?.seq);
    }
    for (const message of Object.values(sessionMessages.messagesById)) {
        visitSeq(message?.seq);
    }

    return maxSeq ?? undefined;
}

function normalizeGoalObjective(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readGoalOperationResult(response: unknown): SessionGoalOperationResult {
    if (!response || typeof response !== 'object') {
        return { ok: false, error: t('session.workState.goal.errorUnsupportedResponse') };
    }
    const raw = response as Record<string, unknown>;
    if (raw.ok === true) return { ok: true };
    if (raw.ok !== true && typeof raw.error === 'string') {
        return {
            ok: false,
            error: raw.error,
            ...(typeof raw.errorCode === 'string' ? { errorCode: raw.errorCode } : {}),
        };
    }
    if (SessionWorkStateGetResponseV1Schema.safeParse(raw).success) {
        return { ok: true };
    }
    return { ok: false, error: t('session.workState.goal.errorUnsupportedResponse') };
}

async function runSessionGoalRpc(
    sessionId: string,
    method: string,
    payload: Record<string, unknown>,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionGoalOperationResult> {
    try {
        const response = await sessionRpcWithServerScope<SessionGoalOperationResult, Record<string, unknown>>({
            sessionId,
            serverId: opts?.serverId ?? resolvePreferredServerIdForSessionId(sessionId),
            method,
            payload,
        });
        return readGoalOperationResult(response);
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : t('session.workState.goal.errorUnknown'),
            errorCode: readRpcErrorCode(error),
        };
    }
}

function isInactiveSession(sessionId: string): boolean {
    const session = storage.getState().sessions?.[sessionId];
    return session?.active === false;
}

async function runMachineGoalRpc(
    sessionId: string,
    method: string,
    payload: Record<string, unknown>,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionGoalOperationResult> {
    const target = readMachineControlTargetForSession(sessionId);
    if (!target) {
        return {
            ok: false,
            error: SESSION_GOAL_CONTROL_MACHINE_UNAVAILABLE,
            errorCode: SESSION_GOAL_CONTROL_MACHINE_UNAVAILABLE,
        };
    }

    try {
        const response = await machineRpcWithServerScope<SessionGoalOperationResult, Record<string, unknown>>({
            machineId: target.machineId,
            serverId: opts?.serverId ?? resolvePreferredServerIdForSessionId(sessionId),
            method,
            payload: { sessionId, ...payload },
        });
        return readGoalOperationResult(response);
    } catch (error) {
        return {
            ok: false,
            error: error instanceof Error ? error.message : t('session.workState.goal.errorUnknown'),
            errorCode: readRpcErrorCode(error),
        };
    }
}

async function resumeInactiveSessionWithInitialGoal(
    sessionId: string,
    request: SessionGoalMutationRequest,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionGoalOperationResult | null> {
    const objective = normalizeGoalObjective(request.objective);
    if (!objective) return null;
    if (request.resumeInactiveWithInitialGoal === false) return null;

    const state = storage.getState();
    const session = state.sessions?.[sessionId];
    if (!session || session.active !== false) return null;

    const resumeCapabilityOptions = buildResumeCapabilityOptionsFromUiState({
        settings: state.settings,
        results: undefined,
    });
    const base = buildResumeSessionBaseOptionsFromSession({
        sessionId,
        session,
        resumeCapabilityOptions,
    });
    if (!base) {
        return { ok: false, error: t('session.workState.goal.errorCannotResume') };
    }

    const agentId = resolveAgentIdFromSessionMetadata(session.metadata);
    const resumeExtras = agentId
        ? buildWakeResumeExtras({ agentId, resumeCapabilityOptions, session })
        : {};
    const initialTranscriptAfterSeq = resolveInitialTranscriptAfterSeq(state, sessionId);
    const result = await resumeSession({
        ...base,
        ...resumeExtras,
        serverId: opts?.serverId ?? resolvePreferredServerIdForSessionId(sessionId),
        ...(initialTranscriptAfterSeq !== undefined ? { initialTranscriptAfterSeq } : {}),
        initialGoal: {
            objective,
            ...(request.status ? { status: request.status } : {}),
            ...('tokenBudget' in request ? { tokenBudget: request.tokenBudget } : {}),
        },
    });

    if (result.type === 'error') {
        return {
            ok: false,
            error: result.errorMessage,
            errorCode: result.errorCode,
        };
    }

    return { ok: true };
}

function buildGoalSetPayload(request: SessionGoalMutationRequest): Record<string, unknown> {
    return {
        ...(typeof request.objective === 'string' ? { objective: request.objective } : {}),
        ...(typeof request.status === 'string' ? { status: request.status } : {}),
        ...('tokenBudget' in request ? { tokenBudget: request.tokenBudget } : {}),
    };
}

export function sessionGoalSet(
    sessionId: string,
    request: SessionGoalMutationRequest,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionGoalOperationResult> {
    return (async () => {
        const resumed = await resumeInactiveSessionWithInitialGoal(sessionId, request, opts);
        if (resumed) return resumed;
        if (isInactiveSession(sessionId)) {
            return runMachineGoalRpc(sessionId, RPC_METHODS.DAEMON_SESSION_GOAL_SET, buildGoalSetPayload(request), opts);
        }
        return runSessionGoalRpc(sessionId, SESSION_GOAL_SET_METHOD, buildGoalSetPayload(request), opts);
    })();
}

export function sessionGoalClear(
    sessionId: string,
    opts?: Readonly<{ serverId?: string | null }>,
): Promise<SessionGoalOperationResult> {
    if (isInactiveSession(sessionId)) {
        return runMachineGoalRpc(sessionId, RPC_METHODS.DAEMON_SESSION_GOAL_CLEAR, {}, opts);
    }
    return runSessionGoalRpc(sessionId, SESSION_GOAL_CLEAR_METHOD, {}, opts);
}
