import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { Typography } from '@/constants/Typography';
import { SelectableRow } from './SelectableRow';
import { MENU_ROW_METRICS } from './itemDensityMetrics';
import { SelectionListSectionHeader } from '@/components/ui/selectionList/SelectionListSectionHeader';
import { Text } from '@/components/ui/text/Text';


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
    onPress?: () => void;
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
        marginHorizontal: MENU_ROW_METRICS.insetPx + MENU_ROW_METRICS.paddingHorizontalPx,
        marginTop: -MENU_ROW_METRICS.sectionPaddingVerticalPx,
        backgroundColor: theme.colors.border.default,
    },
    sectionAfterSeparator: {
        paddingTop: 0,
    },
    label: {
        fontSize: 14,
        color: theme.colors.text.primary,
        ...Typography.default(),
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
    useUnistyles();

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
            left={action.icon ? <View>{renderActionIcon(action.icon)}</View> : null}
            right={action.right ?? null}
            rightElementOutsidePressable={action.rightElementOutsidePressable}
            title={action.label}
            accessibilityLabel={action.accessibilityLabel}
            subtitle={action.subtitle}
            subtitleLeading={action.subtitleLeading}
            titleStyle={action.destructive ? [styles.label, styles.labelDestructive] : styles.label}
            selected={action.selected}
            accessibilityButtonSelected={action.selected}
            variant="slim"
            presentation="menu"
        />
    ), [renderActionIcon, styles.label, styles.labelDestructive]);

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
