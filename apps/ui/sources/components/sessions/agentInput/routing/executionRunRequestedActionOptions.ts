import { t } from '@/text';
import type { PendingRequestedActionV1 } from '@happier-dev/protocol';

import type { AgentInputChipPickerOption } from '@/components/sessions/agentInput/components/AgentInputChipPickerTypes';

const EXECUTION_RUN_REQUESTED_ACTION_ORDER = [
    'enqueue',
    'steer_if_active',
    'send_now',
] as const satisfies readonly PendingRequestedActionV1['kind'][];

export type ExecutionRunRequestedActionKind = (typeof EXECUTION_RUN_REQUESTED_ACTION_ORDER)[number];

export function resolveExecutionRunRequestedActionLabel(kind: PendingRequestedActionV1['kind']): string {
    if (kind === 'send_now' || kind === 'steer_now') return t('runs.delivery.interruptLabel');
    if (kind === 'enqueue') return t('runs.delivery.promptLabel');
    return t('runs.delivery.steerLabel');
}

function resolveExecutionRunRequestedActionSubtitle(kind: PendingRequestedActionV1['kind']): string | undefined {
    if (kind === 'send_now' || kind === 'steer_now') return t('runs.delivery.interruptHelp');
    if (kind === 'enqueue') return undefined;
    return t('runs.delivery.steerHelp');
}

export function buildExecutionRunRequestedActionPickerOptions(): ReadonlyArray<AgentInputChipPickerOption & Readonly<{ id: ExecutionRunRequestedActionKind }>> {
    return EXECUTION_RUN_REQUESTED_ACTION_ORDER.map((kind) => ({
        id: kind,
        label: resolveExecutionRunRequestedActionLabel(kind),
        subtitle: resolveExecutionRunRequestedActionSubtitle(kind),
    }));
}
