import { createCliPrivateLabelActionOpener, deriveCliPrivateLabelAccountKey, openCliMachinePoolPrivateView, prepareCliPrivateLabels } from '@/api/privateLabels';
import { resolveRequesterSavedSecretActionCustody } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { PRIVATE_LABEL_RECIPIENT_CENSUS_PATH } from '@happier-dev/protocol/crypto/privateLabelRecipientCensusV1';
import { isManagedOpaquePresetMachineV1, type ManagedMachineFullV1 } from '@happier-dev/protocol/machines/managed/managedMachineV1';
import { openManagedMachineRead } from '@/machines/managed/readManagedMachine';
import { projectManagedMachinePresetForRecipientV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { externalActionHeaderRefusalFailure, refuseExternalActionHeaders, requireExternalActionHeaders } from '@/api/externalActionHeaderRefusal';
import axios from '@/api/client/credentialAxios';
import { type AxiosResponse } from 'axios';
import { createHash, randomUUID } from 'node:crypto';
import { executeSessionSectionActionV1, isSessionSectionActionIdV1 } from '@happier-dev/protocol/actions/sessionSections';
import { SessionOrganizationSnapshotRequestSchema, SessionOrganizationSnapshotResponseSchema } from '@happier-dev/protocol/sessions/organization/snapshot';
import { CreateOrUpdateSessionOrganizationFolderResponseSchema, DeleteSessionOrganizationFolderResponseSchema, SetSessionFolderAssignmentResponseSchema } from '@happier-dev/protocol/sessions/organization/mutations';
import { readActionCredentialScopeDeniedHttpFailureV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1, AccountApiTokensServerErrorV1Schema, ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1, ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1, ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1, ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1, AccountApiTokensCreateActionInputV1Schema, AccountApiTokensCreateActionOutputV1Schema, AccountApiTokensListActionInputV1Schema, AccountApiTokensListActionOutputV1Schema, AccountApiTokensRevokeActionInputV1Schema, AccountApiTokensRevokeActionOutputV1Schema, AccountApiTokensRevokeAllActionInputV1Schema, AccountApiTokensRevokeAllActionOutputV1Schema, AccountApiTokensUpdateActionInputV1Schema, AccountApiTokensUpdateActionOutputV1Schema } from '@happier-dev/protocol/auth/accountApiTokens';
import { ProjectWorkerActionInputSchemasV1 } from '@happier-dev/protocol/actions/specs/projectWorkers';
import type { ActionExecuteFailure, ActionExecutorDeps, ActionExecutorContext, ArtifactPublicLinkIssuedV1 } from '@happier-dev/protocol';
import { createAccountServerWorkspaceWorkerPreferenceClient } from '@/api/workspaces/workspaceWorkerPreferences';
import { observeProjectServicePlacementActualV1 } from '@happier-dev/protocol/workspaces/projectServicePlacementV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { readProjectAccountRowsObservation } from '@/workspaces/projectAccountRows';
import { listCurrentAccountMachines } from '@/api/machine/resolveCurrentAccountMachineTarget';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { createAccountServerMachineFinitePolicyClient } from '@/api/machine/accountServerMachineFinitePolicyClient';
import { getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { ACCOUNT_EMAIL_CHANGE_REQUEST_PATH_V1, ACCOUNT_PASSWORD_CHANGE_PATH_V1, ACCOUNT_PASSWORD_ENROLL_PATH_V1, ACCOUNT_PASSWORD_REMOVE_PATH_V1, ACCOUNT_SECURITY_PATH_V1, AccountEmailChangeRequestResponseV1Schema, AccountEmailChangeRequestV1Schema, AccountPasswordChangeRequestV1Schema, AccountPasswordEnrollRequestV1Schema, AccountPasswordMutationResponseV1Schema, AccountPasswordRemoveRequestV1Schema, AccountSecurityGetResponseV1Schema, AccountSecurityRouteErrorV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1, AccountSessionsSignOutEverywhereActionInputV1Schema, AccountSessionsSignOutEverywhereServerOutputV1Schema } from '@happier-dev/protocol/auth/accountSessions';
import { bindHomeDomainActionHttpRequestV1, bindPublicProfilePreparedHttpRequestV1, homeDomainActionOutputSchemaV1, readHomeDomainActionErrorV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { USAGE_PRICE_ACTION_IDS } from '@happier-dev/protocol/usage/usageActionIdsV1';
import { bindPublicProfileActionPorts } from '@happier-dev/protocol/actions/executor/publicProfileActions';
import { buildPublicProfileSnapshot } from '@happier-dev/protocol/account/publicProfileSnapshot';
import { bindHomeDomainHttpRequestV1, readHomeDomainConfirmedRollbackV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { bindSessionAccessActionHttpRequestV1 } from '@happier-dev/protocol/actions/sessionAccessActionFamily';
import { getActionSpec, resolveActionExecutionPlacementForInput } from '@happier-dev/protocol/actions/actionSpecs';
import { bindMachineAccessActionHttpRequestV1 } from '@happier-dev/protocol/actions/machineAccessActionFamily';
import { MachineAccessGrantsListResultV1Schema, MachineAccessMutationResultV1Schema, MachineAccessPrepareKeysInputV1Schema, MachineAccessRefusalV1Schema } from '@happier-dev/protocol/machines/machineAccessV1';
import { MachinePoolActionInputSchemasV1, MachinePoolWireOutputSchemasV1, openMachinePoolActionOutputV1, machinePoolActionEndpointPathV1 } from '@happier-dev/protocol/machines/pools/actionsV1';
import { MachinePresetActionInputSchemasV1, MachinePresetActionOutputSchemasV1, machinePresetActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { MACHINE_PRESET_ARCHIVE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/machinePresetActionIdsV1';
import { ManagedAdmissionOutputV1Schema, ManagedErrorV1Schema, ManagedMachineActionInputSchemasV1, ManagedMachineActionOutputSchemasV1, managedMachineActionEndpointPathV1, resolveManagedAcquireReviewV1, unwrapManagedMachineReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';
import { executeCliManagedAccountPower } from '@/machines/managed/accountPower';
import { executeCliManagedAccountDelete } from '@/machines/managed/accountDelete';
import { executeCliMachinePresetArchive } from '@/machines/managed/accountPresetArchive';
import { executeCliManagedAccountResize } from '@/machines/managed/accountResize';
import { executeCliManagedAccountInspect } from '@/machines/managed/accountInspect';
import { isManagedControlAdmissionActionIdV1, MANAGED_DELETE_ACTION_ID_V1, MANAGED_RESIZE_ACTION_ID_V1, MANAGED_RETIRE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/managed/actionIdsV1';
import { readCliManagedAccountGuestDiagnostics } from '@/machines/managed/accountDiagnostics';
import { executeCliManagedProvisionerList } from '@/machines/managed/provisionerDiscovery';
import { ManagedMachineControllerError } from '@happier-dev/cli-common/machines/managed';
import { normalizeActionExecutorThrownError } from '@happier-dev/protocol/actions/executor/resultProjection';
import { normalizeServerIdentityIdCapability } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import { MachinePoolErrorV1Schema } from '@happier-dev/protocol/machines/pools/v1';
import { SessionPublicLinkCreateActionInputV1Schema, projectSessionPublicLinkActionResultV1, projectSessionPublicLinkCreateActionResultV1 } from '@happier-dev/protocol/sessions/access/sessionAccessActionsV1';
import { SessionAccessErrorCodeV1Schema, SetSessionAccessContextRequestV1Schema } from '@happier-dev/protocol/sessions/access/sessionAccessOperationsV1';
import { z } from 'zod/mini';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';

import {
  createAuthenticationHttpStatusError,
  createHttpStatusError,
  isAuthenticationError,
  isAuthenticationStatus,
} from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { classifyActionTransportFailure, classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { configuration } from '@/configuration';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { StoredCredentials } from '@/persistence';
import {
  materializeSessionAccessGrantEnvelope,
  recordSessionTeamShareStatement,
  SessionAccessGrantEnvelopeHostError,
} from '@/api/sessionAccessGrantEnvelopeHost';
import {
  materializeSessionPublicLinkCreateBody,
  SessionPublicLinkEnvelopeHostError,
} from '@/api/sessionPublicLinkEnvelopeHost';
import {
  resolveExternalActionServerRequestHeaders,
  type ExternalActionMachineRequestSigningKey,
} from '@/api/externalActionExecutionAuthorization';
import { captureSessionOrganizationDisplayHost } from '@/api/sessionOrganizationDisplayHost';
import { getUsageQueryKey, resolveUsageQueryPeriod } from '@happier-dev/protocol/inputs/usageQuery';
import { resolveSessionProjectScopeV1 } from '@happier-dev/protocol/sessions/listFilter/sessionListFilterV1';
import { readUsageAccountingSnapshots } from './usageAccountingReads';
import { UsageModelPriceCatalogSchema } from '@happier-dev/protocol/usage/usageModelPriceSchemas';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';
import { resolveUsagePageAggregation, resolveUsagePageAccountingReads, type UsageAccountingSourceSnapshot, type UsagePoolSourceSnapshot, type UsageQueryPoolSnapshot, type UsageQuerySourceState } from '@happier-dev/protocol/usage/resolveUsagePageAggregation';
import { createCanonicalJsonSigningInput } from '@happier-dev/protocol/crypto/canonicalJson';
import { ConnectedServicePoolSelectionGetResponseV1Schema } from '@happier-dev/protocol/connect/connectedServicePoolSelection';
import { ConnectedServiceQuotaGetResultV1Schema, type ConnectedServiceQuotaGetResultV1 } from '@happier-dev/protocol/connect/providerAccountUsageHistory';
import { wasConnectedServiceQuotaObserved } from '@happier-dev/protocol/connect/quotaObservationTime';
import { AccountProfileResponseSchema } from '@happier-dev/protocol/account/profile';
import { PublicProfileReadResultV1Schema } from '@happier-dev/protocol/account/publicProfilePublication';
import { AccountSettingsV2GetResponseSchema } from '@happier-dev/protocol/account/settings/accountSettingsApiV2';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { admitUsageCoachRemedies, applyUsageCoachPreferences } from '@happier-dev/protocol/usage/coach/evaluateUsageCoach';
import { buildUsageCoachRemedies } from '@happier-dev/protocol/usage/coach/buildUsageCoachRemedies';
import { loadMcpServerCatalogV1, type McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { createCliAccountKvJsonTransport, resolveCliAccountStorageContext } from '@/api/client/accountKvJsonTransport';
import { createUsageCoachSuppressionPort, USAGE_COACH_SUPPRESSIONS_KV_KEY, type UsageCoachSuppressionStateV1 } from '@happier-dev/protocol/usage/coach/coachActions';
import { readAccountSettingsV2Raw } from '@/settings/accountSettings/updateAccountSettingsV2WithRetry';
import { ActionExecuteFailureSchema, parseActionExecuteFailure, readUnexpectedActionErrorDiagnosticV1, type AccountActionHttpFailureDetailsV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { isServerProfileHomeIdentity } from '@/server/serverProfiles';

export type AccountServerActionDeps = Pick<
  ActionExecutorDeps,
  | 'accountSessionsSignOutEverywhereAction'
  | 'accountApiTokensCreateAction'
  | 'accountApiTokensUpdateAction'
  | 'accountApiTokensListAction'
  | 'accountApiTokensRevokeAction'
  | 'accountApiTokensRevokeAllAction'
  | 'accountSecurityGetAction'
  | 'accountPasswordEnrollAction'
  | 'accountPasswordChangeAction'
  | 'accountPasswordRemoveAction'
  | 'accountEmailChangeRequestAction'
  | 'machinePoolAction'
  | 'machinePresetAction'
  | 'machinePresetArchive'
  | 'managedMachineAction'
  | 'homeDomainAction'
  | 'privateLabelOpen'
  | 'privateLabelPrepare'
  | 'sessionAccessAction'
  | 'machineAccessAction'
  | 'projectWorkerAction'
  | 'usageActions'
  | 'publicProfileActions'
>;

type AccountServerActionFixedHome =
  | Readonly<{ serverId?: undefined; serverHttpBaseUrl?: undefined }>
  | Readonly<{ serverId: string; serverHttpBaseUrl: string }>;

type AccountServerActionParams<TInputSchema extends z.ZodMiniType, TOutputSchema extends z.ZodMiniType> = Readonly<{
  headers: Readonly<Record<string, string>>;
  path: string;
  input: z.input<TInputSchema>;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  serverHttpBaseUrl?: string;
  signal?: AbortSignal;
}>;

const PublicShareDeleteHttpResponseSchema = z.looseObject({
  success: z.literal(true),
});

function accountHttpOutcomeUnknown(category: AccountActionHttpFailureDetailsV1['category']): ActionExecuteFailure {
  return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown', details: { category } };
}

function accountHttpTransportOutcomeUnknown(error: unknown): ActionExecuteFailure {
  return accountHttpOutcomeUnknown(classifyServerEndpointError(error).kind === 'timeout' ? 'transport_timeout' : 'transport_error');
}

async function executeAccountSecurityAction<TInputSchema extends z.ZodMiniType, TOutputSchema extends z.ZodMiniType>(
  params: AccountServerActionParams<TInputSchema, TOutputSchema>,
): Promise<z.output<TOutputSchema> | ActionExecuteFailure> {
  const response = await axios.post<unknown>(
    `${params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()}${params.path}`,
    params.inputSchema.parse(params.input),
    {
      headers: {
        ...params.headers,
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
      ...(params.signal ? { signal: params.signal } : {}),
      validateStatus: () => true,
    },
  );
  if (response.status >= 400) {
    const failure = AccountSecurityRouteErrorV1Schema.safeParse(response.data);
    if (failure.success) return { ok: false, errorCode: failure.data.error, error: failure.data.error };
    if ([404, 405, 501].includes(response.status)) return { ok: false, errorCode: 'unsupported', error: 'unsupported' };
  }
  if (isAuthenticationStatus(response.status)) {
    throw createAuthenticationHttpStatusError(
      response.status,
      `Authentication failed while executing Account Security Action (${response.status})`,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw createHttpStatusError(
      response.status,
      `Failed to execute Account Security Action (${response.status})`,
    );
  }
  return params.outputSchema.parse(response.data);
}

async function executeAccountSecurityGet<TOutputSchema extends z.ZodMiniType>(
  params: Readonly<{
    headers: Readonly<Record<string, string>>;
    path: string;
    outputSchema: TOutputSchema;
    serverHttpBaseUrl?: string;
    signal?: AbortSignal;
  }>,
): Promise<z.output<TOutputSchema> | ActionExecuteFailure> {
  const response = await axios.get<unknown>(
    `${params.serverHttpBaseUrl ?? resolveServerHttpBaseUrl()}${params.path}`,
    {
      headers: params.headers,
      timeout: 15_000,
      ...(params.signal ? { signal: params.signal } : {}),
      validateStatus: () => true,
    },
  );
  if (response.status >= 400) {
    if ([404, 405, 501].includes(response.status)) return { ok: false, errorCode: 'unsupported', error: 'unsupported' };
  }
  if (isAuthenticationStatus(response.status)) {
    throw createAuthenticationHttpStatusError(
      response.status,
      `Authentication failed while executing Account Security Action (${response.status})`,
    );
  }
  if (response.status < 200 || response.status >= 300) {
    throw createHttpStatusError(
      response.status,
      `Failed to execute Account Security Action (${response.status})`,
    );
  }
  return params.outputSchema.parse(response.data);
}

/**
 * Thin CLI/daemon adapter for Account-server-owned auth Actions. The canonical
 * ActionExecutor retains admission and authority decisions; this dependency
 * only reaches the existing Account-scoped HTTP owners with the daemon's
 * configured signed Account credential.
 */
export function createAccountServerActionDeps(input: Readonly<{
  token: string;
  /** Called immediately before a Home Action request is handed to Axios. */
  onRequestIssued?: () => void;
  /** Existing Machine installation key used only for Home-authorized external Action requests. */
  externalActionMachineRequestPrivateKey?: ExternalActionMachineRequestSigningKey;
  externalActionMachineInstallationId?: string;
  /** Exact Account credential material used only by trusted host-side encryption adapters. */
  credentials?: StoredCredentials;
  /** Optional local notification; approved creation also returns the full URL. */
  onPublicLinkIssued?: (link: ArtifactPublicLinkIssuedV1) => void | Promise<void>;
  /** Incumbent credential/scope owner; checked around private direct-grant materialization. */
  isCredentialCurrent?: () => boolean | Promise<boolean>;
  /** Cryptographic Home identity observed from the bound endpoint's feature projection. */
  serverIdentityId?: string;
  /** Exact Home feature projection used by trusted Session-detail consumers. */
  resolveServerFeaturesSnapshot?: () =>
    | CliServerFeaturesSnapshot
    | undefined
    | Promise<CliServerFeaturesSnapshot | undefined>;
  /** Optional process-lifetime endpoint binding for long-lived executors such as MCP. */
}> & AccountServerActionFixedHome): AccountServerActionDeps {
  if (
    (input.serverId === undefined) !== (input.serverHttpBaseUrl === undefined)
    || (input.serverId !== undefined && input.serverId.trim().length === 0)
    || (input.serverHttpBaseUrl !== undefined && input.serverHttpBaseUrl.trim().length === 0)
  ) {
    throw new Error('fixed_action_server_target_incomplete');
  }
  const serverHttpBaseUrl = input.serverHttpBaseUrl ?? resolveServerHttpBaseUrl();
  const credentials = input.credentials?.token === input.token ? input.credentials : { token: input.token, encryption: null };
  const serverId = input.serverId ?? configuration.activeServerId;
  // Local routing/profile identity never substitutes for cryptographic Home
  // identity. External invocation authority compares only the explicit
  // serverIdentityId; ordinary daemon-bearer work does not consume it, so
  // supported ordinary V1 credentials are preserved while a missing
  // cryptographic identity fails closed instead of falling back to serverId.
  const serverIdentityId = input.serverIdentityId;
  const accountServerTargetMismatch = async (actionContext: Readonly<{ serverId?: string | null }> | undefined): Promise<ActionExecuteFailure | null> =>
    actionContext?.serverId && !await isServerProfileHomeIdentity(serverId, actionContext.serverId)
      ? { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' }
      : null;
  // Home answered 401/403: its authentication verdict. A local header refusal keeps its typed reason instead.
  const homeAuthenticationRefused = (): ActionExecuteFailure => ({
    ok: false,
    errorCode: 'not_authenticated',
    error: 'not_authenticated',
  });
  // This port has no signed external carrier; the refusal keeps the invocation's requestId.
  const externalTransportUnsupported = (context: ActionExecutorContext | undefined): ActionExecuteFailure =>
    externalActionHeaderRefusalFailure(refuseExternalActionHeaders('external_transport_unsupported',
      context?.externalActionExecutionAuthorization?.binding.requestId));
  const qualifiedHomeActionFailure = async (params: Readonly<{
    actionId: string;
    homeId: string;
    context?: ActionExecutorContext;
    signal?: AbortSignal;
  }>): Promise<ActionExecuteFailure | null> => {
    const mismatch = await accountServerTargetMismatch(params.context);
    if (mismatch) return mismatch;
    if (params.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    const snapshot = serverIdentityId ? undefined : await input.resolveServerFeaturesSnapshot?.();
    const homeIdentity = serverIdentityId ?? (snapshot?.status === 'ready' && snapshot.provenance === 'authenticated'
      ? normalizeServerIdentityIdCapability(snapshot.features.capabilities.serverIdentity?.serverIdentityId)
      : undefined);
    if (!homeIdentity) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${params.actionId}` };
    if (params.homeId !== homeIdentity) return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
    if (input.isCredentialCurrent && !await input.isCredentialCurrent()) {
      return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
    }
    return null;
  };
  const resolveRequestHeaders = (params: Readonly<{
    context: ActionExecutorContext | undefined;
    effectActionId: string;
    method: string;
    path: string;
    body?: unknown;
  }>) => resolveExternalActionServerRequestHeaders({
    context: params.context,
    effectActionId: params.effectActionId,
    method: params.method,
    path: params.path,
    ...(params.body === undefined ? {} : { body: params.body }),
    daemonToken: input.token,
    serverIdentityId,
    ...(input.externalActionMachineRequestPrivateKey
      ? { privateKey: input.externalActionMachineRequestPrivateKey }
      : {}),
    ...(input.externalActionMachineInstallationId
      ? { installationId: input.externalActionMachineInstallationId }
      : {}),
  });
  const dispatchAccountServerActionHttpRequest = async (params: Readonly<{
    headers: Readonly<Record<string, string>>;
    method: string;
    path: string;
    body?: unknown;
    signal?: AbortSignal;
    sideEffectClass: ReturnType<typeof getActionSpec>['sideEffectClass'];
    replayAmbiguousOnce?: boolean;
  }>): Promise<Readonly<{ ok: true; response: AxiosResponse<unknown> }> | ActionExecuteFailure> => {
    const mutation = params.sideEffectClass !== 'none' && params.sideEffectClass !== 'read';
    // An already-aborted signal proves this adapter has not handed request
    // bytes to Axios. After dispatch, cancellation cannot prove that a Home
    // mutation did not commit before the response was lost.
    if (params.signal?.aborted) {
      return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
    }

    let requestIssued = false;
    const issueRequest = async (): Promise<Readonly<{ ok: true; response: AxiosResponse<unknown> }> | ActionExecuteFailure> => {
      const response = await axios.request<unknown>({
        method: params.method,
        url: `${serverHttpBaseUrl}${params.path}`,
        ...(params.body === undefined ? {} : { data: params.body }),
        headers: { ...params.headers, 'Content-Type': 'application/json' },
        // The Action signal owns cancellation; Home's transaction owner may
        // recover across several attempts. This phase has no shorter deadline.
        timeout: 0,
        ...(params.signal ? { signal: params.signal } : {}),
        validateStatus: () => true,
      });
      const scopeDenial = readActionCredentialScopeDeniedHttpFailureV1(response.status, response.data);
      return scopeDenial ?? { ok: true, response };
    };
    try {
      input.onRequestIssued?.();
      requestIssued = true;
      return await issueRequest();
    } catch (error) {
      const cancelled = params.signal?.aborted === true || axios.isCancel(error);
      const failure = classifyActionTransportFailure(error, { mutation, requestIssued, cancelled });
      if (!failure) throw error;
      if (cancelled) return failure === 'outcome_unknown'
        ? accountHttpTransportOutcomeUnknown(error) : { ok: false, errorCode: failure, error: failure };
      if (failure === 'outcome_unknown') {
        if (params.replayAmbiguousOnce) {
          try {
            // Public-link POST is value-idempotent. This reuses the one
            // materialized body so bearer and ciphertext bytes stay exact.
            return await issueRequest();
          } catch (replayError) {
            return accountHttpTransportOutcomeUnknown(replayError);
          }
        }
        return accountHttpTransportOutcomeUnknown(error);
      }
      return { ok: false, errorCode: 'server_unreachable', error: 'server_unreachable' };
    }
  };
  const settleAccountServerActionHttpOutput = <TOutputSchema extends z.ZodMiniType>(params: Readonly<{
    data: unknown;
    outputSchema: TOutputSchema;
    sideEffectClass: ReturnType<typeof getActionSpec>['sideEffectClass'];
  }>): z.output<TOutputSchema> | ActionExecuteFailure => {
    try {
      return params.outputSchema.parse(params.data);
    } catch (error) {
      const mutation = params.sideEffectClass !== 'none' && params.sideEffectClass !== 'read';
      if (!mutation) throw error;
      // A 2xx response with an unusable acknowledgement cannot establish that
      // a Home mutation settled without committing its effect.
      return accountHttpOutcomeUnknown('acknowledgement_schema');
    }
  };
  const readAccountApiTokenHttpFailure = (response: AxiosResponse<unknown>): ActionExecuteFailure | null => {
    if (response.status < 400) return null;
    const failure = AccountApiTokensServerErrorV1Schema.safeParse(response.data);
    if (failure.success) {
      return { ok: false, errorCode: failure.data.error, error: failure.data.error };
    }
    if ([404, 405, 501].includes(response.status)) {
      return { ok: false, errorCode: 'unsupported', error: 'unsupported' };
    }
    if (isAuthenticationStatus(response.status)) {
      return { ok: false, errorCode: 'not_authenticated', error: 'not_authenticated' };
    }
    if (response.status === 429) {
      return { ok: false, errorCode: 'rate_limited', error: 'rate_limited' };
    }
    return { ok: false, errorCode: 'api_token_operation_failed', error: 'api_token_operation_failed' };
  };
  const prepareApiTokenBody = async (actionId: 'account.apiTokens.create' | 'account.apiTokens.update', value: unknown,
    context: ActionExecutorContext) => {
    const authored = actionId === 'account.apiTokens.create' ? AccountApiTokensCreateActionInputV1Schema.parse(value)
      : AccountApiTokensUpdateActionInputV1Schema.parse(value);
    const assertCurrent = async () => {
      context.signal?.throwIfAborted();
      if (input.isCredentialCurrent && !await input.isCredentialCurrent()) {
        throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
      }
    };
    await assertCurrent();
    if (authored.deployment) {
      const mismatch = await accountServerTargetMismatch({ serverId: authored.deployment.serverId });
      if (mismatch) throw Object.assign(new Error(mismatch.errorCode), { code: mismatch.errorCode });
    }
    const { prepareApiTokenDeploymentAuthoring, resolveInitialDeploymentApprovalV1 } = await import('@happier-dev/protocol/actions/executor/workflowRunActions');
    let initialDeployApproval: 'automatic' | 'ask' | undefined;
    if (authored.deployment && authored.deployment.deployApproval === undefined && authored.grant?.deployApproval === undefined) {
      const { createCliDeploymentActionDeps } = await import('@/deployments/createCliDeploymentActionDeps');
      const reads = createCliDeploymentActionDeps({ serverHttpBaseUrl,
        admitAccount: async requestedServerId => {
          await assertCurrent();
          return accountServerTargetMismatch({ serverId: requestedServerId });
        },
        resolveRequestHeaders: (readContext, readActionId, request) => {
          const authorization = resolveRequestHeaders({ context: readContext,
            effectActionId: readContext.externalActionExecutionAuthorization?.binding.actionId ?? readActionId, ...request });
          return requireExternalActionHeaders(authorization);
        },
        dispatchReceipt: async () => ({ ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' }),
      });
      const initial = await resolveInitialDeploymentApprovalV1({ serverId: authored.deployment.serverId,
        environmentId: authored.deployment.environmentId, context, read: reads.deploymentAction! });
      if (!initial.ok) throw Object.assign(new Error(initial.errorCode), { code: initial.errorCode });
      initialDeployApproval = initial.mode;
    }
    const accountId = input.credentials?.token === input.token ? readAccountIdFromToken(input.token) : null;
    const prepared = await prepareApiTokenDeploymentAuthoring({ actionId, value: authored, context,
      host: { ...(initialDeployApproval ? { initialDeployApproval } : {}),
        ...(accountId ? { nativeAccount: { accountId, serverId,
          isCurrent: async () => { await assertCurrent(); return true; } } } : {}) } });
    const body = prepared.body.deployment && serverIdentityId
      ? { ...prepared.body, deployment: { ...prepared.body.deployment, serverId: serverIdentityId } } : prepared.body;
    return { body, assertCurrent };
  };
  const readPrices = async (refresh: boolean, context: ActionExecutorContext) => {
    const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
    const mismatch = await accountServerTargetMismatch(context);
    if (mismatch) return mismatch;
    if (context.signal?.aborted) return failure('cancelled');
    if (input.isCredentialCurrent && !await input.isCredentialCurrent()) return failure('credential_scope_retired');
    const actionId = refresh ? USAGE_PRICE_ACTION_IDS.refresh : USAGE_PRICE_ACTION_IDS.get;
    const spec = getActionSpec(actionId);
    const { path, method, body } = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport!, inputSchema: spec.inputSchema, input: {} });
    const authorization = resolveRequestHeaders({ context, effectActionId: actionId, method, path, body });
    if (!authorization.ok) return externalActionHeaderRefusalFailure(authorization);
    const sideEffectClass = spec.sideEffectClass;
    const dispatched = await dispatchAccountServerActionHttpRequest({ headers: authorization.headers, method, path, body,
      signal: context.signal, sideEffectClass });
    if (!dispatched.ok) return dispatched;
    if (context.signal?.aborted) return failure(refresh ? 'outcome_unknown' : 'cancelled');
    if (input.isCredentialCurrent && !await input.isCredentialCurrent()) return failure('credential_scope_retired');
    if (isAuthenticationStatus(dispatched.response.status)) return homeAuthenticationRefused();
    if ([404, 405, 501].includes(dispatched.response.status)) return failure('unsupported');
    if (dispatched.response.status >= 400) return failure('usage_prices_read_failed');
    const parsed = UsageModelPriceCatalogSchema.safeParse(dispatched.response.data);
    return parsed.success ? parsed.data : failure(refresh ? 'outcome_unknown' : 'usage_price_catalog_invalid');
  };
  const readQuota: NonNullable<NonNullable<ActionExecutorDeps['usageActions']>['readQuota']> = async (request, context) => {
        const mismatch = await accountServerTargetMismatch(context);
        if (mismatch) return mismatch;
        const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
        const check = async () => {
          context.signal?.throwIfAborted();
          if (input.isCredentialCurrent && !await input.isCredentialCurrent()) {
            throw Object.assign(new Error('Captured Usage credential retired'), { code: 'scope-retired' });
          }
        };
        try {
          await check();
          const { createCliConnectedServiceAction } = await import('@/session/actions/connectedServiceActionDeps');
          await check();
          const quotaAction = createCliConnectedServiceAction({
            credentials: input.credentials?.token === input.token ? input.credentials : { token: input.token, encryption: null },
            serverId, serverHttpBaseUrl,
            ...(input.isCredentialCurrent ? { isCredentialCurrent: input.isCredentialCurrent } : {}),
            resolveHeaders: (caller, actionId, read) => {
              const authorization = resolveRequestHeaders({ context: caller, effectActionId: actionId, ...read });
              return requireExternalActionHeaders(authorization);
            },
            // This adapter invokes only quota.get, which has no Machine-control effect.
            callMachineAction: async () => { throw new Error('usage_quota_read_has_no_machine_effect'); },
          });
          const result = await quotaAction({ actionId: 'connectedServices.quota.get', input: request,
            context, ...(context.signal ? { signal: context.signal } : {}) });
          await check();
          const parsed = ConnectedServiceQuotaGetResultV1Schema.safeParse(result);
          const refused = ActionExecuteFailureSchema.safeParse(result);
          if (refused.success) return refused.data;
          return parsed.success ? parsed.data : failure('usage_quota_result_invalid');
        } catch (error) {
          if (context.signal?.aborted || axios.isCancel(error)) return failure('cancelled');
          const code = error instanceof Error && 'code' in error ? error.code : undefined;
          if (code === 'scope-retired' || input.isCredentialCurrent && !await input.isCredentialCurrent()) return failure('credential_scope_retired');
          const typedFailure = parseActionExecuteFailure(error);
          if (typedFailure) return typedFailure;
          if (isAuthenticationError(error)) return homeAuthenticationRefused();
          return failure('usage_quota_read_failed');
        }
      };
  const coachSuppressions = (context: ActionExecutorContext,
    effectActionId = context.externalActionExecutionAuthorization?.binding.actionId ?? 'usage.coach.dismiss') => createUsageCoachSuppressionPort({
    transport: createCliAccountKvJsonTransport({ credentials, key: USAGE_COACH_SUPPRESSIONS_KV_KEY, serverBaseUrl: serverHttpBaseUrl,
      signal: context.signal, resolveAuthorizationHeaders: request => {
        const authorization = resolveRequestHeaders({ context, effectActionId, ...request });
        return requireExternalActionHeaders(authorization);
      } }),
  });
  const openPrivateLabel = createCliPrivateLabelActionOpener(credentials.encryption);
  const deps: AccountServerActionDeps = {
    privateLabelPrepare: async (request, context) => {
      const mismatch = await accountServerTargetMismatch(context);
      if (mismatch) throw Object.assign(new Error(mismatch.errorCode), { code: mismatch.errorCode });
      const custody = resolveRequesterSavedSecretActionCustody({
        authorization: context.externalActionExecutionAuthorization, credentials,
      });
      const effectActionId = request.actionId;
      const currentnessHeaders = requireExternalActionHeaders(resolveRequestHeaders({ context, effectActionId,
        method: 'GET', path: '/v1/account/encryption/currentness' }));
      const endpoint = custody.operation?.serverHttpBaseUrl ?? serverHttpBaseUrl;
      const storage = await resolveCliAccountStorageContext({ credentials: custody.credentials, serverBaseUrl: endpoint,
        authorizationHeaders: currentnessHeaders, ...(request.signal ? { signal: request.signal } : {}) });
      const path = PRIVATE_LABEL_RECIPIENT_CENSUS_PATH;
      const body = { owner: request.owner };
      const authorizationHeaders = requireExternalActionHeaders(resolveRequestHeaders({ context, effectActionId,
        method: 'POST', path, body }));
      return await prepareCliPrivateLabels({ endpoint, token: custody.credentials.token, accountMode: storage.mode,
        recipientCensusPath: path, authorizationHeaders, owner: request.owner, labels: request.labels,
        ...(request.signal ? { signal: request.signal } : {}) });
    },
    privateLabelOpen: async (request, context) => {
      if (await accountServerTargetMismatch(context)) return null;
      if (input.isCredentialCurrent && !await input.isCredentialCurrent()) {
        throw Object.assign(new Error('The Account credential is no longer current.'), { code: 'action_account_scope_changed' });
      }
      return await openPrivateLabel(request, context);
    },
    usageActions: {
      coachSuppressions,
      readQuota,
      readPublicProfile: async (context) => {
        const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
        const mismatch = await accountServerTargetMismatch(context);
        if (mismatch) return mismatch;
        if (context.signal?.aborted) return failure('cancelled');
        if (input.isCredentialCurrent && !await input.isCredentialCurrent()) return failure('credential_scope_retired');
        const effectActionId = context.externalActionExecutionAuthorization?.binding.actionId ?? 'usage.recap.compose';
        // Only the captured recap invocation may consume this Account-scoped
        // current view. Neither a caller handle nor a caller public DTO is accepted.
        if (!['usage.recap.compose', 'usage.recap.export', 'usage.recap.deliver'].includes(effectActionId)) {
          return externalTransportUnsupported(context);
        }
        const path = '/v1/account/public-profile/view';
        const authorization = resolveRequestHeaders({ context, effectActionId, method: 'GET', path });
        if (!authorization.ok) return externalActionHeaderRefusalFailure(authorization);
        const dispatched = await dispatchAccountServerActionHttpRequest({ headers: authorization.headers,
          method: 'GET', path, signal: context.signal, sideEffectClass: 'read' });
        if (context.signal?.aborted) return failure('cancelled');
        if (input.isCredentialCurrent && !await input.isCredentialCurrent()) return failure('credential_scope_retired');
        if (!dispatched.ok) return dispatched;
        if (isAuthenticationStatus(dispatched.response.status)) return homeAuthenticationRefused();
        if ([404, 405, 501].includes(dispatched.response.status)) return { kind: 'unavailable' };
        if (dispatched.response.status < 200 || dispatched.response.status >= 300) return failure('public_profile_read_failed');
        const parsed = PublicProfileReadResultV1Schema.safeParse(dispatched.response.data);
        return parsed.success ? parsed.data : failure('public_profile_read_invalid');
      },
      prices: {
        get: context => readPrices(false, context),
        refresh: context => readPrices(true, context),
      },
      query: async (request, context) => {
        const mismatch = await accountServerTargetMismatch(context);
        if (mismatch) return mismatch;
        const retired = (): ActionExecuteFailure => ({ ok: false, errorCode: 'credential_scope_retired', error: 'credential_scope_retired' });
        if (input.isCredentialCurrent && !await input.isCredentialCurrent()) return retired();
        const accountingNowMs = Date.now();
        const accountingReads = resolveUsagePageAccountingReads(request.queries, accountingNowMs);
        // A selected Project asks for every key its usage may carry (owner 11-08), from one census read. Without the
        // census (an external read principal, or the read failing) the Project's anchor alone.
        let projectScopeKeys: ((projectKey: string) => Iterable<string>) | undefined;
        if (accountingReads.some(({ query }) => query.projects.length > 0)
          && !context?.externalActionCredential && !context?.externalActionExecutionAuthorization) {
          const homeId = serverIdentityId ?? serverId;
          try {
            const observation = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => readProjectAccountRowsObservation({
              credentials, serverId: homeId, signal: context?.signal, selection: { kinds: ['workspace-ref'] } }));
            const refs = observation.snapshot.workspaceRefs;
            projectScopeKeys = projectKey => resolveSessionProjectScopeV1({ serverId: homeId, projectKey }, refs).projectKeys;
          } catch {
            context?.signal?.throwIfAborted();
          }
        }
        const snapshots = await readUsageAccountingSnapshots({ reads: accountingReads, nowMs: accountingNowMs, projectScopeKeys,
          post: async (path, body) => {
            const authorization = resolveRequestHeaders({ context, effectActionId: 'usage.query', method: 'POST', path, body });
            if (!authorization.ok) return externalActionHeaderRefusalFailure(authorization);
            if (input.isCredentialCurrent && !await input.isCredentialCurrent()) return retired();
            const dispatched = await dispatchAccountServerActionHttpRequest({ headers: authorization.headers, method: 'POST', path, body,
              signal: context.signal, sideEffectClass: 'read' });
            if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
            if (input.isCredentialCurrent && !await input.isCredentialCurrent()) return retired();
            if (!dispatched.ok) return { sourceErrorCode: dispatched.errorCode };
            if (isAuthenticationStatus(dispatched.response.status)) return homeAuthenticationRefused();
            return { response: dispatched.response };
          },
        });
        if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
        if (input.isCredentialCurrent && !await input.isCredentialCurrent()) return retired();
        const refusal = snapshots.find((snapshot): snapshot is ActionExecuteFailure => 'ok' in snapshot);
        if (refusal) return refusal;
        const check = async () => {
          context.signal?.throwIfAborted();
          if (input.isCredentialCurrent && !await input.isCredentialCurrent()) throw Object.assign(new Error('Usage scope retired'), { code: 'scope-retired' });
        };
        const read = async (path: string) => {
          await check();
          const authorization = resolveRequestHeaders({ context, effectActionId: 'usage.query', method: 'GET', path });
          if (!authorization.ok) throw Object.assign(new Error('Action authorization unavailable'), { code: 'action_authorization_unavailable' });
          const result = await dispatchAccountServerActionHttpRequest({ headers: authorization.headers, method: 'GET', path,
            signal: context.signal, sideEffectClass: 'read' });
          await check();
          if (!result.ok || result.response.status >= 400) throw Object.assign(new Error('Usage source unavailable'), {
            code: result.ok ? result.response.status === 401 || result.response.status === 403 ? 'denied'
              : [404, 405, 501].includes(result.response.status) ? 'unsupported' : 'read_failed' : result.errorCode,
            ...(result.ok ? { status: result.response.status } : {}),
          });
          return result.response.data;
        };
        type Quota = NonNullable<Parameters<typeof resolveUsagePageAggregation>[0]['quota']>;
        let quota: Quota = { status: 'unknown' };
        let quotaSources: UsageQuerySourceState[] = [];
        let pools: UsagePoolSourceSnapshot[] | undefined;
        let preferences: ReturnType<typeof accountSettingsParse>['usageCoachPreferencesV1'] | undefined;
        let suppressionState: UsageCoachSuppressionStateV1 | undefined;
        let pricingOverrides: ReturnType<typeof accountSettingsParse>['usageModelPriceOverridesV1'] | undefined;
        let accountSettings: ReturnType<typeof accountSettingsParse> | undefined;
        let accountEncryptionMode: 'plain' | 'e2ee' | null = null;
        let accountStorage: Awaited<ReturnType<typeof resolveCliAccountStorageContext>> | null = null;
        let accountId = context.runtimeAccountId;
        try {
          const authorization = resolveRequestHeaders({ context, effectActionId: 'usage.query', method: 'GET', path: '/v1/account/encryption/currentness' });
          if (!authorization.ok) throw Object.assign(new Error('Action authorization unavailable'), { code: 'action_authorization_unavailable' });
          const storage = await resolveCliAccountStorageContext({ credentials, serverBaseUrl: serverHttpBaseUrl,
            authorizationHeaders: authorization.headers, signal: context.signal });
          accountEncryptionMode = storage.mode;
          accountStorage = storage;
          await check();
          const settings = await readAccountSettingsV2Raw({ credentials, signal: context.signal, deps: {
            resolveAccountEncryptionMode: async () => storage.mode,
            fetchSettings: async () => AccountSettingsV2GetResponseSchema.parse(await read('/v2/account/settings')),
          } });
          await check();
          const parsedSettings = accountSettingsParse(settings.raw);
          accountSettings = parsedSettings;
          preferences = parsedSettings.usageCoachPreferencesV1;
          if (request.queries.some(query => query.includeAccounting && query.includeSessionEvidence)) {
            suppressionState = await coachSuppressions(context, 'usage.query').read();
          }
          pricingOverrides = parsedSettings.usageModelPriceOverridesV1;
          const profileRequest = bindHomeDomainActionHttpRequestV1('account.profile.get', {});
          const profile = AccountProfileResponseSchema.parse(await read(profileRequest.path));
          accountId = profile.id;
          pools = await Promise.all(request.queries.map(async query => ({ query,
            value: await Promise.all(profile.connectedAccountGroupsV4.map(async group => {
              const machineId = query.machines.length === 1 ? query.machines[0] : undefined;
              let selection: UsageQueryPoolSnapshot['selection'] = { status: 'unsupported', errorCode: 'machine_context_unavailable' };
              if (machineId && !context.externalActionCredential && !context.externalActionExecutionAuthorization) {
                try {
                  await check();
                  const { createCliConnectedServiceAction } = await import('@/session/actions/connectedServiceActionDeps');
                  const action = createCliConnectedServiceAction({ credentials, serverId, serverHttpBaseUrl,
                    ...(input.isCredentialCurrent ? { isCredentialCurrent: input.isCredentialCurrent } : {}),
                    resolveHeaders: (caller, actionId, read) => {
                      const authorization = resolveRequestHeaders({ context: caller, effectActionId: actionId, ...read });
                      return requireExternalActionHeaders(authorization);
                    },
                    callMachineAction: async request => {
                      await check();
                      const result = await callExactMachineRpc({ credentials, serverUrl: serverHttpBaseUrl,
                        ...request, requireCurrentMachine: true });
                      await check();
                      return result;
                    },
                  });
                  const value = ConnectedServicePoolSelectionGetResponseV1Schema.parse(await action({
                    actionId: 'connectedServices.pools.selection.get', input: { machineId, group: group.ref }, context,
                    ...(context.signal ? { signal: context.signal } : {}),
                  }));
                  await check();
                  selection = 'group' in value ? { status: 'available', machineId, value, asOfMs: value.observedAtMs }
                    : { status: value.code === 'unsupported' ? 'unsupported' : 'unknown', machineId, errorCode: value.code };
                } catch { selection = { status: 'unknown', machineId, errorCode: 'pool_selection_unavailable' }; }
              }
              return { group: group.ref, memberAccountIds: group.members.map(member => member.connectedAccountId),
                activeAccountId: group.activeConnectedAccountId, selection };
            })),
          })));
          const accounts = profile.connectedAccountsV4.filter(account => account.status !== 'needs_reauth');
          const periods = request.queries.filter(query => query.includeQuotaHistory)
            .map(query => resolveUsageQueryPeriod(query, accountingNowMs));
          const starts = periods.map(period => period.startMs ?? 0);
          const ends = periods.flatMap(period => period.endMs === undefined ? [] : [period.endMs]);
          const range = periods.length > 0 && starts.length === periods.length && ends.length === periods.length
            ? { startAtMs: Math.min(...starts), endAtMs: Math.max(...ends) } : undefined;
          const rows = await Promise.all(accounts.map(async account => {
            const source = { bindingKind: 'account' as const, ref: account.ref };
            // A finite snapshot retains the canonical page and its continuation,
            // rather than withholding current facts until history is exhausted.
            const history = range && range.endAtMs > range.startAtMs ? { range, pageSize: 100 } : undefined;
            const result = await readQuota({ source, ...(history ? { history } : {}) }, context);
            const asOfMs = !('ok' in result) && result.current && wasConnectedServiceQuotaObserved(result.current)
              ? result.current.fetchedAtMs : undefined;
            return { source, result, asOfMs };
          }));
          await check();
          quotaSources = rows.map(({ source, result, asOfMs }) => ({ source: `quota:${createCanonicalJsonSigningInput(source)}`,
            ...('ok' in result ? { status: result.errorCode === 'unsupported' ? 'unsupported' as const : 'error' as const,
              errorCode: result.errorCode ?? 'usage_quota_read_failed' }
              : { status: result.history?.nextCursor != null ? 'partial' as const : 'available' as const,
                ...(asOfMs === undefined ? {} : { asOfMs }) }),
          }));
          const values = rows.flatMap(({ result }) => 'ok' in result ? [] : [result]);
          const failures = rows.flatMap(({ result }) => 'ok' in result ? [result] : []);
          const times = rows.flatMap(row => row.asOfMs === undefined ? [] : [row.asOfMs]);
          quota = { status: failures.length ? values.length ? 'partial' : 'unknown'
            : values.some(row => row.history?.nextCursor != null) ? 'partial' : 'available',
            ...(failures.length ? { errorCode: failures[0]!.errorCode ?? 'usage_quota_read_failed' } : {}),
            ...(values.length || failures.length === 0 ? { value: values } : {}), ...(times.length ? { asOfMs: Math.min(...times) } : {}) };
        } catch (error) {
          const code = error instanceof Error && 'code' in error ? error.code : undefined;
          quota = { status: code === 'unsupported' ? 'unsupported' : 'unknown',
            errorCode: typeof code === 'string' ? code : 'usage_quota_read_failed' };
        }
        const { readCliUsageDetail } = await import('@/usage/readCliUsageDetail');
        if (context.signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
        if (input.isCredentialCurrent && !await input.isCredentialCurrent()) return retired();
        const accounting = snapshots.filter((snapshot): snapshot is UsageAccountingSourceSnapshot => !('ok' in snapshot));
        const detail = await readCliUsageDetail({ queries: request.queries.filter(query => query.includeAccounting && (query.includeSessionEvidence || query.includeWorkEvidence)),
          accounting, credentials, serverId, serverHttpBaseUrl, accountEncryptionMode,
          allowPrivateRead: !context.externalActionCredential && !context.externalActionExecutionAuthorization,
          nowMs: accountingNowMs, signal: context.signal, assertCurrent: check,
          resolveHeaders: request => {
            const authorization = resolveRequestHeaders({ context, effectActionId: 'usage.query', ...request });
            return requireExternalActionHeaders(authorization);
          },
        });
        await check();
        let mcpCatalog: McpServerCatalogSnapshotV1 | undefined;
        if (accountStorage && detail.howYouWork.some(row => row.detail.coach?.detail?.mcpUsage?.length)) {
          mcpCatalog = await loadMcpServerCatalogV1({ ...accountStorage, signal: context.signal,
            readRow: async () => McpServerCatalogRowReadResponseV1Schema.parse(await read(MCP_SERVER_CATALOG_ROWS_ROUTE_V1)) });
          await check();
        }
        const { bundledUsageModelPriceCatalog } = await import('@happier-dev/protocol/usage/usageModelPriceCatalog');
        const result = resolveUsagePageAggregation({ queries: request.queries, accountSettings, quota, pools, pricingOverrides, coachPreferences: preferences ?? null, nowMs: accountingNowMs,
          accounting, work: detail.work, howYouWork: detail.howYouWork,
          sources: [...quotaSources, { source: 'coach_preferences', status: preferences ? 'available' : 'unknown' },
            { source: 'pricing_overrides', status: pricingOverrides === undefined ? 'unknown' : 'available' }],
        }, bundledUsageModelPriceCatalog);
        const nowMs = accountingNowMs;
        return { ...result, results: result.results.map(slice => {
          if (!slice.coach) return slice;
          const evidence = detail.howYouWork.find(row => getUsageQueryKey(row.query) === slice.key)?.detail.coach;
          const admitted = admitUsageCoachRemedies(slice.coach, buildUsageCoachRemedies({ findings: slice.coach.findings,
            composition: evidence?.composition ?? [], mcpUsage: evidence?.detail?.mcpUsage,
            mcpCatalog, sessions: detail.sessions, serverId, accountId }));
          return { ...slice, coach: suppressionState ? applyUsageCoachPreferences(admitted, suppressionState, nowMs) : admitted };
        }) };
      },
    },
    projectWorkerAction: async ({ actionId, input: actionInput, context, signal }) => {
      const parsed = ProjectWorkerActionInputSchemasV1[actionId].parse(actionInput);
      const targetServerId = 'workspace' in parsed ? parsed.workspace.serverId : parsed.serverId;
      if (!await isServerProfileHomeIdentity(serverId, targetServerId)
        || await accountServerTargetMismatch(context)) {
        return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      }
      if (actionId === 'machines.worker.policy.get' || actionId === 'machines.worker.policy.set') {
        // The incumbent metadata socket has no external Action signing carrier.
        if (context.externalActionCredential) return externalTransportUnsupported(context);
        const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
        const client = await createAccountServerMachineFinitePolicyClient({
          machineId: ProjectWorkerActionInputSchemasV1[actionId].parse(actionInput).machineId,
          credentials: input.credentials?.token === input.token ? input.credentials : {token: input.token, encryption: null},
          serverHttpBaseUrl, signal,
          isCredentialCurrent: async () => lifetime === getActiveAccountSettingsSnapshotLifetimeToken()
            && (!input.isCredentialCurrent || await input.isCredentialCurrent()),
        });
        if (actionId === 'machines.worker.policy.get') return await client.get();
        const mutation = ProjectWorkerActionInputSchemasV1[actionId].parse(actionInput);
        return await client.set({expectedPolicy: mutation.expectedPolicy, expectedMetadataVersion: mutation.expectedMetadataVersion, policy: mutation.policy});
      }
      if (actionId !== 'projects.worker.preferences.get' && actionId !== 'projects.worker.preferences.set'
        && actionId !== 'projects.worker.preferences.reset' && actionId !== 'projects.service.placement.get'
        && actionId !== 'projects.service.placement.set') {
        return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
      }
      const lifetime = getActiveAccountSettingsSnapshotLifetimeToken();
      const isCurrent = async () => !signal?.aborted && lifetime === getActiveAccountSettingsSnapshotLifetimeToken()
        && (!input.isCredentialCurrent || await input.isCredentialCurrent());
      const client = await createAccountServerWorkspaceWorkerPreferenceClient({
        token: input.token, credentials: input.credentials, serverHttpBaseUrl, context, actionId, signal,
        isCredentialCurrent: input.isCredentialCurrent, onRequestIssued: input.onRequestIssued,
        resolveRequestHeaders: (request) => {
          const authorization = resolveRequestHeaders(request);
          return requireExternalActionHeaders(authorization);
        },
      });
      if (!client) return { status: 'unavailable' };
      if (actionId === 'projects.service.placement.get') {
        const request = ProjectWorkerActionInputSchemasV1[actionId].parse(actionInput);
        const desired = await client.getService(request);
        if (desired.status !== 'ready') return desired;
        const unavailable = (reasonCode: 'external_observation_unsupported' | 'observation_unavailable') => ({
          ...desired, actual: { status: 'unavailable' as const, reasonCode },
        });
        // Project-row discovery has no verified external-effect carrier. Never substitute
        // the daemon's Account credential for an externally authorized read principal.
        if (context.externalActionCredential || context.externalActionExecutionAuthorization) return unavailable('external_observation_unsupported');
        const credentials = input.credentials?.token === input.token ? input.credentials : { token: input.token, encryption: null };
        try {
          if (!await isCurrent()) return { status: 'unavailable' };
          const observation = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => readProjectAccountRowsObservation({
            credentials, serverId: targetServerId, signal, selection: { kinds: ['workspace-ref', 'relationship-graph'] },
          }));
          const rows = observation.snapshot;
          const machines = await listCurrentAccountMachines({ token: credentials.token, serverHttpBaseUrl, signal });
          const actual = await observeProjectServicePlacementActualV1({ ...request,
            workspaceRefs: rows.workspaceRefs, relationships: rows.relationships,
            childMachineProjections: machines.flatMap(machine => machine.devcontainerChild
              ? [{ serverId: targetServerId, machineId: machine.id, projection: machine.devcontainerChild }] : []),
            readChildMachines: async machineIds => {
              const localProfileId = configuration.activeServerId;
              const { readWorkspaceSyncChildMachineFacts } = await import('@/workspaces/sync/workspaceSyncTargetAuthority');
              return await readWorkspaceSyncChildMachineFacts({ serverId: targetServerId, serverHttpBaseUrl, localProfileId, credentials, signal,
                purpose: 'admitted_mapping', machineIds });
            },
            isCurrent: async () => await isCurrent() && await observation.isCurrent(),
            readSnapshot: snapshot => callExactMachineRpc({ credentials, serverUrl: serverHttpBaseUrl,
              machineId: snapshot.machineId, method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT,
              request: snapshot, requireCurrentMachine: true, signal }),
          });
          return await isCurrent() ? { ...desired, actual } : { status: 'unavailable' };
        } catch { return await isCurrent() ? unavailable('observation_unavailable') : { status: 'unavailable' }; }
      }
      if (actionId === 'projects.service.placement.set') return await client.setService(ProjectWorkerActionInputSchemasV1[actionId].parse(actionInput));
      if (actionId === 'projects.worker.preferences.get') return await client.get(ProjectWorkerActionInputSchemasV1[actionId].parse(actionInput));
      if (actionId === 'projects.worker.preferences.set') return await client.set(ProjectWorkerActionInputSchemasV1[actionId].parse(actionInput));
      if (actionId === 'projects.worker.preferences.reset') return await client.reset(ProjectWorkerActionInputSchemasV1[actionId].parse(actionInput));
      return { ok: false, errorCode: 'unsupported_action', error: 'unsupported_action' };
    },
    machineAccessAction: async ({ actionId, input: actionInput, context: actionContext, signal }) => {
      const target = MachineAccessPrepareKeysInputV1Schema.parse({
        serverId: actionInput && typeof actionInput === 'object' ? Reflect.get(actionInput, 'serverId') : undefined,
        machineId: actionInput && typeof actionInput === 'object' ? Reflect.get(actionInput, 'machineId') : undefined,
      });
      if (!await isServerProfileHomeIdentity(serverId, target.serverId) || await accountServerTargetMismatch(actionContext)) {
        return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      }
      if (signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      if (input.isCredentialCurrent && !await input.isCredentialCurrent()) {
        return { ok: false, errorCode: 'machine_access_stale_scope', error: 'machine_access_stale_scope' };
      }
      const prepareKeys = async () => {
        const { prepareMachineAccessKeyEnvelopes } = await import('@/api/machineAccessGrantEnvelopeHost');
        return await prepareMachineAccessKeyEnvelopes({
          credentials: input.credentials, serverHttpBaseUrl, ...target,
          ...(signal ? { signal } : {}), ...(input.isCredentialCurrent ? { isCredentialCurrent: input.isCredentialCurrent } : {}),
          ...(serverIdentityId ? { serverIdentityId } : {}),
          requestHeaders: (request) => {
            const headers = resolveRequestHeaders({ context: actionContext, effectActionId: actionId, ...request });
            if (!headers.ok) throw createAuthenticationHttpStatusError(401, 'Machine key preparation authority unavailable');
            return headers.headers;
          },
        });
      };
      if (actionId === 'machines.access.prepareKeys') return await prepareKeys();
      const spec = getActionSpec(actionId);
      const request = bindMachineAccessActionHttpRequestV1(actionId, actionInput);
      const requestHeaders = resolveRequestHeaders({ context: actionContext, effectActionId: actionId,
        method: request.method, path: request.path, ...(request.body === undefined ? {} : { body: request.body }) });
      if (!requestHeaders.ok) return externalActionHeaderRefusalFailure(requestHeaders);
      const dispatch = await dispatchAccountServerActionHttpRequest({ headers: requestHeaders.headers,
        method: request.method, path: request.path, ...(request.body === undefined ? {} : { body: request.body }),
        sideEffectClass: spec.sideEffectClass, ...(signal ? { signal } : {}) });
      if (!dispatch.ok) return dispatch;
      const { response } = dispatch;
      if (isAuthenticationStatus(response.status)) throw createAuthenticationHttpStatusError(response.status, 'Machine access Action authentication failed');
      if (response.status < 200 || response.status >= 300) {
        const refused = MachineAccessRefusalV1Schema.safeParse(response.data);
        if (refused.success) return refused.data;
        if ([404, 405, 501].includes(response.status)) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        throw createHttpStatusError(response.status, 'Machine access Action request failed');
      }
      if (actionId !== 'machines.access.grant.set') return spec.outputSchema!.parse(response.data);
      const output = MachineAccessMutationResultV1Schema.parse(response.data);
      if (!('kind' in output) || output.kind !== 'saved' || !output.canPrepareKeys) return output;
      // Permission already committed. A private continuation failure is not a
      // permission failure and must not invite a second grant mutation.
      const prepared = await prepareKeys().catch(() => null);
      if (prepared?.kind !== 'prepared') return output;
      // Current readiness remains server-derived after the protected continuation.
      const read = bindMachineAccessActionHttpRequestV1('machines.access.grants.list', target);
      const readHeaders = resolveRequestHeaders({ context: actionContext, effectActionId: actionId, method: read.method, path: read.path });
      if (!readHeaders.ok) return output;
      const refreshed = await dispatchAccountServerActionHttpRequest({ headers: readHeaders.headers, method: read.method, path: read.path,
        sideEffectClass: 'read', ...(signal ? { signal } : {}) });
      if (!refreshed.ok || refreshed.response.status !== 200) return output;
      const audience = MachineAccessGrantsListResultV1Schema.safeParse(refreshed.response.data);
      if (!audience.success || 'kind' in audience.data) return output;
      const row = audience.data.grants.find(grant => JSON.stringify(grant.principal) === JSON.stringify(output.grant.principal));
      return row ? { ...output, readiness: row.readiness, canPrepareKeys: row.audience.some(member => member.canPrepareKeys) } : output;
    },
    managedMachineAction: async ({ actionId, input: actionInput, context: actionContext, signal }) => {
      // The Action catalog owns Account placement, including cancellation and
      // setup decisions. Native effects retain the exact-controller adapter.
      const spec = getActionSpec(actionId);
      if (resolveActionExecutionPlacementForInput(spec, actionInput, actionContext.actionCaller, actionContext.surface ?? 'cli') !== 'account') {
        return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
      }
      const parsed = ManagedMachineActionInputSchemasV1[actionId].safeParse(actionInput);
      if (!parsed.success) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      const body = parsed.data;
      const homeId = 'selection' in body ? resolveManagedAcquireReviewV1(body).homeId : 'homeId' in body ? body.homeId : undefined;
      if (!homeId) return { ok: false, errorCode: 'invalid_parameters', error: 'invalid_parameters' };
      const unavailable = await qualifiedHomeActionFailure({ actionId, homeId, context: actionContext, signal });
      if (unavailable) return unavailable;
      if (actionId === 'machines.provisioners.list') {
        if (actionContext.externalActionCredential || actionContext.externalActionExecutionAuthorization) return externalTransportUnsupported(actionContext);
        const result = await executeCliManagedProvisionerList({
          value: ManagedMachineActionInputSchemasV1['machines.provisioners.list'].parse(body),
          credentials: input.credentials?.token === input.token ? input.credentials : { token: input.token, encryption: null },
          serverUrl: serverHttpBaseUrl, signal, homeDomainAction: deps.homeDomainAction!,
        });
        if (input.isCredentialCurrent && !await input.isCredentialCurrent())
          return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
        return result;
      }
      const post: Parameters<typeof executeCliManagedAccountPower>[0]['post'] = async (suffix, request, schema, requestSignal = signal) => {
        const path = `/v1/machines/managed/controller/${suffix}`;
        const headers = resolveRequestHeaders({ context: actionContext, effectActionId: actionId, method: 'POST', path, body: request });
        if (!headers.ok) throw new ManagedMachineControllerError('admission_unavailable');
        const dispatch = await dispatchAccountServerActionHttpRequest({ headers: headers.headers, method: 'POST', path, body: request,
          sideEffectClass: spec.sideEffectClass, ...(requestSignal ? { signal: requestSignal } : {}) });
        if (!dispatch.ok) throw new ManagedMachineControllerError(dispatch.errorCode ?? 'managed_request_failed');
        if (dispatch.response.status < 200 || dispatch.response.status >= 300) {
          const refusal = ManagedErrorV1Schema.safeParse(dispatch.response.data);
          throw Object.assign(new ManagedMachineControllerError(refusal.success ? refusal.data.code : 'managed_request_failed'),
            { status: dispatch.response.status });
        }
        return schema.parse(dispatch.response.data);
      };
      if (actionId === 'machines.managed.inspect' && 'managedId' in body && !('includeGuestDiagnostics' in body && body.includeGuestDiagnostics)) {
        const retained = await deps.managedMachineAction!({ actionId: 'machines.managed.get',
          input: { homeId, managedId: body.managedId }, context: actionContext, signal });
        const refusal = ActionExecuteFailureSchema.safeParse(retained);
        if (refusal.success) return refusal.data;
        const machine = unwrapManagedMachineReadV1(ManagedMachineActionOutputSchemasV1['machines.managed.get'].parse(retained));
        if (!machine.controller) {
          try {
            return await executeCliManagedAccountInspect({ machine, context: actionContext,
              credentials: input.credentials?.token === input.token ? input.credentials : { token: input.token, encryption: null },
              serverUrl: serverHttpBaseUrl, signal, post });
          } catch (error) {
            if (error instanceof ManagedMachineControllerError) return { ok: false, ...normalizeActionExecutorThrownError(error, actionId) };
            throw error;
          }
        }
      }
      if (actionId === MANAGED_RETIRE_ACTION_ID_V1) {
        try {
          const admitted = await post('admit-control', { action: actionId, input: body, requestId: actionContext.actionRequestId },
            ManagedAdmissionOutputV1Schema);
          if (!('presetContent' in admitted)) return admitted.machine;
          const recipientAccountId = readAccountIdFromToken(input.token);
          if (!recipientAccountId) throw new ManagedMachineControllerError('credential_unavailable');
          return { machine: admitted.machine, presetContent: projectManagedMachinePresetForRecipientV1({
            ...admitted.presetContent, recipientAccountId,
          }) };
        } catch (error) {
          if (error instanceof ManagedMachineControllerError) return { ok: false, ...normalizeActionExecutorThrownError(error, actionId) };
          throw error;
        }
      }
      if (isManagedControlAdmissionActionIdV1(actionId)) {
        try {
          const execution: Omit<Parameters<typeof executeCliManagedAccountPower>[0], 'body'> = {
            context: actionContext, credentials: input.credentials?.token === input.token ? input.credentials : { token: input.token, encryption: null },
            serverUrl: serverHttpBaseUrl, signal,
            post };
          return actionId === MANAGED_RESIZE_ACTION_ID_V1
            ? await executeCliManagedAccountResize({ ...execution, body: ManagedMachineActionInputSchemasV1[MANAGED_RESIZE_ACTION_ID_V1].parse(body) })
            : actionId === MANAGED_DELETE_ACTION_ID_V1
            ? await executeCliManagedAccountDelete({ ...execution, body: ManagedMachineActionInputSchemasV1[MANAGED_DELETE_ACTION_ID_V1].parse(body) })
            : await executeCliManagedAccountPower({ ...execution, body: ManagedMachineActionInputSchemasV1['machines.managed.power.set'].parse(body) });
        } catch (error) {
          if (error instanceof ManagedMachineControllerError) return { ok: false, ...normalizeActionExecutorThrownError(error, actionId) };
          throw error;
        }
      }
      const path = managedMachineActionEndpointPathV1(actionId);
      const homeBody = actionId === 'machines.managed.inspect' && 'managedId' in body
        ? { homeId, managedId: body.managedId } : body;
      const requestHeaders = resolveRequestHeaders({ context: actionContext, effectActionId: actionId, method: 'POST', path, body: homeBody });
      if (!requestHeaders.ok) return externalActionHeaderRefusalFailure(requestHeaders);
      const dispatch = await dispatchAccountServerActionHttpRequest({
        headers: requestHeaders.headers, method: 'POST', path, body: homeBody, sideEffectClass: spec.sideEffectClass,
        ...(signal ? { signal } : {}),
      });
      if (!dispatch.ok) return dispatch;
      if (input.isCredentialCurrent && !await input.isCredentialCurrent()) {
        return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
      }
      const { response } = dispatch;
      if (response.status < 200 || response.status >= 300) {
        const refusal = ManagedErrorV1Schema.safeParse(response.data);
        if (refusal.success) return { ok: false, errorCode: refusal.data.code, error: refusal.data.code };
        const confirmedRollback = readHomeDomainConfirmedRollbackV1(response.status, response.data);
        if (confirmedRollback) {
          return { ok: false, errorCode: confirmedRollback.code, error: confirmedRollback.code };
        }
        if (isAuthenticationStatus(response.status)) {
          throw createAuthenticationHttpStatusError(response.status, 'Managed Machine Action authentication failed');
        }
        if ([404, 405, 501].includes(response.status)) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        throw createHttpStatusError(response.status, 'Managed Machine Action request failed');
      }
      if (actionId === 'machines.managed.inspect' && 'includeGuestDiagnostics' in body && body.includeGuestDiagnostics) {
        const output = ManagedMachineActionOutputSchemasV1['machines.managed.inspect'].parse(response.data);
        let machine: ManagedMachineFullV1;
        if (isManagedOpaquePresetMachineV1(output.machine)) {
          const retained = await deps.managedMachineAction!({ actionId: 'machines.managed.get',
            input: { homeId, managedId: output.machine.id }, context: actionContext, signal });
          const refusal = ActionExecuteFailureSchema.safeParse(retained);
          if (refusal.success) return refusal.data;
          machine = await openManagedMachineRead({
            read: ManagedMachineActionOutputSchemasV1['machines.managed.get'].parse(retained),
            credentials: input.credentials?.token === input.token ? input.credentials : { token: input.token, encryption: null },
            serverHttpBaseUrl, signal });
        } else machine = output.machine;
        const guestDiagnostics = await readCliManagedAccountGuestDiagnostics({ machine, context: actionContext,
          credentials: input.credentials?.token === input.token ? input.credentials : { token: input.token, encryption: null },
          serverUrl: serverHttpBaseUrl, signal });
        return { ...output, guestDiagnostics };
      }
      return settleAccountServerActionHttpOutput({ data: response.data, outputSchema: ManagedMachineActionOutputSchemasV1[actionId], sideEffectClass: spec.sideEffectClass });
    },
    machinePresetArchive: async request => executeCliMachinePresetArchive(request, {
      credentials: input.credentials?.token === input.token ? input.credentials : { token: input.token, encryption: null },
      serverUrl: serverHttpBaseUrl, transport: deps.machinePresetAction!,
    }),
    machinePresetAction: async ({ actionId, input: actionInput, context: actionContext, signal }) => {
      const body = MachinePresetActionInputSchemasV1[actionId].parse(actionInput);
      const unavailable = await qualifiedHomeActionFailure({ actionId, homeId: body.homeId, context: actionContext, signal });
      if (unavailable) return unavailable;
      const path = machinePresetActionEndpointPathV1(actionId);
      const root = actionContext.externalActionExecutionAuthorization?.binding.actionId;
      const requestHeaders = resolveRequestHeaders({ context: actionContext,
        effectActionId: root === MACHINE_PRESET_ARCHIVE_ACTION_ID_V1 ? root : actionId, method: 'POST', path, body });
      if (!requestHeaders.ok) return externalActionHeaderRefusalFailure(requestHeaders);
      const sideEffectClass = getActionSpec(actionId).sideEffectClass;
      const dispatch = await dispatchAccountServerActionHttpRequest({
        headers: requestHeaders.headers, method: 'POST', path, body, sideEffectClass,
        ...(signal ? { signal } : {}),
      });
      if (!dispatch.ok) return dispatch;
      const { response } = dispatch;
      if (sideEffectClass === 'read' && input.isCredentialCurrent && !await input.isCredentialCurrent()) {
        return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
      }
      if (response.status < 200 || response.status >= 300) {
        const output = MachinePresetActionOutputSchemasV1[actionId].safeParse(response.data);
        if (output.success && (output.data.kind === 'conflict' || output.data.kind === 'refused')) return output.data;
        if (isAuthenticationStatus(response.status)) {
          throw createAuthenticationHttpStatusError(response.status, 'Machine preset Action authentication failed');
        }
        if ([404, 405, 501].includes(response.status)) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        throw createHttpStatusError(response.status, 'Machine preset Action request failed');
      }
      return settleAccountServerActionHttpOutput({ data: response.data, outputSchema: MachinePresetActionOutputSchemasV1[actionId], sideEffectClass });
    },
    machinePoolAction: async ({ actionId, input: actionInput, context: actionContext, signal }) => {
      const mismatch = await accountServerTargetMismatch(actionContext);
      if (mismatch) return mismatch;
      const path = machinePoolActionEndpointPathV1(actionId);
      const body = MachinePoolActionInputSchemasV1[actionId].parse(actionInput);
      const requestHeaders = resolveRequestHeaders({
        context: actionContext,
        effectActionId: actionId,
        method: 'POST',
        path,
        body,
      });
      if (!requestHeaders.ok) return externalActionHeaderRefusalFailure(requestHeaders);
      const dispatch = await dispatchAccountServerActionHttpRequest({
        headers: requestHeaders.headers,
        method: 'POST',
        path,
        body,
        ...(signal ? { signal } : {}),
        sideEffectClass: getActionSpec(actionId).sideEffectClass,
      });
      if (!dispatch.ok) return dispatch;
      const { response } = dispatch;
      if (isAuthenticationStatus(response.status)) {
        throw createAuthenticationHttpStatusError(response.status, `Authentication failed while executing Machine Pool Action (${response.status})`);
      }
      if (response.status >= 400) {
        const error = MachinePoolErrorV1Schema.safeParse(response.data);
        if (error.success) {
          return { ok: false, errorCode: error.data.code, error: error.data.code, details: error.data };
        }
        if (response.status === 404) {
          return {
            ok: false,
            errorCode: 'unsupported_action',
            error: `unsupported_action:${actionId}`,
          };
        }
        throw createHttpStatusError(response.status, `Failed to execute Machine Pool Action (${response.status})`);
      }
      const wire = settleAccountServerActionHttpOutput({
        data: response.data,
        outputSchema: MachinePoolWireOutputSchemasV1[actionId],
        sideEffectClass: getActionSpec(actionId).sideEffectClass,
      });
      if ('ok' in wire && wire.ok === false) return wire;
      if (!('pool' in wire) && !('pools' in wire)) return wire;
      const credentials = input.credentials?.token === input.token ? input.credentials : { token: input.token, encryption: null };
      const authorization = resolveRequestHeaders({ context: actionContext, effectActionId: actionId,
        method: 'GET', path: '/v1/account/encryption/currentness' });
      if (!authorization.ok) return externalActionHeaderRefusalFailure(authorization);
      const storage = await resolveCliAccountStorageContext({ credentials, serverBaseUrl: serverHttpBaseUrl,
        authorizationHeaders: authorization.headers, ...(signal ? { signal } : {}) });
      const accountKey = storage.mode === 'e2ee' ? deriveCliPrivateLabelAccountKey(storage.encryption) : null;
      try {
        const opened = await openMachinePoolActionOutputV1(wire, view => openCliMachinePoolPrivateView({
          view, accountContentEncryptionMode: storage.mode, ...(accountKey ? { accountKey } : {}),
        }));
        if (input.isCredentialCurrent && !await input.isCredentialCurrent()) {
          return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
        }
        signal?.throwIfAborted();
        return opened ?? { ok: false, errorCode: 'private_label_unavailable', error: 'private_label_unavailable' };
      } finally { accountKey?.fill(0); }
    },
    /**
     * The Home family over the Home this process is already bound to. The Action
     * input names Home-local ids only, so nothing here selects a Home; the
     * configured endpoint and the signed Account credential do, and the Home's
     * own transaction remains the authority for every governance decision.
     */
    homeDomainAction: async ({ actionId, input: actionInput, preparedRequest, context: actionContext, signal, archiveSession }) => {
      const mismatch = await accountServerTargetMismatch(actionContext);
      if (mismatch) return mismatch;
      if (isSessionSectionActionIdV1(actionId)) {
        const sectionCreateFolderId = actionId === 'session.sections.create' && actionContext.actionRequestId
          ? `folder_${createHash('sha256').update(`session.sections.create\0${actionContext.actionRequestId}`).digest('hex').slice(0, 32)}`
          : null;
        const assertCurrent = async () => {
          if (signal?.aborted || (input.isCredentialCurrent && !await input.isCredentialCurrent())) {
            throw Object.assign(new Error('action_account_scope_changed'), { code: 'action_account_scope_changed' });
          }
        };
        // Id-only assignment/removal has no private display to open or seal.
        // Capture Account mode/material once, only when this invocation needs it.
        let displayPromise: ReturnType<typeof captureSessionOrganizationDisplayHost> | undefined;
        const getDisplay = () => displayPromise ??= captureSessionOrganizationDisplayHost({
          token: input.token, credentials: input.credentials, serverHttpBaseUrl,
          isCurrent: input.isCredentialCurrent, ...(signal ? { signal } : {}),
        });
        const request = async <TSchema extends z.ZodMiniType>(method: string, path: string, schema: TSchema, body?: unknown): Promise<z.output<TSchema> | ActionExecuteFailure> => {
          await assertCurrent();
          const headers = resolveRequestHeaders({ context: actionContext, effectActionId: actionId, method, path,
            ...(body === undefined ? {} : { body }) });
          if (!headers.ok) return externalActionHeaderRefusalFailure(headers);
          const sideEffectClass = method === 'GET' ? 'read' : 'external';
          const dispatch = await dispatchAccountServerActionHttpRequest({ headers: headers.headers, method, path,
            ...(body === undefined ? {} : { body }), ...(signal ? { signal } : {}), sideEffectClass });
          if (!dispatch.ok) return dispatch;
          const { response } = dispatch;
          if (response.status >= 400) {
            const rollback = readHomeDomainConfirmedRollbackV1(response.status, response.data);
            if (rollback) return { ok: false, errorCode: rollback.code, error: rollback.code };
            const named = readHomeDomainActionErrorV1(response.data);
            if (named) return { ok: false, errorCode: named.code, error: named.code };
            const error = z.strictObject({ error: z.string() }).safeParse(response.data);
            if (error.success) return { ok: false, errorCode: error.data.error, error: error.data.error };
            if (isAuthenticationStatus(response.status)) throw createAuthenticationHttpStatusError(response.status, 'Section authentication failed');
            return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
          }
          if (method === 'GET') await assertCurrent();
          return settleAccountServerActionHttpOutput({ data: response.data, outputSchema: schema, sideEffectClass });
        };
        return executeSessionSectionActionV1(actionId, actionInput, {
          assertCurrent,
          allocateFolderId: () => sectionCreateFolderId ?? `folder_${randomUUID().replaceAll('-', '')}`,
          archiveSession,
          readSnapshot: async requested => {
            const parsed = SessionOrganizationSnapshotRequestSchema.parse(requested);
            const query = new URLSearchParams();
            for (const [key, value] of Object.entries(parsed)) {
              if (Array.isArray(value)) { if (value.length) query.set(key, value.join(',')); }
              else if (value !== undefined) query.set(key, String(value));
            }
            const result = await request('GET', `/v2/session-organization?${query}`, SessionOrganizationSnapshotResponseSchema);
            if ('ok' in result) return result;
            const folders = result.snapshot.folders.length
              ? result.snapshot.folders.map((await getDisplay()).openFolder) : [];
            return { folders, folderAssignments: result.snapshot.folderAssignments };
          },
          upsertFolder: async folder => {
            const display = await getDisplay();
            const result = await request('POST', '/v2/session-organization/folders', CreateOrUpdateSessionOrganizationFolderResponseSchema,
              display.prepareFolderInput(folder));
            return 'ok' in result ? result : display.openFolder(result.folder);
          },
          deleteFolder: folder => request('DELETE', `/v2/session-organization/folders/${encodeURIComponent(folder.folderId)}`,
            DeleteSessionOrganizationFolderResponseSchema, folder),
          setAssignment: (sessionId, folderId) => request('PUT', `/v2/session-organization/folder-assignments/${encodeURIComponent(sessionId)}`,
            SetSessionFolderAssignmentResponseSchema, { folderId }),
        });
      }
      // Assignment acknowledgements contain only ids, not private display
      // envelopes. Do not capture keys or project them as inventory snapshots.
      const hasOrganizationDisplay = actionId === 'session.tags.list'
        || actionId === 'session.tags.create' || actionId === 'session.tags.rename';
      const organizationDisplay = hasOrganizationDisplay ? await captureSessionOrganizationDisplayHost({
        token: input.token, credentials: input.credentials, serverHttpBaseUrl,
        isCurrent: input.isCredentialCurrent, ...(signal ? { signal } : {}),
      }) : null;
      const request = preparedRequest ? bindPublicProfilePreparedHttpRequestV1(actionId, preparedRequest)
        : bindHomeDomainActionHttpRequestV1(actionId,
          organizationDisplay ? organizationDisplay.prepareInput(actionId, actionInput) : actionInput);
      await organizationDisplay?.assertCurrent();
      if (input.isCredentialCurrent && !await input.isCredentialCurrent()) {
        return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
      }
      const requestHeaders = resolveRequestHeaders({
        context: actionContext,
        effectActionId: actionId,
        method: request.method,
        path: request.path,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      if (!requestHeaders.ok) return externalActionHeaderRefusalFailure(requestHeaders);
      const dispatch = await dispatchAccountServerActionHttpRequest({
        headers: requestHeaders.headers,
        method: request.method,
        path: request.path,
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(signal ? { signal } : {}),
        sideEffectClass: getActionSpec(actionId).sideEffectClass,
      });
      if (!dispatch.ok) return dispatch;
      // Reads require current custody before disclosure. A committed mutation's
      // acknowledgement remains true even if its original Account retires.
      if (getActionSpec(actionId).sideEffectClass === 'read'
        && input.isCredentialCurrent && !await input.isCredentialCurrent()) {
        return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
      }
      const { response } = dispatch;
      if (response.status >= 400) {
        // The Home completed the transaction and confirmed that every attempt
        // rolled back. This is a definite typed failure, never response-loss
        // ambiguity for the already-issued mutation.
        const confirmedRollback = readHomeDomainConfirmedRollbackV1(response.status, response.data);
        if (confirmedRollback) {
          return { ok: false, errorCode: confirmedRollback.code, error: confirmedRollback.code };
        }
        // A Home that named its refusal is answering, not failing — including a
        // 403 that carries a governance code, which is an authorization outcome
        // rather than a broken credential.
        const named = readHomeDomainActionErrorV1(response.data);
        if (named) {
          return { ok: false, errorCode: named.code, error: named.code, details: named.details };
        }
        if (isAuthenticationStatus(response.status)) {
          throw createAuthenticationHttpStatusError(
            response.status,
            `Authentication failed while executing Home Action (${response.status})`,
          );
        }
        // An older or feature-disabled Home has no such operation at all.
        if ([404, 405, 501].includes(response.status)) {
          return {
            ok: false,
            errorCode: 'unsupported_action',
            error: `unsupported_action:${actionId}`,
          };
        }
        throw createHttpStatusError(response.status, `Failed to execute Home Action (${response.status})`);
      }
      const settled = settleAccountServerActionHttpOutput({
        data: response.data,
        outputSchema: homeDomainActionOutputSchemaV1(actionId, preparedRequest),
        sideEffectClass: getActionSpec(actionId).sideEffectClass,
      });
      await organizationDisplay?.assertCurrent();
      if (organizationDisplay && !(settled !== null && typeof settled === 'object' && 'ok' in settled && settled.ok === false)) {
        return organizationDisplay.projectOutput(actionId, settled);
      }
      return settled;
    },
    sessionAccessAction: async ({ actionId, input: actionInput, context: actionContext, signal }) => {
      const mismatch = await accountServerTargetMismatch(actionContext);
      if (mismatch) return mismatch;
      const spec = getActionSpec(actionId);
      const mutation = spec.sideEffectClass !== 'none' && spec.sideEffectClass !== 'read';
      const publicRequest = bindSessionAccessActionHttpRequestV1(actionId, actionInput);
      let request = publicRequest;
      let localPublication: Awaited<ReturnType<typeof materializeSessionPublicLinkCreateBody>> | null = null;
      let retainedEnvelopeFallback = false;
      let repairActionId: 'session.access.layout.update' | undefined;
      if (actionId === 'session.public_link.create') {
        if (signal?.aborted) {
          return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
        }
        if (input.isCredentialCurrent) {
          let credentialCurrent = false;
          try {
            credentialCurrent = await input.isCredentialCurrent();
          } catch {
            credentialCurrent = false;
          }
          if (!credentialCurrent) {
            return { ok: false, errorCode: 'session_access_stale_scope', error: 'session_access_stale_scope' };
          }
        }
        try {
          const materialized = await materializeSessionPublicLinkCreateBody({
            token: input.token,
            credentials: input.credentials,
            serverHttpBaseUrl,
            input: actionInput,
            ...(input.isCredentialCurrent ? { isCurrent: input.isCredentialCurrent } : {}),
            ...(signal ? { signal } : {}),
          });
          localPublication = materialized;
          const baseBody = publicRequest.body !== null && typeof publicRequest.body === 'object'
            ? publicRequest.body as Readonly<Record<string, unknown>>
            : {};
          request = {
            ...publicRequest,
            body: {
              ...baseBody,
              lookupId: materialized.lookupId,
              keyDerivation: materialized.keyDerivation,
              ...(materialized.encryptedDataKey !== undefined ? { encryptedDataKey: materialized.encryptedDataKey } : {}),
            },
          };
        } catch (error) {
          if (signal?.aborted || axios.isCancel(error)) {
            return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
          }
          if (error instanceof SessionPublicLinkEnvelopeHostError) {
            if (error.code === 'cancelled') {
              return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
            }
            if (error.code === 'not_authenticated') {
              throw createAuthenticationHttpStatusError(401, 'Session public-link Action authentication failed');
            }
            return { ok: false, errorCode: error.code, error: error.code };
          }
          if (isAuthenticationError(error)) {
            throw createAuthenticationHttpStatusError(401, 'Session public-link Action authentication failed');
          }
          return {
            ok: false,
            errorCode: 'session_access_request_failed',
            error: 'session_access_request_failed',
          };
        }
        if (signal?.aborted) {
          return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
        }
        if (input.isCredentialCurrent) {
          let credentialCurrent = false;
          try {
            credentialCurrent = await input.isCredentialCurrent();
          } catch {
            credentialCurrent = false;
          }
          if (!credentialCurrent) {
            return { ok: false, errorCode: 'session_access_stale_scope', error: 'session_access_stale_scope' };
          }
        }
      }
      if (actionId === 'session.access.context.set' && input.credentials?.token === input.token) {
        const { sessionId, primaryTeamId } = SetSessionAccessContextRequestV1Schema.parse(actionInput);
        if (primaryTeamId !== null) {
          try {
            await recordSessionTeamShareStatement({ token: input.token, credentials: input.credentials,
              serverHttpBaseUrl, sessionId, teamId: primaryTeamId, ...(signal ? { signal } : {}) });
          } catch {
            // The statement never fails a share, so only cancellation reaches here.
            return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
          }
        }
      }
      if (actionId === 'session.access.grant.set') {
        try {
          let serverFeaturesSnapshot: CliServerFeaturesSnapshot | undefined;
          try {
            serverFeaturesSnapshot = await input.resolveServerFeaturesSnapshot?.();
          } catch {
            // Feature discovery failure must not widen an older or unknown Home.
            serverFeaturesSnapshot = undefined;
          }
          const materialized = await materializeSessionAccessGrantEnvelope({
            token: input.token,
            credentials: input.credentials,
            serverHttpBaseUrl,
            ...(serverFeaturesSnapshot ? { serverFeaturesSnapshot } : {}),
            input: actionInput,
            ...(input.isCredentialCurrent ? { isCurrent: input.isCredentialCurrent } : {}),
            ...(signal ? { signal } : {}),
          });
          const physicalInput = materialized.input;
          retainedEnvelopeFallback = materialized.retainedEnvelopeFallback;
          repairActionId = materialized.repairActionId;
          const accountEnvelopeInput = 'accountEnvelopeInput' in physicalInput
            ? physicalInput.accountEnvelopeInput
            : undefined;
          request = accountEnvelopeInput && publicRequest.body && typeof publicRequest.body === 'object'
            ? {
                ...publicRequest,
                body: {
                  ...publicRequest.body,
                  accountEnvelopeInput,
                },
              }
            : publicRequest;
        } catch (error) {
          if (signal?.aborted || axios.isCancel(error)) {
            return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
          }
          if (error instanceof SessionAccessGrantEnvelopeHostError) {
            return { ok: false, errorCode: error.code, error: error.code };
          }
          return {
            ok: false,
            errorCode: 'session_access_request_failed',
            error: 'session_access_request_failed',
          };
        }
      }
      if (actionId === 'session.access.grant.set' && input.isCredentialCurrent) {
        let credentialCurrent = false;
        try {
          credentialCurrent = await input.isCredentialCurrent();
        } catch {
          credentialCurrent = false;
        }
        if (!credentialCurrent) {
          return { ok: false, errorCode: 'session_access_stale_scope', error: 'session_access_stale_scope' };
        }
      }
      const requestHeaders = resolveRequestHeaders({
        context: actionContext,
        effectActionId: actionId,
        method: request.method,
        path: request.path,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      if (!requestHeaders.ok) return externalActionHeaderRefusalFailure(requestHeaders);
      const dispatch = await dispatchAccountServerActionHttpRequest({
        headers: requestHeaders.headers,
        method: request.method,
        path: request.path,
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(signal ? { signal } : {}),
        sideEffectClass: spec.sideEffectClass,
        ...(actionId === 'session.public_link.create' ? { replayAmbiguousOnce: true } : {}),
      });
      if (!dispatch.ok) return dispatch;
      const response = dispatch.response;
      if (response.status < 200 || response.status >= 300) {
        const confirmedRollback = readHomeDomainConfirmedRollbackV1(response.status, response.data);
        if (confirmedRollback) {
          return { ok: false, errorCode: confirmedRollback.code, error: confirmedRollback.code };
        }
        const body = response.data !== null && typeof response.data === 'object'
          ? response.data as Readonly<Record<string, unknown>>
          : null;
        const named = SessionAccessErrorCodeV1Schema.safeParse(body?.error);
        if (named.success) {
          const code = retainedEnvelopeFallback && named.data === 'recipient_envelope_required'
            ? 'session_data_key_unavailable'
            : named.data;
          if (code === 'session_data_key_unavailable' && repairActionId) {
            return { ok: false, errorCode: code, error:
              `${code}: this Session uses the legacy metadata layout. Run ${repairActionId} for it, then share again.` };
          }
          return { ok: false, errorCode: code, error: code };
        }
        if (actionId === 'session.public_link.remove' && response.status === 404 && body?.error === 'Share not found') {
          return spec.outputSchema?.parse({ changed: false }) ?? { changed: false };
        }
        if ([404, 405, 501].includes(response.status)) {
          return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
        }
        if (isAuthenticationStatus(response.status)) {
          throw createAuthenticationHttpStatusError(response.status, 'Session access Action authentication failed');
        }
        throw createHttpStatusError(response.status, 'Session access Action request failed');
      }
      try {
        if (actionId === 'session.public_link.remove') {
          PublicShareDeleteHttpResponseSchema.parse(response.data);
          return spec.outputSchema?.parse({ changed: true }) ?? { changed: true };
        }
        if (actionId === 'session.public_link.get' || actionId === 'session.public_link.create') {
          const projected = localPublication
            ? projectSessionPublicLinkCreateActionResultV1(response.data, localPublication,
                SessionPublicLinkCreateActionInputV1Schema.parse(actionInput).networkOff === true)
            : projectSessionPublicLinkActionResultV1(response.data);
          const result = spec.outputSchema?.parse(projected) ?? projected;
          if (localPublication && input.onPublicLinkIssued) {
            if (!projected || !('url' in projected) || typeof projected.url !== 'string') throw new Error('public_link_publication_unconfirmed');
            try {
              await input.onPublicLinkIssued({ lookupId: localPublication.lookupId, secret: localPublication.secret, shareId: projected.id,
                url: projected.url, audience: 'anonymous' });
            } catch {
              // Local publication notification failed after a valid Home
              // acknowledgement; do not misdiagnose it as a schema failure.
              return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' };
            }
            return projectSessionPublicLinkCreateActionResultV1(response.data, localPublication,
              SessionPublicLinkCreateActionInputV1Schema.parse(actionInput).networkOff === true, true);
          }
          return result;
        }
        return spec.outputSchema?.parse(response.data) ?? response.data;
      } catch (error) {
        if (!mutation) throw error;
        // A successful HTTP status proves that request bytes reached the Home,
        // but a malformed acknowledgement cannot prove whether its mutation
        // committed. Callers reconcile through the authoritative read owner;
        // this adapter neither retries nor fabricates an inverse operation.
        return accountHttpOutcomeUnknown('acknowledgement_schema');
      }
    },
    accountSessionsSignOutEverywhereAction: async ({ input: actionInput, context: actionContext, signal }) => {
      const targetMismatch = await accountServerTargetMismatch(actionContext);
      if (targetMismatch) {
        throw Object.assign(new Error(targetMismatch.error), { code: targetMismatch.errorCode });
      }
      const spec = getActionSpec('account.sessions.signOutEverywhere');
      const body = AccountSessionsSignOutEverywhereActionInputV1Schema.parse(actionInput);
      const requestHeaders = resolveRequestHeaders({
        context: actionContext,
        effectActionId: 'account.sessions.signOutEverywhere',
        method: 'POST',
        path: ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1,
        body,
      });
      if (!requestHeaders.ok) {
        throw createAuthenticationHttpStatusError(401, 'Sign-out-everywhere Action authentication failed');
      }
      const dispatch = await dispatchAccountServerActionHttpRequest({
        headers: requestHeaders.headers,
        method: 'POST',
        path: ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1,
        body,
        ...(signal ? { signal } : {}),
        sideEffectClass: spec.sideEffectClass,
      });
      if (!dispatch.ok) {
        throw Object.assign(new Error(dispatch.error), { code: dispatch.errorCode });
      }
      const { response } = dispatch;
      if (isAuthenticationStatus(response.status)) {
        throw createAuthenticationHttpStatusError(response.status, 'Sign-out-everywhere Action authentication failed');
      }
      if (response.status < 200 || response.status >= 300) {
        throw createHttpStatusError(response.status, `Failed to execute sign-out-everywhere Action (${response.status})`);
      }
      return AccountSessionsSignOutEverywhereServerOutputV1Schema.parse(response.data);
    },
    accountApiTokensCreateAction: async ({ input: actionInput, context: actionContext, signal }) => {
      const targetMismatch = await accountServerTargetMismatch(actionContext);
      if (targetMismatch) return targetMismatch;
      const spec = getActionSpec('account.apiTokens.create');
      let prepared;
      try { prepared = await prepareApiTokenBody('account.apiTokens.create', actionInput,
        signal ? { ...actionContext, signal } : actionContext); }
      catch (error) { const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'client_required';
        return { ok: false, errorCode: code, error: code }; }
      const { body } = prepared;
      const requestHeaders = resolveRequestHeaders({
        context: actionContext,
        effectActionId: 'account.apiTokens.create',
        method: 'POST',
        path: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
        body,
      });
      if (!requestHeaders.ok) return externalActionHeaderRefusalFailure(requestHeaders);
      await prepared.assertCurrent();
      const dispatch = await dispatchAccountServerActionHttpRequest({
        headers: requestHeaders.headers,
        method: 'POST',
        path: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
        body,
        ...(signal ? { signal } : {}),
        sideEffectClass: spec.sideEffectClass,
      });
      if (!dispatch.ok) return dispatch;
      const failure = readAccountApiTokenHttpFailure(dispatch.response);
      if (failure) return failure;
      return settleAccountServerActionHttpOutput({
        data: dispatch.response.data,
        outputSchema: AccountApiTokensCreateActionOutputV1Schema,
        sideEffectClass: spec.sideEffectClass,
      });
    },
    accountApiTokensUpdateAction: async ({ input: actionInput, context: actionContext, signal }) => {
      const targetMismatch = await accountServerTargetMismatch(actionContext);
      if (targetMismatch) return targetMismatch;
      const spec = getActionSpec('account.apiTokens.update');
      let prepared;
      try { prepared = await prepareApiTokenBody('account.apiTokens.update', actionInput,
        signal ? { ...actionContext, signal } : actionContext); }
      catch (error) { const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'client_required';
        return { ok: false, errorCode: code, error: code }; }
      const { body } = prepared;
      const requestHeaders = resolveRequestHeaders({
        context: actionContext,
        effectActionId: 'account.apiTokens.update',
        method: 'POST',
        path: ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1,
        body,
      });
      if (!requestHeaders.ok) return externalActionHeaderRefusalFailure(requestHeaders);
      await prepared.assertCurrent();
      const dispatch = await dispatchAccountServerActionHttpRequest({
        headers: requestHeaders.headers,
        method: 'POST',
        path: ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1,
        body,
        ...(signal ? { signal } : {}),
        sideEffectClass: spec.sideEffectClass,
      });
      if (!dispatch.ok) return dispatch;
      const failure = readAccountApiTokenHttpFailure(dispatch.response);
      if (failure) return failure;
      return settleAccountServerActionHttpOutput({
        data: dispatch.response.data,
        outputSchema: AccountApiTokensUpdateActionOutputV1Schema,
        sideEffectClass: spec.sideEffectClass,
      });
    },
    accountApiTokensListAction: async ({ input: actionInput, context: actionContext, signal }) => {
      const targetMismatch = await accountServerTargetMismatch(actionContext);
      if (targetMismatch) return targetMismatch;
      const spec = getActionSpec('account.apiTokens.list');
      const body = AccountApiTokensListActionInputV1Schema.parse(actionInput);
      const requestHeaders = resolveRequestHeaders({
        context: actionContext,
        effectActionId: 'account.apiTokens.list',
        method: 'POST',
        path: ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
        body,
      });
      if (!requestHeaders.ok) return externalActionHeaderRefusalFailure(requestHeaders);
      const dispatch = await dispatchAccountServerActionHttpRequest({
        headers: requestHeaders.headers,
        method: 'POST',
        path: ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1,
        body,
        ...(signal ? { signal } : {}),
        sideEffectClass: spec.sideEffectClass,
      });
      if (!dispatch.ok) return dispatch;
      const failure = readAccountApiTokenHttpFailure(dispatch.response);
      if (failure) return failure;
      return settleAccountServerActionHttpOutput({
        data: dispatch.response.data,
        outputSchema: AccountApiTokensListActionOutputV1Schema,
        sideEffectClass: spec.sideEffectClass,
      });
    },
    accountApiTokensRevokeAction: async ({ input: actionInput, context: actionContext, signal }) => {
      const targetMismatch = await accountServerTargetMismatch(actionContext);
      if (targetMismatch) return targetMismatch;
      const spec = getActionSpec('account.apiTokens.revoke');
      const body = AccountApiTokensRevokeActionInputV1Schema.parse(actionInput);
      const requestHeaders = resolveRequestHeaders({
        context: actionContext,
        effectActionId: 'account.apiTokens.revoke',
        method: 'POST',
        path: ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
        body,
      });
      if (!requestHeaders.ok) return externalActionHeaderRefusalFailure(requestHeaders);
      const dispatch = await dispatchAccountServerActionHttpRequest({
        headers: requestHeaders.headers,
        method: 'POST',
        path: ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1,
        body,
        ...(signal ? { signal } : {}),
        sideEffectClass: spec.sideEffectClass,
      });
      if (!dispatch.ok) return dispatch;
      const failure = readAccountApiTokenHttpFailure(dispatch.response);
      if (failure) return failure;
      return settleAccountServerActionHttpOutput({
        data: dispatch.response.data,
        outputSchema: AccountApiTokensRevokeActionOutputV1Schema,
        sideEffectClass: spec.sideEffectClass,
      });
    },
    accountApiTokensRevokeAllAction: async ({ input: actionInput, context: actionContext, signal }) => {
      const targetMismatch = await accountServerTargetMismatch(actionContext);
      if (targetMismatch) return targetMismatch;
      const spec = getActionSpec('account.apiTokens.revokeAll');
      const body = AccountApiTokensRevokeAllActionInputV1Schema.parse(actionInput);
      const requestHeaders = resolveRequestHeaders({
        context: actionContext,
        effectActionId: 'account.apiTokens.revokeAll',
        method: 'POST',
        path: ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1,
        body,
      });
      if (!requestHeaders.ok) return externalActionHeaderRefusalFailure(requestHeaders);
      const dispatch = await dispatchAccountServerActionHttpRequest({
        headers: requestHeaders.headers,
        method: 'POST',
        path: ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1,
        body,
        ...(signal ? { signal } : {}),
        sideEffectClass: spec.sideEffectClass,
      });
      if (!dispatch.ok) return dispatch;
      const failure = readAccountApiTokenHttpFailure(dispatch.response);
      if (failure) return failure;
      return settleAccountServerActionHttpOutput({
        data: dispatch.response.data,
        outputSchema: AccountApiTokensRevokeAllActionOutputV1Schema,
        sideEffectClass: spec.sideEffectClass,
      });
    },
    // Lane 02 Account Security family. One exact-Home binding (serverId +
    // endpoint + signed Account credential) serves all intents; the Home
    // transaction remains the authority for every governance decision.
    accountSecurityGetAction: async ({ context: actionContext, signal }) => {
      const targetMismatch = await accountServerTargetMismatch(actionContext);
      if (targetMismatch) return targetMismatch;
      const requestHeaders = resolveRequestHeaders({
        context: actionContext,
        effectActionId: 'account.security.get',
        method: 'GET',
        path: ACCOUNT_SECURITY_PATH_V1,
      });
      if (!requestHeaders.ok) return externalActionHeaderRefusalFailure(requestHeaders);
      return await executeAccountSecurityGet({
        headers: requestHeaders.headers,
        serverHttpBaseUrl,
        path: ACCOUNT_SECURITY_PATH_V1,
        outputSchema: AccountSecurityGetResponseV1Schema,
        ...(signal ? { signal } : {}),
      });
    },
    accountPasswordEnrollAction: async ({ input: actionInput, context: actionContext, signal }) => {
      const targetMismatch = await accountServerTargetMismatch(actionContext);
      if (targetMismatch) return targetMismatch;
      const body = AccountPasswordEnrollRequestV1Schema.parse(actionInput);
      const requestHeaders = resolveRequestHeaders({ context: actionContext, effectActionId: 'account.password.enroll', method: 'POST', path: ACCOUNT_PASSWORD_ENROLL_PATH_V1, body });
      if (!requestHeaders.ok) return externalActionHeaderRefusalFailure(requestHeaders);
      return await executeAccountSecurityAction({
        headers: requestHeaders.headers,
        serverHttpBaseUrl,
        path: ACCOUNT_PASSWORD_ENROLL_PATH_V1,
        input: body,
        inputSchema: AccountPasswordEnrollRequestV1Schema,
        outputSchema: AccountPasswordMutationResponseV1Schema,
        ...(signal ? { signal } : {}),
      });
    },
    accountPasswordChangeAction: async ({ input: actionInput, context: actionContext, signal }) => {
      const targetMismatch = await accountServerTargetMismatch(actionContext);
      if (targetMismatch) return targetMismatch;
      const body = AccountPasswordChangeRequestV1Schema.parse(actionInput);
      const requestHeaders = resolveRequestHeaders({ context: actionContext, effectActionId: 'account.password.change', method: 'POST', path: ACCOUNT_PASSWORD_CHANGE_PATH_V1, body });
      if (!requestHeaders.ok) return externalActionHeaderRefusalFailure(requestHeaders);
      return await executeAccountSecurityAction({
        headers: requestHeaders.headers,
        serverHttpBaseUrl,
        path: ACCOUNT_PASSWORD_CHANGE_PATH_V1,
        input: body,
        inputSchema: AccountPasswordChangeRequestV1Schema,
        outputSchema: AccountPasswordMutationResponseV1Schema,
        ...(signal ? { signal } : {}),
      });
    },
    accountPasswordRemoveAction: async ({ input: actionInput, context: actionContext, signal }) => {
      const targetMismatch = await accountServerTargetMismatch(actionContext);
      if (targetMismatch) return targetMismatch;
      const body = AccountPasswordRemoveRequestV1Schema.parse(actionInput);
      const requestHeaders = resolveRequestHeaders({ context: actionContext, effectActionId: 'account.password.remove', method: 'POST', path: ACCOUNT_PASSWORD_REMOVE_PATH_V1, body });
      if (!requestHeaders.ok) return externalActionHeaderRefusalFailure(requestHeaders);
      return await executeAccountSecurityAction({
        headers: requestHeaders.headers,
        serverHttpBaseUrl,
        path: ACCOUNT_PASSWORD_REMOVE_PATH_V1,
        input: body,
        inputSchema: AccountPasswordRemoveRequestV1Schema,
        outputSchema: AccountPasswordMutationResponseV1Schema,
        ...(signal ? { signal } : {}),
      });
    },
    accountEmailChangeRequestAction: async ({ input: actionInput, context: actionContext, signal }) => {
      const targetMismatch = await accountServerTargetMismatch(actionContext);
      if (targetMismatch) return targetMismatch;
      const body = AccountEmailChangeRequestV1Schema.parse(actionInput);
      const requestHeaders = resolveRequestHeaders({ context: actionContext, effectActionId: 'account.email.change.request', method: 'POST', path: ACCOUNT_EMAIL_CHANGE_REQUEST_PATH_V1, body });
      if (!requestHeaders.ok) return externalActionHeaderRefusalFailure(requestHeaders);
      return await executeAccountSecurityAction({
        headers: requestHeaders.headers,
        serverHttpBaseUrl,
        path: ACCOUNT_EMAIL_CHANGE_REQUEST_PATH_V1,
        input: body,
        inputSchema: AccountEmailChangeRequestV1Schema,
        outputSchema: AccountEmailChangeRequestResponseV1Schema,
        ...(signal ? { signal } : {}),
      });
    },
  };
  return { ...deps, publicProfileActions: bindPublicProfileActionPorts({
    homeDomainAction: deps.homeDomainAction!, usage: deps.usageActions, buildSnapshot: buildPublicProfileSnapshot,
    assertCurrent: async context => {
      context.signal?.throwIfAborted();
      const mismatch = await accountServerTargetMismatch(context);
      if (mismatch) throw Object.assign(new Error(mismatch.error), { code: mismatch.errorCode });
      if (input.isCredentialCurrent && !await input.isCredentialCurrent()) {
        throw Object.assign(new Error('credential_scope_retired'), { code: 'credential_scope_retired' });
      }
    },
    getRepository: async (selector, context) => {
      const { readScmHostingRepository } = await import('@/scm/hostingProviders/readRepository');
      return await readScmHostingRepository({ selector, signal: context.signal });
    },
  }) };
}
