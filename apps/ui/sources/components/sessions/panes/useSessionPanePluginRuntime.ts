import * as React from 'react';

import type { PaneSurfaceScope } from '@/components/appShell/panes/types';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { resolveLocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/platform';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';

export type SessionPaneSurfaceScope = Extract<PaneSurfaceScope, Readonly<{ targetKind: 'session' }>>;

export type SessionPanePluginRuntimeState = PluginUiProjectionCurrentness;

/**
 * Resolves Session pane plugin facts at the one AppPane handoff boundary.
 * Driver-rendered panes consume their exact registered scope; direct screens
 * omit it and retain the incumbent Session lookup. A supplied stale or wrong
 * scope is unavailable, never permission to reconstruct a competing target.
 */
export function useSessionPanePluginRuntime(params: Readonly<{
    sessionId: string;
    paneSurfaceScope?: SessionPaneSurfaceScope;
    pluginUiProjection?: PluginUiProjectionModel | null;
    platform?: LocalServicePreviewPlatform;
}>): SessionPanePluginRuntimeState {
    const machineTarget = useSessionMachineTarget(params.sessionId);
    const preferredServerId = usePreferredServerIdForSession(params.sessionId);
    const hasRegisteredPaneScope = params.paneSurfaceScope !== undefined;
    const registeredPaneScope =
        params.paneSurfaceScope?.targetKind === 'session'
        && params.paneSurfaceScope.sessionId === params.sessionId
            ? params.paneSurfaceScope
            : null;
    const directMachineId = machineTarget?.machineId ?? null;
    const directServerId = preferredServerId;
    // Keep the direct-route hooks unconditional. Once AppPane passes a scope,
    // disable their projection path entirely: its target is null, so the
    // currentness owner cannot subscribe, describe, or settle a second local
    // snapshot. Every registered-pane fact below instead comes from the exact
    // driver snapshot AppPane admitted.
    const scopedProjection = useScopedPluginUiProjection(hasRegisteredPaneScope
        ? { machineId: null, serverId: null, enabled: false }
        : { machineId: directMachineId, serverId: directServerId });
    const machineId = hasRegisteredPaneScope
        ? registeredPaneScope?.machineId ?? null
        : directMachineId;
    const serverId = hasRegisteredPaneScope
        ? registeredPaneScope?.serverId ?? null
        : directServerId;
    const explicitProjectionProvided = params.pluginUiProjection !== undefined;
    const pluginUiProjection = hasRegisteredPaneScope
        ? registeredPaneScope?.pluginUiProjection ?? null
        : explicitProjectionProvided
            ? params.pluginUiProjection ?? null
            : scopedProjection.pluginUiProjection;
    const interactionEnabled = hasRegisteredPaneScope
        ? registeredPaneScope?.interactionEnabled === true
        : scopedProjection.interactionEnabled;
    const phase = hasRegisteredPaneScope
        ? registeredPaneScope?.projectionPhase ?? 'unavailable'
        : scopedProjection.phase;
    const pluginBrowserProjection = hasRegisteredPaneScope
        ? registeredPaneScope?.pluginBrowserProjection ?? null
        : scopedProjection.pluginBrowserProjection;
    const platform = resolveLocalServicePreviewPlatform(
        hasRegisteredPaneScope ? registeredPaneScope?.platform : params.platform,
    );

    return React.useMemo(() => ({
        pluginUiProjection,
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
        pluginUiProjection,
        pluginBrowserProjection,
        serverId,
    ]);
}
