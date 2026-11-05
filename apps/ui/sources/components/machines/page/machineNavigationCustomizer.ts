import { resolveDetailPhoneNavigationItem, type DetailPageNavigationItem } from '@/components/appShell/rightSidebar/detailNavigationItems';
import type { DetailNavigationCustomizerProps } from '@/components/ui/navigation/NavigationPlacementCustomizer';
import { t } from '@/text';
import { MACHINE_DESKTOP_NAVIGATION_ADDRESS, MACHINE_PHONE_NAVIGATION_ADDRESS } from './machineNavigation';

export function resolveMachineNavigationCustomizer(input: Readonly<{ items: readonly DetailPageNavigationItem[]; device: 'desktop' | 'phone' }>): DetailNavigationCustomizerProps {
    return { pageKind: 'machine', pageTitle: t('settings.machines'), device: input.device,
        desktop: [{ id: 'pages', address: MACHINE_DESKTOP_NAVIGATION_ADDRESS, title: t('navigationPlacement.topTabs'),
            description: t('navigationPlacement.topTabsDescription'), items: input.items }],
        phone: [{ id: 'items', address: MACHINE_PHONE_NAVIGATION_ADDRESS, title: t('navigationPlacement.phoneBar'),
            description: t('navigationPlacement.phoneBarDescription'), items: input.items.map(resolveDetailPhoneNavigationItem),
            placementLabels: { pinned: t('navigationPlacement.bar') } }],
        phonePageTabs: true, testID: 'machine-navigation-customizer' };
}
