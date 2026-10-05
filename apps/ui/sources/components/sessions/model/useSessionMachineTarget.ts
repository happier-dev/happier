import { useShallow } from 'zustand/react/shallow';

import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import {
    resolveMachineControlTargetForSessionFromState,
    resolveMachineTargetForSessionFromState,
    resolveDisplayIdentityForSessionFromState,
    type SessionMachineControlTarget,
    type SessionMachineTargetState,
    type SessionMachineTargetIdentity,
    type SessionDisplayIdentity,
} from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { getStorage } from '@/sync/domains/state/storage';

/** Stable attribution while a machine is offline; this is not permission to issue an RPC. */
export function useSessionMachineDisplayIdentity(sessionId: string, serverId?: string | null): SessionDisplayIdentity {
    const resolvedSessionId = normalizeSessionId(sessionId);
    return getStorage()(useShallow((state) => resolveDisplayIdentityForSessionFromState({
        state: state as SessionMachineTargetState, sessionId: resolvedSessionId, serverId,
    })));
}

export function useSessionMachineTarget(target: SessionMachineTargetIdentity | null, serverId?: string | null): { machineId: string; basePath: string } | null {
    const resolvedTarget = typeof target === 'string'
        ? serverId?.trim() ? { serverId: serverId.trim(), sessionId: normalizeSessionId(target) } : normalizeSessionId(target)
        : target;

    return getStorage()(
        useShallow((state) =>
            resolvedTarget === null ? null : resolveMachineTargetForSessionFromState(
                state as SessionMachineTargetState,
                resolvedTarget,
            ),
        ),
    );
}

export function useSessionMachineControlTarget(sessionId: string, serverId?: string | null): SessionMachineControlTarget | null {
    const resolvedSessionId = normalizeSessionId(sessionId);

    return getStorage()(
        useShallow((state) =>
            resolveMachineControlTargetForSessionFromState(
                state as SessionMachineTargetState,
                serverId?.trim() ? { serverId: serverId.trim(), sessionId: resolvedSessionId } : resolvedSessionId,
            ),
        ),
    );
}
