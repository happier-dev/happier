import * as React from 'react';
import { View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
import { resolveHappierTreeRowIndentPx } from '@happier-dev/plugin-ui/presentation';

import { FilesystemBrowserRow } from '@/components/ui/filesystemBrowser/FilesystemBrowserRow';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import type { FilesystemBrowserNode } from '@/components/ui/filesystemBrowser/filesystemBrowserTypes';
import { useFilesystemTreeRowActive, type FilesystemTreeActivePath, type FilesystemTreeKeyboardNode, type FilesystemTreeRowProps } from '@/components/ui/filesystemBrowser/useFilesystemTreeKeyboard';
import { t } from '@/text';

import { getPathBrowserRowTestId, getPathBrowserToggleTestId } from './pathBrowserTestIds';
import { Icon } from '@/components/ui/icons/Icon';

type MachinePathBrowserListRowProps = Readonly<{
    node: FilesystemBrowserNode;
    showDivider: boolean;
    selected: boolean;
    enableContextMenu: boolean;
    enableRowLongPressContextMenu: boolean;
    onToggleDirectory: (path: string) => void;
    onOpenContextMenu: (directoryPath: string, anchorNode: View | null) => void;
    onContextMenuAnchorChange?: (path: string, anchorNode: View | null) => void;
    onRetryDirectory: (directoryPath: string) => void;
    onActivatePath: (path: string) => void;
    getTreeRowProps: (node: FilesystemTreeKeyboardNode, active: boolean, onDisclosure?: () => void) => FilesystemTreeRowProps;
    /** The tree's tab stop, read per row (`useFilesystemTreeKeyboard().activePath`). */
    treeActivePath: FilesystemTreeActivePath;
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
    // The context-menu anchor sits where the shared tree row starts this node's content.
    const rowPaddingLeft = resolveHappierTreeRowIndentPx(props.node.depth);
    const contextMenuRowAnchorRef = React.useRef<View | null>(null);
    const { onContextMenuAnchorChange } = props;
    const contextMenuPath = props.node.path;
    const setContextMenuRowAnchor = React.useCallback((anchor: View | null) => {
        contextMenuRowAnchorRef.current = anchor;
        onContextMenuAnchorChange?.(contextMenuPath, anchor);
    }, [contextMenuPath, onContextMenuAnchorChange]);
    const { getTreeRowProps, node, onToggleDirectory } = props;
    const active = useFilesystemTreeRowActive(props.treeActivePath, node.path);
    const treeItemProps = React.useMemo(() => getTreeRowProps(node, active,
        node.type === 'directory' ? () => onToggleDirectory(node.path) : undefined),
    [getTreeRowProps, node, active, onToggleDirectory]);

    const handleTogglePress = React.useCallback(() => {
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

    const loadingChildren = props.node.type === 'directory' && props.node.isExpanded && props.node.isLoadingChildren;
    const rightElement = loadingChildren || props.selected ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.space.s4 }}>
            {loadingChildren ? <ActivitySpinner testID={`${getPathBrowserRowTestId(props.node.path)}-loading`}
                size={16} color={theme.colors.text.secondary} /> : null}
            {props.selected ? <Icon name="check-circle" size={16} color={theme.colors.button.primary.background} /> : null}
        </View>
    ) : undefined;

    // Glyphs stay ink; colour is for state (the selected check keeps the accent).
    const icon = props.node.type === 'directory'
        ? (
            <View style={{ width: 18, height: 18, alignItems: 'center', justifyContent: 'center' }}>
                <Icon
                    name={props.node.isExpanded ? 'folder-open' : 'folder'}
                    size={16}
                    color={theme.colors.text.secondary}
                />
            </View>
        )
        : props.node.type === 'file'
            ? <Icon name="file" size={16} color={theme.colors.text.secondary} />
            : <Icon name="folder" size={16} color={theme.colors.text.secondary} />;

    return (
        <FilesystemBrowserRow
            treeItemProps={treeItemProps}
            node={props.node}
            title={
                props.node.type === 'info' && props.node.infoKind === 'truncated'
                    ? t('newSession.pathPicker.truncatedDirectoryInfo', { count: props.node.entryCount ?? 0 })
                    : props.node.name || props.node.path
            }
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
            // Folders disclose through the shared tree row (indent, chevron, hover, focus, density), so the
            // picker's tree reads like every other tree; the toggle keeps its published test id.
            disclosure
            onDisclosurePress={props.node.type === 'directory' ? handleTogglePress : undefined}
            disclosureTestID={props.node.type === 'directory' ? getPathBrowserToggleTestId(props.node.path) : undefined}
            onRetryError={(errorNode) => {
                if (errorNode.parentDirectoryPath) {
                    props.onRetryDirectory(errorNode.parentDirectoryPath);
                }
            }}
            onPress={() => props.onActivatePath(props.node.path)}
            wrapContent={({ content }) => (
                <View collapsable={false}>
                    <View
                        ref={setContextMenuRowAnchor}
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
