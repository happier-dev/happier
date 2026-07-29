import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { TextInput } from '@/components/ui/text/Text';
import { SafeIonicons } from '@/components/ui/icons/SafeIonicons';
import { t } from '@/text';

import { useResolvedSettingsPageCatalog } from '@/components/settings/catalog/runtime/useResolvedSettingsPageCatalog';
import type { ResolvedSettingsPageNode } from '@/components/settings/catalog/types';
import { runGuardedNavigation } from '@/utils/navigation/runGuardedNavigation';
import { fireAndForget } from '@/utils/system/fireAndForget';

const Ionicons = SafeIonicons;

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.surface.base,
        paddingTop: 10,
    },
    searchContainer: {
        paddingHorizontal: 10,
        paddingBottom: 8,
    },
    searchBar: {
        flexDirection: 'row',
        alignItems: 'center',
        borderRadius: 10,
        paddingHorizontal: 12,
        paddingVertical: 8,
        backgroundColor: theme.colors.surface.base,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
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
    settingsPagesContainer: {
        backgroundColor: theme.colors.surface.base,
    },
}));

type ParentMap = Readonly<Record<string, string | null>>;

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

    const renderTreeNode = React.useCallback((node: ResolvedSettingsPageNode, level: number): React.ReactNode => {
        const hasChildren = Boolean(node.children && node.children.length > 0);
        const expanded = expandedIds.has(node.id);
        const indentPx = 12 * Math.max(0, level);

        const iconNode = node.icon ? node.icon({ theme }) : null;

        const resolvedIconNode = iconNode ?? (
            <Ionicons
                name="ellipse-outline"
                size={14}
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
            <Ionicons
                name={expanded ? 'chevron-down' : 'chevron-forward'}
                size={14}
                color={theme.colors.text.secondary}
            />
        ) : undefined;

        return (
            <React.Fragment key={node.id}>
                <Item
                    testID={`settings-sidebar.item.${node.id}`}
                    title={String(t(node.titleKey))}
                    {...(hasChildren
                        ? {
                            leftElement: iconPressable(resolvedIconNode),
                            leftElementWhenHovered: hoveredIconNode,
                        }
                        : {
                            icon: resolvedIconNode,
                        })}
                    density="compact"
                    selected={resolved.activePageId === node.id}
                    showChevron={false}
                    style={{
                        paddingLeft: 12 + indentPx,
                        paddingRight: 10,
                    }}
                    onPress={() => {
                        if (hasChildren && !node.route) {
                            toggleExpanded(node.id);
                            return;
                        }
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
    }, [expandedIds, navigateToRoute, resolved.activePageId, theme, toggleExpanded]);

    return (
            <View testID="settings-sidebar" style={styles.root}>
            <View style={styles.searchContainer}>
                <View style={styles.searchBar}>
                    <View style={styles.searchIcon}>
                        <Ionicons name="search-outline" size={14} color={theme.colors.text.secondary} />
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

            <ItemList style={{ paddingTop: 0 }}>
                {normalizedQuery ? (
                    <View style={styles.settingsPagesContainer}>
                        {results.map((result) => {
                            const node = routeNodes.find((candidate) => candidate.id === result.id);
                            return (
                                <Item
                                    key={result.id}
                                    testID={`settings-sidebar.searchResult.${result.id}`}
                                    title={node ? String(t(node.titleKey)) : String(result.id)}
                                    icon={<Ionicons name="search-outline" size={14} color={theme.colors.text.secondary} />}
                                    density="compact"
                                    showChevron={false}
                                    onPress={() => {
                                        navigateToRoute(result.route, { clearQuery: true });
                                    }}
                                />
                            );
                        })}
                    </View>
                ) : (
                    <View style={styles.settingsPagesContainer}>
                        {resolved.tree.map((node) => renderTreeNode(node, 0))}
                    </View>
                )}
            </ItemList>
        </View>
    );
});
