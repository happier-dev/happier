import * as React from 'react';
import { Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { MeterBar, type MeterTone } from '@/components/ui/lists/MeterBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { useNowMs } from '@/hooks/time/useNowMs';
import { t } from '@/text';
import {
    resolveConnectedServiceQuotaMeterDetailLabel,
    type ConnectedServiceQuotaGaugeViewModel,
} from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { connectedServiceQuotaGaugeFormatter } from './connectedServiceQuotaGaugeFormatter';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { useProviderUsageRefreshState } from '@/hooks/server/connectedServices/useProviderUsageRefreshState';
import { getProviderUsageRingSize } from './ProviderUsageRing';

function ProviderUsageRefreshIndicator(props: Readonly<{ serviceId: string; sourceProfileId: string; size: number }>) {
    const refreshing = useProviderUsageRefreshState(props.serviceId, props.sourceProfileId);
    // The dot mark's ink spans 5/6 of its box. Its visible diameter is half the outer ring's.
    return refreshing ? <ActivitySpinner size={Math.round(props.size * 3 / 5)} /> : null;
}

function mapGaugeToneToMeterTone(tone: ConnectedServiceQuotaGaugeViewModel['tone']): MeterTone {
    if (tone === 'critical') return 'danger';
    if (tone === 'warning') return 'warning';
    return 'success';
}

const METER_RESET_COUNTDOWN_TICK_MS = 1_000;

/**
 * One meter row's right-hand detail. It owns the shared one-second clock, so an open popover
 * counts its reset down live without re-rendering the badge or its parent.
 */
const ProviderUsageMeterDetailRight = React.memo(function ProviderUsageMeterDetailRight(props: Readonly<{
    row: ConnectedServiceQuotaGaugeViewModel['allMeterRows'][number];
    style: React.ComponentProps<typeof Text>['style'];
}>) {
    const nowMs = useNowMs(METER_RESET_COUNTDOWN_TICK_MS);
    return (
        <Text style={props.style} numberOfLines={1}>
            {resolveConnectedServiceQuotaMeterDetailLabel({
                remainingPct: props.row.remainingPct,
                resetAtMs: props.row.resetAtMs,
                nowMs,
                formatter: connectedServiceQuotaGaugeFormatter,
            })}
        </Text>
    );
});

/** Shared usage details for composer popups and the all-provider sessions panel. */
export function ProviderUsageDetails(props: Readonly<{
    viewModel: ConnectedServiceQuotaGaugeViewModel;
    leading?: React.ReactNode;
    ringBaseSize?: number;
    onRecoveryCreditPress?: () => void;
    recoveryCreditActionPending?: boolean;
}>) {
    const styles = stylesheet;
    const title = props.viewModel.providerDisplayName
        ? t('agentInput.providerUsage.titleForProvider', { provider: props.viewModel.providerDisplayName })
        : t('agentInput.providerUsage.title');
    const recoveryCreditSummary = props.viewModel.recoveryCreditSummary;
    return (
        <View style={styles.popoverContent}>
            <View style={styles.titleRow}>
                {props.leading}
                <Text style={styles.popoverTitle}>{title}</Text>
                {props.viewModel.sourceProfileId ? (
                    <ProviderUsageRefreshIndicator
                        serviceId={props.viewModel.serviceId}
                        sourceProfileId={props.viewModel.sourceProfileId}
                        size={getProviderUsageRingSize(props.viewModel, props.ringBaseSize)}
                    />
                ) : null}
            </View>
            {props.viewModel.activeAccountDisplayLabel ? (
                <Text style={styles.popoverAccount}>
                    {t('agentInput.providerUsage.activeAccount', { account: props.viewModel.activeAccountDisplayLabel })}
                </Text>
            ) : null}
            {props.viewModel.subscription ? (
                <View testID="agent-input-provider-usage-subscription" style={styles.subscription}>
                    <View style={styles.subscriptionHeader}>
                        <Text style={styles.subscriptionLabel}>{t('connectedServices.subscription.title')}</Text>
                        <View style={styles.subscriptionStatus}>
                            <View style={[
                                styles.subscriptionStatusDot,
                                props.viewModel.subscription.renewal === 'on'
                                    ? styles.subscriptionStatusDotOn
                                    : props.viewModel.subscription.renewal === 'off'
                                        ? styles.subscriptionStatusDotOff
                                        : styles.subscriptionStatusDotUnknown,
                            ]} />
                            <Text
                                testID="agent-input-provider-usage-subscription:renewal"
                                style={styles.subscriptionRenewal}
                            >
                                {props.viewModel.subscription.renewalLabel}
                            </Text>
                        </View>
                    </View>
                    <Text
                        testID="agent-input-provider-usage-subscription:summary"
                        style={styles.subscriptionSummary}
                    >
                        {props.viewModel.subscription.summary}
                    </Text>
                    {props.viewModel.subscription.period ? (
                        <Text style={styles.subscriptionMeta}>{props.viewModel.subscription.period}</Text>
                    ) : null}
                    <Text style={styles.subscriptionMeta}>{props.viewModel.subscription.checkedLabel}</Text>
                    {props.viewModel.subscription.notice ? (
                        <Text style={styles.subscriptionNotice}>{props.viewModel.subscription.notice}</Text>
                    ) : null}
                </View>
            ) : null}
            {props.viewModel.allMeterRows.map((row, index) => (
                <View
                    key={row.meterId}
                    testID={`agent-input-provider-usage-meter:${row.meterId}`}
                    style={[
                        styles.meterRow,
                        index === 0
                            ? props.viewModel.subscription ? styles.meterRowAfterSubscription : null
                            : styles.meterRowGap,
                    ]}
                >
                    <View style={styles.meterHeader}>
                        <Text style={styles.meterLabel} numberOfLines={1}>
                            {row.label}
                        </Text>
                        <ProviderUsageMeterDetailRight row={row} style={styles.meterRight} />
                    </View>
                    {row.remainingPct !== null ? <MeterBar
                        testID={`agent-input-provider-usage-meter-bar:${row.meterId}`}
                        tone={mapGaugeToneToMeterTone(row.tone)}
                        // Remaining-first fill: the adjacent label says "% left" and the
                        // tone derives from remaining — the fill must match that language
                        // (battery model; user decision 2026-07-10, reverting 5ad4d06be).
                        fillFraction={row.remainingPct / 100}
                        height={5}
                    /> : null}
                    {row.usedLimitLabel ? (
                        <Text style={styles.meterUsage}>
                            {row.usedLimitLabel}
                        </Text>
                    ) : null}
                </View>
            ))}
            {recoveryCreditSummary ? (
                <View
                    testID="agent-input-provider-usage-recovery-credit"
                    style={styles.recoveryCredit}
                >
                    <View style={styles.recoveryCreditInfo}>
                        <Text style={styles.recoveryCreditTitle}>
                            {t('connectedServices.quota.recoveryCreditTitle', { count: recoveryCreditSummary.availableCount })}
                        </Text>
                        <Text style={styles.recoveryCreditSubtitle}>
                            {typeof recoveryCreditSummary.nextExpiresAtMs === 'number'
                                ? t('connectedServices.quota.recoveryCreditExpires', { time: new Date(recoveryCreditSummary.nextExpiresAtMs).toLocaleString() })
                                : t('connectedServices.quota.recoveryCreditSubtitle')}
                        </Text>
                    </View>
                    {props.onRecoveryCreditPress ? (
                        <Pressable
                            testID="agent-input-provider-usage-recovery-credit-action"
                            accessibilityRole="button"
                            disabled={props.recoveryCreditActionPending === true}
                            onPress={props.onRecoveryCreditPress}
                            style={({ pressed }) => [
                                styles.recoveryCreditAction,
                                pressed ? styles.recoveryCreditActionPressed : null,
                                props.recoveryCreditActionPending === true ? styles.recoveryCreditActionDisabled : null,
                            ]}
                        >
                            <Text style={styles.recoveryCreditActionText}>
                                {props.recoveryCreditActionPending === true
                                    ? t('connectedServices.quota.recoveryCreditApplying')
                                    : t('session.usageLimitRecovery.consumeResetCreditAction')}
                            </Text>
                        </Pressable>
                    ) : null}
                </View>
            ) : null}
        </View>
    );
}

const stylesheet = StyleSheet.create((theme) => ({
    titleRow: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
    },
    popoverContent: {
        paddingHorizontal: 18,
        paddingVertical: 16,
        gap: 0,
    },
    popoverTitle: {
        fontSize: 12,
        letterSpacing: 1.6,
        textTransform: 'uppercase',
        color: theme.colors.text.secondary,
        marginBottom: 3,
        ...Typography.header(),
    },
    popoverAccount: {
        fontSize: 13,
        color: theme.colors.text.secondary,
        marginBottom: 12,
        ...Typography.default(),
    },
    subscription: {
        gap: 0,
        paddingTop: 12,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.subtle,
    },
    subscriptionHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
    },
    subscriptionLabel: {
        fontSize: 10,
        letterSpacing: 1.2,
        textTransform: 'uppercase',
        color: theme.colors.text.tertiary,
        ...Typography.header(),
    },
    subscriptionStatus: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
    },
    subscriptionStatusDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
    },
    subscriptionStatusDotOn: {
        backgroundColor: theme.colors.state.success.foreground,
    },
    subscriptionStatusDotOff: {
        backgroundColor: theme.colors.text.tertiary,
    },
    subscriptionStatusDotUnknown: {
        backgroundColor: theme.colors.state.warning.foreground,
    },
    subscriptionRenewal: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default('semiBold'),
    },
    subscriptionSummary: {
        fontSize: 13,
        lineHeight: 18,
        marginTop: 8,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    subscriptionMeta: {
        fontSize: 12,
        lineHeight: 17,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    subscriptionNotice: {
        fontSize: 11,
        lineHeight: 15,
        color: theme.colors.state.warning.foreground,
        ...Typography.default(),
    },
    meterRow: {
        gap: 6,
    },
    meterRowAfterSubscription: {
        marginTop: 12,
    },
    meterRowGap: {
        marginTop: 12,
    },
    meterHeader: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 10,
    },
    meterLabel: {
        flex: 1,
        minWidth: 0,
        fontSize: 12,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    meterRight: {
        flexShrink: 0,
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    meterUsage: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    recoveryCredit: {
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: 6,
        paddingTop: 12,
        borderTopWidth: 1,
        borderTopColor: theme.colors.border.subtle,
    },
    recoveryCreditInfo: {
        flex: 1,
        gap: 4,
        minWidth: 0,
    },
    recoveryCreditTitle: {
        fontSize: 12,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
    recoveryCreditSubtitle: {
        fontSize: 12,
        color: theme.colors.text.secondary,
        ...Typography.default(),
    },
    recoveryCreditAction: {
        alignSelf: 'flex-start',
        marginTop: 2,
        minHeight: 32,
        justifyContent: 'center',
        borderRadius: 8,
        paddingHorizontal: 12,
        backgroundColor: theme.colors.surface.selected,
        borderWidth: 1,
        borderColor: theme.colors.border.default,
    },
    recoveryCreditActionPressed: {
        opacity: 0.82,
        transform: [{ scale: 0.96 }],
    },
    recoveryCreditActionDisabled: {
        opacity: 0.58,
    },
    recoveryCreditActionText: {
        fontSize: 12,
        color: theme.colors.text.primary,
        ...Typography.default('semiBold'),
    },
}));
