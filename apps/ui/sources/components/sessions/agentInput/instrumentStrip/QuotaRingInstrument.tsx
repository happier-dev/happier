import * as React from 'react';
import { Platform, View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

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
