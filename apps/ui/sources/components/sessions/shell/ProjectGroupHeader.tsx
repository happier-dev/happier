import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { GestureDetector } from 'react-native-gesture-handler';
import type { UseSessionInlineDragResult } from './useSessionInlineDrag';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { SessionListViewItem } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { Modal } from '@/modal';
import { useWorkspaceFavicon } from './useWorkspaceFavicon';
import { Icon } from '@/components/ui/icons/Icon';
import { useCustomSessionAppearanceColors } from '@/hooks/session/useSessionAppearance';
import { resolveSessionAppearanceColor, type SessionAppearanceColor } from '@/sync/domains/session/organization/appearanceColor';
import {
    buildSessionAppearanceColorMenuItem,
    resolveSessionAppearanceColorMenuChoice,
} from './appearance/sessionAppearanceColorMenu';

const WORKSPACE_COLOR_MENU_ID = 'workspace-color';
const WORKSPACE_COLOR_DOT_SIZE = 8;

const WORKSPACE_FAVICON_SIZE = 16;
const WORKSPACE_FAVICON_RADIUS = 4;
const workspaceFaviconImageStyle = {
    width: WORKSPACE_FAVICON_SIZE,
    height: WORKSPACE_FAVICON_SIZE,
    borderRadius: WORKSPACE_FAVICON_RADIUS,
};

const webReorderHandleStyle = { width: 24, height: 24 };

const stylesheet = StyleSheet.create((theme) => ({
    section: {
        backgroundColor: theme.colors.background.canvas,
        paddingHorizontal: 24,
        paddingTop: 10,
        paddingBottom: 5,
    },
    row: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        justifyContent: 'space-between' as const,
        borderRadius: 8,
        borderWidth: 1,
        borderColor: 'transparent',
    },
    titleRow: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 6,
        flex: 1,
        minWidth: 0,
    },
    title: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text.secondary,
        flexShrink: 1,
        ...Typography.default('semiBold'),
    },
    pathTitleWeb: {
        writingDirection: 'rtl' as const,
        textAlign: 'left' as const,
    },
    pathTitleTextWeb: {
        writingDirection: 'ltr' as const,
        unicodeBidi: 'isolate' as const,
    },
    subtitle: {
        fontSize: 11,
        color: theme.colors.text.secondary,
        marginTop: 2,
        ...Typography.default(),
    },
    colorDot: {
        width: WORKSPACE_COLOR_DOT_SIZE,
        height: WORKSPACE_COLOR_DOT_SIZE,
        borderRadius: WORKSPACE_COLOR_DOT_SIZE / 2,
        flexShrink: 0,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
    },
    faviconFrame: {
        width: WORKSPACE_FAVICON_SIZE,
        minWidth: WORKSPACE_FAVICON_SIZE,
        maxWidth: WORKSPACE_FAVICON_SIZE,
        height: WORKSPACE_FAVICON_SIZE,
        minHeight: WORKSPACE_FAVICON_SIZE,
        maxHeight: WORKSPACE_FAVICON_SIZE,
        flexShrink: 0,
        borderRadius: WORKSPACE_FAVICON_RADIUS,
        backgroundColor: theme.colors.surface.base,
        overflow: 'hidden' as const,
    },
    content: {
        flex: 1,
        minWidth: 0,
    },
    inlineActions: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        gap: 2,
        flexShrink: 0,
    },
    trailingActions: {
        flexDirection: 'row' as const,
        alignItems: 'center' as const,
        flexShrink: 0,
        marginLeft: 8,
    },
    actionButton: {
        width: 18,
        height: 14,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        borderRadius: 999,
        marginLeft: 4,
    },
    chevron: {
        width: 16,
        alignItems: 'center' as const,
        justifyContent: 'center' as const,
        color: theme.colors.text.secondary,
    },
    hoverHiddenChevron: {
        opacity: 0,
    },
    hoverVisibleChevron: {
        opacity: 1,
    },
}));

export const ProjectGroupHeader = React.memo(function ProjectGroupHeader(props: Readonly<{
    item: Extract<SessionListViewItem, { type: 'header' }>;
    hasMultipleMachines: boolean;
    workspaceFaviconsEnabled?: boolean;
    workspaceMachineSubtitlesEnabled?: boolean;
    dragHandleGesture?: UseSessionInlineDragResult['gesture'];
    onMoveUp?: () => void;
    onMoveDown?: () => void;
    onRenameWorkspace: (workspaceKey: string, currentLabel: string) => void;
    onResetWorkspaceName: (workspaceKey: string) => void;
    /** The list's canonical workspace-colour writer; sessions in the project inherit this colour. */
    onSetWorkspaceColor?: (workspaceKey: string, color: SessionAppearanceColor | null, opts?: Readonly<{ serverId?: string | null }>) => void;
    onCreateSession: () => void;
    onAddFolder?: () => void | Promise<void>;
    collapsed: boolean;
    onToggleCollapse: () => void;
    headerTestId: string;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const {
        item,
        hasMultipleMachines,
        workspaceFaviconsEnabled = false,
        workspaceMachineSubtitlesEnabled = true,
        onRenameWorkspace,
        onResetWorkspaceName,
        onSetWorkspaceColor,
        onCreateSession,
        onAddFolder,
        collapsed,
        onToggleCollapse,
        headerTestId,
    } = props;
    const [isRowHovered, setIsRowHovered] = React.useState(false);
    const [isActionsHovered, setIsActionsHovered] = React.useState(false);
    const [menuOpen, setMenuOpen] = React.useState(false);
    const isWeb = Platform.OS === 'web';
    const showHoverActions = !isWeb || isRowHovered || isActionsHovered || menuOpen;
    const showChevron = !isWeb || collapsed || showHoverActions;
    const workspaceKey = item.workspaceKey ?? '';
    const reorderHandleKey = item.groupKey ?? workspaceKey;
    const customLabel = item.workspaceLabel;
    const displayTitle = customLabel || item.title;
    const hasCustomLabel = Boolean(customLabel);
    const shouldUseStartEllipsis = !hasCustomLabel && isWeb;
    const nativeEllipsizeMode = !isWeb && !hasCustomLabel ? 'head' : 'tail';
    const actionIconColor = theme.colors.text.secondary;
    const canCreateSession = typeof onCreateSession === 'function' && Boolean(item.workspaceScopeHint);
    const canAddFolder = typeof onAddFolder === 'function';
    const workspaceServerId = item.workspaceScopeHint?.serverId ?? item.serverId ?? null;
    const canSetColor = typeof onSetWorkspaceColor === 'function' && Boolean(workspaceKey);
    const workspaceColor = item.appearanceColor ?? null;
    const colorDotPaint = resolveSessionAppearanceColor(workspaceColor, theme);
    // Colours in use are detail data: read only while this header's menu is open.
    const customColors = useCustomSessionAppearanceColors(workspaceServerId, { enabled: menuOpen && canSetColor });
    const [customColorPickerLoading, setCustomColorPickerLoading] = React.useState(false);
    const favicon = useWorkspaceFavicon({
        enabled: workspaceFaviconsEnabled,
        serverId: item.workspaceScopeHint?.serverId ?? item.serverId ?? null,
        machineId: item.workspaceScopeHint?.machineId ?? null,
        workspacePath: item.workspaceScopeHint?.rootPath ?? null,
    });

    const menuItems = React.useMemo((): DropdownMenuItem[] => {
        const items: DropdownMenuItem[] = [
            {
                id: 'add-folder',
                title: t('sessionsList.addFolder'),
                icon: <Icon name="folder-open" size={16} color={actionIconColor} />,
                disabled: !canAddFolder,
            },
            {
                id: 'rename',
                title: t('sessionsList.renameWorkspace'),
                icon: <Icon name="pencil" size={16} color={actionIconColor} />,
            },
        ];
        if (canSetColor) {
            items.push(buildSessionAppearanceColorMenuItem({
                menuId: WORKSPACE_COLOR_MENU_ID,
                iconColor: actionIconColor,
                current: workspaceColor,
                customColors,
                theme,
                customPickerLoading: customColorPickerLoading,
            }));
        }
        if (props.onMoveUp) items.push({ id: 'move-up', title: t('common.moveUp') });
        if (props.onMoveDown) items.push({ id: 'move-down', title: t('common.moveDown') });
        if (hasCustomLabel) {
            items.push({
                id: 'reset',
                title: t('sessionsList.resetWorkspaceName'),
                icon: <Icon name="arrow-clockwise" size={16} color={actionIconColor} />,
            });
        }
        return items;
    }, [
        hasCustomLabel,
        actionIconColor,
        canAddFolder,
        canSetColor,
        customColorPickerLoading,
        customColors,
        props.onMoveUp,
        props.onMoveDown,
        theme,
        workspaceColor,
    ]);

    const handleMenuSelect = React.useCallback(async (itemId: string) => {
        if (canSetColor && itemId.startsWith(`${WORKSPACE_COLOR_MENU_ID}:`)) {
            try {
                const color = await resolveSessionAppearanceColorMenuChoice({
                    menuId: WORKSPACE_COLOR_MENU_ID,
                    itemId,
                    current: workspaceColor,
                    serverId: workspaceServerId,
                    onPickerLoading: setCustomColorPickerLoading,
                    closeMenus: () => setMenuOpen(false),
                });
                if (color !== undefined) onSetWorkspaceColor?.(workspaceKey, color, { serverId: workspaceServerId });
            } catch {
                Modal.alert(t('common.error'), t('errors.unknownError'));
            }
            return;
        }
        if (itemId === 'add-folder') {
            await onAddFolder?.();
        } else if (itemId === 'rename') {
            onRenameWorkspace(workspaceKey, displayTitle);
        } else if (itemId === 'move-up') {
            props.onMoveUp?.();
        } else if (itemId === 'move-down') {
            props.onMoveDown?.();
        } else if (itemId === 'reset') {
            onResetWorkspaceName(workspaceKey);
        }
    }, [
        canSetColor,
        workspaceColor,
        workspaceServerId,
        workspaceKey,
        displayTitle,
        onAddFolder,
        onRenameWorkspace,
        onResetWorkspaceName,
        onSetWorkspaceColor,
        props.onMoveUp,
        props.onMoveDown,
    ]);

    const chevronColor = theme.colors.text.secondary;
    return (
        <View style={styles.section}>
            <View
                style={styles.row}
                onPointerEnter={isWeb ? () => setIsRowHovered(true) : undefined}
                onPointerLeave={isWeb ? () => setIsRowHovered(false) : undefined}
            >
                <Pressable
                    style={styles.content}
                    onPress={onToggleCollapse}
                    testID={headerTestId}
                    accessibilityRole="button"
                    accessibilityLabel={displayTitle}
                    onHoverIn={isWeb ? () => setIsRowHovered(true) : undefined}
                    onHoverOut={isWeb ? () => setIsRowHovered(false) : undefined}
                >
                    <View style={styles.titleRow}>
                        {colorDotPaint ? (
                            <View
                                testID={`session-workspace-color:${workspaceKey}`}
                                accessible={false}
                                importantForAccessibility="no-hide-descendants"
                                style={[styles.colorDot, { backgroundColor: colorDotPaint }]}
                            />
                        ) : null}
                        {favicon ? (
                            <View testID="session-list-workspace-favicon" style={styles.faviconFrame}>
                                <Image
                                    source={{ uri: favicon.uri }}
                                    style={[workspaceFaviconImageStyle]}
                                    contentFit="cover"
                                    accessibilityIgnoresInvertColors
                                />
                            </View>
                        ) : null}
                        <Text
                            style={shouldUseStartEllipsis
                                ? [styles.title, styles.pathTitleWeb]
                                : styles.title}
                            numberOfLines={1}
                            ellipsizeMode={shouldUseStartEllipsis ? undefined : nativeEllipsizeMode}
                        >
                            {shouldUseStartEllipsis ? (
                                <Text style={styles.pathTitleTextWeb}>
                                    {displayTitle}
                                </Text>
                            ) : displayTitle}
                        </Text>
                        <View
                            style={styles.inlineActions}
                            onPointerEnter={isWeb ? () => setIsActionsHovered(true) : undefined}
                            onPointerLeave={isWeb ? () => setIsActionsHovered(false) : undefined}
                        >
                            <View
                                style={[
                                    styles.chevron,
                                    isWeb && !showChevron ? styles.hoverHiddenChevron : styles.hoverVisibleChevron,
                                ]}
                            >
                                <Icon
                                    name={collapsed ? 'caret-right' : 'caret-down'}
                                    size={14}
                                    color={chevronColor}
                                />
                            </View>
                        </View>
                    </View>
                    {workspaceMachineSubtitlesEnabled && hasMultipleMachines && item.subtitle ? (
                        <Text style={styles.subtitle}>{item.subtitle}</Text>
                    ) : null}
                </Pressable>
                <View style={styles.trailingActions}>
                    {reorderHandleKey && props.dragHandleGesture ? (
                        <GestureDetector gesture={props.dragHandleGesture}>
                            <View
                                style={[styles.actionButton, webReorderHandleStyle]}
                                testID={`session-workspace-reorder-handle:${reorderHandleKey}`}
                                accessible={false}
                            >
                                <Icon name="list" size={14} color={actionIconColor} />
                            </View>
                        </GestureDetector>
                    ) : showHoverActions && reorderHandleKey ? (
                        <Pressable
                            style={styles.actionButton}
                            testID={`session-workspace-reorder-handle:${reorderHandleKey}`}
                            accessible={false}
                            onPress={(event) => event?.stopPropagation?.()}
                            hitSlop={8}
                        >
                            <Icon name="list" size={14} color={actionIconColor} />
                        </Pressable>
                    ) : null}
                    {(showHoverActions || props.dragHandleGesture) && workspaceKey ? (
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
                                    testID={`session-workspace-menu-trigger:${reorderHandleKey}`}
                                    style={styles.actionButton}
                                    onPress={(event) => {
                                        (event as any)?.stopPropagation?.();
                                        toggle();
                                    }}
                                    onHoverIn={isWeb ? () => setIsActionsHovered(true) : undefined}
                                    onHoverOut={isWeb ? () => setIsActionsHovered(false) : undefined}
                                    accessibilityRole="button"
                                    accessibilityLabel={t('common.moreActions')}
                                    hitSlop={8}
                                >
                                    <Icon name="dots-three" size={14} color={actionIconColor} />
                                </Pressable>
                            )}
                        />
                    ) : null}
                    {canCreateSession ? (
                        <Pressable
                            style={styles.actionButton}
                            onPress={(event) => {
                                (event as any)?.stopPropagation?.();
                                onCreateSession();
                            }}
                            accessibilityRole="button"
                            accessibilityLabel={t('machine.launchNewSessionInDirectory')}
                            hitSlop={8}
                        >
                            <Icon name="plus" size={14} color={actionIconColor} />
                        </Pressable>
                    ) : null}
                </View>
            </View>
        </View>
    );
});
