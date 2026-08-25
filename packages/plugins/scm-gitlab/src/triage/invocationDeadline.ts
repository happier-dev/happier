import type { PluginInvocationContext } from '@happier-dev/plugin-sdk';
import { createBoundedInvocation } from '@happier-dev/triage-sources/runtime';

/** Applies GitLab's source-owned duration around one complete Action invocation. */
export function withGitlabInvocationDeadline<TInput, TResult>(
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
