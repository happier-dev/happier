import { t } from '@/text';

import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';

import type { ExecutionRunDeliveryMode } from './useSessionRecipientState';

const EXECUTION_RUN_DELIVERY_MODE_ORDER: readonly ExecutionRunDeliveryMode[] = [
    'prompt',
    'steer_if_supported',
    'interrupt',
];

export function resolveExecutionRunDeliveryLabel(mode: ExecutionRunDeliveryMode): string {
    if (mode === 'interrupt') return t('runs.delivery.interruptLabel');
    if (mode === 'prompt') return t('runs.delivery.promptLabel');
    return t('runs.delivery.steerLabel');
}

function resolveExecutionRunDeliverySubtitle(mode: ExecutionRunDeliveryMode): string | undefined {
    if (mode === 'interrupt') return t('runs.delivery.interruptHelp');
    if (mode === 'prompt') return undefined;
    return t('runs.delivery.steerHelp');
}

export function buildExecutionRunDeliveryPickerOptions(): ReadonlyArray<AgentInputChipPickerOption> {
    return EXECUTION_RUN_DELIVERY_MODE_ORDER.map((mode) => ({
        id: mode,
        label: resolveExecutionRunDeliveryLabel(mode),
        subtitle: resolveExecutionRunDeliverySubtitle(mode),
    }));
}
