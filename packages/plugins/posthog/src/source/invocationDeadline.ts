/**
 * The source-local composition of Triage's one bounded-invocation primitive.
 *
 * A PostHog mounted read can perform more than one provider operation (the
 * CRUD-first entry read then its optional query enrichment), so the source must create
 * this once at the Action boundary rather than handing a fresh timeout to each request.
 */

import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createBoundedInvocation } from '@happier-dev/triage-sources/runtime';

export async function runPosthogBoundedInvocation<T>(
    context: PluginInvocationContext,
    timeoutMs: number,
    run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    const invocation = createBoundedInvocation({
        callerSignal: context.signal,
        timeoutMs,
    });
    try {
        return await run(invocation.signal);
    } finally {
        invocation.dispose();
    }
}
