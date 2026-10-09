import * as React from 'react';

import type { IconName } from '@/components/ui/icons/Icon';
import { useMachineAddPaths } from '@/components/machines/add/useMachineAddPaths';
import { useMachinePoolProjections } from '@/sync/engine/machines/useMachinePoolProjections';
import { t } from '@/text';

import type { ActiveSelectionMachineGroup } from '../hooks/useActiveSelectionMachineGroups';
import { MACHINES_ADD_ROUTE } from './machineCollectionModel';

export type MachineAddOptionId = 'machine' | 'pool' | 'preset';

export type MachineAddOption = Readonly<{
    id: MachineAddOptionId;
    title: string;
    subtitle: string;
    icon: IconName;
    /** The collection page it opens: the add-a-machine draft, or a pool draft. */
    href: string;
    /** Whether the destination is a page of the Machines collection (it replaces the open detail). */
    inCollection: boolean;
}>;

/**
 * What the Machines collection's "+" offers (lab `add-flows` MS): add a machine — its draft, whose
 * form offers only the ways this device can run (`useMachineAddPaths`) — and create a machine pool on a
 * Home that supports pools. Nothing here decides a way to add a machine.
 */
export function useMachineAddOptions(groups: readonly ActiveSelectionMachineGroup[]): readonly MachineAddOption[] {
    const paths = useMachineAddPaths();
    const projections = useMachinePoolProjections(groups);
    const poolServerIdsKey = projections
        .filter((projection) => projection?.featureStatus === 'enabled')
        .map((projection) => projection!.serverId)
        .join('\u0000');
    const canAddMachine = paths.length > 0;
    const presetServerIdsKey = groups.filter(group => group.status !== 'signedOut').map(group => group.serverId).join('\u0000');

    return React.useMemo(() => {
        const options: MachineAddOption[] = [];
        if (canAddMachine) {
            options.push({
                id: 'machine',
                title: t('settings.addMachine'),
                subtitle: t('addFlows.addMachineMenuSubtitle'),
                icon: 'plus',
                href: MACHINES_ADD_ROUTE,
                inCollection: true,
            });
        }
        const presetServerIds = presetServerIdsKey ? presetServerIdsKey.split('\u0000') : [];
        if (presetServerIds.length > 0) options.push({ id: 'preset', title: t('machinePresets.newPreset'),
            subtitle: t('machinePresets.empty'), icon: 'stack',
            href: presetServerIds.length === 1 ? `/settings/machines/presets/new?serverId=${encodeURIComponent(presetServerIds[0]!)}`
                : '/settings/machines/presets/new', inCollection: true });
        const serverIds = poolServerIdsKey ? poolServerIdsKey.split('\u0000') : [];
        if (serverIds.length > 0) {
            options.push({
                id: 'pool',
                title: t('machinePools.add'),
                subtitle: t('machinePools.benefit'),
                icon: 'stack',
                // With one Home the pool is created there; otherwise the editor asks which Home.
                href: serverIds.length === 1
                    ? `/settings/machines/pools/new?serverId=${encodeURIComponent(serverIds[0]!)}`
                    : '/settings/machines/pools/new',
                inCollection: true,
            });
        }
        return options;
    }, [canAddMachine, poolServerIdsKey, presetServerIdsKey]);
}
