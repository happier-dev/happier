import * as React from 'react';
import { CockpitTabBar } from '@/components/navigation/mobile/chrome/bars/CockpitTabBar';
import { detailNavigationTab, useDetailPhoneBarPresentation, useDetailPhonePlacement } from '@/components/navigation/mobile/chrome/bars/detailPhoneNavigation';
import type { DetailNavigationCustomizerProps } from '@/components/ui/navigation/NavigationPlacementCustomizer';
import { t } from '@/text';
import type { PluginDetailNavigationModel } from './pluginDetailNavigation';
import { Modal } from '@/modal';
import { resolveDetailPhoneNavigationItem, resolveDetailNavigationProjection } from '@/components/appShell/rightSidebar/detailNavigationItems';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import type { RightPaneHiddenByDetails } from '@/components/appShell/panes/PaneActionRailContext';
import { RightSidebarActionRail } from '@/components/appShell/rightSidebar/RightSidebarActionRail';
import { usePublishRightSidebarActions } from '@/components/appShell/rightSidebar/rightSidebarActions';
import { useMountedScopeActionCommand } from '@/components/approvals/useMountedScopeActionCommand';

type PluginNavigationCustomization = Pick<PluginDetailNavigationModel, 'pageKind' | 'title' | 'items' | 'companionItems' | 'desktopAddress' | 'companionAddress' | 'phoneAddress'>;

export async function openPluginDetailNavigationCustomizer(model: PluginNavigationCustomization, device: 'desktop' | 'phone'): Promise<void> {
    const { DetailNavigationCustomizer } = await import('@/components/ui/navigation/NavigationPlacementCustomizer');
    Modal.show({ component: DetailNavigationCustomizer, props: pluginDetailNavigationCustomizer(model, device) });
}

export function pluginDetailNavigationCustomizer(model: PluginNavigationCustomization, device: 'desktop' | 'phone'): DetailNavigationCustomizerProps {
    const companions = model.companionItems;
    return { pageKind: model.pageKind, pageTitle: model.title, device,
        desktop: [{ id: 'pages', address: model.desktopAddress, title: t('navigationPlacement.topTabs'),
            description: t('navigationPlacement.topTabsDescription'), items: model.items.filter(item => item.navigation.kind !== 'companion') },
            ...(companions.length ? [{ id: 'companions', address: model.companionAddress,
                title: t('navigationPlacement.rail'), description: t('navigationPlacement.railDescription'), items: companions }] : [])],
        phone: [{ id: 'items', address: model.phoneAddress, title: t('navigationPlacement.phoneBar'),
            description: t('navigationPlacement.phoneBarDescription'), items: model.items.map(resolveDetailPhoneNavigationItem),
            placementLabels: { pinned: t('navigationPlacement.bar') } }], phonePageTabs: true,
        testID: 'plugin-detail-navigation-customizer' };
}

export type PluginDetailCockpitTabBarProps = Readonly<{ model: PluginDetailNavigationModel; onSelect: (id: string) => void }>;
export function usePluginDetailCockpitBarPresentation(props: PluginDetailCockpitTabBarProps, native = false) {
    const { model } = props;
    const placement = useDetailPhonePlacement(model.items, model.phoneAddress, model.pageKind);
    const customizer = React.useMemo(() => pluginDetailNavigationCustomizer(model, 'phone'),
        [model.pageKind, model.title, model.items, model.companionItems, model.desktopAddress, model.companionAddress, model.phoneAddress]);
    return useDetailPhoneBarPresentation({ items: model.items, placement, address: model.phoneAddress,
        pageKind: model.pageKind, activeId: model.activeId, select: props.onSelect, customizer, native });
}
export function PluginDetailCockpitTabBar(props: PluginDetailCockpitTabBarProps) {
    const presentation = usePluginDetailCockpitBarPresentation(props);
    return <CockpitTabBar activeSurface={props.model.activeId} barTestId="plugin-detail-cockpit-tabbar"
        tabs={presentation.shown.map(detailNavigationTab)} tabTestIdPrefix="plugin-detail-cockpit-tab-"
        layout="fit" onSurfacePress={props.onSelect} trailing={presentation.menu} />;
}

/** The existing App pane owns visibility; the mounted detail supplies its companion catalog. */
export function PluginDetailNavigationRail(props: Readonly<{
    model: PluginDetailNavigationModel;
    pane: Pick<AppPaneScopeApi, 'scopeState' | 'closeRight' | 'closeDetails'>;
    rightPaneHiddenByDetails?: RightPaneHiddenByDetails;
}>) {
    const { model, pane, rightPaneHiddenByDetails = false } = props;
    const launchers = React.useMemo(() => resolveDetailNavigationProjection(model.companionItems, 'desktop', model.activeId).companions,
        [model.companionItems, model.activeId]);
    const execute = useMountedScopeActionCommand(model.scope);
    const destination = pane.scopeState?.right.selectedDestination;
    const selected = destination?.kind === 'plugin' ? buildQualifiedPluginContributionKey(destination.destination) : null;
    const activeId = model.companionItems.find(item => item.navigation.kind !== 'page' && item.navigation.companion === selected)?.id;
    const readSide = () => ({ ...model.readColumn('side'),
        visible: pane.scopeState?.right.isOpen === true, activeTab: activeId,
        setVisible: (visible: boolean) => { if (!visible) pane.closeRight(); },
    });
    const select = (id: string) => {
        if (rightPaneHiddenByDetails === true) pane.closeDetails();
        void execute('shell.column.set', { column: 'side', visible: true, tab: id },
            { kind: 'shell.column', column: 'side', read: readSide });
    };
    const side = model.readColumn('side');
    usePublishRightSidebarActions({ tabs: side.tabs ?? [], activeTab: activeId, items: side.items, selectTab: side.selectTab ?? (() => {}) });
    return <RightSidebarActionRail surfaceId={model.companionAddress} testID="plugin-detail-navigation-rail"
        testIDPrefix="plugin-detail-navigation-rail" onOpenCustomizer={() => { void openPluginDetailNavigationCustomizer(model, 'desktop'); }}
        actions={launchers.map(item => ({ id: item.id, label: item.title, icon: item.icon,
            defaultPlacement: item.defaultPlacement, allowedPlacements: item.allowedPlacements,
            active: pane.scopeState?.right.isOpen === true && !rightPaneHiddenByDetails && activeId === item.id,
            disabled: Boolean(item.disabledReason), disabledReason: item.disabledReason ?? undefined,
            onPress: () => {
                if (pane.scopeState?.right.isOpen && !rightPaneHiddenByDetails && activeId === item.id) {
                    void execute('shell.column.set', { column: 'side', visible: false }, { kind: 'shell.column', column: 'side', read: readSide });
                } else select(item.id);
            },
        }))} />;
}
