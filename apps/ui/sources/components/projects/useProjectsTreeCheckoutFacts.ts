import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

import { getStorage } from '@/sync/domains/state/storageStore';
import { sessionListRuntimeClock } from '@/hooks/session/sessionListRuntimeClock';
import { projectLastMobileSurfaceState } from '@/sync/domains/state/navigationUiState';
import { resolveProjectMobileSurfaceStorageKeys } from '@/sync/domains/settings/mobileSurfacePersistence';
import { projectManager } from '@/sync/runtime/orchestration/projectManager';

import { createProjectsTreeCheckoutFactsSelector, type ProjectsTreeCheckoutFactsChange } from './projectsTreeCheckoutFacts';
import type { ProjectsTreeCheckoutFacts } from './projectsTreeRows';

/**
 * The live facts of one set of checkouts: one selector and shared input subscriptions for every
 * reader. Readers pick their own checkouts' facts (`useProjectsTreeCheckoutFactsFor`) and re-render only
 * when those change; nothing here subscribes until a reader mounts.
 */
export type ProjectsTreeCheckoutFactsSource = Readonly<{
    getSnapshot: () => ReadonlyMap<string, ProjectsTreeCheckoutFacts>;
    subscribe: (listener: () => void) => () => void;
}>;

function createProjectsTreeCheckoutFactsSource(
    refs: readonly WorkspaceRefV1[],
    store: ReturnType<typeof getStorage>,
): ProjectsTreeCheckoutFactsSource {
    const select = createProjectsTreeCheckoutFactsSelector(refs);
    const serverIds = [...new Set(refs.map(ref => ref.serverId))];
    let nowMs = refs.length > 0 ? Math.max(sessionListRuntimeClock.getNowMs(), Date.now()) : Date.now();
    // This source produces the shared facts at its input wakes. Snapshot reads
    // by each rendered section must not recompute the whole checkout census.
    let published: ReadonlyMap<string, ProjectsTreeCheckoutFacts> | null = null;
    const getSnapshot = () => {
        if (published === null) {
            nowMs = refs.length > 0 ? Math.max(sessionListRuntimeClock.getNowMs(), Date.now()) : Date.now();
            published = select(store.getState(), nowMs, { reset: true });
        }
        return published;
    };
    const listeners = new Set<() => void>();
    let stop: (() => void) | null = null;
    const start = () => {
        const token = {};
        let subscribedScope: ReturnType<typeof store.getState>['profileScope'] | undefined;
        let stopMobileSurfaces: (() => void)[] = [];
        const subscribeMobileSurfaces = () => {
            const scope = store.getState().profileScope;
            if (scope === subscribedScope) return;
            subscribedScope = scope;
            const keys = new Set(resolveProjectMobileSurfaceStorageKeys({
                workspaceRefs: refs, activeScope: scope, activeServerId: scope?.serverId,
            }).filter((key): key is string => key !== null));
            for (const stop of stopMobileSurfaces) stop();
            stopMobileSurfaces = [...keys].map(key => projectLastMobileSurfaceState.subscribeKey(key,
                () => refresh({ mobileSurfaceKey: key })));
        };
        const refresh = (change: ProjectsTreeCheckoutFactsChange = {}) => {
            subscribeMobileSurfaces();
            nowMs = Math.max(sessionListRuntimeClock.getNowMs(), Date.now());
            const next = select(store.getState(), nowMs, published === null ? { reset: true } : change);
            // Re-arm even when a heartbeat extends freshness without changing
            // the visible facts. Only this source's deadline can wake its readers.
            const wakeAtMs = select.getNextWakeAtMs();
            if (wakeAtMs === null) sessionListRuntimeClock.clearWake(token);
            else sessionListRuntimeClock.requestWake(token, wakeAtMs);
            // The selector keeps the Map identity while no checkout's facts changed.
            if (next === published) return;
            published = next;
            for (const listener of [...listeners]) listener();
        };
        const stopClock = sessionListRuntimeClock.subscribeWake(token, () => refresh());
        // Read the writer's latest delta with its row publication, not as a
        // separate wake for an index rebuilt on a Home this tree does not read.
        const stopStore = store.subscribe(() => refresh(), {
            sessions: true, sessionListRowsByServerId: serverIds,
            machines: true, machineListByServerId: serverIds, machineListStatusByServerId: serverIds,
            profileScope: true,
        });
        // SCM snapshots live outside Zustand; their owner publishes actual snapshot changes.
        const stopScm = projectManager.subscribeScmSnapshots(scopeKey => refresh({ scmScopeKey: scopeKey }), select.getScmScopeKeys());
        refresh({ reset: true });
        return () => {
            stopStore();
            stopScm();
            stopClock();
            for (const stop of stopMobileSurfaces) stop();
        };
    };
    const subscribe = (listener: () => void) => {
        if (refs.length === 0) return () => {};
        listeners.add(listener);
        stop ??= start();
        return () => {
            listeners.delete(listener);
            if (listeners.size > 0) return;
            stop?.();
            stop = null;
            published = null;
        };
    };
    return { getSnapshot, subscribe };
}

/** Mount only with the rendered Projects tree; no catalog fetch, SCM discovery or registration. */
export function useProjectsTreeCheckoutFactsSource(refs: readonly WorkspaceRefV1[]): ProjectsTreeCheckoutFactsSource {
    const store = getStorage();
    // Labels, grouping and ordering do not change checkout facts or subscriptions.
    // Opening a checkout does affect its arrival marker, so retain that input too.
    const checkoutInputs = React.useMemo(() => JSON.stringify(refs.map(ref => JSON.stringify([
        ref.serverId, ref.id, ref.machineId, ref.rootPath, ref.lastOpenedAtMs != null,
    ])).sort()), [refs]);
    return React.useMemo(() => createProjectsTreeCheckoutFactsSource(refs, store), [checkoutInputs, store]);
}

/** Every checkout's facts; re-renders on any change. Per-row readers use `useProjectsTreeCheckoutFactsFor`. */
export function useProjectsTreeCheckoutFacts(refs: readonly WorkspaceRefV1[]): ReadonlyMap<string, ProjectsTreeCheckoutFacts> {
    const source = useProjectsTreeCheckoutFactsSource(refs);
    return React.useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
}

/** The facts of `keys`, in order (null while unknown). The reader re-renders only when one of them changes. */
export function useProjectsTreeCheckoutFactsFor(
    source: ProjectsTreeCheckoutFactsSource,
    keys: readonly string[],
): readonly (ProjectsTreeCheckoutFacts | null)[] {
    const pick = useShallow((facts: ReadonlyMap<string, ProjectsTreeCheckoutFacts>) => keys.map(key => facts.get(key) ?? null));
    const getSnapshot = () => pick(source.getSnapshot());
    return React.useSyncExternalStore(source.subscribe, getSnapshot, getSnapshot);
}
