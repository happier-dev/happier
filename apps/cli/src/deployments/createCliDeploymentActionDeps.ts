import { resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { type RequesterEnvironmentAccessObservation } from '@/api/client/accountEncryptionCurrentnessObservation';
import { deploymentAuthorizationFailure, readDeploymentAuthorizationFailure } from './deploymentAuthorizationFailure';
import axios from '@/api/client/credentialAxios';
import { readHttpStatus } from '@/api/client/httpStatusError';
import {
  DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1, DeploymentReceiptResultV1Schema, DeploymentDeployInputV1Schema,
  DeploymentTargetLinkInputV1Schema, DeploymentRollbackInputV1Schema, DeploymentTeardownInputV1Schema,
  DeploymentEnvironmentCreateInputV1Schema, DeploymentEnvironmentCreateStorageInputV1Schema, DeploymentEnvironmentCreateResultV1Schema,
  createDeploymentApprovalScopeResolverV1,
  type ActionExecutorContext, type ActionExecutorDeps, type DeploymentTransportActionIdV1,
  type DeploymentActionInputV1, type DeploymentActionOutputV1, type DeploymentBindingsSetInputV1, type DeploymentBindingsPreparedInputV1,
  type DeploymentTeardownInputV1, type DeploymentReceiptResultV1, type DeploymentEnvironmentCreationReviewV1,
} from '@happier-dev/protocol';
import type { MachineSecretGrantV1 } from '@happier-dev/deployment-protocol';
import type { ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isDeploymentDomainNativeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import {
  DeploymentEnvironmentAccessInputV1Schema, DeploymentEnvironmentAccessResultV1Schema,
  type DeploymentEnvironmentAccessInputV1, type DeploymentEnvironmentAccessResultV1,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER } from '@happier-dev/protocol/actions';
import { bindHomeDomainHttpRequestV1, classifyHomeDomainHttpMutationFailureV1, readHomeDomainConfirmedRollbackV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import type { DeploymentEnvironmentContentPreparation, DeploymentEnvironmentContentPreparationResult } from './prepareEnvironmentContentForHost';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';

type ReceiptSuccess = Extract<DeploymentReceiptResultV1, { ok: true; deploymentId: string }>;
type ReceiptAction = 'deployments.deploy' | 'deployments.rollback' | 'deployments.promote' | 'deployments.teardown';
export type DeploymentReceiptDispatchV1 = { [TAction in ReceiptAction]: Readonly<{
  actionId: TAction;
  input: TAction extends 'deployments.deploy' ? ReturnType<typeof DeploymentDeployInputV1Schema.parse>
    : TAction extends 'deployments.rollback' ? ReturnType<typeof DeploymentRollbackInputV1Schema.parse>
    : TAction extends 'deployments.teardown' ? DeploymentTeardownInputV1
    : ReturnType<(typeof DeploymentActionInputSchemasV1)[TAction]['parse']>;
  receipt: ReceiptSuccess;
  context: ActionExecutorContext;
}> }[ReceiptAction];
export type PreparedDeploymentBindingStorageV1 = DeploymentBindingsPreparedInputV1 & Readonly<{ grants: readonly MachineSecretGrantV1[] }>;
export type DeploymentBindingPreparationRequestV1 = Readonly<{
  input: DeploymentBindingsSetInputV1; context: ActionExecutorContext;
  /** Exact future placement from this invocation's admitted update operand. */
  buildMachineId?: string;
}>;
export type CliDeploymentEnvironmentAccessRead = (input: Omit<DeploymentEnvironmentAccessInputV1, 'environmentIds'>
  & Readonly<{ environmentIds: readonly string[] }>, context: ActionExecutorContext, effectActionId: string
) => Promise<DeploymentEnvironmentAccessResultV1 | ActionExecuteFailure>;
const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
const transportRefusal = (error: unknown): ActionExecuteFailure | null => readHttpStatus(error) === 431
  ? { ...failure('request_headers_too_large'), details: { httpStatus: 431 } } : null;
const rejectedHomeAuthentication = (headers: Readonly<Record<string, string>>): ActionExecuteFailure =>
  Object.entries(headers).some(([name, value]) => name.toLowerCase() === EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER
    && value.length > 0) ? deploymentAuthorizationFailure('home_signed_authorization_rejected') : failure('action_home_signed_out');
const localAdmissionFailure = (error: unknown): ActionExecuteFailure | null => error instanceof Error
  && 'code' in error && typeof error.code === 'string'
  && ['action_forbidden', 'authorityChanged', 'secret_use_client_required', 'secret_save_client_required'].includes(error.code)
  ? readDeploymentAuthorizationFailure(error) ?? failure(error.code) : null;

/** Account-bound storage carrier. The target owner alone executes and settles native effects. */
export function createCliDeploymentActionDeps(params: Readonly<{
  serverHttpBaseUrl: string;
  /** Private own-Account lifetime selected by the local composition, never a received requester fallback. */
  localAccount?: Readonly<{ accountId: string; token: string }>;
  admitAccount(serverId: string, context: ActionExecutorContext): ActionExecuteFailure | null | Promise<ActionExecuteFailure | null>;
  resolveRequestHeaders(context: ActionExecutorContext, actionId: string,
    request: Readonly<{ method: string; path: string; body?: unknown }>): Readonly<Record<string, string>> | null
      | Promise<Readonly<Record<string, string>> | null>;
  dispatchReceipt(request: DeploymentReceiptDispatchV1): Promise<DeploymentReceiptResultV1 | ActionExecuteFailure>;
  admitTeardown?(input: DeploymentTeardownInputV1, context: ActionExecutorContext): Promise<ActionExecuteFailure | null>;
  prepareEnvironment?(request: DeploymentEnvironmentContentPreparation): Promise<DeploymentEnvironmentContentPreparationResult>;
  prepareBindings?(request: DeploymentBindingPreparationRequestV1):
    Promise<PreparedDeploymentBindingStorageV1 | ActionExecuteFailure>;
}>): Pick<ActionExecutorDeps, 'deploymentAction' | 'resolveEnvironmentApprovalScope'> & Readonly<{
  readEnvironmentAccess: CliDeploymentEnvironmentAccessRead;
}> {
  const readEnvironmentAccess: CliDeploymentEnvironmentAccessRead = async (input, context, effectActionId) => {
    try {
      const denied = await params.admitAccount(input.serverId, context);
      if (denied) return denied;
      context.signal?.throwIfAborted();
      if (!input.environmentIds.length) return { ok: true, items: [] };
      const parsedInput = DeploymentEnvironmentAccessInputV1Schema.safeParse({ ...input,
        serverId: context.externalActionExecutionAuthorization?.binding.serverIdentityId
          ?? await resolveServerProfileHomeIdentityId(input.serverId) ?? input.serverId,
        environmentIds: [...new Set(input.environmentIds)] });
      if (!parsedInput.success) return failure('invalid_parameters');
      const body = parsedInput.data;
      const path = '/v1/deployments/environments/access';
      const headers = await params.resolveRequestHeaders(context,
        context.externalActionExecutionAuthorization?.binding.actionId ?? effectActionId,
        { method: 'POST', path, body });
      if (!headers) return deploymentAuthorizationFailure('home_request_headers_refused');
      context.signal?.throwIfAborted();
      const response = await axios.request<unknown>({ method: 'POST', url: `${params.serverHttpBaseUrl}${path}`,
        headers, data: body, ...(context.signal ? { signal: context.signal } : {}), validateStatus: () => true });
      context.signal?.throwIfAborted();
      const changed = await params.admitAccount(input.serverId, context);
      if (changed) return changed;
      context.signal?.throwIfAborted();
      const parsed = DeploymentEnvironmentAccessResultV1Schema.safeParse(response.data);
      if (!parsed.success && response.status === 401) return rejectedHomeAuthentication(headers);
      if (!parsed.success && response.status === 403) return deploymentAuthorizationFailure('home_deployment_http_forbidden');
      if (!parsed.success) return failure(response.status === 404 || response.status === 405 || response.status === 501
        ? 'unsupported_action' : 'invalid_action_output');
      if (!parsed.data.ok) return parsed.data;
      if (response.status < 200 || response.status >= 300) return failure('invalid_action_output');
      const selected = new Set(body.environmentIds);
      const seen = new Set<string>();
      for (const item of parsed.data.items) {
        if (!selected.has(item.environmentId) || seen.has(item.environmentId)) return failure('invalid_action_output');
        seen.add(item.environmentId);
      }
      return parsed.data;
    } catch (error) {
      return context.signal?.aborted ? failure('cancelled')
        : transportRefusal(error) ?? localAdmissionFailure(error) ?? failure('home_unreachable');
    }
  };
  async function request(actionId: DeploymentTransportActionIdV1, input: DeploymentActionInputV1,
    context: ActionExecutorContext, authorizationActionId: DeploymentTransportActionIdV1 = actionId,
    creationReview?: DeploymentEnvironmentCreationReviewV1): Promise<DeploymentActionOutputV1 | ActionExecuteFailure> {
    let issued = false;
    let method = 'POST';
    let preparedBindingArtifact: Pick<PreparedDeploymentBindingStorageV1, 'contentArtifactId' | 'contentHeaderVersion' | 'contentBodyVersion'> | undefined;
    let preparedUpdateBindings: Pick<PreparedDeploymentBindingStorageV1, 'grants' | 'referencedSavedSecretRevisions'> | undefined;
    try {
      const denied = await params.admitAccount(input.serverId, context);
      if (denied) return denied;
      if (actionId === 'deployments.deploy' && !DeploymentDeployInputV1Schema.safeParse(input).success) return failure('client_required');
      if (actionId === 'deployments.targets.link' && !DeploymentTargetLinkInputV1Schema.safeParse(input).success) return failure('client_required');
      if (actionId === 'deployments.rollback' && !DeploymentRollbackInputV1Schema.safeParse(input).success) return failure('client_required');
      if (actionId === 'deployments.environments.create') {
        const prepared = DeploymentEnvironmentCreateInputV1Schema.safeParse(input);
        if (!prepared.success) return failure('client_required');
        input = prepared.data;
      }
      context.signal?.throwIfAborted();
      if (actionId === 'deployments.teardown') {
        if (!params.admitTeardown) return failure('unsupported_action');
        const unsupported = await params.admitTeardown(DeploymentTeardownInputV1Schema.parse(input), context);
        if (unsupported) return unsupported;
      }
      let authoredEnvironmentInputDigest: string | undefined;
      if (actionId === 'deployments.environments.create' || actionId === 'deployments.environments.update') {
        const preparedInput = actionId === 'deployments.environments.create'
          ? DeploymentEnvironmentCreateInputV1Schema.parse(input) : DeploymentActionInputSchemasV1[actionId].parse(input);
        // Core retains this host-private review with its exact prepared input.
        // Direct prepared references still enter content admission below.
        let needsContentAdmission = actionId !== 'deployments.environments.create' || creationReview === undefined
          || 'purpose' in preparedInput && preparedInput.purpose === 'preview';
        if ('patch' in preparedInput && preparedInput.patch) {
          // Placement alone does not open private definition content. Read its
          // exact current reference under the original update authorization;
          // this preparation read does not claim mutation custody.
          const current = await request('deployments.environments.get', {
            serverId: preparedInput.serverId, environmentId: preparedInput.environmentId,
          }, { ...context, onTransportIssued: undefined }, authorizationActionId);
          if ('errorCode' in current || !('ok' in current) || !current.ok) return current;
          if (!('environment' in current) || current.environment.id !== preparedInput.environmentId) return failure('invalid_action_output');
          if (current.environment.revision !== preparedInput.expectedRevision) return failure('deployment_conflict');
          needsContentAdmission = preparedInput.patch.ingress !== undefined
            || current.environment.contentArtifactId !== preparedInput.contentArtifactId
            || current.environment.contentHeaderVersion !== preparedInput.contentHeaderVersion
            || current.environment.contentBodyVersion !== preparedInput.contentBodyVersion;
          if (preparedInput.patch.buildMachineId !== undefined && preparedInput.patch.buildMachineId !== current.environment.buildMachineId
            && params.prepareBindings && (current.environment.runtimeTargetLinkId !== undefined || needsContentAdmission)) {
            const prepared = await params.prepareBindings({ input: {
              serverId: preparedInput.serverId, environmentId: preparedInput.environmentId,
              expectedRevision: preparedInput.expectedRevision, contentArtifactId: preparedInput.contentArtifactId,
              contentHeaderVersion: preparedInput.contentHeaderVersion, contentBodyVersion: preparedInput.contentBodyVersion,
              referencedSavedSecretRevisions: [],
            }, context, buildMachineId: preparedInput.patch.buildMachineId });
            if ('errorCode' in prepared) return prepared;
            preparedUpdateBindings = { grants: prepared.grants,
              referencedSavedSecretRevisions: prepared.referencedSavedSecretRevisions };
          }
        }
        if (needsContentAdmission) {
          if (!params.prepareEnvironment) return failure('client_required');
          const preparedContent = await params.prepareEnvironment({ actionId, input: preparedInput, context });
          if (preparedContent && 'errorCode' in preparedContent) return preparedContent;
          if (preparedContent) {
            input = preparedContent.input;
            authoredEnvironmentInputDigest = preparedContent.authoredInputDigest;
          }
        }
        const changed = await params.admitAccount(input.serverId, context);
        if (changed) return changed;
      }
      const spec = getActionSpec(actionId);
      if (!spec.serverTransport) throw new TypeError(`Missing deployment storage transport: ${actionId}`);
      const homeId = context.externalActionExecutionAuthorization?.binding.serverIdentityId
        ?? await resolveServerProfileHomeIdentityId(input.serverId);
      const targetedInput = homeId ? { ...input, serverId: homeId } : input;
      const transportInput = actionId === 'deployments.environments.create' ? (() => {
        const { copyFrom, copyPlan: _privatePlan, ...prepared } = DeploymentEnvironmentCreateInputV1Schema.parse(targetedInput);
        return { ...prepared, ...(copyFrom ? { copyFrom: {
          environmentId: copyFrom.environmentId, expectedRevision: copyFrom.expectedRevision,
        } } : {}) };
      })() : targetedInput;
      const bound = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport,
        inputSchema: actionId === 'deployments.environments.create'
          ? DeploymentEnvironmentCreateStorageInputV1Schema : actionId === 'deployments.targets.link'
          ? DeploymentTargetLinkInputV1Schema : actionId === 'deployments.rollback'
          ? DeploymentRollbackInputV1Schema : DeploymentActionInputSchemasV1[actionId], input: transportInput });
      method = bound.method;
      let body = bound.body;
      if (actionId === 'deployments.environments.update' && preparedUpdateBindings) {
        body = { ...transportInput, preparedBindings: preparedUpdateBindings };
      }
      if (actionId === 'deployments.environments.update' && authoredEnvironmentInputDigest) {
        body = { ...transportInput, ...(preparedUpdateBindings ? { preparedBindings: preparedUpdateBindings } : {}),
          authoredInputDigest: authoredEnvironmentInputDigest };
      }
      if (actionId === 'deployments.cancel') body = { ...transportInput, kind: 'cancel' };
      if (actionId === 'deployments.deploy' || actionId === 'deployments.rollback' || actionId === 'deployments.promote' || actionId === 'deployments.teardown') {
        const actionOperationId = context.operationAcceptance?.operationId;
        if (!actionOperationId) return failure('operation_unavailable');
        body = { ...transportInput, actionOperationId };
      }
      if (actionId === 'deployments.domains.add' || actionId === 'deployments.domains.remove') {
        const actionOperationId = context.operationAcceptance?.operationId;
        const requestId = context.externalActionExecutionAuthorization?.binding.requestId ?? context.actionRequestId;
        if (!actionOperationId || !requestId) return failure('operation_unavailable');
        const native = context.externalActionExecutionAuthorization?.binding.deploymentNativeAdmission;
        body = { ...transportInput, actionOperationId, requestId,
          ...(actionId === 'deployments.domains.add' && isDeploymentDomainNativeAdmissionV1(native)
            && native.authoredMetadataDigest ? { authoredInputDigest: native.inputDigest } : {}) };
      }
      if (actionId === 'deployments.bindings.set') {
        if (!params.prepareBindings) return failure('client_required');
        const prepared = await params.prepareBindings({ input: DeploymentActionInputSchemasV1[actionId].parse(input), context });
        if ('errorCode' in prepared) return prepared;
        preparedBindingArtifact = { contentArtifactId: prepared.contentArtifactId,
          contentHeaderVersion: prepared.contentHeaderVersion, contentBodyVersion: prepared.contentBodyVersion };
        body = homeId ? { ...prepared, serverId: homeId } : prepared;
        const changed = await params.admitAccount(input.serverId, context);
        if (changed) return changed;
      }
      const headers = await params.resolveRequestHeaders(context, authorizationActionId, { method, path: bound.path,
        ...(body === undefined ? {} : { body }) });
      if (!headers) return deploymentAuthorizationFailure('home_request_headers_refused');
      context.signal?.throwIfAborted();
      issued = true;
      context.onTransportIssued?.();
      const response = await axios.request<unknown>({ url: `${params.serverHttpBaseUrl}${bound.path}`,
        method, headers, ...(body === undefined ? {} : { data: body }),
        ...(context.signal ? { signal: context.signal } : {}), validateStatus: () => true });
      const rollback = readHomeDomainConfirmedRollbackV1(response.status, response.data);
      if (rollback) return { ok: false, errorCode: rollback.code, error: rollback.code, details: rollback.details };
      const parsed = (actionId === 'deployments.environments.create'
        ? DeploymentEnvironmentCreateResultV1Schema : DeploymentActionOutputSchemasV1[actionId]).safeParse(response.data);
      if (!parsed.success && response.status === 401) return rejectedHomeAuthentication(headers);
      if (!parsed.success && response.status === 403) return deploymentAuthorizationFailure('home_deployment_http_forbidden');
      if (!parsed.success) return failure(response.status === 404 || response.status === 405 || response.status === 501
        ? 'unsupported_action' : method === 'GET' ? 'invalid_action_output' : 'outcome_unknown');
      if (method === 'GET') {
        context.signal?.throwIfAborted();
        const changed = await params.admitAccount(input.serverId, context);
        if (changed) return changed;
      }
      return actionId === 'deployments.bindings.set' && 'ok' in parsed.data && parsed.data.ok && preparedBindingArtifact
        ? { ...parsed.data, preparedArtifact: preparedBindingArtifact } : parsed.data;
    } catch (error) {
      // HTTP rejected these headers before routing, including for mutations.
      if (!context.signal?.aborted) {
        const refused = transportRefusal(error);
        if (refused) return refused;
      }
      // A local admission refusal is not a Home outage. Issued mutations
      // retain their existing cancellation/outcome-unknown classification.
      if (!context.signal?.aborted && (!issued || method === 'GET')) {
        const denied = localAdmissionFailure(error);
        if (denied) return denied;
      }
      const outcome = classifyHomeDomainHttpMutationFailureV1({ error, issued, aborted: context.signal?.aborted === true });
      return failure(outcome === 'cancelled' ? 'cancelled' : method !== 'GET' && outcome === 'outcome_unknown'
        ? 'outcome_unknown' : context.signal?.aborted ? 'cancelled' : 'home_unreachable');
    }
  }
  return { readEnvironmentAccess, resolveEnvironmentApprovalScope: args => createDeploymentApprovalScopeResolverV1((actionId, input, context) =>
    request(actionId, input, { ...context, onTransportIssued: undefined },
      args.actionId === 'deployments.environments.update' || args.actionId === 'deployments.bindings.set'
        ? args.actionId : actionId))(args),
    deploymentAction: async (actionId, input, context, creationReview) => {
    const result = await request(actionId, input, context, actionId, creationReview);
    if ('errorCode' in result || !('ok' in result) || !result.ok
      || (actionId !== 'deployments.deploy' && actionId !== 'deployments.rollback' && actionId !== 'deployments.promote' && actionId !== 'deployments.teardown')) return result;
    const receipt = DeploymentReceiptResultV1Schema.parse(result);
    if (!receipt.ok) return receipt;
    if (!('deploymentId' in receipt)) return receipt;
    context.operationOwnerUpdate?.update({ domainRef: { kind: 'deployment', serverId: input.serverId,
      environmentId: receipt.environmentId, deploymentId: receipt.deploymentId } });
    if (receipt.state === 'succeeded' || receipt.state === 'running_unverified') return receipt;
    if (receipt.state === 'cancelled' || (actionId !== 'deployments.teardown' && (receipt.state === 'failed' || receipt.state === 'outcome_unknown'))) {
      return { ok: false, errorCode: receipt.state === 'failed' ? 'deployment_failed'
        : receipt.state === 'cancelled' ? 'cancelled' : 'outcome_unknown', error: receipt.state, details: receipt };
    }
    const settled = await (actionId === 'deployments.teardown'
      ? params.dispatchReceipt({ actionId, input: DeploymentTeardownInputV1Schema.parse(input), receipt, context })
      : actionId === 'deployments.promote'
        ? params.dispatchReceipt({ actionId, input: DeploymentActionInputSchemasV1[actionId].parse(input), receipt, context })
        : actionId === 'deployments.rollback'
          ? params.dispatchReceipt({ actionId, input: DeploymentRollbackInputV1Schema.parse(input), receipt, context })
          : params.dispatchReceipt({ actionId, input: DeploymentDeployInputV1Schema.parse(input), receipt, context }));
    if ('errorCode' in settled || !('ok' in settled) || !settled.ok) return settled;
    if (!('deploymentId' in settled)) return settled;
    if (settled.state === 'failed' || settled.state === 'cancelled' || settled.state === 'outcome_unknown') {
      return { ok: false, errorCode: settled.state === 'outcome_unknown' ? 'outcome_unknown' : settled.state === 'cancelled'
        ? 'cancelled' : 'deployment_failed', error: settled.state, details: settled };
    }
    // Provider builds can be accepted while queued/running. Their known receipt
    // remains observable; acceptance does not claim the build has completed.
    return settled;
  } };
}

export type CliDeploymentEnvironmentAccessObserve = (input: Readonly<{ serverId: string }>, context: ActionExecutorContext,
  listener: (event: RequesterEnvironmentAccessObservation) => void,
) => Promise<Readonly<{ dispose(): Promise<void> }> | ActionExecuteFailure>;
