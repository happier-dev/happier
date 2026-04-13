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

function normalizeStringField(value: unknown): string | null {
    const normalized = typeof value === 'string' ? value.trim() : '';
    return normalized.length > 0 ? normalized : null;
}

function normalizeStringArray(value: unknown): readonly string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((entry) => normalizeStringField(entry))
        .filter((entry): entry is string => entry != null);
}

function formatCommandLine(command: string, args: readonly string[]): string {
    return `$ ${[command, ...args].join(' ')}`.trim();
}

function formatEventDetails(data: unknown): string | undefined {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return undefined;
    }

    const record = data as Record<string, unknown>;
    const lines: string[] = [];
    const command = normalizeStringField(record.command);
    const args = normalizeStringArray(record.args);
    const details = normalizeStringField(record.details);
    const note = normalizeStringField(record.note);
    const stdout = normalizeStringField(record.stdout);
    const stderr = normalizeStringField(record.stderr);
    const status = typeof record.status === 'number' && Number.isFinite(record.status)
        ? record.status
        : null;

    if (command) {
        lines.push(formatCommandLine(command, args));
    }
    if (details) {
        lines.push(details);
    }
    if (note) {
        lines.push(note);
    }
    if (status != null) {
        lines.push(`exit status: ${status}`);
    }
    if (stdout) {
        lines.push(`stdout:\n${stdout}`);
    }
    if (stderr) {
        lines.push(`stderr:\n${stderr}`);
    }

    return lines.length > 0 ? lines.join('\n') : undefined;
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
        details: formatEventDetails((event as { data?: unknown }).data),
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
