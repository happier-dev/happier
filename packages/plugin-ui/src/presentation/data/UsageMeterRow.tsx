import * as React from 'react';
import { View, StyleSheet } from 'react-native';
import type { HappierUiTheme } from '../../environment/types.js';
import { useOptionalHappierUiTypography } from '../../environment/context.js';
import { HappierText as Text } from '../text/Text.js';
import { resolveHappierTypeRoleStyle } from '../text/typeRole.js';
import { HAPPIER_PAGE_METRICS } from '../layout/pageMetrics.js';
import { HappierProgress } from '../content/Foundation.js';
import { CapacityBar } from './CapacityBar.js';

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

/**
 * A stack's one name column: every inline row in a {@link UsageMeterStack} reports its name's natural width and
 * takes the widest, so the bars of one table start (and end) on the same x whatever their names (owner 11-01).
 */
type UsageMeterNameColumn = Readonly<{ widthPx: number; report: (rowId: string, widthPx: number | null) => void }>;
const UsageMeterNameColumnContext = React.createContext<UsageMeterNameColumn | null>(null);

/** Where the meter sits: a page or popover row, a narrow card (Home, the grid), or a wide detail. */
export type UsageMeterSize = 'default' | 'card' | 'wide';

/** Presentation facts only: callers own units, localized wording, quota thresholds and time. */
export type UsageMeterTone = 'success' | 'neutral' | 'warning' | 'danger';
export type UsageMeterRowProps = Readonly<{
    theme: HappierUiTheme;
    label: string;
    /** Remaining percentage on the caller's quota axis, or null when unknown/uncapped. */
    remainingPct: number | null;
    /** Fully formatted value, including estimated or unavailable wording. */
    value: string;
    valueKnown: boolean;
    /** Amount values grow to fit; an uncapped amount draws no exhausted-looking bar. */
    amount?: boolean;
    resetText?: string;
    /** Optional clock-time wording used only when a wide row has room. */
    wideResetText?: string;
    accessibilityLabel: string;
    wideAccessibilityLabel?: string;
    tone?: UsageMeterTone;
    loading?: boolean;
    layout?: 'inline' | 'stacked';
    size?: UsageMeterSize;
    pace?: Readonly<{ evenPaceRemainingFraction: number; projectedRemainingFraction: number }>;
    neutralFillColor?: string;
    trackColor?: string;
    placeholderColor?: string;
    testID?: string;
}>;

export const UsageMeterRow = React.memo(function UsageMeterRow(props: UsageMeterRowProps) {
    const { theme } = props;
    const typography = useOptionalHappierUiTypography();
    const styles = React.useMemo(() => createStyles(theme, typography, props.placeholderColor), [theme, typography, props.placeholderColor]);
    const remaining = props.remainingPct;
    const barTone = props.tone === 'success' ? 'neutral' : props.tone ?? 'neutral';
    const fillColor = barTone === 'neutral' ? props.neutralFillColor ?? theme.colors.secondaryText : theme.colors[barTone];
    const [width, setWidth] = React.useState<number | null>(null);
    const nameColumn = React.useContext(UsageMeterNameColumnContext);
    const rowId = React.useId();
    const reportName = nameColumn?.report;
    React.useEffect(() => () => reportName?.(rowId, null), [reportName, rowId]);
    const size = props.size === 'wide' && width !== null && width < HAPPIER_PAGE_METRICS.rowStackBelowWidthPx ? 'default' : props.size ?? 'default';
    const amountMode = props.amount === true;
    const valueKnown = props.valueKnown;
    const value = props.value;
    const resetAt = (size === 'wide' ? props.wideResetText : undefined) ?? props.resetText ?? '';
    const accessibilityLabel = (size === 'wide' ? props.wideAccessibilityLabel : undefined) ?? props.accessibilityLabel;
    const valueStyle = [
        styles.value,
        !valueKnown ? styles.valueUnknown : null,
        props.tone === 'warning' ? styles.valueWarning : null,
        props.tone === 'danger' ? styles.valueDanger : null,
    ];
    const pace = props.pace && remaining !== null ? props.pace : null;
    const bar = amountMode && remaining === null ? null : pace ? (
        <CapacityBar theme={theme} label={accessibilityLabel} value={remaining} capacity={100}
            evenPace={pace.evenPaceRemainingFraction * 100} projected={pace.projectedRemainingFraction * 100}
            projection="remaining" showCaption={false} height={USAGE_METER_METRICS.barHeightPx}
            color={fillColor} markerColor={theme.colors.text}
            trackColor={props.trackColor ?? theme.colors.divider}
            style={props.layout === 'stacked' ? undefined : styles.bar}
            testID={props.testID ? `${props.testID}:bar` : undefined} />
    ) : (
        <View testID={props.testID ? `${props.testID}:bar` : undefined} style={props.layout === 'stacked' ? undefined : styles.bar}>
            <HappierProgress theme={theme} semantics="none" label=""
                value={remaining !== null ? remaining / 100 : 0}
                height={USAGE_METER_METRICS.barHeightPx} fillColor={fillColor}
                trackColor={props.trackColor ?? theme.colors.divider}
                testID={props.testID ? `${props.testID}:bar:track` : undefined}
                fillTestID={props.testID ? `${props.testID}:bar:fill` : undefined}
                style={{ width: '100%' }} />
        </View>
    );
    if (props.layout === 'stacked') {
        return (
            <View testID={props.testID} style={styles.stacked} accessible accessibilityLabel={accessibilityLabel}>
                <View style={styles.stackedLine}>
                    <Text style={[styles.label, styles.stackedLabel]}>{props.label}</Text>
                    {props.loading
                        ? <View style={styles.valuePlaceholder} />
                        : <Text tabularNumbers style={[valueStyle, styles.stackedValue]}>{value}</Text>}
                </View>
                {bar}
                {resetAt ? (
                    <Text tabularNumbers style={[styles.reset, styles.stackedReset]} numberOfLines={1}>{resetAt}</Text>
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
            {/* The name holds its column (its stack's widest name) and grows past it rather than truncating while the
                bar has room; the name itself is measured at its own width so the stack can find the widest. */}
            <View style={[styles.labelColumn, { minWidth: Math.max(labelWidth, nameColumn?.widthPx ?? 0) }]}>
                <Text style={[styles.label, styles.inlineLabel]} onLayout={reportName ? (event) => {
                    const next = event.nativeEvent.layout.width;
                    if (Number.isFinite(next) && next > 0) reportName(rowId, Math.ceil(next));
                } : undefined}>{props.label}</Text>
            </View>
            {bar ?? <View style={styles.bar} />}
            {props.loading ? (
                <View style={[styles.valueSlot, { marginRight: resetWidth + USAGE_METER_METRICS.gapPx }]}>
                    <View style={styles.valuePlaceholder} />
                </View>
            ) : amountMode ? (
                <>
                    <Text tabularNumbers style={[valueStyle, styles.amount]}>{value}</Text>
                    {resetAt ? <Text tabularNumbers style={[styles.reset, { width: resetWidth }]} numberOfLines={1}>{resetAt}</Text> : null}
                </>
            ) : remaining === null ? (
                // Unknown usage spans both columns so the unavailable label and any reset remain readable.
                <Text style={[styles.value, styles.valueUnknown, { width: USAGE_METER_METRICS.valueWidthPx + USAGE_METER_METRICS.gapPx + resetWidth, textAlign: 'left' }]}>
                    {resetAt ? `${value} · ${resetAt}` : value}
                </Text>
            ) : (
                <>
                    <Text tabularNumbers style={valueStyle}>{value}</Text>
                    <Text tabularNumbers style={[styles.reset, { width: resetWidth }]} numberOfLines={1}>{resetAt}</Text>
                </>
            )}
        </View>
    );
});

export type UsageMeterStackProps = Readonly<{ children: React.ReactNode; testID?: string }>;

/** A stack of meters with the shared row gap and one name column, so it reads as one table. */
export const UsageMeterStack = React.memo(function UsageMeterStack(props: UsageMeterStackProps) {
    const [names, setNames] = React.useState<ReadonlyMap<string, number>>(() => new Map());
    const report = React.useCallback((rowId: string, widthPx: number | null) => setNames((current) => {
        if ((current.get(rowId) ?? null) === widthPx) return current;
        const next = new Map(current);
        if (widthPx === null) next.delete(rowId); else next.set(rowId, widthPx);
        return next;
    }), []);
    const widthPx = names.size > 0 ? Math.max(...names.values()) : 0;
    const column = React.useMemo(() => ({ widthPx, report }), [report, widthPx]);
    return (
        <UsageMeterNameColumnContext.Provider value={column}>
            <View testID={props.testID} style={{ gap: USAGE_METER_METRICS.rowGapPx }}>{props.children}</View>
        </UsageMeterNameColumnContext.Provider>
    );
});

function createStyles(theme: HappierUiTheme, typography: ReturnType<typeof useOptionalHappierUiTypography>, placeholderColor?: string) {
    return StyleSheet.create({
        row: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: USAGE_METER_METRICS.gapPx,
        },
        stacked: {
            gap: theme.spacing.xsmall,
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
            width: USAGE_METER_METRICS.labelWidthPx,
            ...resolveHappierTypeRoleStyle('meta', theme, typography),
            color: theme.colors.secondaryText,
        },
        inlineLabel: {
            width: 'auto',
            alignSelf: 'flex-start',
        },
        labelColumn: {
            flexShrink: 1,
            minWidth: 0,
        },
        bar: {
            flex: 1,
            minWidth: USAGE_METER_METRICS.minBarWidthPx,
        },
        value: {
            minWidth: USAGE_METER_METRICS.valueWidthPx,
            flexShrink: 0,
            textAlign: 'right',
            ...resolveHappierTypeRoleStyle('meta', theme, typography, 'medium'),
            color: theme.colors.text,
        },
        /** An amount keeps the value column's minimum and grows for "$7.00 of $10.00 left". */
        amount: {
            minWidth: USAGE_METER_METRICS.valueWidthPx,
        },
        valueSlot: {
            width: USAGE_METER_METRICS.valueWidthPx,
            alignItems: 'flex-end',
        },
        valuePlaceholder: {
            width: 44,
            height: 9,
            borderRadius: 4,
            backgroundColor: placeholderColor ?? theme.colors.controlDisabled,
        },
        valueUnknown: {
            ...resolveHappierTypeRoleStyle('micro', theme, typography),
            color: theme.colors.mutedText,
        },
        valueWarning: {
            color: theme.statusText?.warning ?? theme.colors.warning,
        },
        valueDanger: {
            color: theme.statusText?.danger ?? theme.colors.danger,
        },
        reset: {
            width: USAGE_METER_METRICS.resetWidthPx,
            textAlign: 'right',
            ...resolveHappierTypeRoleStyle('micro', theme, typography),
            color: theme.colors.mutedText,
        },
    });
}
