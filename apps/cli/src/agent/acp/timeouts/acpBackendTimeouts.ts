import type { TransportHandler } from '../../transport';
import { readPositiveIntEnv } from '@/utils/readPositiveIntEnv';

export function makeAbortError(message: string): Error {
    const err = new Error(message);
    err.name = 'AbortError';
    return err;
}

const DEFAULT_POST_PROMPT_NO_UPDATES_TIMEOUT_MS: number | null = null;
const DEFAULT_PROMPT_LIVENESS_TIMEOUT_MS: number | null = null;
const DEFAULT_POST_TOOL_CALL_IDLE_TIMEOUT_MS = 1_000;
const DEFAULT_IDLE_WITHOUT_ASSISTANT_MESSAGE_TIMEOUT_MS = 0;
const DEFAULT_TURN_HARD_CAP_TIMEOUT_MS: number | null = null;
const DEFAULT_TURN_INACTIVITY_TIMEOUT_MS: number | null = null;

export function resolvePostPromptNoUpdatesTimeoutMs(transport: TransportHandler): number | null {
    const transportValue = transport.getPostPromptNoUpdatesTimeoutMs?.();
    if (transportValue === null) {
        return null;
    }
    if (typeof transportValue === 'number' && Number.isFinite(transportValue) && transportValue > 0) {
        return Math.trunc(transportValue);
    }

    const envValue =
        readPositiveIntEnv('HAPPIER_ACP_POST_PROMPT_NO_UPDATES_TIMEOUT_MS') ??
        readPositiveIntEnv('HAPPY_ACP_POST_PROMPT_NO_UPDATES_TIMEOUT_MS');
    if (envValue != null) return envValue;
    return DEFAULT_POST_PROMPT_NO_UPDATES_TIMEOUT_MS;
}

export function resolvePromptLivenessTimeoutMs(transport: TransportHandler): number | null {
    const transportValue = transport.getPromptLivenessTimeoutMs?.();
    if (transportValue === null) {
        return null;
    }
    if (typeof transportValue === 'number' && Number.isFinite(transportValue) && transportValue > 0) {
        return Math.trunc(transportValue);
    }

    const envValue =
        readPositiveIntEnv('HAPPIER_ACP_PROMPT_LIVENESS_TIMEOUT_MS') ??
        readPositiveIntEnv('HAPPY_ACP_PROMPT_LIVENESS_TIMEOUT_MS');
    if (envValue != null) return envValue;
    return DEFAULT_PROMPT_LIVENESS_TIMEOUT_MS;
}

export function resolvePostToolCallIdleTimeoutMs(transport: TransportHandler): number {
    const transportValue = transport.getPostToolCallIdleTimeoutMs?.();
    if (typeof transportValue === 'number' && Number.isFinite(transportValue) && transportValue > 0) {
        return Math.trunc(transportValue);
    }

    const envValue =
        readPositiveIntEnv('HAPPIER_ACP_POST_TOOL_IDLE_TIMEOUT_MS') ??
        readPositiveIntEnv('HAPPY_ACP_POST_TOOL_IDLE_TIMEOUT_MS');
    if (envValue != null) return envValue;
    return DEFAULT_POST_TOOL_CALL_IDLE_TIMEOUT_MS;
}

export function resolveIdleWithoutAssistantMessageTimeoutMs(transport: TransportHandler): number {
    const transportValue = transport.getIdleWithoutAssistantMessageTimeoutMs?.();
    if (typeof transportValue === 'number' && Number.isFinite(transportValue) && transportValue > 0) {
        return Math.trunc(transportValue);
    }

    const envValue =
        readPositiveIntEnv('HAPPIER_ACP_IDLE_WITHOUT_ASSISTANT_MESSAGE_TIMEOUT_MS') ??
        readPositiveIntEnv('HAPPY_ACP_IDLE_WITHOUT_ASSISTANT_MESSAGE_TIMEOUT_MS');
    if (envValue != null) return envValue;
    return DEFAULT_IDLE_WITHOUT_ASSISTANT_MESSAGE_TIMEOUT_MS;
}

export function resolveTurnHardCapTimeoutMs(): number | null {
    return (
        readPositiveIntEnv('HAPPIER_ACP_TURN_HARD_CAP_TIMEOUT_MS') ??
        readPositiveIntEnv('HAPPY_ACP_TURN_HARD_CAP_TIMEOUT_MS') ??
        DEFAULT_TURN_HARD_CAP_TIMEOUT_MS
    );
}

export function resolveTurnInactivityTimeoutMs(): number | null {
    return (
        readPositiveIntEnv('HAPPIER_ACP_TURN_INACTIVITY_TIMEOUT_MS') ??
        readPositiveIntEnv('HAPPY_ACP_TURN_INACTIVITY_TIMEOUT_MS') ??
        DEFAULT_TURN_INACTIVITY_TIMEOUT_MS
    );
}
