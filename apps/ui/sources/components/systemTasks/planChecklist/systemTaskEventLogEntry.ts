import type { SystemTaskRunState } from '../types';
import type { PlanChecklistLogEntry } from './types';

function normalizeStepId(stepId: unknown): string | null {
    if (typeof stepId !== 'string') {
        return null;
    }
    const normalized = stepId.trim();
    return normalized.length > 0 ? normalized : null;
}

function normalizeLogLevel(type: unknown): PlanChecklistLogEntry['level'] {
    const normalized = typeof type === 'string' ? type.trim().toLowerCase() : '';
    if (normalized === 'error' || normalized === 'failed' || normalized === 'failure') {
        return 'error';
    }
    if (normalized === 'prompt' || normalized === 'warning' || normalized === 'warn') {
        return 'warn';
    }
    return 'info';
}

function normalizeTimestamp(event: { tsMs?: unknown }, index: number): number {
    return typeof event.tsMs === 'number' ? event.tsMs : index;
}

export function createPlanChecklistLogEntryFromSystemTaskEvent(
    event: SystemTaskRunState['events'][number],
    resolveStepLabel: (stepId: string) => string | null,
    index: number,
): PlanChecklistLogEntry | null {
    const stepId = normalizeStepId((event as { stepId?: unknown }).stepId);
    if (!stepId) {
        return null;
    }

    const message = typeof event.message === 'string' && event.message.trim().length > 0
        ? event.message.trim()
        : (resolveStepLabel(stepId) ?? stepId).trim();
    if (message.length === 0) {
        return null;
    }

    return {
        ts: normalizeTimestamp(event as { tsMs?: unknown }, index),
        level: normalizeLogLevel((event as { type?: unknown }).type),
        message,
    };
}

export function resolveSystemTaskEventStepId(event: { stepId?: unknown }): string | null {
    return normalizeStepId(event.stepId);
}

export function resolveSystemTaskEventLogLevel(event: { type?: unknown }): PlanChecklistLogEntry['level'] {
    return normalizeLogLevel(event.type);
}

export function resolveSystemTaskEventTimestamp(event: { tsMs?: unknown }, index: number): number {
    return normalizeTimestamp(event, index);
}
