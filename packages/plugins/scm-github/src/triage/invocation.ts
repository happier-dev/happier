import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createBoundedInvocation } from '@happier-dev/triage-sources/runtime';

/**
 * Applies the shared disposable deadline lifecycle to one GitHub handler.
 * Duration and classification remain GitHub-owned; timer/signal cleanup does not.
 */
export function withGithubInvocationDeadline<TInput, TResult>(
  timeoutMs: number,
  run: (input: TInput, context: PluginInvocationContext) => Promise<TResult>,
): (input: TInput, context: PluginInvocationContext) => Promise<TResult> {
  return async (input, context) => {
    const bounded = createBoundedInvocation({ callerSignal: context.signal, timeoutMs });
    try {
      return await run(input, { ...context, signal: bounded.signal });
    } finally {
      bounded.dispose();
    }
  };
}
