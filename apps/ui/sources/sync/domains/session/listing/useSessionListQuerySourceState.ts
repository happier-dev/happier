import * as React from 'react';
import { featureRequiresServerSnapshot, type FeatureId } from '@happier-dev/protocol/features/catalog';
import type { SessionListQueryV1 } from '@happier-dev/protocol/sessions/listing/query';

import {
    useMachineListByServerId,
    useMachineListStatusByServerId,
    useOrdinarySessionListMembershipByServerId,
    useSessionListQueryMembershipByKey,
    useSessionListRowsByServerId,
    useSetting,
    useSocketStatus,
    storage,
} from '@/sync/domains/state/storage';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { buildMachineDisplaysByIdFromMachineList, buildSessionListIndexWithServerScope } from '@/sync/store/sessionListIndex/buildSessionListIndexWithServerScope';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import type { SessionListRenderableSession } from './sessionListRenderable';
import type { SessionAddress } from '../sessionAddress';
import {
    resolveRuntimeFeatureDecisionFromSnapshot,
    useServerFeaturesMainSelectionSnapshot,
    type ServerFeaturesMainSelectionSnapshot,
} from '@/sync/domains/features/featureDecisionRuntime';
import type { FeatureLocalPolicySettings } from '@/sync/domains/features/featureLocalPolicy';
import { useFeatureLocalPolicySettings } from '@/hooks/server/useFeatureLocalPolicySettings';
import {
    useServerCredentialAccountScopes,
    type ServerCredentialAccountScopeBinding,
} from '@/sync/domains/scope/useServerCredentialAccountScopes';

import {
    createSessionListQueryHomeController,
    type SessionListOrdinaryPageAdapter,
    type SessionListQueryHomeController,
    type SessionListQueryHomeState,
    type SessionListQueryMembership,
} from './sessionListQueryController';
import {
    fetchSessionListQueryPageForHome,
    getSessionListQueryHomeAvailability,
    loadNextOrdinarySessionListPage,
    readOrdinarySessionListHomeState,
    refreshOrdinarySessionList,
    resolveOrdinarySessionListHomeOwner,
    retrySessionListQueryHome,
} from './sessionListQueryRuntime';
import { buildSessionListQueryKey } from './sessionListQueryKey';
import { subscribeSessionListQueryHomeInvalidation } from './sessionListQueryInvalidation';
import { isSessionListQueryHomeCoverageComplete } from './sessionListHomeObservation';

export type SessionListQueryHomeInput = Readonly<{
    serverId: string;
    /**
     * Derived corpus identity. Callers may pass the value produced by
     * `buildSessionListQueryKey`, but this hook always re-derives it from
     * `{serverId, query}` so no caller can supply a contradictory identity.
     */
    queryKey?: string;
    query: SessionListQueryV1;
    /**
     * Mounted Sessions corpora use `query`. Independent secondary consumers
     * use `rowOnly` to hydrate the shared exact-Home rows without publishing a
     * competing mounted-filter membership.
     */
    queryMembership?: 'query' | 'rowOnly';
    /**
     * Released GET adapter for this corpus, used when the Home cannot serve the
     * strict query. Ordinary/archived GET and the strict query are request adapters
     * over this one per-Home pagination owner.
     */
    ordinaryAdapter?: SessionListOrdinaryPageAdapter | null;
}>;

/** The query corpora's lifecycle without their rows: what a membership-only consumer reads. */
export type SessionListQueryHomeStatesState = Readonly<{
    statesByServerId: Readonly<Record<string, SessionListQueryHomeState | undefined>>;
    /**
     * The shared membership projection each list surface renders: the applied page while one
     * answers, otherwise the store's last-known membership for this exact Account/Home/query
     * (`null` when neither exists). Last-known membership never makes `coverageComplete` true.
     */
    membershipByServerId: Readonly<Record<string, readonly SessionAddress[] | null>>;
    coverageComplete: boolean;
    loadNext(): Promise<void>;
    refresh(): Promise<void>;
}>;

export type SessionListQuerySourceState = Readonly<{
    statesByServerId: Readonly<Record<string, SessionListQueryHomeState | undefined>>;
    byServerId: Readonly<Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined>>;
    source: ReadonlyArray<SessionListIndexItem> | null;
    coverageComplete: boolean;
    loadNext(): Promise<void>;
    refresh(): Promise<void>;
}>;

/**
 * A zero-Home query is authoritative only when the mounted filter owner has
 * already observed Homes and proved that none can match the qualified facets.
 * Startup before Home discovery is the same array shape but is not an empty
 * result, so it must stay incomplete.
 */
export function resolveEmptySessionListQueryCoverage(input: Readonly<{
    enabled: boolean;
    homeCount: number;
    emptySelectionComplete: boolean;
}>): boolean {
    return input.enabled && input.homeCount === 0 && input.emptySelectionComplete;
}

/**
 * One Home's filtered-listing admission, decided by the canonical feature owner
 * for that exact Home rather than by a Sessions-local bit read or an aggregate
 * over the whole selection.
 *
 * `null` means undecided — the Home has not answered yet — and is never a denial:
 * the controller waits instead of failing a capable Home closed. Everything else
 * fails closed, so a missing or malformed server bit disables the query.
 */
export function resolveSessionListFeatureHomeSupport(
    featureId: FeatureId,
    featureSnapshots: ServerFeaturesMainSelectionSnapshot,
    serverId: string,
    enabled: boolean,
    settings: FeatureLocalPolicySettings,
): boolean | null {
    if (!enabled) return null;
    const snapshot = featureSnapshots.snapshotsByServerId[serverId];
    if (!snapshot && featureRequiresServerSnapshot(featureId)) return null;
    const decision = resolveRuntimeFeatureDecisionFromSnapshot({
        featureId,
        settings,
        // Client-represented features are decided by build/local policy and do
        // not need a Home response. The resolver ignores this placeholder for
        // those features; server-represented features returned above instead.
        snapshot: snapshot ?? { status: 'unsupported', reason: 'endpoint_missing' },
        scope: { scopeKind: 'spawn', serverId },
    });
    if (!decision) return null;
    if (decision.state === 'enabled') return true;
    return decision.state === 'unknown' ? null : false;
}

export function resolveSessionListQueryHomeSupport(
    featureSnapshots: ServerFeaturesMainSelectionSnapshot,
    serverId: string,
    enabled: boolean,
    settings: FeatureLocalPolicySettings,
): boolean | null {
    return resolveSessionListFeatureHomeSupport(
        'sessions.filteredListing',
        featureSnapshots,
        serverId,
        enabled,
        settings,
    );
}

/**
 * Composes the endpoint decision with an optional scope-specific decision for
 * one exact Home. `undefined` means the active scope has no additional feature
 * requirement; `null` remains undecided so the controller waits and retries
 * when the canonical feature projection changes.
 */
export function resolveSessionListQueryHomeAdmissionSupport(
    filteredListingSupport: boolean | null | undefined,
    scopeFeatureSupport: boolean | null | undefined,
): boolean | null {
    if (filteredListingSupport === false || scopeFeatureSupport === false) return false;
    if (filteredListingSupport !== true) return null;
    if (scopeFeatureSupport === undefined) return true;
    return scopeFeatureSupport === true ? true : null;
}

type NormalizedQueryHome = Readonly<{
    serverId: string;
    queryKey: string;
    query: SessionListQueryV1;
    queryMembership: 'query' | 'rowOnly';
    ordinaryAdapter: SessionListOrdinaryPageAdapter | null;
}>;

/**
 * Per-Home filtered-listing admission.
 *
 * Support is decided once per exact Home through the canonical feature owner. An
 * aggregate decision over the whole selection is never an admission gate: it would
 * let one loading, disabled or unsupported Home suppress a capable one.
 */
export function useSessionListFeatureHomeSupportByServerId(
    featureId: FeatureId,
    serverIds: readonly string[],
    enabled: boolean,
): Readonly<Record<string, boolean | null>> {
    const normalizedServerIds = React.useMemo(
        () => [...new Set(serverIds.map((serverId) => serverId.trim()).filter(Boolean))],
        [serverIds],
    );
    const featureSnapshots = useServerFeaturesMainSelectionSnapshot(normalizedServerIds, {
        enabled: enabled && featureRequiresServerSnapshot(featureId),
    });
    const localPolicySettings = useFeatureLocalPolicySettings();
    return React.useMemo(() => {
        const supportByServerId: Record<string, boolean | null> = {};
        for (const serverId of normalizedServerIds) {
            supportByServerId[serverId] = resolveSessionListFeatureHomeSupport(
                featureId,
                featureSnapshots,
                serverId,
                enabled,
                localPolicySettings,
            );
        }
        return supportByServerId;
    }, [enabled, featureId, featureSnapshots, localPolicySettings, normalizedServerIds]);
}

export function useSessionListQueryHomeSupportByServerId(
    serverIds: readonly string[],
    enabled: boolean,
): Readonly<Record<string, boolean | null>> {
    return useSessionListFeatureHomeSupportByServerId('sessions.filteredListing', serverIds, enabled);
}

function normalizeHomes(homes: readonly SessionListQueryHomeInput[]): NormalizedQueryHome[] {
    const normalized: NormalizedQueryHome[] = [];
    const seen = new Set<string>();
    for (const home of homes) {
        const serverId = home.serverId.trim();
        if (!serverId || seen.has(serverId)) continue;
        seen.add(serverId);
        normalized.push({
            serverId,
            query: home.query,
            queryKey: buildSessionListQueryKey(serverId, home.query),
            queryMembership: home.queryMembership ?? 'query',
            ordinaryAdapter: home.ordinaryAdapter ?? null,
        });
    }
    return normalized;
}

export function buildSessionListQueryHomeIndex(input: Readonly<{
    addresses: readonly SessionAddress[];
    rowsBySessionId: Readonly<Record<string, SessionListRenderableSession | undefined>> | null | undefined;
    machines: ReturnType<typeof buildMachineDisplaysByIdFromMachineList>;
    activeGroupingV1?: 'project' | 'date';
    inactiveGroupingV1?: 'project' | 'date';
    sectionModeV1?: 'activity' | 'single';
    serverId: string;
    serverName: string | null;
    /** The last index built for this Home: unchanged items (and the array itself) are reused. */
    previousIndex?: ReadonlyArray<SessionListIndexItem> | null;
}>): SessionListIndexItem[] {
    const rows: Record<string, SessionListRenderableSession> = {};
    for (const address of input.addresses) {
        const row = input.rowsBySessionId?.[address.sessionId];
        if (row) rows[address.sessionId] = row;
    }
    const index = buildSessionListIndexWithServerScope({
        sessions: rows,
        machines: input.machines,
        activeGroupingV1: input.activeGroupingV1,
        inactiveGroupingV1: input.inactiveGroupingV1,
        sectionModeV1: input.sectionModeV1,
        previousIndex: input.previousIndex ?? null,
        serverScope: {
            serverId: input.serverId,
            serverName: input.serverName,
        },
    });
    const missingAddresses = input.addresses.filter((address) => !input.rowsBySessionId?.[address.sessionId]);
    if (missingAddresses.length === 0) return index;
    // Rows not hydrated yet render as loading placeholders; reuse the previous placeholder objects.
    const previousLoadingBySessionId = new Map(
        (input.previousIndex ?? []).flatMap((item) => (
            item.type === 'session' && item.groupKind === 'loading' ? [[item.sessionId, item] as const] : []
        )),
    );
    const next: SessionListIndexItem[] = [...index];
    for (const address of missingAddresses) {
        const previous = previousLoadingBySessionId.get(address.sessionId);
        next.push(previous && previous.type === 'session' && previous.serverId === address.serverId
            ? previous
            : {
                type: 'session',
                serverId: address.serverId,
                ...(input.serverName ? { serverName: input.serverName } : {}),
                sessionId: address.sessionId,
                section: 'active',
                groupKind: 'loading',
            });
    }
    const previousIndex = input.previousIndex;
    return previousIndex && previousIndex.length === next.length && previousIndex.every((item, i) => item === next[i])
        ? previousIndex as SessionListIndexItem[]
        : next;
}

/**
 * The exact per-Home completeness predicate. Retained rows may render during any
 * partial state, but only this predicate can turn a zero-row result into an
 * authoritative empty one.
 */
type SessionListQueryInput = Readonly<{
    enabled: boolean;
    homes: readonly SessionListQueryHomeInput[];
    emptySelectionComplete?: boolean;
}>;

type SessionListQueryHomeStatus = 'ready' | 'unsupported' | 'pending';

/**
 * What a Home renders. `current` is the applied page; `retained` is the last-known
 * membership for this exact Account/Home/query while no page can answer (a new
 * controller, an unreachable Home, a transport hand-over). Retained rows never claim
 * coverage: the Home stays pending until an authoritative page lands.
 */
type SessionListQueryRenderMembership = Readonly<{
    addresses: readonly SessionAddress[];
    retained: boolean;
}>;

/** The state layer plus what the index layer needs to place each Home's rows. */
type SessionListQueryHomeStatesLayer = SessionListQueryHomeStatesState & Readonly<{
    homes: readonly NormalizedQueryHome[];
    statusByServerId: Readonly<Record<string, SessionListQueryHomeStatus>>;
    renderMembershipByServerId: Readonly<Record<string, SessionListQueryRenderMembership | null>>;
    hasReadySource: boolean;
    hasPendingSource: boolean;
}>;

const retainedAddressesByMembership = new WeakMap<SessionListQueryMembership, readonly SessionAddress[]>();

function readRetainedAddresses(membership: SessionListQueryMembership): readonly SessionAddress[] {
    const cached = retainedAddressesByMembership.get(membership);
    if (cached) return cached;
    const addresses = membership.sessionIds.map((sessionId) => ({ serverId: membership.serverId, sessionId }));
    retainedAddressesByMembership.set(membership, addresses);
    return addresses;
}

/**
 * The query corpora's lifecycle: controllers, per-Home state, coverage, paging and refresh. It reads
 * no rows, machines or list settings, so a consumer that needs only membership (which Sessions are in
 * a corpus) is not re-rendered by session content changes.
 */
export function useSessionListQueryHomeStates(input: SessionListQueryInput): SessionListQueryHomeStatesState {
    const layer = useSessionListQueryHomeStatesLayer(input);
    const { statesByServerId, membershipByServerId, coverageComplete, loadNext, refresh } = layer;
    return React.useMemo(() => ({ statesByServerId, membershipByServerId, coverageComplete, loadNext, refresh }), [
        coverageComplete,
        loadNext,
        membershipByServerId,
        refresh,
        statesByServerId,
    ]);
}

function useSessionListQueryHomeStatesLayer(input: SessionListQueryInput): SessionListQueryHomeStatesLayer {
    const homes = React.useMemo(() => normalizeHomes(input.homes), [input.homes]);
    const homeServerIds = React.useMemo(() => homes.map((home) => home.serverId), [homes]);
    const supportByServerId = useSessionListQueryHomeSupportByServerId(homeServerIds, input.enabled);
    const followingHomeServerIds = React.useMemo(
        () => homes.filter((home) => home.query.scope === 'following').map((home) => home.serverId),
        [homes],
    );
    const followingSupportByServerId = useSessionListFeatureHomeSupportByServerId(
        'sessions.following',
        followingHomeServerIds,
        input.enabled && followingHomeServerIds.length > 0,
    );
    const ordinaryMembershipByServerId = useOrdinarySessionListMembershipByServerId();
    const queryMembershipByKey = useSessionListQueryMembershipByKey();
    const machineStatusesByServerId = useMachineListStatusByServerId();
    const socketStatus = useSocketStatus();
    const accountScopesByServerId = useServerCredentialAccountScopes(homeServerIds);
    // Homes whose ordinary corpus an incumbent runtime already owns — Sync for the
    // applied Home, the concurrent cache for every other managed Home. Their
    // bootstrap/reconnect replace, append continuation and cursors are the only
    // ones for `/v2/sessions` on that Home, so the filter reads that frontier here
    // instead of mounting a controller that would paginate and replace the same
    // membership — two owners that could orphan each other's pages.
    const managedOrdinaryHomeKey = homes
        .filter((home) => (
            home.ordinaryAdapter?.membership === 'ordinary'
            && supportByServerId[home.serverId] === false
            && resolveOrdinarySessionListHomeOwner(home.serverId) !== null
        ))
        .map((home) => home.serverId)
        .join('\u0000');
    const managedOrdinaryHomes = React.useMemo(
        () => new Set(managedOrdinaryHomeKey ? managedOrdinaryHomeKey.split('\u0000') : []),
        [managedOrdinaryHomeKey],
    );
    const controllersRef = React.useRef(new Map<string, SessionListQueryHomeController>());
    const controllerAccountScopesRef = React.useRef(new Map<string, ServerCredentialAccountScopeBinding>());
    const controllerRetirementsRef = React.useRef(new Map<string, Readonly<{ dispose(): void }>>());
    const [controllerRevision, forceRender] = React.useReducer((value) => value + 1, 0);
    const disposeController = React.useCallback((
        serverId: string,
        expected?: SessionListQueryHomeController,
    ): boolean => {
        const controller = controllersRef.current.get(serverId);
        if (!controller || (expected && controller !== expected)) return false;
        controllerRetirementsRef.current.get(serverId)?.dispose();
        controllerRetirementsRef.current.delete(serverId);
        controllerAccountScopesRef.current.delete(serverId);
        controllersRef.current.delete(serverId);
        controller.dispose();
        return true;
    }, []);

    React.useLayoutEffect(() => {
        // Controllers, their cursors, and their in-flight requests belong to the
        // committed mounted selection and exact credential/Account lifetime.
        // Never reconcile this map during render:
        // React may abandon a concurrent render after it has observed different
        // Homes, and that render must not dispose the still-committed controllers.
        const selectedServerIds = new Set(homes.flatMap((home) => {
            if (managedOrdinaryHomes.has(home.serverId)) return [];
            const binding = accountScopesByServerId.get(home.serverId);
            return binding?.isCurrent() === true ? [home.serverId] : [];
        }));
        let membershipChanged = false;
        for (const [serverId, controller] of [...controllersRef.current]) {
            const binding = accountScopesByServerId.get(serverId);
            if (
                selectedServerIds.has(serverId)
                && binding
                && controllerAccountScopesRef.current.get(serverId) === binding
            ) continue;
            membershipChanged = disposeController(serverId, controller) || membershipChanged;
        }
        const selectedControllers: SessionListQueryHomeController[] = [];
        for (const home of homes) {
            if (managedOrdinaryHomes.has(home.serverId)) continue;
            const binding = accountScopesByServerId.get(home.serverId);
            if (!binding?.isCurrent()) continue;
            let controller = controllersRef.current.get(home.serverId);
            if (!controller) {
                const accountId = binding.accountId;
                controller = createSessionListQueryHomeController({
                    serverId: home.serverId,
                    fetchPage: (page) => fetchSessionListQueryPageForHome(home.serverId, page),
                    // The store owns what the list shows; the controller commits each
                    // applied page under the exact Account it was read for.
                    commitMembership: (queryKey, sessionIds) => storage.getState().commitSessionListQueryMembership(
                        queryKey,
                        sessionIds ? { serverId: home.serverId, accountId, sessionIds } : null,
                    ),
                });
                controllersRef.current.set(home.serverId, controller);
                controllerAccountScopesRef.current.set(home.serverId, binding);
                const retirement = binding.onRetire(() => {
                    if (disposeController(home.serverId, controller)) forceRender();
                });
                if (!binding.isCurrent() || controllersRef.current.get(home.serverId) !== controller) {
                    retirement.dispose();
                    disposeController(home.serverId, controller);
                    continue;
                }
                controllerRetirementsRef.current.set(home.serverId, retirement);
                membershipChanged = true;
            }
            selectedControllers.push(controller);
        }
        const unsubscribes = selectedControllers.map((controller) => controller.subscribe(forceRender));
        if (membershipChanged) forceRender();
        return () => {
            for (const unsubscribe of unsubscribes) unsubscribe();
        };
    }, [accountScopesByServerId, disposeController, homes, managedOrdinaryHomes]);

    React.useEffect(() => (
        subscribeSessionListQueryHomeInvalidation(() => controllersRef.current)
    ), []);

    React.useEffect(() => {
        for (const home of homes) {
            const controller = controllersRef.current.get(home.serverId);
            if (!controller) continue;
            const availability = getSessionListQueryHomeAvailability(home.serverId);
            void controller.update({
                query: home.query,
                selected: input.enabled,
                online: availability === 'pending' ? null : availability === 'online',
                supported: resolveSessionListQueryHomeAdmissionSupport(
                    supportByServerId[home.serverId],
                    home.query.scope === 'following'
                        ? (followingSupportByServerId[home.serverId] ?? null)
                        : undefined,
                ),
                queryMembership: home.queryMembership,
                ordinaryAdapter: home.ordinaryAdapter ?? null,
            });
        }
    }, [accountScopesByServerId, followingSupportByServerId, homes, input.enabled, machineStatusesByServerId, socketStatus, supportByServerId]);

    React.useLayoutEffect(() => () => {
        for (const [serverId, controller] of [...controllersRef.current]) {
            disposeController(serverId, controller);
        }
    }, [disposeController]);

    const readHomeState = React.useCallback((home: NormalizedQueryHome): SessionListQueryHomeState | undefined => {
        if (!managedOrdinaryHomes.has(home.serverId)) {
            return controllersRef.current.get(home.serverId)?.getSnapshot();
        }
        const availability = getSessionListQueryHomeAvailability(home.serverId);
        return readOrdinarySessionListHomeState({
            serverId: home.serverId,
            requestedQueryKey: home.queryKey,
            online: availability === 'pending' ? null : availability === 'online',
        });
    }, [managedOrdinaryHomes]);
    const loadNext = React.useCallback(async () => {
        await Promise.all(homes.map((home) => (
            managedOrdinaryHomes.has(home.serverId)
                ? loadNextOrdinarySessionListPage(home.serverId)
                : controllersRef.current.get(home.serverId)?.loadNext()
        )));
    }, [homes, managedOrdinaryHomes]);
    const refresh = React.useCallback(async () => {
        const retryableHomes = homes.filter((home) => {
            const state = readHomeState(home);
            return state?.phase === 'offline'
                || (state?.phase === 'error' && state.failureReason === 'network');
        });
        // Re-arm every unavailable Home through its transport owner before
        // asking query controllers for their next page. A failed reconnect is
        // still followed by refresh so the controller remains the one source
        // of query state and error presentation.
        await Promise.allSettled(retryableHomes.map((home) => (
            retrySessionListQueryHome(home.serverId)
        )));
        await Promise.all(homes.map((home) => (
            managedOrdinaryHomes.has(home.serverId)
                ? refreshOrdinarySessionList(home.serverId)
                : controllersRef.current.get(home.serverId)?.refresh()
        )));
    }, [homes, readHomeState, managedOrdinaryHomes]);

    const readRetainedRenderMembership = React.useCallback((
        home: NormalizedQueryHome,
        state: SessionListQueryHomeState | undefined,
    ): SessionListQueryRenderMembership | null => {
        // The incumbent ordinary corpus is already store-owned (warm cache, then Sync or
        // the concurrent cache); only its first snapshot is outstanding.
        if (managedOrdinaryHomes.has(home.serverId)) {
            return state && state.addresses.length > 0 ? { addresses: state.addresses, retained: true } : null;
        }
        const membership = queryMembershipByKey[home.queryKey];
        const binding = accountScopesByServerId.get(home.serverId);
        if (!membership || !binding?.isCurrent() || membership.accountId !== binding.accountId) return null;
        return { addresses: readRetainedAddresses(membership), retained: true };
    }, [accountScopesByServerId, managedOrdinaryHomes, queryMembershipByKey]);

    const previousStatesRef = React.useRef<Readonly<Record<string, SessionListQueryHomeState | undefined>> | null>(null);
    const previousMembershipRef = React.useRef<Readonly<Record<string, readonly SessionAddress[] | null>> | null>(null);
    const layer = React.useMemo(() => {
        const nextStates: Record<string, SessionListQueryHomeState | undefined> = {};
        const statusByServerId: Record<string, SessionListQueryHomeStatus> = {};
        const renderMembershipByServerId: Record<string, SessionListQueryRenderMembership | null> = {};
        let hasReadySource = false;
        let hasPendingSource = false;
        let coverageComplete = true;
        for (const home of homes) {
            const state = readHomeState(home);
            nextStates[home.serverId] = state;
            if (!state || state.appliedQueryKey !== home.queryKey) {
                if (state?.phase === 'error' && state.failureReason === 'unsupported') {
                    statusByServerId[home.serverId] = 'unsupported';
                    hasReadySource = true;
                    coverageComplete = false;
                    continue;
                }
                statusByServerId[home.serverId] = 'pending';
                hasPendingSource = true;
                coverageComplete = false;
                renderMembershipByServerId[home.serverId] = readRetainedRenderMembership(home, state);
                continue;
            }
            statusByServerId[home.serverId] = 'ready';
            renderMembershipByServerId[home.serverId] = { addresses: state.addresses, retained: false };
            hasReadySource = true;
            if (!isSessionListQueryHomeCoverageComplete({
                state,
                requestedQueryKey: home.queryKey,
            })) {
                coverageComplete = false;
            }
        }
        // Keep the record when every Home's state object is the one already published.
        const previousStates = previousStatesRef.current;
        const statesByServerId = previousStates
            && Object.keys(previousStates).length === homes.length
            && homes.every((home) => home.serverId in previousStates && previousStates[home.serverId] === nextStates[home.serverId])
            ? previousStates
            : nextStates;
        const nextMembership: Record<string, readonly SessionAddress[] | null> = {};
        for (const home of homes) nextMembership[home.serverId] = renderMembershipByServerId[home.serverId]?.addresses ?? null;
        const previousMembership = previousMembershipRef.current;
        const membershipByServerId = previousMembership
            && Object.keys(previousMembership).length === homes.length
            && homes.every((home) => home.serverId in previousMembership && previousMembership[home.serverId] === nextMembership[home.serverId])
            ? previousMembership
            : nextMembership;
        return {
            homes,
            statesByServerId,
            membershipByServerId,
            statusByServerId,
            renderMembershipByServerId,
            hasReadySource,
            hasPendingSource,
            coverageComplete: homes.length === 0
                ? resolveEmptySessionListQueryCoverage({
                    enabled: input.enabled,
                    homeCount: homes.length,
                    emptySelectionComplete: input.emptySelectionComplete === true,
                })
                : input.enabled && coverageComplete && !hasPendingSource,
            loadNext,
            refresh,
        };
    }, [
        controllerRevision,
        homes,
        input.enabled,
        input.emptySelectionComplete,
        loadNext,
        machineStatusesByServerId,
        ordinaryMembershipByServerId,
        queryMembershipByKey,
        readHomeState,
        readRetainedRenderMembership,
        refresh,
        socketStatus,
    ]);
    // Remember only what was committed; an abandoned render must not become the reference point.
    React.useLayoutEffect(() => {
        previousStatesRef.current = layer.statesByServerId;
        previousMembershipRef.current = layer.membershipByServerId;
    }, [layer.membershipByServerId, layer.statesByServerId]);
    return layer;
}

const NO_SERVER_IDS: readonly string[] = Object.freeze([]);

/**
 * The query corpora as list indexes: the state layer plus each ready Home's rows placed into the
 * session list index. It follows only the enabled Homes' rows, and a row change that leaves every
 * Home's index structurally equal (a metadata write) publishes the previous indexes and record, so the
 * list and every summary computed from it keep their identity. Row content is rendered by each row
 * from its own subscription, not from this index.
 */
export function useSessionListQuerySourceState(input: SessionListQueryInput): SessionListQuerySourceState {
    const layer = useSessionListQueryHomeStatesLayer(input);
    const homeServerIds = React.useMemo(
        () => (input.enabled ? layer.homes.map((home) => home.serverId) : NO_SERVER_IDS),
        [input.enabled, layer.homes],
    );
    const rowsByServerId = useSessionListRowsByServerId(homeServerIds);
    const machineListsByServerId = useMachineListByServerId();
    const activeGroupingV1 = useSetting('sessionListActiveGroupingV1');
    const inactiveGroupingV1 = useSetting('sessionListInactiveGroupingV1');
    const sectionModeV1 = useSetting('sessionListSectionModeV1');
    const previousRef = React.useRef<Readonly<{
        byServerId: Readonly<Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined>>;
        source: ReadonlyArray<SessionListIndexItem> | null;
        result: SessionListQuerySourceState | null;
    }>>({ byServerId: {}, source: null, result: null });

    const result = React.useMemo(() => {
        const previous = previousRef.current;
        const coverageComplete = layer.coverageComplete && layer.homes.every((home) => (
            isSessionListQueryHomeCoverageComplete({
                state: layer.statesByServerId[home.serverId],
                requestedQueryKey: home.queryKey,
                bot: home.query.bot,
                rowsBySessionId: rowsByServerId[home.serverId] ?? undefined,
            })
        ));
        const nextByServerId: Record<string, ReadonlyArray<SessionListIndexItem> | null | undefined> = {};
        for (const home of layer.homes) {
            const status = layer.statusByServerId[home.serverId];
            if (status === 'unsupported') {
                const previousIndex = previous.byServerId[home.serverId];
                nextByServerId[home.serverId] = Array.isArray(previousIndex) && previousIndex.length === 0 ? previousIndex : [];
                continue;
            }
            const membership = layer.renderMembershipByServerId[home.serverId];
            if (!membership) {
                nextByServerId[home.serverId] = null;
                continue;
            }
            const homeRows = rowsByServerId[home.serverId];
            const previousIndex = previous.byServerId[home.serverId];
            // Retained rows show only what this device still holds; a retained id with
            // no row (retired meanwhile) is not a loading placeholder.
            const addresses = membership.retained
                ? membership.addresses.filter((address) => Boolean(homeRows?.[address.sessionId]))
                : membership.addresses;
            if (membership.retained && addresses.length === 0 && membership.addresses.length > 0) {
                // Last-known ids alone are not an answer: with none of their rows held, this
                // Home is still loading rather than an empty result.
                nextByServerId[home.serverId] = null;
                continue;
            }
            nextByServerId[home.serverId] = buildSessionListQueryHomeIndex({
                addresses,
                rowsBySessionId: rowsByServerId[home.serverId],
                machines: buildMachineDisplaysByIdFromMachineList(machineListsByServerId[home.serverId]),
                activeGroupingV1,
                inactiveGroupingV1,
                sectionModeV1,
                serverId: home.serverId,
                serverName: getServerProfileById(home.serverId)?.name ?? null,
                previousIndex: Array.isArray(previousIndex) ? previousIndex : null,
            });
        }
        const previousByServerId = previous.byServerId;
        const byServerIdUnchanged = Object.keys(previousByServerId).length === layer.homes.length
            && layer.homes.every((home) => (
                home.serverId in previousByServerId && previousByServerId[home.serverId] === nextByServerId[home.serverId]
            ));
        const byServerId = byServerIdUnchanged ? previousByServerId : nextByServerId;
        const hasRenderableSource = layer.hasReadySource
            || layer.homes.some((home) => nextByServerId[home.serverId] != null);
        const source = !input.enabled
            ? null
            : hasRenderableSource
                ? (byServerIdUnchanged && previous.source !== null
                    ? previous.source
                    : layer.homes.flatMap((home) => nextByServerId[home.serverId] ?? []))
                : layer.hasPendingSource ? null : [];
        const previousResult = previous.result;
        if (
            previousResult
            && previousResult.byServerId === byServerId
            && previousResult.source === source
            && previousResult.statesByServerId === layer.statesByServerId
            && previousResult.coverageComplete === coverageComplete
            && previousResult.loadNext === layer.loadNext
            && previousResult.refresh === layer.refresh
        ) {
            return previousResult;
        }
        return {
            statesByServerId: layer.statesByServerId,
            byServerId,
            source,
            coverageComplete,
            loadNext: layer.loadNext,
            refresh: layer.refresh,
        };
    }, [activeGroupingV1, inactiveGroupingV1, input.enabled, layer, machineListsByServerId, rowsByServerId, sectionModeV1]);
    React.useLayoutEffect(() => {
        previousRef.current = { byServerId: result.byServerId, source: result.source, result };
    }, [result]);
    return result;
}
