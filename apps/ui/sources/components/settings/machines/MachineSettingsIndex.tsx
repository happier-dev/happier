import * as React from 'react';
import { Redirect } from '@/components/appShell/workspace/destinationRoute';

import { isDesktopHost } from '@/utils/platform/desktopHost';

import { buildMachineCollection, resolveMachineCollectionLandingHref } from './collection/machineCollectionModel';
import { readLastVisitedMachine } from './collection/machineCollectionVisit';
import { useMachinesSettingsViewModel } from './machinesSettingsViewModel';
import { MachinesSettingsView } from './MachinesSettingsView';
import { useHappierCollectionIndexView } from '@happier-dev/plugin-ui/presentation';

/**
 * `/settings/machines`. Beside the rail something is always selected, so the index lands on the last
 * opened machine, the first machine, this computer, or adding a machine; where no rail shows, the
 * index is the machine list and each row pushes its detail.
 */
export const MachineSettingsIndex = React.memo(function MachineSettingsIndex() {
    const view = useHappierCollectionIndexView();
    if (view === 'pending') return null;
    if (view === 'land') return <MachineCollectionLanding />;
    return <MachinesSettingsView />;
});

const MachineCollectionLanding = React.memo(function MachineCollectionLanding() {
    const viewModel = useMachinesSettingsViewModel();
    // Wait for the first machine list so "first machine" is not a guess.
    if (viewModel.isLoadingMachines) return null;
    const href = resolveMachineCollectionLandingHref({
        collection: buildMachineCollection({
            groups: viewModel.visibleMachineGroups,
            groupedByHome: viewModel.showMachinesGroupedByServer,
            managedByServerId: viewModel.managedByServerId,
        }),
        lastVisited: readLastVisitedMachine(),
        isDesktop: isDesktopHost(),
    });
    return <Redirect href={href as never} />;
});
