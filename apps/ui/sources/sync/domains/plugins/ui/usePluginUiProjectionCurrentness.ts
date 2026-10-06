import * as React from 'react';
import type { PluginContributionClientPlatform } from '@happier-dev/protocol';
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
    resolvePluginUiProjectionState,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import {
    forgetPluginUiProjectionAdmissionSnapshot,
    pluginUiProjectionAdmissionTargetKey,
    readPluginUiProjectionAdmissionSnapshot,
    savePluginUiProjectionAdmissionSnapshot,
} from '@/sync/domains/plugins/ui/projectionWarmCache';
import {
    getMachineContributionRegistryProjectionRevision,
    subscribeMachineContributionRegistryProjectionInvalidation,
} from '@/sync/ops/machineContributionRegistryProjection';
import { loadDaemonMergedProjectionCacheEntry } from '@/agents/backendCatalog/loadDaemonMergedProjectionInputs';
import {
    useEndpointStatus,
    useMachineCliDetectionTarget,
    useSetting,
} from '@/sync/domains/state/storage';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import {
    readConnectedAccountDescriptorProjection,
    type ConnectedAccountDescriptorMachineProjection,
} from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';

/**
 * The first rungs cover a transport blip around mount or reconnect. The final
 * rung preserves the incumbent 30 s recovery cadence while the failure lasts.
 * Successful snapshots refresh through the canonical machine invalidation
 * subscription, not a second AppShell full-projection poll.
 */
const PLUGIN_UI_PROJECTION_RETRY_BACKOFF_MS = [250, 1_000, 2_500, 5_000, 30_000] as const;
const CONNECTED_ACCOUNT_PROJECTION_TRANSPORT_ERROR = Object.freeze({
    kind: 'error' as const,
    reason: 'transport' as const,
});
const CONNECTED_ACCOUNT_PROJECTION_UNSUPPORTED = Object.freeze({
    kind: 'error' as const,
    reason: 'unsupported' as const,
});

type ProjectionConnectionState = Readonly<{
    targetKey: string | null;
    online: boolean;
    reconnectSequence: number;
    reloadRevision: number;
}>;

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
    interactionEnabled: boolean;
    machineId: string | null;
    serverId: string | null;
    platform: LocalServicePreviewPlatform;
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

/**
 * Client executable declarations have web/iOS/Android targets. Desktop uses
 * the same React Native Web executable bundle as web, while the projection
 * platform retains `desktop` for UI/currentness consumers that distinguish it.
 */
export function resolvePluginUiClientExecutablePlatform(): PluginContributionClientPlatform {
    const platform = resolvePluginUiProjectionPlatform();
    return platform === 'desktop' ? 'web' : platform;
}

function advanceProjectionConnectionState(
    previous: ProjectionConnectionState,
    input: Readonly<{ targetKey: string | null; online: boolean; reloadRevision: number }>,
): ProjectionConnectionState {
    if (previous.targetKey !== input.targetKey) {
        return {
            targetKey: input.targetKey,
            online: input.online,
            reconnectSequence: 0,
            reloadRevision: input.reloadRevision,
        };
    }
    if (previous.online === input.online && previous.reloadRevision === input.reloadRevision) {
        return previous;
    }
    return {
        targetKey: input.targetKey,
        online: input.online,
        reconnectSequence: previous.reconnectSequence + (
            !previous.online && input.online ? 1 : 0
        ),
        reloadRevision: input.reloadRevision,
    };
}

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
 * currentness. A locally observed reconnect advances an owner-scoped request
 * epoch even when transport timestamps and daemon versions do not change.
 */
export function usePluginUiProjectionCurrentness(params: Readonly<{
    machineId?: string | null;
    serverId?: string | null;
    enabled?: boolean;
    reloadRevision?: number;
}>): PluginUiProjectionCurrentness {
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
    // This is the one incumbent ServerAccountScope lifetime. Its identity is
    // deliberately owner-local currentness, not an Account id or UI epoch.
    const accountLifetime = targetKey ? captureActiveServerAccountScopeLifetime() : null;
    const accountLifetimeCurrent = isAccountLifetimeCurrent(accountLifetime);
    const target = React.useMemo(() => (
        targetKey && machineId ? { machineId, serverId } : null
    ), [machineId, serverId, targetKey]);
    const endpointStatus = useEndpointStatus();
    const machineCliDetectionTarget = useMachineCliDetectionTarget(machineId);
    const online = Boolean(
        targetKey
        && endpointStatus === 'online'
        && machineCliDetectionTarget.isOnline,
    );
    const [connectionState, setConnectionState] = React.useState<ProjectionConnectionState>(() => ({
        targetKey,
        online,
        reconnectSequence: 0,
        reloadRevision: params.reloadRevision ?? 0,
    }));
    const nextConnectionState = advanceProjectionConnectionState(connectionState, {
        targetKey,
        online,
        reloadRevision: params.reloadRevision ?? 0,
    });
    if (nextConnectionState !== connectionState) {
        setConnectionState(nextConnectionState);
    }

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
            machineCliDetectionTarget.daemonStateVersion,
            nextConnectionState.reconnectSequence,
            nextConnectionState.reloadRevision,
            projectionInvalidationRevision,
            locale,
        ].join(':')
        : null;
    const currentAuthorityKeyRef = React.useRef(authorityKey);
    currentAuthorityKeyRef.current = authorityKey;
    const currentAccountLifetimeRef = React.useRef(accountLifetime);
    currentAccountLifetimeRef.current = accountLifetime;
    const currentPluginUiProjectionRef = React.useRef<PluginUiProjectionModel | null>(null);
    const [loadedProjection, setLoadedProjection] = React.useState<LoadedProjectionState>(() => (
        createEmptyLoadedProjectionState(null, null)
    ));

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
                return restoreRetained();
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
        let retryTimer: ReturnType<typeof setTimeout> | null = null;
        let retryAttempts = 0;

        const isRequestCurrent = (): boolean => (
            !cancelled
            && currentAuthorityKeyRef.current === authorityKey
            && currentAccountLifetimeRef.current === accountLifetime
            && isAccountLifetimeCurrent(accountLifetime)
        );

        const scheduleRetry = (): void => {
            if (!isRequestCurrent() || retryTimer !== null) return;
            setLoadedProjection((previous) => (
                previous.targetKey !== targetKey
                    || previous.accountLifetime !== accountLifetime
                    || previous.connectedAccountProjection === CONNECTED_ACCOUNT_PROJECTION_TRANSPORT_ERROR
                    ? previous
                    : { ...previous, connectedAccountProjection: CONNECTED_ACCOUNT_PROJECTION_TRANSPORT_ERROR }
            ));
            const delayMs = PLUGIN_UI_PROJECTION_RETRY_BACKOFF_MS[
                Math.min(retryAttempts, PLUGIN_UI_PROJECTION_RETRY_BACKOFF_MS.length - 1)
            ]!;
            retryAttempts += 1;
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
                machineId: target.machineId,
                serverId: target.serverId,
                accountLifetime,
                reuseFreshReady: loadedProjection.authorityKey === null
                    || loadedProjection.authorityKey === authorityKey,
            }).then((entry) => {
                if (!isRequestCurrent()) return;
                if (!entry || entry.kind === 'error') {
                    // Keep the last-known snapshot, but retry a current
                    // transient failure without letting it regain authority.
                    scheduleRetry();
                    return;
                }
                if (entry.kind === 'unsupported') {
                    // The daemon itself answered that this machine does not
                    // serve the projection. That answer must survive a restart,
                    // so the retained snapshot is retired here rather than
                    // being restored by the next fresh process.
                    forgetPluginUiProjectionAdmissionSnapshot({
                        scope: accountLifetime?.scope ?? null,
                        targetKey,
                    });
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
                retryAttempts = 0;
                // This is the one moment admission currentness is confirmed,
                // so it is the only moment the Account-qualified snapshot is
                // recorded for the next fresh process.
                savePluginUiProjectionAdmissionSnapshot({
                    scope: accountLifetime?.scope ?? null,
                    targetKey,
                    machineId: target.machineId,
                    projection,
                });
                const connectedAccountProjection = readConnectedAccountDescriptorProjection(projection);
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
                        pluginUiProjection: resolvePluginUiProjectionState(
                            previous.pluginUiProjection,
                            projection,
                            {
                                reuseSameGeneration: previous.authorityKey === authorityKey,
                                platform,
                            },
                        ),
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
            if (retryTimer !== null) clearTimeout(retryTimer);
        };
    }, [accountLifetime, authorityKey, machineCliDetectionTarget.daemonStateVersion, platform, target, targetKey]);

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
                : !authorityKey
                    ? loadedProjection.phase === 'current'
                        ? 'retainedOffline'
                        : 'establishing'
                    : loadedProjection.phase === 'current' && loadedProjection.authorityKey === authorityKey
                        ? 'current'
                        : 'establishing';
    const interactionEnabled = phase === 'current';
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
        interactionEnabled,
        machineId,
        serverId,
        platform,
        connectedAccountProjection,
    }), [
        interactionEnabled,
        connectedAccountProjection,
        machineId,
        phase,
        platform,
        pluginBrowserProjection,
        currentPluginUiProjection,
        serverId,
    ]);
}
