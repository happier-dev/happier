import * as React from 'react';
import { Pressable } from 'react-native';

import { ProviderUsageRing } from '@/components/sessions/usage/ProviderUsageRing';
import type { ConnectedServiceQuotaGaugeViewModel } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
import type { AgentInputChipPickerOption } from './AgentInputChipPickerTypes';
import { t } from '@/text';

/** The provider reading and refresh action are independent of whether its row can be selected. */
export function AgentInputProviderUsageMark(props: Readonly<{
    option: AgentInputChipPickerOption;
    gaugesByOptionId: ReadonlyMap<string, ConnectedServiceQuotaGaugeViewModel>;
    onRefresh?: () => void;
}>) {
    return (
        <Pressable
            testID={`agent-input-chip-picker.usage-refresh:${props.option.id}`}
            accessibilityRole="button"
            accessibilityLabel={t('common.refresh')}
            disabled={!props.onRefresh}
            hitSlop={13}
            onPress={(event) => {
                event.stopPropagation();
                props.onRefresh?.();
            }}
        >
            <ProviderUsageRing
                gauge={props.gaugesByOptionId.get(props.option.id) ?? null}
                testID={`agent-input-chip-picker.usage:${props.option.id}`}
            />
        </Pressable>
    );
}
