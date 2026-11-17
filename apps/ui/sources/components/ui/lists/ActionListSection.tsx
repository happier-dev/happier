import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { SelectableRow } from './SelectableRow';
import { MENU_ROW_METRICS } from './itemDensityMetrics';
import { SelectionListSectionHeader } from '@/components/ui/selectionList/SelectionListSectionHeader';
import { Text } from '@/components/ui/text/Text';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';


export type ActionListItemContent = Readonly<{
    id: string;
    testID?: string;
    label: string;
    accessibilityLabel?: string;
    subtitle?: string;
    /** A status mark before the subtitle (a dot or a warning glyph); see `SelectableRow`. */
    subtitleLeading?: React.ReactNode;
    icon?: React.ReactNode;
    right?: React.ReactNode;
    /** Keeps an interactive `right` (an inline button) outside the row's own press target. */
    rightElementOutsidePressable?: boolean;
    selected?: boolean;
    /**
     * A choice that is on or off among its siblings (a shown column): on draws the menu's check at the row's end (as a
     * checked `DropdownMenu` row does) and the row is announced as a checkbox. Leave it off for one-shot operations.
     */
    checked?: boolean;
    onPress?: () => void;
    /** The pointer rests on the row (web): a menu that opens a submenu beside a row reads its intent here. */
    onHover?: () => void;
    onKeyDown?: (event: unknown) => void;
    disabled?: boolean;
    destructive?: boolean;
    /** The row's press target, for a menu that moves focus between its own steps. */
    rowRef?: React.Ref<React.ElementRef<typeof SelectableRow>>;
}>;

/**
 * A private extension point for an incumbent action-menu row. The callback
 * receives the generated row facts and must delegate visual chrome back to
 * `renderDefaultItem`; it does not create a second menu/row owner.
 */
export type ActionListItem = ActionListItemContent & Readonly<{
    renderItem?: (
        item: ActionListItemContent,
        renderDefaultItem: (item: ActionListItemContent) => React.ReactNode,
    ) => React.ReactNode;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    // A menu's outer edges are one inset (`MENU_ROW_METRICS`) from the surface. Between two sections
    // the hairline replaces both insets, so the space on each side of it is exactly a row's own
    // padding: the same as the space between two rows (no wider gap before a divider than after a row).
    section: {
        paddingVertical: MENU_ROW_METRICS.sectionPaddingVerticalPx,
    },
    separator: {
        height: StyleSheet.hairlineWidth,
        // Aligned with the rows' text, inside the menu inset.
        marginHorizontal: MENU_ROW_METRICS.paddingHorizontalPx,
        marginTop: -MENU_ROW_METRICS.sectionPaddingVerticalPx,
        backgroundColor: theme.colors.border.default,
    },
    sectionAfterSeparator: {
        paddingTop: 0,
    },
    label: {
        color: theme.colors.text.primary,
        ...Typography.variant('label', 'regular'),
    },
    // A destructive row says so in its words as well as its glyph (as DropdownMenu's destructive rows do).
    labelDestructive: {
        color: theme.colors.state.danger.foreground,
    },
}));

export function ActionListSection(props: {
    title?: string;
    /** Draws a hairline above the section, separating it from the menu section before it. */
    separatorAbove?: boolean;
    actions: ReadonlyArray<ActionListItem | null | undefined>;
    style?: StyleProp<ViewStyle>;
}) {
    const styles = stylesheet;
    const { theme } = useUnistyles();

    const actions = React.useMemo(() => {
        return (props.actions ?? []).filter(Boolean) as ActionListItem[];
    }, [props.actions]);

    const renderActionIcon = React.useCallback((icon: React.ReactNode) => {
        // On web, raw strings/numbers cannot be direct children of <View>.
        // Wrap primitives in <Text> to avoid "Unexpected text node" runtime errors.
        if (typeof icon === 'string' || typeof icon === 'number') {
            return <Text>{icon}</Text>;
        }
        return icon;
    }, []);

    const renderDefaultItem = React.useCallback((action: ActionListItemContent): React.ReactNode => (
        <SelectableRow
            ref={action.rowRef}
            testID={action.testID}
            destructive={action.destructive}
            disabled={action.disabled}
            onPress={action.onPress}
            onHover={action.onHover}
            onKeyDown={action.onKeyDown}
            left={action.icon ? <View>{renderActionIcon(action.icon)}</View> : null}
            right={action.right ?? (action.checked === true ? <Icon name="check" size={ICON_SIZE.sm} color={theme.colors.text.primary} /> : null)}
            rightElementOutsidePressable={action.rightElementOutsidePressable}
            title={action.label}
            accessibilityLabel={action.accessibilityLabel}
            subtitle={action.subtitle}
            subtitleLeading={action.subtitleLeading}
            titleStyle={action.destructive ? [styles.label, styles.labelDestructive] : styles.label}
            selected={action.selected}
            accessibilityButtonSelected={action.selected}
            {...(action.checked === undefined ? {} : { accessibilityRole: 'checkbox' as const, accessibilityChecked: action.checked })}
            variant="slim"
            presentation="menu"
        />
    ), [renderActionIcon, styles.label, styles.labelDestructive, theme.colors.text.primary]);

    if (actions.length === 0) return null;

    return (
        <>
        {props.separatorAbove ? <View style={styles.separator} /> : null}
        <View style={[styles.section, props.separatorAbove ? styles.sectionAfterSeparator : null, props.style]}>
            {/* One section label for popover menus: the list owner's, in the title's own case. */}
            {props.title ? <SelectionListSectionHeader title={props.title} /> : null}

            {actions.map((action) => {
                const { renderItem, ...item } = action;
                const content: ActionListItemContent = item;
                return (
                    <React.Fragment key={content.id}>
                        {renderItem ? renderItem(content, renderDefaultItem) : renderDefaultItem(content)}
                    </React.Fragment>
                );
            })}
        </View>
        </>
    );
}
