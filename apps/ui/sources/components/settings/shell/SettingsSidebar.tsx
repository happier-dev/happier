import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ItemList } from '@/components/ui/lists/ItemList';
import {
    CollectionList,
    CollectionListGroupLabel,
    CollectionNavigationRow,
} from '@/components/ui/lists/collection/CollectionList';
import { t } from '@/text';

import { useResolvedSettingsPageCatalog } from '@/components/settings/catalog/runtime/useResolvedSettingsPageCatalog';
import type { ResolvedSettingsPageNode } from '@/components/settings/catalog/types';
import { SettingsSearchResults, useSettingsSearch } from '@/components/settings/shell/SettingsSearchResults';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { appShellColumnPlaneColor } from '@/components/navigation/shell/appRail/appShellColumnSurface';

/** The indent of each disclosed level. */
const RAIL_INDENT_STEP_PX = 12;

const stylesheet = StyleSheet.create(() => ({
    // The settings navigation lies on its host's plane (the app shell's column, or the settings
    // shell's own column): it paints no ground of its own.
    root: {
        flex: 1,
        minHeight: 0,
    },
    /**
     * The scrolling region's own host. Both edge overlays are absolutely positioned against
     * their nearest positioned ancestor, so without this the top gradient would
     * anchor to the rail root and paint over the search field.
     */
    listHost: {
        flex: 1,
        minHeight: 0,
        position: 'relative',
    },
    // `ItemList` paints the canvas unless told otherwise; on the plane it stays transparent.
    listSurface: {
        paddingTop: 0,
        backgroundColor: 'transparent',
    },
}));

type ParentMap = Readonly<Record<string, string | null>>;

const NO_DISCLOSURE: ReadonlyMap<string, boolean> = new Map();

function readSettingsPageTitle(node: ResolvedSettingsPageNode): string {
    return node.title ?? (node.titleKey ? String(t(node.titleKey)) : node.id);
}

function buildParentMap(nodes: readonly ResolvedSettingsPageNode[]): ParentMap {
    const out: Record<string, string | null> = {};
    const visit = (items: readonly ResolvedSettingsPageNode[], parentId: string | null) => {
        for (const item of items) {
            out[item.id] = parentId;
            if (item.children) {
                visit(item.children, item.id);
            }
        }
    };
    visit(nodes, null);
    return out;
}

function collectAncestors(id: string, parents: ParentMap): string[] {
    const out: string[] = [];
    let cursor: string | null | undefined = parents[id];
    while (cursor) {
        out.push(cursor);
        cursor = parents[cursor];
    }
    return out;
}

export const SettingsSidebar = React.memo(function SettingsSidebar() {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const resolved = useResolvedSettingsPageCatalog();
    const search = useSettingsSearch(resolved, { clearOnOpen: true, tag: 'SettingsSidebar.search' });
    const scrollFades = useScrollEdgeFades({ enabledEdges: { top: true, bottom: true } });

    const parents = React.useMemo(() => buildParentMap(resolved.tree), [resolved.tree]);

    // A subtree stands open only on the way to the open page. What the person opened or closed by hand holds
    // until they open another page, so a tree never stays expanded over pages it has nothing to do with.
    const activePath = React.useMemo(() => new Set(resolved.activePageId
        ? [resolved.activePageId, ...collectAncestors(resolved.activePageId, parents)]
        : []), [parents, resolved.activePageId]);
    const [disclosure, setDisclosure] = React.useState<Readonly<{
        pageId: string | null;
        byHand: ReadonlyMap<string, boolean>;
    }>>({ pageId: resolved.activePageId, byHand: NO_DISCLOSURE });
    if (disclosure.pageId !== resolved.activePageId) {
        setDisclosure({ pageId: resolved.activePageId, byHand: NO_DISCLOSURE });
    }
    const { byHand } = disclosure;

    const toggleExpanded = React.useCallback((id: string, open: boolean) => {
        setDisclosure((current) => ({ ...current, byHand: new Map(current.byHand).set(id, open) }));
    }, []);

    // Rail rows and search results open pages the same guarded way.
    const navigateToRoute = search.openRoute;

    /**
     * Renders one catalog node and its descendants.
     *
     * Two shapes come out of here. A node with a route is a navigable row. A node without one
     * exists only to name the pages beneath it, so it renders as a static label: it is not
     * pressable, has no collapsed state, and contributes no indent level — its pages sit at
     * the same depth as the home row above them, exactly as the labels do.
     *
     * `expandable` is passed rather than derived from `node.children` because the catalog root
     * also has children yet discloses nothing: its children are always-visible section labels.
     */
    const renderTreeNode = React.useCallback((
        node: ResolvedSettingsPageNode,
        level: number,
        options?: Readonly<{ expandable?: boolean }>,
    ): React.ReactNode => {
        // A page's search-only children (its own add or setup rows) open from inside the page, not from here.
        const navChildren = node.children?.filter((child) => !child.searchOnly) ?? [];
        const childCount = navChildren.length;
        const isSectionHeader = childCount > 0 && !node.route;

        if (isSectionHeader) {
            return (
                <React.Fragment key={node.id}>
                    <CollectionListGroupLabel
                        testID={`settings-sidebar.section.${node.id}`}
                        title={readSettingsPageTitle(node)}
                    />
                    {navChildren.map((child) => renderTreeNode(child, level))}
                </React.Fragment>
            );
        }

        const hasChildren = options?.expandable ?? childCount > 0;
        const expanded = byHand.get(node.id) ?? activePath.has(node.id);
        const indentPx = RAIL_INDENT_STEP_PX * Math.max(0, level);
        // On a search-only child's page, the page it opens from stays the selected row.
        const selected = resolved.activePageId === node.id
            || (node.children?.some((child) => child.searchOnly && child.id === resolved.activePageId) ?? false);

        const iconNode = node.icon ? node.icon({ theme }) : null;

        const resolvedIconNode = iconNode ?? (
            <Icon
                name="circle"
                size={ICON_SIZE.xs}
                color={theme.colors.text.secondary}
            />
        );

        const iconPressable = (child: React.ReactNode) => (
            <Pressable
                testID={`settings-sidebar.toggle.${node.id}`}
                onPress={(event: any) => {
                    event?.preventDefault?.();
                    event?.stopPropagation?.();
                    toggleExpanded(node.id, !expanded);
                }}
                accessibilityRole="button"
                accessibilityLabel={readSettingsPageTitle(node)}
                accessibilityState={{ expanded }}
                style={{ alignItems: 'center', justifyContent: 'center' }}
                hitSlop={6}
            >
                {child}
            </Pressable>
        );

        const disclosure = hasChildren ? iconPressable(
            <Icon
                name={expanded ? 'caret-down' : 'caret-right'}
                size={ICON_SIZE.xs}
                color={theme.colors.text.secondary}
            />
        ) : undefined;

        return (
            <React.Fragment key={node.id}>
                <CollectionNavigationRow
                    href={node.route ?? null}
                    testID={`settings-sidebar.item.${node.id}`}
                    title={readSettingsPageTitle(node)}
                    {...(hasChildren
                        ? {
                            icon: resolvedIconNode,
                            rightElement: disclosure,
                        }
                        : {
                            icon: resolvedIconNode,
                        })}
                    selected={selected}
                    indentPx={indentPx}
                    onPress={() => {
                        if (node.route) {
                            navigateToRoute(node.route);
                            return;
                        }
                        if (hasChildren) {
                            toggleExpanded(node.id, !expanded);
                        }
                    }}
                />
                {hasChildren && expanded
                    ? navChildren.map((child) => renderTreeNode(child, level + 1))
                    : null}
            </React.Fragment>
        );
    }, [activePath, byHand, navigateToRoute, resolved.activePageId, theme, toggleExpanded]);

    /**
     * The catalog root is the home row: a plain destination with no disclosure and no label
     * above it. Its group children are then rendered as peers of that row, not beneath it.
     */
    const renderRail = React.useCallback((node: ResolvedSettingsPageNode): React.ReactNode => {
        const groups = node.children ?? [];
        if (!node.route || groups.length === 0) return renderTreeNode(node, 0);

        return (
            <React.Fragment key={node.id}>
                {renderTreeNode(node, 0, { expandable: false })}
                {groups.map((group) => renderTreeNode(group, 0))}
            </React.Fragment>
        );
    }, [renderTreeNode]);

    return (
        <View testID="settings-sidebar" style={styles.root}>
            <CollectionList
                surface="plane"
                title={t('settings.title')}
                search={{
                    testID: 'settings-sidebar.searchInput',
                    placeholder: t('settingsSearch.placeholder'),
                    value: search.query,
                    onChangeText: search.setQuery,
                }}
                scrollContent={(
                    // The rail scrolls, so it fades into the plane's colour at whichever end still has
                    // content behind it. No caret: centred over a row of a navigation list it read as that
                    // row's second disclosure ("Prompts & Skills ⌄ ›", fidelity 2026-10-11).
                    <View style={styles.listHost}>
                        <ItemList presentation="grouped"
                            style={styles.listSurface}
                            onLayout={scrollFades.onViewportLayout}
                            onContentSizeChange={scrollFades.onContentSizeChange}
                            onScroll={scrollFades.onScroll}
                            onMomentumScrollEnd={scrollFades.onMomentumScrollEnd}
                            scrollEventThrottle={16}
                        >
                            {search.active ? (
                                <SettingsSearchResults
                                    presentation="rail"
                                    results={search.results}
                                    tree={resolved.tree}
                                    testIDPrefix="settings-sidebar.searchResult"
                                    emptyTestID="settings-sidebar.searchEmpty"
                                    onOpen={search.openRoute}
                                />
                            ) : resolved.tree.map((node) => renderRail(node))}
                        </ItemList>

                        <ScrollEdgeFades
                            color={appShellColumnPlaneColor(theme.colors)}
                            size={18}
                            edges={scrollFades.visibility}
                        />
                    </View>
                )}
            />
        </View>
    );
});
