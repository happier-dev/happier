import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { t } from '@/text';
import { layout } from '@/components/ui/layout/layout';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { resolveFloatingTabBarSlotCount } from '@/components/ui/navigation/FloatingTabBarSurface';
import { resolveTabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { NavigationPlacementPinButton } from '@/components/ui/navigation/NavigationPlacementPinButton';
import { NavigationPlacementTabMenu } from '@/components/ui/navigation/NavigationPlacementTabMenu';
import { useDetailPageTabsPosition, useNavigationSurfacePlacement } from '@/components/ui/navigation/useNavigationSurfacePlacement';
import type { DetailNavigationCustomizerProps } from '@/components/ui/navigation/NavigationPlacementCustomizer';
import { type NavigationPlacementAddress, type NavigationPlacementPreferences } from '@/sync/domains/settings/mobileSurfacePinning';
import { useSetting } from '@/sync/domains/state/storage';
import { resolveReasonCopy } from '@/sync/domains/surfaces/copy';
import { Modal } from '@/modal';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { CockpitTabBarAction, type CockpitTabBarTabDefinition } from './CockpitTabBar';
import { sfSymbolForCockpitTabIcon } from './cockpitTabSymbols';
import { resolveDetailPhoneBarFit, resolveDetailPhonePlacement, type PhonePlacementItem } from './detailPhoneNavigationProjection';
import { resolveDetailPhoneNavigationItem } from '@/components/appShell/rightSidebar/detailNavigationItems';
import { CockpitBarFoldedContext } from '../pageBarChromeFold';
import { useDetailPageMenuActions } from '../pageMenuActions';
import type { PageHeaderMenuAction } from '@/components/ui/layout/PageHeaderEntityParts';

type PhoneMenuItem = PhonePlacementItem & Readonly<{
    title: string;
    icon: IconName;
    phonePlacement: 'bar' | 'more' | 'none';
    disabledReason?: string | null;
    disabledReasonCode?: string;
    count?: string;
    moreTrailing?: React.ReactNode;
}>;

const styles = StyleSheet.create((theme) => ({
    markSlot: { width: 18, height: 18 },
    // A row's quiet fact and its pin share one line.
    rowEnd: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s6 },
}));

export type DetailPhonePreviewMetrics = Readonly<{ metrics: ReturnType<typeof resolveTabBarMetrics>; slotCount: number | null }>;

export function detailNavigationTab(item: Pick<PhoneMenuItem, 'id' | 'title' | 'icon' | 'disabledReason' | 'count'>): CockpitTabBarTabDefinition<string> & Readonly<{ sfSymbol: string }> {
    // A tab's status rides on it (owner 11-06): its leading count as the badge, its full words in its name.
    const count = item.count?.trim();
    const short = count === undefined ? undefined : TAB_STATUS_COUNT.exec(count)?.[0];
    return { id: item.id, label: item.title, icon: item.icon, sfSymbol: sfSymbolForCockpitTabIcon(item.icon),
        disabled: Boolean(item.disabledReason), unavailableReason: item.disabledReason ?? undefined,
        ...(count === undefined || count === '' ? {} : {
            accessibilityLabel: `${item.title}, ${count}`,
            ...(short === undefined ? {} : { badge: { kind: 'text' as const, value: short } }),
        }) };
}

/** The count a status leads with ("2 failing" → 2, "~402", "1.8K"). */
const TAB_STATUS_COUNT = /^[~≈]?\d[\d.,]*[KkMm]?/u;

/** Detail hosts lend their resolved catalog to the same addressed phone/top projection. */
export function useDetailPhonePlacement<T extends PhonePlacementItem>(items: readonly T[], address: NavigationPlacementAddress, pageKind: string, enabled = true) {
    const { preferences } = useNavigationSurfacePlacement(address, enabled);
    const pageTabs = useDetailPageTabsPosition(pageKind, enabled);
    return React.useMemo(() => ({ ...resolveDetailPhonePlacement(items, preferences, pageTabs), preferences }), [items, preferences, pageTabs]);
}

/** One overflow/menu owner for floating and native detail presenters. */
export function useDetailPhoneBarPresentation<T extends PhoneMenuItem>(input: Readonly<{
    items: readonly T[];
    placement: ReturnType<typeof useDetailPhonePlacement<T>>;
    address: NavigationPlacementAddress;
    pageKind: string;
    activeId: string;
    select: (id: string) => void;
    /** Session's "Always swipe between sessions" holds the excess in More instead of scrolling the bar. */
    overflowBehavior?: 'more' | 'scroll';
    heldSubtitle?: string;
    native: boolean;
}> & (Readonly<{ customizer: DetailNavigationCustomizerProps; onCustomize?: never }>
    | Readonly<{ customizer?: never; onCustomize: (preview: DetailPhonePreviewMetrics) => void }>)) {
    const { preferences, placements } = input.placement;
    const [moreOpen, setMoreOpen] = React.useState(false);
    const width = useWindowDimensions().width;
    const metrics = resolveTabBarMetrics(useSetting('tabBarSize'), useSetting('tabBarShowLabels'));
    const slotCount = input.native ? null : resolveFloatingTabBarSlotCount({ windowWidth: width, maxWidth: layout.maxWidth, tabMinWidth: metrics.tabMinWidth });
    // More also opens Customize, so it occupies one measured slot even before any item overflows.
    // Folded into a page's own bar, More is the bar: it lists every item, and nothing can be pinned to a bar not shown.
    const folded = React.useContext(CockpitBarFoldedContext);
    // More is never replaced (owner 11-10): an open item from More rides the bar just before it.
    const fit = resolveDetailPhoneBarFit(input.placement, slotCount, input.overflowBehavior, { activeId: folded ? null : input.activeId });
    const behindMore = folded ? placements.ordered.filter(item => placements.effectivePlacements[item.id] !== 'hidden') : fit.behindMore;
    // Only a folded bar has no tabs, so only there does More name the open item.
    const foldedActive = folded ? behindMore.find(item => item.id === input.activeId)
        ?? input.items.find(item => item.id === input.activeId && item.phonePlacement === 'none') : undefined;
    // A retained item the phone does not offer (an unavailable Terminal still open) rides the bar the same way.
    const retained = folded || fit.visitor || input.placement.topPages.length > 0 ? undefined
        : input.items.find(item => item.id === input.activeId && item.phonePlacement === 'none'
            && !fit.shown.some(entry => entry.id === item.id));
    const shown = retained ? [...fit.shown, retained] : fit.shown;
    // What is on the bar comes back last in More, under Pinned, where it can be taken off.
    const onBar = folded ? [] : fit.shown.filter(item => item !== fit.visitor
        && (item.allowedPlacements === undefined || item.allowedPlacements.includes('overflow')));
    const openMore = React.useCallback(() => setMoreOpen(true), []);
    const customize = () => {
        setMoreOpen(false);
        if (input.onCustomize) { input.onCustomize({ metrics, slotCount }); return; }
        const customizer = input.customizer;
        fireAndForget(import('@/components/ui/navigation/NavigationPlacementCustomizer').then(({ DetailNavigationCustomizer }) => {
            Modal.show({ component: DetailNavigationCustomizer, props: customizer });
        }), { tag: 'DetailPhoneNavigation.customize' });
    };
    // A held tab's menu: which tab, and whether it is open, kept apart so a late selection still has its tab.
    const [tabMenu, setTabMenu] = React.useState<Readonly<{ id: string; open: boolean }> | null>(null);
    const tabAnchor = React.useRef<unknown>(null);
    const holdTab = React.useCallback((id: string, anchor: unknown) => {
        tabAnchor.current = anchor;
        setTabMenu({ id, open: true });
    }, []);
    const closeTabMenu = React.useCallback((open: boolean) => {
        if (!open) setTabMenu(current => current && { ...current, open: false });
    }, []);
    const heldItem = tabMenu ? input.items.find(item => item.id === tabMenu.id) : undefined;
    // The shown page's ⋯ actions, the list its desktop header reads (ruling 11-14 b); one that is also a navigation
    // item here (Terminal) is listed once, as that item.
    const publishedActions = useDetailPageMenuActions(input.pageKind);
    const pageActions = React.useMemo(() => publishedActions.filter(action => !input.items.some(item => item.id === action.id)),
        [publishedActions, input.items]);
    const more = <DetailPhoneMoreMenu testIDPrefix={`${input.pageKind}-cockpit`} nativeAnchorTestID={`${input.pageKind}-native-more-anchor`}
        native={input.native} surfaceId={input.address} preferences={preferences} activeId={input.activeId}
        open={moreOpen} onOpenChange={setMoreOpen} onSelect={input.select} onCustomize={customize} pageActions={pageActions}
        activeTrigger={foldedActive ? { title: foldedActive.count ? `${foldedActive.title}, ${foldedActive.count}` : foldedActive.title,
            name: foldedActive.title, icon: foldedActive.icon } : null}
        pinnedEntries={onBar.map(entry => ({ id: entry.id, title: entry.title, icon: entry.icon, kind: entry.navigation.kind,
            pinned: true, pinnable: true, disabled: Boolean(entry.disabledReason), subtitle: entry.count }))}
        entries={behindMore.map(entry => {
            const pinned = placements.effectivePlacements[entry.id] === 'pinned';
            return { id: entry.id, title: entry.title, icon: entry.icon, kind: entry.navigation.kind, pinned,
                pinnable: !folded && (entry.allowedPlacements === undefined || entry.allowedPlacements.includes(pinned ? 'overflow' : 'pinned')),
                disabled: Boolean(entry.disabledReason),
                subtitle: entry.disabledReason ? entry.disabledReasonCode ? entry.disabledReason
                    : resolveReasonCopy({ kind: 'pluginRuntime', reasonCode: entry.disabledReason }).body
                    : input.heldSubtitle !== undefined && fit.held.some(item => item.id === entry.id) ? input.heldSubtitle : entry.count,
                trailing: moreOpen ? entry.moreTrailing : undefined };
        })} />;
    // Native bars keep UIKit's own capacity; the floating bar scrolls when its Bar items do not fit.
    const barLayout = !input.native && fit.mode === 'scroll' ? 'scroll' as const : 'fit' as const;
    const menu = <>
        {more}
        {tabMenu && heldItem ? <NavigationPlacementTabMenu testID={`${input.pageKind}-cockpit-tab-menu`} address={input.address}
            item={resolveDetailPhoneNavigationItem(heldItem)} preferences={preferences} open={tabMenu.open} anchorRef={tabAnchor}
            onOpenChange={closeTabMenu} onCustomize={customize} /> : null}
    </>;
    return { ...fit, shown, behindMore, layout: barLayout, menu, openMore, metrics, slotCount, onTabLongPress: input.native ? undefined : holdTab };
}

const PAGE_ACTION_PREFIX = 'page-action:';
const NO_PAGE_ACTIONS: readonly PageHeaderMenuAction[] = Object.freeze([]);

export type DetailPhoneMoreEntry = Readonly<{
    id: string;
    title: string;
    icon: IconName;
    kind: 'page' | 'companion' | 'both';
    pinned: boolean;
    /** The item's placement policy lets this row move between the bar and More. */
    pinnable: boolean;
    disabled?: boolean;
    subtitle?: string;
    /** A quiet fact beside the pin (a mention dot), never a second control. */
    trailing?: React.ReactNode;
}>;

/**
 * The one phone More for every detail kind (orchestrator ruling 2026-11-04): an anchored menu from the
 * bar's More listing what is behind it, pages before companions, each pinnable where its policy allows;
 * then what is on the bar, under Pinned, to open or take off (owner 11-10); then Customize.
 */
export function DetailPhoneMoreMenu(props: Readonly<{
    testIDPrefix: string;
    nativeAnchorTestID: string;
    native: boolean;
    surfaceId: NavigationPlacementAddress;
    preferences: NavigationPlacementPreferences;
    entries: readonly DetailPhoneMoreEntry[];
    /** The bar's own items that may leave it, listed last under Pinned. */
    pinnedEntries?: readonly DetailPhoneMoreEntry[];
    activeId: string;
    /** A folded bar's selected item, named by its More (the only control it shows). */
    activeTrigger: Readonly<{ title: string; name: string; icon: IconName }> | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelect: (id: string) => void;
    onCustomize: () => void;
    /** The shown page's ⋯ actions, after its navigation and before Customize. */
    pageActions?: readonly PageHeaderMenuAction[];
}>) {
    const { entries, open, testIDPrefix: prefix } = props;
    const pageActions = props.pageActions ?? NO_PAGE_ACTIONS;
    const ordered = [...entries.filter(entry => entry.kind !== 'companion'), ...entries.filter(entry => entry.kind === 'companion')];
    const pinnedTitle = t('phoneNav.bar.pinnedSection');
    const categoryTitles = React.useMemo(() => ({ pinned: pinnedTitle }), [pinnedTitle]);
    const rows = [...ordered.map(entry => ({ entry, category: entry.kind === 'companion' ? 'companions' : 'pages' })),
        ...(props.pinnedEntries ?? []).map(entry => ({ entry, category: 'pinned' }))];
    const items: readonly DropdownMenuItem[] = [...rows.map(({ entry, category }) => ({
        id: entry.id, title: entry.title, icon: <Icon name={entry.icon} size={18} />,
        category, checked: entry.id === props.activeId,
        disabled: entry.disabled === true, ...(entry.subtitle ? { subtitle: entry.subtitle } : {}),
        testID: `${prefix}-more-item:${entry.id}`,
        // Pins mount only while the menu is open: a closed More holds no per-row settings writers.
        rightElement: open && (entry.pinnable || entry.trailing) ? <View style={styles.rowEnd}>
            {entry.trailing}
            {entry.pinnable ? <NavigationPlacementPinButton surfaceId={props.surfaceId} entryId={entry.id} pinned={entry.pinned}
                label={t(entry.pinned ? 'phoneNav.bar.removeFromBar' : 'phoneNav.bar.keepOnBar')} preferences={props.preferences}
                testID={`${prefix}-pin:${entry.id}`} /> : null}
        </View> : undefined,
    })), ...pageActions.map((action): DropdownMenuItem => ({
        id: `${PAGE_ACTION_PREFIX}${action.id}`, title: action.title, category: 'actions',
        // Operations carry no mark; the empty mark slot keeps their titles on the tabs' title edge.
        icon: <View style={styles.markSlot} />,
        testID: action.testID ?? `${prefix}-more-action:${action.id}`,
        ...(action.disabled || action.loading ? { disabled: true } : {}),
        ...(action.destructive ? { destructive: true } : {}),
    })), { id: 'customize', title: t('navigationPlacement.customizeTabs'), icon: <Icon name="sliders-horizontal" size={18} />,
        testID: `${prefix}-more-customize` }];
    // The page's operations read as their own group: a hairline sets them apart from the tabs (DESIGN-9 N46 menus).
    return <DropdownMenu open={open} onOpenChange={props.onOpenChange} items={items} categoryTitles={categoryTitles}
        separateCategories={pageActions.length > 0}
        selectedId={rows.some(({ entry }) => entry.id === props.activeId) ? props.activeId : null}
        onSelect={id => {
            props.onOpenChange(false);
            if (id === 'customize') { props.onCustomize(); return; }
            if (id.startsWith(PAGE_ACTION_PREFIX)) {
                void pageActions.find(action => `${PAGE_ACTION_PREFIX}${action.id}` === id)?.onSelect();
                return;
            }
            props.onSelect(id);
        }}
        matchTriggerWidth={false} placement="top" trigger={({ open: expanded, toggle }) => props.native
            ? <View collapsable={false} testID={props.nativeAnchorTestID} style={{ width: 0, height: 0 }} />
            : <CockpitTabBarAction testID={`${prefix}-tab-more`} label={props.activeTrigger?.title ?? t('common.more')}
                // Folded into a page's own bar, More stands for the open tab: with labels on it names it, as a tab does.
                {...(props.activeTrigger === null ? {} : { visibleLabel: props.activeTrigger.name })}
                icon={props.activeTrigger?.icon ?? 'dots-three'} selected={props.activeTrigger !== null} expanded={expanded} onPress={toggle} />} />;
}
