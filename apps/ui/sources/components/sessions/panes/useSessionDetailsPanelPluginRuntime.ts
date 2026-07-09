import * as React from 'react';

import type { PeerMediationObservabilityScopeV1 } from '@happier-dev/protocol';

import { getInstalledPluginReactNativeBundleCache } from '@/components/plugins/reactNative/bundleCache';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { machineContributionRegistryProjectionDescribe } from '@/sync/ops/machineContributionRegistryProjection';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import { resolveLocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/platform';
import { resolvePluginUiArtifactInvalidation } from '@/sync/domains/plugins/ui/artifactInvalidation';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    resolvePluginUiProjectionState,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import {
    EMPTY_PLUGIN_BROWSER_PROJECTION,
    resolvePluginBrowserProjectionState,
    type PluginBrowserProjectionModel,
} from '@/sync/domains/plugins/browser/targets';
import { useProfile } from '@/sync/store/hooks';

const SESSION_DETAILS_PANEL_PLUGIN_PROJECTION_TIMEOUT_MS = 5_000;

type LoadedPluginUiProjectionState = Readonly<{
    key: string | null;
    uiProjection: PluginUiProjectionModel;
    browserProjection: PluginBrowserProjectionModel;
}>;

export type SessionDetailsPanelPluginRuntimeState = Readonly<{
    pluginUiProjection: PluginUiProjectionModel | null;
    pluginBrowserProjection: PluginBrowserProjectionModel | null;
    peerMediationObservabilityScope: PeerMediationObservabilityScopeV1 | null;
    platform: LocalServicePreviewPlatform;
    machineId: string | null;
    serverId: string | null;
}>;

export type PluginUiExecutableArtifactCacheInvalidationTargets = Readonly<{
    reactNative: Pick<ReturnType<typeof getInstalledPluginReactNativeBundleCache>, 'evictForRevokedDigests'>;
}>;

function readProfileId(profile: unknown): string | null {
    if (!profile || typeof profile !== 'object') {
        return null;
    }
    const id = (profile as { id?: unknown }).id;
    return typeof id === 'string' && id.trim().length > 0 ? id : null;
}

export function applyPluginUiExecutableArtifactCacheInvalidation(input: Readonly<{
    previous: PluginUiProjectionModel;
    next: PluginUiProjectionModel;
    targets: PluginUiExecutableArtifactCacheInvalidationTargets;
}>): void {
    const invalidation = resolvePluginUiArtifactInvalidation(input.previous, input.next);
    if (invalidation.revokedArtifactDigests.length === 0) {
        return;
    }
    const revokedDigests = new Set(invalidation.revokedArtifactDigests);
    input.targets.reactNative.evictForRevokedDigests(revokedDigests);
}

export function useSessionDetailsPanelPluginRuntime(params: Readonly<{
    sessionId: string;
    pluginUiProjection?: PluginUiProjectionModel | null;
    peerMediationObservabilityScope?: PeerMediationObservabilityScopeV1 | null;
    platform?: LocalServicePreviewPlatform;
}>): SessionDetailsPanelPluginRuntimeState {
    const machineTarget = useSessionMachineTarget(params.sessionId);
    const serverId = usePreferredServerIdForSession(params.sessionId);
    const profile = useProfile();
    const [loadedProjection, setLoadedProjection] = React.useState<LoadedPluginUiProjectionState>({
        key: null,
        uiProjection: EMPTY_PLUGIN_UI_PROJECTION,
        browserProjection: EMPTY_PLUGIN_BROWSER_PROJECTION,
    });

    const explicitProjectionProvided = params.pluginUiProjection !== undefined;
    const projectionLookupKey = React.useMemo(() => {
        if (explicitProjectionProvided || !machineTarget?.machineId) {
            return null;
        }
        return `${serverId ?? 'default'}:${machineTarget.machineId}`;
    }, [explicitProjectionProvided, machineTarget?.machineId, serverId]);

    React.useEffect(() => {
        if (!projectionLookupKey || !machineTarget?.machineId) {
            setLoadedProjection((previous) => (
                previous.key === null
                    && previous.uiProjection === EMPTY_PLUGIN_UI_PROJECTION
                    && previous.browserProjection === EMPTY_PLUGIN_BROWSER_PROJECTION
                    ? previous
                    : {
                        key: null,
                        uiProjection: EMPTY_PLUGIN_UI_PROJECTION,
                        browserProjection: EMPTY_PLUGIN_BROWSER_PROJECTION,
                    }
            ));
            return;
        }

        setLoadedProjection((previous) => (
            previous.key === projectionLookupKey
                ? previous
                : {
                    key: projectionLookupKey,
                    uiProjection: EMPTY_PLUGIN_UI_PROJECTION,
                    browserProjection: EMPTY_PLUGIN_BROWSER_PROJECTION,
                }
        ));

        let cancelled = false;
        void machineContributionRegistryProjectionDescribe(machineTarget.machineId, {
            serverId,
            timeoutMs: SESSION_DETAILS_PANEL_PLUGIN_PROJECTION_TIMEOUT_MS,
        }).then((result) => {
            if (cancelled || !result.supported) {
                return;
            }
            setLoadedProjection((previous) => {
                if (previous.key !== projectionLookupKey) {
                    return previous;
                }
                return {
                    key: projectionLookupKey,
                    uiProjection: resolvePluginUiProjectionState(previous.uiProjection, result.projection),
                    browserProjection: resolvePluginBrowserProjectionState(previous.browserProjection, result.projection),
                };
            });
        });

        return () => {
            cancelled = true;
        };
    }, [machineTarget?.machineId, projectionLookupKey, serverId]);

    const pluginUiProjection = explicitProjectionProvided
        ? params.pluginUiProjection ?? null
        : loadedProjection.key === projectionLookupKey
            ? loadedProjection.uiProjection
            : EMPTY_PLUGIN_UI_PROJECTION;
    const pluginBrowserProjection = explicitProjectionProvided
        ? null
        : loadedProjection.key === projectionLookupKey
            ? loadedProjection.browserProjection
            : EMPTY_PLUGIN_BROWSER_PROJECTION;
    const effectiveProjectionForInvalidation = pluginUiProjection ?? EMPTY_PLUGIN_UI_PROJECTION;
    const previousProjectionForInvalidationRef = React.useRef<PluginUiProjectionModel>(EMPTY_PLUGIN_UI_PROJECTION);

    React.useEffect(() => {
        const previous = previousProjectionForInvalidationRef.current;
        if (previous !== effectiveProjectionForInvalidation) {
            applyPluginUiExecutableArtifactCacheInvalidation({
                previous,
                next: effectiveProjectionForInvalidation,
                targets: {
                    reactNative: getInstalledPluginReactNativeBundleCache(),
                },
            });
            previousProjectionForInvalidationRef.current = effectiveProjectionForInvalidation;
        }
    }, [effectiveProjectionForInvalidation]);

    const profileId = readProfileId(profile);
    const derivedObservabilityScope = React.useMemo<PeerMediationObservabilityScopeV1 | null>(() => {
        if (!machineTarget?.machineId || !profileId) {
            return null;
        }
        return {
            kind: 'machine',
            accountId: profileId,
            machineId: machineTarget.machineId,
        };
    }, [machineTarget?.machineId, profileId]);

    return React.useMemo(() => ({
        pluginUiProjection,
        pluginBrowserProjection,
        peerMediationObservabilityScope:
            params.peerMediationObservabilityScope !== undefined
                ? params.peerMediationObservabilityScope
                : derivedObservabilityScope,
        platform: resolveLocalServicePreviewPlatform(params.platform),
        machineId: machineTarget?.machineId ?? null,
        serverId,
    }), [
        derivedObservabilityScope,
        machineTarget?.machineId,
        params.peerMediationObservabilityScope,
        params.platform,
        pluginBrowserProjection,
        pluginUiProjection,
        serverId,
    ]);
}
