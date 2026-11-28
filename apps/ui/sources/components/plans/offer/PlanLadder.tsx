import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Icon } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';

import {
    formatPinLimit,
    formatPrice,
    formatRetentionPeriod,
    formatStorageLimit,
    nextPlanUp,
    type PlanLadderColumn,
} from '../planSurfaceCopy';

type LadderRow = Readonly<{
    id: 'sessions' | 'subagents' | 'pins' | 'files' | 'pack';
    title: string;
    hint?: string;
    value: (column: PlanLadderColumn) => string | null;
}>;

function buildRows(columns: readonly PlanLadderColumn[]): LadderRow[] {
    const rows: LadderRow[] = [
        { id: 'sessions', title: t('planSurface.ladderSessions'), hint: t('planSurface.ladderSessionsHint'), value: (c) => formatRetentionPeriod(c.limits.sessionRetentionDays) },
        { id: 'subagents', title: t('planSurface.ladderSubagents'), value: (c) => formatRetentionPeriod(c.limits.subagentRetentionDays) },
        { id: 'pins', title: t('planSurface.ladderPins'), value: (c) => formatPinLimit(c.limits.pinnedSessions) },
    ];
    // A server without a file budget (every 0.2 server) has no files row at all.
    if (columns.some((column) => column.limits.artifactStorageBytes !== null)) {
        rows.push({ id: 'files', title: t('planSurface.ladderFiles'), value: (c) => formatStorageLimit(c.limits.artifactStorageBytes) });
    }
    rows.push({ id: 'pack', title: t('planSurface.ladderPack'), value: () => null });
    return rows;
}

export type PlanLadderProps = Readonly<{
    columns: readonly PlanLadderColumn[];
    /** Phone composition: CTAs leave the grid and stack beneath it with their price. */
    compact: boolean;
    /** False where plans cannot be bought on this platform yet; the comparison still shows. */
    purchasable: boolean;
    busyPlanId: string | null;
    onChoosePlan: (planId: string) => void;
}>;

/** The ladder's footnote, shown as its group's footer. */
export function planLadderFootnote(params: Readonly<{ purchasable: boolean; graceDays: number }>): string {
    return params.purchasable
        ? t('planSurface.billedMonthly', { days: params.graceDays })
        : t('planSurface.storePurchaseUnavailable');
}

/**
 * "Keep more": one sheet comparing the offered plans row by row, the person's plan marked, the
 * top plan's column tinted and its button primary (Decided 9). Every value is drawn from the plan
 * read; a plan the server did not offer has no column.
 */
export const PlanLadder = React.memo(function PlanLadder(props: PlanLadderProps) {
    const { theme } = useUnistyles();
    const rows = React.useMemo(() => buildRows(props.columns), [props.columns]);
    const top = props.columns[props.columns.length - 1] ?? null;
    const current = props.columns.find((column) => column.current) ?? null;
    const upgrade = nextPlanUp(props.columns);
    const ctaFor = (column: PlanLadderColumn): React.ReactNode => {
        if (!props.purchasable || !column.price || column.current) return null;
        const currentIndex = props.columns.findIndex((candidate) => candidate.current);
        const index = props.columns.indexOf(column);
        if (currentIndex >= 0 && index < currentIndex) return null;
        const primary = column === top;
        const title = current?.price ? t('planSurface.switchToPlan', { plan: column.name }) : t('planSurface.getPlan', { plan: column.name });
        return (
            <RoundButton
                testID={`plan-ladder-cta-${column.id}`}
                size="normal"
                display={primary ? 'contrast' : 'outline'}
                style={styles.ctaFull}
                title={props.compact ? `${title} · ${t('planSurface.planPricePerMonth', { price: formatPrice(column.price) })}` : title}
                loading={props.busyPlanId === column.id}
                disabled={props.busyPlanId !== null && props.busyPlanId !== column.id}
                onPress={() => props.onChoosePlan(column.id)}
            />
        );
    };

    const cell = (column: PlanLadderColumn, children: React.ReactNode, extra?: object) => (
        <View key={column.id} style={[styles.planCell, column === top ? styles.topColumn : null, extra]}>{children}</View>
    );

    return (
        <View>
            <View style={styles.sheet} testID="plan-ladder">
                <View style={[styles.row, styles.headerRow]}>
                    <View style={styles.labelCell} />
                    {props.columns.map((column) => cell(column, (
                        <View style={styles.headerCell}>
                            <Text style={styles.planName}>{column.name}</Text>
                            <Text style={styles.planPrice}>
                                {formatPrice(column.price)}
                                {column.price && !props.compact ? <Text style={styles.planPer}>{` ${t('planSurface.perMonth')}`}</Text> : null}
                            </Text>
                            {/* A phone column is too narrow for the price and its period on one line. */}
                            {column.price && props.compact ? <Text style={styles.planPer}>{t('planSurface.perMonth')}</Text> : null}
                            {column.current ? (
                                <View style={styles.youPill}>
                                    <Text style={styles.youPillText}>{props.compact ? t('planSurface.you') : t('planSurface.yourPlan')}</Text>
                                </View>
                            ) : null}
                        </View>
                    ), styles.headerPad))}
                </View>
                {rows.map((row) => (
                    <View key={row.id} style={[styles.row, styles.bodyRow]}>
                        <View style={styles.labelCell}>
                            <Text style={styles.rowTitle}>{row.title}</Text>
                            {row.hint ? <Text style={styles.rowHint}>{row.hint}</Text> : null}
                        </View>
                        {props.columns.map((column) => cell(column, row.id === 'pack' ? (
                            column.includesPack ? (
                                <View style={styles.packIncluded} accessibilityLabel={t('planSurface.included')}>
                                    <Icon name="star" weight="fill" size={13} color={theme.colors.supporter.accent} />
                                    {props.compact ? null : <Text style={styles.value}>{t('planSurface.included')}</Text>}
                                </View>
                            ) : (
                                <Text style={styles.muted} accessibilityLabel={t('planSurface.notIncluded')}>
                                    {props.compact ? '—' : t('planSurface.notIncluded')}
                                </Text>
                            )
                        ) : (
                            <Text style={styles.value}>{row.value(column)}</Text>
                        ), styles.bodyPad))}
                    </View>
                ))}
                {!props.compact && props.purchasable && upgrade ? (
                    <View style={[styles.row, styles.footerRow]}>
                        <View style={styles.labelCell} />
                        {props.columns.map((column) => cell(column, ctaFor(column), styles.footerPad))}
                    </View>
                ) : null}
            </View>
            {props.compact && props.purchasable && upgrade ? (
                <View style={styles.stackedCtas}>
                    {[...props.columns].reverse().map((column) => {
                        const cta = ctaFor(column);
                        return cta ? <React.Fragment key={column.id}>{cta}</React.Fragment> : null;
                    })}
                </View>
            ) : null}
        </View>
    );
});

const styles = StyleSheet.create((theme) => ({
    sheet: {
        overflow: 'hidden',
    },
    row: {
        flexDirection: 'row',
        alignItems: 'stretch',
    },
    headerRow: {
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
    },
    bodyRow: {
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.border.default,
    },
    footerRow: {},
    labelCell: {
        flex: 1.35,
        justifyContent: 'center',
        paddingHorizontal: 16,
        paddingVertical: 12,
    },
    planCell: {
        flex: 1,
        justifyContent: 'center',
        paddingHorizontal: 12,
    },
    headerPad: { paddingVertical: 16, justifyContent: 'flex-start' },
    bodyPad: { paddingVertical: 12 },
    footerPad: { paddingVertical: 12 },
    // `selected`, not `inset`: inset is darker than the card in dark mode and the tint vanished.
    topColumn: {
        backgroundColor: theme.colors.surface.selected,
    },
    headerCell: {
        gap: 2,
        alignItems: 'flex-start',
    },
    planName: {
        ...Typography.default('semiBold'),
        fontSize: 18,
        color: theme.colors.text.primary,
    },
    planPrice: {
        ...Typography.default(),
        fontSize: 15,
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
    },
    planPer: {
        ...Typography.default(),
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
    youPill: {
        marginTop: 6,
        borderRadius: 999,
        paddingHorizontal: 10,
        paddingVertical: 3,
        backgroundColor: theme.colors.surface.elevated,
    },
    youPillText: {
        ...Typography.default(),
        fontSize: 13,
        color: theme.colors.text.primary,
    },
    rowTitle: {
        ...Typography.default(),
        fontSize: 15,
        color: theme.colors.text.primary,
    },
    rowHint: {
        ...Typography.default(),
        fontSize: 13,
        color: theme.colors.text.secondary,
    },
    value: {
        ...Typography.default(),
        fontSize: 15,
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
    },
    muted: {
        ...Typography.default(),
        fontSize: 15,
        color: theme.colors.text.secondary,
    },
    packIncluded: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    ctaFull: {
        alignSelf: 'stretch',
    },
    stackedCtas: {
        padding: 16,
        gap: 10,
    },
}));
