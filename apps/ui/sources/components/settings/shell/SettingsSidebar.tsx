import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { TextInput } from '@/components/ui/text/Text';
import { t } from '@/text';

import { useResolvedSettingsPageCatalog } from '@/components/settings/catalogV1/runtime/useResolvedSettingsPageCatalog';
import type { ResolvedSettingsPageNode } from '@/components/settings/catalogV1/types';

const stylesheet = StyleSheet.create((theme) => ({
    root: {
        flex: 1,
        minHeight: 0,
        backgroundColor: theme.colors.groupped.background,
        paddingTop: 10,
    },
    searchContainer: {
        paddingHorizontal: 10,
        paddingBottom: 8,
    },
    searchInput: {
        borderRadius: 10,
        paddingHorizontal: 10,
        paddingVertical: 8,
        backgroundColor: theme.colors.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.divider,
        color: theme.colors.text,
        ...(Platform.OS === 'web' ? ({ outlineStyle: 'none', outlineWidth: 0 } as any) : null),
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
        // Expand all top-level groups by default so the sidebar is immediately useful.
        for (const node of resolved.tree) {
            expanded.add(node.id);
        }
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

    const renderTreeNode = React.useCallback((node: ResolvedSettingsPageNode, level: number): React.ReactNode => {
        const hasChildren = Boolean(node.children && node.children.length > 0);
        const expanded = expandedIds.has(node.id);
        const indentPx = 12 * Math.max(0, level);

        const iconNode = node.icon ? node.icon({ theme }) : null;

        const resolvedIconNode = iconNode ?? (
            <Ionicons
                name="ellipse-outline"
                size={16}
                color={theme.colors.textSecondary}
            />
        );

        const hoveredIconNode = hasChildren ? (
            <Ionicons
                name={expanded ? 'chevron-down' : 'chevron-forward'}
                size={16}
                color={theme.colors.textSecondary}
            />
        ) : undefined;

        return (
            <React.Fragment key={node.id}>
                <Item
                    testID={`settings-sidebar.item.${node.id}`}
                    title={String(t(node.titleKey))}
                    leftElement={resolvedIconNode}
                    leftElementWhenHovered={hoveredIconNode}
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
                            router.push(node.route as any);
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
    }, [expandedIds, resolved.activePageId, router, theme, toggleExpanded]);

    return (
        <View testID="settings-sidebar" style={styles.root}>
            <View style={styles.searchContainer}>
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

            <ItemList style={{ paddingTop: 0 }}>
                {normalizedQuery ? (
                    <ItemGroup>
                        {results.map((result) => {
                            const node = routeNodes.find((candidate) => candidate.id === result.id);
                            return (
                                <Item
                                    key={result.id}
                                    testID={`settings-sidebar.searchResult.${result.id}`}
                                    title={node ? String(t(node.titleKey)) : String(result.id)}
                                    icon={<Ionicons name="search-outline" size={18} color={theme.colors.textSecondary} />}
                                    density="compact"
                                    onPress={() => {
                                        setQuery('');
                                        router.push(result.route as any);
                                    }}
                                />
                            );
                        })}
                    </ItemGroup>
                ) : (
                    <ItemGroup>
                        {resolved.tree.map((node) => renderTreeNode(node, 0))}
                    </ItemGroup>
                )}
            </ItemList>
        </View>
    );
});
