import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { MeterBar, type MeterTone } from '@/components/ui/lists/MeterBar';
import { Text } from '@/components/ui/text/Text';
import { TokenUsageRing, type TokenUsageTone } from '@/components/sessions/usage';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type {
    ConnectedServiceQuotaGaugeViewModel,
} from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';

import { AgentInputContentPopover } from './AgentInputContentPopover';

type WebHoverablePressableState = Readonly<{
    pressed: boolean;
    hovered?: boolean;
}>;

type AgentInputProviderUsageBadgeProps = Readonly<{
    viewModel: ConnectedServiceQuotaGaugeViewModel;
    marginLeft?: number;
    showLabels?: boolean;
    onRecoveryCreditPress?: () => void;
    recoveryCreditActionPending?: boolean;
}>;

function areProviderUsageMeterRowsEqual(
    left: ConnectedServiceQuotaGaugeViewModel['allMeterRows'],
    right: ConnectedServiceQuotaGaugeViewModel['allMeterRows'],
): boolean {
    if (left === right) return true;
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
        const leftRow = left[index];
        const rightRow = right[index];
        if (!leftRow || !rightRow) return false;
        if (
            leftRow.meterId !== rightRow.meterId
            || leftRow.label !== rightRow.label
            || leftRow.remainingPct !== rightRow.remainingPct
            || leftRow.usedPct !== rightRow.usedPct
            || leftRow.detailRightSemantics !== rightRow.detailRightSemantics
            || leftRow.detailRightLabel !== rightRow.detailRightLabel
            || leftRow.usedLimitSemantics !== rightRow.usedLimitSemantics
            || leftRow.usedLimitLabel !== rightRow.usedLimitLabel
            || leftRow.resetLabel !== rightRow.resetLabel
            || leftRow.tone !== rightRow.tone
        ) {
            return false;
        }
    }
    return true;
}

function areProviderUsageWindowRingsEqual(
    left: ConnectedServiceQuotaGaugeViewModel['usageRings'],
    right: ConnectedServiceQuotaGaugeViewModel['usageRings'],
): boolean {
    if (left === right) return true;
    if (left.length !== right.length) return false;
    return left.every((ring, index) => {
        const other = right[index];
        return !!other
            && ring.label === other.label
            && ring.meterId === other.meterId
            && ring.usedPct === other.usedPct
            && ring.ringValueLabel === other.ringValueLabel
            && ring.valueLabel === other.valueLabel
            && ring.tone === other.tone;
    });
}

function areProviderUsageRecoveryCreditsEqual(
    left: ConnectedServiceQuotaGaugeViewModel['recoveryCreditSummary'],
    right: ConnectedServiceQuotaGaugeViewModel['recoveryCreditSummary'],
): boolean {
    if (left === right) return true;
    if (!left || !right) return false;
    return left.availableCount === right.availableCount
        && left.nextExpiresAtMs === right.nextExpiresAtMs
        && left.providerCreditId === right.providerCreditId;
}

function areProviderUsageViewModelsEqual(
    left: ConnectedServiceQuotaGaugeViewModel,
    right: ConnectedServiceQuotaGaugeViewModel,
): boolean {
    const leftSubscription = left.subscription;
    const rightSubscription = right.subscription;
    const subscriptionEqual = leftSubscription === rightSubscription || (!!leftSubscription && !!rightSubscription
        && leftSubscription.summary === rightSubscription.summary
        && leftSubscription.period === rightSubscription.period
        && leftSubscription.renewal === rightSubscription.renewal
        && leftSubscription.renewalLabel === rightSubscription.renewalLabel
        && leftSubscription.checkedLabel === rightSubscription.checkedLabel
        && leftSubscription.notice === rightSubscription.notice
        && leftSubscription.accessUntilLabel === rightSubscription.accessUntilLabel
        && leftSubscription.isLastKnown === rightSubscription.isLastKnown);
    return subscriptionEqual && left.serviceId === right.serviceId
        && left.providerDisplayName === right.providerDisplayName
        && left.activeAccountDisplayLabel === right.activeAccountDisplayLabel
        && left.remainingPct === right.remainingPct
        && left.usedPct === right.usedPct
        && left.valueLabel === right.valueLabel
        && left.ringValueLabel === right.ringValueLabel
        && left.ringValueAccessibilityLabel === right.ringValueAccessibilityLabel
        && left.badgeLabel === right.badgeLabel
        && left.scopePrefix === right.scopePrefix
        && left.primaryValueSemantics === right.primaryValueSemantics
        && left.detailRightLabel === right.detailRightLabel
        && left.usedLimitLabel === right.usedLimitLabel
        && left.resetLabel === right.resetLabel
        && left.tone === right.tone
        && left.isStale === right.isStale
        && areProviderUsageRecoveryCreditsEqual(left.recoveryCreditSummary, right.recoveryCreditSummary)
        && areProviderUsageMeterRowsEqual(left.allMeterRows, right.allMeterRows)
        && areProviderUsageWindowRingsEqual(left.usageRings, right.usageRings);
}

function areProviderUsageBadgePropsEqual(
    left: AgentInputProviderUsageBadgeProps,
    right: AgentInputProviderUsageBadgeProps,
): boolean {
    return left.showLabels === right.showLabels
        && left.marginLeft === right.marginLeft
        && left.onRecoveryCreditPress === right.onRecoveryCreditPress
        && left.recoveryCreditActionPending === right.recoveryCreditActionPending
        && areProviderUsageViewModelsEqual(left.viewModel, right.viewModel);
}

function mapQuotaToneToTokenTone(tone: ConnectedServiceQuotaGaugeViewModel['tone']): TokenUsageTone {
    if (tone === 'critical') return 'critical';
    if (tone === 'warning') return 'warning';
    return 'neutral';
}

function mapGaugeToneToMeterTone(tone: ConnectedServiceQuotaGaugeViewModel['tone']): MeterTone {
    if (tone === 'critical') return 'danger';
    if (tone === 'warning') return 'warning';
    return 'success';
}

export const AgentInputProviderUsageBadge = React.memo(function AgentInputProviderUsageBadge(
    props: AgentInputProviderUsageBadgeProps,
) {
    const styles = stylesheet;
    const anchorRef = React.useRef<any>(null);
    const [isPinnedOpen, setIsPinnedOpen] = React.useState(false);
    const [isHovered, setIsHovered] = React.useState(false);
    const open = isPinnedOpen || isHovered;
    const rings = props.viewModel.usageRings.length > 0
        ? props.viewModel.usageRings
        : [{ meterId: props.viewModel.effectiveMeter.meterId, label: props.viewModel.effectiveMeter.label,
            usedPct: props.viewModel.usedPct, ringValueLabel: props.viewModel.ringValueLabel,
            valueLabel: props.viewModel.valueLabel, tone: props.viewModel.tone }];
    // Remaining-first, like the ring numbers. Extra rings are named so each one can be told apart.
    const ringAccessibilityValues = rings.length === 1
        ? [props.viewModel.badgeLabel]
        : rings.map((ring) => `${ring.label} ${ring.valueLabel}`);
    const accessibilityLabel = t('agentInput.providerUsage.accessibilityLabel', {
        value: [props.viewModel.ringValueAccessibilityLabel, ...ringAccessibilityValues].filter(Boolean).join(', '),
    });
    const title = props.viewModel.providerDisplayName
        ? t('agentInput.providerUsage.titleForProvider', { provider: props.viewModel.providerDisplayName })
        : t('agentInput.providerUsage.title');
    const recoveryCreditSummary = props.viewModel.recoveryCreditSummary;

    return (
        <>
            <View testID="agent-input-provider-quota-badge" style={styles.badgeContainer}>
            <Pressable
                ref={anchorRef}
                testID="agent-input-provider-usage-badge"
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={accessibilityLabel}
                onPress={() => {
                    setIsPinnedOpen((previous) => !previous);
                }}
                onHoverIn={Platform.OS === 'web' ? () => setIsHovered(true) : undefined}
                onHoverOut={Platform.OS === 'web' ? () => setIsHovered(false) : undefined}
                style={(state) => {
                    const hovered = (state as WebHoverablePressableState).hovered === true;
                    return [
                        styles.badge,
                        { marginLeft: props.marginLeft ?? 0 },
                        (state.pressed || hovered) ? styles.badgePressed : null,
                    ];
                }}
            >
                <View style={styles.windowRing}>
                    {props.showLabels === true ? (
                        <Text
                            testID="agent-input-provider-usage-meter-label"
                            style={styles.windowLabel}
                            numberOfLines={1}
                        >
                            {rings.map(ring => ring.label).join(' / ')}
                        </Text>
                    ) : null}
                    <TokenUsageRing
                        used={100 - rings[0].usedPct}
                        limit={100}
                        rings={rings.map(ring => ({
                            used: 100 - ring.usedPct, limit: 100, tone: mapQuotaToneToTokenTone(ring.tone),
                        }))}
                        label={accessibilityLabel}
                        value={props.viewModel.ringValueLabel}
                        tone={mapQuotaToneToTokenTone(props.viewModel.tone)}
                        ringTestID="agent-input-provider-usage-ring"
                        valueTestID="agent-input-provider-usage-value"
                    />
                </View>
            </Pressable>
            </View>

            <AgentInputContentPopover
                open={open}
                anchorRef={anchorRef}
                onRequestClose={() => {
                    setIsPinnedOpen(false);
                    setIsHovered(false);
                }}
                maxWidthCap={360}
                testID="agent-input-provider-usage-popover"
                content={(
                    <View style={styles.popoverContent}>
                        <Text style={styles.popoverTitle}>
                            {title}
                        </Text>
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
                                    <Text style={styles.meterRight} numberOfLines={1}>
                                        {row.detailRightLabel}
                                    </Text>
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
                )}
            />
        </>
    );
}, areProviderUsageBadgePropsEqual);

const stylesheet = StyleSheet.create((theme) => ({
    badgeContainer: { flexShrink: 1, maxWidth: '100%' },
    badge: {
        position: 'relative',
        flexDirection: 'row',
        minWidth: 20,
        minHeight: 20,
        maxWidth: '100%',
        flexWrap: 'wrap',
        gap: 8,
        borderRadius: 999,
        justifyContent: 'center',
        alignItems: 'center',
    },
    badgePressed: {
        opacity: 0.9,
        transform: [{ scale: 0.96 }],
    },
    windowRing: {
        maxWidth: '100%',
        flexShrink: 1,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 4,
    },
    windowLabel: {
        minWidth: 0,
        flexShrink: 1,
        ...Typography.pillLabel(),
        color: theme.colors.text.secondary,
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
