import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item, type ItemProps } from '@/components/ui/lists/Item';
import { t } from '@/text';
import type { FilesystemBrowserNode, FilesystemBrowserWrapContentInput } from './filesystemBrowserTypes';
import { Icon } from '@/components/ui/icons/Icon';
import { HappierTreeRow, resolveHappierTreeRowIndentPx } from '@happier-dev/plugin-ui/presentation';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { resolveFilesystemErrorReason } from './filesystemErrorReason';
import { isTouchPrimaryPointer } from '@/components/ui/interactiveTargetSize';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { SelectionCheckGlyph, type SelectionCheckState } from '@/components/ui/selection/SelectionCheckGlyph';
import { useDeviceType } from '@/utils/platform/responsive';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';

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
    /** Drawn right after the title on its line (a folder's changed-file count). */
    titleAccessory?: React.ReactNode;
    subtitle?: React.ReactNode;
    icon: React.ReactNode;
    /** Tree rows: a disclosure chevron before the leading control (a spacer on files, so names align). */
    disclosure?: boolean;
    /**
     * A folder's chevron as its own target (Code folder pages, plan 13 §2): pressing it opens or closes
     * the folder in place, while pressing the row does `onPress` (navigate into the folder). Without it
     * the chevron is decoration and the whole row toggles.
     */
    onDisclosurePress?: (() => void) | null;
    /** The chevron target's accessible name ("Expand apps" / "Collapse apps"). */
    disclosureAccessibilityLabel?: string;
    /**
     * `tree` (default): the sidebar rhythm. `table`: a row of a folder page's table, at the list row
     * height with a regular-weight name, because the commit column beside it carries the scan.
     */
    rowPresentation?: 'tree' | 'table';
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

export function FilesystemBrowserRow(props: FilesystemBrowserRowProps): React.ReactElement {
    const { theme } = useUnistyles();
    const presentationTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
    const phone = useDeviceType() === 'phone';
    const reducedMotion = useReducedMotionPreference();
    const paddingLeft = resolveHappierTreeRowIndentPx(props.node.depth, {
        ...(props.basePaddingLeft === undefined ? {} : { basePaddingPx: props.basePaddingLeft }),
        ...(props.depthIndent === undefined ? {} : { indentStepPx: props.depthIndent }),
    });
    const table = props.rowPresentation === 'table';
    const showDivider = props.showDivider === true;

    const errorNode = props.node;
    const touch = isTouchPrimaryPointer();
    const treeTouch = touch || phone;
    const selection = props.selection ? (
        <IconButton
            testID={props.testID ? `${props.testID}-select` : undefined}
            variant="plain"
            size={24}
            accessibilityRole="checkbox"
            checked={props.selection.state === 'checked'}
            selectedBackground={false}
            disabled={props.selection.disabled}
            accessibilityLabel={props.selection.accessibilityLabel}
            icon={<SelectionCheckGlyph state={props.selection.state} size="compact" />}
            onPress={props.selection.onToggle}
        />
    ) : undefined;
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
        : props.disclosure ? (
            <View
                // @ts-expect-error React Native's View types omit RNW's supported double-click event.
                onDoubleClick={props.onDoublePress}
            >
                <HappierTreeRow
                    node={{
                        key: props.node.path,
                        parentKey: props.node.parentDirectoryPath ?? null,
                        depth: props.node.depth,
                        kind: props.node.type === 'directory' ? 'branch' : 'leaf',
                        expanded: props.node.isExpanded === true,
                    }}
                    title={props.title}
                    titleAccessory={props.titleAccessory}
                    mark={props.selection ? undefined : props.icon}
                    selection={selection}
                    selectionMark={props.selection ? props.selectionMark : undefined}
                    meta={props.subtitle}
                    trailing={props.rightElement}
                    renderActions={props.rowActions ?? undefined}
                    actionsRevealed={props.rowActionsRevealed}
                    selected={props.selected}
                    tabStop={props.treeItemProps?.webTabIndex === 0}
                    presentation={props.rowPresentation}
                    touch={treeTouch}
                    theme={presentationTheme}
                    reducedMotion={reducedMotion}
                    onActivate={props.onPress ?? (() => {})}
                    onLongPress={props.onLongPress}
                    onContextMenu={props.onContextMenu}
                    keyboardShortcuts={props.treeItemProps?.webKeyShortcuts}
                    onFocus={props.treeItemProps?.onFocus ?? (() => {})}
                    onKeyDown={(_key, event) => {
                        props.treeItemProps?.onKeyDown?.(event as Parameters<NonNullable<ItemProps['onKeyDown']>>[0]);
                        return (event as { defaultPrevented?: boolean } | null)?.defaultPrevented === true;
                    }}
                    controlRef={(target) => {
                        const ref = props.treeItemProps?.pressableRef;
                        if (typeof ref === 'function') ref(target as never);
                        else if (ref && 'current' in ref) ref.current = target as never;
                    }}
                    disclosure={{
                        ...(props.node.type === 'directory' && props.onDisclosurePress !== undefined && props.onDisclosurePress !== null
                            ? { onPress: props.onDisclosurePress }
                            : {}),
                        accessibilityLabel: props.disclosureAccessibilityLabel ?? props.title,
                        testID: props.testID ? `${props.testID}-disclosure` : undefined,
                    }}
                    testID={props.testID}
                    style={[
                        {
                            marginHorizontal: 0,
                            ...(table ? { borderRadius: 0 } : null),
                            ...(table && showDivider ? { borderBottomWidth: 1, borderBottomColor: theme.colors.border.subtle } : null),
                        },
                        props.style,
                    ]}
                />
            </View>
        ) : (
            <Item
                testID={props.testID}
                {...props.treeItemProps}
                title={props.title}
                titleAccessory={props.titleAccessory}
                subtitle={props.subtitle}
                icon={props.icon}
                density={props.density}
                rightElement={props.rightElement}
                showChevron={false}
                selected={props.selected}
                onPress={props.onPress}
                onDoublePress={props.onDoublePress}
                onLongPress={props.onLongPress}
                onContextMenu={props.onContextMenu}
                showDivider={showDivider}
                style={[
                    {
                        paddingLeft,
                        paddingRight: props.paddingRight ?? 12,
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
