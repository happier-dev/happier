import type { RelayAccessDeadlineV1 } from './types.js';

const MIN_RELAY_ACCESS_COMMAND_TIMEOUT_MS = 1;

export class RelayAccessDeadlineExceededError extends Error {
    readonly code = 'provider_command_timeout';

    constructor(message = 'Relay access provider command deadline expired.') {
        super(message);
        this.name = 'RelayAccessDeadlineExceededError';
    }
}

function normalizeTimeoutMs(value: unknown, defaultMs: number): number {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return defaultMs;
    if (numeric <= 0) return 0;
    return Math.trunc(numeric);
}

export function createRelayAccessDeadline(params: Readonly<{
    timeoutMs: number;
    now?: () => number;
    signal?: AbortSignal;
}>): RelayAccessDeadlineV1 {
    const now = params.now ?? Date.now;
    const startedAt = now();
    return {
        startedAt,
        deadlineAt: startedAt + Math.max(0, Math.trunc(params.timeoutMs)),
        now,
        ...(params.signal ? { signal: params.signal } : {}),
    };
}

export function resolveRelayAccessCommandTimeoutMs(params: Readonly<{
    deadline?: RelayAccessDeadlineV1;
    timeoutMs?: number;
    defaultTimeoutMs: number;
}>): number {
    const commandTimeoutMs = normalizeTimeoutMs(params.timeoutMs, params.defaultTimeoutMs);
    if (!params.deadline) {
        return commandTimeoutMs;
    }

    const remainingMs = Math.trunc(params.deadline.deadlineAt - params.deadline.now());
    if (remainingMs < MIN_RELAY_ACCESS_COMMAND_TIMEOUT_MS) {
        throw new RelayAccessDeadlineExceededError();
    }

    if (commandTimeoutMs <= 0) {
        return remainingMs;
    }
    return Math.min(commandTimeoutMs, remainingMs);
}

