import * as React from 'react';
import { Ionicons } from '@expo/vector-icons';

import type { ParticipantRecipientV1 } from '@happier-dev/protocol';

import type { AgentInputExtraActionChip, AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { t } from '@/text';

import { ExecutionRunDeliveryChip } from './ExecutionRunDeliveryChip';
import { buildExecutionRunDeliveryPickerOptions, resolveExecutionRunDeliveryLabel } from './executionRunDeliveryOptions';
import type { ExecutionRunDeliveryMode } from './useSessionRecipientState';

/**
 * Shared root-step builder used by BOTH the chip-definition factory (action-menu
 * route) and the inline `ExecutionRunDeliveryChip` (direct chip route).
 * Per-option `onSelect` callbacks are the canonical action source for
 * `presentation: 'list'` descriptors.
 */
export function buildExecutionRunDeliveryRootStep(params: Readonly<{
    onSelect?: (selectedId: ExecutionRunDeliveryMode) => void;
}> = {}): SelectionListStep {
    const options = buildExecutionRunDeliveryPickerOptions();
    return {
        id: 'execution-run-delivery-root',
        title: t('runs.delivery.title'),
        sections: [
            {
                kind: 'static',
                id: 'delivery',
                options: options.map((option) => ({
                    id: option.id,
                    label: option.label,
                    subtitle: option.subtitle,
                    onSelect: params.onSelect
                        ? () => params.onSelect!(option.id as ExecutionRunDeliveryMode)
                        : undefined,
                })),
            },
        ],
    };
}

export function createExecutionRunDeliveryActionChip(params: Readonly<{
    recipient: ParticipantRecipientV1 | null;
    delivery: ExecutionRunDeliveryMode;
    onDeliveryChange: (next: ExecutionRunDeliveryMode) => void;
}>): AgentInputExtraActionChip {
    const rootStep = buildExecutionRunDeliveryRootStep({
        onSelect: (selectedId) => {
            if (selectedId === 'prompt' || selectedId === 'steer_if_supported' || selectedId === 'interrupt') {
                params.onDeliveryChange(selectedId);
            }
        },
    });
    return {
        key: 'execution-run-delivery',
        controlId: 'delivery',
        collapsedOptionsPopover: {
            presentation: 'list',
            title: t('runs.delivery.title'),
            label: t('runs.delivery.cardDelivery', {
                label: resolveExecutionRunDeliveryLabel(params.delivery),
            }),
            icon: (tint) => <Ionicons name="options-outline" size={16} color={tint} />,
            rootStep,
            selectedOptionId: params.delivery,
            onSelect: () => {
                // List-mode option mutations live on per-option SelectionListOption.onSelect
                // (set inside `buildExecutionRunDeliveryRootStep`). The overlay route
                // closes on selection but does NOT call this descriptor-level callback.
                // Documented no-op for parity with the chip-picker contract.
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
