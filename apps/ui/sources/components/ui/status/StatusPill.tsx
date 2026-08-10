import * as React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { FontWeights, Typography } from '@/constants/Typography';

import { StatusDot } from './StatusDot';

export const STATUS_PILL_VARIANTS = [
    'success',
    'warning',
    'danger',
    'info',
    'neutral',
] as const;

export type StatusPillVariant = (typeof STATUS_PILL_VARIANTS)[number];

/**
 * How the label reads, which decides its type.
 *
 * `micro` (default) is the classic pill label — a 2–8 character status token like `stale` or
 * `clean` — where a touch of tracking aids legibility at 11px.
 * `phrase` is a sentence-case phrase like "Account rotation pending". Tracking spaces a phrase out
 * and makes it read apart from neighbouring UI text, so it matches ordinary 11px chrome type.
 */
export type StatusPillLabelVariant = 'micro' | 'phrase';

export type StatusPillProps = Readonly<{
    variant: StatusPillVariant;
    label: string;
    chrome?: 'pill' | 'plain';
    count?: number;
    hideDot?: boolean;
    /**
     * Leading element rendered in place of the status dot — an icon glyph, typically. Implies
     * `hideDot`, since a pill carries one leading marker, not two.
     */
    leading?: React.ReactNode;
    foregroundColor?: string;
    dotColor?: string;
    isPulsing?: boolean;
    /** Truncate the label instead of letting it grow, for pills in width-constrained rows. */
    labelNumberOfLines?: number;
    labelVariant?: StatusPillLabelVariant;
    testID?: string;
    variantTestID?: string;
    accessibilityLabel?: string;
    style?: StyleProp<ViewStyle>;
}>;

const stylesheet = StyleSheet.create(() => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 8,
        paddingVertical: 2,
        // 8px, not a full pill. A badge is a small rounded rect that sits in a row of
        // rectangular surfaces; a capsule reads as a separate species next to them.
        borderRadius: 8,
        // Badges are background-only: no border chrome on any pill app-wide.
        borderWidth: 0,
    },
    plainContainer: {
        gap: 4,
        paddingHorizontal: 0,
        paddingVertical: 0,
        borderWidth: 0,
        backgroundColor: 'transparent',
    },
    variantMarker: {
        position: 'absolute',
        width: 0,
        height: 0,
        opacity: 0,
    },
    label: {
        ...Typography.pillLabel(),
    },
    // Ordinary 11px chrome type, matching the status text a phrase pill sits beside.
    phraseLabel: {
        ...Typography.default(),
        fontSize: 11,
        // `Typography.default()` omits `fontWeight` for the regular weight — on the Inter path the
        // family name carries it. But the micro-label uses `default('semiBold')`, which on iOS and
        // Apple web sets an explicit `fontWeight`, and that survives spreading regular over it.
        // Reset it here or phrase pills stay semiBold on exactly those platforms.
        fontWeight: FontWeights.regular,
        letterSpacing: 0,
    },
}));

export function StatusPill(props: StatusPillProps): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const state = theme.colors.state[props.variant];
    const chrome = props.chrome ?? 'pill';
    // Pill chrome puts the label on `state.background`, where the glyph hue does not clear AA;
    // `onTint` is the ink for exactly that surface. Plain chrome has no tint behind the text, so
    // it keeps the foreground. The dot is a glyph, not text, and stays on the foreground either way.
    const labelColor = props.foregroundColor ?? (chrome === 'pill' ? state.onTint : state.foreground);
    const labelVariantStyle = props.labelVariant === 'phrase' ? styles.phraseLabel : null;
    const dotColor = props.dotColor ?? props.foregroundColor ?? state.foreground;

    return (
        <View
            testID={props.testID}
            accessibilityLabel={props.accessibilityLabel ?? props.label}
            style={[
                styles.container,
                chrome === 'plain'
                    ? styles.plainContainer
                    : {
                        backgroundColor: state.background,
                    },
                props.style,
            ]}
        >
            <View
                testID={props.variantTestID ?? (props.testID ? `${props.testID}:variant:${props.variant}` : undefined)}
                pointerEvents="none"
                style={styles.variantMarker}
            />
            {props.leading ?? (props.hideDot ? null : (
                <StatusDot
                    testID={props.testID ? `${props.testID}:dot` : undefined}
                    color={dotColor}
                    isPulsing={props.isPulsing}
                />
            ))}
            {props.count !== undefined ? (
                <Text
                    testID={props.testID ? `${props.testID}:count` : undefined}
                    style={[styles.label, labelVariantStyle, Typography.tabular(), { color: labelColor }]}
                >
                    {props.count}
                </Text>
            ) : null}
            <Text
                testID={props.testID ? `${props.testID}:label` : undefined}
                numberOfLines={props.labelNumberOfLines}
                ellipsizeMode={props.labelNumberOfLines === undefined ? undefined : 'tail'}
                style={[styles.label, labelVariantStyle, { color: labelColor }, props.labelNumberOfLines === undefined ? null : { flexShrink: 1 }]}
            >
                {props.label}
            </Text>
        </View>
    );
}
