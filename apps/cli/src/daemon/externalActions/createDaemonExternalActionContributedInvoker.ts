import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions';

import { configuration } from '@/configuration';
import {
  executeContributedAction,
} from '@/plugins/runtime/invocation/actions/executeContributedAction';
import {
  acquireAuthoritativePluginRuntimeRegistryLease,
} from '@/plugins/runtime/reload/runtimeLease';
import type {
  TargetActionCurrentIntentRequest,
  TargetActionCurrentIntentResult,
} from '@/plugins/runtime/invocation/actionExecutor';

/**
 * Adapts the public host Action `action.invoke` to the one committed-runtime
 * contributed-Action dispatcher. This adapter translates the public typed
 * contribution identity to the registry's canonical internal key; API caller
 * provenance remains host-owned and is deliberately not fabricated as a
 * plugin caller.
 */
export function createDaemonExternalActionContributedInvoker(input: Readonly<{
  acquireRuntimeRegistryLease?: typeof acquireAuthoritativePluginRuntimeRegistryLease;
  requestCurrentIntent?: (
    request: TargetActionCurrentIntentRequest,
  ) => Promise<TargetActionCurrentIntentResult>;
}> = {}): NonNullable<ActionExecutorDeps['invokeContributedAction']> {
  const acquireRuntimeRegistryLease = input.acquireRuntimeRegistryLease
    ?? acquireAuthoritativePluginRuntimeRegistryLease;

  return async ({ action, input: actionInput, context, signal }) => {
    const invocationSignal = signal ?? context.signal ?? new AbortController().signal;
    invocationSignal.throwIfAborted();
    const lease = await acquireRuntimeRegistryLease({
      happyHomeDir: configuration.happyHomeDir,
    });
    try {
      invocationSignal.throwIfAborted();
      const attempt = await executeContributedAction({
        runtimeRegistry: lease.registry,
        actionId: buildQualifiedPluginContributionKey(action),
        input: actionInput,
        ...(input.requestCurrentIntent
          ? { requestCurrentIntent: input.requestCurrentIntent }
          : {}),
        context: {
          surface: 'api',
          invocationSurface: 'api',
          ...(typeof context.defaultSessionId === 'string'
            ? { defaultSessionId: context.defaultSessionId }
            : {}),
          signal: invocationSignal,
        },
      });
      if (attempt.matched) return attempt.result;
      return {
        ok: false,
        errorCode: 'contributed_action_unavailable',
        error: 'contributed_action_unavailable',
      };
    } finally {
      await lease.release();
    }
  };
}
