import { resolveSystemTaskStepLabel } from '@/components/systemTasks/resolveSystemTaskStepLabel';
import type { SystemTaskRunState } from '@/components/systemTasks/types';
import {
    createPlanChecklistLogEntryFromSystemTaskEvent,
    resolveSystemTaskEventStepId,
    type PlanChecklistExecutionState,
    type PlanChecklistLogEntry,
} from '@/components/systemTasks/planChecklist';

import type { RemoteSshChecklistItem } from './types';

type ChecklistExecutionMap = Readonly<Record<string, PlanChecklistExecutionState>>;

export function mapRemoteSshTaskToChecklistExecution(params: Readonly<{
    snapshot: SystemTaskRunState | null;
    items: readonly RemoteSshChecklistItem[];
    selectedIds: readonly string[];
    errorTitle: string;
}>): ChecklistExecutionMap {
    const snapshot = params.snapshot;
    const selectedSet = new Set(params.selectedIds);
    const engagedItems = params.items.filter((item) => selectedSet.has(item.id));

    const result: Record<string, PlanChecklistExecutionState> = {};
    if (!snapshot) {
        for (const item of engagedItems) {
            result[item.id] = { status: 'queued', logs: [] };
        }
        return result;
    }

    const stepToItem = new Map<string, string>();
    for (const item of params.items) {
        for (const stepId of item.stepIds) {
            if (!stepToItem.has(stepId)) {
                stepToItem.set(stepId, item.id);
            }
        }
    }

    const logsByItemId = new Map<string, PlanChecklistLogEntry[]>();
    for (const item of engagedItems) {
        logsByItemId.set(item.id, []);
    }

    for (const [index, event] of snapshot.events.entries()) {
        const stepId = resolveSystemTaskEventStepId(event as { stepId?: unknown });
        if (!stepId) continue;

        const owningItemId = stepToItem.get(stepId);
        if (!owningItemId || !selectedSet.has(owningItemId)) continue;

        const logEntry = createPlanChecklistLogEntryFromSystemTaskEvent(event, resolveSystemTaskStepLabel, index);
        if (!logEntry) continue;
        logsByItemId.get(owningItemId)?.push(logEntry);
    }

    const currentStepId = typeof snapshot.currentStepId === 'string' && snapshot.currentStepId.trim().length > 0
        ? snapshot.currentStepId.trim()
        : null;
    const currentItemId = currentStepId ? stepToItem.get(currentStepId) ?? null : null;
    const currentIndex = currentItemId
        ? engagedItems.findIndex((item) => item.id === currentItemId)
        : -1;

    for (const [index, item] of engagedItems.entries()) {
        const logs = logsByItemId.get(item.id) ?? [];

        let status: PlanChecklistExecutionState['status'] = 'queued';
        let error: PlanChecklistExecutionState['error'] | undefined;

        if (snapshot.result?.ok) {
            status = 'done';
        } else if (snapshot.result && !snapshot.result.ok) {
            if (item.id === currentItemId) {
                status = 'error';
                error = {
                    title: params.errorTitle,
                    message: snapshot.result.error.message ?? snapshot.result.error.code ?? undefined,
                    raw: snapshot.result.error,
                };
            } else if (currentIndex >= 0 && index < currentIndex) {
                status = 'done';
            }
        } else if (item.id === currentItemId) {
            status = 'running';
        } else if (currentIndex >= 0 && index < currentIndex) {
            status = 'done';
        }

        result[item.id] = { status, logs, ...(error ? { error } : {}) };
    }

    return result;
}
