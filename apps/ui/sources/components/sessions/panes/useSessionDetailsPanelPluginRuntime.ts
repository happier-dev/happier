import * as React from 'react';

import type { PeerMediationObservabilityScopeV1 } from '@happier-dev/protocol';

import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import { resolveLocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/platform';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginBrowserProjectionModel } from '@/sync/domains/plugins/browser/targets';
import { useProfile } from '@/sync/store/hooks';

export type SessionDetailsPanelPluginRuntimeState = Readonly<{
    pluginUiProjection: PluginUiProjectionModel | null;
    pluginBrowserProjection: PluginBrowserProjectionModel | null;
    interactionEnabled: boolean;
    peerMediationObservabilityScope: PeerMediationObservabilityScopeV1 | null;
    platform: LocalServicePreviewPlatform;
    machineId: string | null;
    serverId: string | null;
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
    pluginUiProjection?: PluginUiProjectionModel | null;
    peerMediationObservabilityScope?: PeerMediationObservabilityScopeV1 | null;
    platform?: LocalServicePreviewPlatform;
}>): SessionDetailsPanelPluginRuntimeState {
    const machineTarget = useSessionMachineTarget(params.sessionId);
    const serverId = usePreferredServerIdForSession(params.sessionId);
    const profile = useProfile();
    const scopedProjection = useScopedPluginUiProjection({
        machineId: machineTarget?.machineId ?? null,
        serverId,
    });
    const explicitProjectionProvided = params.pluginUiProjection !== undefined;
    const pluginUiProjection = explicitProjectionProvided
        ? params.pluginUiProjection ?? null
        : scopedProjection.pluginUiProjection;
    const pluginBrowserProjection = scopedProjection.pluginBrowserProjection;

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
        interactionEnabled: scopedProjection.interactionEnabled,
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
        scopedProjection.interactionEnabled,
        serverId,
    ]);
}
