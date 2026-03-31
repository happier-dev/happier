import type { SystemTaskResult, SystemTaskRunState } from '@/components/systemTasks/types';
import type {
    RelayHostLocalChecklistExecution,
    RelayHostLocalChecklistItem,
    RelayHostLocalChecklistItemId,
    RelayHostLocalChecklistLogEntry,
    RelayHostLocalChecklistStatus,
} from './types';

function extractErrorMessage(result: SystemTaskResult | null): string | null {
    if (!result || result.ok) return null;
    const message = typeof result.error?.message === 'string' ? result.error.message.trim() : '';
    return message || result.error.code || null;
}

function extractLogsForItem(item: RelayHostLocalChecklistItem, snapshot: SystemTaskRunState | null): readonly RelayHostLocalChecklistLogEntry[] {
    if (!snapshot?.events?.length) {
        return [];
    }

    const stepIds = new Set(item.stepIds);
    return snapshot.events
        .filter((event) => {
            const eventStepId = typeof event.stepId === 'string' ? event.stepId : null;
            return eventStepId ? stepIds.has(eventStepId) : false;
        })
        .map((event) => ({
            ts: typeof event.tsMs === 'number' ? event.tsMs : Date.now(),
            level: (event.type === 'error' ? 'error' : event.type === 'prompt' ? 'warn' : 'info') as RelayHostLocalChecklistLogEntry['level'],
            stepId: typeof event.stepId === 'string' ? event.stepId : null,
            message: typeof event.message === 'string' ? event.message.trim() : '',
        }))
        .filter((entry) => entry.message.length > 0);
}

export function mapRelayHostLocalChecklistExecution(params: Readonly<{
    items: readonly RelayHostLocalChecklistItem[];
    selectedIds: readonly RelayHostLocalChecklistItemId[];
    activeItemId: RelayHostLocalChecklistItemId | null;
    activeSnapshot: SystemTaskRunState | null;
    completedItemIds: readonly RelayHostLocalChecklistItemId[];
    failedItemIds: readonly RelayHostLocalChecklistItemId[];
    logsById: Partial<Record<RelayHostLocalChecklistItemId, readonly RelayHostLocalChecklistLogEntry[]>>;
    errorById: Partial<Record<RelayHostLocalChecklistItemId, string | null>>;
}>): Readonly<Record<RelayHostLocalChecklistItemId, RelayHostLocalChecklistExecution>> {
    const selected = new Set(params.selectedIds);
    const completed = new Set(params.completedItemIds);
    const failed = new Set(params.failedItemIds);

    const executionById = Object.fromEntries(
        params.items.map((item) => {
            let status: RelayHostLocalChecklistStatus = 'idle';
            if (item.satisfied) {
                status = 'done';
            } else if (failed.has(item.id)) {
                status = 'error';
            } else if (completed.has(item.id)) {
                status = 'done';
            } else if (params.activeItemId === item.id) {
                status = 'running';
            } else if (selected.has(item.id)) {
                status = 'queued';
            }

            const logs = params.logsById[item.id] ?? (params.activeItemId === item.id ? extractLogsForItem(item, params.activeSnapshot) : []);
            const errorMessage = params.errorById[item.id] ?? (status === 'error' ? extractErrorMessage(params.activeSnapshot?.result ?? null) : null);

            return [
                item.id,
                {
                    status,
                    selected: selected.has(item.id),
                    expanded: false,
                    logs,
                    errorMessage,
                },
            ] as const;
        }),
    ) as Record<RelayHostLocalChecklistItemId, RelayHostLocalChecklistExecution>;

    return executionById;
}
