import * as React from 'react';
import { PluginAgentSettingsLaunchInputV1Schema, PluginUiJsonValueV1Schema } from '@happier-dev/protocol/plugins/ui';
import { useAppShellPluginUiProjectionCurrentness } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { PluginInlineSurfaceHost } from '@/components/plugins/surfaces/PluginSurfaceHost';
import type { PluginSettingsAccountContentProjection } from '@/components/settings/plugins/detail/PluginDetailGenericSettingsSection';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import type { PluginUiInlineSurfacePlacementProjection } from '@/sync/domains/plugins/ui/projection';
import { selectPluginInlineSurfacePlacementsForRole } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { storage } from '@/sync/domains/state/storage';
import { resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { getMachineDisplayName, isMachineOnline } from '@/utils/sessions/machineUtils';

function record(value: unknown): Readonly<Record<string, unknown>> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>> : {};
}
function json(value: unknown) {
    const parsed = PluginUiJsonValueV1Schema.safeParse(value);
    return parsed.success ? parsed.data : null;
}
function finite(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

type AgentSettingsInlineSurfacesProps = Readonly<{
    pluginId: string;
    agentId: string;
    account: PluginSettingsAccountContentProjection;
}>;

/** Only a declared consumer subscribes to pushed Account/machine facts. */
export const AgentSettingsInlineSurfaces = React.memo(function AgentSettingsInlineSurfaces(props: AgentSettingsInlineSurfacesProps) {
    const currentness = useAppShellPluginUiProjectionCurrentness();
    const placements = React.useMemo(() => currentness.pluginUiProjection ? selectPluginInlineSurfacePlacementsForRole(
        currentness.pluginUiProjection, 'agentSettings',
    ).filter(placement => placement.binding.surface.pluginId === props.pluginId) : [], [currentness.pluginUiProjection, props.pluginId]);
    return placements.length === 0 ? null : <AgentSettingsInlineSurfaceContent {...props}
        placements={placements} currentness={currentness} />;
});

function AgentSettingsInlineSurfaceContent(props: AgentSettingsInlineSurfacesProps & Readonly<{
    placements: readonly PluginUiInlineSurfacePlacementProjection[];
    currentness: ReturnType<typeof useAppShellPluginUiProjectionCurrentness>;
}>) {
    const { currentness } = props;
    useActiveServerSnapshot();
    const machines = storage(state => resolveVisibleMachinesForActiveServerFromState(state));
    const presenceNowMs = useMachinePresenceNowMs(machines);
    const machineFacts = React.useMemo(() => machines.map(machine => {
        const state = record(machine.daemonState);
        return {
            id: machine.id,
            displayName: getMachineDisplayName(machine) ?? machine.id,
            online: isMachineOnline(machine, presenceNowMs),
            pid: finite(state.pid),
            startedAt: finite(state.startedAt),
            cliVersion: machine.metadata?.happyCliVersion ?? null,
            source: json(state.providerSettingsSourceV1),
            report: json(record(state.providerSettingsV1)[props.agentId]),
        };
    }), [machines, props.agentId, presenceNowMs]);
    const launchInput = React.useMemo(() => PluginAgentSettingsLaunchInputV1Schema.parse({
        agentId: props.agentId,
        account: {
            ...props.account,
            values: Object.fromEntries(Object.entries(props.account.values).flatMap(([key, value]) => {
                const parsed = PluginUiJsonValueV1Schema.safeParse(value);
                return parsed.success ? [[key, parsed.data]] : [];
            })),
        },
        machines: machineFacts,
    }), [machineFacts, props.account, props.agentId]);
    const isHostCurrent = React.useCallback(() => currentness.interactionEnabled
        && currentness.accountLifetime?.isCurrent() === true,
    [currentness.accountLifetime, currentness.interactionEnabled]);
    return <>{props.placements.map(placement => <PluginInlineSurfaceHost key={placement.id}
        placement={placement} inlineMount={{ role: 'agentSettings', presentation: 'content' }}
        agentId={props.agentId} machineId={currentness.machineId} serverId={currentness.serverId}
        pluginUiProjection={currentness.pluginUiProjection} launchInput={launchInput}
        projectionInteractionEnabled={currentness.interactionEnabled} isHostCurrent={isHostCurrent} />)}</>;
}
