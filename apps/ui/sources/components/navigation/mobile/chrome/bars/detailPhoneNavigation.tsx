import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { t } from '@/text';
import { layout } from '@/components/ui/layout/layout';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { resolveFloatingTabBarSlotCount } from '@/components/ui/navigation/FloatingTabBarSurface';
import { resolveTabBarMetrics } from '@/components/ui/navigation/tabBarMetrics';
import { NavigationPlacementPinButton } from '@/components/ui/navigation/NavigationPlacementPinButton';
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

type PhoneMenuItem = PhonePlacementItem & Readonly<{
    title: string;
    icon: IconName;
    phonePlacement: 'bar' | 'more' | 'none';
    disabledReason?: string | null;
    disabledReasonCode?: string;
    count?: string;
    moreTrailing?: React.ReactNode;
}>;

export type DetailPhonePreviewMetrics = Readonly<{ metrics: ReturnType<typeof resolveTabBarMetrics>; slotCount: number | null }>;

export function detailNavigationTab(item: Pick<PhoneMenuItem, 'id' | 'title' | 'icon' | 'disabledReason'>): CockpitTabBarTabDefinition<string> & Readonly<{ sfSymbol: string }> {
    return { id: item.id, label: item.title, icon: item.icon, sfSymbol: sfSymbolForCockpitTabIcon(item.icon),
        disabled: Boolean(item.disabledReason), unavailableReason: item.disabledReason ?? undefined };
}

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
    /** Session's tools may own the horizontal axis instead of waiting in More. */
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
    const fit = resolveDetailPhoneBarFit(input.placement, slotCount, input.overflowBehavior);
    const { behindMore } = fit;
    const activeBehindMore = behindMore.find(item => item.id === input.activeId)
        ?? input.items.find(item => item.id === input.activeId && item.phonePlacement === 'none');
    const openMore = React.useCallback(() => setMoreOpen(true), []);
    const customize = () => {
        setMoreOpen(false);
        if (input.onCustomize) { input.onCustomize({ metrics, slotCount }); return; }
        const customizer = input.customizer;
        fireAndForget(import('@/components/ui/navigation/NavigationPlacementCustomizer').then(({ DetailNavigationCustomizer }) => {
            Modal.show({ component: DetailNavigationCustomizer, props: customizer });
        }), { tag: 'DetailPhoneNavigation.customize' });
    };
    const menu = <DetailPhoneMoreMenu testIDPrefix={`${input.pageKind}-cockpit`} nativeAnchorTestID={`${input.pageKind}-native-more-anchor`}
        native={input.native} surfaceId={input.address} preferences={preferences} activeId={input.activeId}
        open={moreOpen} onOpenChange={setMoreOpen} onSelect={input.select} onCustomize={customize}
        activeTrigger={activeBehindMore ? { title: activeBehindMore.count ? `${activeBehindMore.title}, ${activeBehindMore.count}` : activeBehindMore.title,
            icon: activeBehindMore.icon } : null}
        entries={behindMore.map(entry => {
            const pinned = placements.effectivePlacements[entry.id] === 'pinned';
            return { id: entry.id, title: entry.title, icon: entry.icon, kind: entry.navigation.kind, pinned,
                pinnable: entry.allowedPlacements === undefined || entry.allowedPlacements.includes(pinned ? 'overflow' : 'pinned'),
                disabled: Boolean(entry.disabledReason),
                subtitle: entry.disabledReason ? entry.disabledReasonCode ? entry.disabledReason
                    : resolveReasonCopy({ kind: 'pluginRuntime', reasonCode: entry.disabledReason }).body
                    : input.heldSubtitle !== undefined && fit.held.some(item => item.id === entry.id) ? input.heldSubtitle : entry.count,
                trailing: moreOpen ? entry.moreTrailing : undefined };
        })} />;
    return { ...fit, menu, openMore, metrics, slotCount };
}

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
 * bar's More listing only what is behind it, pages before companions, each pinnable where its policy
 * allows, then Customize. The bar's own items are not repeated here; Customize moves those.
 */
export function DetailPhoneMoreMenu(props: Readonly<{
    testIDPrefix: string;
    nativeAnchorTestID: string;
    native: boolean;
    surfaceId: NavigationPlacementAddress;
    preferences: NavigationPlacementPreferences;
    entries: readonly DetailPhoneMoreEntry[];
    activeId: string;
    /** The item behind More that is selected, shown in the More slot. */
    activeTrigger: Readonly<{ title: string; icon: IconName }> | null;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSelect: (id: string) => void;
    onCustomize: () => void;
}>) {
    const { entries, open, testIDPrefix: prefix } = props;
    const ordered = [...entries.filter(entry => entry.kind !== 'companion'), ...entries.filter(entry => entry.kind === 'companion')];
    const items: readonly DropdownMenuItem[] = [...ordered.map(entry => ({
        id: entry.id, title: entry.title, icon: <Icon name={entry.icon} size={18} />,
        category: entry.kind === 'companion' ? 'companions' : 'pages', checked: entry.id === props.activeId,
        disabled: entry.disabled === true, ...(entry.subtitle ? { subtitle: entry.subtitle } : {}),
        testID: `${prefix}-more-item:${entry.id}`,
        // Pins mount only while the menu is open: a closed More holds no per-row settings writers.
        rightElement: open && (entry.pinnable || entry.trailing) ? <>
            {entry.trailing}
            {entry.pinnable ? <NavigationPlacementPinButton surfaceId={props.surfaceId} entryId={entry.id} pinned={entry.pinned}
                label={t(entry.pinned ? 'phoneNav.bar.removeFromBar' : 'phoneNav.bar.keepOnBar')} preferences={props.preferences}
                testID={`${prefix}-pin:${entry.id}`} /> : null}
        </> : undefined,
    })), { id: 'customize', title: t('navigationPlacement.customizeTabs'), icon: <Icon name="sliders-horizontal" size={18} />,
        testID: `${prefix}-more-customize` }];
    return <DropdownMenu open={open} onOpenChange={props.onOpenChange} items={items}
        selectedId={entries.some(entry => entry.id === props.activeId) ? props.activeId : null}
        onSelect={id => { props.onOpenChange(false); if (id === 'customize') props.onCustomize(); else props.onSelect(id); }}
        matchTriggerWidth={false} placement="top" trigger={({ open: expanded, toggle }) => props.native
            ? <View collapsable={false} testID={props.nativeAnchorTestID} style={{ width: 0, height: 0 }} />
            : <CockpitTabBarAction testID={`${prefix}-tab-more`} label={props.activeTrigger?.title ?? t('common.more')}
                icon={props.activeTrigger?.icon ?? 'dots-three'} selected={props.activeTrigger !== null} expanded={expanded} onPress={toggle} />} />;
}
