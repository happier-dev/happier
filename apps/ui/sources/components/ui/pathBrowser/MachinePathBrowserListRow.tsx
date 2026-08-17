import * as React from 'react';
import { Platform, Pressable, View, type GestureResponderEvent } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { FilesystemBrowserRow } from '@/components/ui/filesystemBrowser/FilesystemBrowserRow';
import type { FilesystemBrowserNode } from '@/components/ui/filesystemBrowser/filesystemBrowserTypes';
import { t } from '@/text';

import { getPathBrowserRowTestId, getPathBrowserToggleTestId } from './pathBrowserTestIds';
import { Icon } from '@/components/ui/icons/Icon';

type MachinePathBrowserListRowProps = Readonly<{
    node: FilesystemBrowserNode;
    showDivider: boolean;
    selected: boolean;
    selectionMode: 'directory' | 'file';
    interaction: 'confirm' | 'immediate';
    enableContextMenu: boolean;
    enableRowLongPressContextMenu: boolean;
    onToggleDirectory: (path: string) => void;
    onOpenContextMenu: (directoryPath: string, anchorNode: View | null) => void;
    onRetryDirectory: (directoryPath: string) => void;
    onSelectPath: (path: string) => void;
    onPickPathImmediately: (path: string) => void;
}>;

function stopToggleEventPropagation(event: unknown): void {
    const maybeEvent = event as {
        stopPropagation?: () => void;
        nativeEvent?: { stopPropagation?: () => void };
    };
    try {
        maybeEvent.stopPropagation?.();
    } catch {}
    try {
        maybeEvent.nativeEvent?.stopPropagation?.();
    } catch {}
}

export const MachinePathBrowserListRow = React.memo(function MachinePathBrowserListRow(
    props: MachinePathBrowserListRowProps,
): React.ReactElement {
    const { theme } = useUnistyles();
    const rowBasePaddingLeft = 36;
    const rowDepthIndent = 12;
    const toggleButtonSize = 16;
    const toggleButtonOffsetLeft = 20;
    const rowPaddingLeft = rowBasePaddingLeft + Math.min(6, Math.max(0, props.node.depth)) * rowDepthIndent;
    const contextMenuRowAnchorRef = React.useRef<View | null>(null);

    const handleTogglePress = React.useCallback((event?: GestureResponderEvent) => {
        stopToggleEventPropagation(event);
        props.onToggleDirectory(props.node.path);
    }, [props, props.node.path]);

    const handleOpenContextMenu = React.useCallback((event?: unknown) => {
        stopToggleEventPropagation(event);
        const maybeEvent = event as { preventDefault?: () => void; stopPropagation?: () => void };
        maybeEvent.preventDefault?.();
        maybeEvent.stopPropagation?.();
        props.onOpenContextMenu(props.node.path, contextMenuRowAnchorRef.current);
    }, [props, props.node.path]);

    const handleRowLongPress = React.useCallback(() => {
        props.onOpenContextMenu(props.node.path, contextMenuRowAnchorRef.current);
    }, [props, props.node.path]);

    const rightElement = props.selected
        ? <Icon name="check-circle" size={16} color={theme.colors.button.primary.background} />
        : undefined;

    const icon = props.node.type === 'directory'
        ? (
            <View style={{ width: 18, height: 18, alignItems: 'center', justifyContent: 'center' }}>
                <Icon
                    name={props.node.isExpanded ? 'folder-open' : 'folder'}
                    size={16}
                    color={theme.colors.text.link}
                />
            </View>
        )
        : props.node.type === 'file'
            ? <Icon name="file" size={16} color={theme.colors.text.link} />
            : <Icon name="folder" size={16} color={theme.colors.text.link} />;

    return (
        <FilesystemBrowserRow
            node={props.node}
            title={
                props.node.type === 'info' && props.node.infoKind === 'truncated'
                    ? t('newSession.pathPicker.truncatedDirectoryInfo', { count: props.node.entryCount ?? 0 })
                    : props.node.name || props.node.path
            }
            subtitle={props.node.type === 'error' ? props.node.errorMessage : undefined}
            icon={icon}
            testID={getPathBrowserRowTestId(props.node.path)}
            selected={props.selected}
            rightElement={rightElement}
            onContextMenu={props.node.type === 'directory' && props.enableContextMenu ? handleOpenContextMenu : undefined}
            onLongPress={
                props.node.type === 'directory' && props.enableRowLongPressContextMenu
                    ? handleRowLongPress
                    : undefined
            }
            showDivider={props.showDivider}
            basePaddingLeft={rowBasePaddingLeft}
            depthIndent={rowDepthIndent}
            density="tight"
            errorTitle={t('errors.tryAgain')}
            errorSubtitle={props.node.errorMessage}
            onRetryError={(errorNode) => {
                if (errorNode.parentDirectoryPath) {
                    props.onRetryDirectory(errorNode.parentDirectoryPath);
                }
            }}
            onPress={() => {
                if (props.node.type === 'directory') {
                    if (props.selectionMode === 'file') {
                        props.onToggleDirectory(props.node.path);
                        return;
                    }
                    if (props.interaction === 'immediate') {
                        props.onPickPathImmediately(props.node.path);
                        return;
                    }
                    props.onSelectPath(props.node.path);
                    return;
                }
                if (props.node.type === 'file') {
                    if (props.selectionMode !== 'file') return;
                    if (props.interaction === 'immediate') {
                        props.onPickPathImmediately(props.node.path);
                        return;
                    }
                    props.onSelectPath(props.node.path);
                }
            }}
            wrapContent={({ content }) => (
                <View collapsable={false}>
                    {props.node.type === 'directory' ? (
                        <View
                            pointerEvents="box-none"
                            style={{
                                position: 'absolute',
                                left: rowPaddingLeft - toggleButtonOffsetLeft,
                                top: 0,
                                bottom: 0,
                                width: toggleButtonSize,
                                alignItems: 'center',
                                justifyContent: 'center',
                                zIndex: 2,
                            }}
                        >
                            <Pressable
                                testID={getPathBrowserToggleTestId(props.node.path)}
                                {...(Platform.OS === 'web'
                                    ? ({ onMouseDownCapture: stopToggleEventPropagation } as any)
                                    : {})}
                                onPressIn={stopToggleEventPropagation}
                                onPress={handleTogglePress}
                                hitSlop={10}
                                style={{
                                    width: toggleButtonSize,
                                    height: toggleButtonSize,
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                }}
                            >
                                <Icon
                                    name={props.node.isExpanded ? 'caret-down' : 'caret-right'}
                                    size={16}
                                    color={theme.colors.text.secondary}
                                />
                            </Pressable>
                        </View>
                    ) : null}
                    <View
                        ref={contextMenuRowAnchorRef}
                        collapsable={false}
                        pointerEvents="none"
                        style={{
                            position: 'absolute',
                            left: rowPaddingLeft,
                            top: 0,
                            bottom: 0,
                            width: 1,
                        }}
                    />
                    {content}
                </View>
            )}
        />
    );
});
