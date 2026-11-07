import * as React from 'react';
import { useUnistyles } from 'react-native-unistyles';

import { CapacityRing } from '@/components/ui/progress/CapacityRing';
import { TokenUsageRing, type TokenUsageRingProps } from './TokenUsageRing';
import type { ConnectedServiceQuotaGaugeViewModel } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import { t } from '@/text';

const RAIL_RING_SIZE = 18;

export function getProviderUsageRingSize(gauge: ConnectedServiceQuotaGaugeViewModel, baseSize = RAIL_RING_SIZE): number {
    return baseSize + Math.max(0, gauge.usageRings.length - 1) * 6;
}

/**
 * One Agent row's usage ring in the picker rail. A row without a gauge (Agent not
 * installed, not configured, or with no usage source) shows an empty, light-grey
 * ring with no number, so it reads as "nothing to show" rather than a selection control.
 */
export function ProviderUsageRing(props: Readonly<{
    gauge: ConnectedServiceQuotaGaugeViewModel | null;
    testID?: string;
    ringTestID?: string;
    valueTestID?: string;
    size?: number;
}>) {
    const { theme } = useUnistyles();
    if (!props.gauge) {
        return (
            <CapacityRing
                ratio={0}
                size={RAIL_RING_SIZE}
                strokeWidth={2}
                trackColor={theme.colors.border.subtle}
                testID={props.testID}
            />
        );
    }
    const gauge = props.gauge;
    const limits = gauge.usageRings.length > 0 ? gauge.usageRings : [gauge];
    const rings = limits.map((ring) => ({
        used: ring.remainingPct ?? 100 - ring.usedPct,
        limit: 100,
        remainingPct: ring.remainingPct ?? 100 - ring.usedPct,
        tone: ring.tone === 'critical' ? 'critical' : ring.tone === 'warning' ? 'warning' : 'neutral',
    } satisfies NonNullable<TokenUsageRingProps['rings']>[number]));
    const label = t('agentInput.providerUsage.accessibilityLabel', {
        value: gauge.usageRings.length > 1
            ? gauge.usageRings.map((ring) => `${ring.label} ${ring.valueLabel}`).join(', ')
            : gauge.badgeLabel,
    });
    return (
        <TokenUsageRing
            {...rings[0]}
            rings={rings}
            label={label}
            value={(limits.find((ring) => 'meterId' in ring && ring.meterId === gauge.effectiveMeter?.meterId) ?? limits[0]).ringValueLabel}
            size={getProviderUsageRingSize(gauge, props.size)}
            testID={props.testID}
            ringTestID={props.ringTestID}
            valueTestID={props.valueTestID}
        />
    );
}
