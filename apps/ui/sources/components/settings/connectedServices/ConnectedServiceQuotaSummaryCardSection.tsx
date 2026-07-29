import * as React from 'react';
import { View } from 'react-native';
import type { DimensionValue } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { CardGrid, CardGridColumn, CardSection, MetricCard, PanelCard } from '@/components/ui/cards';
import { ChartTooltip } from '@/components/ui/charts/ChartTooltip';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';

import type { ConnectedServiceQuotaSummaryCard } from './buildConnectedServiceQuotaSummaryCards';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';

type ConnectedServiceQuotaSummaryCardSectionProps = Readonly<{
    title: string;
    cards: ReadonlyArray<ConnectedServiceQuotaSummaryCard>;
    isRefreshing?: boolean;
    showWhenEmpty?: boolean;
    testID?: string;
}>;

const styles = StyleSheet.create((theme) => ({
    meterStack: {
        gap: 8,
    },
    meterRow: {
        gap: 4,
    },
    meterLabelRow: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 8,
    },
    meterLabel: {
        flex: 1,
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.primary,
    },
    meterValue: {
        fontSize: 12,
        lineHeight: 16,
        color: theme.colors.text.secondary,
        fontWeight: '600',
    },
    meterTrack: {
        height: 6,
        borderRadius: 999,
        backgroundColor: theme.colors.background.canvas,
        overflow: 'hidden',
    },
    meterFill: {
        height: '100%',
        borderRadius: 999,
    },
    loadingState: {
        minHeight: 84,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    statusText: {
        fontSize: 13,
        lineHeight: 18,
        color: theme.colors.text.secondary,
    },
}));

function resolveQuotaMeterColor(params: Readonly<{
    remainingPct: number | null;
    status: ConnectedServiceQuotaSummaryCard['meters'][number]['status'];
    theme: ReturnType<typeof useUnistyles>['theme'];
}>): string {
    const { remainingPct, status, theme } = params;

    if (status === 'unavailable') {
        return theme.colors.text.secondary;
    }
    if (status === 'estimated') {
        return theme.colors.state.neutral.foreground;
    }
    if (typeof remainingPct === 'number') {
        if (remainingPct <= 10) {
            return theme.colors.status.error;
        }
        if (remainingPct <= 25) {
            return theme.colors.state.neutral.foreground;
        }
    }

    return theme.colors.accent.green;
}

function resolveQuotaMeterWidth(remainingPct: number | null): DimensionValue {
    if (remainingPct === null || !Number.isFinite(remainingPct) || remainingPct <= 0) {
        return '0%';
    }

    return `${Math.max(8, Math.min(100, remainingPct))}%` as const;
}

export const ConnectedServiceQuotaSummaryCardSection = React.memo(function ConnectedServiceQuotaSummaryCardSection(
    props: ConnectedServiceQuotaSummaryCardSectionProps,
) {
    const { theme } = useUnistyles();

    if (props.cards.length === 0 && !props.isRefreshing && !props.showWhenEmpty) {
        return null;
    }

    return (
        <CardSection title={props.title} testID={props.testID}>
            {props.cards.length === 0 ? (
                <PanelCard
                    padding="md"
                    testID={props.isRefreshing ? 'usage-connected-services-quotas-loading' : 'usage-connected-services-quotas-empty'}
                >
                    <View style={styles.loadingState}>
                        {props.isRefreshing ? (
                            <ActivitySpinner size="small" color={theme.colors.accent.blue} />
                        ) : null}
                        <Text style={styles.statusText}>{props.isRefreshing ? t('common.loading') : t('usage.noData.title')}</Text>
                    </View>
                </PanelCard>
            ) : (
                <CardGrid columns={3} collapseBelow="medium" columnGap={12} rowGap={12}>
                    {props.cards.map((card) => (
                        <CardGridColumn key={card.key}>
                            <MetricCard
                                testID={`connected-service-quota-summary-${card.key}`}
                                label={card.title}
                                value={card.value}
                                subtitle={card.subtitle}
                                valueTone="compact"
                                visual={(
                                    <View style={styles.meterStack}>
                                        {card.meters.map((meter) => {
                                            const meterColor = resolveQuotaMeterColor({
                                                remainingPct: meter.remainingPct,
                                                status: meter.status,
                                                theme,
                                            });

                                            return (
                                                <ChartTooltip
                                                    key={meter.key}
                                                    triggerTestID={`connected-service-quota-meter-trigger-${card.key}-${meter.key}`}
                                                    title={meter.label}
                                                    subtitle={card.title}
                                                    value={meter.valueText}
                                                    accentColor={meterColor}
                                                >
                                                    <View style={styles.meterRow}>
                                                        <View style={styles.meterLabelRow}>
                                                            <Text numberOfLines={1} style={styles.meterLabel}>{meter.label}</Text>
                                                            <Text style={styles.meterValue}>{meter.valueText}</Text>
                                                        </View>
                                                        <View style={styles.meterTrack}>
                                                            <View
                                                                testID={`connected-service-quota-meter-fill-${card.key}-${meter.key}`}
                                                                style={[
                                                                    styles.meterFill,
                                                                    {
                                                                        width: resolveQuotaMeterWidth(meter.remainingPct),
                                                                        backgroundColor: meterColor,
                                                                    },
                                                                ]}
                                                            />
                                                        </View>
                                                    </View>
                                                </ChartTooltip>
                                            );
                                        })}
                                    </View>
                                )}
                            />
                        </CardGridColumn>
                    ))}
                </CardGrid>
            )}
        </CardSection>
    );
});
