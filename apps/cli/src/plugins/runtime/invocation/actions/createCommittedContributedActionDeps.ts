import { createExternalActionRequesterServerRequestHeaders } from '@/api/externalActionExecutionAuthorization';
import { fingerprintPluginAccountActionConfirmation } from '@happier-dev/protocol/plugins/actions/invocation';
import { ACTION_INVOKE_ACTION_ID_V1 } from '@happier-dev/protocol/actions/actionIds';
import { admitAccountActionInvokeConfirmationV1 } from '@happier-dev/protocol/actions/executor/approvalReview';
import { ActionDefinitionV1Schema } from '@happier-dev/protocol/actions/actionDefinitionV1';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { ActionDefinitionV1 } from '@happier-dev/protocol';
import { formatQualifiedPluginActionId, parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import type { ActionExecutorDeps } from '@happier-dev/protocol/actions';
import { createHostReviewedChildPortV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { readHostReviewedChildRootV1 } from '@happier-dev/protocol/actions/executor/deploymentRoleChild';
import { inputTypeResourceReference } from '@happier-dev/protocol/inputs/runtime';
import { PluginActionExecutionV2Schema } from '@happier-dev/protocol/plugins/actions/v2';
import { isPluginError, PluginError } from '@happier-dev/plugin-sdk/errors';
import { ManagedServiceNativeLogResultV1Schema } from '@happier-dev/protocol';

import type { ResolvedActionContribution, ResolvedActionDefinition } from '@/plugins/projection/registry/types';
import { readResolvedActionContribution } from '@/plugins/projection/registry/actions';
import type { TargetActionCurrentIntentRequest, TargetActionCurrentIntentResult } from '../actionExecutor';
import {
  acquireAuthoritativePluginRuntimeRegistryLease,
  tryAcquireAuthoritativePluginRuntimeRegistryLease,
} from '@/plugins/runtime/reload/runtimeLease';
import type { PluginActionSurface } from '@/plugins/runtime/types';
import type { PluginExternalActionContext } from '../services/types';
import type { ResolvedExecutablePluginRuntimeRegistry } from '../../resolveExecutablePluginRuntimeRegistry';
import type { HostActionOperationRuntime } from '@/daemon/actionOperations/createHostActionOperationRuntime';
import { captureConnectedAccountInvocationPurposeBinding } from '@happier-dev/cli-common/connectedAccounts';
import { logExternalActionCurrentIntentMismatch } from '@/daemon/externalActions/externalActionPhase';
import { readMachineProvisionerActionRolesV1 } from '@happier-dev/protocol/plugins/contributions/machineProvisioners';
import type { ManagedProviderOperationAuthority, ManagedProviderOperationAuthorityActivation } from '@/daemon/connectedServices/purposeBindings/managedProviderOperationAuthority';
import type { AdmittedManagedProviderOperationExecutionRequest } from './managedProviderCustody';
import { projectContributedActionFailure } from './contributedActionFailure';

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
    // RPC is the host transport for native Actions (including Files reads),
    // not a plugin invocation surface. Preserve its API origin at this boundary.
    case 'rpc': return 'api';
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
  /** Private host fact; standalone invocation custody never implies daemon custody. */
  daemonHoldsApprovalWaiter?: true;
  /** Constraints already admitted by a containing SDK call, across execution realms. */
  inheritedInvocation?: Pick<Parameters<typeof import('./executeContributedAction').executeContributedAction>[0],
    'requiredDangerLevel' | 'requiredReadOnly' | 'resourceSessionId' | 'readObservation' | 'inheritedTargetedOperation'> & Readonly<{
      /** Existing originating request identity, diagnostic only. */
      operationRequestId?: string;
    }>;
  managedProviderOperationAuthority?: ManagedProviderOperationAuthority;
  observePluginExecution?: HostActionOperationRuntime['observePluginExecution'];
  acquireRuntimeRegistryLease?: typeof acquireAuthoritativePluginRuntimeRegistryLease;
  requestCurrentIntent?: (request: TargetActionCurrentIntentRequest) => Promise<TargetActionCurrentIntentResult>;
  /** Transport-only callers may supply a default without replacing a bound host surface. */
  defaultInvocationSurface?: PluginActionSurface;
}> = {}): NonNullable<ActionExecutorDeps['invokeContributedAction']> {
  const acquire = input.acquireRuntimeRegistryLease ?? acquireAuthoritativePluginRuntimeRegistryLease;
  return async ({ action, input: actionInput, clientId, messageActionReference, context, approvalExecutionOrigin, requiredDangerLevel, resolveEnvironmentApprovalScope, signal }) => {
    const approvalContext = { ...context };
    const expectedContributorOccurrenceId = context.expectedContributedActionOccurrenceId;
    const hasCarriedConsent = context.presentUserConfirmation?.actionId === ACTION_INVOKE_ACTION_ID_V1;
    const requestedSignal = signal ?? context.signal ?? new AbortController().signal;
    const observation = context.machineServiceLogsResource?.observation;
    const invocationSignal = observation ? AbortSignal.any([requestedSignal, observation.signal]) : requestedSignal;
    invocationSignal.throwIfAborted();
    const surface = readSurface(context.surface) ?? input.defaultInvocationSurface;
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
    if (hasCarriedConsent) {
      const wrapper = { action,
        ...(actionInput === undefined ? {} : { input: actionInput }),
        ...(clientId === undefined ? {} : { clientId }),
        ...(expectedContributorOccurrenceId === undefined ? {} : { expectedContributorOccurrenceId }),
        ...(messageActionReference ? { messageActionReference } : {}) };
      const admission = admitAccountActionInvokeConfirmationV1(wrapper, context,
        fingerprintPluginAccountActionConfirmation({ input: wrapper, pluginId: action.pluginId }));
      if (!admission.admitted) {
        logExternalActionCurrentIntentMismatch(admission.mismatch.field, {
          lookupBranch: 'account_confirmation',
          hasConfirmation: context.presentUserConfirmation !== undefined,
          hasApproval: context.presentUserApproval !== undefined,
        });
        return projectContributedActionFailure({ errorCode: 'plugin_action_current_intent_mismatch',
          error: 'plugin_action_current_intent_mismatch', actionHandlerInvocation: 'notStarted',
          data: { details: { currentIntentMismatch: admission.mismatch } } });
      }
      approvalContext.hostReviewedChild = createHostReviewedChildPortV1({
        actionId: ACTION_INVOKE_ACTION_ID_V1, input: wrapper, context: approvalContext, reviewAdmitted: true,
      });
    }
    const lease = await acquire();
    let purposeActivation: ManagedProviderOperationAuthorityActivation | undefined;
    try {
      const { executeContributedAction } = await import('./executeContributedAction');
      invocationSignal.throwIfAborted();
      const machine = context.invocationServices?.managedMachine;
      const seed = context.invocationServices?.connectedAccountPurposeBinding;
      const contribution = machine && lease.registry.contributes.machineProvisioners?.find(candidate =>
        candidate.identity.pluginId === machine.launch.provider.pluginId && candidate.identity.localId === machine.launch.provider.localId);
      const role = contribution && readMachineProvisionerActionRolesV1(contribution.definition).find(candidate => candidate.action === action.localId)?.role;
      let admittedManagedProviderOperation: AdmittedManagedProviderOperationExecutionRequest | undefined;
      const binding = seed ? captureConnectedAccountInvocationPurposeBinding(seed, action) : undefined;
      if (binding) {
        const authority = input.managedProviderOperationAuthority;
        if (!authority) return { ok: false, errorCode: 'plugin_connected_account_binding_unavailable', error: 'plugin_connected_account_binding_unavailable' };
        const declaration = readResolvedActionContribution(lease.registry.contributes, action);
        const admittedBinding = { ...binding, ...(declaration?.pluginVersion ? { actionOperation: {
          pluginVersion: declaration.pluginVersion, signal: invocationSignal,
          resolveRequestHeaders: createExternalActionRequesterServerRequestHeaders(context),
        } } : {}) };
        purposeActivation = await authority.activate({ ...admittedBinding, requestAuthUses: [],
          ...(context.recordOperationCredentialUse ? { recordOperationCredentialUse: context.recordOperationCredentialUse } : {}),
        });
      }
      if (machine && role && contribution) {
        admittedManagedProviderOperation = { managedId: machine.id, homeId: machine.homeId, intentRevision: machine.intentRevision,
          accountMachine: machine, ...(binding ? { purposeBinding: binding } : {}), role,
          contribution: { ...contribution.identity, occurrenceId: lease.registry.readPluginOccurrenceId?.(action.pluginId) ?? '' },
          ...(purposeActivation?.exactPurposeBindingSubjectId ? { exactPurposeBindingSubjectId: purposeActivation.exactPurposeBindingSubjectId } : {}),
          ...(purposeActivation?.executeBrokeredAction ? { executeBrokeredAction: purposeActivation.executeBrokeredAction } : {}),
          isCurrent: () => !invocationSignal.aborted && (!binding || binding.isCurrent()) && (!purposeActivation || purposeActivation.isCurrent()),
        };
      }
      const attempt = await executeContributedAction({
        runtimeRegistry: lease.registry,
        ...input.inheritedInvocation,
        actionId: buildQualifiedPluginContributionKey(action),
        input: actionInput,
        ...(observation ? { readObservation: {
          invalidate() { observation.retire(new PluginError({ code: 'plugin_action_read_observation_unavailable' })); },
          emit: async (value: unknown) => { await observation.emit(ManagedServiceNativeLogResultV1Schema.parse(value), 'pages'); },
          retire: (error?: import('@happier-dev/protocol/plugins/errors').PluginErrorContract) => observation.retire(error),
          accept: (subscription: import('@happier-dev/plugin-sdk').Disposable) => observation.accept(subscription),
        } } : {}),
        ...(expectedContributorOccurrenceId === undefined ? {} : { expectedContributorOccurrenceId }),
        ...(clientId === undefined ? {} : { clientId }),
        ...(messageActionReference ? { messageActionReference } : {}),
        ...(requiredDangerLevel ? { requiredDangerLevel } : {}),
        ...(resolveEnvironmentApprovalScope ? { resolveEnvironmentApprovalScope } : {}),
        approvalContext,
        ...(context.contributedActionExecutionOrigin ? {
          captureExecutionOrigin: true as const,
          ...(context.contributedActionExecutionOrigin.expectedExecutionOrigin === undefined ? {} : {
            expectedExecutionOrigin: context.contributedActionExecutionOrigin.expectedExecutionOrigin }),
          ...(context.contributedActionExecutionOrigin.expectedExecutionRouting === undefined ? {} : {
            expectedExecutionRouting: context.contributedActionExecutionOrigin.expectedExecutionRouting }),
        } : {}),
        ...(context.actionsSettings ? { actionsSettings: context.actionsSettings } : {}),
        ...(admittedManagedProviderOperation ? { admittedManagedProviderOperation } : {}),
        ...(!admittedManagedProviderOperation && purposeActivation && (purposeActivation.exactPurposeBindingSubjectId || purposeActivation.executeBrokeredAction) ? { admittedConnectedAccountPurposeBinding: {
          ...(purposeActivation.exactPurposeBindingSubjectId ? { exactPurposeBindingSubjectId: purposeActivation.exactPurposeBindingSubjectId } : {}),
          ...(purposeActivation.executeBrokeredAction ? { executeBrokeredAction: purposeActivation.executeBrokeredAction } : {}),
          isCurrent: () => !invocationSignal.aborted && purposeActivation!.isCurrent(),
        } } : {}),
        ...(approvalExecutionOrigin ? { approvalExecutionOrigin } : {}),
        ...(input.daemonHoldsApprovalWaiter ? { daemonHoldsApprovalWaiter: true as const } : {}),
        ...(input.requestCurrentIntent ? { requestCurrentIntent: input.requestCurrentIntent } : {}),
        context: {
          ...(input.inheritedInvocation?.operationRequestId === undefined ? {}
            : { operationRequestId: input.inheritedInvocation.operationRequestId }),
          ...(input.observePluginExecution ? { observePluginExecution: input.observePluginExecution } : {}),
          surface,
          invocationSurface: surface,
          ...(readHostReviewedChildRootV1(approvalContext, formatQualifiedPluginActionId(action), actionInput)
            ? { admittedPluginActionSurface: 'plugin' as const } : {}),
          initiatingActionCaller: context.actionCaller ?? { kind: 'host' },
          ...(externalActionContext ? { externalActionContext } : {}),
          ...(typeof context.defaultSessionId === 'string' ? { defaultSessionId: context.defaultSessionId } : {}),
          signal: invocationSignal,
        },
      });
      if (!attempt.matched) return { ok: false, errorCode: 'contributed_action_unavailable', error: 'contributed_action_unavailable' };
      if (attempt.result.ok) {
        if (attempt.result.executionOrigin) context.contributedActionExecutionOrigin?.onExecuted(attempt.result.executionOrigin);
        const { executionOrigin: _executionOrigin, deferredApprovalArtifactId: _deferredApprovalArtifactId, ...result } = attempt.result;
        return result;
      }
      if (attempt.result.errorCode === 'client_ambiguous' && attempt.result.actionHandlerInvocation === 'notStarted') {
        return { ok: false, errorCode: attempt.result.errorCode, error: attempt.result.error,
          details: attempt.result.data };
      }
      // The target already owns classification and redaction. Match the host
      // contribution bridge's published PluginError envelope inside Action's
      // existing details field; private top-level transport data is stripped
      // by ordinary Action normalization.
      if (attempt.result.details !== undefined) return attempt.result;
      return projectContributedActionFailure(attempt.result);
    } finally {
      await purposeActivation?.cleanup();
      await lease.release();
    }
  };
}

export function createCommittedContributedActionDefinitionLister(input: Readonly<{
  tryAcquireRuntimeRegistryLease?: typeof tryAcquireAuthoritativePluginRuntimeRegistryLease;
  onLeaseReleaseError?: () => void;
}> = {}): NonNullable<ActionExecutorDeps['listContributedActionDefinitions']> {
  const tryAcquire = input.tryAcquireRuntimeRegistryLease ?? tryAcquireAuthoritativePluginRuntimeRegistryLease;
  return (selection) => {
    const lease = tryAcquire();
    if (!lease) return [];
    try {
      return listRuntimeContributedActionDefinitions(lease.registry, selection);
    } finally {
      void lease.release().catch(() => input.onLeaseReleaseError?.());
    }
  };
}

/** The committed lease and in-runtime SDK dispatcher share the same declaration projection. */
export function listRuntimeContributedActionDefinitions(
  registry: Pick<ResolvedExecutablePluginRuntimeRegistry, 'contributes' | 'targetActionInvocations'> | null | undefined,
  selection?: Parameters<NonNullable<ActionExecutorDeps['listContributedActionDefinitions']>>[0],
): readonly ActionDefinitionV1[] {
  const targetActionInvocations = registry?.targetActionInvocations;
  if (!registry || !targetActionInvocations) return [];
  const identity = selection ? parseQualifiedPluginActionId(selection.id) : null;
  const selected = identity ? readResolvedActionContribution(registry.contributes, identity) : null;
  const actions = selection ? selected ? [selected] : [] : registry.contributes.actions;
  return Object.freeze(actions.flatMap(action => {
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
    const identity = parseQualifiedPluginActionId(actionId);
    if (!identity) return null;
    const selected = listDefinitions({ id: formatQualifiedPluginActionId(identity) })
      .find(candidate => candidate.id === actionId);
    const definition = ActionDefinitionV1Schema.safeParse(selected);
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
    readInputTypeResource: async ({ type, resource, context, sessionId, query }) => {
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
        let result: Awaited<ReturnType<typeof read>>;
        try {
          result = await read({ callerPluginId: resource.pluginId, resourceId: resource.localId,
            expectedCallerOccurrenceId: occurrenceId,
            ...(query ? { query } : {}),
            ...(definition.source === 'dynamic' && definition.scope === 'session' && sessionId
              ? { context: { kind: 'session' as const, sessionId } } : {}),
            ...(context.signal ? { signal: context.signal } : {}) });
        } catch (error) {
          if (!isPluginError(error)) throw error;
          return { ok: false, errorCode: error.code, error: error.message,
            ...(error.details === undefined ? {} : { details: error.details }) };
        }
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
