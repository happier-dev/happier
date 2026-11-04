import { DeploymentInvalidV1Schema } from '../deployments/deploymentInvalidV1.js';
import { isDeploymentActionIdV1 } from '../deployments/deploymentActionIdsV1.js';
import type { ActionExecuteFailure } from '../actions/actionExecutionResult.js';
import { AccountActionHttpFailureDetailsV1Schema, ClientActionFailureDetailsV1Schema, ClientActionRpcFailureCodeV1Schema } from '../actions/actionExecutionResult.js';
import * as z from 'zod/mini';
import { getActionSpec, resolveActionExecutionPlacementForInput } from '../actions/actionSpecs.js';
import { ActionIdSchema, isPluginDevLoopActionIdV1 } from '../actions/actionIds.js';
import { isFilesystemActionId } from '../actions/filesystemActionFamily.js';
import { PROJECT_ACTION_INPUT_SCHEMAS_V1 } from '../actions/projectActionFamily.js';
import {
  ProjectWorkerNoAcceptanceFailureDetailsV1Schema,
  readProjectWorkerNoAcceptanceFailureV1,
} from '../actions/projectWorkerRefusal.js';
import {
  SavedSecretResourceActionErrorV1Schema,
  SharedSavedSecretDeleteInputV1Schema,
} from '../account/settings/savedSecretResourceActionsV1.js';
import { HomeAccountDeleteInputV1Schema } from '../home/governance/accounts.js';
import { HomeGovernanceErrorV1Schema } from '../home/governance/errors.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { AccountSettingsMutationInvalidResultSchema } from '../account/settings/accountSettingMutationV1.js';
import { SettingsDeclarationActionInputSchemasV1 } from '../actions/settingsDeclarationActionFamily.js';
import { readAccountSettingDeclarationV1 } from '../actions/accountSettingDeclarations.js';
import {
  parseSessionBoardActionPortResultV1,
  parseStoredSessionBoardActionFailureV1,
} from '../sessions/board/actions.js';
import { SessionBoardActionIdV1Schema } from '../sessions/board/actionIds.js';
import { MachinePresetActionIdV1Schema, MachinePresetActionOutputSchemasV1 } from '../machines/managed/machinePresetActionsV1.js';
import { ManagedMachineActionIdV1Schema, ManagedMachineActionOutputSchemasV1 } from '../machines/managed/actionsV1.js';
import { MachinePoolResolveResultV1Schema } from '../machines/pools/v1.js';
import { ProjectWorkerActionOutputSchemasV1 } from '../actions/specs/projectWorkers.js';
import { ActionOperationCancelV1ResponseSchema } from '../actions/operations/v1.js';
import { ApprovalStaleFailureDetailsSchema } from './approvalStaleReason.js';
import { WidgetBindingResolutionV1Schema, WidgetInstanceActionInputSchemasV1 } from '../widgets/actionsV1.js';
import { WidgetInstanceActionIdV1Schema } from '../widgets/actionIdsV1.js';
import { isProviderActionIdV1, PROVIDER_ACTION_INPUT_SCHEMAS_V1 } from '../providers/providerActionsV1.js';
import { ProviderErrorV1Schema } from '../providers/errors.js';
import { DeploymentEnvironmentCreateIntentInputV1Schema } from '../deployments/deploymentActionsV1.js';
import { DeploymentTemplateInstantiateInputV1Schema, DeploymentTemplateInstantiationPartialV1Schema } from '../deployments/deploymentTemplateInstantiationV1.js';
import type {
  ApprovalExecutionV2,
  ApprovalRequest,
  ApprovalRequestV2,
} from './approvalRequestV1.js';
import type { ApprovalRequestPublicRead } from './approvalRequestPublicRead.js';
export { ApprovalStaleReasonSchema, ApprovalStaleFailureDetailsSchema, type ApprovalStaleReason } from './approvalStaleReason.js';

function parseStrictApprovalFailure(input: Readonly<{
  request: ApprovalRequestV2;
  failure: ActionExecuteFailure;
}>, storedRead = false): ActionExecuteFailure | null {
  if (isDeploymentActionIdV1(input.request.actionId) && input.failure.errorCode === 'deployment_invalid') {
    const details = (storedRead ? createStoredReadSchema(DeploymentInvalidV1Schema) : DeploymentInvalidV1Schema)
      .safeParse(input.failure.details);
    if (details.success && details.data.diagnostic) return { ...input.failure, details: details.data };
  }
  const clientDetails = (storedRead ? createStoredReadSchema(ClientActionFailureDetailsV1Schema)
    : ClientActionFailureDetailsV1Schema).safeParse(input.failure.details);
  if (clientDetails.success) {
    const spec = getActionSpec(input.request.actionId);
    const args = (storedRead ? createStoredReadSchema(spec.inputSchema) : spec.inputSchema).safeParse(input.request.actionArgs);
    if (!args.success || resolveActionExecutionPlacementForInput(spec, args.data) !== 'client') return null;
    const mayHaveEffect = spec.sideEffectClass !== 'read' && spec.sideEffectClass !== 'none';
    const code = input.failure.errorCode;
    const expected = mayHaveEffect ? code === 'outcome_uncertain'
      : clientDetails.data.reason === 'client_execution_exception' ? code === 'action_failed'
      : clientDetails.data.reason === 'client_account_scope_changed' ? code === 'action_account_scope_changed'
      : code === 'invalid_action_output' || ClientActionRpcFailureCodeV1Schema.safeParse(code).success;
    return expected ? { ...input.failure, details: clientDetails.data } : null;
  }
  if (isProviderActionIdV1(input.request.actionId)) {
    const details = (storedRead ? createStoredReadSchema(ProviderErrorV1Schema) : ProviderErrorV1Schema)
      .safeParse(input.failure.details);
    if (details.success) {
      const schema = PROVIDER_ACTION_INPUT_SCHEMAS_V1[input.request.actionId];
      const args = (storedRead ? createStoredReadSchema(schema) : schema).safeParse(input.request.actionArgs);
      if (!args.success || details.data.code !== input.failure.errorCode) return null;
      for (const key of ['connectionId', 'machineId', 'sourceProfileId'] as const) {
        if (details.data[key] !== undefined && (!(key in args.data) || Reflect.get(args.data, key) !== details.data[key])) return null;
      }
      return { ...input.failure, details: details.data };
    }
  }
  if (input.failure.errorCode === 'outcome_unknown') {
    const details = (storedRead ? createStoredReadSchema(AccountActionHttpFailureDetailsV1Schema)
      : AccountActionHttpFailureDetailsV1Schema).safeParse(input.failure.details);
    if (details.success) {
      const spec = getActionSpec(input.request.actionId);
      const args = (storedRead ? createStoredReadSchema(spec.inputSchema) : spec.inputSchema).safeParse(input.request.actionArgs);
      if (!args.success || resolveActionExecutionPlacementForInput(spec, args.data) !== 'account'
        || spec.sideEffectClass === 'read' || spec.sideEffectClass === 'none') return null;
      return { ...input.failure, details: details.data };
    }
  }
  if (input.failure.errorCode === 'approval_stale') {
    const details = (storedRead ? createStoredReadSchema(ApprovalStaleFailureDetailsSchema)
      : ApprovalStaleFailureDetailsSchema).safeParse(input.failure.details);
    return details.success ? { ...input.failure, details: details.data } : null;
  }
  if (input.request.actionId === 'deployments.templates.instantiate'
    || input.request.actionId === 'deployments.environments.create') {
    const details = (storedRead ? createStoredReadSchema(DeploymentTemplateInstantiationPartialV1Schema)
      : DeploymentTemplateInstantiationPartialV1Schema).safeParse(input.failure.details);
    if (details.success) {
      if (details.data.errorCode !== input.failure.errorCode) return null;
      if (input.request.actionId === 'deployments.templates.instantiate') {
        const args = (storedRead ? createStoredReadSchema(DeploymentTemplateInstantiateInputV1Schema)
          : DeploymentTemplateInstantiateInputV1Schema).safeParse(input.request.actionArgs);
        if (!args.success || args.data.mode !== 'apply'
          || args.data.environment.kind === 'existing' && details.data.environmentId !== undefined
            && details.data.environmentId !== args.data.environment.environmentId
          || args.data.target.kind === 'existing' && details.data.targetLinkId !== undefined
            && details.data.targetLinkId !== args.data.target.targetLinkId) return null;
      } else {
        const args = (storedRead ? createStoredReadSchema(DeploymentEnvironmentCreateIntentInputV1Schema)
          : DeploymentEnvironmentCreateIntentInputV1Schema).safeParse(input.request.actionArgs);
        if (!args.success || args.data.mode === 'preview' || args.data.definition?.from !== 'catalogApp') return null;
      }
      return { ...input.failure, details: details.data };
    }
  }
  if (input.failure.errorCode === 'widget_inputs_invalid') {
    const action = WidgetInstanceActionIdV1Schema.safeParse(input.request.actionId);
    if (!action.success) return null;
    const schema = WidgetInstanceActionInputSchemasV1[action.data];
    const args = (storedRead ? createStoredReadSchema(schema) : schema).safeParse(input.request.actionArgs);
    const details = (storedRead ? createStoredReadSchema(WidgetBindingResolutionV1Schema)
      : WidgetBindingResolutionV1Schema).safeParse(input.failure.details);
    // A refused admission contains field facts only. Never persist resolved
    // values, or promote an unrelated Action's opaque error bag into history.
    return args.success && details.success && details.data.status !== 'ready'
      ? { ...input.failure, details: details.data } : null;
  }
  if (input.request.actionId === 'settings.set') {
    if (input.failure.errorCode !== 'account_settings_invalid') return null;
    const schema = SettingsDeclarationActionInputSchemasV1['settings.set'];
    const args = (storedRead ? createStoredReadSchema(schema) : schema).safeParse(input.request.actionArgs);
    if (!args.success || args.data.target || !readAccountSettingDeclarationV1(args.data.anchor)) return null;
    const details = (storedRead ? createStoredReadSchema(AccountSettingsMutationInvalidResultSchema)
      : AccountSettingsMutationInvalidResultSchema).safeParse(input.failure.details);
    return details.success ? { ...input.failure, details: details.data } : null;
  }
  const projectActionId = input.request.actionId;
  if (projectActionId === 'projects.script.run' || projectActionId === 'projects.compute.exec') {
    const inputSchema = PROJECT_ACTION_INPUT_SCHEMAS_V1[projectActionId];
    const args = (storedRead ? createStoredReadSchema(inputSchema) : inputSchema)
      .safeParse(input.request.actionArgs);
    if (!args.success || args.data.workspace.serverId !== input.request.executionOriginV1.serverId) return null;
    const details = (storedRead
      ? createStoredReadSchema(ProjectWorkerNoAcceptanceFailureDetailsV1Schema)
      : ProjectWorkerNoAcceptanceFailureDetailsV1Schema).safeParse(input.failure.details);
    return details.success
      ? readProjectWorkerNoAcceptanceFailureV1({ ...input.failure, details: details.data })
      : null;
  }
  const removal = input.request.actionId === 'secrets.shared.delete'
    ? {
      input: SharedSavedSecretDeleteInputV1Schema,
      failure: SavedSecretResourceActionErrorV1Schema,
      code: 'managed_resources_review_required',
    }
    : input.request.actionId === 'home.accounts.delete'
      ? {
        input: HomeAccountDeleteInputV1Schema,
        failure: HomeGovernanceErrorV1Schema,
        code: 'account_erasure_managed_resources_review_required',
      }
      : null;
  if (removal) {
    if (input.failure.errorCode !== removal.code) return null;
    const args = (storedRead ? createStoredReadSchema(removal.input) : removal.input)
      .safeParse(input.request.actionArgs);
    let domainDetails = input.failure.details;
    if (domainDetails && typeof domainDetails === 'object' && !Array.isArray(domainDetails)
      && Object.hasOwn(domainDetails, 'httpStatus')) {
      // homeDomainActions adds transport metadata beside the strict domain
      // payload. Validate and remove only that field before domain admission.
      const { httpStatus, ...payload } = domainDetails as Record<string, unknown>;
      if (typeof httpStatus !== 'number' || !Number.isInteger(httpStatus) || httpStatus < 100 || httpStatus > 599) return null;
      domainDetails = payload;
    }
    const details = (storedRead ? createStoredReadSchema(removal.failure) : removal.failure)
      .safeParse(domainDetails);
    return args.success && details.success && details.data.error === removal.code
      ? { ...input.failure, details: details.data }
      : null;
  }
  const actionId = SessionBoardActionIdV1Schema.safeParse(input.request.actionId);
  if (!actionId.success) return null;
  const parsed = (storedRead ? parseStoredSessionBoardActionFailureV1 : parseSessionBoardActionPortResultV1)(
    actionId.data,
    input.request.actionArgs,
    input.failure,
    {
      ...(input.request.executionOriginV1.sessionId
        ? { expectedSessionId: input.request.executionOriginV1.sessionId }
        : {}),
      expectedServerId: input.request.executionOriginV1.serverId,
    },
  );
  return parsed.success && parsed.kind === 'failure' ? parsed.data : null;
}

/**
 * Project one failed execution into durable approval history. Only details
 * accepted by the exact Action family's strict, request-bound parser survive.
 * Arbitrary errors and opaque detail bags remain live-only.
 */
export function projectApprovalExecutionFailureV2(input: Readonly<{
  request: ApprovalRequestV2;
  failure: ActionExecuteFailure;
  executedAtMs: number;
  /** Defaults to true for execution-path callers; pre-execution settlement must opt out explicitly. */
  effectAttempted?: boolean;
}>): ApprovalExecutionV2 {
  const strictFailure = parseStrictApprovalFailure(input);
  return {
    executedAtMs: input.executedAtMs,
    effectAttempted: input.effectAttempted !== false,
    ok: false,
    errorCode: input.failure.errorCode,
    error: input.failure.error,
    ...(strictFailure?.details !== undefined ? { details: strictFailure.details } : {}),
  };
}

/**
 * A successfully executed Action may still refuse its domain effect.
 * Interpret only exact family outputs; arbitrary Action data can also have a kind or status.
 * This is a read projection, not a rewrite of the durable execution receipt.
 */
function readDomainExecutionFailure(request: ApprovalRequest): ActionExecuteFailure | null {
  if (isFilesystemActionId(request.actionId)) {
    const schema = getActionSpec(request.actionId).outputSchema;
    if (!schema) return null;
    const parsed = createStoredReadSchema(schema).safeParse(request.execution?.result);
    if (!parsed.success) {
      return { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' };
    }
    const result = parsed.data;
    if (!result || typeof result !== 'object' || !('success' in result) || result.success !== false) return null;
    const errorCode = 'errorCode' in result && typeof result.errorCode === 'string' && result.errorCode.trim()
      ? result.errorCode : 'filesystem_operation_failed';
    const error = 'error' in result && typeof result.error === 'string' && result.error.trim()
      ? result.error : errorCode;
    return { ok: false, errorCode, error };
  }
  const preset = MachinePresetActionIdV1Schema.safeParse(request.actionId);
  const managed = ManagedMachineActionIdV1Schema.safeParse(request.actionId);
  const pluginActionId = isPluginDevLoopActionIdV1(request.actionId) ? request.actionId : null;
  const mutationId = request.actionId === 'machines.worker.policy.set'
    || request.actionId === 'projects.worker.preferences.set'
    || request.actionId === 'projects.worker.preferences.reset'
    || request.actionId === 'projects.service.placement.set'
    ? request.actionId : null;
  const familySchema = preset.success ? MachinePresetActionOutputSchemasV1[preset.data]
    : managed.success ? ManagedMachineActionOutputSchemasV1[managed.data]
      : request.actionId === 'machines.pools.resolve' ? MachinePoolResolveResultV1Schema
        : mutationId ? ProjectWorkerActionOutputSchemasV1[mutationId]
          : request.actionId === 'action.operations.cancel' ? ActionOperationCancelV1ResponseSchema
            : pluginActionId ? getActionSpec(pluginActionId).outputSchema : null;
  // Only failure-shaped receipts need the catalog read. Successful/opaque Action
  // data is not an error merely because it happens to contain a status or kind.
  if (!familySchema && !readTypedDomainFailure(request.execution?.result)) return null;
  const actionId = ActionIdSchema.safeParse(request.actionId);
  const schema = familySchema ?? (actionId.success ? getActionSpec(actionId.data).outputSchema : null);
  if (!schema) return null;
  // Plugin development-loop diagnostics are opaque fields on the loose output;
  // keep them only long enough to select the display primitives below.
  const parsed = (pluginActionId ? schema : createStoredReadSchema(schema))
    .safeParse(request.execution?.result);
  if (!parsed.success) return familySchema
    ? { ok: false, errorCode: 'invalid_action_output', error: 'invalid_action_output' } : null;
  const result: unknown = parsed.data;
  if (pluginActionId && result && typeof result === 'object') {
    if (!('ok' in result) || result.ok !== false) return null;
    if ('outcome' in result && result.outcome === 'reviewRequired') return null;
    // Diagnostics are opaque in the Action's output contract. Read only the
    // producer's first display code/message; never expose its arbitrary bags.
    const diagnostic: unknown = 'diagnostics' in result && Array.isArray(result.diagnostics) ? result.diagnostics[0] : null;
    const errorCode = diagnostic && typeof diagnostic === 'object' && 'code' in diagnostic
      && typeof diagnostic.code === 'string' && diagnostic.code.trim()
      ? diagnostic.code : 'plugin_change_failed';
    const error = diagnostic && typeof diagnostic === 'object' && 'message' in diagnostic
      && typeof diagnostic.message === 'string' && diagnostic.message.trim()
      ? diagnostic.message : errorCode;
    return { ok: false, errorCode, error };
  }
  if (mutationId && result && typeof result === 'object' && 'status' in result && typeof result.status === 'string') {
    const errorCode = result.status;
    return errorCode === 'applied' || errorCode === 'satisfied' || errorCode === 'unchanged'
      ? null : { ok: false, errorCode, error: errorCode, details: result };
  }
  if (!familySchema) return readDeclaredDomainFailure(schema, result);
  if (!result || typeof result !== 'object' || !('kind' in result)) return null;
  if (request.actionId === 'action.operations.cancel' && (result.kind === 'unsupported' || result.kind === 'not_found')) {
    return { ok: false, errorCode: result.kind, error: result.kind, details: result };
  }
  const errorCode = result.kind === 'refused' && 'code' in result && typeof result.code === 'string'
    ? result.code
    : result.kind === 'conflict' ? preset.success ? 'conflict' : 'intent_changed'
      : result.kind === 'unavailable' && 'reason' in result && typeof result.reason === 'string'
        ? result.reason : null;
  return errorCode ? { ok: false, errorCode, error: errorCode, details: result } : null;
}

/** A JSON bag accepting failure-looking fields does not declare failure semantics. */
function readDeclaredDomainFailure(schema: z.core.$ZodType, value: unknown): ActionExecuteFailure | null {
  const def = (schema as z.core.$ZodTypes)._zod.def;
  switch (def.type) {
    case 'union':
      for (const option of def.options) {
        const parsed = z.safeParse(createStoredReadSchema(option), value);
        if (!parsed.success) continue;
        const failure = readDeclaredDomainFailure(option, parsed.data);
        if (failure) return failure;
      }
      return null;
    case 'lazy': return readDeclaredDomainFailure((schema as z.core.$ZodLazy)._zod.innerType, value);
    case 'pipe': return readDeclaredDomainFailure(def.out, value);
    case 'optional': case 'nullable': case 'default': case 'prefault': case 'nonoptional': case 'readonly': case 'catch':
      return readDeclaredDomainFailure(def.innerType, value);
    case 'object': {
      // Only finite discriminators describe a domain outcome. Unbounded strings,
      // records, unknown values and transforms remain opaque to this projection.
      const carrier = Object.fromEntries(['ok', 'success', 'status', 'kind', 'outcome'].flatMap(key => {
        const field = def.shape[key];
        return field && (field._zod.def.type === 'literal' || field._zod.def.type === 'enum')
          && value && typeof value === 'object' && key in value
          ? [[key, Reflect.get(value, key)]] : [];
      }));
      return hasDomainFailureDiscriminant(carrier)
        ? readTypedDomainFailure(value) : null;
    }
    default: return null;
  }
}

function hasDomainFailureDiscriminant(result: Readonly<Record<string, unknown>>): boolean {
  return result.ok === false || result.success === false
    || ['failed', 'error', 'denied', 'refused', 'rejected', 'blocked', 'timedOut', 'timed_out',
      'stale', 'policy_denied', 'unsupported', 'unavailable', 'invalid', 'not_supported',
      'conflict', 'collectorDegraded'].includes(String(result.status))
    || ['refused', 'rejected', 'blocked', 'unavailable', 'invalid', 'stale', 'conflict'].includes(String(result.kind))
    || result.outcome === 'failed' || result.outcome === 'error';
}

/** Recognize display primitives; callers expose them only after catalog validation. */
function readTypedDomainFailure(value: unknown): ActionExecuteFailure | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = value as Readonly<Record<string, unknown>>;
  if (!hasDomainFailureDiscriminant(result)) return null;
  const error = result.error && typeof result.error === 'object' && !Array.isArray(result.error)
    ? result.error as Readonly<Record<string, unknown>> : null;
  const reason = result.reason && typeof result.reason === 'object' && !Array.isArray(result.reason)
    ? result.reason as Readonly<Record<string, unknown>> : null;
  const code = [result.errorCode, error?.code, result.code, result.reasonCode, reason?.code,
    typeof result.reason === 'string' ? result.reason : undefined,
    typeof result.error === 'string' ? result.error : undefined]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  if (!code) return null;
  const message = [error?.message, result.error, reason?.message]
    .find((value): value is string => typeof value === 'string' && value.trim().length > 0);
  return { ok: false, errorCode: code, error: message ?? code };
}

/** Read terminal history without trusting legacy or unvalidated opaque fields. */
export function readApprovalExecutionFailure(
  request: ApprovalRequest | ApprovalRequestPublicRead,
): ActionExecuteFailure | null {
  const execution = request.execution;
  if (!execution) return null;
  if (execution.ok === true) return 'actionId' in request ? readDomainExecutionFailure(request) : null;
  if (execution.ok !== false) return null;
  const errorCode = typeof execution.errorCode === 'string' && execution.errorCode.trim().length > 0
    ? execution.errorCode
    : 'approval_execution_failed';
  const error = typeof execution.error === 'string' && execution.error.trim().length > 0
    ? execution.error
    : errorCode;
  const failure: ActionExecuteFailure = { ok: false, errorCode, error };
  if (request.v !== 2) return failure;
  const details = request.execution?.details;
  if (details === undefined) return failure;
  return parseStrictApprovalFailure({
    request,
    failure: { ...failure, details },
  }, true) ?? failure;
}
