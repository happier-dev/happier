import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { CapacityBar } from '@happier-dev/plugin-ui/presentation';
import { projectPluginUiTheme } from '@/components/plugins/surfaces/pluginUiThemeProjection';

import { MeterBar, type MeterTone } from '@/components/ui/lists/MeterBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { formatResetCountdown } from '@/sync/domains/connectedServices/formatResetCountdown';
import { t } from '@/text';
import { formatResetAtTime } from '@/utils/time/formatResetAtTime';
import { PAGE_LIST_METRICS } from '@/components/ui/lists/pageListMetrics';

import { ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER } from '../account/accountBlockFormatters';

/**
 * The shared column widths of a usage meter: window name, the bar (flexible), what is left, when it
 * resets. Every usage surface (the Connected services page, account detail, the Usage popover and its
 * peek, Home) renders meters through `UsageMeterRow`, so their columns line up everywhere.
 */
export const USAGE_METER_METRICS = Object.freeze({
    /**
     * The name column every meter starts at ("Weekly · Sonnet" fits); a longer name grows past it while the
     * bar keeps `minBarWidthPx`. The narrow card column is `cardLabelWidthPx`.
     */
    labelWidthPx: 100,
    cardLabelWidthPx: 70,
    valueWidthPx: 62,
    /** The countdown ("in 4d 6h", "next in 3d 2h"); wide surfaces add the clock time. */
    resetWidthPx: 72,
    cardResetWidthPx: 66,
    wideResetWidthPx: 136,
    minBarWidthPx: 28,
    gapPx: 8,
    barHeightPx: 5,
    rowGapPx: 7,
});

/** Where the meter sits: a page or popover row, a narrow card (Home, the grid), or a wide detail. */
export type UsageMeterSize = 'default' | 'card' | 'wide';

export type UsageMeterRowProps = Readonly<{
    /** The window's name as the provider reports it ("5-hour", "Weekly"). */
    label: string;
    /** What is left, 0–100, or null when the provider reported nothing for the window. */
    remainingPct: number | null;
    resetsAt: number | null;
    /** From `resolveQuotaTone`/`resolveQuotaMeterTone`, the one threshold owner. */
    tone: MeterTone;
    now: number;
    /** The value is still being read: the row keeps its place with a quiet placeholder. */
    loading?: boolean;
    /**
     * `inline` (default): one line — name, bar, what is left, reset time — in the shared columns.
     * `stacked`: for a narrow card (Home's usage grid): name and what is left above the bar, then
     * "resets …" beneath it.
     */
    layout?: 'inline' | 'stacked';
    /** Column widths for where the meter sits; `wide` also names the clock time of the reset. */
    size?: UsageMeterSize;
    /** A pool's aggregate reads "next in …": the earliest of its members' resets. */
    resetPrefix?: 'next';
    /** A window without a countdown names its period instead ("monthly"). */
    resetText?: string;
    /** The provider estimated the value: it reads "~58% left". */
    estimated?: boolean;
    /**
     * The B pace owner's facts on this meter's own "left" axis: a tick where an even pace would leave
     * the window now, and the share this pace uses before the reset drawn hatched. Absent means none.
     */
    pace?: Readonly<{ evenPaceRemainingFraction: number; projectedRemainingFraction: number }>;
    testID?: string;
}>;

/**
 * THE quota row: one usage window as its name, a bar filled with what is LEFT (0 when exhausted, no
 * minimum sliver), "42% left" and the reset time. Every readable quota row renders through it — the
 * Connected services page and account disclosure, account detail, the Usage popover, the usage
 * dashboard, the composer's quota popover and Home. Healthy windows stay quiet (neutral fill); only
 * warning and danger carry colour, on both bar and value. `MeterBar` below is geometry only.
 */
export const UsageMeterRow = React.memo(function UsageMeterRow(props: UsageMeterRowProps) {
    const { theme } = useUnistyles();
    const presentationTheme = React.useMemo(() => projectPluginUiTheme(theme), [theme]);
    const styles = stylesheet;
    const known = props.remainingPct !== null && Number.isFinite(props.remainingPct);
    const remaining = known ? Math.max(0, Math.min(100, Math.round(props.remainingPct!))) : null;
    // Healthy is quiet: colour is reserved for a window that needs attention.
    const barTone: MeterTone = props.tone === 'success' ? 'neutral' : props.tone;
    const [width, setWidth] = React.useState<number | null>(null);
    const size = props.size === 'wide' && width !== null && width < PAGE_LIST_METRICS.rowStackBelowWidthPx ? 'default' : props.size ?? 'default';
    const left = remaining !== null
        ? ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER.remaining({ percent: `${remaining}%` })
        : null;
    const value = left === null
        ? t('common.unavailable')
        : props.estimated ? t('connectedServicesCollection.meterEstimated', { value: left }) : left;
    const countdown = formatResetCountdown(props.now, props.resetsAt, ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER);
    const relative = countdown === null
        ? null
        : props.resetPrefix === 'next'
            ? t('connectedServicesCollection.meterNextResetIn', { time: countdown })
            : t('connectedServicesCollection.meterResetsIn', { time: countdown });
    const resetAt = props.resetText
        ?? (relative === null
            ? ''
            : size === 'wide' && props.resetsAt !== null
                ? t('connectedServicesCollection.meterResetsAt', { countdown: relative, time: formatResetAtTime(props.resetsAt, props.now) })
                : relative);
    const paceLabel = props.pace && remaining !== null ? t('usage.board.plans.meterPaceAccessibility', {
        even: `${Math.round(props.pace.evenPaceRemainingFraction * 100)}%`,
        projected: `${Math.round(props.pace.projectedRemainingFraction * 100)}%`,
    }) : null;
    const baseAccessibilityLabel = props.loading
        ? props.label
        : remaining !== null && countdown
        ? `${props.label}, ${ACCOUNT_BLOCK_GAUGE_LABEL_FORMATTER.remainingWithReset({ percent: `${remaining}%`, reset: countdown })}`
        : `${props.label}, ${value}${resetAt ? `, ${resetAt}` : ''}`;
    const accessibilityLabel = paceLabel ? `${baseAccessibilityLabel}; ${paceLabel}` : baseAccessibilityLabel;
    const valueStyle = [
        styles.value,
        remaining === null ? styles.valueUnknown : null,
        props.tone === 'warning' ? styles.valueWarning : null,
        props.tone === 'danger' ? styles.valueDanger : null,
    ];
    const pace = props.pace && remaining !== null ? props.pace : null;
    const bar = pace ? (
        <CapacityBar theme={presentationTheme} label={accessibilityLabel} value={remaining} capacity={100}
            evenPace={pace.evenPaceRemainingFraction * 100} projected={pace.projectedRemainingFraction * 100}
            projection="remaining" showCaption={false} height={USAGE_METER_METRICS.barHeightPx}
            color={theme.colors.state[barTone].foreground} markerColor={theme.colors.text.primary}
            trackColor={theme.dark ? theme.colors.surface.pressedOverlay : theme.colors.border.default}
            style={props.layout === 'stacked' ? undefined : styles.bar}
            testID={props.testID ? `${props.testID}:bar` : undefined} />
    ) : (
        <MeterBar
            testID={props.testID ? `${props.testID}:bar` : undefined}
            style={props.layout === 'stacked' ? undefined : styles.bar}
            height={USAGE_METER_METRICS.barHeightPx}
            tone={barTone}
            fillFraction={remaining !== null ? remaining / 100 : 0}
        />
    );
    if (props.layout === 'stacked') {
        return (
            <View testID={props.testID} style={styles.stacked} accessible accessibilityLabel={accessibilityLabel}>
                <View style={styles.stackedLine}>
                    <Text style={[styles.label, styles.stackedLabel]}>{props.label}</Text>
                    {props.loading
                        ? <View style={styles.valuePlaceholder} />
                        : <Text style={[valueStyle, styles.stackedValue]}>{value}</Text>}
                </View>
                {bar}
                {resetAt ? (
                    <Text style={[styles.reset, styles.stackedReset]} numberOfLines={1}>{resetAt}</Text>
                ) : null}
            </View>
        );
    }
    const labelWidth = size === 'card' ? USAGE_METER_METRICS.cardLabelWidthPx : USAGE_METER_METRICS.labelWidthPx;
    const resetWidth = size === 'card'
        ? USAGE_METER_METRICS.cardResetWidthPx
        : size === 'wide' ? USAGE_METER_METRICS.wideResetWidthPx : USAGE_METER_METRICS.resetWidthPx;
    return (
        <View testID={props.testID} style={styles.row} onLayout={(event) => {
            const next = event.nativeEvent.layout.width;
            if (Number.isFinite(next) && next > 0) setWidth(next);
        }} accessible accessibilityLabel={accessibilityLabel}>
            {/* The name holds its column and grows past it rather than truncating while the bar has room. */}
            <Text style={[styles.label, styles.inlineLabel, { minWidth: labelWidth }]}>{props.label}</Text>
            {bar}
            {props.loading ? (
                <View style={[styles.valueSlot, { marginRight: resetWidth + USAGE_METER_METRICS.gapPx }]}>
                    <View style={styles.valuePlaceholder} />
                </View>
            ) : remaining === null ? (
                // Unknown usage spans both columns so the unavailable label and any reset remain readable.
                <Text style={[styles.value, styles.valueUnknown, { width: USAGE_METER_METRICS.valueWidthPx + USAGE_METER_METRICS.gapPx + resetWidth, textAlign: 'left' }]}>
                    {resetAt ? `${value} · ${resetAt}` : value}
                </Text>
            ) : (
                <>
                    <Text style={valueStyle}>{value}</Text>
                    <Text style={[styles.reset, { width: resetWidth }]} numberOfLines={1}>{resetAt}</Text>
                </>
            )}
        </View>
    );
});

/** A stack of meters with the shared row gap. */
export const UsageMeterStack = React.memo(function UsageMeterStack(props: Readonly<{ children: React.ReactNode; testID?: string }>) {
    return <View testID={props.testID} style={stylesheet.stack}>{props.children}</View>;
});

const stylesheet = StyleSheet.create((theme) => ({
    stack: {
        gap: USAGE_METER_METRICS.rowGapPx,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: USAGE_METER_METRICS.gapPx,
    },
    stacked: {
        gap: 5,
    },
    stackedLine: {
        flexDirection: 'row',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: USAGE_METER_METRICS.gapPx,
    },
    stackedLabel: {
        width: 'auto',
        flexShrink: 1,
    },
    stackedValue: {
        width: 'auto',
        flexShrink: 0,
    },
    stackedReset: {
        width: 'auto',
        textAlign: 'left',
    },
    label: {
        ...Typography.default(),
        width: USAGE_METER_METRICS.labelWidthPx,
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
    },
    inlineLabel: {
        width: 'auto',
        flexShrink: 1,
    },
    bar: {
        flex: 1,
        minWidth: USAGE_METER_METRICS.minBarWidthPx,
    },
    value: {
        ...Typography.default('medium'),
        minWidth: USAGE_METER_METRICS.valueWidthPx,
        flexShrink: 0,
        textAlign: 'right',
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
    },
    valueSlot: {
        width: USAGE_METER_METRICS.valueWidthPx,
        alignItems: 'flex-end',
    },
    valuePlaceholder: {
        width: 44,
        height: 9,
        borderRadius: 4,
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    valueUnknown: {
        ...Typography.default(),
        fontSize: 11.5,
        color: theme.colors.text.tertiary,
    },
    valueWarning: {
        color: theme.colors.state.warning.foreground,
    },
    valueDanger: {
        color: theme.colors.state.danger.foreground,
    },
    reset: {
        ...Typography.default(),
        width: USAGE_METER_METRICS.resetWidthPx,
        textAlign: 'right',
        fontSize: 11.5,
        lineHeight: 16,
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
}));
