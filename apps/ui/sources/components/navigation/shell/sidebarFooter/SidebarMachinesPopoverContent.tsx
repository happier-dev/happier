import * as React from 'react';
import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

import { NewSessionMachineSelectionContent } from '@/components/sessions/new/components/NewSessionMachineSelectionContent';
import type {
    MachineSelectionAvailability,
    ScopedSelectionMachine,
    ServerScopedMachinePoolSelection,
} from '@/components/sessions/new/components/machineSelection/useMachineSelectionListModel';
import { useMachinePoolGroups } from '@/components/sessions/new/hooks/machines/useMachinePoolGroups';
import type { ServerScopedMachineGroup } from '@/components/sessions/new/hooks/machines/useServerScopedMachineOptions';
import {
    MACHINES_ADD_ROUTE,
    machineCollectionHref,
    machinePoolCollectionHref,
} from '@/components/settings/machines/collection/machineCollectionModel';
import { useMachineAddOptions } from '@/components/settings/machines/collection/useMachineAddOptions';
import { useMachinesSettingsViewModel } from '@/components/settings/machines/machinesSettingsViewModel';
import { MachinePresenceCounts } from '@/components/machines/MachinePresenceCounts';
import { Icon } from '@/components/ui/icons/Icon';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { t } from '@/text';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { countMachinePresence, isMachineOnline } from '@/utils/sessions/machineUtils';
import { fireAndForget } from '@/utils/system/fireAndForget';

import { RailPopoverRoster, resolveRailPopoverRosterListMaxHeight } from './RailPopoverRoster';
import type { SidebarFooterPopoverContentProps } from './SidebarFooterPopoverButton';

type PopoverMachine = ScopedSelectionMachine<Machine>;

const NO_PINNED_MACHINES: readonly PopoverMachine[] = [];

/**
 * The sidebar Machines popover: the machines and pools of the Homes the app shows, from the store
 * (no machine RPC), in the one machine list new session uses. A machine or pool opens its Settings
 * page; the rows beneath add a machine or a pool there. Mounted only while the popover is open.
 */
export function SidebarMachinesPopoverContent(props: SidebarFooterPopoverContentProps) {
    const { theme } = useUnistyles();
    const router = useRouter();
    const model = useMachinesSettingsViewModel();
    const groups = React.useMemo((): ServerScopedMachineGroup<PopoverMachine>[] => model.visibleMachineGroups.map((group) => ({
        serverId: group.serverId,
        serverName: group.serverName,
        machines: group.machines.map((machine) => ({ ...machine, serverId: group.serverId, serverName: group.serverName })),
        loading: group.status === 'loading',
        signedOut: group.status === 'signedOut',
        error: group.status === 'error',
    })), [model.visibleMachineGroups]);
    const poolGroups = useMachinePoolGroups(groups);
    const addOptions = useMachineAddOptions(model.visibleMachineGroups);
    const addPool = addOptions.find((option) => option.id === 'pool') ?? null;

    // The machines this popover lists, counted by the one presence owner (the rail's tooltip and
    // Home's Machines section count the same way).
    const counts = React.useMemo(() => countMachinePresence(groups.flatMap((group) => group.machines)), [groups]);
    const total = counts.online + counts.offline;

    const open = React.useCallback((href: string, tag: string) => {
        props.close();
        const result = runGuardedNavigation(() => router.push(href as never));
        if (result !== true) fireAndForget(result, { tag });
    }, [props, router]);
    const openMachine = React.useCallback((machine: PopoverMachine) => {
        open(machineCollectionHref({ machineId: machine.id, serverId: machine.serverId }), 'SidebarMachines.openMachine');
    }, [open]);
    const openPool = React.useCallback((selection: ServerScopedMachinePoolSelection) => {
        open(machinePoolCollectionHref({ poolId: selection.pool.pool.id, serverId: selection.serverId }), 'SidebarMachines.openPool');
    }, [open]);
    // Every machine opens its page, online or not; offline ones still say so.
    const resolveMachineAvailability = React.useCallback((machine: PopoverMachine): MachineSelectionAvailability => ({
        selectable: true,
        detail: isMachineOnline(machine) ? t('status.online') : t('status.offline'),
    }), []);

    const iconColor = theme.colors.text.secondary;
    return (
        <RailPopoverRoster
            testID="sidebar-machines-popover-content"
            title={t('settings.machines')}
            summary={<MachinePresenceCounts testID="sidebar-machines-presence" counts={counts} />}
            actions={[
                {
                    id: 'add-machine',
                    testID: 'sidebar-machines-add-machine',
                    label: t('settings.addMachine'),
                    icon: <Icon name="plus" size={16} color={iconColor} />,
                    onPress: () => open(MACHINES_ADD_ROUTE, 'SidebarMachines.addMachine'),
                },
                addPool ? {
                    id: 'add-pool',
                    testID: 'sidebar-machines-add-pool',
                    label: addPool.title,
                    icon: <Icon name="plus" size={16} color={iconColor} />,
                    onPress: () => open(addPool.href, 'SidebarMachines.addPool'),
                } : null,
            ]}
        >
            {total > 0 || poolGroups.some((group) => group.pools.length > 0) ? (
                <NewSessionMachineSelectionContent<PopoverMachine>
                    groups={groups}
                    poolGroups={poolGroups}
                    selectedMachine={null}
                    selectedServerId={null}
                    recentMachines={NO_PINNED_MACHINES}
                    favoriteMachines={NO_PINNED_MACHINES}
                    onSelectMachine={openMachine}
                    onSelectScopedMachine={openMachine}
                    onSelectPool={openPool}
                    resolveMachineAvailability={resolveMachineAvailability}
                    showFavorites={false}
                    showRecent={false}
                    showSearch={false}
                    showCliGlyphs={false}
                    autoDetectCliGlyphs={false}
                    testIdPrefix="sidebar-machines"
                    testID="sidebar-machines-list"
                    maxHeight={resolveRailPopoverRosterListMaxHeight(props.maxHeight)}
                />
            ) : null}
        </RailPopoverRoster>
    );
}
