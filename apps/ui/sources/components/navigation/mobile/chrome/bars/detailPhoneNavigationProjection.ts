import { resolveDetailPhoneNavigationItem } from '@/components/appShell/rightSidebar/detailNavigationItems';
import { resolveNavigationOverflow, resolveNavigationPlacements, type NavigationPlacementPolicy, type NavigationPlacementPreferences } from '@/sync/domains/settings/mobileSurfacePinning';

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
 */
export function resolveDetailPhoneBarFit<T extends PhonePlacementItem>(
    placement: ReturnType<typeof resolveDetailPhonePlacement<T>>, slotCount: number | null,
    overflowBehavior: 'more' | 'scroll' = 'scroll',
    /**
     * Slots the selected tab's name takes beyond its icon: with labels off it still names itself (owner 11-06), so a
     * bar that fits only as icons scrolls instead of clipping that name.
     */
    options?: Readonly<{ selectedLabelSlots?: number }>,
) {
    const availableSize = slotCount === null ? null : Math.max(0, slotCount - (options?.selectedLabelSlots ?? 0));
    const fit = resolveNavigationOverflow(placement.bottom, placement.placements.overflow,
        { availableSize, itemSize: 1, reserveOverflowSlot: true });
    const held = placement.bottom.slice(fit.shown.length);
    const scroll = overflowBehavior === 'scroll' && held.length > 0;
    const overflow = scroll ? placement.placements.overflow : fit.overflow;
    return { shown: scroll ? placement.bottom : fit.shown, held: scroll ? [] : held,
        behindMore: placement.placements.ordered.filter(item => overflow.some(entry => entry.id === item.id)),
        mode: scroll ? 'scroll' as const : held.length > 0 ? 'more' as const : 'fit' as const };
}
