import * as React from 'react';

import type { PeerMediationObservabilityScopeV1 } from '@happier-dev/protocol';

import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import { useProfile } from '@/sync/store/hooks';
import {
    useSessionPanePluginRuntime,
    type SessionPanePluginRuntimeState,
    type SessionPaneSurfaceScope,
} from './useSessionPanePluginRuntime';

export type SessionDetailsPanelPluginRuntimeState = SessionPanePluginRuntimeState & Readonly<{
    peerMediationObservabilityScope: PeerMediationObservabilityScopeV1 | null;
}>;

function readProfileId(profile: unknown): string | null {
    if (!profile || typeof profile !== 'object') {
        return null;
    }
    const id = (profile as { id?: unknown }).id;
    return typeof id === 'string' && id.trim().length > 0 ? id : null;
}

export function useSessionDetailsPanelPluginRuntime(params: Readonly<{
    sessionId: string;
    /**
     * AppPane's registered driver is the authority for target/projection facts.
     * Direct screen renders omit this and retain their incumbent local lookup.
     */
    paneSurfaceScope?: SessionPaneSurfaceScope;
    pluginUiProjection?: PluginUiProjectionModel | null;
    peerMediationObservabilityScope?: PeerMediationObservabilityScopeV1 | null;
    platform?: LocalServicePreviewPlatform;
}>): SessionDetailsPanelPluginRuntimeState {
    const pluginRuntime = useSessionPanePluginRuntime({
        sessionId: params.sessionId,
        paneSurfaceScope: params.paneSurfaceScope,
        pluginUiProjection: params.pluginUiProjection,
        platform: params.platform,
    });
    const profile = useProfile();

    const profileId = readProfileId(profile);
    const derivedObservabilityScope = React.useMemo<PeerMediationObservabilityScopeV1 | null>(() => {
        if (!pluginRuntime.machineId || !profileId) {
            return null;
        }
        return {
            kind: 'machine',
            accountId: profileId,
            machineId: pluginRuntime.machineId,
        };
    }, [pluginRuntime.machineId, profileId]);

    return React.useMemo(() => ({
        ...pluginRuntime,
        peerMediationObservabilityScope:
            params.peerMediationObservabilityScope !== undefined
                ? params.peerMediationObservabilityScope
                : derivedObservabilityScope,
    }), [
        derivedObservabilityScope,
        params.peerMediationObservabilityScope,
        pluginRuntime,
    ]);
}
