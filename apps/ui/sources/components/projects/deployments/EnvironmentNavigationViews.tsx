import * as React from 'react';
import { resolveDetailPhoneNavigationItem } from '@/components/appShell/rightSidebar/detailNavigationItems';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { PhonePageStripView } from '@/components/navigation/mobile/chrome/bars/PhonePageStrip';
import { CockpitTabBar } from '@/components/navigation/mobile/chrome/bars/CockpitTabBar';
import { detailNavigationTab, useDetailPhoneBarPresentation, useDetailPhonePlacement } from '@/components/navigation/mobile/chrome/bars/detailPhoneNavigation';
import { DetailNavigationCustomizer, type DetailNavigationCustomizerProps } from '@/components/ui/navigation/NavigationPlacementCustomizer';
import { useSetting } from '@/sync/store/settingsReadHooks';
import { Modal } from '@/modal';
import { t } from '@/text';
import { ENVIRONMENT_DESKTOP_NAVIGATION_ADDRESS, ENVIRONMENT_PHONE_NAVIGATION_ADDRESS, type EnvironmentNavigationModel, type useEnvironmentNavigation } from './environmentNavigation';

export function environmentNavigationCustomizer(model: EnvironmentNavigationModel, device: 'desktop' | 'phone'): DetailNavigationCustomizerProps {
    return { pageKind: 'environment', pageTitle: t('projects.deployments.review.environment'), device,
        desktop: [{ id: 'pages', address: ENVIRONMENT_DESKTOP_NAVIGATION_ADDRESS, title: t('navigationPlacement.topTabs'),
            description: t('navigationPlacement.topTabsDescription'), items: model.items }],
        phone: [{ id: 'items', address: ENVIRONMENT_PHONE_NAVIGATION_ADDRESS, title: t('navigationPlacement.phoneBar'),
            description: t('navigationPlacement.phoneBarDescription'), items: model.items.map(resolveDetailPhoneNavigationItem), placementLabels: { pinned: t('navigationPlacement.bar') } }],
        phonePageTabs: true, testID: 'environment-navigation-customizer' };
}

export function EnvironmentPageNavigation(props: Readonly<{
    navigation: ReturnType<typeof useEnvironmentNavigation>; phone: boolean; onSelect: (id: string) => void;
}>) {
    const experience = useSetting('mobileWorkspaceExperienceV1');
    const { model, placements } = props.navigation;
    if (props.phone && experience === 'cockpit') return <EnvironmentPhonePageStrip model={model} onSelect={props.onSelect} />;
    const tab = (item: EnvironmentNavigationModel['items'][number]) => ({ id: item.id, label: item.title });
    return <SegmentedTabBar presentation="plain" segmentSizing="content" testIDPrefix="project-deployments.environment.tab"
        activeTabId={model.activeId} onSelectTab={props.onSelect} tabs={(props.phone ? model.items : placements.pinned).map(tab)}
        overflow={{ label: t('common.more'), testID: 'project-deployments.environment.tab.more',
            ...(props.phone ? {} : { items: placements.overflow.map(tab), orderedIds: placements.ordered.map(item => item.id),
                actions: [{ id: 'customize', label: t('navigationPlacement.customizeTabs'), onPress: () => {
                    Modal.show({ component: DetailNavigationCustomizer, props: environmentNavigationCustomizer(model, 'desktop') });
                } }] }) }} />;
}

function EnvironmentPhonePageStrip(props: Readonly<{ model: EnvironmentNavigationModel; onSelect: (id: string) => void }>) {
    const phone = useDetailPhonePlacement(props.model.items, ENVIRONMENT_PHONE_NAVIGATION_ADDRESS, 'environment');
    return phone.topPages.length ? <PhonePageStripView tabs={phone.topPages.map(detailNavigationTab)}
        activeId={props.model.activeId} onSelect={props.onSelect} testID="environment-phone-page-strip" /> : null;
}

export type EnvironmentCockpitTabBarProps = Readonly<{ model: EnvironmentNavigationModel; onSelect: (id: string) => void }>;
export function useEnvironmentCockpitBarPresentation(props: EnvironmentCockpitTabBarProps, native = false) {
    const { model } = props;
    const placement = useDetailPhonePlacement(model.items, ENVIRONMENT_PHONE_NAVIGATION_ADDRESS, 'environment');
    const customizer = React.useMemo(() => environmentNavigationCustomizer(model, 'phone'), [model.items]);
    return useDetailPhoneBarPresentation({ items: model.items, placement, address: ENVIRONMENT_PHONE_NAVIGATION_ADDRESS,
        pageKind: 'environment', activeId: model.activeId, select: props.onSelect, customizer, native });
}
export function EnvironmentCockpitTabBar(props: EnvironmentCockpitTabBarProps) {
    const presentation = useEnvironmentCockpitBarPresentation(props);
    return <CockpitTabBar activeSurface={props.model.activeId} barTestId="environment-cockpit-tabbar"
        tabs={presentation.shown.map(detailNavigationTab)} tabTestIdPrefix="environment-cockpit-tab-"
        layout="fit" onSurfacePress={props.onSelect} trailing={presentation.menu} />;
}
