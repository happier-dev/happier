import { resolveServerProfileHomeIdentityId } from '@/server/serverProfiles';
import { projectDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { readDeploymentReceiptFailureCodeV1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { deploymentAuthorizationFailure, readDeploymentAuthorizationFailure } from './deploymentAuthorizationFailure';
import { projectHomeAuthorizationHttpFailure } from '@/api/client/homeAuthorizationHttpFailure';
import { deploymentOutputValidationFailure } from './outputValidation';
import axios from '@/api/client/credentialAxios';
import { readHttpStatus } from '@/api/client/httpStatusError';
import {
  DeploymentActionInputSchemasV1, DeploymentActionOutputSchemasV1, DeploymentReceiptResultV1Schema, DeploymentDeployInputV1Schema,
  DeploymentTargetLinkInputV1Schema, DeploymentRollbackInputV1Schema, DeploymentTeardownInputV1Schema, DeploymentPromoteInputV1Schema,
  DeploymentEnvironmentCreateInputV1Schema, DeploymentEnvironmentCreateStorageInputV1Schema, DeploymentEnvironmentCreateResultV1Schema,
  createDeploymentApprovalScopeResolverV1,
  hasDeploymentEnvironmentContentPatchV1,
  type ActionExecutorContext, type ActionExecutorDeps, type DeploymentTransportActionIdV1,
  type DeploymentActionInputV1, type DeploymentActionOutputV1, type DeploymentReceiptHeaderV1, type DeploymentBindingsSetInputV1, type DeploymentBindingsPreparedInputV1,
  type DeploymentTeardownInputV1, type DeploymentReceiptResultV1, type DeploymentEnvironmentCreationReviewV1,
} from '@happier-dev/protocol';
import type { DeploymentBindingsSetStorageInputV1, MachineSecretGrantV1 } from '@happier-dev/deployment-protocol';
import { isDeploymentPromoteActionIdV1, isDeploymentApprovalMetadataPreparationActionIdV1, DEPLOYMENT_TEARDOWN_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentApprovalEnvironmentResultV1Schema, type DeploymentApprovalEnvironmentResultV1 } from '@happier-dev/protocol/deployments/deploymentApprovalScopeV1';
import { projectActionFailureCauseV1, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readHostAdmittedReviewedChildV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { isDeploymentDomainNativeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import {
  DeploymentEnvironmentAccessInputV1Schema, DeploymentEnvironmentAccessResultV1Schema,
  type DeploymentEnvironmentAccessInputV1, type DeploymentEnvironmentAccessResultV1,
} from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { bindHomeDomainHttpRequestV1, classifyHomeDomainHttpMutationFailureV1, readHomeDomainConfirmedRollbackV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import type { DeploymentEnvironmentContentPreparation, DeploymentEnvironmentContentPreparationResult } from './prepareEnvironmentContentForHost';
import { readRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { acquireRequesterAccountEncryptionCurrentness, type RequesterEnvironmentAccessObservation } from '@/api/client/accountEncryptionCurrentnessObservation';

type ReceiptSuccess = Extract<DeploymentReceiptResultV1, { ok: true; deploymentId: string }>;
type ReceiptAction = 'deployments.deploy' | 'deployments.rollback' | 'deployments.promote' | 'deployments.teardown';
export type DeploymentReceiptDispatchV1 = { [TAction in ReceiptAction]: Readonly<{
  actionId: TAction;
  input: TAction extends 'deployments.deploy' ? ReturnType<typeof DeploymentDeployInputV1Schema.parse>
    : TAction extends 'deployments.rollback' ? ReturnType<typeof DeploymentRollbackInputV1Schema.parse>
    : TAction extends 'deployments.teardown' ? DeploymentTeardownInputV1
    : ReturnType<typeof DeploymentPromoteInputV1Schema.parse>;
  receipt: ReceiptSuccess;
  context: ActionExecutorContext;
}> }[ReceiptAction];
export type PreparedDeploymentBindingStorageV1 = Omit<DeploymentBindingsSetStorageInputV1, 'grants'> & Readonly<{
  grants: readonly MachineSecretGrantV1[];
  providerVariables?: Extract<import('@happier-dev/protocol').DeploymentBindingsSetResultV1, { ok: true }>['providerVariables'];
}>;
export type DeploymentBindingPreparationRequestV1 = Readonly<{
  input: DeploymentBindingsSetInputV1; context: ActionExecutorContext;
  /** Exact future placement from this invocation's admitted update operand. */
  buildMachineId?: string;
  /** Full candidate already admitted by the Environment content owner, before the same storage CAS. */
  environmentUpdate?: true;
}>;
export type CliDeploymentEnvironmentAccessRead = (input: Omit<DeploymentEnvironmentAccessInputV1, 'environmentIds'>
  & Readonly<{ environmentIds: readonly string[] }>, context: ActionExecutorContext, effectActionId: string
) => Promise<DeploymentEnvironmentAccessResultV1 | ActionExecuteFailure>;
const normalizeProviderVariables = (value: NonNullable<PreparedDeploymentBindingStorageV1['providerVariables']>, persisted: boolean) => ({ ...value, persisted });
const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
const domainOperationUnavailable = (requiredFact: 'operationAcceptance' | 'requestId'): ActionExecuteFailure => {
  const phase = requiredFact === 'operationAcceptance'
    ? 'deployment.domain.operation_acceptance_missing' : 'deployment.domain.request_id_missing';
  return { ...failure('operation_unavailable'), error: `operation_unavailable (${phase})`,
    details: { requiredFact }, failureCause: { phase, errorClass: 'Error', errorCode: null, httpStatus: null } };
};
const transportRefusal = (error: unknown): ActionExecuteFailure | null => readHttpStatus(error) === 431
  ? { ...failure('request_headers_too_large'), details: { httpStatus: 431 } } : null;
/** Admitted local or original-requester invalidations, not serialized operands or an ACL cache. */
export type CliDeploymentEnvironmentAccessObserve = (input: Readonly<{ serverId: string }>, context: ActionExecutorContext,
  listener: (event: RequesterEnvironmentAccessObservation) => void,
) => Promise<Readonly<{ dispose(): Promise<void> }> | ActionExecuteFailure>;
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
  observeEnvironmentAccessChanges: CliDeploymentEnvironmentAccessObserve;
}> {
  const observeEnvironmentAccessChanges: CliDeploymentEnvironmentAccessObserve = async (input, context, listener) => {
    let release: (() => Promise<void>) | undefined;
    let unsubscribe: (() => void) | undefined;
    let closed = false;
    const dispose = async () => {
      if (closed) return;
      closed = true;
      context.signal?.removeEventListener('abort', retire);
      unsubscribe?.();
      await release?.();
    };
    const retire = () => { listener({ kind: 'retired' }); void dispose(); };
    try {
      const denied = await params.admitAccount(input.serverId, context);
      if (denied) return denied;
      context.signal?.throwIfAborted();
      if (context.externalActionExecutionAuthorization) {
        const requester = readRequesterAccountActionContext(context.externalActionExecutionAuthorization);
        const binding = context.externalActionExecutionAuthorization.binding;
        if (!requester || requester.authorization.binding.accountId !== binding.accountId
          || requester.authorization.binding.serverIdentityId !== binding.serverIdentityId
          || normalizeServerHttpBaseUrl(requester.serverHttpBaseUrl) !== normalizeServerHttpBaseUrl(params.serverHttpBaseUrl)) {
          return failure('admission_unavailable');
        }
        if (!await requester.isCurrent()) return failure('action_forbidden');
        context.signal?.throwIfAborted();
        release = requester.retain();
        unsubscribe = requester.subscribeEnvironmentAccess(listener);
      } else {
        if (!params.localAccount) return failure('admission_unavailable');
        // Account admission above owns local authority; join its existing pooled Account/Home observation.
        const own = acquireRequesterAccountEncryptionCurrentness({ ...params.localAccount, serverBaseUrl: params.serverHttpBaseUrl });
        release = () => own.dispose();
        await own.read(context.signal, { requireLiveObservation: true });
        context.signal?.throwIfAborted();
        unsubscribe = own.subscribeEnvironmentAccess(listener);
      }
      context.signal?.addEventListener('abort', retire, { once: true });
      context.signal?.throwIfAborted();
      return { dispose };
    } catch {
      await dispose();
      return failure(context.signal?.aborted ? 'cancelled' : 'admission_unavailable');
    }
  };
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
      if (!parsed.success && (response.status === 401 || response.status === 403)) return projectHomeAuthorizationHttpFailure(response.status, headers, response.data);
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
  function request(actionId: DeploymentTransportActionIdV1, input: DeploymentActionInputV1,
    context: ActionExecutorContext, authorizationActionId?: DeploymentTransportActionIdV1,
    creationReview?: DeploymentEnvironmentCreationReviewV1): Promise<DeploymentActionOutputV1 | ActionExecuteFailure>;
  function request(actionId: 'deployments.environments.get', input: DeploymentActionInputV1,
    context: ActionExecutorContext, authorizationActionId: DeploymentTransportActionIdV1,
    creationReview: undefined, approvalMetadata: true): Promise<DeploymentApprovalEnvironmentResultV1 | ActionExecuteFailure>;
  async function request(actionId: DeploymentTransportActionIdV1, input: DeploymentActionInputV1,
    context: ActionExecutorContext, authorizationActionId: DeploymentTransportActionIdV1 = actionId,
    creationReview?: DeploymentEnvironmentCreationReviewV1, approvalMetadata = false): Promise<DeploymentActionOutputV1 | DeploymentApprovalEnvironmentResultV1 | ActionExecuteFailure> {
    let issued = false;
    let method = 'POST';
    let preparedBindingArtifact: Pick<PreparedDeploymentBindingStorageV1, 'contentArtifactId' | 'contentHeaderVersion' | 'contentBodyVersion'> | undefined;
    let preparedUpdateArtifact: typeof preparedBindingArtifact;
    let providerVariables: PreparedDeploymentBindingStorageV1['providerVariables'];
    const withProviderEffect = (result: ActionExecuteFailure): ActionExecuteFailure => providerVariables
      ? { ...result, effectAttempted: true, details: { providerVariables: normalizeProviderVariables(providerVariables, false) } } : result;
    let preparedUpdateBindings: Pick<PreparedDeploymentBindingStorageV1, 'grants' | 'referencedSavedSecretRevisions'> | undefined;
    try {
      const denied = await params.admitAccount(input.serverId, context);
      if (denied) return denied;
      if (actionId === 'deployments.deploy' && !DeploymentDeployInputV1Schema.safeParse(input).success) return failure('client_required');
      if (actionId === 'deployments.targets.link' && !DeploymentTargetLinkInputV1Schema.safeParse(input).success) return failure('client_required');
      if (actionId === 'deployments.rollback' && !DeploymentRollbackInputV1Schema.safeParse(input).success) return failure('client_required');
      if (actionId === 'deployments.environments.create') {
        const prepared = DeploymentEnvironmentCreateInputV1Schema.safeParse(input);
        if (!prepared.success) {
          const { actionInputValidationFailure } = await import('@happier-dev/protocol/actions/executor/actionInputValidation');
          return actionInputValidationFailure(prepared.error);
        }
        input = prepared.data;
      }
      context.signal?.throwIfAborted();
      if (actionId === DEPLOYMENT_TEARDOWN_ACTION_ID_V1 && !('detachKeepRunning' in input) && !('nothingDeployed' in input)) {
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
          needsContentAdmission = hasDeploymentEnvironmentContentPatchV1(preparedInput.patch)
            || preparedInput.patch.buildMachineId !== undefined
            || current.environment.contentArtifactId !== preparedInput.contentArtifactId
            || current.environment.contentHeaderVersion !== preparedInput.contentHeaderVersion
            || current.environment.contentBodyVersion !== preparedInput.contentBodyVersion;
          if (preparedInput.patch.buildMachineId !== undefined && preparedInput.patch.buildMachineId !== current.environment.buildMachineId
            && preparedInput.patch.bindings === undefined
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
            if (actionId === 'deployments.environments.update') preparedUpdateArtifact = {
              contentArtifactId: preparedContent.input.contentArtifactId,
              contentHeaderVersion: preparedContent.input.contentHeaderVersion,
              contentBodyVersion: preparedContent.input.contentBodyVersion,
            };
          }
          if ('patch' in preparedInput && preparedInput.patch?.bindings) {
            if (!params.prepareBindings) return failure('client_required');
            const candidate = DeploymentActionInputSchemasV1['deployments.environments.update'].parse(input);
            const prepared = await params.prepareBindings({ input: {
              serverId: candidate.serverId, environmentId: candidate.environmentId, expectedRevision: candidate.expectedRevision,
              contentArtifactId: candidate.contentArtifactId, contentHeaderVersion: candidate.contentHeaderVersion,
              contentBodyVersion: candidate.contentBodyVersion, referencedSavedSecretRevisions: [],
            }, context, environmentUpdate: true,
              ...(preparedInput.patch.buildMachineId ? { buildMachineId: preparedInput.patch.buildMachineId } : {}) });
            if ('errorCode' in prepared) return prepared;
            preparedUpdateBindings = { grants: prepared.grants,
              referencedSavedSecretRevisions: prepared.referencedSavedSecretRevisions };
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
          ? DeploymentRollbackInputV1Schema : isDeploymentPromoteActionIdV1(actionId)
          ? DeploymentPromoteInputV1Schema : DeploymentActionInputSchemasV1[actionId], input: transportInput });
      method = bound.method;
      const path = approvalMetadata ? `${bound.path}&projection=approvalScope` : bound.path;
      let body = bound.body;
      if (actionId === 'deployments.environments.update' && preparedUpdateBindings) {
        body = { ...transportInput, preparedBindings: preparedUpdateBindings };
      }
      if (actionId === 'deployments.environments.update' && authoredEnvironmentInputDigest) {
        body = { ...transportInput, ...(preparedUpdateBindings ? { preparedBindings: preparedUpdateBindings } : {}),
          authoredInputDigest: authoredEnvironmentInputDigest };
      }
      if (actionId === 'deployments.cancel') body = { ...transportInput, kind: 'cancel' };
      if (actionId === 'deployments.deploy' || actionId === 'deployments.rollback' || actionId === 'deployments.promote'
        || actionId === DEPLOYMENT_TEARDOWN_ACTION_ID_V1 && !('detachKeepRunning' in transportInput) && !('nothingDeployed' in transportInput)) {
        const actionOperationId = context.operationAcceptance?.operationId;
        if (!actionOperationId) return failure('operation_unavailable');
        body = { ...transportInput, actionOperationId };
      }
      if (actionId === 'deployments.domains.add' || actionId === 'deployments.domains.remove') {
        const actionOperationId = context.operationAcceptance?.operationId;
        const requestId = context.externalActionExecutionAuthorization?.binding.requestId ?? context.actionRequestId;
        if (!actionOperationId) return domainOperationUnavailable('operationAcceptance');
        if (!requestId) return domainOperationUnavailable('requestId');
        const native = readHostAdmittedReviewedChildV1(context)?.deploymentNativeAdmission
          ?? context.externalActionExecutionAuthorization?.binding.deploymentNativeAdmission;
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
        const { providerVariables: observed, ...storage } = prepared;
        providerVariables = observed;
        body = homeId ? { ...storage, serverId: homeId } : storage;
        const changed = await params.admitAccount(input.serverId, context);
        if (changed) return withProviderEffect(changed);
      }
      const headers = await params.resolveRequestHeaders(context, authorizationActionId, { method, path,
        ...(body === undefined ? {} : { body }) });
      if (!headers) return withProviderEffect(deploymentAuthorizationFailure('home_request_headers_refused'));
      context.signal?.throwIfAborted();
      issued = true;
      context.onTransportIssued?.();
      const response = await axios.request<unknown>({ url: `${params.serverHttpBaseUrl}${path}`,
        method, headers, ...(body === undefined ? {} : { data: body }),
        ...(context.signal ? { signal: context.signal } : {}), validateStatus: () => true });
      const rollback = readHomeDomainConfirmedRollbackV1(response.status, response.data);
      if (providerVariables && rollback) return withProviderEffect(failure(rollback.code));
      if (rollback) return { ok: false, errorCode: rollback.code, error: rollback.code, effectAttempted: false,
        details: { ...rollback.details, requiredFact: 'transaction_commit',
          remedy: 'Retry the action; the Home rolled back its database transaction.' },
        failureCause: projectActionFailureCauseV1({ code: rollback.code, status: response.status }, 'home.database.transaction') };
      const parsed = (approvalMetadata ? DeploymentApprovalEnvironmentResultV1Schema : actionId === 'deployments.environments.create'
        ? DeploymentEnvironmentCreateResultV1Schema : DeploymentActionOutputSchemasV1[actionId]).safeParse(response.data);
      if (!parsed.success && providerVariables) return withProviderEffect(failure('outcome_unknown'));
      if (!parsed.success && (response.status === 401 || response.status === 403)) return projectHomeAuthorizationHttpFailure(response.status, headers, response.data);
      if (!parsed.success && method === 'GET' && ![404, 405, 501].includes(response.status)) {
        return deploymentOutputValidationFailure(actionId, response.status, parsed.error);
      }
      if (!parsed.success) return failure(response.status === 404 || response.status === 405 || response.status === 501
        ? 'unsupported_action' : method === 'GET' ? 'invalid_action_output' : 'outcome_unknown');
      if (method === 'GET') {
        context.signal?.throwIfAborted();
        const changed = await params.admitAccount(input.serverId, context);
        if (changed) return changed;
      }
      if (providerVariables && 'ok' in parsed.data && !parsed.data.ok && 'error' in parsed.data)
        return withProviderEffect(failure(parsed.data.error));
      if (actionId === 'deployments.environments.update' && parsed.data.ok && preparedUpdateArtifact)
        return { ...parsed.data, preparedArtifact: preparedUpdateArtifact };
      return actionId === 'deployments.bindings.set' && 'ok' in parsed.data && parsed.data.ok && preparedBindingArtifact
        ? { ...parsed.data, preparedArtifact: preparedBindingArtifact,
          ...(providerVariables ? { providerVariables: normalizeProviderVariables(providerVariables, true) } : {}) } : parsed.data;
    } catch (error) {
      if (providerVariables) return withProviderEffect(failure(context.signal?.aborted ? 'cancelled' : 'outcome_unknown'));
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
  return { readEnvironmentAccess, observeEnvironmentAccessChanges, resolveEnvironmentApprovalScope: args => {
    const metadataRoot = isDeploymentApprovalMetadataPreparationActionIdV1(args.actionId) ? args.actionId : undefined;
    return createDeploymentApprovalScopeResolverV1((actionId, input, context) =>
      request(actionId, input, { ...context, onTransportIssued: undefined },
        args.actionId === 'deployments.environments.update' || args.actionId === 'deployments.bindings.set'
          ? args.actionId : actionId), metadataRoot
        ? ({ serverId, environmentId, context }) => request('deployments.environments.get', { serverId, environmentId },
          { ...context, onTransportIssued: undefined }, metadataRoot, undefined, true) : undefined)(args);
  },
    deploymentAction: async (actionId, input, context, creationReview) => {
    const result = await request(actionId, input, context, actionId, creationReview);
    if (actionId === 'deployments.receipts.list' && 'ok' in result && result.ok && 'items' in result) {
      // request already validated this Action's output; the aggregate return union loses the Action/row correlation.
      const page = result as Extract<DeploymentActionOutputV1, { ok: true; items: DeploymentReceiptHeaderV1[] }>;
      return { ...page, items: page.items.map(receipt => {
        const code = readDeploymentReceiptFailureCodeV1(receipt.state);
        return code ? { ...receipt, ...projectDeploymentFailureRecoveryV1(receipt, code) } : receipt;
      }) };
    }
    if ('errorCode' in result || !('ok' in result) || !result.ok
      || (actionId !== 'deployments.deploy' && actionId !== 'deployments.rollback' && actionId !== 'deployments.promote' && actionId !== 'deployments.teardown')) return result;
    if (actionId === DEPLOYMENT_TEARDOWN_ACTION_ID_V1 && ('detached' in result || 'nothingDeployed' in result)) return result;
    const receipt = DeploymentReceiptResultV1Schema.parse(result);
    if (!receipt.ok) return receipt;
    if (!('deploymentId' in receipt)) return receipt;
    context.operationOwnerUpdate?.update({ domainRef: { kind: 'deployment', serverId: input.serverId,
      environmentId: receipt.environmentId, deploymentId: receipt.deploymentId } });
    if (receipt.state === 'succeeded' || receipt.state === 'running_unverified') return receipt;
    const receiptFailureCode = readDeploymentReceiptFailureCodeV1(receipt.state);
    if (receiptFailureCode && (actionId !== 'deployments.teardown' || receipt.state === 'cancelled')) {
      return { ok: false, errorCode: receiptFailureCode,
        error: receipt.state, details: projectDeploymentFailureRecoveryV1(receipt) };
    }
    const settled = await (actionId === 'deployments.teardown'
      ? params.dispatchReceipt({ actionId, input: DeploymentTeardownInputV1Schema.parse(input), receipt, context })
      : actionId === 'deployments.promote'
        ? params.dispatchReceipt({ actionId, input: DeploymentPromoteInputV1Schema.parse(input), receipt, context })
        : actionId === 'deployments.rollback'
          ? params.dispatchReceipt({ actionId, input: DeploymentRollbackInputV1Schema.parse(input), receipt, context })
          : params.dispatchReceipt({ actionId, input: DeploymentDeployInputV1Schema.parse(input), receipt, context }));
    if ('errorCode' in settled || !('ok' in settled) || !settled.ok) return settled;
    if (!('deploymentId' in settled)) return settled;
    const settledFailureCode = readDeploymentReceiptFailureCodeV1(settled.state);
    if (settledFailureCode) {
      return { ok: false, errorCode: settledFailureCode,
        error: settled.state, details: projectDeploymentFailureRecoveryV1(settled) };
    }
    // Provider builds can be accepted while queued/running. Their known receipt
    // remains observable; acceptance does not claim the build has completed.
    return settled;
  } };
}
