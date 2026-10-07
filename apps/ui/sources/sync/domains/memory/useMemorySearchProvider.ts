import * as React from 'react';

import { HomeSearchCapabilitiesSchema } from '@happier-dev/protocol/features/payload/capabilities/homeSearchCapabilities';

import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import {
    useServerFeaturesRuntimeSnapshot,
    useServerFeaturesSnapshotForServerId,
} from '@/sync/domains/features/featureDecisionRuntime';
import {
    areServerProfileIdentifiersEquivalent,
    resolveServerProfileScopeIdForIdentifier,
} from '@/sync/domains/server/serverProfiles';

import {
    resolveDaemonMemorySearchTarget,
    useDaemonMemorySearchTargetSelection,
    type DaemonMemorySearchTargetV1,
} from './resolveDaemonMemorySearchTarget';

export type MemorySearchProviderId = 'home' | 'daemon';

export type MemorySearchProviderTarget =
    | Readonly<{ kind: 'ambient' }>
    | Readonly<{ kind: 'none' }>
    | Readonly<{ kind: 'exact'; serverId: string; machineId?: string | null }>;

/**
 * Readiness of the Personal Home search index according to the optional server
 * `capabilities.homeSearch` advertisement. `unknown` covers missing (older
 * server) and malformed advertisements; the typed route result remains the
 * authority for actual request outcomes.
 */
export type HomeMemorySearchReadiness = 'ready' | 'indexing' | 'unavailable' | 'unknown';

/**
 * Why a query cannot be issued right now. It is a diagnostic for the section-local
 * state a consumer renders, never a wire enum.
 */
export type MemorySearchUnavailableReason =
    | 'home_indexing'
    | 'home_unavailable'
    | 'home_unknown'
    | 'daemon_no_target';

export type MemorySearchProvider = Readonly<{
    /** `null` when neither transcript provider is admitted for the current context. */
    provider: MemorySearchProviderId | null;
    /** Exact Home target for a `home` provider decision; requests and results key to it. */
    homeServerId: string | null;
    homeReadiness: HomeMemorySearchReadiness | null;
    /**
     * Exact daemon request target for a `daemon` decision: the explicitly selected
     * usable machine and the server scope that routes to it. `null` means no usable
     * explicit target, never an arbitrary first machine.
     */
    daemonTarget: DaemonMemorySearchTargetV1 | null;
    /** The only authorization to issue a transcript request for this context. */
    queryAvailable: boolean;
    unavailableReason: MemorySearchUnavailableReason | null;
}>;

const NO_MEMORY_SEARCH_PROVIDER: MemorySearchProvider = Object.freeze({
    provider: null,
    homeServerId: null,
    homeReadiness: null,
    daemonTarget: null,
    queryAvailable: false,
    unavailableReason: null,
});

function resolveHomeUnavailableReason(
    readiness: HomeMemorySearchReadiness,
): MemorySearchUnavailableReason | null {
    if (readiness === 'indexing') return 'home_indexing';
    if (readiness === 'unavailable') return 'home_unavailable';
    if (readiness === 'unknown') return 'home_unknown';
    return null;
}

export function resolveHomeMemorySearchReadiness(capability: unknown): HomeMemorySearchReadiness {
    const parsed = HomeSearchCapabilitiesSchema.safeParse(capability);
    if (!parsed.success) return 'unknown';
    if (parsed.data.reason === 'indexing') return 'indexing';
    if (parsed.data.reason === 'index_unavailable') return 'unavailable';
    if (parsed.data.enabled) return 'ready';
    return 'unknown';
}

/**
 * One exclusive, contextual transcript-provider decision shared by every search
 * consumer. Home plaintext search is admitted by the server-represented `search`
 * feature plus the Home's own readiness capability; daemon-local memory search is
 * admitted by `memory.search` plus the explicitly selected usable machine. The
 * capability is diagnostic only — it never authorizes a provider on its own — and
 * the two providers are never queried together for one target.
 *
 * `provider` names the admitted source kind; `queryAvailable` is the only
 * authorization to issue a request. A Home that is admitted but still indexing, or
 * a daemon with no explicitly selected usable machine, therefore keeps its truthful
 * `unavailableReason` instead of silently querying the other source.
 */
export function useMemorySearchProvider(
    target: MemorySearchProviderTarget = { kind: 'ambient' },
    options: Readonly<{ enabled?: boolean }> = {},
): MemorySearchProvider {
    const enabled = options.enabled !== false;
    const activeServer = useActiveServerSnapshot();
    const requestedServerId = target.kind === 'exact'
        ? resolveServerProfileScopeIdForIdentifier(target.serverId)
        : '';
    const isAmbient = target.kind === 'ambient';
    const isExplicitNone = target.kind === 'none' || (target.kind === 'exact' && !requestedServerId);
    // The Home decision reads the same runtime (focused-Home) snapshot as the
    // capability below, so feature and readiness always describe one Home.
    const homeSearchFeatureEnabled = useFeatureEnabled('search', requestedServerId
        ? { scopeKind: 'spawn', serverId: requestedServerId }
        : { scopeKind: 'runtime' });
    const daemonMemorySearchEnabled = useFeatureEnabled('memory.search');
    // This fetch must be independent of profile provenance: its result is the
    // authority used to choose the provider.
    const featuresSnapshot = useServerFeaturesRuntimeSnapshot({ enabled: true });
    const scopedFeaturesSnapshot = useServerFeaturesSnapshotForServerId(requestedServerId, {
        enabled: requestedServerId.length > 0,
    });
    const activeServerId = requestedServerId || (isAmbient
        ? resolveServerProfileScopeIdForIdentifier(activeServer.serverId)
        : '');
    // Daemon memory search targets the explicitly selected usable machine, never an
    // arbitrary first machine and never an automatic all-machine fanout.
    const daemonTargetEnabled = enabled && daemonMemorySearchEnabled && !isExplicitNone;
    const daemonTargetSelection = useDaemonMemorySearchTargetSelection(daemonTargetEnabled);
    const daemonTarget = daemonTargetEnabled
        ? requestedServerId
            ? target.kind === 'exact' && target.machineId
                ? resolveDaemonMemorySearchTarget(
                    daemonTargetSelection,
                    { serverId: requestedServerId, machineId: target.machineId },
                )
                : (() => {
                    const selected = resolveDaemonMemorySearchTarget(daemonTargetSelection);
                    return selected && areServerProfileIdentifiersEquivalent(selected.serverId, requestedServerId)
                        ? selected
                        : null;
                })()
            : resolveDaemonMemorySearchTarget(daemonTargetSelection)
        : null;
    const daemonServerId = daemonTarget?.serverId ?? null;
    const daemonMachineId = daemonTarget?.machineId ?? null;

    return React.useMemo(() => {
        if (!enabled || isExplicitNone) return NO_MEMORY_SEARCH_PROVIDER;
        const effectiveFeaturesSnapshot = requestedServerId ? scopedFeaturesSnapshot : featuresSnapshot;
        const capability = effectiveFeaturesSnapshot.status === 'ready'
            ? effectiveFeaturesSnapshot.features.capabilities.homeSearch
            : undefined;
        const nextDaemonTarget = requestedServerId
            ? daemonServerId && daemonMachineId
                ? { serverId: daemonServerId, machineId: daemonMachineId }
                : null
            : daemonServerId && daemonMachineId
                ? { serverId: daemonServerId, machineId: daemonMachineId }
                : null;
        const resolvedHomeReadiness = resolveHomeMemorySearchReadiness(capability);
        const homeCandidate = homeSearchFeatureEnabled && activeServerId.length > 0;
        const homeAdmitted = homeCandidate && resolvedHomeReadiness !== 'unknown';
        const homeReadiness = homeCandidate ? resolvedHomeReadiness : null;
        const readyHome: MemorySearchProvider = {
            provider: 'home',
            homeServerId: activeServerId,
            homeReadiness,
            daemonTarget: null,
            queryAvailable: homeReadiness === 'ready',
            unavailableReason: homeReadiness === null ? null : resolveHomeUnavailableReason(homeReadiness),
        };
        // 1. An admitted, ready Home owns the context outright.
        if (homeAdmitted && homeReadiness === 'ready') return readyHome;
        // 2. Otherwise the daemon, and only with an explicitly selected usable machine.
        if (daemonMemorySearchEnabled && nextDaemonTarget) {
            return {
                provider: 'daemon',
                homeServerId: null,
                homeReadiness: null,
                daemonTarget: nextDaemonTarget,
                queryAvailable: true,
                unavailableReason: null,
            };
        }
        // 3. Otherwise the truthful section-local state of whichever source is admitted.
        if (homeCandidate) return readyHome;
        if (daemonMemorySearchEnabled) {
            return {
                provider: 'daemon',
                homeServerId: null,
                homeReadiness: null,
                daemonTarget: null,
                queryAvailable: false,
                unavailableReason: 'daemon_no_target',
            };
        }
        return NO_MEMORY_SEARCH_PROVIDER;
    }, [
        enabled,
        activeServerId,
        daemonMachineId,
        daemonMemorySearchEnabled,
        daemonServerId,
        featuresSnapshot,
        homeSearchFeatureEnabled,
        isExplicitNone,
        requestedServerId,
        scopedFeaturesSnapshot,
    ]);
}
