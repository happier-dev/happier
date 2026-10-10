import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';

export type SetupBlockLayout = 'card' | 'row' | 'wide';

/** The block's quiet ✕: always visible (hover is never the only way to find it). */
export type SetupBlockDismiss = Readonly<{
    /** "Hide “Add your phone”". */
    label: string;
    /** Where it goes and how it comes back ("Hide · restore from Customize"). */
    tooltip?: string;
    onPress: () => void;
}>;

/**
 * The one paper a set-up block sits on (lab `.hi-tile`): surface, hairline, radius, and the ✕ in its
 * corner (`card`) or at the end of the line (`row`, `wide`). The body is the caller's. `card` fills its
 * grid cell; `row` is a phone row; `wide` lays the body out in one line across the whole row (give the
 * block `span: 'row'`). Columns belong to the grid (`SetupBlockItem.span`), not to the paper.
 */
export function SetupBlockPaper(props: Readonly<{
    testID: string;
    layout: SetupBlockLayout;
    accessibilityLabel?: string;
    /** The ✕'s test id is `${testID}.dismiss`. */
    dismiss?: SetupBlockDismiss;
    /**
     * `dashed`: a block that explains rather than offers (no action of its own). `tile`: a choice
     * inside an open block, on the action-tile paper (section tint + hairline, as "Add a machine"'s
     * ways to add one), `highlighted` while hovered or focused.
     */
    appearance?: 'solid' | 'dashed' | 'tile';
    highlighted?: boolean;
    children: React.ReactNode;
}>) {
    const card = props.layout === 'card';
    const { theme } = useUnistyles();
    const materialColor = useHappierMaterialColorResolver();
    const paperColor = props.appearance === 'dashed' ? 'transparent' : props.appearance === 'tile' ? theme.colors.surface.sectionTint : theme.colors.surface.base;
    return (
        <View
            testID={props.testID}
            accessibilityLabel={props.accessibilityLabel}
            style={[
                card ? styles.card : props.layout === 'wide' ? styles.wide : styles.row,
                props.appearance === 'dashed' ? styles.dashed : null,
                props.appearance === 'tile' ? styles.tile : null,
                props.appearance === 'tile' && props.highlighted ? styles.tileHighlighted : null,
                { backgroundColor: materialColor(paperColor) },
            ]}
        >
            {props.children}
            {props.dismiss ? (
                <View style={card ? styles.dismissCard : styles.dismissRow}>
                    <IconButton
                        testID={`${props.testID}.dismiss`}
                        iconName="x"
                        variant="plain"
                        size={24}
                        iconSize={14}
                        accessibilityLabel={props.dismiss.label}
                        tooltip={props.dismiss.tooltip}
                        tooltipPlacement="bottom"
                        onPress={props.dismiss.onPress}
                    />
                </View>
            ) : null}
        </View>
    );
}

const styles = StyleSheet.create((theme) => {
    const paper = {
        borderRadius: PAGE_LIST_METRICS.sheetRadiusPx,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border.default,
        backgroundColor: theme.colors.surface.base,
    } as const;
    return {
        card: {
            ...paper,
            flex: 1,
            position: 'relative',
            minHeight: 152,
            padding: 14,
            gap: 10,
        },
        row: {
            ...paper,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 12,
            paddingVertical: 12,
            paddingLeft: 14,
            paddingRight: 8,
        },
        wide: {
            ...paper,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 14,
            paddingVertical: 14,
            paddingLeft: 16,
            paddingRight: 10,
        },
        dashed: {
            borderStyle: 'dashed',
            borderWidth: 1,
            borderColor: theme.colors.border.strong,
            backgroundColor: 'transparent',
        },
        tile: {
            backgroundColor: theme.colors.surface.sectionTint,
        },
        tileHighlighted: {
            borderColor: theme.colors.border.strong,
        },
        dismissCard: {
            position: 'absolute',
            top: 8,
            right: 8,
        },
        dismissRow: {
            marginLeft: -2,
        },
    };
});
