import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { Typography } from '@/constants/Typography';
import { Text } from '@/components/ui/text/Text';
import { CapacityRing } from '@/components/ui/progress/CapacityRing';

import { resolveMachineResourcesGaugeColor, type MachineResourcesTone } from './machineResourcesTone';

export type MachineResourcesGaugeProps = Readonly<{
    label: string;
    /** Fill percent 0-100; `null` renders an unmeasured neutral gauge. */
    usagePercent: number | null;
    /** Absolute-value line under the label (e.g. `5.2 GB / 16 GB`); omitted for CPU. */
    detail?: string | null;
    tone: MachineResourcesTone;
    size?: number;
    strokeWidth?: number;
    testID?: string;
    ringTestID?: string;
    progressTestID?: string;
    labelTestID?: string;
    valueTestID?: string;
}>;

const stylesheet = StyleSheet.create((theme) => ({
    gauge: {
        alignItems: 'center',
        gap: 4,
    },
    percent: {
        fontSize: 12,
        lineHeight: 14,
        textAlign: 'center',
        ...Typography.default(),
    },
    label: {
        fontSize: 12,
        lineHeight: 14,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    detail: {
        fontSize: 11,
        lineHeight: 13,
        color: theme.colors.text.tertiary,
        ...Typography.default(),
    },
}));

/**
 * One machine-resource gauge (CPU / Memory / Disk): a thin wrapper over the shared
 * {@link CapacityRing} that owns the percent label, the metric name, and the absolute-value
 * line, so the ring geometry stays with the canonical primitive.
 */
export function MachineResourcesGauge(props: MachineResourcesGaugeProps) {
    const { theme } = useUnistyles();
    const styles = stylesheet;
    const rawPercent = props.usagePercent;
    const measured = typeof rawPercent === 'number' && Number.isFinite(rawPercent);
    // The ring caps at a full circle, but the label keeps the reported value (e.g. a transient
    // CPU overshoot) so the number stays truthful.
    const clampedPercent = measured ? Math.min(100, Math.max(0, rawPercent)) : 0;
    const toneColor = resolveMachineResourcesGaugeColor(props.tone, theme.colors);

    return (
        <View style={styles.gauge}>
            <CapacityRing
                ratio={clampedPercent / 100}
                color={toneColor}
                size={props.size ?? 56}
                strokeWidth={props.strokeWidth ?? 4}
                testID={props.testID}
                ringTestID={props.ringTestID}
                progressTestID={props.progressTestID}
                accessibilityLabel={measured ? `${props.label} ${Math.round(rawPercent)}%` : props.label}
            >
                <Text testID={props.valueTestID} style={[styles.percent, { color: toneColor }]} numberOfLines={1}>
                    {measured ? `${Math.round(rawPercent)}%` : '—'}
                </Text>
            </CapacityRing>
            <Text testID={props.labelTestID} style={styles.label} numberOfLines={1}>
                {props.label}
            </Text>
            {props.detail ? (
                <Text style={styles.detail} numberOfLines={1}>
                    {props.detail}
                </Text>
            ) : null}
        </View>
    );
}
