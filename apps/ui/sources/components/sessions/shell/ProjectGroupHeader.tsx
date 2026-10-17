import React from 'react';
import { Platform, Pressable, View, type ViewStyle } from 'react-native';
import { Image } from 'expo-image';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { GestureDetector } from 'react-native-gesture-handler';
import type { UseSessionInlineDragResult } from './useSessionInlineDrag';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { SessionListViewItem } from '@/sync/domains/state/storage';
import { t } from '@/text';
import { useWorkspaceFavicon } from './useWorkspaceFavicon';
import { Icon } from '@/components/ui/icons/Icon';

const WORKSPACE_FAVICON_SIZE = 16;
const WORKSPACE_FAVICON_RADIUS = 4;
const workspaceFaviconImageStyle = {
    width: WORKSPACE_FAVICON_SIZE,
    height: WORKSPACE_FAVICON_SIZE,
    borderRadius: WORKSPACE_FAVICON_RADIUS,
};

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
    dragHandle: {
        opacity: 0.72,
    },
    dragHandleActive: {
        opacity: 1,
    },
}));

export const ProjectGroupHeader = React.memo(function ProjectGroupHeader(props: Readonly<{
    item: Extract<SessionListViewItem, { type: 'header' }>;
    hasMultipleMachines: boolean;
    workspaceLabelsV1: Record<string, string>;
    workspaceFaviconsEnabled?: boolean;
    workspaceMachineSubtitlesEnabled?: boolean;
    dragHandleGesture?: UseSessionInlineDragResult['gesture'];
    onRenameWorkspace: (workspaceKey: string, currentLabel: string) => void;
    onResetWorkspaceName: (workspaceKey: string) => void;
    onCreateSession: () => void;
    onAddFolder: () => void | Promise<void>;
    collapsed: boolean;
    onToggleCollapse: () => void;
    headerTestId: string;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const {
        item,
        hasMultipleMachines,
        workspaceLabelsV1,
        workspaceFaviconsEnabled = false,
        workspaceMachineSubtitlesEnabled = true,
        onRenameWorkspace,
        onResetWorkspaceName,
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
    const customLabel = workspaceKey ? workspaceLabelsV1[workspaceKey] : undefined;
    const displayTitle = customLabel || item.title;
    const hasCustomLabel = Boolean(customLabel);
    const shouldUseStartEllipsis = !hasCustomLabel && isWeb;
    const nativeEllipsizeMode = !isWeb && !hasCustomLabel ? 'head' : 'tail';
    const actionIconColor = theme.colors.text.secondary;
    const canCreateSession = typeof onCreateSession === 'function' && Boolean(item.workspaceScopeHint);
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
                disabled: !canCreateSession,
            },
            {
                id: 'rename',
                title: t('sessionsList.renameWorkspace'),
                icon: <Icon name="pencil" size={16} color={actionIconColor} />,
            },
        ];
        if (hasCustomLabel) {
            items.push({
                id: 'reset',
                title: t('sessionsList.resetWorkspaceName'),
                icon: <Icon name="arrow-clockwise" size={16} color={actionIconColor} />,
            });
        }
        return items;
    }, [hasCustomLabel, actionIconColor, canCreateSession]);

    const handleMenuSelect = React.useCallback(async (itemId: string) => {
        if (itemId === 'add-folder') {
            await onAddFolder();
        } else if (itemId === 'rename') {
            onRenameWorkspace(workspaceKey, displayTitle);
        } else if (itemId === 'reset') {
            onResetWorkspaceName(workspaceKey);
        }
    }, [workspaceKey, displayTitle, onAddFolder, onRenameWorkspace, onResetWorkspaceName]);

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
                    {showHoverActions && reorderHandleKey ? (
                        props.dragHandleGesture ? (
                            <GestureDetector gesture={props.dragHandleGesture}>
                                <View
                                    style={[styles.actionButton, isWeb && ({ cursor: 'move' } as unknown as ViewStyle)]}
                                    testID={`session-workspace-reorder-handle:${reorderHandleKey}`}
                                    onPointerEnter={isWeb ? () => setIsActionsHovered(true) : undefined}
                                    onPointerLeave={isWeb ? () => setIsActionsHovered(false) : undefined}
                                >
                                    <Icon name="list" size={14} color={actionIconColor} />
                                </View>
                            </GestureDetector>
                        ) : null
                    ) : null}
                    {showHoverActions && workspaceKey ? (
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
