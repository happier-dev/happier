import * as React from 'react';
import type { PaneMainColumnState } from '@/components/appShell/panes/mainColumn/usePaneMainColumn';
import { useDestinationFocus, useDestinationVisibility } from '@/components/appShell/workspace/destinationInstanceContext';
import type { useMountedScopeActionCommand } from '@/components/approvals/useMountedScopeActionCommand';
import type { SystemMobileBottomChromeModel } from '@/components/navigation/mobile/chrome/systemMobileBottomChromeTypes';
import { useDetailPhonePlacement } from '@/components/navigation/mobile/chrome/bars/detailPhoneNavigation';
import { createPresentedDetailContext } from '@/components/ui/navigation/createPresentedDetailContext';
import type { DetailNavigationCustomizerProps } from '@/components/ui/navigation/NavigationPlacementCustomizer';
import { useNavigationSurfacePlacement } from '@/components/ui/navigation/useNavigationSurfacePlacement';
import { Modal } from '@/modal';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { resolveNavigationPlacements, type DetailNavigationAddress } from '@/sync/domains/settings/mobileSurfacePinning';
import { notifyShellColumnActionOwnersChanged, registerShellColumnActionOwner, type ShellColumnActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import { t } from '@/text';
import { resolveDetailPhoneNavigationItem, type DetailPageNavigationItem } from './detailNavigationItems';

type Execute = ReturnType<typeof useMountedScopeActionCommand>;
export type DetailPhoneChrome = Readonly<{ node: React.ReactElement; systemModel: SystemMobileBottomChromeModel }>;
export type DetailNavigationMainColumnControls = Pick<ShellColumnActionOwner,
    'present' | 'visible' | 'available' | 'label' | 'arrangementAvailable' | 'setVisible'>;
export type PresentedDetailNavigationModel = Readonly<{
    pageKind: string;
    identity: string;
    scope: ServerAccountScope | null;
    title: string;
    items: readonly DetailPageNavigationItem[];
    companionItems: readonly DetailPageNavigationItem[];
    activeId: string;
    desktopAddress: DetailNavigationAddress;
    companionAddress: DetailNavigationAddress;
    phoneAddress: DetailNavigationAddress;
    readColumn: (column: 'main' | 'side') => ShellColumnActionOwner;
    bindMainColumn: (read: () => DetailNavigationMainColumnControls) => () => void;
    phoneChrome: (execute: Execute) => DetailPhoneChrome | null;
    chromeRevision?: unknown;
    sessionId?: string;
    rootHosted?: boolean;
    registerSide?: boolean;
}>;

const chrome = createPresentedDetailContext<PresentedDetailNavigationModel>();
export const PresentedDetailNavigationBoundary = chrome.Boundary;
function PresentedDetailActionOwner() {
    const model = chrome.useValue();
    React.useEffect(() => {
        if (!model) return;
        const main = registerShellColumnActionOwner('main', () => model.readColumn('main'));
        const side = model.registerSide === false ? () => {} : registerShellColumnActionOwner('side', () => model.readColumn('side'));
        return () => { main(); side(); };
    }, [model?.identity, model?.pageKind, model?.scope, model?.registerSide, model?.readColumn]);
    React.useEffect(() => { notifyShellColumnActionOwnersChanged(); }, [model]);
    return null;
}
export function PresentedDetailNavigationProvider(props: Readonly<{ children: React.ReactNode }>) {
    return <chrome.Provider>{props.children}<PresentedDetailActionOwner /></chrome.Provider>;
}
export const usePresentedDetailNavigationChrome = chrome.useValue;

export function detailNavigationCustomizer(model: Pick<PresentedDetailNavigationModel,
    'pageKind' | 'title' | 'items' | 'companionItems' | 'desktopAddress' | 'companionAddress' | 'phoneAddress'>,
    device: 'desktop' | 'phone'): DetailNavigationCustomizerProps {
    return { pageKind: model.pageKind, pageTitle: model.title, device,
        desktop: [{ id: 'pages', address: model.desktopAddress, title: t('navigationPlacement.topTabs'),
            description: t('navigationPlacement.topTabsDescription'), items: model.items.filter(item => item.navigation.kind !== 'companion') },
        ...(model.companionItems.length ? [{ id: 'companions', address: model.companionAddress,
            title: t('navigationPlacement.rail'), description: t('navigationPlacement.railDescription'), items: model.companionItems }] : [])],
        phone: [{ id: 'items', address: model.phoneAddress, title: t('navigationPlacement.phoneBar'),
            description: t('navigationPlacement.phoneBarDescription'), items: model.items.map(resolveDetailPhoneNavigationItem),
            placementLabels: { pinned: t('navigationPlacement.bar') } }], phonePageTabs: true,
        testID: `${model.pageKind}-navigation-customizer` };
}

/** Domain hosts supply their catalog and effects; placement, Action delivery and chrome have one adapter. */
export function usePresentedDetailNavigation(input: Readonly<{
    pageKind: string; identity: string; scope: ServerAccountScope | null;
    items: readonly DetailPageNavigationItem[]; activeId: string; title?: string;
    phone: boolean; presented: boolean;
    customizer?: DetailNavigationCustomizerProps | ((device: 'desktop' | 'phone') => DetailNavigationCustomizerProps);
    selectPage: (id: string) => void;
    companion?: Readonly<{ items?: readonly DetailPageNavigationItem[]; activeId: string | null;
        idForItem?: (item: DetailPageNavigationItem) => string;
        activeIds?: readonly string[]; select: (id: string) => void; close: () => void }>;
    mainControls?: React.RefObject<PaneMainColumnState | null>;
    registerSide?: boolean;
    columnState?: (column: 'main' | 'side') => Pick<ShellColumnActionOwner, 'visible' | 'activeTab' | 'setVisible'>;
    phoneChrome?: (execute: Execute) => DetailPhoneChrome | null;
    chromeRevision?: unknown;
    sessionId?: string;
    rootHosted?: boolean;
}>) {
    const { pageKind, identity, items, phone } = input;
    const desktopAddress = React.useMemo<DetailNavigationAddress>(() => ({ pageKind, device: 'desktop', section: 'pages' }), [pageKind]);
    const companionAddress = React.useMemo<DetailNavigationAddress>(() => ({ pageKind, device: 'desktop', section: 'companions' }), [pageKind]);
    const phoneAddress = React.useMemo<DetailNavigationAddress>(() => ({ pageKind, device: 'phone', section: 'items' }), [pageKind]);
    const pages = React.useMemo(() => items.filter(item => item.navigation.kind !== 'companion'
        && (phone || item.navigation.desktop !== 'none')), [items, phone]);
    const companions = React.useMemo(() => input.companion?.items ?? items.filter(item => item.navigation.kind !== 'page'), [items, input.companion?.items]);
    const companionIdForItem = input.companion?.idForItem;
    const addressedCompanions = React.useMemo(() => companionIdForItem
        ? companions.map(item => ({ ...item, id: companionIdForItem(item) })) : companions, [companions, companionIdForItem]);
    const { preferences } = useNavigationSurfacePlacement(desktopAddress, !phone);
    const { preferences: companionPreferences } = useNavigationSurfacePlacement(companionAddress, !phone);
    const desktop = React.useMemo(() => resolveNavigationPlacements(pages, preferences), [pages, preferences]);
    const desktopCompanions = React.useMemo(() => resolveNavigationPlacements(addressedCompanions, companionPreferences), [addressedCompanions, companionPreferences]);
    const phonePlacement = useDetailPhonePlacement(items, phoneAddress, pageKind, phone);
    const placements = phone ? phonePlacement.placements : desktop;
    const latest = React.useRef(input);
    latest.current = input;
    const physicalMain = React.useRef<(() => DetailNavigationMainColumnControls) | null>(null);
    const bindMainColumn = React.useCallback((read: () => DetailNavigationMainColumnControls) => {
        physicalMain.current = read;
        notifyShellColumnActionOwnersChanged();
        return () => {
            if (physicalMain.current !== read) return;
            physicalMain.current = null;
            notifyShellColumnActionOwnersChanged();
        };
    }, []);
    const customization = React.useMemo(() => ({ pageKind, title: input.title ?? '', items, companionItems: addressedCompanions,
        desktopAddress, companionAddress, phoneAddress }), [pageKind, input.title, items, addressedCompanions, desktopAddress, companionAddress, phoneAddress]);
    const openNavigationCustomizer = React.useCallback(async (override?: DetailNavigationCustomizerProps) => {
        const { DetailNavigationCustomizer } = await import('@/components/ui/navigation/NavigationPlacementCustomizer');
        const device = phone ? 'phone' : 'desktop';
        const customizer = latest.current.customizer;
        const props = override ?? (typeof customizer === 'function' ? customizer(device)
            : customizer ?? detailNavigationCustomizer(customization, device));
        Modal.show({ component: DetailNavigationCustomizer, props });
    }, [customization, phone]);
    const currentReader = React.useRef<(column: 'main' | 'side') => ShellColumnActionOwner>(() => ({ present: false, visible: false, available: false, setVisible: () => {} }));
    currentReader.current = column => {
        const current = latest.current;
        const main = column === 'main';
        const entries = main ? pages : phone ? companions.filter(item => item.phonePlacement !== 'none') : companions;
        const itemId = (item: DetailPageNavigationItem) => main ? item.id : current.companion?.idForItem?.(item) ?? item.id;
        const controls = current.mainControls?.current;
        const columnState = current.columnState?.(column);
        const placed = phone ? phonePlacement.placements : main ? desktop : desktopCompanions;
        const navigation: ShellColumnActionOwner = {
            present: main || entries.length > 0,
            available: entries.length > 0,
            visible: main ? !controls?.hidden : current.companion?.activeId != null,
            tabs: entries.map(itemId), activeTab: main ? current.activeId : current.companion?.activeId ?? undefined,
            items: entries.map(item => ({ id: itemId(item), label: item.title, available: !item.disabledReason,
                ...(item.disabledReason ? { reason: item.disabledReason } : {}),
                pageKind, placement: placed.effectivePlacements[phone ? item.id : itemId(item)] ?? 'overflow' })),
            selectTab: id => {
                if (main) latest.current.selectPage(id);
                else latest.current.companion?.select(id);
            },
            setVisible: visible => {
                if (main) controls?.setHidden(!visible);
                else if (!visible) latest.current.companion?.close();
                else if (latest.current.companion?.activeId == null && entries[0]) latest.current.companion?.select(itemId(entries[0]));
            },
            ...columnState,
            ...(main ? { openNavigationCustomizer } : {}),
        };
        const physical = main ? physicalMain.current?.() : null;
        return physical ? { ...navigation, ...physical, available: navigation.available || physical.available } : navigation;
    };
    const readColumn = React.useCallback((column: 'main' | 'side') => currentReader.current(column), []);
    const phoneChrome = React.useCallback((execute: Execute) => latest.current.phoneChrome?.(execute) ?? null, []);
    const model = React.useMemo<PresentedDetailNavigationModel>(() => ({ ...customization, identity, scope: input.scope,
        activeId: input.activeId, readColumn, bindMainColumn, phoneChrome, chromeRevision: input.chromeRevision, sessionId: input.sessionId,
        rootHosted: input.rootHosted, registerSide: input.registerSide }),
    [customization, identity, input.scope, input.activeId, readColumn, bindMainColumn, phoneChrome, input.chromeRevision, input.sessionId,
        input.rootHosted, input.registerSide, desktop, desktopCompanions, phonePlacement.placements, input.companion?.activeId]);
    const focused = useDestinationFocus();
    const visible = useDestinationVisibility();
    const presented = input.presented && focused && visible;
    chrome.usePublish(model, presented);
    return React.useMemo(() => ({ model, pages, companions, placements, desktop, desktopCompanions, phonePlacement,
        desktopAddress, companionAddress, phoneAddress, readColumn, openNavigationCustomizer }),
    [model, pages, companions, placements, desktop, desktopCompanions, phonePlacement,
        desktopAddress, companionAddress, phoneAddress, readColumn, openNavigationCustomizer]);
}

export function selectPresentedDetailNavigationItem(execute: Execute,
    model: Readonly<{ items: readonly Pick<DetailPageNavigationItem, 'id' | 'navigation'>[];
        readColumn: PresentedDetailNavigationModel['readColumn'] }>, id: string, column?: 'main' | 'side', visible = true): void {
    const item = model.items.find(item => item.id === id);
    if (!item) return;
    const target = column ?? (item.navigation.kind === 'companion' ? 'side' : 'main');
    void execute('shell.column.set', { column: target, visible, ...(visible ? { tab: id } : {}) },
        { kind: 'shell.column', column: target, read: () => model.readColumn(target) });
}
