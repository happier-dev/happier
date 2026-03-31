import { resolveSystemTaskStepLabel } from '@/components/systemTasks/resolveSystemTaskStepLabel';
import type { SystemTaskRunState } from '@/components/systemTasks/types';
import type { PlanChecklistExecutionState, PlanChecklistLogEntry } from '@/components/systemTasks/planChecklist';

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

function normalizeStepId(stepId: unknown): string {
    return typeof stepId === 'string' ? stepId.trim() : '';
}

function normalizeLogLevel(type: unknown): PlanChecklistLogEntry['level'] {
    const normalized = typeof type === 'string' ? type.trim().toLowerCase() : '';
    if (normalized === 'error' || normalized === 'failed' || normalized === 'failure') {
        return 'error';
    }
    if (normalized === 'warning' || normalized === 'warn') {
        return 'warn';
    }
    return 'info';
}

function buildLogEntry(event: SystemTaskRunState['events'][number]): PlanChecklistLogEntry | null {
    const stepId = normalizeStepId((event as { stepId?: unknown }).stepId);
    if (!stepId) {
        return null;
    }

    const message = typeof event.message === 'string' && event.message.trim().length > 0
        ? event.message.trim()
        : resolveSystemTaskStepLabel(stepId)
            ?? stepId;
    return {
        ts: typeof (event as { tsMs?: unknown }).tsMs === 'number' ? (event as { tsMs: number }).tsMs : 0,
        level: normalizeLogLevel((event as { type?: unknown }).type),
        message,
    };
}

export function mapThisComputerTaskToChecklistExecution(snapshot: SystemTaskRunState | null): ThisComputerChecklistExecution {
    const logsByItem = new Map<ThisComputerChecklistItemId, PlanChecklistLogEntry[]>();
    for (const itemId of ITEM_ORDER) {
        logsByItem.set(itemId, []);
    }

    const seenItemIds = new Set<ThisComputerChecklistItemId>();
    if (snapshot) {
        for (const event of snapshot.events) {
            const logEntry = buildLogEntry(event);
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

    return ITEM_ORDER.reduce((acc, itemId, index) => {
        const logs = logsByItem.get(itemId) ?? [];
        let status: PlanChecklistExecutionState['status'] = 'idle';
        if (snapshot?.status === 'succeeded') {
            status = 'done';
        } else if (snapshot?.status === 'failed') {
            status = itemId === currentItemId ? 'error' : seenItemIds.has(itemId) ? 'done' : 'idle';
        } else if (snapshot?.status === 'canceled') {
            status = itemId === currentItemId ? 'error' : seenItemIds.has(itemId) ? 'done' : 'idle';
        } else if (itemId === currentItemId) {
            status = snapshot?.awaitingInput ? 'running' : 'running';
        } else if (currentIndex >= 0 && index < currentIndex) {
            status = 'done';
        } else if (currentIndex >= 0 && index > currentIndex) {
            status = 'queued';
        } else if (seenItemIds.has(itemId)) {
            status = 'done';
        }

        acc[itemId] = {
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
        return acc;
    }, {} as ThisComputerChecklistExecution);
}
