import React from 'react';
import { View, Pressable, Platform, Image as ReactNativeImage } from 'react-native';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSettingMutable } from '@/sync/domains/state/storage';
import { useUnistyles } from 'react-native-unistyles';
import { RecoveryKeyReminderBanner } from '@/components/account/RecoveryKeyReminderBanner';
import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { Eyebrow } from '@/components/ui/text/Eyebrow';
import { Ionicons, Octicons } from '@expo/vector-icons';
import { t } from '@/text';
import type { SessionListIndexItem } from '@/sync/domains/sessionList/sessionListIndex';
import {
    resolveDurableWorkspaceRefForSessionListHeader,
    type SessionFolderV1,
    type SessionFolderWorkspaceRefV1,
} from '@/sync/domains/session/folders';

import { sessionListStyles } from './sessionListStyles';
import { resolveProjectGroupHeaderMenuItems } from './resolveProjectGroupHeaderMenuItems';
import { resolveSessionsListHeaderMenuItems } from './resolveSessionsListHeaderMenuItems';
import type { RegisterSessionFolderDropTarget } from './useSessionListViewState';
import { useWorkspaceFavicon } from './useWorkspaceFavicon';

const ORDERING_MENU_IDS = {
    custom: 'custom',
    created: 'created',
    updated: 'updated',
    activeGroupingProject: 'activeGroupingProject',
    activeGroupingDate: 'activeGroupingDate',
    inactiveGroupingProject: 'inactiveGroupingProject',
    inactiveGroupingDate: 'inactiveGroupingDate',
    hideInactiveSessions: 'hideInactiveSessions',
    sessionFolderViewModeTree: 'sessionFolderViewModeTree',
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

type MeasuredSessionFolderDropTarget = Readonly<
    | {
        type: 'folder';
        folderId: string;
        workspace: SessionFolderWorkspaceRefV1;
        serverId: string | null;
    }
    | {
        type: 'workspace-root';
        workspace: SessionFolderWorkspaceRefV1;
        serverId: string | null;
    }
>;

function useMeasuredDropTargetRegistration(params: Readonly<{
    id: string | null;
    target: MeasuredSessionFolderDropTarget | null;
    onRegister?: RegisterSessionFolderDropTarget;
}>) {
    const ref = React.useRef<View>(null);
    const cleanupRef = React.useRef<(() => void) | null>(null);
    const clearRegistration = React.useCallback(() => {
        cleanupRef.current?.();
        cleanupRef.current = null;
    }, []);
    React.useEffect(() => clearRegistration, [clearRegistration]);
    const onLayout = React.useCallback((event?: { nativeEvent?: { layout?: { x: number; y: number; width: number; height: number } } }) => {
        clearRegistration();
        if (!params.id || !params.target || !params.onRegister) return;
        const node = ref.current as unknown as {
            measureInWindow?: (callback: (x: number, y: number, width: number, height: number) => void) => void;
        } | null;
        const targetId = params.id;
        const target = params.target;
        const register = (x: number, y: number, width: number, height: number) => {
            if (!targetId || !target) return;
            cleanupRef.current = params.onRegister?.(target.type === 'folder' ? {
                type: 'folder',
                folderId: target.folderId,
                workspace: target.workspace,
                serverId: target.serverId,
                id: targetId,
                bounds: { x, y, width, height },
            } : {
                type: 'workspace-root',
                workspace: target.workspace,
                serverId: target.serverId,
                id: targetId,
                bounds: { x, y, width, height },
            }) ?? null;
        };
        if (typeof node?.measureInWindow === 'function') {
            node.measureInWindow(register);
            return;
        }
        const fallback = event?.nativeEvent?.layout;
        if (fallback) {
            register(fallback.x, fallback.y, fallback.width, fallback.height);
        }
    }, [clearRegistration, params.id, params.onRegister, params.target]);
    return { ref, onLayout };
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
    const [sessionFolderViewModeV1, setSessionFolderViewModeV1] = useSettingMutable('sessionFolderViewModeV1');
    const sessionFoldersFeatureEnabled = useFeatureEnabled('sessions.folders');
    const [menuOpen, setMenuOpen] = React.useState(false);
    const actionIconColor = theme.colors.text.secondary;
    const activeGrouping = sessionListActiveGroupingV1 === 'date' ? 'date' : 'project';
    const inactiveGrouping = sessionListInactiveGroupingV1 === 'date' ? 'date' : 'project';
    const isHideInactiveSessionsEnabled = hideInactiveSessions === true;

    const menuItems = resolveSessionsListHeaderMenuItems({
        orderingMode,
        activeGrouping,
        inactiveGrouping,
        isHideInactiveSessionsEnabled,
        showFolderViewMode: sessionFoldersFeatureEnabled,
        folderViewMode: sessionFolderViewModeV1 === 'tree' ? 'tree' : 'off',
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
        if (sessionFoldersFeatureEnabled && itemId === ORDERING_MENU_IDS.sessionFolderViewModeTree) {
            setSessionFolderViewModeV1(sessionFolderViewModeV1 === 'tree' ? 'off' : 'tree');
        }
        setMenuOpen(false);
    }, [
        isHideInactiveSessionsEnabled,
        setHideInactiveSessions,
        setOrderingMode,
        setSessionListActiveGroupingV1,
        setSessionListInactiveGroupingV1,
        sessionFoldersFeatureEnabled,
        sessionFolderViewModeV1,
        setSessionFolderViewModeV1,
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

export const SessionFolderFocusBreadcrumbs = React.memo(function SessionFolderFocusBreadcrumbs(props: Readonly<{
    breadcrumbs: ReadonlyArray<SessionFolderV1>;
    onClear: () => void;
    onSelectFolder: (folderId: string) => void;
    rootTitle?: string | null;
}>) {
    const styles = sessionListStyles;
    const { theme } = useUnistyles();
    if (props.breadcrumbs.length === 0) return null;
    return (
        <View style={styles.groupHeaderSection} testID="session-folder-focused-breadcrumbs">
            <View style={styles.headerLabelRow}>
                <Pressable
                    testID="session-folder-breadcrumb-root"
                    onPress={props.onClear}
                    accessibilityRole="button"
                    accessibilityLabel={props.rootTitle ?? t('sessionsList.workspaceRoot')}
                    hitSlop={8}
                >
                    <Text style={styles.groupHeaderSubtitle}>{props.rootTitle ?? t('sessionsList.workspaceRoot')}</Text>
                </Pressable>
                {props.breadcrumbs.map((breadcrumb) => (
                    <React.Fragment key={breadcrumb.id}>
                        <Ionicons name="chevron-forward" size={12} color={theme.colors.text.tertiary} />
                        <Pressable
                            testID={`session-folder-breadcrumb-folder-${breadcrumb.id}`}
                            onPress={() => props.onSelectFolder(breadcrumb.id)}
                            accessibilityRole="button"
                            accessibilityLabel={breadcrumb.name}
                            hitSlop={8}
                        >
                            <Text style={styles.groupHeaderSubtitle}>{breadcrumb.name}</Text>
                        </Pressable>
                    </React.Fragment>
                ))}
            </View>
        </View>
    );
});

export const ProjectGroupHeader = React.memo(function ProjectGroupHeader(props: Readonly<{
    item: Extract<SessionListIndexItem, { type: 'header' }>;
    hasMultipleMachines: boolean;
    displayTitle: string;
    hasCustomLabel: boolean;
    canOpenProject: boolean;
    workspaceFaviconsEnabled?: boolean;
    workspaceMachineSubtitlesEnabled?: boolean;
    onOpenProject: () => void;
    onCreateSession: () => void;
    onAddFolder: () => void;
    onRename: () => void;
    onReset: () => void;
    collapsed: boolean;
    onToggleCollapse: () => void;
    onRegisterDropTarget?: RegisterSessionFolderDropTarget;
    activeDropTargetId?: string | null;
}>) {
    const styles = sessionListStyles;
    const { theme } = useUnistyles();
    const { item, hasMultipleMachines, displayTitle, hasCustomLabel, canOpenProject, workspaceFaviconsEnabled = false, workspaceMachineSubtitlesEnabled = true, onOpenProject, onCreateSession, onAddFolder, onRename, onReset, collapsed, onToggleCollapse } = props;
    const [isRowHovered, setIsRowHovered] = React.useState(false);
    const [isActionsHovered, setIsActionsHovered] = React.useState(false);
    const [menuOpen, setMenuOpen] = React.useState(false);
    const isWeb = Platform.OS === 'web';
    const sessionFoldersFeatureEnabled = useFeatureEnabled('sessions.folders');
    const showHoverActions = !isWeb || isRowHovered || isActionsHovered || menuOpen;
    const showChevron = !isWeb || collapsed || showHoverActions;
    const menuEnabled = Boolean(item.workspaceScopeHint);
    const actionIconColor = theme.colors.text.secondary;
    const canCreateSession = Boolean(item.workspaceScopeHint);
    const favicon = useWorkspaceFavicon({
        enabled: workspaceFaviconsEnabled,
        serverId: item.workspaceScopeHint?.serverId ?? item.serverId ?? null,
        machineId: item.workspaceScopeHint?.machineId ?? null,
        workspacePath: item.workspaceScopeHint?.rootPath ?? null,
    });
    const workspace = React.useMemo(() => resolveDurableWorkspaceRefForSessionListHeader(item), [item]);
    const dropTarget = React.useMemo(() => {
        if (!workspace) return null;
        return {
            type: 'workspace-root' as const,
            workspace,
            serverId: item.serverId ?? workspace.serverId ?? null,
        };
    }, [item.serverId, workspace]);
    const dropRegistration = useMeasuredDropTargetRegistration({
        id: dropTarget ? `workspace-root:${item.groupKey ?? item.workspaceKey ?? displayTitle}` : null,
        target: dropTarget,
        onRegister: props.onRegisterDropTarget,
    });
    const isActiveDropTarget = props.activeDropTargetId === `workspace-root:${item.groupKey ?? item.workspaceKey ?? displayTitle}`;

    const menuItems = resolveProjectGroupHeaderMenuItems({
        menuEnabled: Boolean(item.workspaceScopeHint),
        canOpenProject,
        canAddFolder: sessionFoldersFeatureEnabled,
        hasCustomLabel,
        actionIconColor,
    });

    const chevronColor = theme.colors.text.secondary;
    return (
        <View style={styles.groupHeaderSection}>
            <View
                ref={dropRegistration.ref}
                style={[styles.groupHeaderRow, isActiveDropTarget ? styles.dropTargetActive : null]}
                onLayout={dropRegistration.onLayout}
                onPointerEnter={isWeb ? () => setIsRowHovered(true) : undefined}
                onPointerLeave={isWeb ? () => setIsRowHovered(false) : undefined}
            >
                <Pressable
                    style={styles.groupHeaderContent}
                    onPress={onToggleCollapse}
                    onHoverIn={isWeb ? () => setIsRowHovered(true) : undefined}
                    onHoverOut={isWeb ? () => setIsRowHovered(false) : undefined}
                    accessibilityRole="button"
                    accessibilityLabel={displayTitle}
                >
                    <View style={styles.groupHeaderTitleRow}>
                        {favicon ? (
                            <View testID="session-list-workspace-favicon" style={styles.groupHeaderFaviconFrame}>
                                <ReactNativeImage
                                    source={{ uri: favicon.uri }}
                                    style={styles.groupHeaderFavicon}
                                    resizeMode="cover"
                                    accessibilityIgnoresInvertColors
                                />
                            </View>
                        ) : null}
                        <Eyebrow style={styles.groupHeaderTitle} numberOfLines={1}>{displayTitle}</Eyebrow>
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
                        </View>
                    </View>
                    {workspaceMachineSubtitlesEnabled && hasMultipleMachines && item.subtitle ? (
                        <Text style={styles.groupHeaderSubtitle}>{item.subtitle}</Text>
                    ) : null}
                </Pressable>
                <View style={styles.groupHeaderTrailingActions}>
                    {showHoverActions && menuEnabled ? (
                        <DropdownMenu
                            open={menuOpen}
                            onOpenChange={setMenuOpen}
                            items={menuItems}
                            onSelect={(itemId) => {
                                if (itemId === 'openProject') {
                                    onOpenProject();
                                } else if (itemId === 'addFolder') {
                                    onAddFolder();
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
            </View>
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
    const headerChevronColor = theme.colors.text.secondary;
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
                    <Eyebrow style={isPrimaryHeader ? styles.headerText : styles.groupHeaderTitle}>{props.title}</Eyebrow>
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

export const FolderGroupHeader = React.memo(function FolderGroupHeader(props: Readonly<{
    title: string;
    depth: number;
    collapsed: boolean;
    onPress: () => void;
    onToggleCollapse: () => void;
    onNewSession: () => void;
    onAddSubfolder: () => void | Promise<void>;
    onRename: () => void | Promise<void>;
    onDelete: () => void | Promise<void>;
    item: Extract<SessionListIndexItem, { type: 'header' }>;
    onRegisterDropTarget?: RegisterSessionFolderDropTarget;
    activeDropTargetId?: string | null;
    disabled?: boolean;
}>) {
    const styles = sessionListStyles;
    const { theme } = useUnistyles();
    const [isHovered, setIsHovered] = React.useState(false);
    const [isActionsHovered, setIsActionsHovered] = React.useState(false);
    const [menuOpen, setMenuOpen] = React.useState(false);
    const isWeb = Platform.OS === 'web';
    const normalizedDepth = Math.min(Math.max(Math.trunc(props.depth), 0), 3);
    const indentation = 20 + normalizedDepth * 12;
    const iconColor = props.disabled ? theme.colors.text.tertiary : theme.colors.text.secondary;
    const showActions = !isWeb || isHovered || isActionsHovered || menuOpen;
    const dropTarget = React.useMemo(() => {
        if (!props.item.workspace || !props.item.folderId) return null;
        return {
            type: 'folder' as const,
            folderId: props.item.folderId,
            workspace: props.item.workspace,
            serverId: props.item.serverId ?? props.item.workspace.serverId ?? null,
        };
    }, [props.item.folderId, props.item.serverId, props.item.workspace]);
    const dropRegistration = useMeasuredDropTargetRegistration({
        id: dropTarget ? `folder:${dropTarget.folderId}` : null,
        target: dropTarget,
        onRegister: props.onRegisterDropTarget,
    });
    const isActiveDropTarget = dropTarget ? props.activeDropTargetId === `folder:${dropTarget.folderId}` : false;
    const menuItems = React.useMemo((): DropdownMenuItem[] => [
        {
            id: 'new-session',
            title: t('sessionsList.newSessionInFolder'),
            icon: <Ionicons name="add-circle-outline" size={16} color={iconColor} />,
            disabled: props.disabled,
        },
        {
            id: 'add-subfolder',
            title: t('sessionsList.addSubfolder'),
            icon: <Ionicons name="folder-open-outline" size={16} color={iconColor} />,
            disabled: props.disabled,
        },
        {
            id: 'rename',
            title: t('sessionsList.renameFolder'),
            icon: <Ionicons name="pencil-outline" size={16} color={iconColor} />,
            disabled: props.disabled,
        },
        {
            id: 'delete',
            title: t('sessionsList.deleteFolder'),
            icon: <Ionicons name="trash-outline" size={16} color={iconColor} />,
            disabled: props.disabled,
        },
    ], [iconColor, props.disabled]);
    const handleMenuSelect = React.useCallback(async (itemId: string) => {
        if (props.disabled) return;
        if (itemId === 'new-session') {
            props.onNewSession();
        } else if (itemId === 'add-subfolder') {
            await props.onAddSubfolder();
        } else if (itemId === 'rename') {
            await props.onRename();
        } else if (itemId === 'delete') {
            await props.onDelete();
        }
    }, [props]);
    const headerTestId = `session-folder-header-${props.item.folderId ?? props.title}`;
    return (
        <View
            ref={dropRegistration.ref}
            style={styles.folderHeaderSection}
            onLayout={dropRegistration.onLayout}
            onPointerEnter={isWeb ? () => setIsHovered(true) : undefined}
            onPointerLeave={isWeb ? () => setIsHovered(false) : undefined}
        >
            <View
                testID={headerTestId}
                style={[
                    styles.folderHeaderRow,
                    { paddingLeft: indentation },
                    isActiveDropTarget ? styles.dropTargetActive : null,
                ]}
            >
                <Pressable
                    testID={`session-folder-collapse-${props.item.folderId ?? props.title}`}
                    style={styles.groupHeaderActionButton}
                    onPress={(event) => {
                        stopPressEventPropagation(event);
                        props.onToggleCollapse();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={props.collapsed ? t('common.expand') : t('common.collapse')}
                    hitSlop={8}
                >
                    <Ionicons
                        name={props.collapsed ? 'chevron-forward' : 'chevron-down'}
                        size={12}
                        color={iconColor}
                    />
                </Pressable>
                <Pressable
                    testID={`${headerTestId}-focus`}
                    style={styles.headerLabelRow}
                    onPress={props.disabled ? undefined : props.onPress}
                    accessibilityRole="button"
                    accessibilityLabel={props.title}
                    disabled={props.disabled}
                >
                    <Ionicons name="folder-outline" size={14} color={iconColor} />
                    <Eyebrow style={styles.groupHeaderTitle} numberOfLines={1}>{props.title}</Eyebrow>
                </Pressable>
                <View
                    testID={`session-folder-reorder-handle-${props.item.folderId ?? props.title}`}
                    style={[
                        styles.groupHeaderActionButton,
                        showActions ? styles.webHoverVisibleChevron : styles.webHoverHiddenChevron,
                    ]}
                    pointerEvents="none"
                >
                    <Ionicons
                        name="reorder-three-outline"
                        size={14}
                        color={iconColor}
                        style={[
                            styles.folderHeaderDragHandleIcon,
                            showActions ? styles.folderHeaderDragHandleIconActive : null,
                        ]}
                    />
                </View>
                <View
                    onPointerEnter={isWeb ? () => setIsActionsHovered(true) : undefined}
                    onPointerLeave={isWeb ? () => setIsActionsHovered(false) : undefined}
                >
                    <DropdownMenu
                        open={menuOpen}
                        onOpenChange={setMenuOpen}
                        items={menuItems}
                        onSelect={handleMenuSelect}
                        placement="left"
                        variant="slim"
                        matchTriggerWidth={false}
                        maxWidthCap={240}
                        showCategoryTitles={false}
                        popoverPortalWebTarget="body"
                        trigger={({ toggle }) => (
                            <Pressable
                                testID={`session-folder-menu-trigger-${props.item.folderId ?? props.title}`}
                                style={[
                                    styles.groupHeaderActionButton,
                                    isWeb && !showActions ? styles.webHoverHiddenChevron : styles.webHoverVisibleChevron,
                                ]}
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
                                <Octicons name="kebab-horizontal" size={12} color={iconColor} />
                            </Pressable>
                        )}
                    />
                </View>
            </View>
        </View>
    );
});
