import * as React from 'react';
import { Platform, Pressable, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import { TokenUsageRing, type TokenUsageTone } from '@/components/sessions/usage';
import { MeterBar } from '@/components/ui/lists/MeterBar';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import type { ConnectedServiceQuotaGaugeViewModel } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { resolveQuotaTone } from '@/sync/domains/connectedServices/resolveQuotaTone';
import { t } from '@/text';

import { AgentInputContentPopover } from '../components/AgentInputContentPopover';
import { instrumentStripStyles } from './instrumentStripStyles';

/**
 * Plan/quota usage instrument. Data path + popover content are the canonical
 * System-B quota view model (unchanged — see AUDIT §1 System B; L5 restyles the
 * trigger ONLY). Distinguished from the context gauge by a thin stroke ring and
 * a "Plan usage" popover title.
 */

export type QuotaRingInstrumentProps = Readonly<{
    viewModel: ConnectedServiceQuotaGaugeViewModel;
    onRecoveryCreditPress?: () => void;
    recoveryCreditPending?: boolean;
    /** Show the provider caption under the ring (≥360px available width). */
    showProviderGlyph: boolean;
    testID?: string;
}>;

function mapQuotaToneToTokenTone(tone: ConnectedServiceQuotaGaugeViewModel['tone']): TokenUsageTone {
    if (tone === 'critical') return 'critical';
    if (tone === 'warning') return 'warning';
    return 'neutral';
}

export const QuotaRingInstrument = React.memo(function QuotaRingInstrument(props: QuotaRingInstrumentProps) {
    const styles = quotaStyles;
    const anchorRef = React.useRef(null);
    // Web parity with the replaced badge: hover previews the popover, press pins it.
    const [isPinnedOpen, setIsPinnedOpen] = React.useState(false);
    const [isHovered, setIsHovered] = React.useState(false);
    const open = isPinnedOpen || isHovered;

    const { viewModel } = props;
    const accessibilityLabel = t('agentInput.providerUsage.accessibilityLabel', {
        value: viewModel.badgeLabel,
    });
    const providerCaption = viewModel.scopePrefix ?? viewModel.providerDisplayName;
    const recoveryCreditSummary = viewModel.recoveryCreditSummary;
    const recoveryCreditSubtitle = recoveryCreditSummary
        ? typeof recoveryCreditSummary.nextExpiresAtMs === 'number'
            ? t('connectedServices.quota.recoveryCreditExpires', {
                time: new Date(recoveryCreditSummary.nextExpiresAtMs).toLocaleString(),
            })
            : t('connectedServices.quota.recoveryCreditSubtitle')
        : null;

    return (
        <>
            <View ref={anchorRef} style={styles.trigger}>
                <Pressable
                    testID={props.testID ?? 'session-instrument-quota-ring'}
                    accessibilityRole="button"
                    accessibilityLabel={accessibilityLabel}
                    onPress={() => setIsPinnedOpen((previous) => !previous)}
                    onHoverIn={Platform.OS === 'web' ? () => setIsHovered(true) : undefined}
                    onHoverOut={Platform.OS === 'web' ? () => setIsHovered(false) : undefined}
                    hitSlop={12}
                    style={({ pressed }) => (pressed ? styles.triggerPressed : null)}
                >
                    <TokenUsageRing
                        used={viewModel.usedPct}
                        limit={100}
                        label={accessibilityLabel}
                        value={viewModel.ringValueLabel}
                        tone={mapQuotaToneToTokenTone(viewModel.tone)}
                        size={16}
                        strokeWidth={2}
                        ringTestID="session-instrument-quota-ring-arc"
                        valueTestID="session-instrument-quota-ring-value"
                    />
                </Pressable>
                {props.showProviderGlyph && providerCaption ? (
                    <Text style={styles.providerCaption} numberOfLines={1}>
                        {providerCaption}
                    </Text>
                ) : null}
            </View>

            <AgentInputContentPopover
                open={open}
                anchorRef={anchorRef}
                onRequestClose={() => {
                    setIsPinnedOpen(false);
                    setIsHovered(false);
                }}
                maxWidthCap={360}
                scrollEnabled={false}
                testID="session-instrument-quota-popover"
                content={(
                    <View style={styles.popoverContent}>
                        <Text style={styles.popoverTitle}>
                            {t('instrument.quota.popoverTitle')}
                        </Text>
                        <Text style={styles.popoverDetail}>
                            {viewModel.detailRightLabel}
                        </Text>
                        {viewModel.allMeterRows.map((row) => (
                            <View
                                key={row.meterId}
                                style={styles.meterRow}
                            >
                                <View style={styles.meterHeader}>
                                    <Text style={styles.meterLabel} numberOfLines={1}>{row.label}</Text>
                                    <Text style={styles.meterRight} numberOfLines={1}>{row.detailRightLabel}</Text>
                                </View>
                                {/* Canonical MeterBar (L3 T4.1): fill = USED fraction; tone via the
                                    single quota-threshold owner (resolveQuotaTone on remainingPct). */}
                                <MeterBar
                                    testID={`session-instrument-quota-meter:${row.meterId}`}
                                    tone={resolveQuotaTone(row.remainingPct)}
                                    fillFraction={row.usedPct / 100}
                                    height={5}
                                />
                                {row.usedLimitLabel ? (
                                    <Text style={styles.meterUsage}>{row.usedLimitLabel}</Text>
                                ) : null}
                            </View>
                        ))}
                        {recoveryCreditSummary ? (
                            <View
                                testID="session-instrument-quota-recovery-credit"
                                style={styles.recoveryCreditBox}
                            >
                                <Text style={styles.recoveryCreditTitle}>
                                    {t('connectedServices.quota.recoveryCreditTitle', {
                                        count: recoveryCreditSummary.availableCount,
                                    })}
                                </Text>
                                {recoveryCreditSubtitle ? (
                                    <Text style={styles.recoveryCreditSubtitle}>{recoveryCreditSubtitle}</Text>
                                ) : null}
                                {props.onRecoveryCreditPress ? (
                                    <Pressable
                                        testID="session-instrument-quota-recovery-credit-action"
                                        accessibilityRole="button"
                                        disabled={props.recoveryCreditPending === true}
                                        onPress={props.onRecoveryCreditPress}
                                        style={(state) => [
                                            styles.recoveryCreditAction,
                                            state.pressed ? styles.recoveryCreditActionPressed : null,
                                            props.recoveryCreditPending === true ? styles.recoveryCreditActionDisabled : null,
                                        ]}
                                    >
                                        <Text style={styles.recoveryCreditActionText}>
                                            {props.recoveryCreditPending === true
                                                ? t('connectedServices.quota.recoveryCreditApplying')
                                                : t('session.usageLimitRecovery.actions.consumeResetCredit')}
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
});

const quotaStyles = StyleSheet.create((theme) => ({
    trigger: {
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
    },
    triggerPressed: {
        opacity: 0.85,
    },
    providerCaption: {
        fontSize: 8,
        lineHeight: 9,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        color: theme.colors.text.tertiary,
        maxWidth: 44,
    },
    popoverContent: {
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 10,
    },
    popoverTitle: {
        fontSize: 11,
        letterSpacing: 1,
        textTransform: 'uppercase',
        color: theme.colors.text.secondary,
        ...Typography.header(),
    },
    popoverDetail: {
        fontSize: 13,
        color: theme.colors.text.primary,
        ...Typography.default(),
    },
    meterRow: {
        gap: 6,
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
    recoveryCreditBox: {
        gap: 6,
        paddingTop: 2,
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
        minHeight: 28,
        paddingHorizontal: 10,
        borderRadius: 8,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: theme.colors.button.primary.background,
    },
    recoveryCreditActionPressed: {
        opacity: 0.85,
    },
    recoveryCreditActionDisabled: {
        opacity: 0.6,
    },
    recoveryCreditActionText: {
        fontSize: 12,
        color: theme.colors.button.primary.tint,
        ...Typography.default('semiBold'),
    },
}));
