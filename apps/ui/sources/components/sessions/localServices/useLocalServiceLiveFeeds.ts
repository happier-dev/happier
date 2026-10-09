import * as React from 'react';
import { observeProjectServicePlacementActualV1, type ProjectServicePlacementGetResultV1 } from '@happier-dev/protocol/workspaces/projectServicePlacementV1';
import { storage } from '@/sync/domains/state/storage';
import { readCurrentProjectAccountRows } from '@/sync/store/domains/projectAccountRows';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getLocalServiceLauncherState, invalidateLocalServiceLauncherStore, subscribeLocalServiceLauncherStore,
    type LocalServiceLauncherStoreKeyInput } from '@/sync/domains/local/services/launch/sharedStore';
import { getLocalServiceInventoryState, invalidateLocalServiceInventoryStore, subscribeLocalServiceInventoryStore } from '@/sync/domains/local/services/inventory/sharedStore';
import { applyLocalServiceLauncherSnapshot, selectLocalServiceLaunchTargets, snapshotFromLocalServiceLauncherState } from '@/sync/domains/local/services/launch';

import {
    type LocalServiceLauncherSnapshotClient,
    type LocalServiceLauncherState,
    useLocalServiceLauncherStateController,
} from '@/sync/domains/local/services/launch';
import type { LocalServiceInventoryState } from '@/sync/domains/local/services/inventory/store';
import {
    type LocalServiceInventorySnapshotClient,
    useLocalServiceInventoryStateController,
} from '@/sync/domains/local/services/inventory/useLocalServiceInventoryState';

/**
 * The two daemon feeds a Local services surface reads — the inventory (pushed by the daemon's watch)
 * and the launcher (derived from it) — kept fresh together by one freshness rule. Mount it only in an
 * open Local services surface: it starts machine reads and a daemon watch.
 */
export type LocalServiceLiveFeedsInput = Readonly<{
    machineId: string | null;
    serverId: string | null;
    sessionId?: string;
    workspaceRoot?: string | null;
    /** Accepted SOURCE ref; omitted for Session/Machine feeds that have no Project placement. */
    workspaceRefId?: string | null;
    scope: 'workspace' | 'machine';
    /** Supplied state replaces the live feed (tests, previews); `undefined` reads live. */
    inventoryState?: LocalServiceInventoryState;
    launcherState?: LocalServiceLauncherState | null;
    inventorySnapshotClient?: LocalServiceInventorySnapshotClient;
    launcherSnapshotClient?: LocalServiceLauncherSnapshotClient;
}>;

export type LocalServiceLiveFeeds = Readonly<{
    inventoryState: LocalServiceInventoryState;
    launcherState: LocalServiceLauncherState | null;
    /** Undefined when the inventory is supplied rather than live. */
    refresh: (() => void) | undefined;
    applyLauncherSnapshot: ReturnType<typeof useLocalServiceLauncherStateController>['applySnapshot'] | undefined;
}>;

export function useLocalServiceLiveFeeds(input: LocalServiceLiveFeedsInput): LocalServiceLiveFeeds {
    const liveInventory = useLocalServiceInventoryStateController({
        machineId: input.machineId,
        serverId: input.serverId,
        sessionId: input.sessionId,
        enabled: input.inventoryState === undefined,
        snapshotClient: input.inventorySnapshotClient,
    });
    const liveLauncher = useLocalServiceLauncherStateController({
        machineId: input.machineId,
        serverId: input.serverId,
        sessionId: input.sessionId,
        scope: input.scope,
        workspaceRoot: input.workspaceRoot ?? null,
        enabled: input.launcherState === undefined,
        snapshotClient: input.launcherSnapshotClient,
    });
    // The rows are built from the daemon's LAUNCHER feed, and inventory entries only enrich them —
    // so making the inventory fresh is not enough on its own for a service started after mount to
    // appear. The launcher feed is derived from the same inventory the daemon just rescanned, so it
    // needs no push producer of its own: one push source (the inventory watch) drives the derived
    // read. `generatedAt` advancing is exactly "the daemon rescanned".
    const inventorySupplied = input.inventoryState !== undefined;
    const inventoryGeneratedAt = liveInventory.state.generatedAt;
    const refreshLauncher = liveLauncher.refresh;
    const lastSyncedInventoryGeneratedAtRef = React.useRef<number | null>(null);
    React.useEffect(() => {
        if (inventorySupplied || inventoryGeneratedAt === null) {
            return;
        }
        if (lastSyncedInventoryGeneratedAtRef.current === inventoryGeneratedAt) {
            return;
        }
        const isFirstObservation = lastSyncedInventoryGeneratedAtRef.current === null;
        lastSyncedInventoryGeneratedAtRef.current = inventoryGeneratedAt;
        // The launcher's own mount read already covers the first snapshot; only a later change
        // needs a derived re-read.
        if (!isFirstObservation) {
            refreshLauncher?.();
        }
    }, [inventoryGeneratedAt, inventorySupplied, refreshLauncher]);

    // An explicit refresh re-reads both halves directly rather than relying on the derived chain:
    // an unchanged inventory would otherwise leave the launcher feed untouched, and a user who
    // pressed refresh is entitled to a real re-read of what they can see.
    const refreshInventory = liveInventory.refresh;
    const refresh = React.useMemo(() => {
        if (inventorySupplied || !refreshInventory) {
            return undefined;
        }
        return () => {
            refreshInventory();
            refreshLauncher?.();
        };
    }, [inventorySupplied, refreshInventory, refreshLauncher]);

    const inventoryState = input.inventoryState ?? liveInventory.state;
    const sourceLauncherState = input.launcherState !== undefined ? input.launcherState : liveLauncher.state;
    const bindings = useProjectServiceBindings(input, sourceLauncherState);
    const launcherState = bindings.state;
    const applyLauncherSnapshot = input.launcherState === undefined ? liveLauncher.applySnapshot : undefined;
    return React.useMemo(() => ({
        inventoryState,
        launcherState,
        refresh: refresh ? () => { refresh(); bindings.refresh(); } : undefined,
        applyLauncherSnapshot,
    }), [applyLauncherSnapshot, bindings.refresh, inventoryState, launcherState, refresh]);
}

type ServiceActual = Extract<ProjectServicePlacementGetResultV1, { status: 'ready' }>['actual'];

/** Projection only: reads the same launcher store and parked inventory watches as the SOURCE feed.
 * The protocol observation owner selects accepted endpoints and proves native provenance. */
function useProjectServiceBindings(input: LocalServiceLiveFeedsInput, sourceState: LocalServiceLauncherState | null) {
    const enabled = input.launcherState === undefined && input.scope === 'workspace' && Boolean(input.workspaceRefId && input.serverId);
    const { binding } = useServerCredentialAccountScopeBinding(enabled ? input.serverId ?? '' : '');
    const rows = storage(state => enabled ? readCurrentProjectAccountRows(state) : null);
    const sourceTargets = React.useMemo(() => sourceState ? selectLocalServiceLaunchTargets(sourceState) : [], [sourceState?.targetsById]);
    const declarations = React.useMemo(() => sourceTargets.filter(target => target.declaration && target.declaration.workspaceRefId === input.workspaceRefId
        && target.declaration.selection.kind === 'manifest'), [input.workspaceRefId, sourceTargets]);
    const [change, observeAgain] = React.useReducer((value: number) => value + 1, 0);
    const subscriptions = React.useMemo(() => new Map<string, Readonly<{ key: LocalServiceLauncherStoreKeyInput; dispose: () => void }>>(),
        [binding, enabled, input.serverId, input.workspaceRefId, input.launcherSnapshotClient, input.inventorySnapshotClient, rows]);
    React.useEffect(() => () => { for (const subscription of subscriptions.values()) subscription.dispose(); subscriptions.clear(); }, [subscriptions]);
    const [observation, setObservation] = React.useState<Readonly<{ subscriptions: typeof subscriptions; declarations: typeof declarations; values: ReadonlyMap<string, ServiceActual> }> | null>(null);
    React.useEffect(() => {
        let current = true;
        if (!enabled || !binding?.isCurrent() || !rows || rows.status !== 'ready' || rows.coverage !== 'complete'
            || rows.scope.accountId !== binding.accountId || !areServerProfileIdentifiersEquivalent(rows.scope.serverId, input.serverId ?? '')) return;
        const isCurrent = () => current && binding.isCurrent() && readCurrentProjectAccountRows(storage.getState()) === rows;
        void Promise.all(declarations.map(async target => {
            const selection = target.declaration!.selection;
            const serviceName = selection.kind === 'manifest' ? selection.name : target.id;
            const actual = await observeProjectServicePlacementActualV1({ workspace: { serverId: input.serverId!, refId: input.workspaceRefId! }, serviceName,
                workspaceRefs: rows.workspaceRefs, relationships: rows.relationships,
                context: { normalizeServerId: resolveServerProfileScopeIdForIdentifier }, isCurrent,
                readSnapshot: async request => {
                    const key: LocalServiceLauncherStoreKeyInput = { machineId: request.machineId, serverId: input.serverId,
                        accountId: binding.accountId, scope: 'workspace', workspaceRoot: request.workspaceRoot, projection: 'managed_bindings' };
                    const id = JSON.stringify(key);
                    if (!subscriptions.has(id)) {
                        const disposeLauncher = subscribeLocalServiceLauncherStore(key, observeAgain,
                            input.launcherSnapshotClient ? { snapshotClient: input.launcherSnapshotClient } : undefined);
                        const inventoryKey = { machineId: key.machineId, serverId: key.serverId };
                        let generatedAt = getLocalServiceInventoryState(inventoryKey).generatedAt;
                        const disposeInventory = subscribeLocalServiceInventoryStore(inventoryKey, () => {
                            const next = getLocalServiceInventoryState(inventoryKey).generatedAt;
                            if (next === generatedAt) return;
                            const previous = generatedAt;
                            generatedAt = next;
                            if (previous !== null) invalidateLocalServiceLauncherStore(key);
                        }, input.inventorySnapshotClient ? { snapshotClient: input.inventorySnapshotClient } : undefined);
                        subscriptions.set(id, { key, dispose: () => { disposeLauncher(); disposeInventory(); } });
                    }
                    const state = getLocalServiceLauncherState(key);
                    const snapshot = snapshotFromLocalServiceLauncherState(state);
                    if (!snapshot || state.refreshStatus === 'error') throw new Error('Service binding is unavailable');
                    return { protocolVersion: 1, snapshot };
                },
            });
            return [target.id, actual] as const;
        })).then(values => { if (isCurrent()) setObservation({ subscriptions, declarations, values: new Map(values) }); });
        return () => { current = false; };
    }, [binding, change, declarations, enabled, input.serverId, input.workspaceRefId, input.launcherSnapshotClient, input.inventorySnapshotClient, rows, subscriptions]);
    const state = React.useMemo(() => {
        if (!enabled || !sourceState || !declarations.length) return sourceState;
        const values = observation?.subscriptions === subscriptions && observation.declarations === declarations ? observation.values : null;
        const targets = sourceTargets.flatMap(target => {
            if (!declarations.includes(target)) return [target];
            const actual = values?.get(target.id);
            if (actual?.status === 'present') return [actual.target];
            if (actual?.status === 'ambiguous') return [...actual.targets];
            if (actual?.status === 'absent') return [target];
            // An unavailable binding is not a stopped suggestion or executable Start authority.
            return [{ ...target, state: 'unavailable' as const, unavailableReason: 'project_service_binding_unavailable', actions: [] }];
        });
        return applyLocalServiceLauncherSnapshot(sourceState, { v: 1, machineId: sourceState.machineId!,
            ...(sourceState.sessionId ? { sessionId: sourceState.sessionId } : {}), updatedAt: sourceState.updatedAt!, targets });
    }, [declarations, enabled, observation, sourceState, sourceTargets, subscriptions]);
    const refresh = React.useCallback(() => { for (const { key } of subscriptions.values()) {
        invalidateLocalServiceLauncherStore(key);
        invalidateLocalServiceInventoryStore({ serverId: key.serverId, machineId: key.machineId });
    } }, [subscriptions]);
    return { state, refresh };
}
