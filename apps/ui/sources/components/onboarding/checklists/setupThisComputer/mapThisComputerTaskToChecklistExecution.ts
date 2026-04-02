import { resolveSystemTaskStepLabel } from '@/components/systemTasks/resolveSystemTaskStepLabel';
import type { SystemTaskRunState } from '@/components/systemTasks/types';
import {
    createPlanChecklistLogEntryFromSystemTaskEvent,
    resolveSystemTaskEventStepId,
    type PlanChecklistExecutionState,
    type PlanChecklistLogEntry,
} from '@/components/systemTasks/planChecklist';

import type { ThisComputerChecklistItemId } from './types';

export type ThisComputerChecklistExecution = Readonly<Record<ThisComputerChecklistItemId, PlanChecklistExecutionState>>;

const ITEM_ORDER: readonly ThisComputerChecklistItemId[] = [
    'setup.thisComputer.resolveRelay',
    'setup.thisComputer.checkAuth',
    'setup.thisComputer.configureRelay',
    'setup.thisComputer.auth.request',
    'setup.thisComputer.auth.wait',
    'setup.thisComputer.installService',
    'setup.thisComputer.startService',
    'setup.thisComputer.verifyService',
    'setup.thisComputer.installTailscale',
];

const STEP_TO_ITEM: Readonly<Record<string, ThisComputerChecklistItemId>> = {
    'setup.thisComputer.resolveRelay': 'setup.thisComputer.resolveRelay',
    'setup.thisComputer.checkAuth': 'setup.thisComputer.checkAuth',
    'setup.thisComputer.configureRelay': 'setup.thisComputer.configureRelay',
    'setup.thisComputer.auth.request': 'setup.thisComputer.auth.request',
    'setup.thisComputer.auth.wait': 'setup.thisComputer.auth.wait',
    'setup.thisComputer.installService': 'setup.thisComputer.installService',
    'setup.thisComputer.startService': 'setup.thisComputer.startService',
    'setup.thisComputer.verifyService': 'setup.thisComputer.verifyService',
};

function resolveRecommendedTailscaleStatus(snapshot: SystemTaskRunState | null): PlanChecklistExecutionState['status'] {
    if (!snapshot) {
        return 'queued';
    }
    if (snapshot.status === 'succeeded') {
        return 'done';
    }
    if (snapshot.status === 'failed' || snapshot.status === 'canceled') {
        return 'error';
    }
    return 'running';
}

function normalizeStepId(stepId: unknown): string {
    return resolveSystemTaskEventStepId({ stepId }) ?? '';
}

export function mapThisComputerTaskToChecklistExecution(snapshot: SystemTaskRunState | null): ThisComputerChecklistExecution {
    const logsByItem = new Map<ThisComputerChecklistItemId, PlanChecklistLogEntry[]>();
    for (const itemId of ITEM_ORDER) {
        logsByItem.set(itemId, []);
    }

    const seenItemIds = new Set<ThisComputerChecklistItemId>();
    if (snapshot) {
        for (const [index, event] of snapshot.events.entries()) {
            const logEntry = createPlanChecklistLogEntryFromSystemTaskEvent(event, resolveSystemTaskStepLabel, index);
            if (!logEntry) {
                continue;
            }
            const stepId = normalizeStepId((event as { stepId?: unknown }).stepId);
            const itemId = STEP_TO_ITEM[stepId];
            if (!itemId) {
                continue;
            }
            logsByItem.get(itemId)?.push(logEntry);
            seenItemIds.add(itemId);
        }
    }

    const currentStepId = normalizeStepId(snapshot?.currentStepId);
    const currentItemId = currentStepId ? STEP_TO_ITEM[currentStepId] : null;
    const currentIndex = currentItemId ? ITEM_ORDER.indexOf(currentItemId) : -1;

    const executionById: Record<ThisComputerChecklistItemId, PlanChecklistExecutionState> = {} as Record<ThisComputerChecklistItemId, PlanChecklistExecutionState>;

    for (const [index, itemId] of ITEM_ORDER.entries()) {
        const logs = logsByItem.get(itemId) ?? [];
        let status: PlanChecklistExecutionState['status'] = 'idle';
        if (snapshot?.status === 'succeeded') {
            status = 'done';
        } else if (snapshot?.status === 'failed') {
            status = itemId === currentItemId ? 'error' : seenItemIds.has(itemId) ? 'done' : 'idle';
        } else if (snapshot?.status === 'canceled') {
            status = itemId === currentItemId ? 'error' : seenItemIds.has(itemId) ? 'done' : 'idle';
        } else if (itemId === 'setup.thisComputer.installTailscale') {
            status = resolveRecommendedTailscaleStatus(snapshot);
        } else if (itemId === currentItemId) {
            status = snapshot?.awaitingInput ? 'running' : 'running';
        } else if (currentIndex >= 0 && index < currentIndex) {
            status = 'done';
        } else if (currentIndex >= 0 && index > currentIndex) {
            status = 'queued';
        } else if (seenItemIds.has(itemId)) {
            status = 'done';
        }

        executionById[itemId] = {
            status,
            logs,
            error: snapshot?.result && !snapshot.result.ok && itemId === currentItemId
                ? {
                    title: snapshot.result.error.code,
                    message: snapshot.result.error.message,
                    raw: snapshot.result.error,
                }
                : undefined,
        };
    }

    return executionById;
}
