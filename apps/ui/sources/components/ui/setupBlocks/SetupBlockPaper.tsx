import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useHappierMaterialColorResolver } from '@happier-dev/plugin-ui/presentation';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { GlassSurface } from '@/components/ui/glass/GlassSurface';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';

export type SetupBlockLayout = 'card' | 'row' | 'wide';

/**
 * A card's ✕ sits 8 px under the card's top edge, right below its section's ⋯ (15 px between the two
 * drawn controls, the ⋯'s own hit area taking 8 px of it). The ✕ takes the 7 px left above it, so the
 * two meet and never overlap; sideways and below, nothing competes, so it keeps the full reach.
 */
const CARD_DISMISS_EDGES_PX = { leading: 10, trailing: 10, top: 7 } as const;

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
    const shape = card ? styles.card : props.layout === 'wide' ? styles.wide : styles.row;
    const body = (
        <>
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
                        interactiveTargetEdgesPx={card ? CARD_DISMISS_EDGES_PX : undefined}
                    />
                </View>
            ) : null}
        </>
    );
    // A block's own paper is a card: the Elements material owns its paint and finish (glass over a backdrop,
    // the card fill with nothing behind), like every Element on the page. A dashed note and a choice inside
    // an open block stay inner paint.
    if (props.appearance !== 'dashed' && props.appearance !== 'tile') {
        return <GlassSurface testID={props.testID} accessibilityLabel={props.accessibilityLabel} surfaceGroup="card" nested finishRole="card"
            solidColor={theme.colors.edge.cardFill} style={shape}>{body}</GlassSurface>;
    }
    return (
        <View
            testID={props.testID}
            accessibilityLabel={props.accessibilityLabel}
            style={[
                shape,
                props.appearance === 'dashed' ? styles.dashed : null,
                props.appearance === 'tile' ? styles.tile : null,
                props.appearance === 'tile' && props.highlighted ? styles.tileHighlighted : null,
                { backgroundColor: materialColor(paperColor) },
            ]}
        >
            {body}
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
            flexGrow: 1,
            position: 'relative',
            minHeight: 152,
            padding: 14,
            gap: theme.space.s10,
        },
        row: {
            ...paper,
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.space.s12,
            paddingVertical: theme.space.s12,
            paddingLeft: 14,
            paddingRight: theme.space.s8,
        },
        wide: {
            ...paper,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 14,
            paddingVertical: 14,
            paddingLeft: theme.space.s16,
            paddingRight: theme.space.s10,
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
