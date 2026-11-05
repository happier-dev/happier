import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { hrefForDestinationRef, resolveCurrentAppDestination, useDestinationInstanceTitles, useDestinationInstanceTitleSources, type CompactAppDestination, type DestinationRef, type DestinationInstanceTitleEntry } from '@/components/appShell/destinations/compactAppDestinationCatalog';
import { DETAILS_TAB_STRIP_METRICS as M } from '@/components/appShell/panes/details/header/detailsTabHeaderMetrics';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Icon, type IconName } from '@/components/ui/icons/Icon';
import { DocumentTabStrip, DOCUMENT_TAB_BAR_METRICS as B, type DocumentTabItem } from '@/components/ui/navigation/DocumentTabStrip';
import type { PopoverAnchor } from '@/components/ui/popover';
import { resolvePointerMenuAnchor } from '@/components/ui/popover/resolvePointerMenuAnchor';
import { KeyboardShortcutLabelsContext } from '@/keyboard/shortcutLabels';
import { t } from '@/text';
import { toTestIdSafeValue } from '@/utils/ui/toTestIdSafeValue';
import { useWorkspacePresentationVisibility, type WorkspaceNavigationContextValue } from '../WorkspaceNavigationContext';
import { selectWorkspaceVisibleGroup, type WorkspaceGroup } from '../workspaceState';
import { useWorkspaceOpenActions } from '../useWorkspaceOpenActions';
import { selectWorkspaceTabsToClose } from '../workspaceActions';
import { executeWorkspaceUiAction } from '../workspaceActionRuntime';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { useWorkspaceRefs, useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { useEntityDragDropRuntime } from '@/components/ui/treeDragDrop/entityDragDropHooks';
import { useEntityDropDomBinding } from '@/components/ui/treeDragDrop/useEntityDragDomBinding';
import { executeWorkspaceEntityDrop, resolveWorkspaceEntityDrop, WORKSPACE_ENTITY_KINDS } from '../workspaceEntityDrop';
import type { DocumentTabEntityDragDrop } from '@/components/ui/navigation/DocumentTabStrip';
import { useDestinationInstanceTabPresentations } from './useDestinationInstanceTabPresentations';
import { splitCanvasEntityTargetId } from '@/components/appShell/splitCanvas/hooks/useSplitCanvasDnD';
import { presentPaneDropAdmission } from '@/components/appShell/splitCanvas/presentation/paneDropPresentation';
import { usePaneDropStripCue } from '@/components/appShell/splitCanvas/presentation/usePaneDropStripCue';
import { createWorkspaceDropScene } from '../workspaceDropScene';

type WorkspaceDocumentTab = DocumentTabItem & Readonly<{
    icon: IconName;
    target: DestinationRef;
    catalog: readonly CompactAppDestination[];
    href: string | null;
}>;
type MenuState = Readonly<{ tabId: string; anchor: PopoverAnchor | undefined }>;
const EMPTY_TITLE_ENTRIES: readonly DestinationInstanceTitleEntry[] = [];

/**
 * One pane's tabs, wherever the pane's tabs live: in the window's top strip over a top-row pane
 * (`bar`), or in the pane's own strip below the top row (`strip`). Both are the same tabs and menu;
 * only the height and the surface they sit on differ (workspace lab T/S). Every tab stays in the
 * strip, which scrolls sideways; one trailing menu lists them all with the recently closed ones.
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
    const { workspace } = props;
    const presentation = useWorkspacePresentationVisibility(workspace.desktopPresentation);
    const group = React.useMemo(() => selectWorkspaceVisibleGroup(workspace.state, props.group, presentation),
        [presentation, props.group, workspace.state]);
    const scope = useActiveServerAccountScope();
    const workspaceRefs = useWorkspaceRefs();
    const runtime = useEntityDragDropRuntime();
    const safeGroup = toTestIdSafeValue(group.id);
    const shortcutLabels = React.useContext(KeyboardShortcutLabelsContext);
    const [menu, setMenu] = React.useState<MenuState | null>(null);
    const [overflowOpen, setOverflowOpen] = React.useState(false);
    const tabHeightPx = props.placement === 'bar' ? B.tabHeightPx : M.tabHeightPx;

    const titleEntries = React.useMemo(() => group.tabIds.flatMap((id) => {
        const tab = workspace.state.tabs[id];
        return tab ? [{ key: id, ref: tab.target, fallbackTitle: workspace.state.fallbackTitlesByTabId[id] }] : [];
    }), [group.tabIds, workspace.state.tabs, workspace.state.fallbackTitlesByTabId]);
    // The live instance title (a session's name, a file, a page); the title saved with the layout
    // stands in only while the instance cannot be named yet.
    const titleResolutionEntries = React.useMemo(() => overflowOpen
        ? [...titleEntries, ...workspace.state.recentlyClosed.map(entry => ({ key: `closed:${entry.tab.id}`, instanceKey: entry.tab.id, ref: entry.tab.target, fallbackTitle: entry.fallbackTitle }))]
        : titleEntries, [overflowOpen, titleEntries, workspace.state.recentlyClosed]);
    const titleSources = useDestinationInstanceTitleSources(props.catalog, titleResolutionEntries);
    const liveTitles = useDestinationInstanceTitles(props.catalog, overflowOpen ? titleResolutionEntries : EMPTY_TITLE_ENTRIES);
    const hasRecentlyClosed = workspace.state.recentlyClosed.length > 0;
    const previousTabs = React.useRef<ReadonlyMap<string, WorkspaceDocumentTab>>(new Map());
    const tabs = React.useMemo(() => {
        const byId = new Map<string, WorkspaceDocumentTab>();
        for (const id of group.tabIds) {
            const tab = workspace.state.tabs[id];
            if (!tab) continue;
            const previous = previousTabs.current.get(id);
            const sameTarget = previous?.target === tab.target && previous.catalog === props.catalog;
            const href = sameTarget ? previous.href : hrefForDestinationRef(props.catalog, tab.target);
            const icon = sameTarget ? previous.icon : (href ? resolveCurrentAppDestination(props.catalog, href)?.icon : null) ?? 'file';
            const titleSource = titleSources.get(id);
            const next: WorkspaceDocumentTab = {
                key: tab.id,
                title: previous && previous.titleSource === titleSource ? previous.title : titleSource?.getSnapshot() ?? t(href ? 'common.loading' : 'common.unavailable'),
                titleSource,
                isPinned: tab.pinned, isPreview: tab.preview, canPin: !tab.pinned,
                icon, target: tab.target, catalog: props.catalog, href,
            };
            byId.set(id, previous
                && previous.title === next.title
                && previous.titleSource === next.titleSource
                && previous.target === next.target
                && previous.catalog === next.catalog
                && previous.isPinned === next.isPinned
                && previous.isPreview === next.isPreview
                && previous.canPin === next.canPin
                && previous.icon === next.icon ? previous : next);
        }
        // Reconcile the lightweight projection so another tab's publication leaves this tab unchanged.
        previousTabs.current = byId;
        return byId;
    }, [group.tabIds, titleSources, props.catalog, workspace.state.tabs]);

    const stripTabs = React.useMemo(() => group.tabIds.flatMap((id) => tabs.get(id) ?? []), [group.tabIds, tabs]);
    const livePresentations = useDestinationInstanceTabPresentations(titleEntries);
    const renderLeadingIcon = React.useCallback((tab: WorkspaceDocumentTab, emphasized: boolean) => (
        <Icon name={tab.icon} size={M.tabGlyphPx}
            color={emphasized ? theme.colors.text.primary : theme.colors.text.secondary} />
    ), [theme.colors.text.primary, theme.colors.text.secondary]);

    const execute = React.useCallback((request: Parameters<typeof executeWorkspaceUiAction>[0]) => {
        fireAndForget(executeWorkspaceUiAction(request, href => {
            const navigation = workspace.navigationForTab(group.activeTabId);
            (navigation.pushRetainingCurrent ?? navigation.push)(href);
        }), { tag: 'Workspace.tabs' });
    }, [group.activeTabId, workspace]);
    // A tab's own menu offers every bulk close around it; the pane's tab list ends with Close others / Close all.
    const closeItems = React.useCallback((tabId: string, prefix: 'workspace-tab-menu' | 'workspace-overflow'): readonly DropdownMenuItem[] => [
        { id: 'closeOthers', actionId: 'workspace.tabs.close_others' as const, title: t('workspaceBar.closeOtherTabs'), testID: `${prefix}-close-others` },
        ...(prefix === 'workspace-tab-menu' ? [
            { id: 'closeLeft', actionId: 'workspace.tabs.close_left' as const, title: t('workspaceBar.closeTabsToLeft'), testID: `${prefix}-close-left` },
            { id: 'closeRight', actionId: 'workspace.tabs.close_right' as const, title: t('workspaceBar.closeTabsToRight'), testID: `${prefix}-close-right` },
        ] : []),
        { id: 'closeAll', actionId: 'workspace.tabs.close_all' as const, title: t('workspaceBar.closeAllTabs'), testID: `${prefix}-close-all`, shortcut: shortcutLabels['workspace.tab.closeAll'] },
    ].filter(item => (selectWorkspaceTabsToClose(workspace.state, item.actionId,
        item.actionId === 'workspace.tabs.close_all' ? { groupId: group.id } : { tabId })?.tabIds.length ?? 0) > 0),
    [group.id, shortcutLabels, workspace.state]);

    const close = React.useCallback((itemId: string, tabId: string) => {
        switch (itemId) {
            case 'closeOthers': execute({ actionId: 'workspace.tabs.close_others', input: { tabId } }); return true;
            case 'closeLeft': execute({ actionId: 'workspace.tabs.close_left', input: { tabId } }); return true;
            case 'closeRight': execute({ actionId: 'workspace.tabs.close_right', input: { tabId } }); return true;
            case 'closeAll': execute({ actionId: 'workspace.tabs.close_all', input: { groupId: group.id } }); return true;
            default: return false;
        }
    }, [execute, group.id]);

    const menuTab = menu && group.tabIds.includes(menu.tabId) ? workspace.state.tabs[menu.tabId] : undefined;
    const openActions = useWorkspaceOpenActions(menuTab ? hrefForDestinationRef(props.catalog, menuTab.target) : null, undefined, { sourceTabId: menuTab?.id });

    const menuItems = React.useMemo((): readonly DropdownMenuItem[] => {
        if (!menuTab) return [];
        const glyph = (name: IconName) => <Icon name={name} size={16} color={theme.colors.text.secondary} />;
        const multiplePanes = Object.keys(workspace.state.groups).length > 1;
        const maximized = workspace.state.maximizedGroupId === group.id;
        return [
            ...openActions.presentationItems,
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
            { id: 'close', testID: 'workspace-tab-menu-close', title: t('workspaceBar.closeTab'), icon: glyph('x'), shortcut: shortcutLabels['workspace.tab.close'] },
            ...(hasRecentlyClosed ? [{ id: 'reopen', testID: 'workspace-tab-menu-reopen', title: t('workspaceTabs.reopenTab'), shortcut: shortcutLabels['workspace.tab.reopen'], icon: glyph('clock-counter-clockwise') }] : []),
            ...closeItems(menuTab.id, 'workspace-tab-menu'),
        ];
    }, [closeItems, group.id, hasRecentlyClosed, menuTab, openActions.items, shortcutLabels, theme.colors.text.secondary, workspace.state.groups,
        workspace.state.maximizedGroupId, workspace.state.tabs]);

    const selectMenu = React.useCallback((itemId: string) => {
        const tabId = menu?.tabId;
        setMenu(null);
        if (!tabId) return;
        if (openActions.select(itemId)) return;
        if (close(itemId, tabId)) return;
        switch (itemId) {
            case 'pin': execute({ actionId: 'workspace.tabs.pin', input: { tabId, pinned: true } }); break;
            case 'unpin': execute({ actionId: 'workspace.tabs.pin', input: { tabId, pinned: false } }); break;
            case 'splitRight': execute({ actionId: 'workspace.split', input: { tabId, groupId: group.id, direction: 'right' } }); break;
            case 'splitDown': execute({ actionId: 'workspace.split', input: { tabId, groupId: group.id, direction: 'down' } }); break;
            case 'maximize': execute(workspace.state.maximizedGroupId === group.id
                ? { actionId: 'workspace.groups.restore', input: {} }
                : { actionId: 'workspace.groups.maximize', input: { groupId: group.id } }); break;
            case 'close': execute({ actionId: 'workspace.tabs.close', input: { tabId } }); break;
            case 'reopen': execute({ actionId: 'workspace.tabs.reopen', input: {} }); break;
        }
    }, [close, execute, group.id, menu?.tabId, openActions.select, workspace.state.maximizedGroupId]);

    // The menu lists the tabs in the strip's order: pinned marks lead, and each says so.
    const overflowItems = React.useMemo((): readonly DropdownMenuItem[] => overflowOpen ? [...[...stripTabs].sort((a, b) => Number(b.isPinned) - Number(a.isPinned)).map((tab) => ({
        id: tab.key, testID: `workspace-overflow-tab-${toTestIdSafeValue(tab.key)}`, title: liveTitles.get(tab.key) ?? tab.title,
        icon: <Icon name={tab.icon} size={16} color={theme.colors.text.secondary} />,
        ...(tab.isPinned ? {
            rightElement: <View style={styles.menuTabMarks}>
                <View testID={`workspace-overflow-pinned-${toTestIdSafeValue(tab.key)}`}>
                    <Icon name="push-pin" size={14} color={theme.colors.text.tertiary} />
                </View>
                {tab.key === group.activeTabId ? <Icon name="check" size={16} color={theme.colors.text.primary} /> : null}
            </View>,
        } : {}),
        checked: tab.key === group.activeTabId,
        category: t('workspaceBar.tabsLabel'),
    })), ...workspace.state.recentlyClosed.map((entry, index) => ({
        id: `closed:${entry.tab.id}`, testID: `workspace-reopen-tab-${toTestIdSafeValue(entry.tab.id)}`,
        title: liveTitles.get(`closed:${entry.tab.id}`) ?? t('common.loading'),
        category: t('workspaceTabs.recentlyClosed'),
        icon: <Icon name="clock-counter-clockwise" size={16} color={theme.colors.text.secondary} />,
        ...(index === 0 ? { shortcut: shortcutLabels['workspace.tab.reopen'] } : {}),
    })), ...closeItems(group.activeTabId, 'workspace-overflow').map(item => ({ ...item, category: t('workspaceBar.tabMenuLabel') }))] : [],
    [overflowOpen, closeItems, group.activeTabId, hasRecentlyClosed, liveTitles, shortcutLabels, stripTabs, styles.menuTabMarks, theme.colors.text.primary, theme.colors.text.secondary, theme.colors.text.tertiary, workspace.state.recentlyClosed]);

    const entityDragDrop: DocumentTabEntityDragDrop | undefined = scope ? {
        runtime, id: `workspace-tabs:${group.id}`, scope, acceptedKinds: WORKSPACE_ENTITY_KINDS,
        isCurrent: () => workspace.active && Boolean(workspace.state.groups[group.id])
            && !workspace.phone && (!workspace.state.maximizedGroupId || workspace.state.maximizedGroupId === group.id),
        getItem: tabId => workspace.state.tabs[tabId] && workspace.state.groups[group.id]?.tabIds.includes(tabId)
            ? { kind: 'workspace-tab', scope, tabId } : null,
        resolve: ({ item, beforeTabId }) => presentPaneDropAdmission(resolveWorkspaceEntityDrop({
            workspace, scope, item, beforeTabId, target: { leafId: group.id, placement: 'center' },
            catalog: props.catalog, workspaceRefs,
        }), createWorkspaceDropScene(workspace.state, props.catalog, { paneId: group.id, beforeTabId, destinationTitles: workspace.destinationTitles })),
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

    // The new-tab square keeps its design size; a finger reaches it through the shared hit area.
    const actionSize = props.placement === 'bar' ? 28 : M.actionSizePx;
    return (
        <View ref={attachStrip} testID={`workspace-tabs-${safeGroup}`} style={styles.row}>
            <DocumentTabStrip
                variant="bar"
                barTabHeightPx={tabHeightPx}
                barFadeColor={theme.colors.background.canvas}
                activeEmphasis={props.focused ? 'focused' : 'unfocused'}
                tabs={stripTabs}
                activeTabKey={group.activeTabId}
                resolveTabPresentation={(tab) => livePresentations.get(tab.key)}
                accessibilityLabel={t('workspaceBar.tabsLabel')}
                onActivate={(tabId) => execute({ actionId: 'workspace.tabs.activate', input: { tabId } })}
                onPin={(tabId) => execute({ actionId: 'workspace.tabs.pin', input: { tabId, pinned: true } })}
                onUnpin={(tabId) => execute({ actionId: 'workspace.tabs.pin', input: { tabId, pinned: false } })}
                onClose={(tabId) => execute({ actionId: 'workspace.tabs.close', input: { tabId } })}
                onTabMenu={(tabId, event) => setMenu({ tabId, anchor: resolvePointerMenuAnchor(event) })}
                onDismissTabMenu={(tabId) => setMenu(current => current?.tabId === tabId ? null : current)}
                entityDragDrop={entityDragDrop}
                dropSlot={dropCue.slot}
                dropRingTabKey={dropCue.pulseTabKey}
                renderLeadingIcon={renderLeadingIcon}
                tabNativeId={(key) => `workspace-${safeGroup}-tab-${toTestIdSafeValue(key)}`}
                panelNativeId={(key) => `workspace-${safeGroup}-panel-${toTestIdSafeValue(key)}`}
                testIds={{ tab: (key) => `workspace-tab-${key}`, tabClose: (key) => `workspace-tab-close-${key}` }}
            />
            <IconButton
                testID={`workspace-new-tab-${safeGroup}`}
                variant="plain"
                size={actionSize}
                iconSize={M.actionGlyphPx}
                iconName="plus"
                accessibilityLabel={t('workspaceBar.newTab')}
                tooltip={t('workspaceBar.newTab')}
                tooltipPlacement="bottom"
                interactiveTargetEdgesPx={NEW_TAB_EDGES_PX}
                onPress={() => execute({ actionId: 'workspace.tabs.open', input: { groupId: group.id } })}
            />
            <View style={styles.grow} />
            <DropdownMenu
                open={overflowOpen}
                onOpenChange={setOverflowOpen}
                items={overflowItems}
                onSelect={(tabId) => {
                    if (close(tabId, group.activeTabId)) return;
                    const closed = workspace.state.recentlyClosed.find(entry => `closed:${entry.tab.id}` === tabId);
                    if (closed) execute({ actionId: 'workspace.tabs.reopen', input: { tabId: closed.tab.id } });
                    else execute({ actionId: 'workspace.tabs.activate', input: { tabId } });
                }}
                search
                separateCategories
                searchPlaceholder={t('workspaceBar.searchTabs')}
                matchTriggerWidth={false}
                maxWidthCap={300}
                placement="bottom"
                popoverAnchorAlign="end"
                trigger={({ toggle }) => (
                    <IconButton
                        testID={`workspace-overflow-${safeGroup}`}
                        variant="plain"
                        size={actionSize}
                        iconSize={M.actionGlyphPx}
                        iconName="caret-down"
                        accessibilityLabel={t('workspaceBar.allTabs')}
                        tooltip={t('workspaceBar.allTabs')}
                        tooltipPlacement="bottom"
                        hasPopup="menu"
                        expanded={overflowOpen}
                        interactiveTargetEdgesPx={ALL_TABS_EDGES_PX}
                        onPress={toggle}
                    />
                )}
            />
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

/** The empty spacer between + New tab and the controls at the pane's end never gets narrower than this. */
const SPACER_MIN_PX = 8;
/**
 * The row's hit areas tile its gaps: + New tab takes the whole 2 px gap to the last tab (whose close stays inside the
 * tab) and half of the narrowest spacer, All tabs the other half and half the gap to the pane's trailing control.
 */
const NEW_TAB_EDGES_PX = { leading: B.stripGapPx, trailing: (B.stripGapPx * 2 + SPACER_MIN_PX) / 2 } as const;
const ALL_TABS_EDGES_PX = { leading: (B.stripGapPx * 2 + SPACER_MIN_PX) / 2, trailing: B.stripGapPx / 2 } as const;

const stylesheet = StyleSheet.create(() => ({
    row: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: B.stripGapPx,
    },
    grow: {
        flex: 1,
        minWidth: SPACER_MIN_PX,
    },
    menuTabMarks: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
}));
