import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { ChartTooltip } from '@/components/ui/charts';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { UsagePunchCard } from '@/sync/api/account/usageAnalytics';
import { usageSignatureAccent, withUsageAccentAlpha } from '../usageAccent';

/**
 * Band 3 "When you work" punch card (E-2): the received 7×24 weekday×hour grid
 * rendered as a WakaTime-style dot matrix. Cell fill is the signature accent at
 * an alpha proportional to its value (empty cells are a hairline track), the
 * busiest cell is annotated inline, and every cell carries the ONE ChartTooltip
 * owner with its exact weekday · hour · events. Replaces the separate weekday
 * bars; the 24-hour rhythm survives only as the <480px compact variant.
 */
export type PunchCardProps = Readonly<{
    punchCard: UsagePunchCard;
    testID?: string;
}>;

const AXIS_HOURS = [0, 6, 12, 18] as const;
/** Minimum accent alpha for a cell that has ANY activity (keeps low cells legible). */
const MIN_CELL_ALPHA = 0.16;

function formatFullHour(hour: number): string {
    const period = hour < 12 ? 'AM' : 'PM';
    const base = hour % 12 === 0 ? 12 : hour % 12;
    return `${base} ${period}`;
}

function formatAxisHour(hour: number): string {
    const period = hour < 12 ? 'A' : 'P';
    const base = hour % 12 === 0 ? 12 : hour % 12;
    return `${base}${period}`;
}

/** Locale-aware weekday initials (narrow) and full names, Sun→Sat. */
function weekdayLabels(style: 'narrow' | 'long'): string[] {
    const formatter = new Intl.DateTimeFormat(undefined, { weekday: style });
    // 2024-01-07 is a Sunday (UTC).
    return Array.from({ length: 7 }, (_value, index) =>
        formatter.format(new Date(Date.UTC(2024, 0, 7 + index))));
}

export const PunchCard = React.memo(function PunchCard(props: PunchCardProps) {
    const { theme } = useUnistyles();
    const { punchCard } = props;
    const accent = usageSignatureAccent(theme);
    const peak = Math.max(1, punchCard.peak);
    const initials = React.useMemo(() => weekdayLabels('narrow'), []);
    const names = React.useMemo(() => weekdayLabels('long'), []);
    const busiest = punchCard.busiest;

    return (
        <View style={styles.root} testID={props.testID}>
            {busiest ? (
                <Text style={styles.busiestTag} numberOfLines={1} testID="usage-punchcard-busiest">
                    <Text style={styles.busiestValue}>
                        {`${names[busiest.weekday] ?? ''} · ${formatFullHour(busiest.hour)}`}
                    </Text>
                    {` · ${t('usage.busiestTag')}`}
                </Text>
            ) : null}
            {punchCard.cells.map((hours, weekday) => (
                <View key={weekday} style={styles.weekRow}>
                    <Text style={styles.rowLabel} numberOfLines={1}>{initials[weekday] ?? ''}</Text>
                    <View style={styles.cellRow}>
                        {hours.map((eventCount, hour) => {
                            const isBusiest = busiest?.weekday === weekday && busiest?.hour === hour;
                            const ratio = eventCount > 0 ? eventCount / peak : 0;
                            const alpha = eventCount > 0 ? MIN_CELL_ALPHA + (1 - MIN_CELL_ALPHA) * ratio : 0;
                            return (
                                <View key={hour} style={styles.cellSlot}>
                                    <ChartTooltip
                                        triggerTestID="usage-punchcard-cell-trigger"
                                        title={`${names[weekday] ?? ''} · ${formatFullHour(hour)}`}
                                        value={`${eventCount.toLocaleString()} ${t('usage.events')}`}
                                        accentColor={accent}
                                    >
                                        <View
                                            style={[
                                                styles.cell,
                                                {
                                                    backgroundColor: eventCount > 0
                                                        ? withUsageAccentAlpha(accent, alpha)
                                                        : theme.colors.border.default,
                                                    opacity: eventCount > 0 ? 1 : 0.4,
                                                },
                                                isBusiest ? { borderColor: accent, borderWidth: StyleSheet.hairlineWidth } : null,
                                            ]}
                                        />
                                    </ChartTooltip>
                                </View>
                            );
                        })}
                    </View>
                </View>
            ))}
            <View style={styles.axisRow}>
                <View style={styles.rowLabelSpacer} />
                <View style={styles.axisLabels}>
                    {AXIS_HOURS.map((hour) => (
                        <Text key={hour} style={styles.axisLabel}>{formatAxisHour(hour)}</Text>
                    ))}
                </View>
            </View>
        </View>
    );
});

const ROW_LABEL_WIDTH = 16;

const styles = StyleSheet.create((theme) => ({
    root: {
        gap: 4,
    },
    busiestTag: {
        ...Typography.default(),
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.text.tertiary,
        marginBottom: 4,
    },
    busiestValue: {
        ...Typography.default('semiBold'),
        color: theme.colors.text.primary,
    },
    weekRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    rowLabel: {
        ...Typography.default(),
        width: ROW_LABEL_WIDTH,
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.text.tertiary,
    },
    cellRow: {
        flex: 1,
        flexDirection: 'row',
        gap: 3,
    },
    cellSlot: {
        flex: 1,
        minWidth: 0,
    },
    cell: {
        width: '100%',
        aspectRatio: 1,
        borderRadius: 2,
    },
    axisRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginTop: 2,
    },
    rowLabelSpacer: {
        width: ROW_LABEL_WIDTH,
    },
    axisLabels: {
        flex: 1,
        flexDirection: 'row',
        justifyContent: 'space-between',
    },
    axisLabel: {
        ...Typography.default(),
        fontSize: 11,
        lineHeight: 14,
        color: theme.colors.text.tertiary,
        fontVariant: ['tabular-nums'],
    },
}));
