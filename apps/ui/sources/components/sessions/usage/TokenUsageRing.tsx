import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { CapacityRing, getConcentricCapacityRingSize } from '@/components/ui/progress/CapacityRing';

import { resolveTokenUsageProgressRatio } from './tokenUsageFormatting';
import { resolveTokenUsageToneColor, type TokenUsageTone } from './tokenUsageTone';

type TokenUsageRingMeter = Readonly<{
    used: number;
    limit: number | null | undefined;
    tone?: TokenUsageTone;
}>;

export type TokenUsageRingProps = TokenUsageRingMeter & Readonly<{
    label: string;
    value: string;
    /** Per-window fills and tones, outermost first; the center value is independent. */
    rings?: readonly TokenUsageRingMeter[];
    size?: number;
    strokeWidth?: number;
    testID?: string;
    ringTestID?: string;
    valueTestID?: string;
    progressTestID?: string;
}>;

/**
 * Token-budget usage ring. A thin, token-domain wrapper over the shared
 * {@link CapacityRing}: it owns the token tone→color mapping and the centered
 * `used / limit` label, and delegates all ring geometry to the canonical
 * primitive so the gauge never drifts from the connected-service capacity rings.
 */
export function TokenUsageRing(props: TokenUsageRingProps) {
    const { theme } = useUnistyles();
    const progressRatio = React.useMemo(
        () => resolveTokenUsageProgressRatio({ used: props.used, limit: props.limit }),
        [props.limit, props.used],
    );
    const toneColor = React.useMemo(
        () => resolveTokenUsageToneColor({
            tone: props.tone ?? 'neutral',
            neutralColor: theme.colors.text.secondary,
            warningColor: theme.colors.state.neutral.foreground,
            criticalColor: theme.colors.state.danger.foreground,
        }),
        [
            props.tone,
            theme.colors.state.danger.foreground,
            theme.colors.state.neutral.foreground,
            theme.colors.text.secondary,
        ],
    );

    return (
        <CapacityRing
            ratio={progressRatio}
            rings={props.rings?.map(meter => ({
                ratio: resolveTokenUsageProgressRatio(meter),
                color: resolveTokenUsageToneColor({
                    tone: meter.tone ?? 'neutral',
                    neutralColor: theme.colors.text.secondary,
                    warningColor: theme.colors.state.neutral.foreground,
                    criticalColor: theme.colors.state.danger.foreground,
                }),
            }))}
            size={getConcentricCapacityRingSize(props.size ?? 20, props.rings?.length ?? 1, props.strokeWidth ?? 2)}
            strokeWidth={props.strokeWidth ?? 2}
            color={toneColor}
            testID={props.testID}
            ringTestID={props.ringTestID}
            progressTestID={props.progressTestID}
            accessibilityLabel={props.label}
        >
            <Text
                testID={props.valueTestID}
                style={[styles.value, { color: toneColor }]}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.5}
            >
                {props.value}
            </Text>
        </CapacityRing>
    );
}

const styles = StyleSheet.create(() => ({
    value: {
        fontSize: 8,
        lineHeight: 8,
        textAlign: 'center',
        ...Typography.default(),
    },
}));
