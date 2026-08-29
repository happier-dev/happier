import * as React from 'react';
import type { PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';

import { PluginInlineSurfaceHost, type PluginInlineSurfaceMountV1 } from '@/components/plugins/surfaces';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { selectPluginInlineSurfacePlacementsBySurface } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useSessionServerId } from '@/sync/store/hooks';

export function AgentInlineSurface(props: Readonly<{
    pluginId: string;
    surfaceId: string;
    sessionId: string;
    /** Route-scoped server identity may be supplied by a details owner. */
    serverId?: string | null;
    agentId?: string | null;
    inlineMount: PluginInlineSurfaceMountV1;
    launchInput?: PluginUiJsonValueV1;
}>): React.ReactElement | null {
    // Inline surfaces are children of the live Session owner. Never trust a
    // machine id serialized into a launch card/details resource: a Session can
    // be handed off while a retained details tree remains mounted. The existing
    // Session target hook is the canonical machine owner; the Session server
    // hook provides the matching server scope.
    const sessionTarget = useSessionMachineTarget(props.sessionId);
    const sessionServerId = useSessionServerId(props.sessionId);
    const current = useScopedPluginUiProjection({
        machineId: sessionTarget?.machineId ?? null,
        serverId: sessionServerId ?? props.serverId,
    });
    const placements = current.pluginUiProjection
        ? selectPluginInlineSurfacePlacementsBySurface(current.pluginUiProjection, {
            pluginId: props.pluginId,
            localId: props.surfaceId,
        }, props.inlineMount.role)
        : [];
    const placement = placements.length === 1 ? placements[0] : null;
    if (!placement) return null;
    return (
        <PluginInlineSurfaceHost
            placement={placement}
            inlineMount={props.inlineMount}
            sessionId={props.sessionId}
            machineId={current.machineId}
            serverId={current.serverId}
            agentId={props.agentId}
            pluginUiProjection={current.pluginUiProjection}
            platform={current.platform}
            projectionInteractionEnabled={current.interactionEnabled}
            launchInput={props.launchInput}
        />
    );
}
