import React from 'react';
import { View, Pressable, Platform } from 'react-native';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { useUnistyles } from 'react-native-unistyles';
import { RecoveryKeyReminderBanner } from '@/components/account/RecoveryKeyReminderBanner';
import { UpdateBanner } from '@/components/ui/feedback/UpdateBanner';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { t } from '@/text';
import type { SessionListViewItem } from '@/sync/domains/state/storage';

import { sessionListStyles } from './sessionListStyles';

const ORDERING_MENU_IDS = {
    custom: 'custom',
    created: 'created',
    updated: 'updated',
    activeGroupingProject: 'activeGroupingProject',
    activeGroupingDate: 'activeGroupingDate',
    inactiveGroupingProject: 'inactiveGroupingProject',
    inactiveGroupingDate: 'inactiveGroupingDate',
    hideInactiveSessions: 'hideInactiveSessions',
} as const;

export const SessionsListHeader = React.memo(function SessionsListHeader() {
    const styles = sessionListStyles;
    const { theme } = useUnistyles();
    const [orderingMode, setOrderingMode] = useSettingMutable('sessionListOrderingModeV1');
    const [sessionListActiveGroupingV1, setSessionListActiveGroupingV1] = useSettingMutable('sessionListActiveGroupingV1');
    const [sessionListInactiveGroupingV1, setSessionListInactiveGroupingV1] = useSettingMutable('sessionListInactiveGroupingV1');
    const [hideInactiveSessions, setHideInactiveSessions] = useSettingMutable('hideInactiveSessions');
    const [menuOpen, setMenuOpen] = React.useState(false);
    const actionIconColor = theme.colors.textSecondary;
    const activeGrouping = sessionListActiveGroupingV1 === 'date' ? 'date' : 'project';
    const inactiveGrouping = sessionListInactiveGroupingV1 === 'date' ? 'date' : 'project';
    const isHideInactiveSessionsEnabled = hideInactiveSessions === true;

    const menuItems = React.useMemo((): DropdownMenuItem[] => ([
        {
            id: ORDERING_MENU_IDS.custom,
            title: t('settingsSession.sessionList.orderingOptions.custom'),
            rightElement: orderingMode === ORDERING_MENU_IDS.custom
                ? <Ionicons name="checkmark" size={16} color={actionIconColor} />
                : undefined,
        },
        {
            id: ORDERING_MENU_IDS.created,
            title: t('settingsSession.sessionList.orderingOptions.created'),
            rightElement: orderingMode === ORDERING_MENU_IDS.created
                ? <Ionicons name="checkmark" size={16} color={actionIconColor} />
                : undefined,
        },
        {
            id: ORDERING_MENU_IDS.updated,
            title: t('settingsSession.sessionList.orderingOptions.updated'),
            rightElement: orderingMode === ORDERING_MENU_IDS.updated
                ? <Ionicons name="checkmark" size={16} color={actionIconColor} />
                : undefined,
        },
        {
            id: ORDERING_MENU_IDS.activeGroupingProject,
            title: t('settingsFeatures.sessionListGrouping.projectTitle'),
            subtitle: t('settingsFeatures.sessionListActiveGrouping'),
            rightElement: activeGrouping === 'project'
                ? <Ionicons name="checkmark" size={16} color={actionIconColor} />
                : undefined,
        },
        {
            id: ORDERING_MENU_IDS.activeGroupingDate,
            title: t('settingsFeatures.sessionListGrouping.dateTitle'),
            subtitle: t('settingsFeatures.sessionListActiveGrouping'),
            rightElement: activeGrouping === 'date'
                ? <Ionicons name="checkmark" size={16} color={actionIconColor} />
                : undefined,
        },
        {
            id: ORDERING_MENU_IDS.inactiveGroupingProject,
            title: t('settingsFeatures.sessionListGrouping.projectTitle'),
            subtitle: t('settingsFeatures.sessionListInactiveGrouping'),
            rightElement: inactiveGrouping === 'project'
                ? <Ionicons name="checkmark" size={16} color={actionIconColor} />
                : undefined,
        },
        {
            id: ORDERING_MENU_IDS.inactiveGroupingDate,
            title: t('settingsFeatures.sessionListGrouping.dateTitle'),
            subtitle: t('settingsFeatures.sessionListInactiveGrouping'),
            rightElement: inactiveGrouping === 'date'
                ? <Ionicons name="checkmark" size={16} color={actionIconColor} />
                : undefined,
        },
        {
            id: ORDERING_MENU_IDS.hideInactiveSessions,
            title: t('settingsFeatures.hideInactiveSessions'),
            subtitle: t('settingsFeatures.hideInactiveSessionsSubtitle'),
            rightElement: isHideInactiveSessionsEnabled
                ? <Ionicons name="checkmark" size={16} color={actionIconColor} />
                : undefined,
        },
    ]), [actionIconColor, activeGrouping, inactiveGrouping, isHideInactiveSessionsEnabled, orderingMode]);

    const handleMenuSelect = React.useCallback((itemId: string) => {
        if (itemId === ORDERING_MENU_IDS.custom
            || itemId === ORDERING_MENU_IDS.created
            || itemId === ORDERING_MENU_IDS.updated
        ) {
            setOrderingMode(itemId);
            setMenuOpen(false);
            return;
        }
        if (itemId === ORDERING_MENU_IDS.activeGroupingProject) {
            setSessionListActiveGroupingV1('project');
            return;
        }
        if (itemId === ORDERING_MENU_IDS.activeGroupingDate) {
            setSessionListActiveGroupingV1('date');
            return;
        }
        if (itemId === ORDERING_MENU_IDS.inactiveGroupingProject) {
            setSessionListInactiveGroupingV1('project');
            return;
        }
        if (itemId === ORDERING_MENU_IDS.inactiveGroupingDate) {
            setSessionListInactiveGroupingV1('date');
            return;
        }
        if (itemId === ORDERING_MENU_IDS.hideInactiveSessions) {
            setHideInactiveSessions(!isHideInactiveSessionsEnabled);
        }
        setMenuOpen(false);
    }, [
        isHideInactiveSessionsEnabled,
        setHideInactiveSessions,
        setOrderingMode,
        setSessionListActiveGroupingV1,
        setSessionListInactiveGroupingV1,
    ]);

    return (
        <View style={styles.listHeaderSection}>
            <View style={styles.listHeaderMenuRow}>
                <DropdownMenu
                    open={menuOpen}
                    onOpenChange={setMenuOpen}
                    items={menuItems}
                    onSelect={handleMenuSelect}
                    selectedId={orderingMode}
                    variant="slim"
                    search={false}
                    showCategoryTitles={false}
                    matchTriggerWidth={false}
                    maxWidthCap={220}
                    popoverPortalWebTarget="body"
                    placement="bottom"
                    trigger={({ toggle }) => (
                        <Pressable
                            style={styles.listHeaderMenuButton}
                            onPress={(event) => {
                                if (event && typeof event === 'object' && 'stopPropagation' in event) {
                                    const stopPropagation = (event as { stopPropagation?: unknown }).stopPropagation;
                                    if (typeof stopPropagation === 'function') {
                                        stopPropagation();
                                    }
                                }
                                toggle();
                            }}
                            accessibilityRole="button"
                            accessibilityLabel={t('settingsSession.sessionList.orderingTitle')}
                            hitSlop={8}
                        >
                            <Ionicons name="filter-outline" size={16} color={actionIconColor} />
                        </Pressable>
                    )}
                />
            </View>
            <RecoveryKeyReminderBanner />
            <UpdateBanner />
        </View>
    );
});

export const ProjectGroupHeader = React.memo(function ProjectGroupHeader(props: Readonly<{
    item: Extract<SessionListViewItem, { type: 'header' }>;
    hasMultipleMachines: boolean;
    displayTitle: string;
    hasCustomLabel: boolean;
    canOpenProject: boolean;
    onOpenProject: () => void;
    onRename: () => void;
    onReset: () => void;
    collapsed: boolean;
    onToggleCollapse: () => void;
}>) {
    const styles = sessionListStyles;
    const { theme } = useUnistyles();
    const { item, hasMultipleMachines, displayTitle, hasCustomLabel, canOpenProject, onOpenProject, onRename, onReset, collapsed, onToggleCollapse } = props;
    const [isRowHovered, setIsRowHovered] = React.useState(false);
    const [isActionsHovered, setIsActionsHovered] = React.useState(false);
    const [menuOpen, setMenuOpen] = React.useState(false);
    const isWeb = Platform.OS === 'web';
    const showActions = !isWeb || isRowHovered || isActionsHovered || menuOpen;
    const menuEnabled = Boolean(item.workspaceScopeHint);
    const actionIconColor = theme.colors.textSecondary;

    const menuItems = React.useMemo((): DropdownMenuItem[] => {
        if (!item.workspaceScopeHint) return [];
        const items: DropdownMenuItem[] = [
            ...(canOpenProject ? [{
                id: 'openProject',
                title: t('sessionsList.openProject'),
                icon: <Ionicons name="folder-outline" size={16} color={actionIconColor} />,
            } satisfies DropdownMenuItem] : []),
            {
                id: 'rename',
                title: t('sessionsList.renameWorkspace'),
                icon: <Ionicons name="pencil-outline" size={16} color={actionIconColor} />,
            },
        ];
        if (hasCustomLabel) {
            items.push({
                id: 'reset',
                title: t('sessionsList.resetWorkspaceName'),
                icon: <Ionicons name="refresh-outline" size={16} color={actionIconColor} />,
            });
        }
        return items;
    }, [canOpenProject, hasCustomLabel, actionIconColor, item.workspaceScopeHint]);

    const handleMenuSelect = React.useCallback((itemId: string) => {
        if (itemId === 'openProject') {
            onOpenProject();
        } else if (itemId === 'rename') {
            onRename();
        } else if (itemId === 'reset') {
            onReset();
        }
    }, [onOpenProject, onRename, onReset]);

    const chevronColor = theme.colors.textSecondary;
    return (
        <View style={styles.groupHeaderSection}>
            <Pressable
                style={styles.groupHeaderRow}
                onPress={onToggleCollapse}
                onHoverIn={isWeb ? () => setIsRowHovered(true) : undefined}
                onHoverOut={isWeb ? () => setIsRowHovered(false) : undefined}
            >
                <View style={styles.groupHeaderContent}>
                    <View style={styles.groupHeaderTitleRow}>
                        <Text style={styles.groupHeaderTitle} numberOfLines={1}>{displayTitle}</Text>
                        <View
                            style={[
                                styles.groupHeaderChevron,
                                isWeb ? styles.webHoverVisibleChevron : null,
                            ]}
                        >
                            <Ionicons
                                name={collapsed ? 'chevron-forward' : 'chevron-down'}
                                size={12}
                                color={chevronColor}
                            />
                        </View>
                    </View>
                    {hasMultipleMachines && item.subtitle ? (
                        <Text style={styles.groupHeaderSubtitle}>{item.subtitle}</Text>
                    ) : null}
                </View>
                <View
                    onPointerEnter={isWeb ? () => setIsActionsHovered(true) : undefined}
                    onPointerLeave={isWeb ? () => setIsActionsHovered(false) : undefined}
                >
                    {showActions && menuEnabled ? (
                        <DropdownMenu
                            open={menuOpen}
                            onOpenChange={setMenuOpen}
                            items={menuItems}
                            onSelect={handleMenuSelect}
                            placement="left"
                            variant="slim"
                            matchTriggerWidth={false}
                            maxWidthCap={220}
                            showCategoryTitles={false}
                            popoverPortalWebTarget="body"
                            trigger={({ toggle }) => (
                                <Pressable
                                    style={styles.groupHeaderActionButton}
                                    onPress={(event) => {
                                        if (event && typeof event === 'object' && 'stopPropagation' in event) {
                                            const stopPropagation = (event as { stopPropagation?: unknown }).stopPropagation;
                                            if (typeof stopPropagation === 'function') {
                                                stopPropagation();
                                            }
                                        }
                                        toggle();
                                    }}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('common.moreActions')}
                                    hitSlop={8}
                                >
                                    <Octicons name="kebab-horizontal" size={12} color={actionIconColor} />
                                </Pressable>
                            )}
                        />
                    ) : null}
                </View>
            </Pressable>
        </View>
    );
});

export const CollapsibleSectionHeader = React.memo(function CollapsibleSectionHeader(props: Readonly<{
    title: string;
    collapsed: boolean;
    onPress: () => void;
}>) {
    const styles = sessionListStyles;
    const { theme } = useUnistyles();
    const isWeb = Platform.OS === 'web';
    const headerChevronColor = theme.colors.textSecondary;
    return (
        <Pressable
            style={styles.headerSection}
            onPress={props.onPress}
        >
            <View style={styles.headerRow}>
                <View style={styles.headerLabelRow}>
                    <Text style={styles.headerText}>{props.title}</Text>
                    <View
                        style={[
                            styles.headerChevron,
                            isWeb ? styles.webHoverVisibleChevron : null,
                        ]}
                    >
                        <Ionicons
                            name={props.collapsed ? 'chevron-forward' : 'chevron-down'}
                            size={14}
                            color={headerChevronColor}
                        />
                    </View>
                </View>
            </View>
        </Pressable>
    );
});
