import * as React from 'react';
import { getRightSidebarTabLabel } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import type { DiscussionMobileSurface } from '@/components/workspaceCockpit/discussion/discussionCockpitState';
import { resolveDetailNavigationItems, resolveDetailNavigationProjection, type DetailNavigationItem } from '@/components/appShell/rightSidebar/detailNavigationItems';
import { DISCUSSION_PHONE_NAVIGATION_ADDRESS, DiscussionNavigationContext, discussionSurfaceForItem, selectDiscussionNavigationItem } from '@/components/workspaceCockpit/discussion/discussionNavigation';
import { resolveDiscussionNavigationCustomizer } from '@/components/workspaceCockpit/discussion/discussionNavigationCustomizer';
import { useMobileWorkspaceExperienceState } from '@/components/workspaceCockpit/useMobileWorkspaceExperienceState';
import { useMountedScopeActionCommand } from '@/components/approvals/useMountedScopeActionCommand';
import { CockpitTabBar, type CockpitTabBarTabDefinition } from './CockpitTabBar';
import { sfSymbolForCockpitTabIcon } from './cockpitTabSymbols';
import { PhonePageStripView } from './PhonePageStrip';
import { useDetailPhoneBarPresentation, useDetailPhonePlacement } from './detailPhoneNavigation';

export type DiscussionCockpitTabDefinition = CockpitTabBarTabDefinition<DiscussionMobileSurface> & Readonly<{ sfSymbol: string }>;
type DiscussionCockpitTabBarProps = Readonly<{
    discussionId: string;
    items?: readonly DetailNavigationItem[];
    activeSurface: DiscussionMobileSurface;
    onSurfacePress: (surface: DiscussionMobileSurface) => void;
}>;

/** Descriptor adaptation only; the shared phone owner decides placement, top mode and measured fit. */
export function useDiscussionPhoneNavigation(props: DiscussionCockpitTabBarProps) {
    const fallback = React.useMemo(() => props.items ? undefined : resolveDetailNavigationItems({ scope: 'discussion' }), [props.items]);
    const items = props.items ?? fallback!;
    const phone = React.useMemo(() => resolveDetailNavigationProjection(items, 'mobile').phone.map(item => ({ ...item,
        title: getRightSidebarTabLabel(item),
    })), [items]);
    const placement = useDetailPhonePlacement(phone, DISCUSSION_PHONE_NAVIGATION_ADDRESS, 'discussion');
    const activeId = items.find(item => discussionSurfaceForItem(item) === props.activeSurface)?.id ?? props.activeSurface;
    const select = (id: string) => {
        const item = items.find(item => item.id === id || discussionSurfaceForItem(item) === id);
        const surface = item && discussionSurfaceForItem(item);
        if (surface && !item.disabledReason) props.onSurfacePress(surface);
    };
    const tabForItem = (item: DetailNavigationItem): DiscussionCockpitTabDefinition => ({
        id: discussionSurfaceForItem(item)!, label: getRightSidebarTabLabel(item), icon: item.icon,
        sfSymbol: sfSymbolForCockpitTabIcon(item.icon), disabled: Boolean(item.disabledReason),
        unavailableReason: item.disabledReason ?? undefined,
    });
    return { items, phone, activeId, select, tabForItem, ...placement };
}

export function useDiscussionCockpitBarPresentation(props: DiscussionCockpitTabBarProps, native = false) {
    const navigation = useDiscussionPhoneNavigation(props);
    const customizer = React.useMemo(() => resolveDiscussionNavigationCustomizer({ items: navigation.items, device: 'phone' }), [navigation.items]);
    const presentation = useDetailPhoneBarPresentation({ items: navigation.phone, placement: navigation,
        address: DISCUSSION_PHONE_NAVIGATION_ADDRESS, pageKind: 'discussion', activeId: navigation.activeId,
        select: navigation.select, customizer, native });
    return { ...navigation, ...presentation };
}

/** Mounted under either Discussion header; the retained Chat keeps its draft while a companion is open. */
export function DiscussionPhonePageStrip() {
    const navigation = React.useContext(DiscussionNavigationContext);
    const { cockpitEnabled } = useMobileWorkspaceExperienceState();
    const execute = useMountedScopeActionCommand(navigation?.scope ?? null);
    if (!navigation || !cockpitEnabled) return null;
    return <DiscussionPhonePageStripContent discussionId={navigation.discussionId} items={navigation.items}
        activeSurface={navigation.surface} onSurfacePress={surface => selectDiscussionNavigationItem(execute, navigation, surface)} />;
}
function DiscussionPhonePageStripContent(props: DiscussionCockpitTabBarProps) {
    const navigation = useDiscussionPhoneNavigation(props);
    if (navigation.topPages.length === 0) return null;
    return <PhonePageStripView tabs={navigation.topPages.map(navigation.tabForItem)} activeId={props.activeSurface}
        onSelect={navigation.select} testID="discussion-phone-page-strip" />;
}

export const DiscussionCockpitTabBar = React.memo(function DiscussionCockpitTabBar(props: DiscussionCockpitTabBarProps) {
    const presentation = useDiscussionCockpitBarPresentation(props);
    return <CockpitTabBar activeSurface={props.activeSurface} barTestId={`discussion-cockpit-tabbar-${props.discussionId}`}
        tabs={presentation.shown.map(presentation.tabForItem)} tabTestIdPrefix="discussion-cockpit-tab-" layout="fit"
        onSurfacePress={presentation.select} trailing={presentation.menu} />;
});
