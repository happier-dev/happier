import * as React from 'react';
import { resolveDetailPhoneNavigationItem } from '@/components/appShell/rightSidebar/detailNavigationItems';
import { useUnistyles } from 'react-native-unistyles';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { SegmentedTabBar } from '@/components/ui/navigation/SegmentedTabBar';
import { RightSidebarActionRail } from '@/components/appShell/rightSidebar/RightSidebarActionRail';
import { PhonePageStripView } from '@/components/navigation/mobile/chrome/bars/PhonePageStrip';
import { CockpitTabBar } from '@/components/navigation/mobile/chrome/bars/CockpitTabBar';
import { detailNavigationTab, useDetailPhoneBarPresentation, useDetailPhonePlacement } from '@/components/navigation/mobile/chrome/bars/detailPhoneNavigation';
import type { DetailNavigationCustomizerProps } from '@/components/ui/navigation/NavigationPlacementCustomizer';
import { useSetting } from '@/sync/store/settingsReadHooks';
import { Modal } from '@/modal';
import { t } from '@/text';
import { workflowNavigationAddress, type WorkflowNavigationModel, type useWorkflowNavigation } from './workflowNavigation';

export function workflowNavigationCustomizer(model: WorkflowNavigationModel, device: 'desktop' | 'phone'): DetailNavigationCustomizerProps {
    return { pageKind: model.pageKind, pageTitle: t('workflows.title'), device,
        desktop: [
            { id: 'pages', address: workflowNavigationAddress(model.pageKind, 'desktop'), title: t('navigationPlacement.topTabs'),
                description: t('navigationPlacement.topTabsDescription'), items: model.items.filter(item => item.navigation.kind !== 'companion') },
            { id: 'companions', address: workflowNavigationAddress(model.pageKind, 'desktop', 'companions'), title: t('navigationPlacement.rail'),
                description: t('navigationPlacement.railDescription'), items: model.items.filter(item => item.navigation.kind !== 'page') },
        ],
        phone: [{ id: 'items', address: workflowNavigationAddress(model.pageKind, 'phone'), title: t('navigationPlacement.phoneBar'),
            description: t('navigationPlacement.phoneBarDescription'), items: model.items.map(resolveDetailPhoneNavigationItem), placementLabels: { pinned: t('navigationPlacement.bar') } }],
        phonePageTabs: true, testID: `${model.pageKind}-navigation-customizer` };
}
export async function openWorkflowNavigationCustomizer(model: WorkflowNavigationModel) {
    const { DetailNavigationCustomizer } = await import('@/components/ui/navigation/NavigationPlacementCustomizer');
    Modal.show({ component: DetailNavigationCustomizer, props: workflowNavigationCustomizer(model, 'desktop') });
}

/**
 * What the page navigation shows: the phone strip of pages placed on top, the page tabs, or nothing.
 * The one decision both the navigation and a row that holds it read, so an empty row never keeps its space.
 */
function useWorkflowPageNavigationContent(navigation: ReturnType<typeof useWorkflowNavigation>, phone: boolean) {
    const experience = useSetting('mobileWorkspaceExperienceV1');
    const { model } = navigation;
    const placement = useDetailPhonePlacement(model.items, workflowNavigationAddress(model.pageKind, 'phone'), model.pageKind);
    if (phone && experience === 'cockpit') return placement.topPages.length ? { kind: 'strip' as const, topPages: placement.topPages } : null;
    return navigation.pages.length <= 1 ? null : { kind: 'tabs' as const };
}

export function useWorkflowPageNavigationShown(navigation: ReturnType<typeof useWorkflowNavigation>, phone: boolean): boolean {
    return useWorkflowPageNavigationContent(navigation, phone) !== null;
}

export const WorkflowPageNavigation = React.memo(function WorkflowPageNavigation(props: Readonly<{
    navigation: ReturnType<typeof useWorkflowNavigation>; phone: boolean; onSelect: (id: string) => void; testIDPrefix: string;
}>) {
    const { theme } = useUnistyles();
    const { model, placements } = props.navigation;
    const content = useWorkflowPageNavigationContent(props.navigation, props.phone);
    if (content === null) return null;
    if (content.kind === 'strip') return <PhonePageStripView tabs={content.topPages.map(detailNavigationTab)}
        activeId={model.activeId} onSelect={props.onSelect} testID={props.testIDPrefix} />;
    const tab = (item: WorkflowNavigationModel['items'][number]) => ({ id: item.id, label: item.title,
        icon: <Icon name={item.icon} size={ICON_SIZE.sm} color={theme.colors.text.secondary} />,
        disabled: Boolean(item.disabledReason), unavailableReason: item.disabledReason ?? undefined });
    const pages = props.phone ? props.navigation.pages : placements.pinned;
    return <SegmentedTabBar presentation="plain" segmentSizing="content" iconPlacement="leading"
        testIDPrefix={props.testIDPrefix} accessibilityLabel={t('navigationPlacement.pageTabsTitle')}
        tabs={pages.map(tab)} activeTabId={model.activeId} onSelectTab={props.onSelect}
        {...(props.phone ? {} : { overflow: { label: t('common.more'), items: placements.overflow.map(tab), orderedIds: placements.ordered.map(item => item.id),
            actions: [{ id: 'customize', label: t('navigationPlacement.customizeTabs'), onPress: () => { void openWorkflowNavigationCustomizer(model); } }] } })} />;
});

export function WorkflowCompanionNavigation(props: Readonly<{ model: WorkflowNavigationModel; onSelect: (id: string) => void }>) {
    const { model } = props;
    return <RightSidebarActionRail surfaceId={workflowNavigationAddress(model.pageKind, 'desktop', 'companions')}
        testIDPrefix={`${model.pageKind}-companion`} onOpenCustomizer={() => { void openWorkflowNavigationCustomizer(model); }}
        actions={model.items.filter(item => item.navigation.kind !== 'page' && !(item.navigation.kind === 'both' && item.id === model.activeId)).map(item => ({
            id: item.id, label: item.title, icon: item.icon, active: model.sideIds.includes(item.id),
            disabled: Boolean(item.disabledReason), disabledReason: item.disabledReason ?? undefined,
            defaultPlacement: item.defaultPlacement, allowedPlacements: item.allowedPlacements, onPress: () => props.onSelect(item.id),
        }))} />;
}

export type WorkflowCockpitTabBarProps = Readonly<{ model: WorkflowNavigationModel; onSelect: (id: string) => void }>;
export function useWorkflowCockpitBarPresentation(props: WorkflowCockpitTabBarProps, native = false) {
    const { model } = props;
    const address = workflowNavigationAddress(model.pageKind, 'phone');
    const placement = useDetailPhonePlacement(model.items, address, model.pageKind);
    const customizer = React.useMemo(() => workflowNavigationCustomizer(model, 'phone'), [model.items, model.pageKind]);
    return useDetailPhoneBarPresentation({ items: model.items, placement, address, pageKind: model.pageKind,
        activeId: model.sideId ?? model.activeId, select: props.onSelect, customizer, native });
}
export function WorkflowCockpitTabBar(props: WorkflowCockpitTabBarProps) {
    const presentation = useWorkflowCockpitBarPresentation(props);
    return <CockpitTabBar activeSurface={props.model.sideId ?? props.model.activeId} barTestId={`${props.model.pageKind}-cockpit-tabbar`}
        tabs={presentation.shown.map(detailNavigationTab)} tabTestIdPrefix={`${props.model.pageKind}-cockpit-tab-`}
        layout={presentation.layout} onSurfacePress={props.onSelect} onTabLongPress={presentation.onTabLongPress} trailing={presentation.menu} />;
}
