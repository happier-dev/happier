import React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { GestureDetector } from 'react-native-gesture-handler';
import type { UseSessionInlineDragResult } from './useSessionInlineDrag';

import { DropdownMenu, type DropdownMenuItem } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { SessionFolderHeaderItem } from './sessionFolderShellTypes';
import { Icon } from '@/components/ui/icons/Icon';

const FOLDER_ROOT_INDENT = 20;
const FOLDER_NESTED_INDENT_STEP = 12;
const FOLDER_INDENT_CAP = 3;

const webReorderHandleStyle = { width: 24, height: 24 };

const stylesheet = StyleSheet.create((theme) => ({
    section: {
        backgroundColor: theme.colors.background.canvas,
        paddingHorizontal: 10,
        paddingTop: 0,
        paddingBottom: 0,
    },
    row: {
        minHeight: 22,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderRadius: 8,
        alignSelf: 'stretch',
    },
    content: {
        flex: 1,
        minWidth: 0,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
    },
    title: {
        flex: 1,
        minWidth: 0,
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
    },
    actionButton: {
        width: 18,
        height: 20,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 999,
    },
    hidden: {
        opacity: 0,
    },
    visible: {
        opacity: 1,
    },
}));

export function FolderGroupHeader(props: Readonly<{
    item: SessionFolderHeaderItem;
    collapsed: boolean;
    dragHandleGesture?: UseSessionInlineDragResult['gesture'];
    onToggleCollapse: () => void;
    onFocus: () => void;
    onNewSession: () => void;
    onAddSubfolder: () => void | Promise<void>;
    onRename: () => void | Promise<void>;
    onDelete: () => void | Promise<void>;
    onMove?: () => void;
    onMoveDown?: () => void;
    onMoveToWorkspaceRoot?: () => void;
    onMoveUp?: () => void;
    disabled?: boolean;
}>) {
    const styles = stylesheet;
    const { theme } = useUnistyles();
    const [hovered, setHovered] = React.useState(false);
    const [actionsHovered, setActionsHovered] = React.useState(false);
    const [menuOpen, setMenuOpen] = React.useState(false);
    const isWeb = Platform.OS === 'web';
    const showActions = !isWeb || hovered || actionsHovered || menuOpen;
    const iconColor = props.disabled ? theme.colors.text.tertiary : theme.colors.text.secondary;
    const normalizedDepth = Math.min(Math.max(0, Math.trunc(props.item.depth)), FOLDER_INDENT_CAP);
    const indent = FOLDER_ROOT_INDENT + normalizedDepth * FOLDER_NESTED_INDENT_STEP;

    const menuItems = React.useMemo((): DropdownMenuItem[] => [
        {
            id: 'new-session',
            title: t('sessionsList.newSessionInFolder'),
            icon: <Icon name="plus-circle" size={16} color={iconColor} />,
            disabled: props.disabled,
        },
        {
            id: 'add-subfolder',
            title: t('sessionsList.addSubfolder'),
            icon: <Icon name="folder-open" size={16} color={iconColor} />,
            disabled: props.disabled,
        },
        {
            id: 'rename',
            title: t('sessionsList.renameFolder'),
            icon: <Icon name="pencil" size={16} color={iconColor} />,
            disabled: props.disabled,
        },
        ...(props.onMoveUp ? [{ id: 'move-up', title: t('common.moveUp'), disabled: props.disabled }] : []),
        ...(props.onMoveDown ? [{ id: 'move-down', title: t('common.moveDown'), disabled: props.disabled }] : []),
        {
            id: 'move',
            title: t('sessionsList.moveFolder'),
            icon: <Icon name="arrow-circle-right" size={16} color={iconColor} />,
            disabled: props.disabled || !props.onMove,
        },
        {
            id: 'delete',
            title: t('sessionsList.deleteFolder'),
            icon: <Icon name="trash" size={16} color={iconColor} />,
            disabled: props.disabled,
        },
    ], [iconColor, props.disabled, props.onMove, props.onMoveUp, props.onMoveDown]);

    const handleMenuSelect = React.useCallback(async (itemId: string) => {
        if (props.disabled) return;
        if (itemId === 'new-session') {
            props.onNewSession();
        } else if (itemId === 'add-subfolder') {
            await props.onAddSubfolder();
        } else if (itemId === 'rename') {
            await props.onRename();
        } else if (itemId === 'move-up') {
            props.onMoveUp?.();
        } else if (itemId === 'move-down') {
            props.onMoveDown?.();
        } else if (itemId === 'move') {
            props.onMove?.();
        } else if (itemId === 'delete') {
            await props.onDelete();
        }
    }, [props]);

    const accessibilityActions = React.useMemo(() => {
        const actions: Array<{ name: string; label: string }> = [];
        if (props.onMoveUp) actions.push({ name: 'moveUp', label: t('common.moveUp') });
        if (props.onMoveDown) actions.push({ name: 'moveDown', label: t('common.moveDown') });
        if (props.onMove) actions.push({ name: 'moveToFolder', label: t('sessionsList.moveToFolder') });
        if (props.onMoveToWorkspaceRoot) actions.push({ name: 'moveToWorkspaceRoot', label: t('sessionsList.moveToWorkspaceRoot') });
        return actions;
    }, [props.onMove, props.onMoveDown, props.onMoveToWorkspaceRoot, props.onMoveUp]);

    const handleAccessibilityAction = React.useCallback((event: { nativeEvent?: { actionName?: string } }) => {
        switch (event.nativeEvent?.actionName) {
            case 'moveUp':
                props.onMoveUp?.();
                break;
            case 'moveDown':
                props.onMoveDown?.();
                break;
            case 'moveToFolder':
                props.onMove?.();
                break;
            case 'moveToWorkspaceRoot':
                props.onMoveToWorkspaceRoot?.();
                break;
        }
    }, [props]);

    return (
        <View style={styles.section}>
            <View
                style={[styles.row, { paddingLeft: indent }]}
                onPointerEnter={isWeb ? () => setHovered(true) : undefined}
                onPointerLeave={isWeb ? () => setHovered(false) : undefined}
            >
                <Pressable
                    style={styles.actionButton}
                    onPress={(event) => {
                        event?.stopPropagation?.();
                        props.onToggleCollapse();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={props.collapsed ? t('common.expand') : t('common.collapse')}
                    hitSlop={8}
                >
                    <Icon
                        name={props.collapsed ? 'caret-right' : 'caret-down'}
                        size={14}
                        color={iconColor}
                    />
                </Pressable>
                <Pressable
                    testID={`session-folder-header-${props.item.folderId}`}
                    style={styles.content}
                    accessibilityActions={accessibilityActions}
                    accessibilityRole="button"
                    accessibilityLabel={props.item.title}
                    onAccessibilityAction={accessibilityActions.length > 0 ? handleAccessibilityAction : undefined}
                    disabled={props.disabled}
                    onPress={props.disabled ? undefined : props.onFocus}
                >
                    <Icon name="folder" size={14} color={iconColor} />
                    <Text style={styles.title} numberOfLines={1}>{props.item.title}</Text>
                </Pressable>
                {props.dragHandleGesture ? (
                    <GestureDetector gesture={props.dragHandleGesture}>
                        <View
                            style={[styles.actionButton, webReorderHandleStyle]}
                            testID={`session-folder-reorder-handle-${props.item.folderId}`}
                            accessible={false}
                        >
                            <Icon name="list" size={14} color={iconColor} />
                        </View>
                    </GestureDetector>
                ) : (
                    <View
                        style={[styles.actionButton, showActions ? styles.visible : styles.hidden]}
                        testID={`session-folder-reorder-handle-${props.item.folderId}`}
                        pointerEvents="none"
                    >
                        <Icon name="list" size={14} color={iconColor} />
                    </View>
                )}
                <View
                    onPointerEnter={isWeb ? () => setActionsHovered(true) : undefined}
                    onPointerLeave={isWeb ? () => setActionsHovered(false) : undefined}
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
                                testID={`session-folder-menu-trigger-${props.item.folderId}`}
                                style={[styles.actionButton, props.dragHandleGesture || showActions ? styles.visible : styles.hidden]}
                                onPress={(event) => {
                                    event?.stopPropagation?.();
                                    toggle();
                                }}
                                onHoverIn={isWeb ? () => setActionsHovered(true) : undefined}
                                onHoverOut={isWeb ? () => setActionsHovered(false) : undefined}
                                accessibilityRole="button"
                                accessibilityLabel={t('common.moreActions')}
                                hitSlop={8}
                            >
                                <Icon name="dots-three" size={14} color={iconColor} />
                            </Pressable>
                        )}
                    />
                </View>
            </View>
        </View>
    );
}
