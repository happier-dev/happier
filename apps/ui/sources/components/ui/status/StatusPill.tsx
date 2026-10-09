import * as React from 'react';
import { View, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import { HappierBadge } from '@happier-dev/plugin-ui/presentation';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { FontWeights, Typography } from '@/constants/Typography';

import { StatusDot } from './StatusDot';

export const STATUS_PILL_VARIANTS = [
    'success',
    'warning',
    'attention',
    'danger',
    'info',
    'neutral',
] as const;

export type StatusPillVariant = (typeof STATUS_PILL_VARIANTS)[number];

type HappierBadgeStyle = React.ComponentProps<typeof HappierBadge>['style'];

type StateColors = Readonly<{ foreground: string; background: string; border: string }>;

/**
 * "Needs you" (DESIGN.md, "One attention colour"): the Brand-owned attention amber for its ink and ring.
 * The amber has no tint token of its own, so its faint ground is the warning tint (the attention ink is
 * asserted AA on it in `themeContrast.test.ts`). The one owner of the attention triple: status pills and
 * the Work status treatment both draw it from here.
 */
export function resolveAttentionStateColors(state: Readonly<{
    attention: Readonly<{ foreground: string }>;
    warning: Readonly<{ background: string }>;
}>): StateColors {
    return { foreground: state.attention.foreground, background: state.warning.background, border: state.attention.foreground };
}

export function resolveStatusPillVariantForState(
    state: 'live' | 'needsAttention' | 'neutral',
): StatusPillVariant {
    if (state === 'live') return 'success';
    if (state === 'needsAttention') return 'attention';
    return 'neutral';
}

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
    /** Label type beyond the variant's role (the composer badge's heavier phrase). */
    labelStyle?: StyleProp<TextStyle>;
    /**
     * `rect` (default): the shared status geometry. `capsule`: a badge that is itself a control among
     * capsule chips (the composer status row).
     */
    shape?: 'rect' | 'capsule';
    /** A trailing mark (the caret of a badge that opens a popover). */
    trailing?: React.ReactNode;
    testID?: string;
    variantTestID?: string;
    accessibilityLabel?: string;
    style?: StyleProp<ViewStyle>;
}>;

function resolvePillLabelTypography() {
    const helpers = Typography as Readonly<{
        pillLabel?: () => object;
        default?: (weight?: 'regular' | 'italic' | 'semiBold') => object;
    }>;
    return typeof helpers.pillLabel === 'function'
        ? helpers.pillLabel()
        : (helpers.default?.('semiBold') ?? {});
}

function resolveTabularTypography() {
    const helpers = Typography as Readonly<{
        tabular?: () => object;
    }>;
    return helpers.tabular?.() ?? {};
}

const stylesheet = StyleSheet.create(() => ({
    plainContainer: {
        gap: 4,
    },
    variantMarker: {
        position: 'absolute',
        width: 0,
        height: 0,
        opacity: 0,
    },
    label: {
        ...resolvePillLabelTypography(),
    },
    // Ordinary 11px chrome type, matching the status text a phrase pill sits beside.
    phraseLabel: {
        ...Typography.default(),
        fontSize: 11,
        // The regular Inter face carries its weight; reset any explicit weight
        // from a preceding label style so phrase pills remain regular.
        fontWeight: FontWeights.regular,
        letterSpacing: 0,
    },
}));

/**
 * Core's semantic status pill: the variant → state colours, the status dot and the app's scaled pill type.
 * The chrome itself (radius, padding, gap, background-only fill) is the shared badge geometry
 * (`HappierBadge` / `HAPPIER_BADGE_METRICS`), so a core pill and a plugin author's `Badge` cannot drift.
 */
export function StatusPill(props: StatusPillProps): React.ReactElement {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const state: StateColors = props.variant === 'attention'
        ? resolveAttentionStateColors(theme.colors.state)
        : theme.colors.state[props.variant];
    const chrome = props.chrome ?? 'pill';
    const plain = chrome === 'plain';
    const foregroundColor = props.foregroundColor ?? state.foreground;
    const labelVariantStyle = props.labelVariant === 'phrase' ? styles.phraseLabel : null;
    const dotColor = props.dotColor ?? foregroundColor;
    const leading = props.leading ?? (props.hideDot ? null : (
        <StatusDot
            testID={props.testID ? `${props.testID}:dot` : undefined}
            color={dotColor}
            isPulsing={props.isPulsing}
        />
    ));

    return (
        <HappierBadge
            testID={props.testID}
            accessibilityLabel={props.accessibilityLabel ?? props.label}
            color={foregroundColor}
            backgroundColor={plain ? 'transparent' : state.background}
            shape={props.shape}
            {...(plain ? { horizontalPadding: 0, verticalPadding: 0 } : {})}
            // Core's RN style prop crosses into the portable badge style at this one adapter boundary.
            style={[plain ? styles.plainContainer : null, props.style] as HappierBadgeStyle}
            leading={(
                <>
                    <View
                        testID={props.variantTestID ?? (props.testID ? `${props.testID}:variant:${props.variant}` : undefined)}
                        pointerEvents="none"
                        style={styles.variantMarker}
                    />
                    {leading}
                </>
            )}
            trailing={props.trailing}
        >
            <>
                {props.count !== undefined ? (
                    <Text
                        testID={props.testID ? `${props.testID}:count` : undefined}
                        style={[styles.label, labelVariantStyle, resolveTabularTypography(), { color: foregroundColor }]}
                    >
                        {props.count}
                    </Text>
                ) : null}
                <Text
                    testID={props.testID ? `${props.testID}:label` : undefined}
                    numberOfLines={props.labelNumberOfLines}
                    ellipsizeMode={props.labelNumberOfLines === undefined ? undefined : 'tail'}
                    style={[styles.label, labelVariantStyle, { color: foregroundColor }, props.labelStyle, props.labelNumberOfLines === undefined ? null : { flexShrink: 1 }]}
                >
                    {props.label}
                </Text>
            </>
        </HappierBadge>
    );
}
