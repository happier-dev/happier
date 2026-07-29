import {
    SESSION_RUNNER_RUNTIME_METADATA_KEY,
    SessionRunnerRuntimeStateV1Schema,
    type SessionRunnerRuntimeStateV1,
} from '@happier-dev/protocol';

function readRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readNonEmptyString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
}

function readRunnerEntrypointIdentity(state: SessionRunnerRuntimeStateV1): string | null {
    if (state.runner.entrypointSource === 'unknown') return null;
    return readNonEmptyString(state.runner.runtimeId);
}

function readCurrentEntrypointIdentity(state: SessionRunnerRuntimeStateV1): string | null {
    if (state.daemon.currentEntrypointSource === 'unknown') return null;
    return readNonEmptyString(state.daemon.currentEntrypointVersion);
}

export function readSessionRunnerRuntimeStateFromMetadata(metadata: unknown): SessionRunnerRuntimeStateV1 | null {
    const record = readRecord(metadata);
    if (!record) return null;

    const parsed = SessionRunnerRuntimeStateV1Schema.safeParse(record[SESSION_RUNNER_RUNTIME_METADATA_KEY]);
    return parsed.success ? parsed.data : null;
}

export function readActionableStaleSessionRunnerRuntimeState(input: Readonly<{
    metadata: unknown;
    sessionId?: string | null;
    machineId?: string | null;
}>): SessionRunnerRuntimeStateV1 | null {
    const state = readSessionRunnerRuntimeStateFromMetadata(input.metadata);
    if (!state) return null;
    if (typeof input.sessionId === 'string' && input.sessionId.trim().length > 0 && state.sessionId !== input.sessionId) {
        return null;
    }
    const targetMachineId = readNonEmptyString(input.machineId);
    const stateMachineId = readNonEmptyString(state.machineId);
    if (targetMachineId && stateMachineId !== targetMachineId) return null;
    if (state.versionState !== 'stale') return null;
    if (state.plannedRestart.supported !== true || state.plannedRestart.eligible !== true) return null;
    if (state.plannedRestart.disabledReason) return null;
    if (!stateMachineId) return null;
    if (state.runner.pid == null) return null;
    if (!readNonEmptyString(state.runner.processCommandHash)) return null;
    if (!readRunnerEntrypointIdentity(state)) return null;
    if (!readCurrentEntrypointIdentity(state)) return null;
    return state;
}
