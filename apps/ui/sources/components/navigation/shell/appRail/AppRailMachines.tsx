import * as React from 'react';

import { describeMachinePresenceCounts } from '@/components/machines/MachinePresenceCounts';
import { useMachinePresenceCounts } from '@/sync/domains/state/storage';
import { t } from '@/text';

import { SidebarFooterPopoverButton, type SidebarFooterPopoverContentProps, type SidebarFooterPopoverTrigger } from '../sidebarFooter/SidebarFooterPopoverButton';
import { SidebarMachinesPopoverContent } from '../sidebarFooter/SidebarMachinesPopoverContent';
import { APP_RAIL_ICON_GLYPH_SIZE_PX, APP_RAIL_ITEM_SIZE_PX } from './appRailMetrics';

const renderMachines = (content: SidebarFooterPopoverContentProps) => <SidebarMachinesPopoverContent {...content} />;

/**
 * The rail's Machines icon (lab `hmachines-M3`). Closed, it reads only the online/offline counts —
 * a heartbeat that leaves them unchanged renders nothing — and names them in its tooltip
 * ("Machines · 2 online · 1 offline"). It carries no badge: a machine that is merely offline does
 * not need the person, and no machine problem that does (signed out, setup failed, too old to run
 * sessions) has a producer yet. The machine list mounts only in the open popover.
 */
export const AppRailMachines = React.memo(function AppRailMachines(props: Readonly<{ renderTrigger?: SidebarFooterPopoverTrigger }>) {
    const counts = useMachinePresenceCounts();
    const presence = describeMachinePresenceCounts(counts);
    const title = t('settings.machines');
    return (
        <SidebarFooterPopoverButton
            testID="app-rail-machines"
            iconName="desktop"
            label={presence ? `${title} · ${presence}` : title}
            placement="right"
            buttonSizePx={APP_RAIL_ITEM_SIZE_PX}
            iconSizePx={APP_RAIL_ICON_GLYPH_SIZE_PX}
            renderContent={renderMachines}
            renderTrigger={props.renderTrigger}
        />
    );
});
