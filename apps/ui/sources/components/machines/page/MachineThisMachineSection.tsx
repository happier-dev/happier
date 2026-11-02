import * as React from 'react';
import { View } from 'react-native';

import { useMachineAgents } from '@/agents/machineAgents/useMachineAgents';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { readCachedMachineDoctorSnapshot } from '@/components/machines/doctorSnapshot/machineDoctorSnapshotCache';
import { machinePageHref } from '@/components/settings/machines/collection/machineCollectionModel';
import { useMachineDirectConnectionSummary } from '@/components/settings/connections/DirectConnectionSettings';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { useSetting } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { resolveTerminalHost } from '@/sync/domains/settings/terminalSettings';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';
import { formatOSPlatform } from '@/utils/sessions/sessionUtils';
import { readComputerUseSettingsForMachine } from '@happier-dev/protocol/computer/v1';

import { useMachinesDoor } from './machinesDoor';
import {
    describeMachineAgentsReady,
    describeMachineComputerUse,
    describeMachineDoctorSummary,
    describeMachineSharingSummary,
    describeMachineTerminalHost,
} from './machineThisMachineSummaries';
import { MACHINE_THIS_MACHINE_PAGES, MACHINE_SUB_PAGE_TITLE_KEYS, type MachineThisMachinePageId } from './machineSubPages';

const ROW_ICONS: Readonly<Record<MachineThisMachinePageId, IconName>> = {
    sharing: 'users',
    agents: 'sparkle',
    terminal: 'terminal',
    computer: 'cursor',
    connection: 'arrows-left-right',
    security: 'shield',
    installables: 'cube',
    doctor: 'first-aid-kit',
    details: 'info',
};

/**
 * "This machine" (lab `R`, `DD`): the machine's own settings and diagnostics, one row each, every row
 * a pushed sub-page in the door the page was opened through. Each summary line is a fact the section's owner
 * already holds; a row with none is its title alone, so the Overview never asks the machine for something only a
 * sub-page shows.
 */
export const MachineThisMachineSection = React.memo(function MachineThisMachineSection(props: Readonly<{
    serverId: string;
    machine: Machine;
}>) {
    const language = usePreferredLanguage();
    const router = useRouter();
    const door = useMachinesDoor();
    const machineId = props.machine.id;
    const agents = useMachineAgents({ serverId: props.serverId, machineId, load: false });
    const sessionTerminalHost = useSetting('sessionTerminalHost');
    const sessionUseTmux = useSetting('sessionUseTmux');
    const sessionTmuxByMachineId = useSetting('sessionTmuxByMachineId');
    const sessionTerminalHostByMachineId = useSetting('sessionTerminalHostByMachineId');
    const computerUseByMachineId = useSetting('computerUseByMachineId');
    const settings = { sessionTerminalHost, sessionUseTmux, sessionTmuxByMachineId, sessionTerminalHostByMachineId };
    const terminalHost = resolveTerminalHost({ settings, machineId });
    const connection = useMachineDirectConnectionSummary(machineId);
    const doctor = React.useMemo(() => readCachedMachineDoctorSnapshot({ serverId: props.serverId, machineId }), [machineId, props.serverId]);
    const agentsReady = React.useMemo(
        () => describeMachineAgentsReady(agents.agents.filter((agent) => agent.state === 'ready' || agent.state === 'updateAvailable').map((agent) => agent.title)),
        [language, agents.agents],
    );
    const platform = formatOSPlatform(props.machine.metadata?.platform);
    const host = props.machine.metadata?.host?.trim();

    // Plan 10 MPG-10: a summary is a fact already held (cached or in settings), never a description. A row with no
    // fact yet is its title alone, and the line appears when the cache has state; nothing here fetches.
    const summaries: Readonly<Record<MachineThisMachinePageId, string | undefined>> = {
        sharing: describeMachineSharingSummary(props.machine),
        agents: agentsReady ?? undefined,
        terminal: describeMachineTerminalHost(terminalHost),
        computer: describeMachineComputerUse(readComputerUseSettingsForMachine({ computerUseByMachineId }, machineId)),
        connection,
        // Updates are read only while Security is open (Plan 10: no detail subscription while closed).
        security: undefined,
        installables: undefined,
        doctor: describeMachineDoctorSummary(doctor),
        details: [host, platform].filter(Boolean).join(' · ') || undefined,
    };

    const open = (page: MachineThisMachinePageId) => {
        router.push(machinePageHref({ door, target: { machineId, serverId: props.serverId }, page }) as never);
    };

    return (
        <View testID="machine-page-this-machine">
            <ItemGroup title={t('machineDetailPage.thisMachineTitle')}>
                {MACHINE_THIS_MACHINE_PAGES.map((page) => (
                    <Item
                        key={page}
                        testID={`machine-page-row-${page}`}
                        title={t(MACHINE_SUB_PAGE_TITLE_KEYS[page])}
                        subtitle={summaries[page]}
                        icon={<Icon name={ROW_ICONS[page]} />}
                        showChevron
                        onPress={() => open(page)}
                    />
                ))}
            </ItemGroup>
        </View>
    );
});
