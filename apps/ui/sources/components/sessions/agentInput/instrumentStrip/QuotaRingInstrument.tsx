import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useSharedValue } from 'react-native-reanimated';
import { GaugeRing } from '@/components/instrument/gauge/GaugeRing';

import { SessionUsagePopoverContent } from '@/components/navigation/shell/sidebarFooter/SessionUsagePopoverContent';
import { RAIL_POPOVER_WIDE_WIDTH_PX } from '@/components/navigation/shell/sidebarFooter/sidebarFooterLayout';
import { TokenUsageRing, type TokenUsageTone } from '@/components/sessions/usage';
import { useHoverPreviewPopover } from '@/components/ui/popover/useHoverPreviewPopover';
import { Text } from '@/components/ui/text/Text';
import type { ConnectedServiceQuotaGaugeViewModel } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import type { Metadata } from '@happier-dev/session-core/state';
import { t } from '@/text';

import { AgentInputContentPopover } from '../components/AgentInputContentPopover';
import { motionTokens } from '@/components/ui/motion/motionTokens';
import { instrumentStripStyles, useInstrumentStripHitReach } from './instrumentStripStyles';
import { HappierPressable } from '@happier-dev/plugin-ui/presentation';

/**
 * Plan/quota usage instrument: the ring is the session's tightest limit (the canonical System-B quota
 * view model). Resting on it previews and a press pins the one Usage popover (lab `csvc` U3), scoped
 * to the account this session signs in with, with "All accounts" to widen it.
 */

export type QuotaRingInstrumentProps = Readonly<{
    viewModel: ConnectedServiceQuotaGaugeViewModel;
    /** The session's metadata and agent: the popover reads which account the session signs in with. */
    metadata?: Metadata | null;
    agentId?: string | null;
    /** The session's own usage-reset action, for a session that signs in on its own. */
    onRecoveryCreditPress?: () => void;
    recoveryCreditPending?: boolean;
    /** Show the provider caption under the ring (≥360px available width). */
    showProviderGlyph: boolean;
    /** Also name a lone ring; multiple rings always show their usage windows. */
    showLabels?: boolean;
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
    const hitReach = useInstrumentStripHitReach();
    // Resting the pointer on the ring previews the popover (web); a press pins it (the shared hover owner).
    const { mode, toggle, close, hoverProps, popoverLayer } = useHoverPreviewPopover({ enabled: Platform.OS === 'web' });

    const { viewModel } = props;
    // Each globally selected window reports the percentage left.
    const rings = viewModel.usageRings.length > 0
        ? viewModel.usageRings
        : [{
            meterId: viewModel.effectiveMeter.meterId,
            label: viewModel.effectiveMeter.label,
            usedPct: viewModel.usedPct,
            ringValueLabel: viewModel.ringValueLabel,
            valueLabel: viewModel.valueLabel,
            tone: viewModel.tone,
        }];
    // One ring reads as before; extra rings are named so each one can be told apart.
    const ringAccessibilityValues = rings.length === 1
        ? [viewModel.badgeLabel]
        : rings.map((ring) => `${ring.label} ${ring.valueLabel}`);
    const accessibilityLabel = t('agentInput.providerUsage.accessibilityLabel', {
        value: ringAccessibilityValues.join(', '),
    });
    const providerCaption = viewModel.scopePrefix ?? viewModel.providerDisplayName;
    // Each ring says what is left beside it ("9% left"), at every width: a bare number inside the ring
    // next to the context gauge reads as another percentage used. A compact strip drops only the caption.

    return (
        <>
            <View ref={anchorRef} style={styles.trigger} {...hoverProps}>
                <HappierPressable
                    testID={props.testID ?? 'session-instrument-quota-ring'}
                    accessibilityRole="button"
                    accessibilityLabel={accessibilityLabel}
                    onPress={() => toggle()}
                    hitReach={hitReach}
                    style={({ pressed }) => (pressed ? styles.triggerPressed : null)}
                >
                    <View style={styles.rings}>
                        {rings.map((ring, index) => {
                            const testIDSuffix = index === 0 ? '' : `:${ring.meterId}`;
                            return (
                                <View key={ring.meterId} style={styles.ring}>
                                    {props.showLabels === true || rings.length > 1 ? (
                                        <Text
                                            testID={`session-instrument-quota-meter-label${testIDSuffix}`}
                                            style={instrumentStripStyles.instrumentLabelText}
                                            numberOfLines={1}
                                        >
                                            {ring.label}
                                        </Text>
                                    ) : null}
                                    <TokenUsageRing
                                        used={ring.usedPct}
                                        limit={100}
                                        label={rings.length === 1 ? accessibilityLabel : ringAccessibilityValues[index]!}
                                        tone={mapQuotaToneToTokenTone(ring.tone)}
                                        size={16}
                                        strokeWidth={2}
                                        ringTestID={`session-instrument-quota-ring-arc${testIDSuffix}`}
                                    />
                                    <Text
                                        testID={`session-instrument-quota-ring-value${testIDSuffix}`}
                                        style={instrumentStripStyles.instrumentValueText}
                                        numberOfLines={1}
                                    >
                                        {ring.valueLabel}
                                    </Text>
                                </View>
                            );
                        })}
                    </View>
                </HappierPressable>
                {props.showProviderGlyph && providerCaption ? (
                    <Text style={styles.providerCaption} numberOfLines={1}>
                        {providerCaption}
                    </Text>
                ) : null}
            </View>

            <AgentInputContentPopover
                open={mode !== 'closed'}
                autoFocusOnOpen={mode === 'open'}
                hoverProps={hoverProps}
                layer={popoverLayer}
                anchorRef={anchorRef}
                onRequestClose={close}
                maxWidthCap={RAIL_POPOVER_WIDE_WIDTH_PX}
                testID="session-instrument-quota-popover"
                content={(
                    <SessionUsagePopoverContent
                        close={close}
                        metadata={props.metadata ?? null}
                        agentId={props.agentId ?? null}
                        viewModel={viewModel}
                        onUseReset={props.onRecoveryCreditPress}
                        resetPending={props.recoveryCreditPending}
                    />
                )}
            />
        </>
    );
});

/**
 * The ring when the Session's first quota read failed (the one owner, `useSessionProviderUsage().quotaReadFailed`,
 * decides it; the Session Companion says the same words): the strip's unknown ring, the context gauge's stale form
 * (track and a dot, no fill), so it is never an empty ring a person can mistake for the context gauge at session
 * start. The words are quiet ink (nothing needs the person here); a press is the owner's next read, where it has one.
 */
export function QuotaRingUnavailable(props: Readonly<{ onRetry?: (() => void) | null }>) {
    const { theme } = useUnistyles();
    const hitReach = useInstrumentStripHitReach();
    const fillPct = useSharedValue(0);
    const strokeColor = useSharedValue(theme.colors.text.tertiary);
    const label = t('agentInput.providerUsage.accessibilityLabel', { value: t('usage.board.page.readFailedTitle') });
    const body = (
        <View style={quotaStyles.ring}>
            <GaugeRing fillPct={fillPct} strokeColor={strokeColor} size={16} trackColor={theme.colors.border.default}
                stale staleDotColor={theme.colors.text.tertiary} testID="session-instrument-quota-ring-arc" />
            <Text testID="session-instrument-quota-ring-value" style={[instrumentStripStyles.instrumentValueText, { color: theme.colors.text.tertiary }]}
                numberOfLines={1}>
                {t('usage.board.page.readFailedTitle')}
            </Text>
        </View>
    );
    return (
        <View style={quotaStyles.trigger}>
            {props.onRetry ? (
                <HappierPressable testID="session-instrument-quota-ring" accessibilityRole="button"
                    accessibilityLabel={`${label}, ${t('common.retry')}`} onPress={props.onRetry} hitReach={hitReach}
                    style={({ pressed }) => (pressed ? quotaStyles.triggerPressed : null)}>
                    {body}
                </HappierPressable>
            ) : (
                <View testID="session-instrument-quota-ring" accessible accessibilityLabel={label}>{body}</View>
            )}
        </View>
    );
}

const quotaStyles = StyleSheet.create((theme) => ({
    trigger: {
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
    },
    triggerPressed: {
        opacity: motionTokens.press.opacitySubtle,
    },
    rings: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s8,
    },
    ring: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.space.s4,
    },
    providerCaption: {
        fontSize: 8,
        lineHeight: 9,
        letterSpacing: 0.4,
        textTransform: 'uppercase',
        color: theme.colors.text.tertiary,
        maxWidth: 44,
    },
}));
