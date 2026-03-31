import type { SystemTaskRunState } from '@/components/systemTasks/types';

import type {
    RemoteSshChecklistItem,
    RemoteSshChecklistItemExecution,
    RemoteSshChecklistItemExecutionStatus,
    RemoteSshChecklistItemId,
} from './remoteSshChecklistTypes';

type ChecklistExecutionMap = Readonly<Record<RemoteSshChecklistItemId, RemoteSshChecklistItemExecution>>;

function eventStepId(event: { stepId?: unknown }): string | null {
    if (typeof event.stepId !== 'string') {
        return null;
    }
    const stepId = event.stepId.trim();
    return stepId.length > 0 ? stepId : null;
}

function eventMessage(event: { message?: unknown; type?: unknown }): string | null {
    if (typeof event.message === 'string' && event.message.trim().length > 0) {
        return event.message.trim();
    }
    if (event.type === 'prompt') {
        return 'Waiting for confirmation';
    }
    return null;
}

export function mapRemoteSshTaskToChecklistExecution(params: Readonly<{
    snapshot: SystemTaskRunState | null;
    items: readonly RemoteSshChecklistItem[];
}>): ChecklistExecutionMap {
    const snapshot = params.snapshot;
    const emptyMap = Object.fromEntries(
        params.items.map((item) => [item.id, { status: 'idle', logs: [], errorMessage: null }]),
    ) as ChecklistExecutionMap;
    if (!snapshot) {
        return emptyMap;
    }

    const currentStepId = typeof snapshot.currentStepId === 'string' && snapshot.currentStepId.trim().length > 0
        ? snapshot.currentStepId.trim()
        : null;
    const currentItemIndex = currentStepId
        ? params.items.findIndex((item) => item.stepIds.some((stepId) => stepId === currentStepId))
        : -1;
    const byItemId = new Map<RemoteSshChecklistItemId, RemoteSshChecklistItemExecution & { mutableLogs: string[] }>();
    for (const item of params.items) {
        byItemId.set(item.id, {
            status: 'idle',
            logs: [],
            errorMessage: null,
            mutableLogs: [],
        });
    }

    for (const event of snapshot.events) {
        const stepId = eventStepId(event as { stepId?: unknown });
        if (!stepId) continue;
        const message = eventMessage(event as { message?: unknown; type?: unknown });
        if (!message) continue;

        const owningItem = params.items.find((item) => item.stepIds.some((ownedStepId) => ownedStepId === stepId));
        if (!owningItem) continue;

        const target = byItemId.get(owningItem.id);
        if (!target) continue;
        target.mutableLogs.push(message);
    }

    for (const item of params.items) {
        const execution = byItemId.get(item.id);
        if (!execution) continue;

        let status: RemoteSshChecklistItemExecutionStatus = 'idle';
        if (snapshot.result?.ok) {
            status = 'done';
        } else if (currentItemIndex >= 0) {
            const itemIndex = params.items.findIndex((candidate) => candidate.id === item.id);
            if (itemIndex < currentItemIndex) {
                status = 'done';
            } else if (itemIndex === currentItemIndex) {
                if (snapshot.awaitingInput) {
                    status = 'waiting';
                } else if (snapshot.status === 'failed' || snapshot.status === 'canceled') {
                    status = 'error';
                } else {
                    status = 'running';
                }
            }
        }

        execution.status = status;
        execution.errorMessage = snapshot.result && !snapshot.result.ok && status === 'error'
            ? (snapshot.result.error.message ?? snapshot.result.error.code ?? 'Remote SSH setup failed')
            : null;
        execution.logs = execution.mutableLogs;
    }

    return Object.fromEntries(
        [...byItemId.entries()].map(([itemId, execution]) => [itemId, {
            status: execution.status,
            logs: execution.logs,
            errorMessage: execution.errorMessage,
        }]),
    ) as ChecklistExecutionMap;
}
