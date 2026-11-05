import * as React from 'react';
import type { DetailPageNavigationItem } from '@/components/appShell/rightSidebar/detailNavigationItems';
import { MACHINE_PHONE_NAVIGATION_ADDRESS } from '@/components/machines/page/machineNavigation';
import { resolveMachineNavigationCustomizer } from '@/components/machines/page/machineNavigationCustomizer';
import { CockpitTabBar } from './CockpitTabBar';
import { detailNavigationTab, useDetailPhoneBarPresentation, useDetailPhonePlacement } from './detailPhoneNavigation';

export type MachineCockpitTabBarProps = Readonly<{
    machineId: string; items: readonly DetailPageNavigationItem[]; activeId: string; onSelect: (id: string) => void;
}>;

export const machineNavigationTab = detailNavigationTab;

export function useMachineCockpitBarPresentation(props: MachineCockpitTabBarProps, native = false) {
    const placement = useDetailPhonePlacement(props.items, MACHINE_PHONE_NAVIGATION_ADDRESS, 'machine');
    const customizer = React.useMemo(() => resolveMachineNavigationCustomizer({ items: props.items, device: 'phone' }), [props.items]);
    const presentation = useDetailPhoneBarPresentation({ items: props.items, placement, address: MACHINE_PHONE_NAVIGATION_ADDRESS,
        pageKind: 'machine', activeId: props.activeId, select: props.onSelect, customizer, native });
    return { ...placement, ...presentation };
}

export const MachineCockpitTabBar = React.memo(function MachineCockpitTabBar(props: MachineCockpitTabBarProps) {
    const presentation = useMachineCockpitBarPresentation(props);
    return <CockpitTabBar activeSurface={props.activeId} barTestId={`machine-cockpit-tabbar-${props.machineId}`}
        tabs={presentation.shown.map(machineNavigationTab)} tabTestIdPrefix="machine-cockpit-tab-" layout="fit"
        onSurfacePress={props.onSelect} trailing={presentation.menu} />;
});
