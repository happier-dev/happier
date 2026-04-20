import React from 'react';
import { View, Pressable, Platform } from 'react-native';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { useUnistyles } from 'react-native-unistyles';
import { RecoveryKeyReminderBanner } from '@/components/account/RecoveryKeyReminderBanner';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { t } from '@/text';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';

import { sessionListStyles } from './sessionListStyles';
import { resolveProjectGroupHeaderMenuItems } from './resolveProjectGroupHeaderMenuItems';
import { resolveSessionsListHeaderMenuItems } from './resolveSessionsListHeaderMenuItems';

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

function stopPressEventPropagation(event: unknown): void {
    if (!event || typeof event !== 'object' || !('stopPropagation' in event)) {
        return;
    }
    const stopPropagation = (event as { stopPropagation?: () => void }).stopPropagation;
    if (typeof stopPropagation === 'function') {
        (event as { stopPropagation: () => void }).stopPropagation();
    }
}

const SessionListOrderingMenuButton = React.memo(function SessionListOrderingMenuButton(props: Readonly<{
    placement?: 'top' | 'bottom' | 'left' | 'right';
    onMenuOpenChange?: (open: boolean) => void;
}>) {
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

    const menuItems = resolveSessionsListHeaderMenuItems({
        orderingMode,
        activeGrouping,
        inactiveGrouping,
        isHideInactiveSessionsEnabled,
        actionIconColor,
    });

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
        <DropdownMenu
            open={menuOpen}
            onOpenChange={(open) => {
                setMenuOpen(open);
                props.onMenuOpenChange?.(open);
            }}
            items={menuItems}
            onSelect={handleMenuSelect}
            selectedId={orderingMode}
            variant="slim"
            search={false}
            showCategoryTitles={true}
            matchTriggerWidth={false}
            maxWidthCap={220}
            popoverPortalWebTarget="body"
            placement={props.placement ?? 'bottom'}
            popoverAnchorAlign="end"
            trigger={({ toggle }) => (
                <Pressable
                    testID="session-list-ordering-menu-trigger"
                    style={styles.headerActionButton}
                    onPress={(event) => {
                        stopPressEventPropagation(event);
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
    );
});

export const SessionsListHeader = React.memo(function SessionsListHeader() {
    const styles = sessionListStyles;

    return (
        <View style={styles.listHeaderSection}>
            <RecoveryKeyReminderBanner />
        </View>
    );
});

export const ProjectGroupHeader = React.memo(function ProjectGroupHeader(props: Readonly<{
    item: Extract<SessionListIndexItem, { type: 'header' }>;
    hasMultipleMachines: boolean;
    displayTitle: string;
    hasCustomLabel: boolean;
    canOpenProject: boolean;
    onOpenProject: () => void;
    onCreateSession: () => void;
    onRename: () => void;
    onReset: () => void;
    collapsed: boolean;
    onToggleCollapse: () => void;
}>) {
    const styles = sessionListStyles;
    const { theme } = useUnistyles();
    const { item, hasMultipleMachines, displayTitle, hasCustomLabel, canOpenProject, onOpenProject, onCreateSession, onRename, onReset, collapsed, onToggleCollapse } = props;
    const [isRowHovered, setIsRowHovered] = React.useState(false);
    const [isActionsHovered, setIsActionsHovered] = React.useState(false);
    const [menuOpen, setMenuOpen] = React.useState(false);
    const isWeb = Platform.OS === 'web';
    const showHoverActions = !isWeb || isRowHovered || isActionsHovered || menuOpen;
    const showChevron = !isWeb || collapsed || showHoverActions;
    const menuEnabled = Boolean(item.workspaceScopeHint);
    const actionIconColor = theme.colors.textSecondary;
    const canCreateSession = Boolean(item.workspaceScopeHint);

    const menuItems = resolveProjectGroupHeaderMenuItems({
        menuEnabled: Boolean(item.workspaceScopeHint),
        canOpenProject,
        hasCustomLabel,
        actionIconColor,
    });

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
                            style={styles.groupHeaderInlineActions}
                            onPointerEnter={isWeb ? () => setIsActionsHovered(true) : undefined}
                            onPointerLeave={isWeb ? () => setIsActionsHovered(false) : undefined}
                        >
                            <View
                                style={[
                                    styles.groupHeaderChevron,
                                    isWeb && !showChevron ? styles.webHoverHiddenChevron : styles.webHoverVisibleChevron,
                                ]}
                            >
                                <Ionicons
                                    name={collapsed ? 'chevron-forward' : 'chevron-down'}
                                    size={12}
                                    color={chevronColor}
                                />
                            </View>
                            {showHoverActions && menuEnabled ? (
                                <DropdownMenu
                                    open={menuOpen}
                                    onOpenChange={setMenuOpen}
                                    items={menuItems}
                                    onSelect={(itemId) => {
                                        if (itemId === 'openProject') {
                                            onOpenProject();
                                        } else if (itemId === 'rename') {
                                            onRename();
                                        } else if (itemId === 'reset') {
                                            onReset();
                                        }
                                    }}
                                    placement="bottom"
                                    popoverAnchorAlign="end"
                                    variant="slim"
                                    matchTriggerWidth={false}
                                    maxWidthCap={220}
                                    showCategoryTitles={false}
                                    popoverPortalWebTarget="body"
                                    trigger={({ toggle }) => (
                                        <Pressable
                                            style={styles.groupHeaderActionButton}
                                            onPress={(event) => {
                                                stopPressEventPropagation(event);
                                                toggle();
                                            }}
                                            onHoverIn={isWeb ? () => setIsActionsHovered(true) : undefined}
                                            onHoverOut={isWeb ? () => setIsActionsHovered(false) : undefined}
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
                    </View>
                    {hasMultipleMachines && item.subtitle ? (
                        <Text style={styles.groupHeaderSubtitle}>{item.subtitle}</Text>
                    ) : null}
                </View>
                <View style={styles.groupHeaderTrailingActions}>
                    {canCreateSession ? (
                        <Pressable
                            style={styles.groupHeaderActionButton}
                            onPress={(event) => {
                                stopPressEventPropagation(event);
                                onCreateSession();
                            }}
                            accessibilityRole="button"
                            accessibilityLabel={t('machine.launchNewSessionInDirectory')}
                            hitSlop={8}
                        >
                            <Ionicons name="add" size={14} color={actionIconColor} />
                        </Pressable>
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
    showOrderingMenu?: boolean;
}>) {
    const styles = sessionListStyles;
    const { theme } = useUnistyles();
    const isWeb = Platform.OS === 'web';
    const [isHovered, setIsHovered] = React.useState(false);
    const [isOrderingMenuOpen, setIsOrderingMenuOpen] = React.useState(false);
    const headerChevronColor = theme.colors.textSecondary;
    const isPrimaryHeader = props.showOrderingMenu === true;
    const showChevron = !isWeb || props.collapsed || isHovered || isOrderingMenuOpen;
    const showOrderingMenu = props.showOrderingMenu === true;
    return (
        <Pressable
            style={isPrimaryHeader ? styles.headerSection : styles.groupHeaderSection}
            onPress={props.onPress}
            onHoverIn={isWeb ? () => setIsHovered(true) : undefined}
            onHoverOut={isWeb ? () => setIsHovered(false) : undefined}
        >
            <View style={styles.headerRow}>
                <View style={styles.headerLabelRow}>
                    <Text style={isPrimaryHeader ? styles.headerText : styles.groupHeaderTitle}>{props.title}</Text>
                    <View
                        style={[
                            styles.headerChevron,
                            isWeb && !showChevron ? styles.webHoverHiddenChevron : styles.webHoverVisibleChevron,
                        ]}
                    >
                        <Ionicons
                            name={props.collapsed ? 'chevron-forward' : 'chevron-down'}
                            size={12}
                            color={headerChevronColor}
                        />
                    </View>
                </View>
                {showOrderingMenu ? (
                    <SessionListOrderingMenuButton
                        placement="bottom"
                        onMenuOpenChange={setIsOrderingMenuOpen}
                    />
                ) : null}
            </View>
        </Pressable>
    );
});
