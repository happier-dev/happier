import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { shallow } from 'zustand/shallow';

import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import {
    resolveMachineControlTargetForSessionFromState,
    resolveMachineControlTargetStateForSessionFromState,
    resolveMachineTargetForSessionFromState,
    resolveDisplayIdentityForSessionFromState,
    readSessionMachineTargetActivityInputs,
    type SessionMachineControlTarget,
    type SessionMachineTargetState,
    type SessionMachineTargetIdentity,
    type SessionDisplayIdentity,
} from '@/sync/domains/session/resolveMachineTargetForSessionFromState';
import { getStorage } from '@/sync/domains/state/storage';
import { useMachinePresenceSnapshot } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';

/** Session edits use the store; presence observes only the target owner's candidate rows. */
function useSessionTargetSnapshot<T>(
    target: SessionMachineTargetIdentity | null,
    read: (state: SessionMachineTargetState) => T,
): T {
    const store = getStorage();
    const rooted = store(useShallow(read));
    const machines = store(useShallow((state) => target === null ? [] : readSessionMachineTargetActivityInputs(state, target)));
    const readMachines = React.useCallback(() => machines, [machines]);
    // The existing presence owner does not subscribe to Session metadata. A changed
    // rooted result renews its read closure after the Session store publishes it.
    const readSnapshot = React.useCallback(() => read(store.getState()), [read, rooted, store]);
    const targets = React.useMemo(() => [{ serverId: typeof target === 'object' ? target?.serverId : undefined,
        machineIds: machines.map(machine => machine.id) }], [machines, target]);
    return useMachinePresenceSnapshot(readMachines, readSnapshot, targets, shallow);
}

/** Stable attribution while a machine is offline; this is not permission to issue an RPC. */
export function useSessionMachineDisplayIdentity(sessionId: string, serverId?: string | null): SessionDisplayIdentity {
    const resolvedSessionId = normalizeSessionId(sessionId);
    return getStorage()(useShallow((state) => resolveDisplayIdentityForSessionFromState({
        state: state as SessionMachineTargetState, sessionId: resolvedSessionId, serverId,
    })));
}

export function useSessionMachineTarget(target: SessionMachineTargetIdentity | null, serverId?: string | null): { machineId: string; basePath: string } | null {
    const targetSessionId = target === null ? null : normalizeSessionId(typeof target === 'string' ? target : target.sessionId);
    const targetServerId = (typeof target === 'object' ? target?.serverId : serverId)?.trim();
    const exactTarget = typeof target === 'object' && target !== null;
    const accountId = typeof target === 'object' && target !== null && 'accountId' in target ? target.accountId : undefined;
    const resolvedTarget = React.useMemo(() => targetSessionId === null ? null
        : exactTarget || targetServerId ? { serverId: targetServerId ?? '', sessionId: targetSessionId, ...(accountId !== undefined ? { accountId } : {}) }
            : targetSessionId, [accountId, exactTarget, targetServerId, targetSessionId]);

    const read = React.useCallback((state: SessionMachineTargetState) =>
            resolvedTarget === null ? null : resolveMachineTargetForSessionFromState(
                state,
                resolvedTarget,
            ), [resolvedTarget]);
    return useSessionTargetSnapshot(resolvedTarget, read);
}

export function useSessionMachineControlTarget(sessionId: string, serverId?: string | null): SessionMachineControlTarget | null {
    const resolvedSessionId = normalizeSessionId(sessionId);
    const target = React.useMemo(() => serverId?.trim() ? { serverId: serverId.trim(), sessionId: resolvedSessionId } : resolvedSessionId,
        [resolvedSessionId, serverId]);
    const read = React.useCallback((state: SessionMachineTargetState) =>
            resolveMachineControlTargetForSessionFromState(
                state, target,
            ), [target]);
    return useSessionTargetSnapshot(target, read);
}

export function useSessionMachineControlTargetState(sessionId: string, serverId?: string | null) {
    const resolvedSessionId = normalizeSessionId(sessionId);
    const target = React.useMemo(() => serverId?.trim() ? { serverId: serverId.trim(), sessionId: resolvedSessionId } : resolvedSessionId,
        [resolvedSessionId, serverId]);
    const read = React.useCallback((state: SessionMachineTargetState) => resolveMachineControlTargetStateForSessionFromState(state, target), [target]);
    return useSessionTargetSnapshot(target, read);
}
