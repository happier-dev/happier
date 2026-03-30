import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type { AgentInputExtraActionChip, AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import { t } from '@/text';

import { ExecutionRunDeliveryChip } from './ExecutionRunDeliveryChip';
import { buildExecutionRunDeliveryPickerOptions, resolveExecutionRunDeliveryLabel } from './executionRunDeliveryOptions';
import type { ExecutionRunDeliveryMode } from './useSessionRecipientState';

export function createExecutionRunDeliveryActionChip(params: Readonly<{
    recipient: ParticipantRecipientV1 | null;
    delivery: ExecutionRunDeliveryMode;
    onDeliveryChange: (next: ExecutionRunDeliveryMode) => void;
}>): AgentInputExtraActionChip {
    return {
        key: 'execution-run-delivery',
        controlId: 'delivery',
        collapsedOptionsPopover: {
            title: t('runs.delivery.title'),
            label: t('runs.delivery.cardDelivery', {
                label: resolveExecutionRunDeliveryLabel(params.delivery),
            }),
            icon: (tint) => <Ionicons name="options-outline" size={16} color={tint} />,
            options: buildExecutionRunDeliveryPickerOptions(),
            selectedOptionId: params.delivery,
            onSelect: (selectedId) => {
                if (selectedId === 'prompt' || selectedId === 'steer_if_supported' || selectedId === 'interrupt') {
                    params.onDeliveryChange(selectedId);
                }
            },
            maxHeightCap: 320,
        },
        render: (ctx: AgentInputExtraActionChipRenderContext) => (
            <ExecutionRunDeliveryChip
                recipient={params.recipient}
                delivery={params.delivery}
                onDeliveryChange={params.onDeliveryChange}
                ctx={ctx}
            />
        ),
    };
}
