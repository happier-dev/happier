import * as React from 'react';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginUiPageNavigationProjectionV1 } from '@happier-dev/protocol/plugins/ui/pageNavigation';
import { resolveDetailNavigationItems, type DetailPageNavigationItem } from '@/components/appShell/rightSidebar/detailNavigationItems';
import { selectPresentedDetailNavigationItem, usePresentedDetailNavigation } from '@/components/appShell/rightSidebar/usePresentedDetailNavigation';
import type { DetailNavigationAddress } from '@/sync/domains/settings/mobileSurfacePinning';
import { useSetting } from '@/sync/store/settingsReadHooks';
import { useDeviceType } from '@/utils/platform/responsive';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import type { ShellColumnActionOwner } from '@/sync/ops/actions/scopeActionFamily';
import { PluginDetailCockpitTabBar } from './PluginDetailNavigationViews';
import type { PluginSurfaceOpenHandler } from '@/components/plugins/surfaces/openPluginSurface';
import { createPluginPageNavigationOwner } from './pluginPageNavigationOwner';

export type PluginDetailNavigationModel = Readonly<{
    scope: ServerAccountScope | null;
    pageKind: string;
    title: string;
    items: readonly DetailPageNavigationItem[];
    companionItems: readonly DetailPageNavigationItem[];
    activeId: string;
    desktopAddress: DetailNavigationAddress;
    companionAddress: DetailNavigationAddress;
    phoneAddress: DetailNavigationAddress;
    readColumn: (column: 'main' | 'side') => ShellColumnActionOwner;
}>;
const EMPTY_ITEMS: readonly DetailPageNavigationItem[] = Object.freeze([]);

/** The descriptor supplies M1 once; placement and selection never rebuild its catalog. */
export function usePluginDetailNavigation(input: Readonly<{
    identity: string;
    lifetime: unknown;
    scope: ServerAccountScope | null;
    live: boolean;
    presented: boolean;
    title: string;
    openSurface?: PluginSurfaceOpenHandler;
}>) {
    const owner = React.useMemo(() => createPluginPageNavigationOwner(), [input.identity, input.lifetime]);
    React.useEffect(() => () => owner.clear(), [owner]);
    React.useEffect(() => { if (!input.live) owner.clear(); }, [owner, input.live]);
    const snapshot = React.useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot);
    const navigation = snapshot.navigation;
    const pageKind = navigation ? buildQualifiedPluginContributionKey(navigation.pageKind) : input.identity;
    const declaredItems = navigation?.items;
    const items = React.useMemo(() => declaredItems ? resolveDetailNavigationItems({ scope: 'plugin', items: declaredItems }) : EMPTY_ITEMS, [declaredItems]);
    const pages = React.useMemo(() => items.filter(item => item.navigation.kind !== 'companion'), [items]);
    const companions = React.useMemo(() => items.filter(item => item.navigation.kind !== 'page').map(item =>
        // The primary page is reserved; its independently addressed companion is movable.
        item === pages[0] ? { ...item, allowedPlacements: undefined } : item), [items, pages]);
    const phoneDevice = useDeviceType() === 'phone';
    const cockpit = useSetting('mobileWorkspaceExperienceV1') === 'cockpit';
    const detail = usePresentedDetailNavigation({ pageKind, identity: input.identity, scope: input.scope,
        title: input.title, items, activeId: navigation?.value ?? '', phone: phoneDevice,
        presented: input.live && input.presented && navigation !== null && (!phoneDevice || navigation.phonePresented !== false),
        rootHosted: true, registerSide: false, selectPage: owner.select,
        companion: { items: companions, activeId: null, close: () => {}, select: id => {
            const item = navigation?.items.find(item => item.value === id);
            if (item && item.kind !== 'page') void input.openSurface?.({ destination: item.companion });
        } },
        phoneChrome: execute => {
            if (!model) return null;
            const props = { model, onSelect: (id: string) => selectPresentedDetailNavigationItem(execute, model, id) };
            return { node: <PluginDetailCockpitTabBar {...props} />, systemModel: { kind: 'pluginCockpit', props } };
        } });
    const { desktop, phonePlacement: phone } = detail;
    const projection = React.useMemo<PluginUiPageNavigationProjectionV1 | null>(() => navigation ? {
        pageKind: navigation.pageKind,
        items: navigation.items,
        tabIds: (phoneDevice ? cockpit ? phone.pageTabs === 'top' ? phone.placements.pinned.filter(item => item.navigation.kind !== 'companion') : [] : pages : desktop.pinned).map(item => item.id),
        overflowIds: phoneDevice ? [] : desktop.overflow.map(item => item.id),
        presentation: phoneDevice && cockpit ? phone.pageTabs === 'top' ? 'top' : 'bottom' : 'local',
        request: snapshot.request,
    } : null, [navigation?.pageKind.pluginId, navigation?.pageKind.localId, Boolean(navigation), snapshot.request,
        phoneDevice, cockpit, phone.placements, phone.pageTabs, pages, desktop.pinned, desktop.overflow]);
    const model = React.useMemo<PluginDetailNavigationModel | null>(() => navigation ? detail.model : null,
        [Boolean(navigation), detail.model]);
    return { owner, projection, model };
}

export const selectPluginDetailNavigationItem = selectPresentedDetailNavigationItem;
