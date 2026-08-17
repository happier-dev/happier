import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { Item } from '@/components/ui/lists/Item';
import { ItemList } from '@/components/ui/lists/ItemList';
import { TextInput } from '@/components/ui/text/Text';
import { Eyebrow } from '@/components/ui/text/Eyebrow';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import { useResolvedSettingsPageCatalog } from '@/components/settings/catalog/runtime/useResolvedSettingsPageCatalog';
import type { ResolvedSettingsPageNode } from '@/components/settings/catalog/types';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { useScrollEdgeFades } from '@/components/ui/scroll/useScrollEdgeFades';
import { ScrollEdgeFades } from '@/components/ui/scroll/ScrollEdgeFades';
import { ScrollEdgeIndicators } from '@/components/ui/scroll/ScrollEdgeIndicators';

/**
 * Rail geometry.
 *
 * The rail is a gutter plus a content column. The gutter is the air between the rail's edge and
 * the selected row's chip; the content inset is measured from the rail edge to the icons, so a
 * row's own horizontal padding is the difference — that keeps every icon on the same optical x
 * whether or not its row is wearing the chip.
 *
 * These restate `theme.margins.md` (12) and `theme.margins.xl` (20). They are constants rather
 * than token reads because the row insets are computed in plain arithmetic at the call site,
 * outside the Unistyles callback where `theme` is in scope.
 */
const RAIL_GUTTER_PX = 12; // theme.margins.md
const RAIL_CONTENT_LEFT_PX = 20; // theme.margins.xl
const RAIL_CONTENT_RIGHT_PX = 20; // theme.margins.xl
/** Label-to-first-row gap. Deliberately off the margin scale: no step sits between xs and sm. */
const RAIL_LABEL_TO_ROW_GAP_PX = 6;
const RAIL_ROW_RADIUS_PX = 8;
const RAIL_INDENT_STEP_PX = 12;

/**
 * The row content inset, shared by the tree rows and the search-result rows so the two views
 * cannot drift apart — they were duplicated expressions and had already diverged once.
 */
function resolveRailRowPadding(indentPx: number) {
    return {
        paddingLeft: RAIL_CONTENT_LEFT_PX - RAIL_GUTTER_PX + indentPx,
        paddingRight: RAIL_CONTENT_RIGHT_PX - RAIL_GUTTER_PX,
    };
}

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        // Product decision: the settings rail is the raised plane and the content pane beside it
        // is the recessed field, so the selected row reads as a recess cut into the rail. This
        // deliberately inverts the app shell's own left rail, which stays on the canvas plane.
        backgroundColor: theme.colors.surface.base,
        paddingTop: theme.margins.md,
    },
    searchContainer: {
        // Same gutter as the rows, so the well and the chips share one left edge.
        paddingHorizontal: RAIL_GUTTER_PX,
        paddingBottom: theme.margins.md,
    },
    searchBar: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: theme.borderRadius.lg,
        // Lands the magnifying glass on the same optical x as every row icon below it.
        paddingHorizontal: RAIL_CONTENT_LEFT_PX - RAIL_GUTTER_PX,
        paddingVertical: 8,
        // A recessed well cut into the raised rail. It cannot use the base surface any more —
        // that is now the rail's own plane, and in dark mode the hairline alone (5% white) is
        // far too faint to carry a field that is otherwise the same colour as its background.
        backgroundColor: theme.colors.surface.inset,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    sectionHeader: {
        paddingLeft: RAIL_CONTENT_LEFT_PX,
        paddingRight: RAIL_CONTENT_RIGHT_PX,
        paddingTop: theme.margins.xl,
        paddingBottom: RAIL_LABEL_TO_ROW_GAP_PX,
    },
    // The first label follows the home row rather than another group, so it needs less air.
    sectionHeaderFirst: {
        paddingTop: theme.margins.md,
    },
    row: {
        marginHorizontal: RAIL_GUTTER_PX,
        borderRadius: RAIL_ROW_RADIUS_PX,
    },
    /**
     * The scrolling region's own host. Both edge overlays are absolutely positioned against
     * their nearest positioned ancestor, so without this the top gradient and caret would
     * anchor to the rail root and paint over the search field.
     */
    listHost: {
        flex: 1,
        minHeight: 0,
        position: 'relative',
    },
    // `ItemList` unconditionally paints the canvas plane and covers the rail below the search
    // field, so the rail's own colour has to be restated here or the flip above does nothing.
    listSurface: {
        paddingTop: 0,
        backgroundColor: theme.colors.surface.base,
    },
    // The selected fill is ~1.06:1 against the rail, far below the 3:1 WCAG 1.4.11 asks of a
    // non-text indicator, so the title's weight carries the state as well. The fill itself is
    // `Item`'s own `surface.selected`; the rail must not become a second owner of that decision.
    rowTitleSelected: {
        ...Typography.default('semiBold'),
    },
    searchIcon: {
        marginRight: 8,
    },
    searchInput: {
        flex: 1,
        padding: 0,
        margin: 0,
        minHeight: 20,
        color: theme.colors.text.primary,
        ...(Platform.select({
            web: {
                outline: 'none',
                outlineStyle: 'none',
                outlineWidth: 0,
                outlineColor: 'transparent',
                boxShadow: 'none',
                WebkitBoxShadow: 'none',
                WebkitAppearance: 'none',
            },
            default: {},
        }) as object),
    },
}));

type ParentMap = Readonly<Record<string, string | null>>;

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
    const router = useRouter();
    const styles = stylesheet;
    const resolved = useResolvedSettingsPageCatalog();
    const [query, setQuery] = React.useState('');
    const scrollFades = useScrollEdgeFades({ enabledEdges: { top: true, bottom: true } });

    const parents = React.useMemo(() => buildParentMap(resolved.tree), [resolved.tree]);

    const defaultExpanded = React.useMemo(() => {
        const expanded = new Set<string>();
        // Expand the top-level and first-level groups by default so the sidebar is immediately useful.
        // This keeps settings categories visible without forcing the user to click multiple times.
        const visit = (items: readonly ResolvedSettingsPageNode[], depth: number) => {
            for (const node of items) {
                if (depth <= 1) {
                    expanded.add(node.id);
                }
                if (node.children) {
                    visit(node.children, depth + 1);
                }
            }
        };
        visit(resolved.tree, 0);
        if (resolved.activePageId) {
            for (const ancestor of collectAncestors(resolved.activePageId, parents)) {
                expanded.add(ancestor);
            }
        }
        return expanded;
    }, [parents, resolved.activePageId, resolved.tree]);

    const [expandedIds, setExpandedIds] = React.useState<Set<string>>(() => new Set(defaultExpanded));

    React.useEffect(() => {
        if (!resolved.activePageId) return;
        const ancestors = collectAncestors(resolved.activePageId, parents);
        if (ancestors.length === 0) return;
        setExpandedIds((current) => {
            const next = new Set(current);
            for (const ancestor of ancestors) {
                next.add(ancestor);
            }
            return next;
        });
    }, [parents, resolved.activePageId]);

    const normalizedQuery = query.trim();
    const results = React.useMemo(() => {
        if (!normalizedQuery) return [];
        return resolved.search(normalizedQuery);
    }, [normalizedQuery, resolved]);

    const routeNodes = React.useMemo(() => {
        const out: Array<ResolvedSettingsPageNode & { route: string }> = [];
        const visit = (items: readonly ResolvedSettingsPageNode[]) => {
            for (const item of items) {
                if (typeof item.route === 'string' && item.route.length > 0) {
                    out.push(item as ResolvedSettingsPageNode & { route: string });
                }
                if (item.children) {
                    visit(item.children);
                }
            }
        };
        visit(resolved.tree);
        return out;
    }, [resolved.tree]);

    const toggleExpanded = React.useCallback((id: string) => {
        setExpandedIds((current) => {
            const next = new Set(current);
            if (next.has(id)) {
                next.delete(id);
            } else {
                next.add(id);
            }
            return next;
        });
    }, []);

    const navigateToRoute = React.useCallback((route: string, options?: Readonly<{ clearQuery?: boolean }>) => {
        const result = runGuardedNavigation(() => {
            if (options?.clearQuery) setQuery('');
            router.navigate(route as never);
        });
        if (result !== true) {
            fireAndForget(result, { tag: 'SettingsSidebar.navigate' });
        }
    }, [router]);

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
        options?: Readonly<{ expandable?: boolean; sectionIndex?: number }>,
    ): React.ReactNode => {
        const childCount = node.children?.length ?? 0;
        const isSectionHeader = childCount > 0 && !node.route;

        if (isSectionHeader) {
            return (
                <React.Fragment key={node.id}>
                    <Eyebrow
                        testID={`settings-sidebar.section.${node.id}`}
                        accessibilityRole="header"
                        style={[
                            styles.sectionHeader,
                            (options?.sectionIndex ?? 0) === 0 ? styles.sectionHeaderFirst : null,
                        ]}
                    >
                        {readSettingsPageTitle(node)}
                    </Eyebrow>
                    {node.children!.map((child) => renderTreeNode(child, level))}
                </React.Fragment>
            );
        }

        const hasChildren = options?.expandable ?? childCount > 0;
        const expanded = expandedIds.has(node.id);
        const indentPx = RAIL_INDENT_STEP_PX * Math.max(0, level);
        const selected = resolved.activePageId === node.id;

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
                    toggleExpanded(node.id);
                }}
                style={{ flex: 1, width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center' }}
                hitSlop={6}
            >
                {child}
            </Pressable>
        );

        const hoveredIconNode = hasChildren ? iconPressable(
            <Icon
                name={expanded ? 'caret-down' : 'caret-right'}
                size={ICON_SIZE.xs}
                color={theme.colors.text.secondary}
            />
        ) : undefined;

        return (
            <React.Fragment key={node.id}>
                <Item
                    testID={`settings-sidebar.item.${node.id}`}
                    title={readSettingsPageTitle(node)}
                    {...(hasChildren
                        ? {
                            leftElement: iconPressable(resolvedIconNode),
                            leftElementWhenHovered: hoveredIconNode,
                        }
                        : {
                            icon: resolvedIconNode,
                        })}
                    density="compact"
                    selected={selected}
                    showChevron={false}
                    pressableStyle={styles.row}
                    titleStyle={selected ? styles.rowTitleSelected : undefined}
                    style={resolveRailRowPadding(indentPx)}
                    onPress={() => {
                        if (node.route) {
                            navigateToRoute(node.route);
                            return;
                        }
                        if (hasChildren) {
                            toggleExpanded(node.id);
                        }
                    }}
                />
                {hasChildren && expanded
                    ? node.children!.map((child) => renderTreeNode(child, level + 1))
                    : null}
            </React.Fragment>
        );
    }, [expandedIds, navigateToRoute, resolved.activePageId, styles, theme, toggleExpanded]);

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
                {groups.map((group, index) => renderTreeNode(group, 0, { sectionIndex: index }))}
            </React.Fragment>
        );
    }, [renderTreeNode]);

    return (
            <View testID="settings-sidebar" style={styles.root}>
            <View style={styles.searchContainer}>
                <View style={styles.searchBar}>
                    <View style={styles.searchIcon}>
                        <Icon name="magnifying-glass" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
                    </View>
                    <TextInput
                        testID="settings-sidebar.searchInput"
                        placeholder={t('settingsSearch.placeholder')}
                        placeholderTextColor={theme.colors.input.placeholder}
                        value={query}
                        onChangeText={setQuery}
                        autoCapitalize="none"
                        autoCorrect={false}
                        style={styles.searchInput}
                    />
                </View>
            </View>

            {/*
              * The rail scrolls, so it carries the app's canonical edge affordances: a fade into
              * the rail's own colour plus a caret at whichever end still has content behind it.
              */}
            <View style={styles.listHost}>
                <ItemList
                    style={styles.listSurface}
                    onLayout={scrollFades.onViewportLayout}
                    onContentSizeChange={scrollFades.onContentSizeChange}
                    onScroll={scrollFades.onScroll}
                    onMomentumScrollEnd={scrollFades.onMomentumScrollEnd}
                    scrollEventThrottle={16}
                >
                    {normalizedQuery
                        ? results.map((result) => {
                            const node = routeNodes.find((candidate) => candidate.id === result.id);
                            return (
                                <Item
                                    key={result.id}
                                    testID={`settings-sidebar.searchResult.${result.id}`}
                                    title={node ? readSettingsPageTitle(node) : String(result.id)}
                                    icon={<Icon name="magnifying-glass" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />}
                                    density="compact"
                                    showChevron={false}
                                    pressableStyle={styles.row}
                                    style={resolveRailRowPadding(0)}
                                    onPress={() => {
                                        navigateToRoute(result.route, { clearQuery: true });
                                    }}
                                />
                            );
                        })
                        : resolved.tree.map((node) => renderRail(node))}
                </ItemList>

                <ScrollEdgeFades
                    color={theme.colors.surface.base}
                    size={18}
                    edges={scrollFades.visibility}
                />
                <ScrollEdgeIndicators
                    edges={scrollFades.visibility}
                    color={theme.colors.text.secondary}
                    size={ICON_SIZE.xs}
                    opacity={0.35}
                />
            </View>
        </View>
    );
});
