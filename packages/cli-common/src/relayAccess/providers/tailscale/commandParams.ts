import {
    createRelayAccessDeadline,
    resolveRelayAccessCommandTimeoutMs,
} from '../../deadline.js';
import type {
    RelayAccessDeadlineV1,
    RelayAccessExecutionContext,
    RelayAccessProviderStatusOptions,
} from '../../types.js';

export function resolveTailscaleRelayAccessDeadline(
    options: RelayAccessProviderStatusOptions,
): RelayAccessDeadlineV1 | undefined {
    if (options.deadline) return options.deadline;
    if (options.timeoutMs === undefined) return undefined;
    return createRelayAccessDeadline({
        timeoutMs: options.timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
    });
}

export function resolveTailscaleRelayAccessCommandParams(
    ctx: RelayAccessExecutionContext,
    options: RelayAccessProviderStatusOptions,
): Readonly<{
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
    deadline?: RelayAccessDeadlineV1;
    signal?: AbortSignal;
}> {
    const signal = options.signal ?? options.deadline?.signal;
    const timeoutMs = options.deadline
        ? resolveRelayAccessCommandTimeoutMs({
            deadline: options.deadline,
            timeoutMs: options.timeoutMs ?? 0,
            defaultTimeoutMs: options.timeoutMs ?? 0,
        })
        : options.timeoutMs;

    return {
        env: ctx.env,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        ...(options.deadline ? { deadline: options.deadline } : {}),
        ...(signal ? { signal } : {}),
    };
}
