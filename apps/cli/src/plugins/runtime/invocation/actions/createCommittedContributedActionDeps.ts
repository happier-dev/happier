import { buildQualifiedPluginContributionKey, type ActionDefinitionV1 } from '@happier-dev/protocol';
import { formatQualifiedPluginActionId, type ActionExecutorDeps } from '@happier-dev/protocol/actions';

import type { ResolvedActionContribution, ResolvedActionDefinition } from '@/plugins/projection/registry/types';
import { executeContributedAction } from './executeContributedAction';
import type { TargetActionCurrentIntentRequest, TargetActionCurrentIntentResult } from '../actionExecutor';
import {
  acquireAuthoritativePluginRuntimeRegistryLease,
  tryAcquireAuthoritativePluginRuntimeRegistryLease,
} from '@/plugins/runtime/reload/runtimeLease';
import type { PluginActionSurface } from '@/plugins/runtime/types';

function projectDefinition(definition: ResolvedActionDefinition, identity: NonNullable<ResolvedActionContribution['identity']>): ActionDefinitionV1 {
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
    ...(definition.sideEffectClass === undefined ? {} : { sideEffectClass: definition.sideEffectClass }),
    ...(definition.operation === undefined ? {} : { operation: definition.operation }),
  });
}

function readSurface(surface: string | null | undefined): PluginActionSurface | null {
  switch (surface) {
    case 'api': case 'cli': case 'mcp': case 'agent': case 'ui': case 'voice': case 'plugin': return surface;
    default: return null;
  }
}

export function createCommittedContributedActionInvoker(input: Readonly<{
  acquireRuntimeRegistryLease?: typeof acquireAuthoritativePluginRuntimeRegistryLease;
  requestCurrentIntent?: (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult>;
  fixedInvocationSurface?: PluginActionSurface;
  captureApprovalReplayPlacement?: true;
}> = {}): NonNullable<ActionExecutorDeps['invokeContributedAction']> {
  const acquire = input.acquireRuntimeRegistryLease ?? acquireAuthoritativePluginRuntimeRegistryLease;
  return async ({ action, input: actionInput, context, signal }) => {
    const invocationSignal = signal ?? context.signal ?? new AbortController().signal;
    invocationSignal.throwIfAborted();
    const surface = input.fixedInvocationSurface ?? readSurface(context.surface);
    if (!surface) return { ok: false, errorCode: 'contributed_action_unavailable', error: 'contributed_action_unavailable' };
    const lease = await acquire();
    try {
      invocationSignal.throwIfAborted();
      const attempt = await executeContributedAction({
        runtimeRegistry: lease.registry,
        actionId: buildQualifiedPluginContributionKey(action),
        input: actionInput,
        ...(input.captureApprovalReplayPlacement ? { captureApprovalReplayPlacement: true } : {}),
        ...(input.requestCurrentIntent ? { requestCurrentIntent: input.requestCurrentIntent } : {}),
        context: {
          surface,
          invocationSurface: surface,
          ...(typeof context.defaultSessionId === 'string' ? { defaultSessionId: context.defaultSessionId } : {}),
          signal: invocationSignal,
        },
      });
      if (!attempt.matched) return { ok: false, errorCode: 'contributed_action_unavailable', error: 'contributed_action_unavailable' };
      if (attempt.result.ok && attempt.result.deferredApprovalArtifactId !== undefined) {
        return { ok: true, result: { kind: 'approval_request_created', artifactId: attempt.result.deferredApprovalArtifactId, actionId: 'action.invoke' } };
      }
      if (attempt.result.ok) {
        const { executionOrigin: _executionOrigin, ...result } = attempt.result;
        return result;
      }
      return attempt.result;
    } finally {
      await lease.release();
    }
  };
}

export function createCommittedContributedActionDefinitionLister(input: Readonly<{
  tryAcquireRuntimeRegistryLease?: typeof tryAcquireAuthoritativePluginRuntimeRegistryLease;
  onLeaseReleaseError?: () => void;
}> = {}): NonNullable<ActionExecutorDeps['listContributedActionDefinitions']> {
  const tryAcquire = input.tryAcquireRuntimeRegistryLease ?? tryAcquireAuthoritativePluginRuntimeRegistryLease;
  return () => {
    const lease = tryAcquire();
    if (!lease) return [];
    try {
      return Object.freeze(lease.registry.contributes.actions.flatMap((action) => {
        const identity = action.identity;
        if (!identity || identity.localId !== action.definition.id) return [];
        return [projectDefinition(action.definition, identity)];
      }));
    } finally {
      void lease.release().catch(() => input.onLeaseReleaseError?.());
    }
  };
}
