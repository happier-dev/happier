import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { Text } from '@/components/ui/text/Text';
import { ProviderUsageRing } from '@/components/sessions/usage/ProviderUsageRing';
import { ProviderUsageDetails } from '@/components/sessions/usage/ProviderUsageDetails';
import { Typography } from '@/constants/Typography';
import { t } from '@/text';
import type { ConnectedServiceQuotaGaugeViewModel } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';

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
    /** Asks the provider for fresh figures; runs on every press of the rings. */
    onRefresh?: () => void;
    /** Which side of the rings the popup opens on. Defaults to above, as in the composer. */
    popoverPlacement?: 'top' | 'bottom';
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
            && ring.remainingPct === other.remainingPct
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
        && left.sourceProfileId === right.sourceProfileId
        && left.providerDisplayName === right.providerDisplayName
        && left.activeAccountDisplayLabel === right.activeAccountDisplayLabel
        && left.remainingPct === right.remainingPct
        && left.usedPct === right.usedPct
        && left.valueLabel === right.valueLabel
        && left.ringValueLabel === right.ringValueLabel
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
        && left.onRefresh === right.onRefresh
        && areProviderUsageViewModelsEqual(left.viewModel, right.viewModel);
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
            usedPct: props.viewModel.usedPct, remainingPct: props.viewModel.remainingPct, ringValueLabel: props.viewModel.ringValueLabel,
            valueLabel: props.viewModel.valueLabel, tone: props.viewModel.tone }];
    // Remaining-first, like the ring numbers. Extra rings are named so each one can be told apart.
    const ringAccessibilityValues = rings.length === 1
        ? [props.viewModel.badgeLabel]
        : rings.map((ring) => `${ring.label} ${ring.valueLabel}`);
    const accessibilityLabel = t('agentInput.providerUsage.accessibilityLabel', {
        value: ringAccessibilityValues.join(', '),
    });


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
                    props.onRefresh?.();
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
                            {rings.map((ring) => ring.label).join(' / ')}
                        </Text>
                    ) : null}
                    <ProviderUsageRing
                        gauge={props.viewModel}
                        size={20}
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
                placement={props.popoverPlacement}
                testID="agent-input-provider-usage-popover"
                content={open ? (
                    <ProviderUsageDetails
                        viewModel={props.viewModel}
                        ringBaseSize={20}
                        onRecoveryCreditPress={props.onRecoveryCreditPress}
                        recoveryCreditActionPending={props.recoveryCreditActionPending}
                    />
                ) : null}
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
}));
