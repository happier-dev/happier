import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item, type ItemProps } from '@/components/ui/lists/Item';
import { t } from '@/text';
import type { FilesystemBrowserNode, FilesystemBrowserWrapContentInput } from './filesystemBrowserTypes';
import { Icon } from '@/components/ui/icons/Icon';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveFilesystemErrorReason } from './filesystemErrorReason';
import { TREE_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';
import { isTouchPrimaryPointer } from '@/components/ui/interactiveTargetSize';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { SelectionCheckGlyph, type SelectionCheckState } from '@/components/ui/selection/SelectionCheckGlyph';

/** How a row hands its actions menu the reveal: open it (a long press) and whether its … is drawn. */
export type FilesystemBrowserRowActionsControl = Readonly<{
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** Touch: the menu opens from a long press only, so its … is not drawn. */
    triggerHidden: boolean;
}>;

/**
 * A row's leading checkbox, controlled by the consumer (the Git changed-files tree selects files for a
 * commit). It takes the entry icon's place, and pressing it toggles without opening the row.
 */
export type FilesystemBrowserRowSelection = Readonly<{
    state: SelectionCheckState;
    onToggle: () => void;
    accessibilityLabel: string;
    disabled?: boolean;
}>;

export type FilesystemBrowserRowProps = Readonly<{
    node: FilesystemBrowserNode;
    treeItemProps?: Pick<ItemProps, 'webRole' | 'webTabIndex' | 'accessibilityLevel' | 'webKeyShortcuts' | 'accessibilityExpanded' | 'pressableRef' | 'onFocus' | 'onKeyDown'>;
    title: string;
    titleAccessory?: React.ReactNode;
    subtitle?: React.ReactNode;
    icon: React.ReactNode;
    /** Tree rows: a disclosure chevron before the leading control (a spacer on files, so names align). */
    disclosure?: boolean;
    /** A controlled checkbox in place of `icon`. */
    selection?: FilesystemBrowserRowSelection;
    /** With `selection`: a mark after the checkbox, in the icon slot (the Git tree's status letter). */
    selectionMark?: React.ReactNode;
    rightElement?: React.ReactNode;
    /**
     * The row's actions menu (its …). Under a pointer it shows only while the row is hovered, focused
     * or selected (`rowActionsRevealed`), over the trailing marks so nothing reflows; under a finger
     * it is never drawn and a long press opens it.
     */
    rowActions?: ((control: FilesystemBrowserRowActionsControl) => React.ReactNode) | null;
    rowActionsRevealed?: boolean;
    onPress?: () => void;
    onDoublePress?: () => void;
    onLongPress?: () => void;
    onContextMenu?: (event: unknown) => void;
    selected?: boolean;
    testID?: string;
    density?: ItemProps['density'];
    showDivider?: boolean;
    basePaddingLeft?: number;
    depthIndent?: number;
    paddingRight?: number;
    style?: StyleProp<ViewStyle>;
    onRetryError?: (node: FilesystemBrowserNode) => void | Promise<void>;
    wrapContent?: ((input: FilesystemBrowserWrapContentInput) => React.ReactElement) | null;
}>;

const ROW_ACTIONS_OVERLAY_STYLE = { position: 'absolute', right: 0, top: 0, bottom: 0, justifyContent: 'center', borderRadius: 6 } as const;
const ROW_ACTIONS_HIDDEN_ANCHOR_STYLE = { position: 'absolute', right: 0, width: 0, height: 0, overflow: 'visible' } as const;

export function FilesystemBrowserRow(props: FilesystemBrowserRowProps): React.ReactElement {
    const { theme } = useUnistyles();
    const paddingLeft = (props.basePaddingLeft ?? TREE_ROW_METRICS.basePaddingPx)
        + Math.min(TREE_ROW_METRICS.maxIndentDepth, Math.max(0, props.node.depth)) * (props.depthIndent ?? TREE_ROW_METRICS.indentStepPx);
    const treeRowMinHeight = props.disclosure
        ? (isTouchPrimaryPointer() ? TREE_ROW_METRICS.minHeightPx.touch : TREE_ROW_METRICS.minHeightPx.precise)
        : undefined;
    const showDivider = props.showDivider === true;

    const errorNode = props.node;
    const touch = isTouchPrimaryPointer();
    const [hovered, setHovered] = React.useState(false);
    const [focused, setFocused] = React.useState(false);
    const [actionsOpen, setActionsOpen] = React.useState(false);
    const rowActions = props.rowActions ?? null;
    const actionsVisible = Boolean(rowActions) && (touch
        ? actionsOpen
        : hovered || focused || actionsOpen || props.rowActionsRevealed === true || props.selected === true);
    const treeItemOnFocus = props.treeItemProps?.onFocus;
    const onFocus = React.useCallback(() => {
        setFocused(true);
        treeItemOnFocus?.();
    }, [treeItemOnFocus]);
    const onBlur = React.useCallback(() => setFocused(false), []);
    const actionsNode = actionsVisible && rowActions
        ? rowActions({ open: actionsOpen, onOpenChange: setActionsOpen, triggerHidden: touch })
        : null;
    const rightElement = actionsNode
        ? (
            <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                {props.rightElement}
                {/* Over the trailing marks, never beside them: showing the … must not move the row. */}
                <View style={touch ? ROW_ACTIONS_HIDDEN_ANCHOR_STYLE : [ROW_ACTIONS_OVERLAY_STYLE, { backgroundColor: theme.colors.surface.pressed }]}>
                    {actionsNode}
                </View>
            </View>
        )
        : props.rightElement;
    const leading = props.disclosure || props.selection ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            {props.disclosure ? (
                props.node.type === 'directory'
                    ? <Icon name={props.node.isExpanded ? 'caret-down' : 'caret-right'} size={12} color={theme.colors.text.secondary} />
                    : <View style={{ width: 12 }} />
            ) : null}
            {props.selection ? (
                <IconButton
                    testID={props.testID ? `${props.testID}-select` : undefined}
                    variant="plain"
                    size={24}
                    accessibilityRole="checkbox"
                    checked={props.selection.state === 'checked'}
                    selectedBackground={false}
                    disabled={props.selection.disabled}
                    accessibilityLabel={props.selection.accessibilityLabel}
                    // Tree rows are always the compact rhythm: the 14 px checkbox (Git lab TV).
                    icon={<SelectionCheckGlyph state={props.selection.state} size="compact" />}
                    onPress={props.selection.onToggle}
                />
            ) : props.icon}
            {props.selection && props.selectionMark ? props.selectionMark : null}
        </View>
    ) : props.icon;
    const content = props.node.type === 'error'
        ? (
            // Pane-states lab 0 "N": a folder that could not be listed is one quiet line in the tree — what
            // failed, the cause, and an inline retry of that folder. The raw error stays on the QA channel.
            <View style={{ paddingLeft: Math.max(0, paddingLeft - (props.basePaddingLeft ?? 12)) }}>
                <SurfaceStateCard
                    testID={props.testID ? `${props.testID}-folder-error` : undefined}
                    size="line"
                    kind="error"
                    title={t('files.repositoryFolderLoadFailed')}
                    reason={resolveFilesystemErrorReason(errorNode.errorMessage)}
                    diagnosticCode={errorNode.errorMessage ?? null}
                    action={props.onRetryError
                        ? { label: t('surfaceState.tryAgain'), onPress: () => props.onRetryError!(errorNode) }
                        : undefined}
                />
            </View>
        )
        : props.node.type === 'info'
            ? (
                <Item
                    testID={props.testID}
                {...props.treeItemProps}
                    title={props.title}
                    subtitle={props.subtitle}
                    icon={<Icon name="info" size={16} color={theme.colors.text.secondary} />}
                    density={props.density}
                    showChevron={false}
                    showDivider={showDivider}
                    style={[
                        {
                            paddingLeft,
                            paddingRight: props.paddingRight ?? 12,
                        },
                        props.style,
                    ]}
                />
            )
        : (
            <Item
                testID={props.testID}
                {...props.treeItemProps}
                title={props.title}
                titleAccessory={props.titleAccessory}
                subtitle={props.subtitle}
                icon={leading}
                // A tree row is one line. A folder (or a merged chain) ellipsizes in the middle so its last
                // folder stays whole; a file keeps its name's start and truncates its end.
                titleLines={props.disclosure ? 1 : undefined}
                titleEllipsizeMode={props.disclosure ? (props.node.type === 'directory' ? 'middle' : 'tail') : undefined}
                density={props.density}
                rightElement={rightElement}
                showChevron={false}
                selected={props.selected}
                onFocus={rowActions && !touch ? onFocus : props.treeItemProps?.onFocus}
                onBlur={rowActions && !touch ? onBlur : undefined}
                onHoverIn={rowActions && !touch ? () => setHovered(true) : undefined}
                onHoverOut={rowActions && !touch ? () => setHovered(false) : undefined}
                onPress={props.onPress}
                onDoublePress={props.onDoublePress}
                onLongPress={rowActions && touch ? () => setActionsOpen(true) : props.onLongPress}
                onContextMenu={props.onContextMenu}
                showDivider={showDivider}
                style={[
                    {
                        paddingLeft,
                        paddingRight: props.paddingRight ?? 12,
                        ...(treeRowMinHeight ? { minHeight: treeRowMinHeight, paddingVertical: 0 } : null),
                    },
                    props.style,
                ]}
            />
        );

    if (!props.wrapContent) {
        return content;
    }

    return props.wrapContent({
        node: props.node,
        content,
    });
}
