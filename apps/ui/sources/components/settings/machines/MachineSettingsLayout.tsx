import * as React from 'react';

import { SettingsCollectionLayout } from '@/components/settings/shell/SettingsCollectionLayout';

import { MachineCollectionRail } from './collection/MachineCollectionList';
import { MACHINES_COLLECTION_ROOT } from './collection/machineCollectionModel';
import { MachinesRelayDriftBanner } from './MachinesRelayDriftBanner';

/** Rail width at normal text scale: a device mark, a machine name and one status line. */
const MACHINE_RAIL_WIDTH_PX = 272;
/** The narrowest detail that still fits a machine's launch path field beside its label. */
const MACHINE_DETAIL_MIN_WIDTH_PX = 480;

function resolveMachinesChildRoute(pathname: string): string {
    if (pathname === MACHINES_COLLECTION_ROOT) return 'index';
    const rest = pathname.slice(MACHINES_COLLECTION_ROOT.length + 1);
    if (rest === 'add' || rest === 'this-computer' || rest === 'defaults' || rest === 'pools/new') return rest;
    if (rest.startsWith('add/')) return 'add/[provisioner]';
    if (rest === 'presets/new') return 'presets/new';
    if (rest.startsWith('presets/')) return 'presets/[presetId]';
    if (rest.startsWith('pools/')) return 'pools/[poolId]';
    if (rest.startsWith('managed/')) return 'managed/[id]';
    return '[id]';
}

/**
 * Machines as a collection beside the selected detail: a machine, this computer (desktop app), a
 * machine pool, or adding a machine. Narrow: the list page pushes each detail.
 */
export const MachineSettingsLayout = React.memo(function MachineSettingsLayout() {
    return (
        <SettingsCollectionLayout
            navigator="machines"
            rootPathname={MACHINES_COLLECTION_ROOT}
            resolveChildRoute={resolveMachinesChildRoute}
            rail={<MachineCollectionRail />}
            railWidthPx={MACHINE_RAIL_WIDTH_PX}
            detailMinWidthPx={MACHINE_DETAIL_MIN_WIDTH_PX}
            testID="settings-machines"
            detailTop={<MachinesRelayDriftBanner />}
        />
    );
});
