import * as React from 'react';
import { Pressable, View, Platform, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import { buildSelectionListSectionHeaderGridA11yProps } from './buildSelectionListOptionA11yProps';
import type { SelectionListSectionAction } from './_types';

/**
 * R6 — Premium UI design polish (Fix 1): a lighter, command-bar-style section
 * header used for SelectionList sections on web. Replaces the heavy `ItemGroup`
 * chrome (background card + 32pt padded title bar) that gave the picker a
 * settings-list feel.
 *
 * Visual contract:
 *  - Web: a flat label rendered with a thin top border so consecutive sections
 *    read as a continuous command-bar list.
 *  - Native: keeps the iOS-style padding/typography that `ItemGroup` already
 *    provides (we render the same shape but without the surface card around
 *    rows; the orchestrator owns row chrome).
 *
 * The component is presentational: it doesn't own selection state, dividers
 * between rows, or any interactivity. It is rendered by `SelectionList.tsx`
 * directly above the option rows for non-virtualized sections, and by the
 * virtualized section helper above the virtualized list host.
 */
export type SelectionListSectionHeaderProps = Readonly<{
    /** Section title, rendered in its own (sentence) case. May be undefined. */
    title?: string;
    /**
     * Optional count rendered to the right of the title with tabular-nums so
     * width stays stable as numbers tick.
     */
    count?: number;
    /** Optional section-owned action rendered at the trailing edge. */
    rightAccessory?: React.ReactNode;
    /** The section's one quiet destination, drawn as a text link at the trailing edge. */
    action?: SelectionListSectionAction;
    /** Stable testID anchor (e.g. `<sectionTestId>:header`). */
    testID?: string;
    /** Optional host-owned layout override; typography and accessory behavior remain canonical here. */
    containerStyle?: StyleProp<ViewStyle>;
    /**
     * The header's identity as a GRID ROW, when the popup composes its rows
     * with the grid pattern. A grid may own only rows, and this header renders
     * text, so it takes a row of its own containing one full-width
     * `columnheader` — see `buildSelectionListSectionHeaderGridA11yProps`.
     *
     * Absent in `listbox` mode and in the identity-free measure mirror, both of
     * which keep the historical role-free markup.
     */
    gridRow?: Readonly<{
        /** Popup-wide 1-based `aria-rowindex`, from the shared row model. */
        rowIndex: number;
        /** The grid's declared column count — what this header spans. */
        columnCount: number;
    }>;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        // R13 (Fix 4): drop the full-width 1pt top border that R6 used. The
        // command-bar surface reads as a continuous list without an explicit
        // divider — section grouping comes from typography + vertical rhythm.
        ...(Platform.select({
            web: {
                paddingHorizontal: 16,
                paddingTop: 10,
                paddingBottom: 4,
            },
            default: {
                paddingHorizontal: 16,
                paddingTop: Platform.select({ ios: 16, default: 14 }),
                paddingBottom: Platform.select({ ios: 6, default: 6 }),
            },
        }) as object),
    },
    label: {
        flex: 1,
        // U8.5 craft S1: a sentence-case group label in the secondary text colour, medium weight —
        // the group reads by weight and rhythm, not by an uppercase eyebrow.
        ...Typography.default('medium'),
        color: theme.colors.text.secondary,
        fontSize: Platform.select({ ios: 13, default: 12 }),
        lineHeight: Platform.select({ ios: 18, default: 16 }),
    },
    action: {
        ...Typography.default('medium'),
        color: theme.colors.text.secondary,
        fontSize: Platform.select({ ios: 13, default: 12 }),
        lineHeight: Platform.select({ ios: 18, default: 16 }),
    },
    count: {
        color: theme.colors.text.tertiary,
        fontSize: Platform.select({ ios: 13, default: 12 }),
        lineHeight: Platform.select({ ios: 18, default: 16 }),
        marginLeft: 8,
    },
}));

/**
 * Render a SelectionList section header. Intentionally tiny: only paints
 * typography + the optional count accessory. Empty titles render nothing.
 */
export function SelectionListSectionHeader(
    props: SelectionListSectionHeaderProps,
): React.ReactElement | null {
    const styles = stylesheet;
    if (props.title === undefined || props.title.length === 0) return null;
    const title = props.title;
    // In `grid` mode the header's own box becomes the row's single cell, so the
    // visible chrome — padding, typography, the count accessory — stays on the
    // exact same node it has always been on, and only a role-carrying row is
    // added around it.
    const gridAria = props.gridRow === undefined
        ? null
        : buildSelectionListSectionHeaderGridA11yProps({
            pattern: 'grid',
            rowIndex: props.gridRow.rowIndex,
            columnCount: props.gridRow.columnCount,
        });
    const header = (
        <View
            testID={props.testID}
            style={[styles.container, props.containerStyle]}
            {...(gridAria === null ? {} : (gridAria.cell as unknown as Record<string, never>))}
        >
            <Text style={styles.label}>{title}</Text>
            {typeof props.count === 'number' ? (
                <Text style={[styles.count, Typography.tabular()]}>{String(props.count)}</Text>
            ) : null}
            {props.rightAccessory}
            {props.action ? (
                <Pressable
                    testID={props.action.testID}
                    accessibilityRole="link"
                    accessibilityLabel={props.action.label}
                    hitSlop={8}
                    onPress={props.action.onPress}
                >
                    <Text style={styles.action}>{props.action.label}</Text>
                </Pressable>
            ) : null}
        </View>
    );
    if (gridAria === null) return header;
    return (
        <View {...(gridAria.row as unknown as Record<string, never>)}>
            {header}
        </View>
    );
}
