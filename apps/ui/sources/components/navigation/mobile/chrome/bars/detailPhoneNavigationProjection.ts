import { resolveDetailPhoneNavigationItem } from '@/components/appShell/rightSidebar/detailNavigationItems';
import { resolveNavigationOverflow, resolveNavigationPlacements, resolveNavigationVisitor, type NavigationPlacementPolicy, type NavigationPlacementPreferences } from '@/sync/domains/settings/navigationPlacement';

export type PhonePlacementItem = NavigationPlacementPolicy & Readonly<{
    id: string;
    navigation: Readonly<{ kind: 'page' | 'companion' | 'both' }>;
    phonePlacement?: 'bar' | 'more' | 'none';
}>;

/** Shared placement for live bars, top strips, and captured Customize previews. */
export function resolveDetailPhonePlacement<T extends PhonePlacementItem>(
    items: readonly T[], preferences: NavigationPlacementPreferences | undefined, pageTabs: 'top' | 'bottom',
) {
    const placements = resolveNavigationPlacements(items.map(resolveDetailPhoneNavigationItem), preferences);
    // Chat is Session's fixed primary destination, ahead of the configurable tools.
    const pinned = [...placements.pinned.filter(item => item.id === 'chat'), ...placements.pinned.filter(item => item.id !== 'chat')];
    const pinnedPages = pinned.filter(item => item.navigation.kind !== 'companion');
    const topMode = pageTabs === 'top' && pinnedPages.some(item => item.id !== 'chat');
    return { preferences, pageTabs, placements, topPages: topMode ? pinnedPages : [],
        bottom: topMode ? pinned.filter(item => item.navigation.kind === 'companion') : pinned };
}

/**
 * One fit rule for every phone bar (owner 11-06): Bar items that do not fit scroll, and nothing moves to
 * More on its own; only items placed in More wait there. Session's "Always swipe between sessions" alone
 * holds the excess in More (`'more'`), so the swipe keeps the horizontal axis.
 *
 * More is never replaced (owner 11-10): the open item, when it is not on the bar, rides it as the `visitor`
 * just before More, and keeps its row behind More. A bar that holds its excess in More makes room for it.
 */
export function resolveDetailPhoneBarFit<T extends PhonePlacementItem>(
    placement: ReturnType<typeof resolveDetailPhonePlacement<T>>, slotCount: number | null,
    overflowBehavior: 'more' | 'scroll' = 'scroll',
    options?: Readonly<{ activeId?: string | null }>,
) {
    const fitAt = (availableSize: number | null) => {
        const fit = resolveNavigationOverflow(placement.bottom, placement.placements.overflow,
            { availableSize, itemSize: 1, reserveOverflowSlot: true });
        const held = placement.bottom.slice(fit.shown.length);
        const scroll = overflowBehavior === 'scroll' && held.length > 0;
        const overflow = scroll ? placement.placements.overflow : fit.overflow;
        return { shown: scroll ? placement.bottom : fit.shown, held: scroll ? [] : held,
            behindMore: placement.placements.ordered.filter(item => overflow.some(entry => entry.id === item.id)),
            mode: scroll ? 'scroll' as const : held.length > 0 ? 'more' as const : 'fit' as const };
    };
    const visitorOf = (shown: readonly T[]): T | null => {
        const id = options?.activeId;
        if (!id || placement.topPages.some(item => item.id === id)) return null;
        const item = resolveNavigationVisitor(shown, placement.placements.ordered, entry => entry.id === id);
        // With page tabs at the top, the bottom bar holds only companions: an open page stays checked in More.
        return item && placement.topPages.length > 0 && item.navigation.kind !== 'companion' ? null : item;
    };
    const availableSize = slotCount;
    let fit = fitAt(availableSize);
    let visitor = visitorOf(fit.shown);
    if (visitor && availableSize !== null && fit.mode !== 'scroll') {
        fit = fitAt(Math.max(0, availableSize - 1));
        visitor = visitorOf(fit.shown);
    }
    return { ...fit, shown: visitor ? [...fit.shown, visitor] : fit.shown, visitor };
}
