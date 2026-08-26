import * as React from 'react';
import type { PluginUiJsonValueV1 } from '@happier-dev/protocol/plugins/ui';

import { PluginInlineSurfaceHost, type PluginInlineSurfaceMountV1 } from '@/components/plugins/surfaces';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { selectPluginInlineSurfacePlacementsBySurface } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';

export function AgentInlineSurface(props: Readonly<{
    pluginId: string;
    surfaceId: string;
    sessionId: string;
    machineId?: string | null;
    agentId?: string | null;
    inlineMount: PluginInlineSurfaceMountV1;
    launchInput?: PluginUiJsonValueV1;
}>): React.ReactElement | null {
    const current = useScopedPluginUiProjection({ machineId: props.machineId });
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
