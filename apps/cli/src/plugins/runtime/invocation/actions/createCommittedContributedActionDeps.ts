import { ActionDefinitionV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ActionDefinitionV1, WorkflowAcceptedAuthorizationV1 } from '@happier-dev/protocol';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { formatQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { inputTypeResourceReference } from '@happier-dev/protocol/inputs/runtime';
import { PluginActionExecutionV2Schema } from '@happier-dev/protocol/plugins/actions/v2';

import type { ResolvedActionContribution, ResolvedActionDefinition } from '@/plugins/projection/registry/types';
import type { TargetActionCurrentIntentRequest, TargetActionCurrentIntentResult } from '../actionExecutor';
import {
  acquireAuthoritativePluginRuntimeRegistryLease,
  tryAcquireAuthoritativePluginRuntimeRegistryLease,
} from '@/plugins/runtime/reload/runtimeLease';
import type { PluginActionSurface } from '@/plugins/runtime/types';
import type { PluginExternalActionContext } from '../services/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '../../resolveExecutablePluginRuntimeRegistry';

function projectDefinition(definition: ResolvedActionDefinition, identity: NonNullable<ResolvedActionContribution['identity']>): ActionDefinitionV1 {
  const execution = PluginActionExecutionV2Schema.safeParse(definition.execution);
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
    // The legacy discovery catalog describes canonical JSON values and requires
    // a schema. Keep its unconstrained descriptor here, not in the author ABI.
    inputSchema: definition.inputSchema ?? {},
    ...(definition.contextualDefaults === undefined ? {} : { contextualDefaults: definition.contextualDefaults }),
    ...(definition.sessionTarget === undefined ? {} : { sessionTarget: definition.sessionTarget }),
    ...(definition.approval === undefined ? {} : { approval: definition.approval }),
    ...(definition.toolExposure === undefined ? {} : { toolExposure: definition.toolExposure }),
    ...(definition.outputSchema === undefined ? {} : { outputSchema: definition.outputSchema }),
    ...(definition.execution === undefined ? {} : { execution: definition.execution }),
    ...(execution.success ? { executionPlacement: execution.data.target === 'daemon' ? 'machine' as const : execution.data.target } : {}),
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
    (context.authority !== 'account_automation' && context.authority !== 'present_user')
    || !authorization
    || ('grant' in authorization.binding && !credential)
    || !target
    || (!signer && !allowMissingApprovalSigner)
    || typeof serverId !== 'string'
    || typeof serverIdentityId !== 'string'
    || typeof actionRequestId !== 'string'
  ) {
    return null;
  }
  return Object.freeze({
    authority: context.authority,
    serverId,
    serverIdentityId,
    actionRequestId,
    ...(credential ? { externalActionCredential: credential } : {}),
    externalActionExecutionAuthorization: authorization,
    externalActionTarget: target,
    ...(signer ? { signExternalActionApprovalInput: signer } : {}),
  });
}

export function createCommittedContributedActionInvoker(input: Readonly<{
  acquireRuntimeRegistryLease?: typeof acquireAuthoritativePluginRuntimeRegistryLease;
  requestCurrentIntent?: (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult>;
  /** Transport-only callers may supply a default without replacing a bound host surface. */
  defaultInvocationSurface?: PluginActionSurface;
  /** Bound only by the accepted Workflow host; author input cannot supply this proof. */
  isWorkflowRunAuthorizationCurrent?: (params: Readonly<{
    authorization: WorkflowAcceptedAuthorizationV1;
    signal?: AbortSignal;
  }>) => boolean | Promise<boolean>;
}> = {}): NonNullable<ActionExecutorDeps['invokeContributedAction']> {
  const acquire = input.acquireRuntimeRegistryLease ?? acquireAuthoritativePluginRuntimeRegistryLease;
  return async ({ action, input: actionInput, clientId, messageActionReference, context, approvalExecutionOrigin, requiredDangerLevel, signal }) => {
    const invocationSignal = signal ?? context.signal ?? new AbortController().signal;
    invocationSignal.throwIfAborted();
    const surface = readSurface(context.surface) ?? input.defaultInvocationSurface;
    if (!surface) return { ok: false, errorCode: 'contributed_action_unavailable', error: 'contributed_action_unavailable' };
    const workflowCaller = context.actionCaller?.kind === 'workflowRun' && input.isWorkflowRunAuthorizationCurrent
      ? context.actionCaller : null;
    const isWorkflowCurrent = async () => {
      if (!workflowCaller) return true;
      return await input.isWorkflowRunAuthorizationCurrent!({
        authorization: workflowCaller.authorization, signal: invocationSignal,
      });
    };
    if (!await isWorkflowCurrent()) return {
      ok: false, errorCode: 'workflow_authorization_not_current', error: 'workflow_authorization_not_current',
    };
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
      const { executeContributedAction } = await import('./executeContributedAction');
      invocationSignal.throwIfAborted();
      const attempt = await executeContributedAction({
        runtimeRegistry: lease.registry,
        actionId: buildQualifiedPluginContributionKey(action),
        input: actionInput,
        ...(clientId === undefined ? {} : { clientId }),
        ...(messageActionReference ? { messageActionReference } : {}),
        ...(requiredDangerLevel ? { requiredDangerLevel } : {}),
        approvalContext: context,
        ...(approvalExecutionOrigin ? { approvalExecutionOrigin } : {}),
        ...(input.requestCurrentIntent ? { requestCurrentIntent: input.requestCurrentIntent } : {}),
        context: {
          surface,
          invocationSurface: surface,
          initiatingActionCaller: context.actionCaller ?? { kind: 'host' },
          ...(workflowCaller ? { beforeHandlerInvocation: async () => {
            if (!await isWorkflowCurrent()) throw new PluginError({
              code: 'workflow_authorization_not_current', message: 'workflow_authorization_not_current',
            });
          } } : {}),
          ...(externalActionContext ? { externalActionContext } : {}),
          ...(typeof context.defaultSessionId === 'string' ? { defaultSessionId: context.defaultSessionId } : {}),
          signal: invocationSignal,
        },
      });
      if (!attempt.matched) return { ok: false, errorCode: 'contributed_action_unavailable', error: 'contributed_action_unavailable' };
      if (attempt.result.ok) {
        const { executionOrigin: _executionOrigin, deferredApprovalArtifactId: _deferredApprovalArtifactId, ...result } = attempt.result;
        return result;
      }
      if (attempt.result.errorCode === 'client_ambiguous' && attempt.result.actionHandlerInvocation === 'notStarted') {
        return { ok: false, errorCode: attempt.result.errorCode, error: attempt.result.error,
          details: attempt.result.data };
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
      return listRuntimeContributedActionDefinitions(lease.registry);
    } finally {
      void lease.release().catch(() => input.onLeaseReleaseError?.());
    }
  };
}

/** The committed lease and in-runtime SDK dispatcher share the same declaration projection. */
export function listRuntimeContributedActionDefinitions(
  registry: Pick<ResolvedExecutablePluginRuntimeRegistry, 'contributes' | 'targetActionInvocations'> | null | undefined,
): readonly ActionDefinitionV1[] {
  const targetActionInvocations = registry?.targetActionInvocations;
  if (!registry || !targetActionInvocations) return [];
  return Object.freeze(registry.contributes.actions.flatMap(action => {
    const identity = action.identity;
    if (!identity || identity.localId !== action.definition.id
      || targetActionInvocations.evaluateCatalogPolicy(identity.pluginId, identity.localId).outcome !== 'visible') return [];
    return [projectDefinition(action.definition, identity)];
  }));
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
