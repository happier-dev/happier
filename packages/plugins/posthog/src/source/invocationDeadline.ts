/**
 * The source-local composition of Triage's one bounded-invocation primitive.
 *
 * A PostHog mounted read can perform more than one provider operation (the
 * CRUD-first entry read then its optional query enrichment), so an explicitly supplied caller
 * bound is composed once at the Action boundary rather than refreshed for each request. Normal
 * production reads supply no extra duration and inherit the invocation caller's signal.
 */

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createBoundedInvocation } from '@happier-dev/triage-sources/runtime';

export async function runPosthogBoundedInvocation<T>(
    context: PluginInvocationContext,
    timeoutMs: number | undefined,
    run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    const invocation = createBoundedInvocation({
        callerSignal: context.signal,
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
    });
    try {
        return await run(invocation.signal);
    } finally {
        invocation.dispose();
    }
}
