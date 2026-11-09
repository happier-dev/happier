import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { HAPPIER_COLLECTION_LIST_METRICS } from '@happier-dev/plugin-ui/presentation';
import { PANE_TEXT_INSET_PX } from '@/components/ui/layout/headerBand';
import { CollectionListGroupLabel } from '@/components/ui/lists/collection/CollectionList';
import { ITEM_ROW_PADDING_HORIZONTAL } from '@/components/ui/lists/itemDensityMetrics';
import { useSidePaneTextEdge } from '@/components/ui/lists/listPresentation';

/**
 * The label starts where the pane's rows start their marks, not on a collection column's content inset, so a
 * heading, its rows' icons and every other section share one left edge. In a side pane that is the pane's
 * text edge (its header title's); elsewhere the compact row inset.
 */
const LABEL_INDENT_PX = ITEM_ROW_PADDING_HORIZONTAL.compact - HAPPIER_COLLECTION_LIST_METRICS.contentInset;
const SIDE_PANE_LABEL_INDENT_PX = PANE_TEXT_INSET_PX - HAPPIER_COLLECTION_LIST_METRICS.contentInset;

/**
 * A flat pane section's heading: the title with its count, and the section's one control ("+") at the
 * end, on the pane rows' leading edge so every section of a pane and its rows share one edge.
 */
export function PaneSectionHeader(props: Readonly<{
    title: string;
    count?: number;
    action?: React.ReactNode;
    testID?: string;
}>) {
    const sidePane = useSidePaneTextEdge();
    return (
        <View style={styles.header} testID={props.testID}>
            <View style={styles.label}>
                <CollectionListGroupLabel title={props.title} count={props.count} indentPx={sidePane ? SIDE_PANE_LABEL_INDENT_PX : LABEL_INDENT_PX} />
            </View>
            {props.action}
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    // The label carries the section's top gap above its line; the control sits on that line, not on the gap's middle.
    header: { flexDirection: 'row', alignItems: 'flex-end', gap: theme.space.s4, paddingRight: theme.space.s8 },
    label: { flex: 1, minWidth: 0 },
}));
