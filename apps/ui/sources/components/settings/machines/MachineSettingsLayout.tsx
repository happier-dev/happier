import * as React from 'react';

import { usePathname } from '@/components/appShell/workspace/destinationRoute';
import { SettingsCollectionLayout } from '@/components/settings/shell/SettingsCollectionLayout';

import { MachineCollectionRail } from './collection/MachineCollectionList';
import { MACHINES_COLLECTION_ROOT, MACHINES_RAIL_ROOT } from './collection/machineCollectionModel';
import { MachinesRelayDriftBanner } from './MachinesRelayDriftBanner';
import { useMachinesDoor } from '@/components/machines/page/machinesDoor';

/** The narrowest detail that still fits a machine's launch path field beside its label. */
const MACHINE_DETAIL_MIN_WIDTH_PX = 480;

function resolveMachinesChildRoute(pathname: string): string {
    const root = pathname.startsWith(MACHINES_COLLECTION_ROOT) ? MACHINES_COLLECTION_ROOT : MACHINES_RAIL_ROOT;
    if (pathname === root) return 'index';
    const rest = pathname.slice(root.length + 1);
    if (rest === 'add' || rest === 'this-computer' || rest === 'defaults' || rest === 'pools/new') return rest;
    if (rest.startsWith('add/')) return 'add/[provisioner]';
    if (rest === 'presets/new') return 'presets/new';
    if (rest.startsWith('presets/')) return 'presets/[presetId]';
    if (rest.startsWith('pools/')) return 'pools/[poolId]';
    if (rest.startsWith('managed/')) return 'managed/[id]';
    return rest.includes('/') ? '[id]/[page]' : '[id]/index';
}

/**
 * Machines as a collection beside the selected detail: a machine, this computer (desktop app), a
 * machine pool, or adding a machine. Narrow: the list page pushes each detail.
 */
export const MachineSettingsLayout = React.memo(function MachineSettingsLayout() {
    const settings = useMachinesDoor() === 'settings';
    // Configuring a new machine is one focused task: its choices and receipt take the whole pane, as in lab
    // m-config, so the size table keeps its rate columns beside the receipt. The breadcrumb-style back leads out.
    const configuring = resolveMachinesChildRoute(usePathname().replace(/\/+$/, '')) === 'add/[provisioner]';
    return (
        <SettingsCollectionLayout
            navigator="machines"
            rootPathname={settings ? MACHINES_COLLECTION_ROOT : MACHINES_RAIL_ROOT}
            resolveChildRoute={resolveMachinesChildRoute}
            rail={settings && !configuring ? <MachineCollectionRail /> : null}
            railWidth="standard"
            detailMinWidthPx={MACHINE_DETAIL_MIN_WIDTH_PX}
            testID="settings-machines"
            detailTop={settings ? <MachinesRelayDriftBanner /> : null}
        />
    );
});
