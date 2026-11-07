import * as React from 'react';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { CapacityRing } from '@/components/ui/progress/CapacityRing';

import { resolveTokenUsageProgressRatio } from './tokenUsageFormatting';
import { useSetting } from '@/sync/domains/state/storage';
import { resolveRemainingUsageColor, resolveTokenUsageToneColor, type TokenUsageTone } from './tokenUsageTone';

type TokenUsageRingMeter = Readonly<{
    used: number;
    limit: number | null | undefined;
    tone?: TokenUsageTone;
    /** When set (and the coloured-rings setting is on) the ring colour follows this remaining %, overriding `tone`. */
    remainingPct?: number;
}>;

export type TokenUsageRingProps = TokenUsageRingMeter & Readonly<{
    label: string;
    value: string;
    /** Multiple limits, outermost first; each keeps its own fill and colour. */
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
    const coloredUsageRings = useSetting('coloredUsageRings');
    const resolveColor = (meter: TokenUsageRingMeter) => meter.remainingPct !== undefined && coloredUsageRings
        ? resolveRemainingUsageColor({
            remainingPct: meter.remainingPct,
            fullColor: theme.colors.state.success.foreground,
            midColor: theme.colors.state.warning.foreground,
            emptyColor: theme.colors.state.danger.foreground,
        })
        : resolveTokenUsageToneColor({
            tone: meter.tone ?? 'neutral',
            neutralColor: theme.colors.text.secondary,
            warningColor: theme.colors.state.neutral.foreground,
            criticalColor: theme.colors.state.danger.foreground,
        });
    const toneColor = resolveColor(props);

    return (
        <CapacityRing
            ratio={progressRatio}
            rings={props.rings?.map((meter) => ({
                ratio: resolveTokenUsageProgressRatio(meter),
                color: resolveColor(meter),
                trackColor: meter.remainingPct !== undefined && meter.remainingPct <= 0 ? resolveColor(meter) : undefined,
            }))}
            size={props.size ?? 20}
            strokeWidth={props.strokeWidth ?? 2}
            color={toneColor}
            trackColor={props.remainingPct !== undefined && props.remainingPct <= 0 ? toneColor : undefined}
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
