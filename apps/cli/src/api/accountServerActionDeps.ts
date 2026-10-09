import axios, { type AxiosResponse } from 'axios';
import { ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1, AccountApiTokensServerErrorV1Schema, ACCOUNT_API_TOKENS_LIST_HTTP_PATH_V1, ACCOUNT_API_TOKENS_REVOKE_ALL_HTTP_PATH_V1, ACCOUNT_API_TOKENS_REVOKE_HTTP_PATH_V1, ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1, AccountApiTokensCreateActionInputV1Schema, AccountApiTokensCreateActionOutputV1Schema, AccountApiTokensListActionInputV1Schema, AccountApiTokensListActionOutputV1Schema, AccountApiTokensRevokeActionInputV1Schema, AccountApiTokensRevokeActionOutputV1Schema, AccountApiTokensRevokeAllActionInputV1Schema, AccountApiTokensRevokeAllActionOutputV1Schema, AccountApiTokensUpdateActionInputV1Schema, AccountApiTokensUpdateActionOutputV1Schema } from '@happier-dev/protocol/auth/accountApiTokens';
import { ProjectWorkerActionInputSchemasV1, type ActionExecuteFailure, type ActionExecutorDeps, type ActionExecutorContext, type ArtifactPublicLinkIssuedV1 } from '@happier-dev/protocol';
import { createAccountServerWorkspaceWorkerPreferenceClient } from '@/api/workspaces/workspaceWorkerPreferences';
import { observeProjectServicePlacementActualV1 } from '@happier-dev/protocol/workspaces/projectServicePlacementV1';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { getActiveProjectAccountRowsSnapshot, readProjectAccountRows } from '@/workspaces/projectAccountRows';
import { callExactMachineRpc } from '@/session/transport/rpc/machineRpc';
import { createAccountServerMachineFinitePolicyClient } from '@/api/machine/accountServerMachineFinitePolicyClient';
import { getActiveAccountSettingsSnapshotLifetimeToken } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { ACCOUNT_EMAIL_CHANGE_REQUEST_PATH_V1, ACCOUNT_PASSWORD_CHANGE_PATH_V1, ACCOUNT_PASSWORD_ENROLL_PATH_V1, ACCOUNT_PASSWORD_REMOVE_PATH_V1, ACCOUNT_SECURITY_PATH_V1, ACCOUNT_TERMINAL_PRESENT_USER_POLICY_PATH_V1, AccountEmailChangeRequestResponseV1Schema, AccountEmailChangeRequestV1Schema, AccountPasswordChangeRequestV1Schema, AccountPasswordEnrollRequestV1Schema, AccountPasswordMutationResponseV1Schema, AccountPasswordRemoveRequestV1Schema, AccountSecurityGetResponseV1Schema, AccountSecurityRouteErrorV1Schema, AccountTerminalPresentUserPolicySetRequestV1Schema, AccountTerminalPresentUserPolicySetResponseV1Schema } from '@happier-dev/protocol/auth/accountSecurity';
import { ACCOUNT_SESSIONS_SIGN_OUT_EVERYWHERE_HTTP_PATH_V1, AccountSessionsSignOutEverywhereActionInputV1Schema, AccountSessionsSignOutEverywhereServerOutputV1Schema } from '@happier-dev/protocol/auth/accountSessions';
import { bindHomeDomainActionHttpRequestV1, homeDomainActionOutputSchemaV1, readHomeDomainActionErrorV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { bindSessionAccessActionHttpRequestV1 } from '@happier-dev/protocol/actions/sessionAccessActionFamily';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { bindMachineAccessActionHttpRequestV1, MachineAccessGrantsListResultV1Schema, MachineAccessMutationResultV1Schema, MachineAccessPrepareKeysInputV1Schema, MachineAccessRefusalV1Schema } from '@happier-dev/protocol';
import { MachinePoolActionInputSchemasV1, MachinePoolActionOutputSchemasV1, machinePoolActionEndpointPathV1 } from '@happier-dev/protocol/machines/pools/actionsV1';
import { MachinePresetActionInputSchemasV1, MachinePresetActionOutputSchemasV1, machinePresetActionEndpointPathV1 } from '@happier-dev/protocol/machines/managed/machinePresetActionsV1';
import { normalizeServerIdentityIdCapability } from '@happier-dev/protocol/features/payload/capabilities/serverIdentityCapabilities';
import { MachinePoolErrorV1Schema } from '@happier-dev/protocol/machines/pools/v1';
import { projectSessionPublicLinkActionResultV1, projectSessionPublicLinkCreateActionResultV1 } from '@happier-dev/protocol/sessions/access/sessionAccessActionsV1';
import { SessionAccessErrorCodeV1Schema } from '@happier-dev/protocol/sessions/access/sessionAccessOperationsV1';
import { z } from 'zod';

import {
  createAuthenticationHttpStatusError,
  createHttpStatusError,
  isAuthenticationError,
  isAuthenticationStatus,
} from '@/api/client/httpStatusError';
import { resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { classifyActionTransportFailure } from '@/api/client/classifyServerEndpointError';
import { configuration } from '@/configuration';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import type { StoredCredentials } from '@/persistence';
import {
  materializeSessionAccessGrantEnvelope,
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

export type AccountServerActionDeps = Pick<
  ActionExecutorDeps,
  | 'accountSessionsSignOutEverywhereAction'
  | 'accountApiTokensCreateAction'
  | 'accountApiTokensUpdateAction'
  | 'accountApiTokensListAction'
  | 'accountApiTokensRevokeAction'
  | 'accountApiTokensRevokeAllAction'
  | 'accountSecurityGetAction'
  | 'accountSecurityTerminalPresentUserSetAction'
  | 'accountPasswordEnrollAction'
  | 'accountPasswordChangeAction'
  | 'accountPasswordRemoveAction'
  | 'accountEmailChangeRequestAction'
  | 'machinePoolAction'
  | 'machinePresetAction'
  | 'homeDomainAction'
  | 'sessionAccessAction'
  | 'machineAccessAction'
  | 'projectWorkerAction'
>;

type AccountServerActionFixedHome =
  | Readonly<{ serverId?: undefined; serverHttpBaseUrl?: undefined }>
  | Readonly<{ serverId: string; serverHttpBaseUrl: string }>;

type AccountServerActionParams<TInputSchema extends z.ZodType, TOutputSchema extends z.ZodType> = Readonly<{
  headers: Readonly<Record<string, string>>;
  path: string;
  input: z.input<TInputSchema>;
  inputSchema: TInputSchema;
  outputSchema: TOutputSchema;
  serverHttpBaseUrl?: string;
  signal?: AbortSignal;
}>;

const PublicShareDeleteHttpResponseSchema = z.object({
  success: z.literal(true),
}).loose();

async function executeAccountSecurityAction<TInputSchema extends z.ZodType, TOutputSchema extends z.ZodType>(
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

async function executeAccountSecurityGet<TOutputSchema extends z.ZodType>(
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
  const serverId = input.serverId ?? configuration.activeServerId;
  // Local routing/profile identity never substitutes for cryptographic Home
  // identity. External invocation authority compares only the explicit
  // serverIdentityId; ordinary daemon-bearer work does not consume it, so
  // supported ordinary V1 credentials are preserved while a missing
  // cryptographic identity fails closed instead of falling back to serverId.
  const serverIdentityId = input.serverIdentityId;
  const accountServerTargetMismatch = (actionContext: Readonly<{ serverId?: string | null }> | undefined): ActionExecuteFailure | null =>
    actionContext?.serverId && actionContext.serverId !== serverId
      ? { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' }
      : null;
  const externalAuthorizationUnavailable = (): ActionExecuteFailure => ({
    ok: false,
    errorCode: 'not_authenticated',
    error: 'not_authenticated',
  });
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
    const issueRequest = () => axios.request<unknown>({
      method: params.method,
      url: `${serverHttpBaseUrl}${params.path}`,
      ...(params.body === undefined ? {} : { data: params.body }),
      headers: { ...params.headers, 'Content-Type': 'application/json' },
      timeout: 15_000,
      ...(params.signal ? { signal: params.signal } : {}),
      validateStatus: () => true,
    });
    try {
      input.onRequestIssued?.();
      requestIssued = true;
      const response = await issueRequest();
      return { ok: true, response };
    } catch (error) {
      const cancelled = params.signal?.aborted === true || axios.isCancel(error);
      const failure = classifyActionTransportFailure(error, { mutation, requestIssued, cancelled });
      if (!failure) throw error;
      if (cancelled) return { ok: false, errorCode: failure, error: failure };
      if (failure === 'outcome_unknown') {
        if (params.replayAmbiguousOnce) {
          try {
            // Public-link POST is value-idempotent. This reuses the one
            // materialized body so bearer and ciphertext bytes stay exact.
            return { ok: true, response: await issueRequest() };
          } catch {
            return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' };
          }
        }
        return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' };
      }
      return { ok: false, errorCode: 'server_unreachable', error: 'server_unreachable' };
    }
  };
  const settleAccountServerActionHttpOutput = <TOutputSchema extends z.ZodType>(params: Readonly<{
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
      return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' };
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
  return {
    projectWorkerAction: async ({ actionId, input: actionInput, context, signal }) => {
      const parsed = ProjectWorkerActionInputSchemasV1[actionId].parse(actionInput);
      const targetServerId = 'workspace' in parsed ? parsed.workspace.serverId : parsed.serverId;
      if (targetServerId !== serverId || accountServerTargetMismatch(context)) {
        return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      }
      if (actionId === 'machines.worker.policy.get' || actionId === 'machines.worker.policy.set') {
        // The incumbent metadata socket has no external Action signing carrier.
        if (context.externalActionCredential) return externalAuthorizationUnavailable();
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
          return authorization.ok ? authorization.headers : null;
        },
      });
      if (!client) return { status: 'unavailable' };
      if (actionId === 'projects.service.placement.get') {
        const request = ProjectWorkerActionInputSchemasV1[actionId].parse(actionInput);
        const desired = await client.getService(request);
        if (desired.status !== 'ready') return desired;
        const unavailable = { ...desired, actual: { status: 'unavailable' as const } };
        // Project-row discovery has no verified external-effect carrier. Never substitute
        // the daemon's Account credential for an externally authorized read principal.
        if (context.externalActionCredential || context.externalActionExecutionAuthorization) return unavailable;
        const credentials = input.credentials?.token === input.token ? input.credentials : { token: input.token, encryption: null };
        try {
          if (!await isCurrent()) return { status: 'unavailable' };
          const rows = await runWithServerHttpBaseUrl(serverHttpBaseUrl, () => readProjectAccountRows({ credentials, serverId, signal }));
          const actual = await observeProjectServicePlacementActualV1({ ...request,
            workspaceRefs: rows.workspaceRefs, relationships: rows.relationships,
            isCurrent: async () => await isCurrent() && getActiveProjectAccountRowsSnapshot() === rows,
            readSnapshot: snapshot => callExactMachineRpc({ credentials, serverUrl: serverHttpBaseUrl,
              machineId: snapshot.machineId, method: RPC_METHODS.DAEMON_LOCAL_SERVICES_LAUNCHER_SNAPSHOT,
              request: snapshot, requireCurrentMachine: true, signal }),
          });
          return await isCurrent() ? { ...desired, actual } : { status: 'unavailable' };
        } catch { return await isCurrent() ? unavailable : { status: 'unavailable' }; }
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
      if (target.serverId !== serverId || accountServerTargetMismatch(actionContext)) {
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
      if (!requestHeaders.ok) return externalAuthorizationUnavailable();
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
      const output = actionId === 'machines.access.grants.list'
        ? MachineAccessGrantsListResultV1Schema.parse(response.data)
        : MachineAccessMutationResultV1Schema.parse(response.data);
      if (actionId !== 'machines.access.grant.set' || !('kind' in output) || output.kind !== 'saved' || output.readiness !== 'key_pending') return output;
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
      return row ? { ...output, readiness: row.readiness } : output;
    },
    machinePresetAction: async ({ actionId, input: actionInput, context: actionContext, signal }) => {
      const body = MachinePresetActionInputSchemasV1[actionId].parse(actionInput);
      const mismatch = accountServerTargetMismatch(actionContext);
      if (mismatch) return mismatch;
      if (signal?.aborted) return { ok: false, errorCode: 'cancelled', error: 'cancelled' };
      const snapshot = serverIdentityId ? undefined : await input.resolveServerFeaturesSnapshot?.();
      const homeIdentity = serverIdentityId ?? (snapshot?.status === 'ready' && snapshot.provenance === 'authenticated'
        ? normalizeServerIdentityIdCapability(snapshot.features.capabilities.serverIdentity?.serverIdentityId)
        : undefined);
      if (!homeIdentity) return { ok: false, errorCode: 'unsupported_action', error: `unsupported_action:${actionId}` };
      if (body.homeId !== homeIdentity) {
        return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      }
      if (input.isCredentialCurrent && !await input.isCredentialCurrent()) {
        return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
      }
      const path = machinePresetActionEndpointPathV1(actionId);
      const requestHeaders = resolveRequestHeaders({ context: actionContext, effectActionId: actionId, method: 'POST', path, body });
      if (!requestHeaders.ok) return externalAuthorizationUnavailable();
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
      if (actionContext?.serverId && actionContext.serverId !== serverId) {
        return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      }
      const path = machinePoolActionEndpointPathV1(actionId);
      const body = MachinePoolActionInputSchemasV1[actionId].parse(actionInput);
      const requestHeaders = resolveRequestHeaders({
        context: actionContext,
        effectActionId: actionId,
        method: 'POST',
        path,
        body,
      });
      if (!requestHeaders.ok) return externalAuthorizationUnavailable();
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
      return settleAccountServerActionHttpOutput({
        data: response.data,
        outputSchema: MachinePoolActionOutputSchemasV1[actionId],
        sideEffectClass: getActionSpec(actionId).sideEffectClass,
      });
    },
    /**
     * The Home family over the Home this process is already bound to. The Action
     * input names Home-local ids only, so nothing here selects a Home; the
     * configured endpoint and the signed Account credential do, and the Home's
     * own transaction remains the authority for every governance decision.
     */
    homeDomainAction: async ({ actionId, input: actionInput, context: actionContext, signal }) => {
      if (actionContext?.serverId && actionContext.serverId !== serverId) {
        return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      }
      const hasOrganizationDisplay = (actionId.startsWith('session.folders.') || actionId.startsWith('session.tags.'))
        && !actionId.endsWith('.delete');
      const organizationDisplay = hasOrganizationDisplay ? await captureSessionOrganizationDisplayHost({
        token: input.token, credentials: input.credentials, serverHttpBaseUrl,
        isCurrent: input.isCredentialCurrent, ...(signal ? { signal } : {}),
      }) : null;
      const request = bindHomeDomainActionHttpRequestV1(actionId,
        organizationDisplay ? organizationDisplay.prepareInput(actionId, actionInput) : actionInput);
      await organizationDisplay?.assertCurrent();
      const requestHeaders = resolveRequestHeaders({
        context: actionContext,
        effectActionId: actionId,
        method: request.method,
        path: request.path,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      if (!requestHeaders.ok) return externalAuthorizationUnavailable();
      const dispatch = await dispatchAccountServerActionHttpRequest({
        headers: requestHeaders.headers,
        method: request.method,
        path: request.path,
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(signal ? { signal } : {}),
        sideEffectClass: getActionSpec(actionId).sideEffectClass,
      });
      if (!dispatch.ok) return dispatch;
      const { response } = dispatch;
      if (response.status >= 400) {
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
        outputSchema: homeDomainActionOutputSchemaV1(actionId),
        sideEffectClass: getActionSpec(actionId).sideEffectClass,
      });
      await organizationDisplay?.assertCurrent();
      if (organizationDisplay && !(settled !== null && typeof settled === 'object' && 'ok' in settled && settled.ok === false)) {
        return organizationDisplay.projectOutput(actionId, settled);
      }
      return settled;
    },
    sessionAccessAction: async ({ actionId, input: actionInput, context: actionContext, signal }) => {
      if (actionContext?.serverId && actionContext.serverId !== serverId) {
        return { ok: false, errorCode: 'server_target_mismatch', error: 'server_target_mismatch' };
      }
      const spec = getActionSpec(actionId);
      const mutation = spec.sideEffectClass !== 'none' && spec.sideEffectClass !== 'read';
      const publicRequest = bindSessionAccessActionHttpRequestV1(actionId, actionInput);
      let request = publicRequest;
      let localPublication: Awaited<ReturnType<typeof materializeSessionPublicLinkCreateBody>> | null = null;
      let retainedEnvelopeFallback = false;
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
      if (!requestHeaders.ok) return externalAuthorizationUnavailable();
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
        const body = response.data !== null && typeof response.data === 'object'
          ? response.data as Readonly<Record<string, unknown>>
          : null;
        const named = SessionAccessErrorCodeV1Schema.safeParse(body?.error);
        if (named.success) {
          const code = retainedEnvelopeFallback && named.data === 'recipient_envelope_required'
            ? 'session_data_key_unavailable'
            : named.data;
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
            ? projectSessionPublicLinkCreateActionResultV1(response.data, localPublication)
            : projectSessionPublicLinkActionResultV1(response.data);
          const result = spec.outputSchema?.parse(projected) ?? projected;
          if (localPublication && input.onPublicLinkIssued) {
            if (!projected || !('url' in projected) || typeof projected.url !== 'string') throw new Error('public_link_publication_unconfirmed');
            await input.onPublicLinkIssued({ lookupId: localPublication.lookupId, secret: localPublication.secret, shareId: projected.id,
              url: projected.url });
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
        return { ok: false, errorCode: 'outcome_unknown', error: 'outcome_unknown' };
      }
    },
    accountSessionsSignOutEverywhereAction: async ({ input: actionInput, context: actionContext, signal }) => {
      const targetMismatch = accountServerTargetMismatch(actionContext);
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
      const targetMismatch = accountServerTargetMismatch(actionContext);
      if (targetMismatch) return targetMismatch;
      const spec = getActionSpec('account.apiTokens.create');
      const body = AccountApiTokensCreateActionInputV1Schema.parse(actionInput);
      const requestHeaders = resolveRequestHeaders({
        context: actionContext,
        effectActionId: 'account.apiTokens.create',
        method: 'POST',
        path: ACCOUNT_API_TOKENS_CREATE_HTTP_PATH_V1,
        body,
      });
      if (!requestHeaders.ok) return externalAuthorizationUnavailable();
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
      const targetMismatch = accountServerTargetMismatch(actionContext);
      if (targetMismatch) return targetMismatch;
      const spec = getActionSpec('account.apiTokens.update');
      const body = AccountApiTokensUpdateActionInputV1Schema.parse(actionInput);
      const requestHeaders = resolveRequestHeaders({
        context: actionContext,
        effectActionId: 'account.apiTokens.update',
        method: 'POST',
        path: ACCOUNT_API_TOKENS_UPDATE_HTTP_PATH_V1,
        body,
      });
      if (!requestHeaders.ok) return externalAuthorizationUnavailable();
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
      const targetMismatch = accountServerTargetMismatch(actionContext);
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
      if (!requestHeaders.ok) return externalAuthorizationUnavailable();
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
      const targetMismatch = accountServerTargetMismatch(actionContext);
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
      if (!requestHeaders.ok) return externalAuthorizationUnavailable();
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
      const targetMismatch = accountServerTargetMismatch(actionContext);
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
      if (!requestHeaders.ok) return externalAuthorizationUnavailable();
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
      const targetMismatch = accountServerTargetMismatch(actionContext);
      if (targetMismatch) return targetMismatch;
      const requestHeaders = resolveRequestHeaders({
        context: actionContext,
        effectActionId: 'account.security.get',
        method: 'GET',
        path: ACCOUNT_SECURITY_PATH_V1,
      });
      if (!requestHeaders.ok) return externalAuthorizationUnavailable();
      return await executeAccountSecurityGet({
        headers: requestHeaders.headers,
        serverHttpBaseUrl,
        path: ACCOUNT_SECURITY_PATH_V1,
        outputSchema: AccountSecurityGetResponseV1Schema,
        ...(signal ? { signal } : {}),
      });
    },
    accountSecurityTerminalPresentUserSetAction: async ({ input: actionInput, context: actionContext, signal }) => {
      const targetMismatch = accountServerTargetMismatch(actionContext);
      if (targetMismatch) return targetMismatch;
      const body = AccountTerminalPresentUserPolicySetRequestV1Schema.parse(actionInput);
      const requestHeaders = resolveRequestHeaders({
        context: actionContext,
        effectActionId: 'account.security.terminalPresentUser.set',
        method: 'POST',
        path: ACCOUNT_TERMINAL_PRESENT_USER_POLICY_PATH_V1,
        body,
      });
      if (!requestHeaders.ok) return externalAuthorizationUnavailable();
      return await executeAccountSecurityAction({
        headers: requestHeaders.headers,
        serverHttpBaseUrl,
        path: ACCOUNT_TERMINAL_PRESENT_USER_POLICY_PATH_V1,
        input: body,
        inputSchema: AccountTerminalPresentUserPolicySetRequestV1Schema,
        outputSchema: AccountTerminalPresentUserPolicySetResponseV1Schema,
        ...(signal ? { signal } : {}),
      });
    },
    accountPasswordEnrollAction: async ({ input: actionInput, context: actionContext, signal }) => {
      const targetMismatch = accountServerTargetMismatch(actionContext);
      if (targetMismatch) return targetMismatch;
      const body = AccountPasswordEnrollRequestV1Schema.parse(actionInput);
      const requestHeaders = resolveRequestHeaders({ context: actionContext, effectActionId: 'account.password.enroll', method: 'POST', path: ACCOUNT_PASSWORD_ENROLL_PATH_V1, body });
      if (!requestHeaders.ok) return externalAuthorizationUnavailable();
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
      const targetMismatch = accountServerTargetMismatch(actionContext);
      if (targetMismatch) return targetMismatch;
      const body = AccountPasswordChangeRequestV1Schema.parse(actionInput);
      const requestHeaders = resolveRequestHeaders({ context: actionContext, effectActionId: 'account.password.change', method: 'POST', path: ACCOUNT_PASSWORD_CHANGE_PATH_V1, body });
      if (!requestHeaders.ok) return externalAuthorizationUnavailable();
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
      const targetMismatch = accountServerTargetMismatch(actionContext);
      if (targetMismatch) return targetMismatch;
      const body = AccountPasswordRemoveRequestV1Schema.parse(actionInput);
      const requestHeaders = resolveRequestHeaders({ context: actionContext, effectActionId: 'account.password.remove', method: 'POST', path: ACCOUNT_PASSWORD_REMOVE_PATH_V1, body });
      if (!requestHeaders.ok) return externalAuthorizationUnavailable();
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
      const targetMismatch = accountServerTargetMismatch(actionContext);
      if (targetMismatch) return targetMismatch;
      const body = AccountEmailChangeRequestV1Schema.parse(actionInput);
      const requestHeaders = resolveRequestHeaders({ context: actionContext, effectActionId: 'account.email.change.request', method: 'POST', path: ACCOUNT_EMAIL_CHANGE_REQUEST_PATH_V1, body });
      if (!requestHeaders.ok) return externalAuthorizationUnavailable();
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
}
