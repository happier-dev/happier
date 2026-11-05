import * as React from 'react';
import type { DetailNavigationItem } from '@/components/appShell/rightSidebar/detailNavigationItems';
import { selectPresentedDetailNavigationItem, usePresentedDetailNavigation } from '@/components/appShell/rightSidebar/usePresentedDetailNavigation';
import { DiscussionCockpitTabBar } from '@/components/navigation/mobile/chrome/bars/DiscussionCockpitTabBar';
import { getRightSidebarTabLabel } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import type { ShellColumnActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { useMountedScopeActionCommand } from '@/components/approvals/useMountedScopeActionCommand';
import { normalizeDiscussionMobileSurface, type DiscussionMobileSurface } from './discussionCockpitState';
import { resolveDiscussionNavigationCustomizer } from './discussionNavigationCustomizer';
import { t } from '@/text';
import { usePreferredLanguage } from '@/text/usePreferredLanguage';

export type DiscussionNavigationModel = Readonly<{
    discussionId: string;
    scope: ServerAccountScope | null;
    items: readonly DetailNavigationItem[];
    surface: DiscussionMobileSurface;
    readColumn: (column: 'main' | 'side') => ShellColumnActionOwner;
}>;
export const DiscussionNavigationContext = React.createContext<DiscussionNavigationModel | null>(null);
export const DISCUSSION_DESKTOP_NAVIGATION_ADDRESS = { pageKind: 'discussion', device: 'desktop', section: 'companions' } as const;
export const DISCUSSION_PHONE_NAVIGATION_ADDRESS = { pageKind: 'discussion', device: 'phone', section: 'items' } as const;

/** The shared adapter owns item metadata; Discussion translates its route and physical pane effects. */
export function useDiscussionNavigation(input: Readonly<{
    discussionId: string;
    scope: ServerAccountScope | null;
    phone: boolean;
    items: readonly DetailNavigationItem[];
    surface: DiscussionMobileSurface;
    sideVisible: boolean;
    activeCompanionId?: string;
    onSelect: (item: DetailNavigationItem) => void;
    setVisible: (column: 'main' | 'side', visible: boolean) => void;
}>): DiscussionNavigationModel {
    const locale = usePreferredLanguage();
    const items = React.useMemo(() => input.items.map(item => ({ ...item,
        title: getRightSidebarTabLabel(item), disabledReason: item.disabledReason ?? null })), [input.items, locale]);
    const companions = React.useMemo(() => items.filter(item => item.navigation.kind !== 'page'
        && (!input.phone || item.phonePlacement !== 'none')), [items, input.phone]);
    const activeId = input.phone ? input.items.find(item => discussionSurfaceForItem(item) === input.surface)?.id ?? 'chat' : 'chat';
    const sideId = input.phone ? activeId === 'chat' ? null : activeId : input.activeCompanionId ?? null;
    const chromeRevision = React.useMemo(() => ({ surface: input.surface, sideVisible: input.sideVisible,
        activeCompanionId: input.activeCompanionId }), [input.surface, input.sideVisible, input.activeCompanionId]);
    const select = (id: string) => { const item = input.items.find(item => item.id === id); if (item) input.onSelect(item); };
    const detail = usePresentedDetailNavigation({ pageKind: 'discussion', identity: input.discussionId,
        scope: input.scope, items, activeId, title: t('session.collaboration.conversations'),
        phone: input.phone, presented: Boolean(input.discussionId), chromeRevision,
        customizer: device => resolveDiscussionNavigationCustomizer({ items: input.items, device }),
        selectPage: select,
        companion: { items: companions, activeId: sideId, select, close: () => input.setVisible('side', false) },
        columnState: column => ({
            visible: column === 'main' ? !input.phone || input.surface === 'chat'
                : input.phone ? input.surface !== 'chat' : input.sideVisible,
            activeTab: column === 'main' ? 'chat' : sideId ?? undefined,
            setVisible: visible => input.setVisible(column, visible),
        }),
        phoneChrome: execute => {
            const props = { discussionId: input.discussionId, items: input.items, activeSurface: input.surface,
                onSurfacePress: (surface: DiscussionMobileSurface) => selectDiscussionNavigationItem(execute, navigation, surface) };
            return { node: <DiscussionCockpitTabBar {...props} />, systemModel: { kind: 'discussionCockpit', props } };
        } });
    const navigation = React.useMemo<DiscussionNavigationModel>(() => ({ discussionId: input.discussionId,
        scope: input.scope, items: input.items, surface: input.surface, readColumn: detail.readColumn }),
    [input.discussionId, input.scope, input.items, input.surface, detail.model, detail.readColumn]);
    return navigation;
}

export function discussionSurfaceForItem(item: DetailNavigationItem): DiscussionMobileSurface | null {
    return normalizeDiscussionMobileSurface(item.mobileSurfaces?.discussion);
}

export function selectDiscussionNavigationItem(execute: ReturnType<typeof useMountedScopeActionCommand>,
    navigation: DiscussionNavigationModel, id: string, visible = true): void {
    const item = navigation.items.find(item => item.id === id || item.mobileSurfaces?.discussion === id);
    if (!item) return;
    selectPresentedDetailNavigationItem(execute, navigation, item.id, undefined, visible);
}
