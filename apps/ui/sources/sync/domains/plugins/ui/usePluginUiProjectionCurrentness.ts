import * as React from 'react';
import { Platform } from 'react-native';

import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
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
    getMachineContributionRegistryProjectionRevision,
    machineContributionRegistryProjectionDescribe,
    subscribeMachineContributionRegistryProjectionInvalidation,
} from '@/sync/ops/machineContributionRegistryProjection';
import {
    useEndpointStatus,
    useMachineCliDetectionTarget,
} from '@/sync/domains/state/storage';

const PLUGIN_UI_PROJECTION_TIMEOUT_MS = 5_000;

type ProjectionConnectionState = Readonly<{
    targetKey: string | null;
    online: boolean;
    reconnectSequence: number;
}>;

type LoadedProjectionState = Readonly<{
    targetKey: string | null;
    authorityKey: string | null;
    pluginUiProjection: PluginUiProjectionModel;
    pluginBrowserProjection: PluginBrowserProjectionModel;
}>;

export type PluginUiProjectionCurrentness = Readonly<{
    pluginUiProjection: PluginUiProjectionModel | null;
    pluginBrowserProjection: PluginBrowserProjectionModel | null;
    interactionEnabled: boolean;
    machineId: string | null;
    serverId: string | null;
    platform: LocalServicePreviewPlatform;
}>;

function resolvePlatform(): LocalServicePreviewPlatform {
    return Platform.OS === 'ios' || Platform.OS === 'android' ? Platform.OS : 'web';
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
    const platform = resolvePlatform();
    const machineId = typeof params.machineId === 'string' && params.machineId.trim().length > 0
        ? params.machineId
        : null;
    const serverId = typeof params.serverId === 'string' && params.serverId.trim().length > 0
        ? params.serverId
        : null;
    const enabled = params.enabled !== false;
    const targetKey = enabled && machineId ? `${serverId ?? 'default'}:${machineId}` : null;
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
        target
            ? subscribeMachineContributionRegistryProjectionInvalidation(target, listener)
            : () => {}
    ), [target]);
    const getProjectionInvalidationRevision = React.useCallback(() => (
        target ? getMachineContributionRegistryProjectionRevision(target) : 0
    ), [target]);
    const projectionInvalidationRevision = React.useSyncExternalStore(
        subscribeProjectionInvalidation,
        getProjectionInvalidationRevision,
        getProjectionInvalidationRevision,
    );
    const authorityKey = targetKey && online
        ? [
            targetKey,
            machineCliDetectionTarget.daemonStateVersion,
            nextConnectionState.reconnectSequence,
            projectionInvalidationRevision,
        ].join(':')
        : null;
    const currentAuthorityKeyRef = React.useRef(authorityKey);
    currentAuthorityKeyRef.current = authorityKey;
    const [loadedProjection, setLoadedProjection] = React.useState<LoadedProjectionState>({
        targetKey: null,
        authorityKey: null,
        pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION,
        pluginBrowserProjection: EMPTY_PLUGIN_BROWSER_PROJECTION,
    });

    React.useEffect(() => {
        if (!target || !targetKey) {
            setLoadedProjection((previous) => (
                previous.targetKey === null
                    && previous.pluginUiProjection === EMPTY_PLUGIN_UI_PROJECTION
                    && previous.pluginBrowserProjection === EMPTY_PLUGIN_BROWSER_PROJECTION
                    ? previous
                    : {
                        targetKey: null,
                        authorityKey: null,
                        pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION,
                        pluginBrowserProjection: EMPTY_PLUGIN_BROWSER_PROJECTION,
                    }
            ));
            return;
        }

        setLoadedProjection((previous) => (
            previous.targetKey === targetKey
                ? previous
                : {
                    targetKey,
                    authorityKey: null,
                    pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION,
                    pluginBrowserProjection: EMPTY_PLUGIN_BROWSER_PROJECTION,
                }
        ));

        if (!authorityKey) {
            return;
        }

        let cancelled = false;
        void machineContributionRegistryProjectionDescribe(target.machineId, {
            serverId: target.serverId,
            timeoutMs: PLUGIN_UI_PROJECTION_TIMEOUT_MS,
            requestEpoch: authorityKey,
        }).then((result) => {
            if (cancelled || currentAuthorityKeyRef.current !== authorityKey || !result.supported) {
                return;
            }
            setLoadedProjection((previous) => {
                if (
                    previous.targetKey !== targetKey
                    || currentAuthorityKeyRef.current !== authorityKey
                ) {
                    return previous;
                }
                return {
                    targetKey,
                    authorityKey,
                    pluginUiProjection: resolvePluginUiProjectionState(
                        previous.pluginUiProjection,
                        result.projection,
                    ),
                    pluginBrowserProjection: resolvePluginBrowserProjectionState(
                        previous.pluginBrowserProjection,
                        result.projection,
                    ),
                };
            });
        }).catch(() => {
            // Keep the last-known snapshot, but never grant it current authority.
        });

        return () => {
            cancelled = true;
        };
    }, [authorityKey, target, targetKey]);

    const pluginUiProjection = targetKey && loadedProjection.targetKey === targetKey
        ? loadedProjection.pluginUiProjection
        : null;
    const interactionEnabled = Boolean(
        authorityKey
        && loadedProjection.targetKey === targetKey
        && loadedProjection.authorityKey === authorityKey,
    );
    const pluginBrowserProjection = interactionEnabled
        ? loadedProjection.pluginBrowserProjection
        : null;

    return React.useMemo(() => ({
        pluginUiProjection,
        pluginBrowserProjection,
        interactionEnabled,
        machineId,
        serverId,
        platform,
    }), [
        interactionEnabled,
        machineId,
        platform,
        pluginBrowserProjection,
        pluginUiProjection,
        serverId,
    ]);
}
