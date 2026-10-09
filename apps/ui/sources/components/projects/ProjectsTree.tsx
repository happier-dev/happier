import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import {
    HAPPIER_TREE_ROW_METRICS,
    HappierPressable,
    HappierTreeDisclosure,
    useHappierTreeInteraction,
    type HappierTreeNode,
} from '@happier-dev/plugin-ui/presentation';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';

import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { Icon } from '@/components/ui/icons/Icon';
import { focusRingStyle } from '@/components/ui/interactions/interactionFeedback';
import { CollectionListGroupLabel, CollectionNavigationRow } from '@/components/ui/lists/collection/CollectionList';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import type { ProjectsTreeRow } from './projectsTreeRows';
import type { WorkspaceAddressV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';

/**
 * The Projects tree's keyboard and semantics through the shared tree owner (`useHappierTreeInteraction`):
 * treeitem levels and expanded state, one roving tab stop, arrows/Home/End move, Right/Left/Space
 * disclose, Enter activates (a leaf opens its exact checkout; a parent toggles). Focus repairs to the
 * nearest visible ancestor when a branch closes or a Project is hidden. The column and the phone list
 * both bind their rows through it — there is no Projects-specific keyboard engine.
 */
export function useProjectsTreeKeyboard(rows: readonly ProjectsTreeRow[], handlers: Readonly<{
    onToggle: (key: string) => void;
    onOpenRow: (row: ProjectsTreeRow) => void;
}>) {
    const visibleNodes = React.useMemo((): HappierTreeNode[] => {
        const ancestors: ProjectsTreeRow[] = [];
        return rows.map((row) => {
            while (ancestors.length > 0 && ancestors[ancestors.length - 1]!.level >= row.level) ancestors.pop();
            const node: HappierTreeNode = {
                key: row.key,
                parentKey: ancestors[ancestors.length - 1]?.key ?? null,
                depth: row.level,
                kind: row.expandable ? 'branch' : 'leaf',
                expanded: row.expanded,
            };
            if (row.expandable) ancestors.push(row);
            return node;
        });
    }, [rows]);
    const rowsRef = React.useRef(rows);
    rowsRef.current = rows;
    const handlersRef = React.useRef(handlers);
    handlersRef.current = handlers;
    const [focusedKey, setFocusedKey] = React.useState<string | null>(null);
    const tree = useHappierTreeInteraction({
        visibleNodes,
        focusedKey,
        onFocus: setFocusedKey,
        onExpandedChange: (key, expanded) => {
            const row = rowsRef.current.find((candidate) => candidate.key === key);
            if (row && row.expanded !== expanded) handlersRef.current.onToggle(key);
        },
        onActivate: (key) => {
            const row = rowsRef.current.find((candidate) => candidate.key === key);
            if (row) handlersRef.current.onOpenRow(row);
        },
    });
    const getRowProps = React.useCallback((row: ProjectsTreeRow): NonNullable<React.ComponentProps<typeof CollectionNavigationRow>['treeItem']> => ({
        webRole: 'treeitem',
        webTabIndex: row.key === tree.activeKey ? 0 : -1,
        accessibilityLevel: row.level + 1,
        accessibilityExpanded: row.expandable ? row.expanded : undefined,
        pressableRef: (target) => tree.bindFocusTarget(row.key, target?.focus ? { focus: () => target.focus?.() } : null),
        onFocus: () => setFocusedKey(row.key),
        onKeyDown: (event) => {
            const key = event.nativeEvent?.key ?? event.key;
            if (key && tree.onKeyDown(row.key, key, event)) event.preventDefault?.();
        },
    }), [tree]);
    return { getRowProps };
}

/** Where a row's action lands: a leaf opens its exact checkout, a parent opens or closes in place. */
function openTreeRow(row: ProjectsTreeRow, onOpenRef: (refId: string, address?: WorkspaceAddressV1) => void, onToggle: (key: string) => void) {
    if (row.refId) onOpenRef(row.refId, row.workspaceAddress);
    else if (row.expandable) onToggle(row.key);
}

export type ProjectsTreeHiddenItem = Readonly<{ key: string; title: string; subtitle: string }>;
export type ProjectsTreeSavedItem = Readonly<{ key: string; title: string; subtitle?: string }>;

/**
 * The Projects column's tree (plan 10 §2/§8, lab p-projects TREE/HIDE/HIDDEN): Projects, their
 * machines and checkouts as `buildProjectsTreeRows` folds them; parents disclose, leaves open their
 * exact checkout. Your saved Sources that are not open sit dimmed after them, and hidden Projects
 * collect in one Hidden group at the end, each with Show.
 */
export const ProjectsTree = React.memo(function ProjectsTree(props: Readonly<{
    testID?: string;
    rows: readonly ProjectsTreeRow[];
    onToggle: (key: string) => void;
    onOpenRef: (refId: string, address?: WorkspaceAddressV1) => void;
    /** A row's own menu (New session here, Save as a source, Hide project). */
    renderRowMenu?: ((row: ProjectsTreeRow) => React.ReactNode) | null;
    hrefForRef?: ((refId: string, address?: WorkspaceAddressV1) => string | null) | null;
    saved?: Readonly<{ items: readonly ProjectsTreeSavedItem[]; onOpen: (key: string) => void }> | null;
    hidden?: Readonly<{
        items: readonly ProjectsTreeHiddenItem[];
        open: boolean;
        onToggle: () => void;
        onShow: (key: string) => void;
    }> | null;
}>) {
    const { theme } = useUnistyles();
    const reducedMotion = useReducedMotionPreference();
    const testID = props.testID ?? 'projects-tree';
    const { onOpenRef, onToggle } = props;
    const keyboard = useProjectsTreeKeyboard(props.rows, {
        onToggle,
        onOpenRow: (row) => openTreeRow(row, onOpenRef, onToggle),
    });
    const disclosureColumn = props.rows.some((candidate) => candidate.expandable);
    return (
        <View testID={testID} {...(Platform.OS === 'web' ? { role: 'tree' as const } : {})}>
            {props.rows.map((row) => {
                const leading = (
                    <View style={styles.leading}>
                        {disclosureColumn ? (
                            // The shared turning chevron; the row itself toggles (parents disclose, leaves navigate).
                            <HappierTreeDisclosure
                                kind={row.expandable ? 'branch' : 'leaf'}
                                expanded={row.expanded}
                                color={theme.colors.text.tertiary}
                                reducedMotion={reducedMotion}
                            />
                        ) : null}
                        <Icon
                            name={row.glyph === 'project' ? 'folder' : row.glyph === 'machine' ? 'desktop' : 'git-branch'}
                            size={16}
                            color={theme.colors.text.secondary}
                        />
                    </View>
                );
                const trailing = (
                    <View style={styles.trailing}>
                        {row.count != null ? <Text style={styles.count}>{String(row.count)}</Text> : null}
                        {row.attention === 'needs-you' ? (
                            <View testID={`${testID}-${row.key}-needs-you`} style={[styles.dot, { backgroundColor: theme.colors.state.warning.foreground }]} />
                        ) : row.attention === 'working' ? (
                            <ActivitySpinner size="small" color={theme.colors.text.tertiary} />
                        ) : null}
                        {props.renderRowMenu?.(row) ?? null}
                    </View>
                );
                return (
                    <CollectionNavigationRow
                        key={row.key}
                        testID={`${testID}-row-${row.key}`}
                        href={row.refId ? props.hrefForRef?.(row.refId, row.workspaceAddress) ?? null : null}
                        title={row.title}
                        titleAccessory={row.titleQualifier ? <Text numberOfLines={1} style={styles.qualifier}>{row.titleQualifier}</Text> : undefined}
                        subtitle={row.subtitle ?? undefined}
                        subtitleMono={row.kind === 'checkout' && row.subtitle != null}
                        leftElement={leading}
                        selected={row.selected}
                        dimmed={row.offline === true}
                        indentPx={row.level * HAPPIER_TREE_ROW_METRICS.indentStepPx}
                        treeItem={keyboard.getRowProps(row)}
                        accessibilityLabel={row.titleQualifier ? `${row.title}, ${row.titleQualifier}` : row.title}
                        rightElement={trailing}
                        onPress={() => openTreeRow(row, onOpenRef, onToggle)}
                    />
                );
            })}
            {props.saved && props.saved.items.length > 0 ? (
                <>
                    <CollectionListGroupLabel testID={`${testID}-saved`} title={t('projects.identity.savedNotOpen')} count={props.saved.items.length} />
                    {props.saved.items.map((item) => (
                        <CollectionNavigationRow
                            key={item.key}
                            testID={`${testID}-saved-${item.key}`}
                            title={item.title}
                            subtitle={item.subtitle}
                            icon={<Icon name="folder" size={16} color={theme.colors.text.tertiary} />}
                            dimmed
                            selected={false}
                            rightElement={<Text style={styles.count}>{t('projects.identity.notOpen')}</Text>}
                            onPress={() => props.saved?.onOpen(item.key)}
                        />
                    ))}
                </>
            ) : null}
            {props.hidden && props.hidden.items.length > 0 ? (
                <View style={[styles.hidden, { borderTopColor: theme.colors.border.subtle }]}>
                    <HappierPressable
                        testID={`${testID}-hidden`}
                        accessibilityRole="button"
                        accessibilityLabel={t('projects.identity.hiddenCount', { count: props.hidden.items.length })}
                        expanded={props.hidden.open}
                        onPress={props.hidden.onToggle}
                        style={(state) => [
                            styles.hiddenHeader,
                            focusRingStyle({ focused: state.focused, color: theme.colors.border.focus }),
                            state.pressed || state.hovered ? { backgroundColor: theme.colors.surface.pressed } : null,
                        ]}
                    >
                        <Icon name="eye-slash" size={16} color={theme.colors.text.secondary} />
                        <Text style={styles.hiddenTitle}>{t('projects.identity.hiddenTitle')}</Text>
                        <Text style={styles.count}>{String(props.hidden.items.length)}</Text>
                        <View style={styles.grow} />
                        <Icon name={props.hidden.open ? 'caret-down' : 'caret-right'} size={12} color={theme.colors.text.tertiary} />
                    </HappierPressable>
                    {props.hidden.open ? props.hidden.items.map((item) => (
                        <View key={item.key} testID={`${testID}-hidden-${item.key}`} style={styles.hiddenRow}>
                            <Icon name="folder" size={16} color={theme.colors.text.tertiary} />
                            <View style={styles.hiddenText}>
                                <Text numberOfLines={1} style={styles.hiddenRowTitle}>{item.title}</Text>
                                <Text numberOfLines={1} style={styles.hiddenRowSubtitle}>{item.subtitle}</Text>
                            </View>
                            <ToolbarButton
                                testID={`${testID}-show-${item.key}`}
                                label={t('projects.identity.show')}
                                accessibilityLabel={`${t('projects.identity.show')} ${item.title}`}
                                onPress={() => props.hidden?.onShow(item.key)}
                            />
                        </View>
                    )) : null}
                </View>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    leading: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    trailing: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    qualifier: {
        ...Typography.rowMeta(),
        color: theme.colors.text.secondary,
        marginLeft: 6,
    },
    count: {
        ...Typography.rowMeta(),
        ...Typography.tabular(),
        color: theme.colors.text.tertiary,
    },
    dot: {
        width: 6,
        height: 6,
        borderRadius: 3,
    },
    hidden: {
        marginTop: 12,
        paddingTop: 8,
        borderTopWidth: StyleSheet.hairlineWidth || 1,
    },
    hiddenHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        minHeight: 36,
        paddingHorizontal: 12,
        marginHorizontal: 4,
        borderRadius: 8,
    },
    hiddenTitle: {
        ...Typography.rowTitle(),
        ...Typography.default('regular'),
        color: theme.colors.text.secondary,
    },
    grow: {
        flex: 1,
    },
    hiddenRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
        minHeight: 48,
        paddingHorizontal: 12,
        marginHorizontal: 4,
    },
    hiddenText: {
        flex: 1,
        minWidth: 0,
    },
    hiddenRowTitle: {
        ...Typography.rowTitle(),
        ...Typography.default('regular'),
        color: theme.colors.text.secondary,
    },
    hiddenRowSubtitle: {
        ...Typography.rowMeta(),
        color: theme.colors.text.tertiary,
    },
}));
