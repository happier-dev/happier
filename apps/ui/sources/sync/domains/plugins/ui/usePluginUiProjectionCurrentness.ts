import * as React from 'react';
import { getPreferredLanguage } from '@/text';

import {
    createInstalledPluginUiReactNativeRuntimeProjectionSource,
    type PluginUiReactNativeRuntimeProjectionSource,
} from '@/components/plugins/reactNative/projectionInvalidation';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import {
    EMPTY_PLUGIN_BROWSER_PROJECTION,
    resolvePluginBrowserProjectionState,
    type PluginBrowserProjectionModel,
} from '@/sync/domains/plugins/browser/targets';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    resolvePluginUiProjectionPlatform,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import {
    pluginUiProjectionAdmissionTargetKey,
    readPluginUiProjectionAdmissionSnapshot,
} from '@/sync/domains/plugins/ui/projectionWarmCache';
import {
    getMachineContributionRegistryProjectionRevision,
    subscribeMachineContributionRegistryProjectionInvalidation,
    type MachineContributionRegistryProjectionFailureReason,
} from '@/sync/ops/machineContributionRegistryProjection';
import { loadDaemonMergedProjectionCacheEntry, readDaemonMergedProjectionRetryDelayMs } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import {
    useEndpointStatus,
    useSetting,
} from '@/sync/domains/state/storage';
import { useMachinePresenceSummary } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import {
    captureActiveServerAccountScopeLifetime,
    getActiveServerAccountScope,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import {
    getAppliedActiveServerId,
    subscribeAppliedActiveServer,
} from '@/sync/runtime/orchestration/appliedActiveServerRuntime';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import {
    type ConnectedAccountDescriptorMachineProjection,
} from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';

const CONNECTED_ACCOUNT_PROJECTION_TRANSPORT_ERROR = Object.freeze({
    kind: 'error' as const,
    reason: 'transport' as const,
});
// Setup reads credential descriptors and exactly one purpose declaration across
// Resources, Actions and provisioners. It does not present plugin UI, browser
// destinations or input widgets; those families must not delay this admission.
const PLUGIN_UI_PURPOSE_SECTIONS = ['familiesById.connectedAccounts', 'resourcesById',
    'actionsById', 'familiesById.machineProvisioners'] as const;
const CONNECTED_ACCOUNT_PROJECTION_UNSUPPORTED = Object.freeze({
    kind: 'error' as const,
    reason: 'unsupported' as const,
});

/**
 * A projection's explicit consumer-facing establishment state. Consumers must
 * branch on this owner-provided fact rather than treating an empty model or a
 * disabled interaction channel as an unavailable destination.
 */
export type PluginUiProjectionPhase =
    | 'establishing'
    | 'current'
    | 'retainedOffline'
    | 'unavailable';

type LoadedProjectionState = Readonly<{
    targetKey: string | null;
    /**
     * The opaque Account lifetime which admitted this snapshot. Keeping the
     * lifetime by identity prevents an identical server/machine/generation
     * projection from crossing an Account switch without copying Account data
     * into a projection key or creating a second epoch.
     */
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    authorityKey: string | null;
    failureReason?: MachineContributionRegistryProjectionFailureReason;
    /**
     * A failed refresh never proves absence. When the describe for this
     * authority failed over a snapshot this process already confirmed, that
     * snapshot stays admitted (and interactive while the machine is online)
     * under this key while retries continue. Only offline presence, a
     * daemon-answered `unsupported`, or Account retirement withdraw it.
     */
    failedRefreshAuthorityKey?: string;
    /**
     * `retainedOffline` is derived, never stored: a `current` snapshot with no
     * live authority is retained-offline whether it was confirmed earlier in
     * this process or restored from this Account's device custody.
     */
    phase: Exclude<PluginUiProjectionPhase, 'retainedOffline'>;
    pluginUiProjection: PluginUiProjectionModel;
    pluginBrowserProjection: PluginBrowserProjectionModel;
    connectedAccountProjection: ConnectedAccountDescriptorMachineProjection | null;
}>;

export type PluginUiProjectionCurrentness = Readonly<{
    pluginUiProjection: PluginUiProjectionModel | null;
    pluginBrowserProjection: PluginBrowserProjectionModel | null;
    phase: PluginUiProjectionPhase;
    /** Owner-provided cause; consumers do not infer reachability from an empty catalog. */
    unavailableReasonCode?: string;
    interactionEnabled: boolean;
    machineId: string | null;
    serverId: string | null;
    platform: LocalServicePreviewPlatform;
    /** The same opaque credential lifetime which admitted this projection. */
    accountLifetime: ServerAccountScopeLifetime | null;
    /** Present on machine-owned reports; aggregate surface projections have no descriptor authority. */
    connectedAccountProjection?: ConnectedAccountDescriptorMachineProjection | null;
}>;

/**
 * The host platform every projection currentness reports. Re-exported because
 * the app-scope union has no single machine hook to read it from, and a second
 * `Platform.OS` mapping beside the projection owner's would be exactly the
 * split-brain §8 forbids.
 */
export { resolvePluginUiProjectionPlatform };

export { resolvePluginUiClientExecutablePlatform } from './projection';

function createEmptyLoadedProjectionState(
    targetKey: string | null,
    accountLifetime: ActiveServerAccountScopeLifetime | null,
): LoadedProjectionState {
    return {
        targetKey,
        accountLifetime,
        authorityKey: null,
        phase: targetKey ? 'establishing' : 'unavailable',
        pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION,
        pluginBrowserProjection: EMPTY_PLUGIN_BROWSER_PROJECTION,
        connectedAccountProjection: null,
    };
}

/**
 * A fresh process with no reachable daemon has no in-process snapshot to
 * retain, so it restores this Account's last-confirmed admission snapshot from
 * device custody and presents it read-only while the live describe establishes
 * current authority. The retained slice contains presentation contributions
 * only, and the phase gate keeps interaction disabled until that describe
 * settles, so a warm launch does not need to hide a catalog it already proved.
 */
function createRestoredLoadedProjectionState(input: Readonly<{
    targetKey: string;
    machineId: string;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    platform: LocalServicePreviewPlatform;
}>): LoadedProjectionState {
    const restored = input.accountLifetime && input.accountLifetime.isCurrent()
        ? readPluginUiProjectionAdmissionSnapshot({
            scope: input.accountLifetime.scope,
            targetKey: input.targetKey,
            machineId: input.machineId,
            platform: input.platform,
        })
        : null;
    if (!restored) return createEmptyLoadedProjectionState(input.targetKey, input.accountLifetime);
    return {
        targetKey: input.targetKey,
        accountLifetime: input.accountLifetime,
        authorityKey: null,
        phase: 'current',
        pluginUiProjection: restored,
        pluginBrowserProjection: EMPTY_PLUGIN_BROWSER_PROJECTION,
        connectedAccountProjection: null,
    };
}

function createUnavailableLoadedProjectionState(
    targetKey: string,
    accountLifetime: ActiveServerAccountScopeLifetime | null,
): LoadedProjectionState {
    return {
        targetKey,
        accountLifetime,
        authorityKey: null,
        phase: 'unavailable',
        pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION,
        pluginBrowserProjection: EMPTY_PLUGIN_BROWSER_PROJECTION,
        connectedAccountProjection: CONNECTED_ACCOUNT_PROJECTION_UNSUPPORTED,
    };
}

function isAccountLifetimeCurrent(
    accountLifetime: ActiveServerAccountScopeLifetime | null,
): boolean {
    // Legacy/no-Account UI states have no Account-scoped projection to retire.
    // Once a lifetime is captured, its currentness is mandatory for every
    // projection cache entry and late RPC settlement.
    return accountLifetime?.isCurrent() ?? true;
}

/**
 * Canonical client owner for daemon-described plugin UI/browser projection
 * currentness. A reconnect or replaced daemon advances the machine's projection
 * revision (the one endpoint-identity signal), which starts a fresh request even when transport
 * timestamps and daemon versions do not change. A lapsed heartbeat that resumes on the same
 * endpoint is not a new endpoint: the confirmed projection is current again as soon as presence is.
 */
export function usePluginUiProjectionCurrentness(params: Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    enabled?: boolean;
    reloadRevision?: number;
    /** Setup consumes the credential-use declarations, beyond ordinary UI presentation. */
    includeConnectedAccountPurposes?: boolean;
}>): PluginUiProjectionCurrentness {
    const sections = params.includeConnectedAccountPurposes ? PLUGIN_UI_PURPOSE_SECTIONS : PLUGIN_UI_SECTIONS;
    // Local and remote Settings use the same language authority and narrow subscription.
    useSetting('preferredLanguage');
    const locale = getPreferredLanguage();
    const platform = resolvePluginUiProjectionPlatform();
    const machineId = typeof params.machineId === 'string' && params.machineId.trim().length > 0
        ? params.machineId
        : null;
    const serverId = typeof params.serverId === 'string' && params.serverId.trim().length > 0
        ? params.serverId
        : null;
    const enabled = params.enabled !== false;
    const targetKey = enabled && machineId
        ? pluginUiProjectionAdmissionTargetKey({ serverId, machineId })
        : null;
    const { binding: routedAccountLifetime } = useServerCredentialAccountScopeBinding(targetKey ? serverId : null);
    // Explicit Homes borrow the existing credential owner, never the focused
    // Home's Account. Unqualified legacy readers retain their incumbent owner.
    const accountLifetime = targetKey
        ? serverId ? routedAccountLifetime : captureActiveServerAccountScopeLifetime()
        : null;
    const accountLifetimeCurrent = serverId
        ? accountLifetime?.isCurrent() === true
        : isAccountLifetimeCurrent(accountLifetime);
    const target = React.useMemo(() => (
        targetKey && machineId ? { machineId, serverId } : null
    ), [machineId, serverId, targetKey]);
    const endpointStatus = useEndpointStatus();
    const machinePresence = useMachinePresenceSummary(serverId, machineId?.trim() ?? null);
    const appliedServerId = React.useSyncExternalStore(
        subscribeAppliedActiveServer,
        getAppliedActiveServerId,
        getAppliedActiveServerId,
    );
    const focusedAccountScope = getActiveServerAccountScope();
    // The singleton endpoint reports only its applied Home/Account. A routed
    // projection on another Home is admitted by that Home's existing RPC
    // transport, not withdrawn when the focused connection is torn down.
    const usesFocusedEndpoint = !serverId || Boolean(
        areServerProfileIdentifiersEquivalent(serverId, appliedServerId)
        && (!focusedAccountScope || accountLifetime?.scope.accountId === focusedAccountScope.accountId),
    );
    const online = Boolean(
        targetKey
        && (!usesFocusedEndpoint || endpointStatus === 'online')
        && machinePresence.reachability === 'reachable',
    );
    const subscribeProjectionInvalidation = React.useCallback((listener: () => void) => (
        target && accountLifetimeCurrent
            ? subscribeMachineContributionRegistryProjectionInvalidation(target, listener)
            : () => {}
    ), [accountLifetime, accountLifetimeCurrent, target]);
    const getProjectionInvalidationRevision = React.useCallback(() => (
        target && accountLifetimeCurrent
            ? getMachineContributionRegistryProjectionRevision(target)
            : 0
    ), [accountLifetime, accountLifetimeCurrent, target]);
    const projectionInvalidationRevision = React.useSyncExternalStore(
        subscribeProjectionInvalidation,
        getProjectionInvalidationRevision,
        getProjectionInvalidationRevision,
    );
    const authorityKey = targetKey && online && accountLifetimeCurrent
        ? [
            targetKey,
            params.reloadRevision ?? 0,
            projectionInvalidationRevision,
            locale,
            params.includeConnectedAccountPurposes === true ? 'purposes' : 'ui',
        ].join(':')
        : null;
    const currentAuthorityKeyRef = React.useRef(authorityKey);
    currentAuthorityKeyRef.current = authorityKey;
    // A real reload/reconnect starts a fresh attempt; a newly mounted sibling
    // instead joins the shared owner's existing failure/recovery cadence.
    const lastRequestedAuthorityKeyRef = React.useRef<string | null>(null);
    const currentAccountLifetimeRef = React.useRef(accountLifetime);
    currentAccountLifetimeRef.current = accountLifetime;
    const currentPluginUiProjectionRef = React.useRef<PluginUiProjectionModel | null>(null);
    const [loadedProjectionState, setLoadedProjection] = React.useState<LoadedProjectionState>(() => (
        targetKey && machineId
            ? createRestoredLoadedProjectionState({ targetKey, machineId, accountLifetime, platform })
            : createEmptyLoadedProjectionState(null, null)
    ));
    let loadedProjection = loadedProjectionState;
    if (loadedProjection.targetKey !== targetKey || loadedProjection.accountLifetime !== accountLifetime) {
        // Scope adoption belongs to this loaded-state owner. Restore only the
        // proven Account's existing custody in its first render, before a live
        // refresh can answer; the restored authorityKey remains null.
        loadedProjection = targetKey && machineId
            ? createRestoredLoadedProjectionState({ targetKey, machineId, accountLifetime, platform })
            : createEmptyLoadedProjectionState(null, null);
        setLoadedProjection(loadedProjection);
    }

    React.useEffect(() => {
        if (!accountLifetime) return;
        const retirement = accountLifetime.onRetire(() => {
            // Reset-time retirement must immediately fence both the visible
            // cache and pending RPC settlement. A successor lifetime owns its
            // own cache; an old callback may never clear it.
            if (currentAccountLifetimeRef.current !== accountLifetime) return;
            currentAccountLifetimeRef.current = null;
            currentAuthorityKeyRef.current = null;
            // Capture may retire A while a sibling renders B. Fence authority
            // immediately, then publish React state after that render. A late
            // publication must not clear a successor's settled projection.
            queueMicrotask(() => {
                setLoadedProjection((previous) => (
                    previous.accountLifetime !== accountLifetime
                        ? previous
                        : createEmptyLoadedProjectionState(null, null)
                ));
            });
        });
        return () => retirement.dispose();
    }, [accountLifetime]);

    React.useEffect(() => {
        if (!target || !targetKey) {
            setLoadedProjection((previous) => (
                previous.targetKey === null
                    && previous.accountLifetime === null
                    && previous.pluginUiProjection === EMPTY_PLUGIN_UI_PROJECTION
                    && previous.pluginBrowserProjection === EMPTY_PLUGIN_BROWSER_PROJECTION
                    ? previous
                    : createEmptyLoadedProjectionState(null, null)
            ));
            return;
        }

        const restoreRetained = (): LoadedProjectionState => createRestoredLoadedProjectionState({
            targetKey,
            machineId: target.machineId,
            accountLifetime,
            platform,
        });
        setLoadedProjection((previous) => {
            if (previous.targetKey !== targetKey || previous.accountLifetime !== accountLifetime) {
                return previous;
            }
            // Losing live authority before this process confirmed anything is
            // the same cold state as booting without it: the Account server's
            // last daemon heartbeat outlives a sleeping machine, so the first
            // describe is attempted and only then fails. `current` already
            // derives `retainedOffline`, and `unavailable` is a daemon's own
            // answer — neither may be replaced by device custody.
            if (authorityKey || previous.phase !== 'establishing') return previous;
            const restored = restoreRetained();
            return restored.phase === 'current' ? restored : previous;
        });

        if (!authorityKey) {
            return;
        }

        let cancelled = false;
        const abort = new AbortController();
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        let nextRetryEntry: Awaited<ReturnType<typeof loadDaemonMergedProjectionCacheEntry>> = null;
        let shareRetryCadence = lastRequestedAuthorityKeyRef.current === null
            || lastRequestedAuthorityKeyRef.current === authorityKey;
        lastRequestedAuthorityKeyRef.current = authorityKey;

        const isRequestCurrent = (): boolean => (
            !cancelled
            && currentAuthorityKeyRef.current === authorityKey
            && currentAccountLifetimeRef.current === accountLifetime
            && isAccountLifetimeCurrent(accountLifetime)
        );

        const scheduleRetry = (failureReason: MachineContributionRegistryProjectionFailureReason = 'error'): void => {
            if (!isRequestCurrent() || retryTimer !== null) return;
            setLoadedProjection((previous) => {
                if (previous.targetKey !== targetKey
                    || previous.accountLifetime !== accountLifetime
                    || (previous.connectedAccountProjection === CONNECTED_ACCOUNT_PROJECTION_TRANSPORT_ERROR
                        && previous.failureReason === failureReason)) return previous;
                if (previous.phase === 'current' && previous.authorityKey !== null) {
                    return previous.failedRefreshAuthorityKey === authorityKey
                        ? previous
                        : { ...previous, failedRefreshAuthorityKey: authorityKey };
                }
                const retained = previous.phase === 'current' ? previous : restoreRetained();
                return { ...retained, failureReason, phase: retained.phase === 'current' ? 'current' : 'unavailable',
                    connectedAccountProjection: CONNECTED_ACCOUNT_PROJECTION_TRANSPORT_ERROR };
            });
            const delayMs = readDaemonMergedProjectionRetryDelayMs(nextRetryEntry);
            if (delayMs === null) return;
            retryTimer = setTimeout(() => {
                retryTimer = null;
                requestProjection();
            }, delayMs);
        };

        const requestProjection = (): void => {
            if (!isRequestCurrent()) return;
            // The one per-machine projection owner: every reader of this
            // machine shares its request and its projection revision.
            void loadDaemonMergedProjectionCacheEntry({
                sections,
                machineId: target.machineId,
                serverId: target.serverId,
                accountLifetime,
                signal: abort.signal,
                reuseFreshReady: shareRetryCadence,
                shareRetryCadence,
            }).then((entry) => {
                if (!isRequestCurrent()) return;
                nextRetryEntry = entry;
                shareRetryCadence = true;
                if (!entry || entry.kind === 'error') {
                    // Keep the last-known snapshot, but retry a current
                    // transient failure without letting it regain authority.
                    scheduleRetry(entry?.kind === 'error' ? entry.reason : 'error');
                    return;
                }
                if (entry.kind === 'unsupported') {
                    // The full acquisition owner already retired this exact
                    // machine's retained admission before publishing unsupported.
                    setLoadedProjection((previous) => {
                        if (
                            previous.targetKey !== targetKey
                            || previous.accountLifetime !== accountLifetime
                            || !isRequestCurrent()
                        ) {
                            return previous;
                        }
                        return createUnavailableLoadedProjectionState(targetKey, accountLifetime);
                    });
                    return;
                }
                const projection = entry.inputs.pluginProjectionV2;
                if (!projection) {
                    scheduleRetry();
                    return;
                }
                const connectedAccountProjection = entry.inputs.connectedAccountProjection;
                setLoadedProjection((previous) => {
                    if (
                        previous.targetKey !== targetKey
                        || previous.accountLifetime !== accountLifetime
                        || !isRequestCurrent()
                    ) {
                        return previous;
                    }
                    return {
                        targetKey,
                        accountLifetime,
                        authorityKey,
                        phase: 'current',
                        connectedAccountProjection,
                        pluginUiProjection: entry.inputs.pluginUiProjection,
                        pluginBrowserProjection: resolvePluginBrowserProjectionState(
                            previous.pluginBrowserProjection,
                            projection,
                        ),
                    };
                });
            }).catch(() => {
                scheduleRetry();
            });
        };

        requestProjection();

        return () => {
            cancelled = true;
            abort.abort();
            if (retryTimer !== null) clearTimeout(retryTimer);
        };
    }, [accountLifetime, authorityKey, platform, target, targetKey]);

    const hasLoadedCurrentScope = Boolean(
        targetKey
        && accountLifetimeCurrent
        && loadedProjection.targetKey === targetKey
        && loadedProjection.accountLifetime === accountLifetime,
    );
    const phase: PluginUiProjectionPhase = !targetKey || !accountLifetimeCurrent
        ? 'unavailable'
        : !hasLoadedCurrentScope
            ? 'establishing'
            : loadedProjection.phase === 'unavailable'
                ? 'unavailable'
                : loadedProjection.phase === 'current'
                    && loadedProjection.connectedAccountProjection === CONNECTED_ACCOUNT_PROJECTION_TRANSPORT_ERROR
                    ? 'retainedOffline'
                : !authorityKey
                    ? loadedProjection.phase === 'current'
                        ? 'retainedOffline'
                        : 'unavailable'
                    : loadedProjection.phase === 'current'
                        && (loadedProjection.authorityKey === authorityKey || loadedProjection.failedRefreshAuthorityKey === authorityKey)
                        ? 'current'
                        : 'establishing';
    const interactionEnabled = phase === 'current';
    const unavailableReasonCode = (phase === 'unavailable' || phase === 'retainedOffline') && targetKey && accountLifetimeCurrent
        ? loadedProjection.connectedAccountProjection === CONNECTED_ACCOUNT_PROJECTION_UNSUPPORTED
            ? 'plugin_daemon_unsupported'
            : loadedProjection.failureReason === 'invalid-response'
                ? 'plugin_daemon_invalid_response'
                : loadedProjection.failureReason
                    ? 'plugin_daemon_unavailable'
                    : !authorityKey ? 'plugin_machine_unreachable' : undefined
        : undefined;
    const pluginBrowserProjection = interactionEnabled
        ? loadedProjection.pluginBrowserProjection
        : null;

    const currentPluginUiProjection = hasLoadedCurrentScope && phase !== 'unavailable'
        ? loadedProjection.pluginUiProjection
        : null;
    const connectedAccountProjection = hasLoadedCurrentScope
        ? loadedProjection.connectedAccountProjection
        : null;
    currentPluginUiProjectionRef.current = currentPluginUiProjection;
    const reactNativeRuntimeProjectionSourceRef = React.useRef<PluginUiReactNativeRuntimeProjectionSource | null>(null);

    React.useEffect(() => {
        const source = createInstalledPluginUiReactNativeRuntimeProjectionSource();
        reactNativeRuntimeProjectionSourceRef.current = source;
        return () => {
            if (reactNativeRuntimeProjectionSourceRef.current === source) {
                reactNativeRuntimeProjectionSourceRef.current = null;
            }
            source.dispose();
        };
    }, []);

    React.useEffect(() => {
        const source = reactNativeRuntimeProjectionSourceRef.current;
        if (!source) return;
        source.update({
            projection: currentPluginUiProjection,
            accountLifetime,
            isCurrent: () => (
                currentAccountLifetimeRef.current === accountLifetime
                && currentPluginUiProjectionRef.current === currentPluginUiProjection
                && isAccountLifetimeCurrent(accountLifetime)
            ),
        });
    }, [accountLifetime, currentPluginUiProjection]);

    return React.useMemo(() => ({
        pluginUiProjection: currentPluginUiProjection,
        pluginBrowserProjection,
        phase,
        unavailableReasonCode,
        interactionEnabled,
        machineId,
        serverId,
        platform,
        accountLifetime,
        connectedAccountProjection,
    }), [
        interactionEnabled,
        connectedAccountProjection,
        machineId,
        phase,
        unavailableReasonCode,
        platform,
        accountLifetime,
        pluginBrowserProjection,
        currentPluginUiProjection,
        serverId,
    ]);
}
