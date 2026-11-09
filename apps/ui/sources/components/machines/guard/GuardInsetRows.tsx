import * as React from 'react';
import { View, type TextStyle } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

/**
 * The Guard's one inset list of present things — the candidates a ladder step would stop, the idle
 * sessions and terminals a rule would act on (lab `RS.cand`): a quiet inset under its rule, one row per
 * thing with its mark, its name, what qualifies it and one trailing figure.
 */
/** `nested` sits inside a step's body, which already carries the row inset; otherwise it spans the sheet at the row inset. */
export function GuardInsetList(props: Readonly<{ testID?: string; nested?: boolean; children: React.ReactNode }>) {
    return <View testID={props.testID} style={[styles.list, props.nested ? styles.nested : styles.inSheet]}>{props.children}</View>;
}

export type GuardInsetFigureTone = 'normal' | 'strong' | 'quiet';

export function GuardInsetRow(props: Readonly<{
    testID?: string;
    first: boolean;
    /** The thing's mark (agent, kind glyph); never a tile. */
    leading?: React.ReactNode;
    label: string;
    /** A kept or already-handled row reads quieter. */
    quiet?: boolean;
    qualifier?: string | null;
    /** The trailing figure: a size, "Stops in 4:52", "Kept". */
    trailing?: React.ReactNode;
}>) {
    return (
        <View testID={props.testID} style={[styles.row, props.first ? null : styles.divider]}>
            {props.leading}
            <Text style={styles.text} numberOfLines={1}>
                <Text style={props.quiet ? styles.labelQuiet : styles.label}>{props.label}</Text>
                {props.qualifier ? `  ${props.qualifier}` : ''}
            </Text>
            {props.trailing}
        </View>
    );
}

/** The trailing figure's text styles, for a figure that is its own component (the live countdown). */
export function useGuardInsetFigureStyle(tone: GuardInsetFigureTone): TextStyle {
    // Unistyles maps native font fields through breakpoint/opaque-color types.
    // The authored figure styles below are checked against the native contract.
    return styles[tone === 'strong' ? 'figureStrong' : tone === 'quiet' ? 'figureQuiet' : 'figure'] as TextStyle;
}

export function GuardInsetFigure(props: Readonly<{ tone?: GuardInsetFigureTone; children: React.ReactNode }>) {
    return <Text style={useGuardInsetFigureStyle(props.tone ?? 'normal')}>{props.children}</Text>;
}

const styles = StyleSheet.create((theme) => ({
    list: {
        borderRadius: 8,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.inset,
    },
    inSheet: {
        marginHorizontal: PAGE_LIST_METRICS.rowPaddingHorizontalPx,
        marginBottom: theme.space.s12,
    },
    nested: {
        marginTop: theme.space.s8,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s10,
        paddingHorizontal: theme.space.s12,
        paddingVertical: theme.space.s8,
    },
    divider: {
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border.subtle,
    },
    text: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
        flex: 1,
        minWidth: 0,
    },
    label: {
        ...Typography.default('medium'),
        color: theme.colors.text.primary,
    },
    labelQuiet: {
        ...Typography.default(),
        color: theme.colors.text.secondary,
    },
    figure: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.secondary,
        fontVariant: ['tabular-nums'],
    } satisfies TextStyle,
    figureStrong: {
        ...Typography.default('semiBold'),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
    } satisfies TextStyle,
    figureQuiet: {
        ...Typography.default(),
        ...happierPageTextMetrics('rowDescription'),
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    } satisfies TextStyle,
}));
