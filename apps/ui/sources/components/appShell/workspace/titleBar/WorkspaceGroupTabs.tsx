import * as React from 'react';
import { Platform, View, type LayoutChangeEvent } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { hrefForDestinationRef, resolveCurrentAppDestination, useDestinationInstanceTitles, type CompactAppDestination } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { DETAILS_TAB_STRIP_METRICS as M } from '@/components/appShell/panes/details/header/detailsTabHeaderMetrics';
import type { SplitCanvasDirection } from '@/components/appShell/splitCanvas/model/splitCanvasTypes';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { resolveTouchTargetFloorPx } from '@/components/ui/interactiveTargetSize';
import { DocumentTabStrip, DOCUMENT_TAB_BAR_METRICS as B, type DocumentTabItem } from '@/components/ui/navigation/DocumentTabStrip';
import type { PopoverAnchor } from '@/components/ui/popover';
import { resolvePointerMenuAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { KeyboardShortcutLabelsContext } from '@/keyboard/shortcutLabels';
import { randomUUID } from '@/platform/randomUUID';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import type { WorkspaceNavigationContextValue } from '../WorkspaceNavigationContext';
import { createWorkspaceEmptyTab, type WorkspaceGroup } from '../workspaceState';
import { createWorkspaceSplit } from '../workspaceSplit';
import { useActiveServerAccountScope, useSetting } from '@/sync/domains/state/storage';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import { useEntityDropDomBinding } from '@/components/ui/treeDragDrop/useEntityDragDomBinding';
import { executeWorkspaceEntityDrop, resolveWorkspaceEntityDrop, WORKSPACE_ENTITY_KINDS } from '../workspaceEntityDrop';
import type { DocumentTabEntityDragDrop } from '@/components/ui/navigation/DocumentTabStrip';
import { useDestinationInstanceTabPresentations } from './useDestinationInstanceTabPresentations';
import { splitCanvasEntityTargetId } from '@/components/appShell/splitCanvas/hooks/useSplitCanvasDnD';
import { presentPaneDropAdmission } from '@/components/appShell/splitCanvas/presentation/paneDropPresentation';
import { usePaneDropStripCue } from '@/components/appShell/splitCanvas/presentation/usePaneDropStripCue';
import { createWorkspaceDropScene } from '../workspaceDropScene';

type WorkspaceDocumentTab = DocumentTabItem & Readonly<{ icon: IconName }>;
type MenuState = Readonly<{ tabId: string; anchor: PopoverAnchor | undefined }>;

/** Room the "+" (new tab) and the "+N" overflow keep beside the tabs, so tabs never push them out. */
const ACTION_SLOT_PX = 30;
const OVERFLOW_SLOT_PX = 44;
const PIN_SEPARATOR_PX = 11;

/**
 * Which unpinned tabs fit at their minimum width (workspace lab V). The open tab always stays, then
 * the most recently used; the rest wait behind "+N". Strip order is kept among the tabs that show.
 */
export function selectVisibleWorkspaceTabs(input: Readonly<{
    tabIds: readonly string[];
    activeTabId: string;
    mru: readonly string[];
    capacity: number;
}>): readonly string[] {
    if (input.tabIds.length <= input.capacity) return input.tabIds;
    const keep = new Set<string>();
    if (input.tabIds.includes(input.activeTabId)) keep.add(input.activeTabId);
    for (const id of input.mru) {
        if (keep.size >= Math.max(1, input.capacity)) break;
        if (input.tabIds.includes(id)) keep.add(id);
    }
    for (const id of input.tabIds) {
        if (keep.size >= Math.max(1, input.capacity)) break;
        keep.add(id);
    }
    return input.tabIds.filter((id) => keep.has(id));
}

/**
 * One pane's tabs, wherever the pane's tabs live: in the window's top strip over a top-row pane
 * (`bar`), or in the pane's own strip below the top row (`strip`). Both are the same tabs, menu and
 * overflow; only the height and the surface they sit on differ (workspace lab T/S).
 */
export function WorkspaceGroupTabs(props: Readonly<{
    workspace: WorkspaceNavigationContextValue;
    group: WorkspaceGroup;
    catalog: readonly CompactAppDestination[];
    focused: boolean;
    placement: 'bar' | 'strip';
    /** Room reserved at the trailing end for a control the caller adds (the bar's split button). */
    trailing?: React.ReactNode;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const { workspace, group } = props;
    const scope = useActiveServerAccountScope();
    const workspaceRefs = useSetting('workspaceRefsV1');
    const runtime = useEntityDragDropRuntime();
    const safeGroup = toTestIdSafeValue(group.id);
    const shortcutLabels = React.useContext(KeyboardShortcutLabelsContext);
    const [widthPx, setWidthPx] = React.useState<number | null>(null);
    const [menu, setMenu] = React.useState<MenuState | null>(null);
    const [overflowOpen, setOverflowOpen] = React.useState(false);
    const tabHeightPx = props.placement === 'bar' ? B.tabHeightPx : M.tabHeightPx;

    const titleEntries = React.useMemo(() => group.tabIds.flatMap((id) => {
        const tab = workspace.state.tabs[id];
        return tab ? [{ key: id, ref: tab.target }] : [];
    }), [group.tabIds, workspace.state.tabs]);
    // The live instance title (a session's name, a file, a page); the title saved with the layout
    // stands in only while the instance cannot be named yet.
    const titleResolutionEntries = React.useMemo(() => overflowOpen
        ? [...titleEntries, ...workspace.state.recentlyClosed.map(entry => ({ key: `closed:${entry.tab.id}`, ref: entry.tab.target }))]
        : titleEntries, [overflowOpen, titleEntries, workspace.state.recentlyClosed]);
    const liveTitles = useDestinationInstanceTitles(props.catalog, titleResolutionEntries);
    const hasRecentlyClosed = workspace.state.recentlyClosed.length > 0;
    const tabs = React.useMemo(() => {
        const byId = new Map<string, WorkspaceDocumentTab>();
        for (const id of group.tabIds) {
            const tab = workspace.state.tabs[id];
            if (!tab) continue;
            const href = hrefForDestinationRef(props.catalog, tab.target);
            const destination = href ? resolveCurrentAppDestination(props.catalog, href) : null;
            byId.set(id, {
                key: tab.id,
                title: liveTitles.get(id) ?? workspace.state.fallbackTitlesByTabId[tab.id] ?? t('common.unavailable'),
                isPinned: tab.pinned, isPreview: tab.preview, canPin: !tab.pinned,
                icon: destination?.icon ?? 'file',
            });
        }
        return byId;
    }, [group.tabIds, liveTitles, props.catalog, workspace.state.fallbackTitlesByTabId, workspace.state.tabs]);

    const pinnedIds = group.tabIds.filter((id) => tabs.get(id)?.isPinned);
    const unpinnedIds = group.tabIds.filter((id) => tabs.has(id) && !tabs.get(id)?.isPinned);
    const capacity = React.useMemo(() => {
        if (widthPx === null) return unpinnedIds.length;
        const pinnedPx = pinnedIds.length * (tabHeightPx + B.stripGapPx) + (pinnedIds.length > 0 ? PIN_SEPARATOR_PX : 0);
        const room = widthPx - pinnedPx - ACTION_SLOT_PX - (hasRecentlyClosed ? OVERFLOW_SLOT_PX : 0);
        if (room >= unpinnedIds.length * (B.tabMinWidthPx + B.stripGapPx)) return unpinnedIds.length;
        return Math.max(1, Math.floor((room - (hasRecentlyClosed ? 0 : OVERFLOW_SLOT_PX)) / (B.tabMinWidthPx + B.stripGapPx)));
    }, [hasRecentlyClosed, pinnedIds.length, tabHeightPx, unpinnedIds.length, widthPx]);
    const visibleUnpinned = selectVisibleWorkspaceTabs({ tabIds: unpinnedIds, activeTabId: group.activeTabId, mru: group.mru, capacity });
    const hiddenCount = unpinnedIds.length - visibleUnpinned.length;
    const pinnedTabs = pinnedIds.flatMap((id) => tabs.get(id) ?? []);
    const visibleTabs = visibleUnpinned.flatMap((id) => tabs.get(id) ?? []);
    // Hidden tabs have no status mark; keep their live work updates out of the mounted strip.
    const visibleTabKeys = new Set([...pinnedIds, ...visibleUnpinned]);
    const livePresentations = useDestinationInstanceTabPresentations(titleEntries.filter(entry => visibleTabKeys.has(entry.key)));

    const onLayout = React.useCallback((event: LayoutChangeEvent) => {
        const next = Math.round(event.nativeEvent.layout.width);
        setWidthPx((current) => (current === next ? current : next));
    }, []);

    const split = React.useCallback((tabId: string, direction: SplitCanvasDirection) => {
        const measurement = workspace.canvasControlsRef?.current?.readSplitMeasurement(group.id, direction);
        if (!measurement) return;
        const action = createWorkspaceSplit(workspace.state, {
            groupId: group.id, tabId, direction, createId: randomUUID, ...measurement,
        });
        if (action) workspace.dispatch(action);
    }, [group.id, workspace]);

    const menuTab = menu ? workspace.state.tabs[menu.tabId] : undefined;
    const menuItems = React.useMemo((): readonly DropdownMenuItem[] => {
        if (!menuTab) return [];
        const glyph = (name: IconName) => <Icon name={name} size={16} color={theme.colors.text.secondary} />;
        const index = group.tabIds.indexOf(menuTab.id);
        const hasOthers = group.tabIds.some((id) => id !== menuTab.id && !workspace.state.tabs[id]?.pinned);
        const hasRight = group.tabIds.slice(index + 1).some((id) => !workspace.state.tabs[id]?.pinned);
        const multiplePanes = Object.keys(workspace.state.groups).length > 1;
        const maximized = workspace.state.maximizedGroupId === group.id;
        return [
            menuTab.pinned
                ? { id: 'unpin', testID: 'workspace-tab-menu-unpin', title: t('workspaceBar.unpinTab'), icon: glyph('push-pin-slash') }
                : { id: 'pin', testID: 'workspace-tab-menu-pin', title: t('workspaceBar.pinTab'), icon: glyph('push-pin') },
            { id: 'splitRight', testID: 'workspace-tab-menu-split-right', title: t('workspaceBar.splitRight'), icon: glyph('square-split-horizontal'), shortcut: shortcutLabels['workspace.splitRight'] },
            { id: 'splitDown', testID: 'workspace-tab-menu-split-down', title: t('workspaceBar.splitDown'), icon: glyph('square-split-vertical'), shortcut: shortcutLabels['workspace.splitDown'] },
            ...(multiplePanes ? [{
                id: 'maximize', testID: 'workspace-tab-menu-maximize',
                title: maximized ? t('workspaceBar.restorePane') : t('workspaceBar.maximizePane'),
                icon: glyph('arrows-out'), shortcut: shortcutLabels['workspace.toggleMaximize'],
            }] : []),
            { id: 'close', testID: 'workspace-tab-menu-close', title: t('workspaceBar.closeTab'), icon: glyph('x') },
            ...(hasRecentlyClosed ? [{ id: 'reopen', testID: 'workspace-tab-menu-reopen', title: t('workspaceTabs.reopenTab'), shortcut: shortcutLabels['workspace.tab.reopen'], icon: glyph('clock-counter-clockwise') }] : []),
            ...(hasOthers ? [{ id: 'closeOthers', testID: 'workspace-tab-menu-close-others', title: t('workspaceBar.closeOtherTabs') }] : []),
            ...(hasRight ? [{ id: 'closeRight', testID: 'workspace-tab-menu-close-right', title: t('workspaceBar.closeTabsToRight') }] : []),
        ];
    }, [group.id, group.tabIds, hasRecentlyClosed, menuTab, shortcutLabels, theme.colors.text.secondary, workspace.state.groups,
        workspace.state.maximizedGroupId, workspace.state.tabs]);

    const selectMenu = React.useCallback((itemId: string) => {
        const tabId = menu?.tabId;
        setMenu(null);
        if (!tabId) return;
        switch (itemId) {
            case 'pin': workspace.dispatch({ type: 'setPinned', tabId, pinned: true }); break;
            case 'unpin': workspace.dispatch({ type: 'setPinned', tabId, pinned: false }); break;
            case 'splitRight': split(tabId, 'right'); break;
            case 'splitDown': split(tabId, 'down'); break;
            case 'maximize': workspace.dispatch({ type: 'toggleMaximize', groupId: group.id }); break;
            case 'close': workspace.closeTab(group.id, tabId); break;
            case 'reopen': workspace.dispatch({ type: 'reopenTab' }); break;
            case 'closeOthers':
                workspace.closeTabs(group.id, group.tabIds.filter((id) => id !== tabId));
                break;
            case 'closeRight': {
                const index = group.tabIds.indexOf(tabId);
                workspace.closeTabs(group.id, group.tabIds.slice(index + 1));
                break;
            }
        }
    }, [group.id, group.tabIds, menu?.tabId, split, workspace]);

    const overflowItems = React.useMemo((): readonly DropdownMenuItem[] => [...group.tabIds.flatMap((id) => {
        const tab = tabs.get(id);
        return tab ? [{
            id, testID: `workspace-overflow-tab-${toTestIdSafeValue(id)}`, title: tab.title,
            icon: <Icon name={tab.icon} size={16} color={theme.colors.text.secondary} />,
            checked: id === group.activeTabId,
            ...(hasRecentlyClosed ? { category: t('workspaceBar.tabsLabel') } : {}),
        }] : [];
    }), ...workspace.state.recentlyClosed.map((entry, index) => ({
        id: `closed:${entry.tab.id}`, testID: `workspace-reopen-tab-${toTestIdSafeValue(entry.tab.id)}`,
        title: liveTitles.get(`closed:${entry.tab.id}`) ?? entry.fallbackTitle ?? t('common.unavailable'),
        category: t('workspaceTabs.recentlyClosed'),
        icon: <Icon name="clock-counter-clockwise" size={16} color={theme.colors.text.secondary} />,
        ...(index === 0 ? { shortcut: shortcutLabels['workspace.tab.reopen'] } : {}),
    }))], [group.activeTabId, group.tabIds, hasRecentlyClosed, liveTitles, shortcutLabels, tabs, theme.colors.text.secondary, workspace.state.recentlyClosed]);

    const entityDragDrop: DocumentTabEntityDragDrop | undefined = scope ? {
        runtime, id: `workspace-tabs:${group.id}`, scope, acceptedKinds: WORKSPACE_ENTITY_KINDS,
        isCurrent: () => workspace.active && Boolean(workspace.state.groups[group.id])
            && !workspace.phone && (!workspace.state.maximizedGroupId || workspace.state.maximizedGroupId === group.id),
        getItem: tabId => workspace.state.tabs[tabId] && workspace.state.groups[group.id]?.tabIds.includes(tabId)
            ? { kind: 'workspace-tab', scope, tabId } : null,
        resolve: ({ item, beforeTabId }) => presentPaneDropAdmission(resolveWorkspaceEntityDrop({
            workspace, scope, item, beforeTabId, target: { leafId: group.id, placement: 'center' },
            catalog: props.catalog, workspaceRefs,
        }), createWorkspaceDropScene(workspace.state, props.catalog, { paneId: group.id, beforeTabId })),
        execute: effect => executeWorkspaceEntityDrop(effect, scope),
    } : undefined;
    const latestEntity = React.useRef(entityDragDrop);
    latestEntity.current = entityDragDrop;
    const stripHost = React.useRef<HTMLElement | null>(null);
    const dropHostRef = useEntityDropDomBinding(runtime);
    const attachStrip = React.useCallback((node: unknown) => {
        stripHost.current = node as HTMLElement | null;
        dropHostRef(node);
    }, [dropHostRef]);
    React.useEffect(() => {
        if (!scope) return;
        return runtime.registerTarget({
            id: `workspace-strip:${group.id}`, scope, acceptedKinds: WORKSPACE_ENTITY_KINDS,
            isCurrent: () => latestEntity.current?.scope.serverId === scope.serverId
                && latestEntity.current.scope.accountId === scope.accountId && latestEntity.current.isCurrent?.() !== false,
            getBounds: () => {
                const rect = stripHost.current?.getBoundingClientRect?.();
                return rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null;
            },
            listDestinations: () => [{ destination: { beforeTabId: null }, label: t('workspaceBar.tabsLabel') }],
            resolve: ({ item, input }) => latestEntity.current!.resolve({ item, beforeTabId: null, input }),
            execute: effect => latestEntity.current!.execute(effect),
        });
    }, [runtime, group.id, scope?.serverId, scope?.accountId]);

    // The pane centre (shell canvas id `workspace`) and this strip's empty end both land a kept tab here.
    const dropTargetIds = React.useMemo(() => [splitCanvasEntityTargetId('workspace', group.id, 'center'), `workspace-strip:${group.id}`], [group.id]);
    const dropCue = usePaneDropStripCue(scope ? runtime : null, { targetIds: dropTargetIds, tabIds: group.tabIds });

    const touchFloor = resolveTouchTargetFloorPx(Platform.OS);
    const actionSize = Math.max(props.placement === 'bar' ? 28 : M.actionSizePx, touchFloor ?? 0);
    const renderStrip = (items: readonly WorkspaceDocumentTab[]) => (
        <DocumentTabStrip
            variant="bar"
            barTabHeightPx={tabHeightPx}
            activeEmphasis={props.focused ? 'raised' : 'quiet'}
            tabs={items}
            activeTabKey={group.activeTabId}
            resolveTabPresentation={(tab) => livePresentations.get(tab.key)}
            accessibilityLabel={t('workspaceBar.tabsLabel')}
            onActivate={(tabId) => workspace.activateTab(group.id, tabId)}
            onPin={(tabId) => workspace.dispatch({ type: 'setPinned', tabId, pinned: true })}
            onUnpin={(tabId) => workspace.dispatch({ type: 'setPinned', tabId, pinned: false })}
            onClose={(tabId) => workspace.closeTab(group.id, tabId)}
            onTabMenu={(tabId, event) => setMenu({ tabId, anchor: resolvePointerMenuAnchor(event) })}
            entityDragDrop={entityDragDrop}
            dropSlot={dropCue.slot}
            dropRingTabKey={dropCue.pulseTabKey}
            renderLeadingIcon={(tab, emphasized) => <Icon name={tab.icon} size={M.tabGlyphPx}
                color={emphasized ? theme.colors.text.primary : theme.colors.text.secondary} />}
            tabNativeId={(key) => `workspace-${safeGroup}-tab-${toTestIdSafeValue(key)}`}
            panelNativeId={(key) => `workspace-${safeGroup}-panel-${toTestIdSafeValue(key)}`}
            testIds={{ tab: (key) => `workspace-tab-${key}`, tabClose: (key) => `workspace-tab-close-${key}` }}
        />
    );

    return (
        <View ref={attachStrip} testID={`workspace-tabs-${safeGroup}`} style={styles.row} onLayout={onLayout}>
            <View style={styles.tabs}>
                {renderStrip([...pinnedTabs, ...visibleTabs])}
            </View>
            {hiddenCount > 0 || hasRecentlyClosed ? (
                <DropdownMenu
                    open={overflowOpen}
                    onOpenChange={setOverflowOpen}
                    items={overflowItems}
                    onSelect={(tabId) => {
                        const closed = workspace.state.recentlyClosed.find(entry => `closed:${entry.tab.id}` === tabId);
                        if (closed) workspace.dispatch({ type: 'reopenTab', tabId: closed.tab.id });
                        else workspace.activateTab(group.id, tabId);
                    }}
                    search
                    searchPlaceholder={t('workspaceBar.searchTabs')}
                    matchTriggerWidth={false}
                    maxWidthCap={300}
                    placement="bottom"
                    popoverAnchorAlign="start"
                    trigger={({ toggle }) => (
                        <IconButton
                            testID={`workspace-overflow-${safeGroup}`}
                            variant="plain"
                            size={actionSize}
                            accessibilityLabel={hiddenCount > 0 ? t('workspaceBar.moreTabs', { count: hiddenCount }) : t('workspaceTabs.recentlyClosed')}
                            tooltip={hiddenCount > 0 ? t('workspaceBar.moreTabs', { count: hiddenCount }) : t('workspaceTabs.recentlyClosed')}
                            tooltipPlacement="bottom"
                            hasPopup="menu"
                            expanded={overflowOpen}
                            onPress={toggle}
                            icon={hiddenCount > 0 ? <Text style={styles.overflowCount}>{`+${hiddenCount}`}</Text> : <Icon name="dots-three" size={M.actionGlyphPx} color={theme.colors.text.secondary} />}
                        />
                    )}
                />
            ) : null}
            <IconButton
                testID={`workspace-new-tab-${safeGroup}`}
                variant="plain"
                size={actionSize}
                iconSize={M.actionGlyphPx}
                iconName="plus"
                accessibilityLabel={t('workspaceBar.newTab')}
                tooltip={t('workspaceBar.newTab')}
                tooltipPlacement="bottom"
                onPress={() => workspace.dispatch({ type: 'openTab', groupId: group.id, tab: createWorkspaceEmptyTab(randomUUID()) })}
            />
            <View style={styles.grow} />
            {props.trailing}
            {menu ? (
                <DropdownMenu
                    open
                    onOpenChange={(open) => { if (!open) setMenu(null); }}
                    items={menuItems}
                    onSelect={selectMenu}
                    search={false}
                    trigger={null}
                    popoverAnchor={menu.anchor}
                    matchTriggerWidth={false}
                    maxWidthCap={260}
                    placement="bottom"
                    popoverAnchorAlign="start"
                    allowEmptySelection
                />
            ) : null}
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    row: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: B.stripGapPx,
    },
    tabs: {
        flexShrink: 1,
        minWidth: 0,
        flexDirection: 'row',
    },
    grow: {
        flex: 1,
        minWidth: 8,
    },
    overflowCount: {
        ...M.tabLabel,
        ...Typography.default('semiBold'),
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    },
}));
