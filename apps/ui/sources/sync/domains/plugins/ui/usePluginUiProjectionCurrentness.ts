import * as React from 'react';
import type { PluginContributionClientPlatform } from '@happier-dev/protocol';

import {
    createInstalledPluginUiReactNativeRuntimeProjectionSource,
    type PluginUiReactNativeRuntimeProjectionSource,
} from '@/components/plugins/reactNative/projectionInvalidation';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import { resolveLocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/platform';
import {
    EMPTY_PLUGIN_BROWSER_PROJECTION,
    resolvePluginBrowserProjectionState,
    type PluginBrowserProjectionModel,
} from '@/sync/domains/plugins/browser/targets';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
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
    machineContributionRegistryProjectionDescribe,
    subscribeMachineContributionRegistryProjectionInvalidation,
} from '@/sync/ops/machineContributionRegistryProjection';
import {
    useEndpointStatus,
    useMachineCliDetectionTarget,
} from '@/sync/domains/state/storage';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';

const PLUGIN_UI_PROJECTION_TIMEOUT_MS = 5_000;
/**
 * The first rungs cover a transport blip around mount or reconnect. The final
 * rung is the steady state and repeats for as long as the failure lasts, so it
 * is bounded by the cadence the app already pays for this same RPC: the app
 * shell re-describes every online machine's projection every 30 s
 * (`CONNECTED_ACCOUNT_PROJECTION_REFRESH_INTERVAL_MS`). Asking faster than that
 * cannot surface a change sooner and re-pulls the whole projection each time —
 * a failure the daemon answers deterministically (a response this client cannot
 * parse arrives here as the same opaque `error`) would otherwise re-read it
 * twelve times a minute forever.
 */
const PLUGIN_UI_PROJECTION_RETRY_BACKOFF_MS = [250, 1_000, 2_500, 5_000, 30_000] as const;

type ProjectionConnectionState = Readonly<{
    targetKey: string | null;
    online: boolean;
    reconnectSequence: number;
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
}>;

export type PluginUiProjectionCurrentness = Readonly<{
    pluginUiProjection: PluginUiProjectionModel | null;
    pluginBrowserProjection: PluginBrowserProjectionModel | null;
    phase: PluginUiProjectionPhase;
    interactionEnabled: boolean;
    machineId: string | null;
    serverId: string | null;
    platform: LocalServicePreviewPlatform;
}>;

/**
 * The host platform every projection currentness reports. Exported because the
 * app-scope union has no single machine hook to read it from, and a second
 * `Platform.OS` mapping beside this one would be exactly the split-brain §8
 * forbids.
 */
export function resolvePluginUiProjectionPlatform(): LocalServicePreviewPlatform {
    return resolveLocalServicePreviewPlatform();
}

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
    input: Readonly<{ targetKey: string | null; online: boolean }>,
): ProjectionConnectionState {
    if (previous.targetKey !== input.targetKey) {
        return {
            targetKey: input.targetKey,
            online: input.online,
            reconnectSequence: 0,
        };
    }
    if (previous.online === input.online) {
        return previous;
    }
    return {
        targetKey: input.targetKey,
        online: input.online,
        reconnectSequence: previous.reconnectSequence + (
            !previous.online && input.online ? 1 : 0
        ),
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
    };
}

/**
 * A fresh process with no reachable daemon has no in-process snapshot to
 * retain, so it restores this Account's last-confirmed admission snapshot from
 * device custody and presents it read-only. Restoring is deliberately
 * conditional on there being no live authority: when a daemon is reachable the
 * fresh describe is one RPC away and remains the only thing worth showing.
 */
function createRestoredLoadedProjectionState(input: Readonly<{
    targetKey: string;
    machineId: string;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
}>): LoadedProjectionState {
    const restored = input.accountLifetime && input.accountLifetime.isCurrent()
        ? readPluginUiProjectionAdmissionSnapshot({
            scope: input.accountLifetime.scope,
            targetKey: input.targetKey,
            machineId: input.machineId,
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
}>): PluginUiProjectionCurrentness {
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
    }));
    const nextConnectionState = advanceProjectionConnectionState(connectionState, {
        targetKey,
        online,
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
            projectionInvalidationRevision,
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
            setLoadedProjection((previous) => (
                previous.accountLifetime !== accountLifetime
                    ? previous
                    : createEmptyLoadedProjectionState(null, null)
            ));
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
        });
        setLoadedProjection((previous) => {
            if (previous.targetKey !== targetKey || previous.accountLifetime !== accountLifetime) {
                return authorityKey
                    ? createEmptyLoadedProjectionState(targetKey, accountLifetime)
                    : restoreRetained();
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
        let activeRequestController: AbortController | null = null;
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
            const controller = new AbortController();
            activeRequestController = controller;
            void machineContributionRegistryProjectionDescribe(target.machineId, {
                serverId: target.serverId,
                timeoutMs: PLUGIN_UI_PROJECTION_TIMEOUT_MS,
                signal: controller.signal,
                requestEpoch: authorityKey,
            }).then((result) => {
                if (!isRequestCurrent()) return;
                if (!result.supported) {
                    if (result.reason === 'error') {
                        scheduleRetry();
                        return;
                    }
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
                retryAttempts = 0;
                // This is the one moment admission currentness is confirmed,
                // so it is the only moment the Account-qualified snapshot is
                // recorded for the next fresh process.
                savePluginUiProjectionAdmissionSnapshot({
                    scope: accountLifetime?.scope ?? null,
                    targetKey,
                    machineId: target.machineId,
                    projection: result.projection,
                });
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
                        pluginUiProjection: resolvePluginUiProjectionState(
                            previous.pluginUiProjection,
                            result.projection,
                            { reuseSameGeneration: previous.authorityKey === authorityKey },
                        ),
                        pluginBrowserProjection: resolvePluginBrowserProjectionState(
                            previous.pluginBrowserProjection,
                            result.projection,
                        ),
                    };
                });
            }).catch(() => {
                // Keep the last-known snapshot, but retry a current transient
                // describe failure without allowing it to regain authority.
                scheduleRetry();
            }).finally(() => {
                if (activeRequestController === controller) activeRequestController = null;
            });
        };

        requestProjection();

        return () => {
            cancelled = true;
            if (retryTimer !== null) clearTimeout(retryTimer);
            activeRequestController?.abort();
        };
    }, [accountLifetime, authorityKey, target, targetKey]);

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
    }), [
        interactionEnabled,
        machineId,
        phase,
        platform,
        pluginBrowserProjection,
        currentPluginUiProjection,
        serverId,
    ]);
}
