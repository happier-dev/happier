import * as React from 'react';

import type { PluginProjectionEntry } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { PluginDetailGenericSettingsSection } from '@/components/settings/plugins/detail/PluginDetailGenericSettingsSection';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { isAdministrationScopedPluginSettingsTargetCurrent } from '@/sync/domains/machines/administration/scopedPluginSettingsTarget';
import type {
    FreshMachineAdministrationExecutionTargetV1,
    MachineAdministrationTargetSelectionV1,
} from '@/sync/domains/machines/administration/useTargetSelection';
import type { ScopedPluginSettingsTarget } from '@/sync/domains/plugins/settings/scopedPluginSettingsAdapter';
import { resolveScopedPluginSettingsServerIdentity } from '@/sync/domains/plugins/settings/scopedPluginSettingsRuntime';

/** A missing machine is not a different Account; a foreign target remains unavailable. */
export function areAgentAccountSettingsAvailable(selection: Pick<
    MachineAdministrationTargetSelectionV1,
    'selectedTarget' | 'selectedTargetServerMatchesActiveAccount'
>): boolean {
    return selection.selectedTarget === null || selection.selectedTargetServerMatchesActiveAccount;
}

/** Both Agent presentations share this Account/daemon settings admission owner. */
export const AgentContributedSettingsSection = React.memo(function AgentContributedSettingsSection(props: Readonly<{
    pluginSettingsProjection: PluginProjectionEntry | null;
    targetSelection: MachineAdministrationTargetSelectionV1;
    executionTarget: FreshMachineAdministrationExecutionTargetV1 | null;
    daemonOperationsAvailable: boolean;
}>) {
    const { pluginSettingsProjection, targetSelection, executionTarget, daemonOperationsAvailable } = props;
    const activeServer = useActiveServerSnapshot();
    const accountServerIdentityId = React.useMemo(
        () => resolveScopedPluginSettingsServerIdentity(activeServer.serverId),
        [activeServer.serverId],
    );
    const isDaemonSettingsTargetCurrent = React.useCallback((target: Extract<ScopedPluginSettingsTarget, { kind: 'daemon' }>) => (
        isAdministrationScopedPluginSettingsTargetCurrent({
            target,
            expectedExecutionTarget: executionTarget,
            resolveCurrentExecutionTarget: targetSelection.resolveExecutionTarget,
        })
    ), [executionTarget, targetSelection.resolveExecutionTarget]);
    if (!pluginSettingsProjection) return null;
    return (
        <PluginDetailGenericSettingsSection
            pluginId={pluginSettingsProjection.pluginId}
            projection={pluginSettingsProjection}
            machineId={executionTarget?.machine.id ?? null}
            serverId={executionTarget?.serverId ?? null}
            accountServerIdentityId={accountServerIdentityId}
            daemonServerIdentityId={executionTarget?.target.serverIdentityId ?? null}
            perActiveServerIdentityId={targetSelection.selectedTarget?.serverIdentityId ?? accountServerIdentityId}
            accountOperationsAvailable={areAgentAccountSettingsAvailable(targetSelection)}
            daemonOperationsAvailable={daemonOperationsAvailable}
            isDaemonTargetCurrent={isDaemonSettingsTargetCurrent}
        />
    );
});
