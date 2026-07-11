import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { ContextGauge } from '@/components/instrument';
import { usageSeriesColor } from '@/components/settings/usage/usageAccent';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { formatPercent, formatTokenCount, formatTokenCountLong } from '@/utils/format/usageNumbers';
import { t } from '@/text';

import { AgentInputContentPopover } from '../components/AgentInputContentPopover';
import { instrumentStripStyles } from './instrumentStripStyles';
import type { InstrumentStripContextModel } from './useInstrumentStripModel';

const REFRESH_SHIMMER_MS = 300;

export type ContextGaugeInstrumentProps = Readonly<{
    model: InstrumentStripContextModel;
    /** Show the trailing `%` label (≥360px available width). */
    showPercentText: boolean;
    isStreaming: boolean;
    /** On-demand provider refresh (Claude `getContextUsage`); no-op otherwise. */
    onRefresh: () => void;
    testID?: string;
}>;

/**
 * The in-session context instrument: a 16px `ContextGauge` (liquid at `full`,
 * ring otherwise) with an optional `%` label, opening a breakdown popover.
 */
export const ContextGaugeInstrument = React.memo(function ContextGaugeInstrument(
    props: ContextGaugeInstrumentProps,
) {
    const anchorRef = React.useRef(null);
    const [open, setOpen] = React.useState(false);
    const [refreshing, setRefreshing] = React.useState(false);
    const refreshTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    React.useEffect(() => () => {
        if (refreshTimer.current) clearTimeout(refreshTimer.current);
    }, []);

    const handlePress = React.useCallback(() => {
        setOpen((previous) => {
            const next = !previous;
            if (next) {
                props.onRefresh();
                setRefreshing(true);
                if (refreshTimer.current) clearTimeout(refreshTimer.current);
                refreshTimer.current = setTimeout(() => setRefreshing(false), REFRESH_SHIMMER_MS);
            }
            return next;
        });
    }, [props]);

    const { model } = props;
    const percentLabel = model.stale ? null : formatPercent(model.usedPct);

    return (
        <>
            <View ref={anchorRef} style={instrumentStripStyles.instrumentSlot}>
                <ContextGauge
                    usedPct={model.usedPct}
                    size={16}
                    isStreaming={props.isStreaming}
                    stale={model.stale}
                    onPress={handlePress}
                    testID={props.testID ?? 'session-instrument-context-gauge'}
                />
                {props.showPercentText && percentLabel ? (
                    <Text style={instrumentStripStyles.instrumentValueText} numberOfLines={1}>
                        {percentLabel}
                    </Text>
                ) : null}
            </View>
            <AgentInputContentPopover
                open={open}
                anchorRef={anchorRef}
                onRequestClose={() => setOpen(false)}
                maxWidthCap={340}
                scrollEnabled={false}
                testID="session-instrument-context-popover"
                content={<ContextGaugePopoverContent model={model} refreshing={refreshing} />}
            />
        </>
    );
});

const ContextGaugePopoverContent = React.memo(function ContextGaugePopoverContent(props: Readonly<{
    model: InstrumentStripContextModel;
    refreshing: boolean;
}>) {
    const { model } = props;
    const { theme } = useUnistyles();
    const styles = popoverStyles;
    const dimmed = props.refreshing ? styles.shimmer : null;

    const percentText = model.stale ? t('instrument.contextGauge.staleNote') : formatPercent(model.usedPct);
    const windowText = typeof model.windowTokens === 'number'
        ? formatTokenCountLong(model.windowTokens)
        : t('instrument.contextGauge.unknownWindow');

    // Ordered tonal ramp of the ONE signature accent (usageAccent, R-DESIGN D-1),
    // one distinct step per category. Eight ordered steps → up to 8 categories
    // never wrap back to the signature accent or collide (D-6).
    const categoryColorForIndex = React.useCallback(
        (index: number) => usageSeriesColor(theme, index),
        [theme],
    );

    const categoriesTotal = React.useMemo(
        () => (model.categories ?? []).reduce((sum, category) => sum + Math.max(0, category.tokens), 0),
        [model.categories],
    );

    return (
        <View style={styles.root}>
            <Text style={styles.title}>{t('instrument.contextGauge.popoverTitle')}</Text>

            <View style={[styles.rows, dimmed]}>
                <PopoverRow label={t('instrument.contextGauge.percentRow')} value={percentText} />
                <PopoverRow
                    label={t('instrument.contextGauge.usedRow')}
                    value={formatTokenCountLong(model.usedTokens)}
                />
                <PopoverRow label={t('instrument.contextGauge.windowRow')} value={windowText} />
                {typeof model.baselineTokens === 'number' && model.baselineTokens > 0 ? (
                    <Text style={styles.note}>
                        {t('instrument.contextGauge.baselineNote', {
                            tokens: formatTokenCount(model.baselineTokens),
                        })}
                    </Text>
                ) : null}
                {typeof model.totalProcessedTokens === 'number' ? (
                    <PopoverRow
                        label={t('instrument.contextGauge.lifetimeRow')}
                        value={formatTokenCountLong(model.totalProcessedTokens)}
                    />
                ) : null}
                {model.isAutoCompactEnabled !== null ? (
                    <Text style={styles.note}>
                        {model.isAutoCompactEnabled
                            ? t('instrument.contextGauge.autoCompactOn')
                            : t('instrument.contextGauge.autoCompactOff')}
                    </Text>
                ) : null}
            </View>

            {model.categories && model.categories.length > 0 && categoriesTotal > 0 ? (
                <View style={[styles.categories, dimmed]}>
                    <Text style={styles.subTitle}>{t('instrument.contextGauge.categoriesTitle')}</Text>
                    <View
                        style={styles.stackedBar}
                        accessibilityRole="image"
                        accessibilityLabel={t('instrument.contextGauge.categoriesTitle')}
                    >
                        {model.categories.map((category, index) => {
                            const fraction = Math.max(0, category.tokens) / categoriesTotal;
                            if (fraction <= 0) return null;
                            return (
                                <View
                                    key={category.key}
                                    testID={`session-instrument-context-category-bar:${category.key}`}
                                    style={{
                                        flexGrow: fraction,
                                        backgroundColor: categoryColorForIndex(index),
                                    }}
                                />
                            );
                        })}
                    </View>
                    {model.categories.map((category, index) => (
                        <View key={category.key} style={styles.categoryRow}>
                            <View
                                style={[
                                    styles.categorySwatch,
                                    { backgroundColor: categoryColorForIndex(index) },
                                ]}
                            />
                            <Text style={styles.categoryLabel} numberOfLines={1}>
                                {category.label ?? category.key}
                            </Text>
                            <Text style={styles.categoryValue}>{formatTokenCount(category.tokens)}</Text>
                        </View>
                    ))}
                </View>
            ) : null}
        </View>
    );
});

function PopoverRow(props: Readonly<{ label: string; value: string }>) {
    const styles = popoverStyles;
    return (
        <View style={styles.row}>
            <Text style={styles.rowLabel} numberOfLines={1}>{props.label}</Text>
            <Text style={styles.rowValue} numberOfLines={1}>{props.value}</Text>
        </View>
    );
}

const popoverStyles = StyleSheet.create((theme) => ({
    root: {
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 12,
        minWidth: 200,
    },
    shimmer: {
        opacity: 0.45,
    },
    title: {
        fontSize: 11,
        letterSpacing: 1,
        textTransform: 'uppercase',
        color: theme.colors.text.secondary,
        ...Typography.header(),
    },
    subTitle: {
        fontSize: 11,
        letterSpacing: 0.8,
        textTransform: 'uppercase',
        color: theme.colors.text.tertiary,
        ...Typography.header(),
    },
    rows: {
        gap: 6,
    },
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
    },
    rowLabel: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        flexShrink: 1,
        ...Typography.default(),
    },
    rowValue: {
        fontSize: 13,
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
        flexShrink: 0,
        ...Typography.default('semiBold'),
    },
    note: {
        fontSize: 12,
        color: theme.colors.text.tertiary,
        ...Typography.default(),
    },
    categories: {
        gap: 8,
    },
    stackedBar: {
        flexDirection: 'row',
        height: 6,
        borderRadius: 999,
        overflow: 'hidden',
        backgroundColor: theme.colors.surface.pressedOverlay,
    },
    categoryRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
    },
    categorySwatch: {
        width: 8,
        height: 8,
        borderRadius: 2,
    },
    categoryLabel: {
        flex: 1,
        minWidth: 0,
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    categoryValue: {
        fontSize: 12,
        color: theme.colors.text.primary,
        fontVariant: ['tabular-nums'],
        ...Typography.default('semiBold'),
    },
}));
