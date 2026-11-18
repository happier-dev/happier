import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { SectionRowBleedContext, useSectionRowBleedStyle } from './bareRowBleed';
import { MENU_ROW_METRICS } from './itemDensityMetrics';
import { MenuSectionRowsContext } from './listPresentation';
import { PAGE_LIST_METRICS } from './pageListMetrics';

/**
 * Free-form content that sits directly in a page section (a visual picker the section title already
 * names), with the same insets and row divider as an `Item`. `ItemGroup` injects `showDivider`.
 * `continuesRow` places it directly under the row above (which then draws no divider), for content
 * that belongs to that row, such as a preview of its choice. `leading` (an identity mark or glyph)
 * sits in the page row's leading column, so the content's text starts on the same edge as the titles
 * of the `Item` rows around it.
 */
export function SectionContentRow(props: Readonly<{
    children: React.ReactNode;
    showDivider?: boolean;
    continuesRow?: boolean;
    leading?: React.ReactNode;
    testID?: string;
}>) {
    const bleedStyle = useSectionRowBleedStyle();
    // On a popover or menu (`ItemGroup`'s floating menu section) it stands on the menu's one text edge, with the
    // menu's rows, and like them draws no divider unless asked.
    const menuRow = React.useContext(MenuSectionRowsContext);
    const showDivider = props.showDivider ?? !menuRow;
    const row = (
        <View
            testID={props.testID}
            style={[styles.row, menuRow ? styles.menuRow : null, bleedStyle, props.continuesRow ? styles.continuesRow : null, showDivider ? styles.divider : null]}
        >
            {props.leading ? (
                <View style={styles.leadingRow}>
                    <View style={styles.leading}>{props.leading}</View>
                    <View style={styles.content}>{props.children}</View>
                </View>
            ) : props.children}
        </View>
    );
    // Only the section's own rows bleed: a row drawn inside this one does not.
    return bleedStyle ? <SectionRowBleedContext.Provider value={0}>{row}</SectionRowBleedContext.Provider> : row;
}

const styles = StyleSheet.create((theme) => ({
    row: {
        paddingHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
        paddingTop: PAGE_LIST_METRICS.rowPaddingVerticalPx + 2,
        paddingBottom: PAGE_LIST_METRICS.rowPaddingVerticalPx,
    },
    menuRow: {
        paddingHorizontal: MENU_ROW_METRICS.paddingHorizontalPx,
    },
    leadingRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: PAGE_LIST_METRICS.rowLeadingGapPx,
    },
    // The same column an `Item`'s leading mark sits in: at least the glyph column, wider for a larger mark.
    leading: {
        minWidth: PAGE_LIST_METRICS.rowLeadingColumnPx,
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
    },
    content: {
        flex: 1,
        minWidth: 0,
    },
    continuesRow: {
        paddingTop: 0,
    },
    divider: {
        borderBottomWidth: StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border.subtle,
    },
}));
