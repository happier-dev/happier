import * as React from 'react';
import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { observeProjectServicePlacementActualV1, type ProjectServicePlacementGetResultV1 } from '@happier-dev/protocol/workspaces/projectServicePlacementV1';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { storage } from '@/sync/domains/state/storage';
import { readCurrentProjectAccountRows } from '@/sync/store/domains/projectAccountRows';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { getLocalServiceLauncherState, readLocalServiceLauncherStore, subscribeLocalServiceLauncherStore,
    invalidateLocalServiceLauncherStore, type LocalServiceLauncherStoreKeyInput } from '@/sync/domains/local/services/launch/sharedStore';
import { captureLazyActionAccountContext, type LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { readUiWorkspaceSyncChildMachineFacts } from '@/sync/ops/workspaceSyncChildMachineFacts';
import { subscribeMachineRpcRecovery } from '@/sync/runtime/orchestration/serverScopedRpc/subscribeMachineRpcRecovery';
import { createFrontDoorRuntimeActionExecutor } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import { t } from '@/text';
import { presentLocalServiceActionFailure, readLocalServiceActionOutcome, readLocalServiceFailureOutcome } from './localServiceActionOutcome';
import { selectLocalServiceLaunchTargets, snapshotFromLocalServiceLauncherState } from '@/sync/domains/local/services/launch/store';
import { reconcileLocalServiceLauncherTargets } from '@/sync/domains/local/services/launch/store';

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
    /**
     * The Home's Local services decision from `useLocalServicePresentationFeatures` (`localServicesArm
     * === 'available'`). False starts no scan, watch or Project observation. Product surfaces always
     * pass it; only tests and specimens that drive the feeds directly omit it.
     */
    available?: boolean;
    /** Supplied state replaces the live feed (tests, previews); `undefined` reads live. */
    inventoryState?: LocalServiceInventoryState;
    launcherState?: LocalServiceLauncherState | null;
    inventorySnapshotClient?: LocalServiceInventorySnapshotClient;
    launcherSnapshotClient?: LocalServiceLauncherSnapshotClient;
}>;

export type LocalServiceLiveFeeds = Readonly<{
    inventoryState: LocalServiceInventoryState;
    launcherState: LocalServiceLauncherState | null;
    /** Effective definition's ordinary slots; null means no declaration was supplied. */
    worktreePortSlots: number | null;
    /** Undefined when the inventory is supplied rather than live. */
    refresh: (() => Promise<void>) | undefined;
    applyLauncherSnapshot: ReturnType<typeof useLocalServiceLauncherStateController>['applySnapshot'] | undefined;
}>;

export function useLocalServiceLiveFeeds(input: LocalServiceLiveFeedsInput): LocalServiceLiveFeeds {
    const available = input.available !== false;
    const liveInventory = useLocalServiceInventoryStateController({
        machineId: input.machineId,
        serverId: input.serverId,
        sessionId: input.sessionId,
        enabled: available && input.inventoryState === undefined,
        snapshotClient: input.inventorySnapshotClient,
    });
    const liveLauncher = useLocalServiceLauncherStateController({
        machineId: input.machineId,
        serverId: input.serverId,
        sessionId: input.sessionId,
        scope: input.scope,
        workspaceRoot: input.workspaceRoot ?? null,
        enabled: available && input.launcherState === undefined,
        snapshotClient: input.launcherSnapshotClient,
    });
    // Launcher freshness is owned by its shared store for every consumer and mutation surface.
    const inventorySupplied = input.inventoryState !== undefined;

    const inventoryState = input.inventoryState ?? liveInventory.state;
    const sourceLauncherState = input.launcherState !== undefined ? input.launcherState : liveLauncher.state;
    const bindings = useProjectServiceBindings(input, sourceLauncherState);
    const launcherState = bindings.state;
    const applyLauncherSnapshot = input.launcherState === undefined ? liveLauncher.applySnapshot : undefined;
    const refresh = React.useMemo(() => !available || inventorySupplied || !liveInventory.refresh || !input.machineId || !input.serverId
        ? undefined : async () => {
            if (!bindings.binding?.isCurrent()) return;
            if (inventoryState.refreshState === 'unavailable') {
                liveLauncher.refresh?.();
                await bindings.refresh(true);
                return;
            }
            const refreshed = await refreshLocalServiceMachine({ machineId: input.machineId!, serverId: input.serverId!, sessionId: input.sessionId,
                accountId: bindings.binding.accountId, isCurrent: bindings.binding.isCurrent });
            await bindings.refresh(refreshed);
        }, [available, inventorySupplied, inventoryState.refreshState, liveInventory.refresh, liveLauncher.refresh,
            input.machineId, input.serverId, input.sessionId, bindings.binding, bindings.refresh]);
    return React.useMemo(() => ({
        inventoryState,
        launcherState,
        worktreePortSlots: launcherState?.worktreePorts?.declaredSlots ?? null,
        refresh,
        applyLauncherSnapshot,
    }), [applyLauncherSnapshot, bindings.refresh, inventoryState, launcherState, refresh]);
}

/** User Refresh uses the Action owner; successful inventory publication drives
 * observation. Launcher invalidation below is only its derived read. */
async function refreshLocalServiceMachine(input: Readonly<{ serverId: string; machineId: string; sessionId?: string | null; accountId: string; isCurrent(): boolean }>) {
    const outcome = await createFrontDoorRuntimeActionExecutor()({ actionId: 'localServices.inventory.refresh',
        input: { machineId: input.machineId, ...(input.sessionId ? { sessionId: input.sessionId } : {}) },
        context: { surface: 'ui', serverId: input.serverId, ...(input.accountId ? { expectedAccountId: input.accountId } : {}) },
    }).then(readLocalServiceActionOutcome, readLocalServiceFailureOutcome);
    if (!input.isCurrent()) return false;
    if (outcome.kind === 'failed' || outcome.kind === 'outcome_unknown') {
        presentLocalServiceActionFailure({ title: t('common.refresh'), ...outcome });
    }
    return outcome.kind === 'succeeded';
}

type ServiceActual = Extract<ProjectServicePlacementGetResultV1, { status: 'ready' }>['actual'];
type ProjectAccountRowsSnapshot = NonNullable<ReturnType<typeof readCurrentProjectAccountRows>>;
type ChildMachineFactsSnapshot = Awaited<ReturnType<typeof readUiWorkspaceSyncChildMachineFacts>>;

type RelevantServiceTopology = Readonly<{
    workspaceRefs: ProjectAccountRowsSnapshot['workspaceRefs'];
    relationships: ProjectAccountRowsSnapshot['relationships'];
    relationshipIdsKey: string;
    topologyKey: string;
}>;

const EMPTY_TOPOLOGY: RelevantServiceTopology = Object.freeze({
    workspaceRefs: [],
    relationships: [],
    relationshipIdsKey: '[]',
    topologyKey: '',
});

/**
 * Derive stable topology keys for a workspace while preserving full refs/relationships for
 * bind-mounted parent-child resolution inside `observeProjectServicePlacementActualV1`.
 * Unrelated workspace-ref edits that touch neither this workspace nor any relationship endpoint
 * keep `topologyKey` and `relationshipIdsKey` stable.
 */
function selectRelevantServiceTopology(
    rows: ProjectAccountRowsSnapshot | null,
    workspaceRefId: string | null | undefined,
): RelevantServiceTopology {
    if (!rows || !workspaceRefId) return EMPTY_TOPOLOGY;
    const relationships = [...rows.relationships].sort((left, right) => left.relationshipId.localeCompare(right.relationshipId));
    const relevantRefIds = new Set<string>([workspaceRefId]);
    for (const relationship of relationships) {
        relevantRefIds.add(relationship.alphaWorkspaceRefId);
        relevantRefIds.add(relationship.betaWorkspaceRefId);
    }
    const relevantWorkspaceRefs = rows.workspaceRefs
        .filter(ref => relevantRefIds.has(ref.id))
        .sort((left, right) => left.id.localeCompare(right.id));
    const relationshipIdsKey = JSON.stringify(relationships.map(relationship => relationship.relationshipId));
    const topologyKey = JSON.stringify({ workspaceRefs: relevantWorkspaceRefs, relationships });
    return { workspaceRefs: rows.workspaceRefs, relationships: rows.relationships, relationshipIdsKey, topologyKey };
}

function isProjectRowsReadyForBinding(
    rows: ReturnType<typeof readCurrentProjectAccountRows>,
    accountId: string,
    serverId: string,
): rows is ProjectAccountRowsSnapshot {
    return rows?.status === 'ready'
        && rows.coverage === 'complete'
        && rows.scope.accountId === accountId
        && areServerProfileIdentifiersEquivalent(rows.scope.serverId, serverId);
}

/** Projection only: reads the same launcher store and projected watches as the SOURCE feed.
 * The protocol observation owner selects accepted endpoints and proves native provenance. */
function useProjectServiceBindings(input: LocalServiceLiveFeedsInput, sourceState: LocalServiceLauncherState | null) {
    const presented = useLayoutPresentationActive();
    const enabled = presented && input.available !== false && input.launcherState === undefined && input.scope === 'workspace' && Boolean(input.workspaceRefId && input.serverId);
    const { binding } = useServerCredentialAccountScopeBinding(input.serverId ?? '');
    const rows = storage(state => enabled ? readCurrentProjectAccountRows(state) : null);
    const canObserve = enabled && binding?.isCurrent() === true && isProjectRowsReadyForBinding(rows, binding.accountId, input.serverId ?? '');
    const [bindingTick, bumpBindingTick] = React.useReducer((value: number) => value + 1, 0);
    const [censusGeneration, renewCensus] = React.useReducer((value: number) => value + 1, 0);
    const cachedCensusRef = React.useRef<Readonly<{
        binding: typeof binding;
        censusGeneration: number;
        abort: AbortController;
        account: LazyActionAccountContext;
        facts: ChildMachineFactsSnapshot;
    }> | null>(null);
    const rawTopology = React.useMemo(
        () => canObserve && rows ? selectRelevantServiceTopology(rows, input.workspaceRefId) : EMPTY_TOPOLOGY,
        [canObserve, input.workspaceRefId, rows],
    );
    const stableTopologyRef = React.useRef<RelevantServiceTopology>(rawTopology);
    const topology = React.useMemo(() => {
        if (stableTopologyRef.current.topologyKey === rawTopology.topologyKey) return stableTopologyRef.current;
        stableTopologyRef.current = rawTopology;
        return rawTopology;
    }, [rawTopology]);

    const sourceTargets = React.useMemo(() => sourceState ? selectLocalServiceLaunchTargets(sourceState) : [], [sourceState?.targetsById]);
    const rawDeclarations = React.useMemo(() => sourceTargets.filter(target => target.declaration && target.declaration.workspaceRefId === input.workspaceRefId
        && target.declaration.selection.kind === 'manifest'), [input.workspaceRefId, sourceTargets]);
    const stableDeclarationsRef = React.useRef<typeof rawDeclarations>(rawDeclarations);
    const declarations = React.useMemo(() => {
        const previous = stableDeclarationsRef.current;
        const same = previous.length === rawDeclarations.length && previous.every((target, index) => {
            const next = rawDeclarations[index]!;
            return target.id === next.id
                && sameStrictJsonValue(target.declaration, next.declaration)
                && sameStrictJsonValue(target.workspace, next.workspace);
        });
        if (same) return previous;
        stableDeclarationsRef.current = rawDeclarations;
        return rawDeclarations;
    }, [rawDeclarations]);
    const disposeCachedCensus = React.useCallback(() => {
        const previous = cachedCensusRef.current;
        cachedCensusRef.current = null;
        previous?.abort.abort();
        previous?.account.dispose();
    }, []);

    // Launcher subscriptions track only the workspace's connected relationships, never unrelated project rows.
    const subscriptions = React.useMemo(() => new Map<string, Readonly<{ key: LocalServiceLauncherStoreKeyInput; dispose: () => void }>>(),
        [binding, enabled, input.serverId, input.workspaceRefId, input.launcherSnapshotClient, topology.relationshipIdsKey]);
    React.useEffect(() => {
        if (!canObserve || !binding || !input.machineId) return;
        // Project admission can fail independently of healthy native snapshots. Reconnect
        // must renew that observation even when the launcher has no changed facts to publish.
        return subscribeMachineRpcRecovery({ machineId: input.machineId, serverId: input.serverId,
            expectedAccountId: binding.accountId }, () => {
                // Failed native reads publish their recovery and renew this observation.
                // Wait for those facts instead of starting a census of the failed feed.
                for (const { key } of subscriptions.values()) {
                    if (key.machineId === input.machineId && getLocalServiceLauncherState(key).refreshStatus === 'error') return;
                }
                renewCensus();
            });
    }, [binding, canObserve, input.machineId, input.serverId, subscriptions]);
    React.useEffect(() => {
        const release = () => {
            for (const subscription of subscriptions.values()) subscription.dispose();
            subscriptions.clear();
            disposeCachedCensus();
        };
        const retirement = binding?.onRetire(release);
        return () => { retirement?.dispose(); release(); };
    }, [binding, disposeCachedCensus, subscriptions]);
    React.useEffect(() => {
        if (!canObserve) disposeCachedCensus();
    }, [canObserve, disposeCachedCensus]);

    const [observation, setObservation] = React.useState<Readonly<{
        binding: typeof binding;
        topologyKey: string;
        declarations: typeof declarations;
        values: ReadonlyMap<string, ServiceActual>;
    }> | null>(null);
    React.useEffect(() => {
        let current = true;
        if (!canObserve || !binding || !topology.topologyKey) return;
        const topologyKey = topology.topologyKey;
        const isCurrent = () => {
            if (!current || !binding.isCurrent()) return false;
            const liveRows = readCurrentProjectAccountRows(storage.getState());
            return isProjectRowsReadyForBinding(liveRows, binding.accountId, input.serverId!)
                && selectRelevantServiceTopology(liveRows, input.workspaceRefId).topologyKey === topologyKey;
        };
        const abort = new AbortController();
        void (async () => {
          if (!declarations.length) return [];
          const cached = cachedCensusRef.current;
          const reusable = cached
              && cached.binding === binding
              && cached.censusGeneration === censusGeneration
              && cached.account.accountId === binding.accountId;
          let facts: ChildMachineFactsSnapshot;
          if (reusable) {
              facts = cached.facts;
          } else {
              const censusAbort = new AbortController();
              const abortPendingCensus = () => censusAbort.abort();
              if (abort.signal.aborted) censusAbort.abort();
              else abort.signal.addEventListener('abort', abortPendingCensus, { once: true });
              let account: LazyActionAccountContext;
              try {
                  account = await captureLazyActionAccountContext(input.serverId!, censusAbort.signal);
                  try {
                      if (account.accountId !== binding.accountId) throw new Error('Project Account changed');
                      facts = await readUiWorkspaceSyncChildMachineFacts(account, censusAbort.signal);
                  } catch (error) {
                      account.dispose();
                      throw error;
                  }
              } finally {
                  abort.signal.removeEventListener('abort', abortPendingCensus);
              }
              if (!isCurrent()) {
                  censusAbort.abort();
                  account.dispose();
                  return [];
              }
              disposeCachedCensus();
              cachedCensusRef.current = { binding, censusGeneration, abort: censusAbort, account, facts };
          }
          try {
            return await Promise.all(declarations.map(async target => {
            const selection = target.declaration!.selection;
            const serviceName = selection.kind === 'manifest' ? selection.name : target.id;
            const actual = await observeProjectServicePlacementActualV1({ workspace: { serverId: input.serverId!, refId: input.workspaceRefId! }, serviceName,
                workspaceRefs: topology.workspaceRefs, relationships: topology.relationships, ...facts,
                context: { normalizeServerId: resolveServerProfileScopeIdForIdentifier }, isCurrent,
                readSnapshot: async request => {
                    const key: LocalServiceLauncherStoreKeyInput = { machineId: request.machineId, serverId: binding.scope.serverId,
                        accountId: binding.accountId, credentialKey: binding.credentialKey,
                        scope: 'workspace', workspaceRoot: request.workspaceRoot, projection: 'managed_bindings' };
                    const id = JSON.stringify(key);
                    if (!isCurrent()) throw new Error('Project Account changed');
                    if (!subscriptions.has(id)) {
                        let previous = getLocalServiceLauncherState(key);
                        const disposeLauncher = subscribeLocalServiceLauncherStore(key, () => {
                            const next = getLocalServiceLauncherState(key);
                            const wasError = previous.refreshStatus === 'error';
                            const observed = previous.updatedAt !== null || wasError;
                            previous = next;
                            // This observation awaits initial hydration below. Restarting it on
                            // that same read would discard its admitted Machine census and result.
                            // The store publishes only changed native facts or availability.
                            if (!observed) return;
                            // Recovery from a failed native feed renews the Machine census; steady
                            // watch ticks reuse the admitted census without calling fetchMachineRows.
                            if (wasError && next.refreshStatus !== 'error') renewCensus();
                            else bumpBindingTick();
                        }, {
                            ...(input.launcherSnapshotClient ? { snapshotClient: input.launcherSnapshotClient } : {}),
                        });
                        subscriptions.set(id, { key, dispose: disposeLauncher });
                    }
                    await readLocalServiceLauncherStore(key);
                    const state = getLocalServiceLauncherState(key);
                    const snapshot = snapshotFromLocalServiceLauncherState(state);
                    // A failed refresh carries no new binding fact. Re-project the
                    // admitted snapshot so last-known rows keep their state and group.
                    if (!snapshot) throw new Error('Service binding is unavailable');
                    return { protocolVersion: 1, snapshot };
                },
            });
            return [target.id, actual] as const;
            }));
          } catch (error) {
              if (cachedCensusRef.current?.facts === facts) disposeCachedCensus();
              throw error;
          }
        })().then(values => { if (isCurrent()) setObservation({ binding, topologyKey, declarations, values: new Map(values) }); })
            .catch(() => { if (isCurrent()) setObservation({ binding, topologyKey, declarations,
                values: new Map(declarations.map(target => [target.id, { status: 'unavailable' as const }])) }); });
        return () => { current = false; abort.abort(); };
    }, [binding, bindingTick, canObserve, censusGeneration, declarations, disposeCachedCensus, enabled, input.serverId, input.workspaceRefId, input.launcherSnapshotClient, subscriptions, topology]);
    const sourceTargetIds = sourceState?.targetIds;
    const sourceTargetsById = sourceState?.targetsById;
    // Project rows depend on native facts and their binding, not a new scan cursor.
    // Reconcile that collection once per structural change; carry freshness separately below.
    const projection = React.useMemo(() => {
        if (!enabled || !sourceTargetIds || !sourceTargetsById || !declarations.length) return null;
        const declarationIds = new Set(declarations.map(target => target.id));
        const values = canObserve && observation?.binding === binding && observation.topologyKey === topology.topologyKey ? observation.values : null;
        const rowIdsByTargetId = new Map<string, string>();
        let pending = false;
        const targets = sourceTargets.flatMap(target => {
            if (!declarationIds.has(target.id)) return [target];
            // A fresh SOURCE target can change native facts without changing the
            // declaration being observed. Keep its completed binding while the
            // same census refreshes; new declarations/topology still start unread.
            const observedDeclaration = observation?.declarations.find(previous => previous.id === target.id);
            const actual = observedDeclaration && sameStrictJsonValue(observedDeclaration.declaration, target.declaration)
                && sameStrictJsonValue(observedDeclaration.workspace, target.workspace) ? values?.get(target.id) : undefined;
            if (!actual && canObserve) pending = true;
            if (actual?.status === 'present') {
                // Moving changes native custody, not the declared Service the person opened.
                // Keep presentation identity separate from the native target used by Actions.
                rowIdsByTargetId.set(actual.target.id, target.id);
                return [actual.target];
            }
            if (actual?.status === 'ambiguous') return [...actual.targets];
            if (actual?.status === 'absent') return [target];
            // A pending read offers no Start authority, but is not a failed observation.
            return [{ ...target, state: 'unavailable' as const,
                unavailableReason: !actual && canObserve ? 'project_service_binding_pending' : 'project_service_binding_unavailable',
                ...(actual?.status === 'unavailable' && actual.machineId ? { unavailableMachineId: actual.machineId } : {}), actions: [] }];
        });
        return { collection: reconcileLocalServiceLauncherTargets({ targetIds: sourceTargetIds, targetsById: sourceTargetsById }, targets),
            rowIdsByTargetId, pending };
    }, [binding, canObserve, declarations, enabled, observation, sourceTargetIds, sourceTargetsById, sourceTargets, topology.topologyKey]);
    const state = React.useMemo(() => !projection || !sourceState ? sourceState : {
        ...sourceState,
        targetIds: projection.collection.targetIds,
        targetsById: projection.collection.targetsById,
        rowIdsByTargetId: projection.rowIdsByTargetId,
        ...(projection.pending && sourceState.refreshStatus !== 'error' ? { refreshStatus: 'refreshing' as const } : {}),
    }, [projection, sourceState]);
    const refresh = React.useCallback(async (sourceRefreshed: boolean) => {
        let refreshed = sourceRefreshed;
        for (const { key } of subscriptions.values()) {
            if (!key.serverId || !binding?.isCurrent()) return;
            invalidateLocalServiceLauncherStore(key);
            await readLocalServiceLauncherStore(key);
            refreshed = refreshed || getLocalServiceLauncherState(key).refreshStatus !== 'error';
        }
        // Retry renews the existing native bindings and Project census even when
        // the source scan is unchanged or unavailable to this requester.
        if (binding?.isCurrent() && refreshed) renewCensus();
    }, [binding, subscriptions]);
    return { state, refresh, binding };
}
