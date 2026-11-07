import * as React from 'react';
import type { WorkBoardV1 } from '@happier-dev/protocol/boards/workBoardV1';

import { useActiveServerAccountScopeLifetime } from '@/sync/domains/state/storage';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { stableJsonStringify } from '@/utils/json/stableJsonStringify';

import { createBoardMembershipProjection, type BoardMembership, type BoardMembershipSources } from './boardMembership';
import type { BoardHomes } from './useBoardContent';

type Membership = ReturnType<ReturnType<typeof createBoardMembershipProjection>> & BoardMembership;

/** One Board fact, retained without readers. Only the first demanded subscriber acquires sources;
 * the rail, pinned chrome and page all subscribe to its answer. No requests survive the last reader. */
function createMembershipState(board: WorkBoardV1, homes: BoardHomes) {
    const project = createBoardMembershipProjection();
    const pending = project(board, { isHomeMounted: homes.isHomeMounted, sections: {}, filtered: null });
    const listeners = new Set<() => void>();
    const readers = new Set<symbol>();
    let refresh: (() => void) | undefined;
    const refreshTaskItems = () => refresh?.();
    let snapshot: Readonly<{ reader: symbol | undefined; membership: Membership }> = {
        reader: undefined, membership: { ...pending, refreshTaskItems },
    };
    let retired = false;
    const notify = () => { for (const listener of listeners) listener(); };
    const selectReader = () => {
        const reader = readers.values().next().value;
        if (reader === snapshot.reader) return;
        refresh = undefined;
        // A retained answer is display truth, never permission to prune during reacquisition.
        snapshot = { reader, membership: snapshot.membership.complete
            ? { ...snapshot.membership, complete: false } : snapshot.membership };
        notify();
    };
    return {
        get retired() { return retired; },
        getSnapshot: () => snapshot,
        subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        retain(reader: symbol) {
            readers.add(reader);
            selectReader();
            return () => { readers.delete(reader); selectReader(); };
        },
        retire() {
            retired = true;
            refresh = undefined;
            snapshot = { reader: undefined, membership: { ...pending, complete: false, settled: false, refreshTaskItems } };
            notify();
        },
        publish(reader: symbol, board: WorkBoardV1, sources: BoardMembershipSources,
            tasks: Pick<BoardMembership, 'taskItems' | 'refreshTaskItems'>, withdrawn: boolean) {
            if (retired || snapshot.reader !== reader) return;
            refresh = tasks.refreshTaskItems;
            const next = project(board, sources);
            const previous = snapshot.membership;
            const membership: Membership = !next.settled && previous.settled && !withdrawn
                ? { ...previous, complete: false }
                : { ...next, taskItems: tasks.taskItems, refreshTaskItems };
            if (previous.members === membership.members && previous.complete === membership.complete
                && previous.settled === membership.settled && previous.taskItems === membership.taskItems
                && previous.taskItemsComplete === membership.taskItemsComplete
                && previous.representedSessionKeys === membership.representedSessionKeys
                && previous.undetermined.count === membership.undetermined.count
                && JSON.stringify(previous.undetermined.reasons) === JSON.stringify(membership.undetermined.reasons)) return;
            snapshot = { ...snapshot, membership };
            notify();
        },
    };
}

type MembershipState = ReturnType<typeof createMembershipState>;
type AccountStates = Map<string, Readonly<{ key: string; homes: readonly string[]; state: MembershipState }>>;
const accounts = new WeakMap<ActiveServerAccountScopeLifetime, AccountStates>();

function accountStates(lifetime: ActiveServerAccountScopeLifetime): AccountStates {
    const existing = accounts.get(lifetime);
    if (existing) return existing;
    const states: AccountStates = new Map();
    accounts.set(lifetime, states);
    // Credential retirement is meaningful even while all Board surfaces are unmounted.
    const stop = subscribeHomeCredentialChange(event => {
        for (const [id, entry] of states) {
            if (!entry.homes.some(home => areServerProfileIdentifiersEquivalent(home, event.serverId))) continue;
            states.delete(id);
            entry.state.retire();
        }
    });
    lifetime.onRetire(() => {
        stop();
        for (const entry of states.values()) entry.state.retire();
        states.clear();
    });
    return states;
}

/** Scope changes replace the fact; a view mounting or unmounting does not. */
export function useBoardMembershipState(board: WorkBoardV1, homes: BoardHomes, enabled: boolean) {
    const lifetime = useActiveServerAccountScopeLifetime();
    const key = React.useMemo(() => stableJsonStringify([board.source, homes.activeServerId, homes.mountedServerIds]),
        [board.source, homes.activeServerId, homes.mountedServerIds]);
    const states = lifetime?.isCurrent() ? accountStates(lifetime) : null;
    const entry = states?.get(board.id);
    const state = React.useMemo(() => {
        if (entry?.key === key && !entry.state.retired) return entry.state;
        const state = createMembershipState(board, homes);
        states?.set(board.id, { key, homes: homes.mountedServerIds, state });
        return state;
    }, [board.id, key, lifetime, states, entry]);
    const reader = React.useMemo(() => Symbol('board-source-reader'), [state]);
    const snapshot = React.useSyncExternalStore(state.subscribe, state.getSnapshot, state.getSnapshot);
    React.useLayoutEffect(() => enabled ? state.retain(reader) : undefined, [enabled, reader, state]);
    return { state, reader, membership: snapshot.membership, readsSources: enabled && snapshot.reader === reader };
}
