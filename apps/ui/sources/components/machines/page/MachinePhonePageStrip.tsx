import * as React from 'react';
import { PhonePageStripView } from '@/components/navigation/mobile/chrome/bars/PhonePageStrip';
import { useDetailPhonePlacement } from '@/components/navigation/mobile/chrome/bars/detailPhoneNavigation';
import { machineNavigationTab } from '@/components/navigation/mobile/chrome/bars/MachineCockpitTabBar';
import { MACHINE_PHONE_NAVIGATION_ADDRESS, type MachineNavigationModel } from './machineNavigation';

/** Top mode lends the same phone placement projection to the existing strip. */
export function MachinePhonePageStrip(props: Readonly<{ model: MachineNavigationModel; onSelect: (id: string) => void }>) {
    const { topPages } = useDetailPhonePlacement(props.model.items, MACHINE_PHONE_NAVIGATION_ADDRESS, 'machine');
    return topPages.length ? <PhonePageStripView tabs={topPages.map(machineNavigationTab)} activeId={props.model.activeId}
        onSelect={props.onSelect} testID="machine-phone-page-strip" /> : null;
}
