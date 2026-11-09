import * as React from 'react';

import type { ActivityAttentionSource } from '@/activity/source/activityAttentionSourceTypes';
import { forEachActivitySummaryCandidate } from '@/activity/source/buildActivityOverviewFromSource';
import { useActivityAttentionSummarySource } from '@/activity/source/useActivityAttentionSource';
import { storage } from '@/sync/domains/state/storage';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import {
    resolveDisplayMachineIdForSessionFromState,
    type SessionMachineTargetState,
} from '@/sync/domains/session/resolveMachineTargetForSessionFromState';

export type MachineWorkingTarget = Readonly<{ serverId: string; machineId: string }>;

/** A machine within its Home: the same machine id on two Homes is two machines. */
export function machineWorkingKey(target: MachineWorkingTarget): string {
    return `${target.serverId}\u0000${target.machineId}`;
}

export type MachineWorkingCounts = Readonly<{
    /** Sessions working right now on each machine, by {@link machineWorkingKey}; absent = none. */
    byMachine: ReadonlyMap<string, number>;
    /** Every working session that names a machine. */
    total: number;
}>;

/**
 * Sessions working on each machine (MPG-27): the Activity summary's own walk and its own "working"
 * reason (`reasons.isThinking`), grouped by the machine the session shows it runs on. It is a second
 * projection of the one classifier, never a second definition of working.
 */
export function buildMachineWorkingCounts(params: Readonly<{
    source: ActivityAttentionSource;
    nowMs: number;
    /** The store state the session's machine is resolved against (the machine page's same owner). */
    state: SessionMachineTargetState;
    includeWarmSourceWhenNotReady?: boolean;
}>): MachineWorkingCounts {
    const byMachine = new Map<string, number>();
    let total = 0;
    forEachActivitySummaryCandidate(params, ({ entry, candidate }) => {
        if (!candidate.reasons.isThinking) return;
        const machineId = resolveDisplayMachineIdForSessionFromState({
            state: params.state,
            serverId: entry.address.serverId,
            sessionId: entry.address.sessionId,
            metadata: readSessionOwnerMetadataView(entry.session),
        });
        if (!machineId) return;
        const key = machineWorkingKey({ serverId: entry.address.serverId, machineId });
        byMachine.set(key, (byMachine.get(key) ?? 0) + 1);
        total += 1;
    });
    return { byMachine, total };
}

const EMPTY_COUNTS: MachineWorkingCounts = Object.freeze({ byMachine: new Map(), total: 0 });

/** The open surface's one projection; rows read their own number from it. */
type MachineWorkingCountsStore = Readonly<{
    current: () => MachineWorkingCounts;
    publish: (next: MachineWorkingCounts) => void;
    notify: () => void;
    subscribe: (listener: () => void) => () => void;
}>;

function createMachineWorkingCountsStore(): MachineWorkingCountsStore {
    let counts = EMPTY_COUNTS;
    const listeners = new Set<() => void>();
    return {
        current: () => counts,
        publish: (next) => { counts = next; },
        notify: () => { for (const listener of listeners) listener(); },
        subscribe: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
    };
}

const MachineWorkingCountsContext = React.createContext<MachineWorkingCountsStore | null>(null);

/**
 * Mounted by an open machine surface (the rail popover, All machines): it computes the per-machine
 * working counts once per Activity source change, and each row subscribes to its own number, so a
 * session update on one machine re-renders only that machine's row. Closed surfaces mount nothing.
 * The Activity subscription lives in a leaf beside the rows, so a Session change renders the leaf (and
 * the rows whose number moved), never this provider or the page under it; while a retained surface is
 * hidden the leaf is not mounted, so Session churn computes nothing there and the rows keep what they
 * showed until the surface is presented again, when the leaf reads the current counts once.
 */
export function MachineWorkingCountsProvider(props: Readonly<{ children: React.ReactNode }>) {
    const presented = useLayoutPresentationActive();
    const [store] = React.useState(createMachineWorkingCountsStore);
    return (
        <MachineWorkingCountsContext.Provider value={store}>
            {presented ? <MachineWorkingCountsSource store={store} /> : null}
            {props.children}
        </MachineWorkingCountsContext.Provider>
    );
}

/** The provider's one Activity reader; it renders before the rows in the same pass, so they read its counts. */
function MachineWorkingCountsSource(props: Readonly<{ store: MachineWorkingCountsStore }>): null {
    const source = useActivityAttentionSummarySource();
    const counts = React.useMemo(() => buildMachineWorkingCounts({
        source,
        nowMs: Date.now(),
        state: storage.getState() as SessionMachineTargetState,
        includeWarmSourceWhenNotReady: true,
    }), [source]);
    usePublishedMachineWorkingCounts(props.store, counts);
    return null;
}

/** Rows rendered in this pass read the new counts; rows that did not re-render hear about it in the layout effect. */
function usePublishedMachineWorkingCounts(store: MachineWorkingCountsStore, counts: MachineWorkingCounts): void {
    store.publish(counts);
    React.useLayoutEffect(() => store.notify(), [counts, store]);
}

/** Publishes one projection to the rows below; a row re-renders only when its own number changes. */
export function MachineWorkingCountsScope(props: Readonly<{ counts: MachineWorkingCounts; children: React.ReactNode }>) {
    const [store] = React.useState(createMachineWorkingCountsStore);
    usePublishedMachineWorkingCounts(store, props.counts);
    return <MachineWorkingCountsContext.Provider value={store}>{props.children}</MachineWorkingCountsContext.Provider>;
}

function useMachineWorkingCountsStore(): MachineWorkingCountsStore {
    const store = React.useContext(MachineWorkingCountsContext);
    if (!store) throw new Error('Machine working counts are read inside MachineWorkingCountsProvider');
    return store;
}

/** Sessions working on one machine right now (row-local: other machines' changes do not render it). */
export function useMachineWorkingCount(target: MachineWorkingTarget): number {
    const store = useMachineWorkingCountsStore();
    const key = machineWorkingKey(target);
    const read = React.useCallback(() => store.current().byMachine.get(key) ?? 0, [key, store]);
    return React.useSyncExternalStore(store.subscribe, read, read);
}

/** Sessions working on every machine (the popover header's "20 working"). */
export function useMachineWorkingTotal(): number {
    const store = useMachineWorkingCountsStore();
    const read = React.useCallback(() => store.current().total, [store]);
    return React.useSyncExternalStore(store.subscribe, read, read);
}
