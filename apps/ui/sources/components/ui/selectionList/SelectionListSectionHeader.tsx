import * as React from 'react';
import { useHappierThemeSurfaceOverridesEnabled } from '@happier-dev/plugin-ui/presentation';
import { themeSurfaceStyles } from '@/theme/css/themeSurfaceStyles';
import { SelectionListThemeSurfaceContext } from './SelectionListThemeSurfaceContext';
import { View, Platform, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { resolveItemGroupHeaderHorizontalInsetPx } from '@/components/ui/lists/itemGroupSpacing';
import { MENU_ROW_METRICS } from '@/components/ui/lists/itemDensityMetrics';

import { buildSelectionListSectionHeaderGridA11yProps } from './buildSelectionListOptionA11yProps';
import { SELECTION_LIST_CARD_CONTENT_INSET_PX } from './_constants';
import { SelectionListOptionPresentationContext } from './SelectionListOptionPresentationContext';
import type { SelectionListSectionAction } from './_types';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

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
    /** The title is a path or identifier, set in the mono role. */
    monoTitle?: boolean;
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
                paddingHorizontal: theme.space.s16,
                paddingTop: theme.space.s10,
                paddingBottom: theme.space.s4,
            },
            default: {
                paddingHorizontal: theme.space.s16,
                paddingTop: Platform.select({ ios: 16, default: 14 }),
                paddingBottom: Platform.select({ ios: 6, default: 6 }),
            },
        }) as object),
    },
    label: {
        flex: 1,
        // U8.5 craft S1: a sentence-case group label in the secondary text colour, medium weight —
        // the group reads by weight and rhythm, not by an uppercase eyebrow.

        color: theme.colors.text.secondary,
        ...Typography.variant('meta', 'medium'),

    },
    action: {

        color: theme.colors.text.secondary,
        ...Typography.variant('meta', 'medium'),

    },
    // Over a card grid the heading starts where the cards' text does, not at the list-row inset.
    cardContainer: {
        paddingHorizontal: SELECTION_LIST_CARD_CONTENT_INSET_PX,
    },
    // Menu presentation: the title starts where the edge-to-edge menu rows start (their shared inset).
    menuContainer: {
        paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx,
    },
    // Section presentation: the title starts where a grouped `ItemGroup` title does, in its type role.
    sectionContainer: {
        paddingHorizontal: resolveItemGroupHeaderHorizontalInsetPx(),
    },
    sectionLabel: {
        ...Typography.variant('body', 'medium'),
    },
    // Paths are mono (DESIGN.md), one step quieter than the proportional label.
    monoLabel: {
        ...Typography.mono(),
    },
    count: {
        color: theme.colors.text.tertiary,
        fontSize: Platform.select({ ios: 13, default: 12 }),
        lineHeight: Platform.select({ ios: 18, default: 16 }),
        marginLeft: theme.space.s8,
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
    const presentation = React.useContext(SelectionListOptionPresentationContext);
    const surface = React.useContext(SelectionListThemeSurfaceContext)?.sectionTitle;
    const themeSurfaceEnabled = useHappierThemeSurfaceOverridesEnabled();
    const isCard = presentation === 'card';
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
            style={[styles.container, isCard ? styles.cardContainer : null, presentation === 'menu' ? styles.menuContainer : null, presentation === 'section' ? styles.sectionContainer : null, props.containerStyle]}
            {...(gridAria === null ? {} : (gridAria.cell as unknown as Record<string, never>))}
        >
            <Text
                {...(surface ? { dataSet: { ...surface, state: surface.state ?? 'default' } } : {})}
                style={[styles.label, presentation === 'section' ? styles.sectionLabel : null, props.monoTitle ? styles.monoLabel : null, themeSurfaceStyles.surface(themeSurfaceEnabled ? surface : undefined)]}
            >{title}</Text>
            {typeof props.count === 'number' ? (
                <Text style={[styles.count, Typography.tabular()]}>{String(props.count)}</Text>
            ) : null}
            {props.rightAccessory}
            {props.action ? (
                <HappierPressable
                    testID={props.action.testID}
                    accessibilityRole="link"
                    accessibilityLabel={props.action.label}
                    onPress={props.action.onPress}
                >
                    <Text style={styles.action}>{props.action.label}</Text>
                </HappierPressable>
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
