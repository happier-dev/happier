import * as React from 'react';
import { subscribeHomeCredentialChange } from '@/sync/runtime/orchestration/homeAccountChange';
import { resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import { useMountedClientActionDemand } from '@/components/appShell/plugins/mountedClientActionDemand';
import { readPluginUiClientExecutableProjectionFacts, type PluginUiClientExecutableProjectionSource } from '../reactNative/clientExecutableProjection';
import { areSnapshotProjectionsEquivalent, retainDeep, retainKeyedRows } from '@/sync/domains/state/structuralSharing';
import { isPluginError } from '@happier-dev/plugin-sdk';
import type {
    DaemonPluginUiTargetedSurfaceMountV1} from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type {
    PreparedPluginJsonSchema,
} from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import type { DaemonPluginUiResourceDeclarationsByPluginIdV1, PluginUiTargetedSurfaceMountCoreV1 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import type { PluginUiAccountExecutableOrigin } from '../reactNative/executableModuleHost';
import { readPluginAccountAvailability } from '@/sync/domains/plugins/availability/projection';
import { readMountedAccountTargetedContributions } from './mountedAccountTargetedContributions';
import { projectNativeJsonValueForTransport, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { DaemonMergedProjectionInputs } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { loadDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import { readCompletePluginUiResourceDeclarations, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { createInstalledPluginUiProjectionPublication } from '@/sync/domains/plugins/ui/projectionUnion';
import { createPluginActionInputSelectionFactsPublication, readPluginActionInputSelectionPresenceSnapshot, type PluginActionInputSelectionSnapshot } from './pluginActionInputSelectionFacts';

import {
    preparePluginJsonSchema,
    rehydrateCanonicalProtocolComposableSchema,
} from '@happier-dev/protocol/plugins/actions/json-schema-validation';
import type { PluginUiTargetedContributionsV1 } from '@happier-dev/protocol/plugins/ui';

import {
    getMachineContributionRegistryProjectionRevision,
    machinePluginUiTargetedContributionsRead,
    publishMachineContributionRegistryProjectionInvalidation,
    subscribeMachineContributionRegistryProjectionInvalidation,
    type MachinePluginUiTargetedContributionsReadResult,
} from '@/sync/ops/machineContributionRegistryProjection';
import { getMachineContributionRegistryProjectionAuthorityRevision } from '@/sync/ops/machineContributionRegistryProjectionRevision';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import {
    pluginUiProjectionAdmissionTargetKey,
    savePluginUiProjectionTargetedAdmissionSnapshot,
} from '@/sync/domains/plugins/ui/projectionWarmCache';

export type MountedPluginUiTargetedSurfaceMountV1 = Readonly<DaemonPluginUiTargetedSurfaceMountV1 & {
    accountExecutionOrigin?: never;
}> | Readonly<
    PluginUiTargetedSurfaceMountCoreV1 & {
        accountExecutionOrigin: PluginUiAccountExecutableOrigin;
        executionOrigin?: never;
    }
>;

/**
 * One targeted embedded-Surface mount plus its prepared input validator and
 * Protocol normalizer. This is host-private executable state derived from one
 * target read response; it is never itself an RPC projection.
 */
type PreparedTargetedSurfaceMount<TMount> = TMount extends MountedPluginUiTargetedSurfaceMountV1 ? Readonly<
    Omit<TMount, 'inputSchema'> & {
        /** The canonical schema identity paired with `inputValidation`. */
        inputSchema: PreparedPluginJsonSchema['jsonSchema'];
        inputValidation: PreparedPluginJsonSchema;
        /** The sole Protocol rehydrator restores this target-owned normalizer. */
        inputNormalizer: NonNullable<ReturnType<typeof rehydrateCanonicalProtocolComposableSchema>>;
        /** Joined with current catalog/text by this target's source publication. */
        actionInputSelectionFactsKey?: PluginActionInputSelectionSnapshot;
        /** Present, even empty, only for a producer-complete plugin declaration set. */
        resourceDeclarations?: DaemonPluginUiResourceDeclarationsByPluginIdV1[string];
    }
> : never;

export type PreparedDaemonPluginUiTargetedSurfaceMountV1 = PreparedTargetedSurfaceMount<MountedPluginUiTargetedSurfaceMountV1>;

/**
 * Prepares each mount's input validator. A mount whose role schema is not
 * Protocol-canonical, or cannot be compiled, gets no physical child mount;
 * the rest of the response is unaffected.
 */
export function prepareTargetedSurfaceMounts(
    mounts: readonly MountedPluginUiTargetedSurfaceMountV1[],
): readonly PreparedDaemonPluginUiTargetedSurfaceMountV1[] {
    const prepared: PreparedDaemonPluginUiTargetedSurfaceMountV1[] = [];
    for (const mount of mounts) {
        try {
            const inputNormalizer = rehydrateCanonicalProtocolComposableSchema(mount.inputSchema);
            if (!inputNormalizer) continue;
            const inputValidation = preparePluginJsonSchema(inputNormalizer.jsonSchema);
            prepared.push(Object.freeze({
                ...mount,
                inputSchema: inputValidation.jsonSchema,
                inputValidation,
                inputNormalizer,
            }));
        } catch {
            // No fallback validator or renderer exists for an invalid mount.
        }
    }
    return Object.freeze(prepared);
}

/** One wire mount beside its preparation; null when it could not be prepared. */
type PreparedWireMount = Readonly<{ wire: MountedPluginUiTargetedSurfaceMountV1; prepared: PreparedDaemonPluginUiTargetedSurfaceMountV1 | null }>;

/**
 * Prepares each mount, reusing the previous preparation of an unchanged wire mount. Compiled
 * validators and normalizers are not plain data, so an equal re-read must not rebuild them.
 */
function prepareTargetedSurfaceMountsReusing(mounts: readonly MountedPluginUiTargetedSurfaceMountV1[],
    previous: readonly PreparedWireMount[]): Readonly<{ wires: readonly PreparedWireMount[]; prepared: readonly PreparedDaemonPluginUiTargetedSurfaceMountV1[] }> {
    const wires = mounts.map(wire => previous.find(entry => sameStrictJsonValue(entry.wire, wire))
        ?? { wire, prepared: prepareTargetedSurfaceMounts([wire])[0] ?? null });
    return { wires, prepared: Object.freeze(wires.flatMap(entry => entry.prepared ? [entry.prepared] : [])) };
}

export type MountedTargetedContributionsFailure = Readonly<{
    reason: Exclude<MachinePluginUiTargetedContributionsReadResult, { supported: true }>['reason'];
    code?: string;
}>;

export type MountedTargetedContributionsState = Readonly<{
    /**
     * `loading` keeps the last current snapshot visible while a refresh runs;
     * `failed` carries the classified reason so a fallback can say why.
     */
    phase: 'idle' | 'loading' | 'ready' | 'failed';
    targetedContributions: PluginUiTargetedContributionsV1 | null;
    preparedTargetedSurfaceMounts: readonly PreparedDaemonPluginUiTargetedSurfaceMountV1[] | null;
    /** Exact ready Machine inputs paired atomically with this source publication. */
    projectionInputs: DaemonMergedProjectionInputs | null;
    /** Already normalized/composed before the mounted host reads it. */
    pluginUiProjection: PluginUiProjectionModel | null;
    /** Missing plugin keys are unknown, not a declaration withdrawal. */
    resourceDeclarationsByPluginId: DaemonPluginUiResourceDeclarationsByPluginIdV1 | null;
    actionInputSelectionFactsKey: PluginActionInputSelectionSnapshot;
    failure: MountedTargetedContributionsFailure | null;
}>;

const IDLE_STATE: MountedTargetedContributionsState = Object.freeze({
    phase: 'idle',
    targetedContributions: null,
    preparedTargetedSurfaceMounts: null,
    projectionInputs: null,
    pluginUiProjection: null,
    resourceDeclarationsByPluginId: null,
    actionInputSelectionFactsKey: readPluginActionInputSelectionPresenceSnapshot({ hasPluginProjection: false, hasTargetedContributions: false }),
    failure: null,
});

const LOADING_STATE: MountedTargetedContributionsState = Object.freeze({
    ...IDLE_STATE,
    phase: 'loading',
});

type LoadedState = Readonly<{
    requestKey: string;
    projectionRevision: number;
    /** The authority revision the state was admitted under; only its change withdraws readiness. */
    authorityRevision: number;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    state: MountedTargetedContributionsState;
}>;

/**
 * A Machine target's last-good answer, kept across mounts per Account and target so a re-open draws it at
 * once. It is never trusted as current: every open revalidates it. Machine reachability and transport are
 * the currentness owner's decision (`usePluginUiProjectionCurrentness`), and a stale invocation is refused
 * at dispatch. The authority revision it was admitted under decides whether the drawn answer is ready
 * (same authority) or loading (authority changed). The Home Account change owner drops a Home's entries
 * when its Account leaves.
 */
type SettledTargetCustody = Readonly<{
    projectionRevision: number;
    authorityRevision: number;
    state: MountedTargetedContributionsState;
    current: PluginUiTargetedContributionsV1 | null;
    projectionInputs: DaemonMergedProjectionInputs | null;
    sourcePresentation: PluginUiProjectionModel | null;
    resourceDeclarationsByPluginId: DaemonPluginUiResourceDeclarationsByPluginIdV1 | null;
    childMounts: readonly PreparedDaemonPluginUiTargetedSurfaceMountV1[];
    preparedWireMounts: readonly PreparedWireMount[];
}>;
const settledTargets = new Map<string, SettledTargetCustody & Readonly<{ homeScopeId: string }>>();
let releaseSettledTargetRetirement: (() => void) | null = null;

function settledTargetKey(lifetime: ActiveServerAccountScopeLifetime, targetKey: string): string {
    return JSON.stringify([resolveServerProfileScopeIdForIdentifier(lifetime.scope.serverId), lifetime.scope.accountId, targetKey]);
}

function readSettledTarget(lifetime: ActiveServerAccountScopeLifetime | null, targetKey: string): SettledTargetCustody | null {
    if (!lifetime?.isCurrent() || !targetKey) return null;
    return settledTargets.get(settledTargetKey(lifetime, targetKey)) ?? null;
}

function keepSettledTarget(lifetime: ActiveServerAccountScopeLifetime, targetKey: string,
    custody: SettledTargetCustody): void {
    // The key carries the Account; a read that lands after its lifetime retired is not kept.
    if (!lifetime.isCurrent()) return;
    releaseSettledTargetRetirement ??= subscribeHomeCredentialChange((event, { accountLeft }) => {
        if (!accountLeft) return;
        const homeScopeId = resolveServerProfileScopeIdForIdentifier(event.serverId);
        for (const [key, entry] of settledTargets) if (entry.homeScopeId === homeScopeId) settledTargets.delete(key);
    });
    const homeScopeId = resolveServerProfileScopeIdForIdentifier(lifetime.scope.serverId);
    settledTargets.set(settledTargetKey(lifetime, targetKey), { ...custody, homeScopeId });
}

// Process-global custody: the test setup resets it before each test, like other module state.
(globalThis as unknown as { [key: symbol]: Map<string, () => void> | undefined })[Symbol.for('happier.vitest.testResets')]
    ?.set('mountedTargetedContributions.settledTargets', () => settledTargets.clear());

/** An equal re-read publishes nothing: each field is already identity-retained by its producer. */
function sameReadyState(previous: MountedTargetedContributionsState, next: MountedTargetedContributionsState): boolean {
    return previous.phase === 'ready' && next.phase === 'ready'
        && previous.targetedContributions === next.targetedContributions
        && previous.preparedTargetedSurfaceMounts === next.preparedTargetedSurfaceMounts
        && previous.projectionInputs === next.projectionInputs
        && previous.pluginUiProjection === next.pluginUiProjection
        && previous.resourceDeclarationsByPluginId === next.resourceDeclarationsByPluginId
        && previous.actionInputSelectionFactsKey === next.actionInputSelectionFactsKey;
}

function normalizeKeyPart(value: string | null | undefined): string {
    return String(value ?? '').trim();
}

/**
 * The one owner of a mounted target's current contributions. It reads only
 * the target slice and exact Action facts for that target and its prepared
 * children. It re-reads when the machine projection is
 * invalidated, when the mounted occurrence changes, or on an explicit retry.
 * The answer is the daemon's current snapshot tagged with its occurrence,
 * which the caller compares with the occurrence it mounted.
 */
/** Executable facts a mounted Action admission carries; the projection generation is a revision stamp, not a fact. */
function sameMountedActionFacts(previous: PluginUiClientExecutableProjectionSource, next: PluginUiClientExecutableProjectionSource): boolean {
    if (previous.directMachineAuthority?.machineId !== next.directMachineAuthority?.machineId
        || previous.directMachineAuthority?.serverId !== next.directMachineAuthority?.serverId) return false;
    if (previous.projection === next.projection) return true;
    const { generation: _previousGeneration, ...previousFacts } = readPluginUiClientExecutableProjectionFacts(previous.projection);
    const { generation: _nextGeneration, ...nextFacts } = readPluginUiClientExecutableProjectionFacts(next.projection);
    return areSnapshotProjectionsEquivalent(previousFacts, nextFacts);
}

export function useMountedTargetedContributions(params: Readonly<{
    /** The exact lifetime already acquired by the mounted Host/controller. */
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    machineId: string | null | undefined;
    serverId: string | null | undefined;
    pluginId: string | null | undefined;
    /** The occurrence the mount was built from; a change re-reads. */
    mountedOccurrenceId: string | null | undefined;
    enabled: boolean;
    /** Already admitted no-points target; it needs no points RPC. */
    emptyTargetedContributions?: PluginUiTargetedContributionsV1 | null;
    /** Admitted declaration identities only; current executable facts come from the exact read. */
    pluginUiProjection?: PluginUiProjectionModel | null;
    refreshKey?: unknown;
    accountExecutionOrigin?: PluginUiAccountExecutableOrigin;
    /** Exact selected Machine caller, distinct from this renderer's Account custody. */
    machineTarget?: PluginUiTargetedContributionsV1['target'] | null;
}>): MountedTargetedContributionsState {
    const machineId = normalizeKeyPart(params.machineId);
    const serverId = normalizeKeyPart(params.serverId);
    const pluginId = normalizeKeyPart(params.pluginId);
    const mountedOccurrenceId = normalizeKeyPart(params.mountedOccurrenceId);
    const accountOriginKey = JSON.stringify(params.accountExecutionOrigin ?? null);
    const accountOrigin = React.useMemo(() => params.accountExecutionOrigin, [accountOriginKey]);
    const machineTargetKey = JSON.stringify(params.machineTarget ?? null);
    const machineTarget = React.useMemo(() => params.machineTarget, [machineTargetKey]);
    const emptyTargetedContributions = params.emptyTargetedContributions;
    const declaredActions = params.pluginUiProjection?.actionsById;
    // Supplier/presentation updates do not change this target's acquisition.
    // Its occurrence and registry invalidation own re-admission; borrow the
    // latest committed declaration identities when that acquisition runs.
    const declaredActionsRef = React.useRef(declaredActions);
    React.useLayoutEffect(() => { declaredActionsRef.current = declaredActions; }, [declaredActions]);
    const active = params.enabled && Boolean(machineId || accountOrigin) && Boolean(pluginId);
    const accountLifetime = active ? params.accountLifetime : null;
    const accountAvailability = React.useMemo(() => accountLifetime
        ? readPluginAccountAvailability(accountLifetime.scope) : null, [accountLifetime]);
    const [accountRevision, refreshAccount] = React.useReducer((revision: number) => revision + 1, 0);
    const projectionScope = React.useMemo(() => (
        active && machineId ? { machineId, serverId: serverId || null } : null
    ), [active, machineId, serverId]);
    const subscribe = React.useCallback((listener: () => void) => (
        projectionScope
            ? subscribeMachineContributionRegistryProjectionInvalidation(projectionScope, listener)
            : () => {}
    ), [projectionScope]);
    const getRevision = React.useCallback(() => (
        projectionScope ? getMachineContributionRegistryProjectionRevision(projectionScope) : 0
    ), [projectionScope]);
    const projectionRevision = React.useSyncExternalStore(subscribe, getRevision, getRevision);
    // A same-authority refresh re-reads behind the last answer; only an authority change withdraws it.
    const getAuthorityRevision = React.useCallback(() => (
        projectionScope ? getMachineContributionRegistryProjectionAuthorityRevision(projectionScope) : 0
    ), [projectionScope]);
    const authorityRevision = React.useSyncExternalStore(subscribe, getAuthorityRevision, getAuthorityRevision);
    const refreshKeyRef = React.useRef(params.refreshKey);
    React.useEffect(() => {
        if (refreshKeyRef.current === params.refreshKey) return;
        refreshKeyRef.current = params.refreshKey;
        // Explicit Retry advances the incumbent Machine currentness owner so
        // every mounted reader shares the same renewed question.
        if (projectionScope) publishMachineContributionRegistryProjectionInvalidation(projectionScope, 'refresh');
    }, [params.refreshKey, projectionScope]);
    // The target identity. Revision, occurrence and retry only ask again; they
    // never discard the snapshot this target already showed.
    const targetKey = active ? JSON.stringify([serverId, machineId, pluginId, accountOrigin ?? null, machineTarget ?? null]) : '';
    // A read tagged with a newer occurrence than the mount means the plugin
    // reloaded and the machine projection has not caught up. Ask it once per
    // (mounted, current) pair to refresh; the mount then follows the new
    // occurrence instead of showing an error.
    const followedOccurrenceRef = React.useRef<string | null>(null);
    // Only Machine targets: an Account-origin answer also follows Account Availability.
    const settled = React.useMemo(() => accountOrigin ? null : readSettledTarget(accountLifetime, targetKey),
        // The custody is read when a target (re)opens; later revisions re-read through the effect below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [accountLifetime, accountOrigin, targetKey]);
    // Last-good is drawn under the authority it was admitted with; the render below derives its phase.
    const seed = (custody: SettledTargetCustody, lifetime: ActiveServerAccountScopeLifetime): LoadedState => ({
        requestKey: targetKey, projectionRevision: custody.projectionRevision, authorityRevision: custody.authorityRevision,
        accountLifetime: lifetime, state: custody.state });
    let [loaded, setLoaded] = React.useState<LoadedState>(() => settled && accountLifetime ? seed(settled, accountLifetime) : {
        requestKey: '',
        projectionRevision: -1,
        authorityRevision: -1,
        accountLifetime: null,
        state: IDLE_STATE,
    });
    // The target or its Account lifetime can arrive after the first render (a routed binding resolving).
    if (settled && accountLifetime && (loaded.requestKey !== targetKey || loaded.accountLifetime !== accountLifetime)) {
        loaded = seed(settled, accountLifetime);
        setLoaded(loaded);
    }
    const installedPublication = React.useMemo(
        () => createInstalledPluginUiProjectionPublication(),
        [accountLifetime, targetKey],
    );
    const targetPublication = React.useMemo<{
        current: PluginUiTargetedContributionsV1 | null;
        projectionInputs: DaemonMergedProjectionInputs | null;
        sourcePresentation: PluginUiProjectionModel | null;
        resourceDeclarationsByPluginId: DaemonPluginUiResourceDeclarationsByPluginIdV1 | null;
        preparedWireMounts: readonly PreparedWireMount[];
    }>(
        () => ({ current: settled?.current ?? null, projectionInputs: settled?.projectionInputs ?? null,
            sourcePresentation: settled?.sourcePresentation ?? null,
            resourceDeclarationsByPluginId: settled?.resourceDeclarationsByPluginId ?? null,
            preparedWireMounts: settled?.preparedWireMounts ?? [] }), [accountLifetime, targetKey],
    );
    const selectionPublication = React.useMemo(() => createPluginActionInputSelectionFactsPublication(), [accountLifetime, targetKey]);
    const childPublications = React.useMemo<{
        entries: Array<{ mount: PreparedDaemonPluginUiTargetedSurfaceMountV1; selection: ReturnType<typeof createPluginActionInputSelectionFactsPublication> }>;
        snapshot: readonly PreparedDaemonPluginUiTargetedSurfaceMountV1[] | null;
    }>(() => settled ? {
        entries: settled.childMounts.map(mount => ({ mount, selection: createPluginActionInputSelectionFactsPublication() })),
        snapshot: settled.state.preparedTargetedSurfaceMounts,
    } : { entries: [], snapshot: null }, [accountLifetime, targetKey]);
    const readCurrentSources = React.useCallback((): Pick<MountedTargetedContributionsState, 'projectionInputs' | 'pluginUiProjection' | 'resourceDeclarationsByPluginId' | 'actionInputSelectionFactsKey' | 'preparedTargetedSurfaceMounts'> => {
        if (!accountLifetime?.isCurrent()) return { projectionInputs: null, pluginUiProjection: null, actionInputSelectionFactsKey: IDLE_STATE.actionInputSelectionFactsKey,
            preparedTargetedSurfaceMounts: null, resourceDeclarationsByPluginId: null };
        const projectionInputs = targetPublication.projectionInputs;
        // Copy and locale Resource declarations belong to the selected source,
        // just like its Action facts. An ambient replica cannot replace them.
        const runtime = projectionInputs?.pluginUiProjection ?? null;
        const account = accountAvailability?.readAccountUiProjection() ?? null;
        const pluginUiProjection = installedPublication.publish(account ? [account] : [], runtime);
        let childrenChanged = false;
        for (const child of childPublications.entries) {
            const actionInputSelectionFactsKey = child.selection.publish({ pluginProjectionById: projectionInputs?.pluginProjectionById,
                translationsByPluginId: pluginUiProjection?.translationsByPluginId,
                targetedContributions: child.mount.contributorTargetedContributions, targetPluginId: child.mount.contributor?.pluginId });
            if (child.mount.actionInputSelectionFactsKey !== actionInputSelectionFactsKey) {
                child.mount = Object.freeze({ ...child.mount, actionInputSelectionFactsKey });
                childrenChanged = true;
            }
        }
        if (childrenChanged) childPublications.snapshot = Object.freeze(childPublications.entries.map(child => child.mount));
        return {
            projectionInputs,
            pluginUiProjection,
            resourceDeclarationsByPluginId: targetPublication.resourceDeclarationsByPluginId,
            preparedTargetedSurfaceMounts: childPublications.snapshot,
            actionInputSelectionFactsKey: selectionPublication.publish({ pluginProjectionById: projectionInputs?.pluginProjectionById,
                translationsByPluginId: pluginUiProjection?.translationsByPluginId,
                targetedContributions: targetPublication.current, targetPluginId: pluginId }),
        };
    }, [accountAvailability, accountLifetime, childPublications, installedPublication, pluginId, projectionScope, selectionPublication, targetPublication]);

    React.useEffect(() => {
        if (!active || !accountLifetime) return;
        // Points-free targets may already carry a complete Resource namespace.
        targetPublication.sourcePresentation = params.pluginUiProjection ?? null;
        // Source notifications derive first, then publish one ready pair. React
        // state updaters and render/getSnapshot only read the prepared result.
        const updateSources = () => {
            const next = readCurrentSources();
            setLoaded(previous => previous.requestKey !== targetKey || previous.accountLifetime !== accountLifetime
                || (previous.state.projectionInputs === next.projectionInputs && previous.state.pluginUiProjection === next.pluginUiProjection
                    && previous.state.resourceDeclarationsByPluginId === next.resourceDeclarationsByPluginId
                    && previous.state.actionInputSelectionFactsKey === next.actionInputSelectionFactsKey
                    && previous.state.preparedTargetedSurfaceMounts === next.preparedTargetedSurfaceMounts)
                ? previous : { ...previous, state: { ...previous.state, ...next } });
        };
        const unsubscribeAccount = accountAvailability?.subscribe(() => {
            updateSources();
            if (accountOrigin) refreshAccount();
        });
        const retirement = accountLifetime.onRetire(updateSources);
        updateSources();
        return () => { unsubscribeAccount?.(); retirement.dispose(); };
    }, [accountAvailability, accountLifetime, accountOrigin, active, params.pluginUiProjection, projectionScope, readCurrentSources, targetKey, targetPublication]);

    React.useEffect(() => {
        if (!active || !accountLifetime) return;
        let alive = true;
        const abort = new AbortController();
        const retirement = accountLifetime.onRetire(() => abort.abort());
        setLoaded((previous) => {
            const sameTarget = previous.requestKey === targetKey
                && previous.accountLifetime === accountLifetime;
            // The same authority's answer stays admitted while it is re-read.
            if (sameTarget && previous.state.phase === 'ready' && previous.authorityRevision === authorityRevision) {
                return previous.projectionRevision === projectionRevision ? previous : { ...previous, projectionRevision };
            }
            return {
                requestKey: targetKey,
                projectionRevision,
                authorityRevision,
                accountLifetime,
                state: {
                    phase: 'loading',
                    targetedContributions: sameTarget ? previous.state.targetedContributions : null,
                    preparedTargetedSurfaceMounts: sameTarget
                        ? previous.state.preparedTargetedSurfaceMounts
                        : null,
                    projectionInputs: sameTarget ? previous.state.projectionInputs : null,
                    pluginUiProjection: sameTarget ? previous.state.pluginUiProjection : null,
                    resourceDeclarationsByPluginId: sameTarget ? previous.state.resourceDeclarationsByPluginId : null,
                    actionInputSelectionFactsKey: sameTarget ? previous.state.actionInputSelectionFactsKey : IDLE_STATE.actionInputSelectionFactsKey,
                    failure: null,
                },
            };
        });
        const isCurrent = () => alive && accountLifetime.isCurrent();
        const publish = async (result: MachinePluginUiTargetedContributionsReadResult
            | Awaited<ReturnType<typeof readMountedAccountTargetedContributions>>, includeMachine = true) => {
            if (!isCurrent()) return;
            if (!result.supported) {
                setLoaded((previous) => previous.requestKey !== targetKey
                    || previous.accountLifetime !== accountLifetime
                    ? previous
                    : {
                        ...previous,
                        state: {
                            ...previous.state,
                            phase: 'failed',
                            failure: Object.freeze({
                                reason: result.reason,
                                ...(result.code ? { code: result.code } : {}),
                            }),
                        },
                    });
                return;
            }
            const reused = prepareTargetedSurfaceMountsReusing(result.targetedSurfaceMounts, targetPublication.preparedWireMounts);
            targetPublication.preparedWireMounts = reused.wires;
            const preparedMounts = reused.prepared;
            const snapshots = [result.targetedContributions, ...preparedMounts.map(mount => mount.contributorTargetedContributions)];
            const callers = includeMachine ? [...new Map([
                ...(!accountOrigin ? [result.targetedContributions.target] : []),
                ...(accountOrigin && machineTarget ? [machineTarget] : []),
                ...preparedMounts.filter(mount => !mount.accountExecutionOrigin).map(mount => mount.contributorTargetedContributions.target),
            ].map(caller => [caller.pluginId, caller] as const)).values()] : [];
            const callerPluginIds = new Set(callers.map(caller => caller.pluginId));
            const actions = new Map<string, PluginContributionIdentityV1>();
            for (const action of Object.values(declaredActionsRef.current ?? {})) {
                if (callerPluginIds.has(action.pluginId)) {
                    const identity = { pluginId: action.pluginId, localId: action.id };
                    actions.set(buildQualifiedPluginContributionKey(identity), identity);
                }
            }
            for (const snapshot of snapshots) {
                for (const point of snapshot.points) {
                    for (const protocol of point.protocols) {
                        for (const contribution of protocol.contributions) {
                            for (const operation of contribution.operations) {
                                actions.set(buildQualifiedPluginContributionKey(operation.action), operation.action);
                            }
                        }
                    }
                }
            }
            if (machineId && callers.length > 0) {
                const exact = await loadDaemonMergedProjectionCacheEntry({ machineId, serverId: serverId || null,
                    // A mountedActions question names its own answer; selection replies are never sectioned.
                    sections: 'complete',
                    mountedActions: { callers, actions: [...actions.values()] }, accountLifetime, signal: abort.signal });
                if (!isCurrent()) return;
                if (exact?.kind !== 'ready') {
                    setLoaded(previous => previous.requestKey !== targetKey || previous.accountLifetime !== accountLifetime ? previous
                        // An admitted Account snapshot stays usable when only
                        // the optional Machine Action facts fail to hydrate.
                        : { ...previous, state: { ...previous.state,
                            phase: accountOrigin && targetPublication.current && !targetPublication.projectionInputs ? 'ready' : 'failed', failure: {
                            reason: exact?.kind === 'error' ? exact.reason : exact?.kind === 'unsupported' ? 'not-supported' : 'aborted',
                        } } });
                    return;
                }
                targetPublication.projectionInputs = exact.inputs;
            }
            // Recorded for the next fresh process: an offline mount may show
            // the last confirmed admission read-only.
            if (!accountOrigin) savePluginUiProjectionTargetedAdmissionSnapshot({
                scope: accountLifetime.scope,
                targetKey: pluginUiProjectionAdmissionTargetKey({
                    machineId,
                    serverId: serverId || null,
                }),
                machineId,
                targetedContributions: result.targetedContributions,
            });
            const currentOccurrenceId = result.targetedContributions.target.occurrenceId;
            if (mountedOccurrenceId && currentOccurrenceId !== mountedOccurrenceId && projectionScope) {
                const pair = `${mountedOccurrenceId}\0${currentOccurrenceId}`;
                if (followedOccurrenceRef.current !== pair) {
                    followedOccurrenceRef.current = pair;
                    // A replaced occurrence is a new authority, not a re-read.
                    publishMachineContributionRegistryProjectionInvalidation(projectionScope, 'authority');
                }
            }
            let incomingResources = result.resourceDeclarationsByPluginId ?? null;
            if (emptyTargetedContributions && !Object.hasOwn(incomingResources ?? {}, pluginId)) {
                // The points-free path already owns this supplying occurrence's
                // full Resource declaration set. A selected Action reply is not
                // a withdrawal of it and never invents complete-set coverage.
                const supplied = readCompletePluginUiResourceDeclarations(targetPublication.sourcePresentation, pluginId, currentOccurrenceId);
                if (supplied !== undefined) incomingResources = { ...incomingResources, [pluginId]: supplied };
            }
            targetPublication.resourceDeclarationsByPluginId = sameStrictJsonValue(targetPublication.resourceDeclarationsByPluginId, incomingResources)
                ? targetPublication.resourceDeclarationsByPluginId : incomingResources;
            const preparedTargetedSurfaceMounts = Object.freeze(preparedMounts.map(mount => Object.freeze({
                ...mount,
                resourceDeclarations: targetPublication.resourceDeclarationsByPluginId?.[mount.contributor?.pluginId ?? mount.target.pluginId],
            })));
            const childKey = (mount: PreparedDaemonPluginUiTargetedSurfaceMountV1) => JSON.stringify([
                mount.point.pointId, mount.point.protocol.id, mount.point.protocol.version,
                mount.contributor?.pluginId, mount.contributor?.contributionId, mount.contributor?.occurrenceId, mount.role,
            ]);
            const previousChildren = new Map(childPublications.entries.map(child => [childKey(child.mount), child]));
            childPublications.entries = preparedTargetedSurfaceMounts.map(mount => {
                const previous = previousChildren.get(childKey(mount));
                return { mount: retainDeep(previous?.mount, { ...mount, actionInputSelectionFactsKey: previous?.mount.actionInputSelectionFactsKey }),
                    selection: previous?.selection ?? createPluginActionInputSelectionFactsPublication() };
            });
            childPublications.snapshot = retainDeep(childPublications.snapshot, Object.freeze(childPublications.entries.map(child => child.mount)));
            const ownedTarget = projectNativeJsonValueForTransport(result.targetedContributions) as PluginUiTargetedContributionsV1;
            // Machine-only entries can sort before retained Account entries.
            // Reconcile contributors by identity before sharing the containing
            // snapshot, so an insertion never re-keys unaffected row inputs.
            const points = ownedTarget.points.map(point => {
                const previousPoint = targetPublication.current?.points.find(previous => previous.pointId === point.pointId);
                return { ...point, protocols: point.protocols.map(protocol => {
                    const previousProtocol = previousPoint?.protocols.find(previous => previous.protocol.id === protocol.protocol.id
                        && previous.protocol.version === protocol.protocol.version);
                    return { ...protocol, contributions: retainKeyedRows(previousProtocol?.contributions, protocol.contributions,
                        contribution => buildQualifiedPluginContributionKey({ pluginId: contribution.contributor.pluginId,
                            localId: contribution.contributor.contributionId })) };
                }) };
            });
            const targetedContributions = retainDeep(targetPublication.current, { ...ownedTarget, points }, { freeze: true });
            targetPublication.current = targetedContributions;
            const sources = readCurrentSources();
            const readyState: MountedTargetedContributionsState = { phase: 'ready', targetedContributions, ...sources, failure: null };
            if (!accountOrigin && includeMachine && machineId) {
                keepSettledTarget(accountLifetime, targetKey, { projectionRevision, authorityRevision,
                    state: readyState,
                    current: targetedContributions, projectionInputs: targetPublication.projectionInputs,
                    sourcePresentation: targetPublication.sourcePresentation,
                    resourceDeclarationsByPluginId: targetPublication.resourceDeclarationsByPluginId,
                    childMounts: childPublications.entries.map(child => child.mount),
                    preparedWireMounts: targetPublication.preparedWireMounts });
            }
            setLoaded((previous) => previous.requestKey !== targetKey
                || previous.accountLifetime !== accountLifetime
                || sameReadyState(previous.state, readyState)
                ? previous
                : { ...previous, state: readyState });
        };
        const read = emptyTargetedContributions
            ? Promise.resolve({ supported: true as const, targetedContributions: emptyTargetedContributions,
                targetedSurfaceMounts: [] as readonly MountedPluginUiTargetedSurfaceMountV1[], resourceDeclarationsByPluginId: undefined })
            : accountOrigin
            ? readMountedAccountTargetedContributions({ pluginId, origin: accountOrigin, accountLifetime,
                signal: abort.signal, isCurrent,
                ...(machineId ? { machine: { machineId, serverId: serverId || null } } : {}),
            // Refreshes keep the last complete answer; only a cold mount needs
            // an Account-only publication while Machine hydration continues.
            }, targetPublication.current ? undefined : result => publish(result, false))
                .catch((error: unknown) => ({ supported: false as const, reason: 'unavailable' as const,
                    code: isPluginError(error) ? error.code : 'plugin_targeted_contributions_unavailable' }))
            : machinePluginUiTargetedContributionsRead(machineId, {
                serverId: serverId || null, pluginId, accountLifetime, signal: abort.signal,
            });
        void read.then(async result => {
            if (emptyTargetedContributions && accountOrigin && !targetPublication.current) await publish(result, false);
            await publish(result);
        }).catch((error: unknown) => {
            if (!isCurrent()) return;
            setLoaded(previous => previous.requestKey !== targetKey || previous.accountLifetime !== accountLifetime
                ? previous
                : { ...previous, state: { ...previous.state, phase: 'failed', failure: {
                    reason: 'error',
                    ...(isPluginError(error) ? { code: error.code } : {}),
                } } });
        });
        return () => {
            alive = false;
            abort.abort();
            retirement.dispose();
        };
    }, [
        accountLifetime,
        accountOrigin,
        accountRevision,
        active,
        authorityRevision,
        childPublications,
        emptyTargetedContributions,
        machineId,
        machineTarget,
        mountedOccurrenceId,
        // Machine Retry wakes through projectionRevision; Account-only targets
        // retain their existing local retry signal.
        projectionScope ? undefined : params.refreshKey,
        pluginId,
        projectionRevision,
        projectionScope,
        readCurrentSources,
        serverId,
        targetKey,
        targetPublication,
    ]);

    let currentState = loaded.state;
    if (!active) currentState = IDLE_STATE;
    else if (!accountLifetime?.isCurrent() || loaded.requestKey !== targetKey || loaded.accountLifetime !== accountLifetime) {
        currentState = LOADING_STATE;
    }
    // Invalidation withdraws readiness in the render that observes it. Waiting
    // for the read effect would briefly re-admit the retained reply, then mark
    // it pending again and make consumers execute twice on one recovery.
    // A same-authority refresh keeps the admitted answer while its re-read runs.
    else if ((loaded.projectionRevision !== projectionRevision || loaded.authorityRevision !== authorityRevision)
        && !(loaded.authorityRevision === authorityRevision && loaded.state.phase === 'ready')) {
        currentState = { ...loaded.state, phase: 'loading', failure: null };
    }
    const freshActionSource = React.useMemo<PluginUiClientExecutableProjectionSource | null>(() => {
        if (!accountLifetime?.isCurrent() || currentState.phase !== 'ready' || !currentState.pluginUiProjection
            || currentState.targetedContributions?.target.pluginId !== pluginId
            || (mountedOccurrenceId && currentState.targetedContributions.target.occurrenceId !== mountedOccurrenceId)) return null;
        return Object.freeze({ projection: currentState.pluginUiProjection,
            ...(machineId ? { directMachineAuthority: Object.freeze({ machineId, serverId: accountLifetime.scope.serverId }) } : {}) });
    }, [accountLifetime, currentState.phase, currentState.pluginUiProjection, currentState.targetedContributions,
        machineId, mountedOccurrenceId, pluginId]);
    // The admission AppShell activated stays while this same mount rereads it: an invalidation that
    // answers with the same executable facts is not a change, so it neither withdraws (retiring and
    // re-evaluating the plugin's executables) nor republishes. A failed read, another target, Account
    // or occurrence, an unmount or different facts still replace or withdraw it.
    const admittedActionSource = React.useRef<Readonly<{ targetKey: string; occurrenceId: string; accountLifetime: typeof accountLifetime;
        source: PluginUiClientExecutableProjectionSource }> | null>(null);
    const held = admittedActionSource.current;
    const heldForThisMount = held !== null && held.targetKey === targetKey && held.occurrenceId === mountedOccurrenceId && held.accountLifetime === accountLifetime
        && accountLifetime?.isCurrent() === true ? held.source : null;
    const mountedActionSource = heldForThisMount === null ? freshActionSource
        : freshActionSource === null ? (currentState.phase === 'loading' ? heldForThisMount : null)
        : sameMountedActionFacts(heldForThisMount, freshActionSource) ? heldForThisMount : freshActionSource;
    React.useLayoutEffect(() => {
        admittedActionSource.current = mountedActionSource ? { targetKey, occurrenceId: mountedOccurrenceId, accountLifetime, source: mountedActionSource } : null;
    }, [accountLifetime, mountedActionSource, mountedOccurrenceId, targetKey]);
    useMountedClientActionDemand(accountLifetime, mountedActionSource);
    return currentState;
}
