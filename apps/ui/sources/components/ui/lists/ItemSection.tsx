import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Eyebrow } from '@/components/ui/text/Eyebrow';
import { ItemGroupColumns } from '@/components/ui/lists/ItemGroupColumns';

/**
 * Narrowest an `ItemSection` cell may become before a column is given up.
 *
 * A section cell is a compact readout — a labelled meter, a small stat — not a
 * title+subtitle list row, so it stays readable well below the 320px list-row
 * floor. Below roughly this width the single-line label starts truncating.
 */
export const ITEM_SECTION_COLUMN_MIN_WIDTH_PX = 240;

export interface ItemSectionProps {
    caption?: string;
    children: React.ReactNode;
    columns?: 1 | 2 | 3;
    /** Override the cell floor when a section hosts unusually wide content. */
    minColumnWidthPx?: number;
    tone?: 'tint' | 'plain';
    style?: StyleProp<ViewStyle>;
    testID?: string;
}

const stylesheet = StyleSheet.create((theme) => ({
    containerTint: {
        // Barely-there separation: a baked low-opacity section tint sits a hair off
        // the base surface, lighter than the recessed inset and not a heavy elevated
        // grey block. Baked into the token because a runtime opacity transform is a
        // silent no-op once the web build var-ifies theme tokens.
        backgroundColor: theme.colors.surface.sectionTint,
        borderRadius: 12,
        overflow: 'hidden',
    },
    containerPlain: {
        borderRadius: 12,
        overflow: 'hidden',
    },
    caption: {
        paddingHorizontal: 16,
        paddingTop: 12,
    },
    body: {
        paddingTop: 8,
    },
}));

export const ItemSection = React.memo<ItemSectionProps>((props) => {
    const styles = stylesheet;
    const tone = props.tone ?? 'tint';

    return (
        <View
            testID={props.testID}
            style={[tone === 'tint' ? styles.containerTint : styles.containerPlain, props.style]}
        >
            {props.caption != null ? (
                <Eyebrow style={styles.caption}>{props.caption}</Eyebrow>
            ) : null}
            {/*
              * No `activeColumns`: a section is a thin wrapper with nothing to
              * decide before rendering, so it delegates the count to the grid,
              * which measures the box the cells actually share. Resolving it
              * here as well would be a second owner of the same number.
              */}
            <ItemGroupColumns
                style={styles.body}
                columns={props.columns ?? 2}
                minColumnWidthPx={props.minColumnWidthPx ?? ITEM_SECTION_COLUMN_MIN_WIDTH_PX}
            >
                {props.children}
            </ItemGroupColumns>
        </View>
    );
});

ItemSection.displayName = 'ItemSection';
