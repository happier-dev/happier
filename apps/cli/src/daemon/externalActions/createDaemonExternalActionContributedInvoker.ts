import {
  buildQualifiedPluginContributionKey,
  type ActionDefinitionV1,
} from '@happier-dev/protocol';
import {
  formatQualifiedPluginActionId,
  type ActionExecutorDeps,
} from '@happier-dev/protocol/actions';

import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import {
  executeContributedAction,
} from '@/plugins/runtime/invocation/actions/executeContributedAction';
import {
  acquireAuthoritativePluginRuntimeRegistryLease,
  tryAcquireAuthoritativePluginRuntimeRegistryLease,
} from '@/plugins/runtime/reload/runtimeLease';
import type {
  TargetActionCurrentIntentRequest,
  TargetActionCurrentIntentResult,
} from '@/plugins/runtime/invocation/actionExecutor';
import type {
  ResolvedActionContribution,
  ResolvedActionDefinition,
} from '@/plugins/projection/registry/types';

/**
 * The committed daemon registry is the only contributor-definition source.
 * Project it explicitly at this public Action catalog boundary so registry
 * implementation fields and undefined runtime slots never become API data.
 */
function projectDaemonExternalActionContributedDefinition(
  definition: ResolvedActionDefinition,
  identity: NonNullable<ResolvedActionContribution['identity']>,
): ActionDefinitionV1 {
  return Object.freeze({
    kindVersion: definition.kindVersion,
    id: formatQualifiedPluginActionId(identity),
    title: definition.title,
    description: definition.description,
    safety: definition.safety,
    placements: definition.placements,
    slash: definition.slash,
    bindings: definition.bindings,
    examples: definition.examples,
    surfaces: definition.surfaces,
    inputHints: definition.inputHints,
    inputSchema: definition.inputSchema,
    ...(definition.approval === undefined ? {} : { approval: definition.approval }),
    ...(definition.toolExposure === undefined ? {} : { toolExposure: definition.toolExposure }),
    ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
    ...(definition.execution === undefined ? {} : { execution: definition.execution }),
    ...(definition.sideEffectClass === undefined
      ? {}
      : { sideEffectClass: definition.sideEffectClass }),
    ...(definition.operation === undefined ? {} : { operation: definition.operation }),
  });
}

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

/**
 * Reads the current committed runtime's contributed Action declarations for
 * the canonical `action.spec.search` and `action.spec.get` owner. The lease
 * is released after the immutable declaration snapshot is copied; execution
 * keeps its own currentness checks through the committed invoker above.
 */
export function createDaemonExternalActionContributedDefinitionLister(input: Readonly<{
  tryAcquireRuntimeRegistryLease?: typeof tryAcquireAuthoritativePluginRuntimeRegistryLease;
}> = {}): NonNullable<ActionExecutorDeps['listContributedActionDefinitions']> {
  const tryAcquireRuntimeRegistryLease = input.tryAcquireRuntimeRegistryLease
    ?? tryAcquireAuthoritativePluginRuntimeRegistryLease;

  return () => {
    const lease = tryAcquireRuntimeRegistryLease({
      happyHomeDir: configuration.happyHomeDir,
    });
    if (!lease) return [];
    try {
      return Object.freeze(lease.registry.contributes.actions.flatMap((action) => {
        const identity = action.identity;
        // Discovery must use the same settings/invocation identity as the
        // committed Action runtime. A legacy or malformed registry row without
        // that identity cannot be safely projected into the public catalog.
        if (!identity || identity.localId !== action.definition.id) return [];
        return [projectDaemonExternalActionContributedDefinition(action.definition, identity)];
      }));
    } finally {
      void lease.release().catch(() => {
        logger.debug('[ExternalAction] Contributed Action discovery registry lease release failed (non-fatal)', {
          error: 'external_action_catalog_registry_lease_release_failed',
        });
      });
    }
  };
}
