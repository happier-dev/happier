import { ActionDefinitionV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ActionDefinitionV1 } from '@happier-dev/protocol';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { inputTypeResourceReference } from '@happier-dev/protocol/inputs/runtime';

import type { ResolvedActionContribution, ResolvedActionDefinition } from '@/plugins/projection/registry/types';
import { executeContributedAction } from './executeContributedAction';
import type { TargetActionCurrentIntentRequest, TargetActionCurrentIntentResult } from '../actionExecutor';
import {
  acquireAuthoritativePluginRuntimeRegistryLease,
  tryAcquireAuthoritativePluginRuntimeRegistryLease,
} from '@/plugins/runtime/reload/runtimeLease';
import type { PluginActionSurface } from '@/plugins/runtime/types';
import type { PluginExternalActionContext } from '../services/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '../../resolveExecutablePluginRuntimeRegistry';

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

function projectExternalActionContext(
  context: Parameters<NonNullable<ActionExecutorDeps['invokeContributedAction']>>[0]['context'],
  allowMissingApprovalSigner: boolean,
): PluginExternalActionContext | null {
  const authorization = context.externalActionExecutionAuthorization;
  const credential = context.externalActionCredential;
  const target = context.externalActionTarget;
  const signer = context.signExternalActionApprovalInput;
  const serverId = context.serverId;
  const serverIdentityId = context.serverIdentityId;
  const actionRequestId = context.actionRequestId;
  // Raw bearer external Actions intentionally retain their existing behavior:
  // the authenticated credential selects Account authority, but it does not
  // manufacture the stronger Home-signed plugin context used by protected
  // requests and deferred replay. Only an actual execution authorization opts
  // into that context and therefore requires the complete bound tuple below.
  if (!authorization) return null;
  if (
    context.authority !== 'account_automation'
    || !authorization
    || !credential
    || !target
    || (!signer && !allowMissingApprovalSigner)
    || typeof serverId !== 'string'
    || typeof serverIdentityId !== 'string'
    || typeof actionRequestId !== 'string'
  ) {
    return null;
  }
  return Object.freeze({
    authority: 'account_automation',
    serverId,
    serverIdentityId,
    actionRequestId,
    externalActionCredential: credential,
    externalActionExecutionAuthorization: authorization,
    externalActionTarget: target,
    ...(signer ? { signExternalActionApprovalInput: signer } : {}),
  });
}

export function createCommittedContributedActionInvoker(input: Readonly<{
  acquireRuntimeRegistryLease?: typeof acquireAuthoritativePluginRuntimeRegistryLease;
  requestCurrentIntent?: (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult>;
  fixedInvocationSurface?: PluginActionSurface;
  captureApprovalReplayPlacement?: true;
}> = {}): NonNullable<ActionExecutorDeps['invokeContributedAction']> {
  const acquire = input.acquireRuntimeRegistryLease ?? acquireAuthoritativePluginRuntimeRegistryLease;
  return async ({ action, input: actionInput, context, approvalExecutionOrigin, requiredDangerLevel, signal }) => {
    const invocationSignal = signal ?? context.signal ?? new AbortController().signal;
    invocationSignal.throwIfAborted();
    const surface = input.fixedInvocationSurface ?? readSurface(context.surface);
    if (!surface) return { ok: false, errorCode: 'contributed_action_unavailable', error: 'contributed_action_unavailable' };
    const externalActionContext = projectExternalActionContext(
      context,
      approvalExecutionOrigin !== undefined,
    );
    if (
      context.externalActionExecutionAuthorization !== undefined
      && externalActionContext === null
    ) {
      return { ok: false, errorCode: 'contributed_action_unavailable', error: 'contributed_action_unavailable' };
    }
    const lease = await acquire();
    try {
      invocationSignal.throwIfAborted();
      const attempt = await executeContributedAction({
        runtimeRegistry: lease.registry,
        actionId: buildQualifiedPluginContributionKey(action),
        input: actionInput,
        ...(requiredDangerLevel ? { requiredDangerLevel } : {}),
        ...(input.captureApprovalReplayPlacement ? { captureApprovalReplayPlacement: true } : {}),
        ...(input.requestCurrentIntent
          ? {
              requestCurrentIntent: (request: TargetActionCurrentIntentRequest) => input.requestCurrentIntent!({
                ...request,
                ...(approvalExecutionOrigin ? { executionOriginV1: approvalExecutionOrigin } : {}),
              }),
            }
          : {}),
        context: {
          surface,
          invocationSurface: surface,
          initiatingActionCaller: context.actionCaller ?? { kind: 'host' },
          ...(externalActionContext ? { externalActionContext } : {}),
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
      const targetActionInvocations = lease.registry.targetActionInvocations;
      if (!targetActionInvocations) return [];
      return Object.freeze(lease.registry.contributes.actions.flatMap((action) => {
        const identity = action.identity;
        if (!identity || identity.localId !== action.definition.id) return [];
        if (
          targetActionInvocations
            .evaluateCatalogPolicy(identity.pluginId, identity.localId)
            .outcome !== 'visible'
        ) return [];
        return [projectDefinition(action.definition, identity)];
      }));
    } finally {
      void lease.release().catch(() => input.onLeaseReleaseError?.());
    }
  };
}

/** Re-read the same current, policy-filtered catalog used by discovery. */
export function createCommittedContributedActionSchemaReader(
  listDefinitions: NonNullable<ActionExecutorDeps['listContributedActionDefinitions']>,
): NonNullable<ActionExecutorDeps['readContributedActionSchemas']> {
  return async (actionId, signal) => {
    signal?.throwIfAborted();
    const definition = ActionDefinitionV1Schema.safeParse(listDefinitions().find(action => action.id === actionId));
    if (!definition.success) return null;
    return { inputSchema: definition.data.inputSchema,
      ...(definition.data.outputSchema === undefined ? {} : { outputSchema: definition.data.outputSchema }) };
  };
}

/** Catalog/schema identity and Resource authority are shared by discovery and target dispatch. */
export function createRegistryInputTypeDeps(runtime: Pick<ResolvedExecutablePluginRuntimeRegistry,
  'contributes' | 'readUiResource'>): Required<Pick<ActionExecutorDeps, 'resolveInputType' | 'readInputTypeResource'>> {
  return {
    resolveInputType: async (identity, context) => {
      context.signal?.throwIfAborted();
        const registry = runtime.contributes;
        const occurrenceId = registry.occurrenceIdsByPluginId?.[identity.pluginId];
        const candidates = (registry.inputTypes ?? []).filter(entry =>
          entry.identity.pluginId === identity.pluginId && entry.identity.localId === identity.localId);
        return occurrenceId && candidates.length === 1
          ? { identity: candidates[0]!.identity, occurrenceId, definition: candidates[0]!.definition } : null;
    },
    readInputTypeResource: async ({ type, resource, context, sessionId }) => {
        const registry = runtime.contributes;
        if (registry.occurrenceIdsByPluginId?.[type.identity.pluginId] !== type.occurrenceId) {
          return { ok: false, errorCode: 'input_type_retired', error: 'input_type_retired' };
        }
        const types = (registry.inputTypes ?? []).filter(entry => entry.identity.pluginId === type.identity.pluginId
          && entry.identity.localId === type.identity.localId);
        const declared = types.length === 1 ? inputTypeResourceReference({ ...type, definition: types[0]!.definition }) : null;
        if (!declared || declared.pluginId !== resource.pluginId || declared.localId !== resource.localId) {
          return { ok: false, errorCode: 'input_type_options_unavailable', error: 'input_type_options_unavailable' };
        }
        const occurrenceId = registry.occurrenceIdsByPluginId?.[resource.pluginId];
        const candidates = registry.resources.filter(entry => entry.pluginId === resource.pluginId
          && entry.definition.id === resource.localId);
        const read = runtime.readUiResource;
        if (!read || !occurrenceId || candidates.length !== 1) {
          return { ok: false, errorCode: 'input_type_options_unavailable', error: 'input_type_options_unavailable' };
        }
        const definition = candidates[0]!.definition;
        // A headless form has no mounted surface; do not manufacture a surface proof.
        if (definition.source === 'dynamic' && definition.scope === 'surface') {
          return { ok: false, errorCode: 'input_type_options_unavailable', error: 'input_type_options_unavailable' };
        }
        const result = await read({ callerPluginId: resource.pluginId, resourceId: resource.localId,
          expectedCallerOccurrenceId: occurrenceId,
          ...(definition.source === 'dynamic' && definition.scope === 'session' && sessionId
            ? { context: { kind: 'session' as const, sessionId } } : {}),
          ...(context.signal ? { signal: context.signal } : {}) });
        if (result.contentType !== 'application/json') {
          return { ok: false, errorCode: 'input_type_options_invalid', error: 'input_type_options_invalid' };
        }
        try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(result.bytes)) as unknown; }
        catch { return { ok: false, errorCode: 'input_type_options_invalid', error: 'input_type_options_invalid' }; }
    },
  };
}

/** Input types resolve from the serving catalog while its incumbent lease is held. */
export function createCommittedInputTypeDeps(input: Readonly<{
  acquireRuntimeRegistryLease?: typeof acquireAuthoritativePluginRuntimeRegistryLease;
}> = {}): Required<Pick<ActionExecutorDeps, 'resolveInputType' | 'readInputTypeResource'>> {
  const acquire = input.acquireRuntimeRegistryLease ?? acquireAuthoritativePluginRuntimeRegistryLease;
  return {
    resolveInputType: async (identity, context) => {
      const lease = await acquire();
      try { return await createRegistryInputTypeDeps(lease.registry).resolveInputType(identity, context); }
      finally { await lease.release(); }
    },
    readInputTypeResource: async request => {
      const lease = await acquire();
      try { return await createRegistryInputTypeDeps(lease.registry).readInputTypeResource(request); }
      finally { await lease.release(); }
    },
  };
}
