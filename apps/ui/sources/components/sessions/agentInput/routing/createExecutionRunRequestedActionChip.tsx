import * as React from 'react';

import type { ParticipantRecipientV1, PendingRequestedActionV1 } from '@happier-dev/protocol';

import type { AgentInputExtraActionChip, AgentInputExtraActionChipRenderContext } from '@/components/sessions/agentInput/agentInputContracts';
import type { SelectionListStep } from '@/components/ui/selectionList';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';

import { ExecutionRunRequestedActionChip } from './ExecutionRunRequestedActionChip';
import { buildExecutionRunRequestedActionPickerOptions, resolveExecutionRunRequestedActionLabel, type ExecutionRunRequestedActionKind } from './executionRunRequestedActionOptions';

/** Shared picker definition for the action-menu and inline chip routes. */
export function buildExecutionRunRequestedActionRootStep(params: Readonly<{
    onSelect?: (selectedId: ExecutionRunRequestedActionKind) => void;
}> = {}): SelectionListStep {
    const options = buildExecutionRunRequestedActionPickerOptions();
    return {
        id: 'execution-run-requested-action-root',
        title: t('runs.delivery.title'),
        sections: [{
            kind: 'static',
            id: 'requested-action',
            options: options.map((option) => ({
                id: option.id,
                label: option.label,
                subtitle: option.subtitle,
                onSelect: params.onSelect
                    ? () => params.onSelect!(option.id)
                    : undefined,
            })),
        }],
    };
}

export function createExecutionRunRequestedActionChip(params: Readonly<{
    recipient: ParticipantRecipientV1 | null;
    requestedAction: PendingRequestedActionV1;
    onRequestedActionChange: (next: PendingRequestedActionV1) => void;
}>): AgentInputExtraActionChip {
    const rootStep = buildExecutionRunRequestedActionRootStep({
        onSelect: (kind) => params.onRequestedActionChange({ v: 1, kind }),
    });
    return {
        key: 'execution-run-requested-action',
        controlId: 'delivery',
        collapsedOptionsPopover: {
            presentation: 'list',
            title: t('runs.delivery.title'),
            label: t('runs.delivery.cardDelivery', {
                label: resolveExecutionRunRequestedActionLabel(params.requestedAction.kind),
            }),
            icon: (tint) => <Icon name="sliders-horizontal" size={16} color={tint} />,
            rootStep,
            selectedOptionId: params.requestedAction.kind,
            onSelect: () => undefined,
            maxHeightCap: 320,
        },
        render: (ctx: AgentInputExtraActionChipRenderContext) => (
            <ExecutionRunRequestedActionChip
                recipient={params.recipient}
                requestedAction={params.requestedAction}
                onRequestedActionChange={params.onRequestedActionChange}
                ctx={ctx}
            />
        ),
    };
}
