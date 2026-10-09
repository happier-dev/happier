import axios from 'axios';
import { randomBytes } from 'node:crypto';

import { EXTERNAL_ACTION_EFFECT_ACTION_HEADER, EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, EXTERNAL_ACTION_RESOLVED_TARGET_HEADER, ExternalActionActionIdV1Schema, ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationVerifyResponseV1Schema, ExternalActionRequestEnvelopeSchema, externalActionTargetsEqualV1, bindExternalActionExecutionAuthorizationHttpPathV1, bindExternalActionExecutionAuthorizationVerifyHttpPathV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1, encodeExternalActionResolvedTargetV1, signExternalActionMachineRequestV1, signExternalActionMachineRpcRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import type { ActionExecutorContext, ExternalActionExecutionAuthorizationV1, ExternalActionMachineRpcExecutionV1, ExternalActionRequestEnvelope, ExternalActionTargetV1 } from '@happier-dev/protocol';
import type { ActionRequiredAuthority } from '@happier-dev/protocol/actions/metadata';
import { SOCKET_RPC_EVENTS, SessionActionRpcOriginV1Schema, type WorkspaceSyncSourceWriterTargetRoutingV1 } from '@happier-dev/protocol/socketRpc';
import { signMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1, ExternalActionExecutionAuthorizationRequestV1Schema, ExternalActionHttpErrorSchema, ExternalActionResponseEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { openExternalActionResponseV2, sealExternalActionRequestV2, type ExternalActionEncryptionBindingV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { projectApiTokenSessionSpawnAdmissionV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { AccountScopedCryptoMaterial } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { SessionSpawnNewInputV2Schema, type SessionSpawnNewInputV2 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import type { ActionExecuteResult } from '@happier-dev/protocol';
import type { ExternalActionExecutionAuthorizationRequestV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { assertResolvedHomeTargetIdentity } from '@happier-dev/cli-common/homeTarget';
import { resolveCliHomeTarget } from '@/server/homeTarget';
import { normalizeServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { readAuthTokenProvenance } from '@happier-dev/protocol/auth/authToken';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { decodeJwtPayload, readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import { readAccountEncryptionModeOnce } from '@/api/client/accountEncryptionMode';
import { listCurrentAccountMachines, type CurrentAccountMachineInventoryItem } from '@/api/machine/resolveCurrentAccountMachineTarget';
import { requireAccountEncryptionCredentials } from '@/api/client/encryptionKey';
import type { StoredCredentials } from '@/persistence';
import { ExternalActionSignedAuthenticationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { AUTHORITY_CEILING_HEADER_V1, resolveInvocationAuthority } from '@happier-dev/protocol/actions/invocationAuthority';
import { z } from 'zod';
import { ExternalActionMachineBootstrapV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { decodeBase64, encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { projectRequesterSessionCredentialDisclosure, sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { encodeStoredCredentials } from '@/persistence';
import { PROJECT_FINITE_ACTION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/projectActionFamily';
import type { ManagedWakeTargetV1 } from '@happier-dev/protocol/machines/managed/managedIntentV1';
import { MachineEnvironmentApplyInputV1Schema, type MachineEnvironmentApplyInputV1 } from '@happier-dev/protocol/machines/managed/actionsV1';

export type ExternalActionMachineRequestSigningKey = string | Uint8Array;

/** Schema-checked provenance projection only; Home still verifies the issued root and current principal. */
export function resolveExternalActionRootInvocationAuthority(authorization: ExternalActionExecutionAuthorizationV1): ActionRequiredAuthority {
  const binding = authorization.binding;
  const credential = binding.sessionActionOrigin || binding.workflowActionOrigin ? 'agent'
    : 'authentication' in binding ? binding.authentication.kind : 'api_token';
  return resolveInvocationAuthority({ credential, surface: 'rpc' });
}

/**
 * The device-local profile id routes a request to one Home, while the observed
 * stable identity binds Home-issued authorization. They are deliberately
 * independent because a profile id is not cryptographic identity evidence.
 */
export type ExternalActionHomeBinding = Readonly<{
  serverId?: string;
  serverIdentityId?: string;
  externalActionMachineRequestPrivateKey?: ExternalActionMachineRequestSigningKey;
  externalActionMachineInstallationId?: string;
}>;

type OriginalAccountActionInput = Readonly<{
  actionId: string;
  input: unknown;
  requestId: string;
  target: Extract<ExternalActionTargetV1, { kind: 'machine' }>;
  credentials: StoredCredentials;
  serverHttpBaseUrl: string;
  serverIdentityId?: string;
  authority?: ActionExecutorContext['authority'];
  /** A human confidentiality decision, distinct from the target Action's Ask first policy. */
  onRequesterSessionCredentialDisclosure?: (disclosure: ReturnType<typeof projectRequesterSessionCredentialDisclosure>) => boolean | void | Promise<boolean | void>;
  isCurrent?: () => boolean | Promise<boolean>;
  signal?: AbortSignal;
}>;

/** A positively observed own target retains the caller's incumbent daemon path. */
/** These finite receivers require an exact installed-Machine proof even for
 * an original requester's own target; no local bearer bridge can replace it. */
export function requiresOriginalAccountMachineActionProof(actionId: string): boolean {
  return Object.hasOwn(PROJECT_FINITE_ACTION_RPC_METHODS_V1, actionId) || actionId === 'machines.environment.apply';
}

export function dispatchOriginalAccountAction(input: OriginalAccountActionInput & Readonly<{ foreignTargetOnly: true }>): Promise<ActionExecuteResult | null>;
export function dispatchOriginalAccountAction(input: OriginalAccountActionInput): Promise<ActionExecuteResult>;
/** Original Account/terminal delivery enters Home before a retained guest can accept it.
 * Session and installed receivers use their incumbent signed/direct transport.
 */
export async function dispatchOriginalAccountAction(input: OriginalAccountActionInput & Readonly<{ foreignTargetOnly?: true }>): Promise<ActionExecuteResult | null> {
  const fail = (errorCode: string): ActionExecuteResult => ({ ok: false, errorCode, error: errorCode });
  input.signal?.throwIfAborted();
  const claims = decodeJwtPayload(input.credentials.token);
  const provenance = readAuthTokenProvenance(claims, { allowLegacyHome: false });
  const accountId = readAccountIdFromToken(input.credentials.token);
  const homeUrl = normalizeServerHttpBaseUrl(input.serverHttpBaseUrl);
  const requiresMachineProof = requiresOriginalAccountMachineActionProof(input.actionId);
  const isCurrent = async () => !input.signal?.aborted && (!input.isCurrent || await input.isCurrent());
  if (!await isCurrent()) return fail('target_unavailable');
  // This branch only chooses the incumbent own-account path. Home still owns
  // authentication and the destination owns its Action admission.
  let machines: Awaited<ReturnType<typeof listCurrentAccountMachines>> | undefined;
  if (input.foreignTargetOnly) {
    machines = await listCurrentAccountMachines({ token: input.credentials.token, serverHttpBaseUrl: homeUrl,
      ...(input.signal ? { signal: input.signal } : {}) });
    if (!await isCurrent()) return fail('target_unavailable');
    const own = machines.find(row => row.id === input.target.machineId);
    const ordinary = readAuthTokenProvenance(claims, { allowLegacyHome: true });
    if (!requiresMachineProof && ordinary?.provenance.kind === 'account'
      && ordinary.provenance.authority === 'present_user' && input.authority !== 'account_automation'
      && accountId && own?.access?.custodian.accountId === accountId) return null;
  }
  const extras = claims && typeof claims.extras === 'object' && claims.extras !== null && !Array.isArray(claims.extras)
    ? claims.extras as Readonly<Record<string, unknown>> : {};
  const kind = provenance?.provenance.kind;
  const authentication = ExternalActionSignedAuthenticationV1Schema.safeParse({ kind, tokenEpoch: claims?.tokenEpoch ?? extras.tokenEpoch });
  if (!accountId || !authentication.success
    || !((kind === 'account' && provenance?.provenance.authority === 'present_user')
      || (kind === 'terminal' && provenance?.provenance.authority === 'account_automation'))) return fail('admission_unavailable');
  const headers = { Authorization: `Bearer ${input.credentials.token}`, 'Content-Type': 'application/json',
    ...(kind === 'terminal' || input.authority === 'account_automation'
      ? { [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' } : {}) };
  const mode = await readAccountEncryptionModeOnce({ request: () => axios.get<unknown>(`${homeUrl}/v1/account/encryption`, {
    headers, ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true,
  }) });
  if (mode.kind !== 'resolved') return fail('content_unavailable');
  machines ??= await listCurrentAccountMachines({ token: input.credentials.token, serverHttpBaseUrl: homeUrl,
    ...(input.signal ? { signal: input.signal } : {}) });
  const machine = machines.find(row => row.id === input.target.machineId);
  // Offline remains a retained target; current Home admission still decides
  // whether the requested Action can reach this installation.
  if (!machine || machine.kind !== 'persistent' || machine.revokedAt !== null || machine.replacedByMachineId !== null
    || !machine.access || machine.access.accessState !== 'ready') return fail('admission_unavailable');
  if (!await isCurrent()) return fail('target_unavailable');
  const foreign = machine.access.custodian.accountId !== accountId;
  if (!foreign && machine.access.resourceMode !== mode.mode) return fail('admission_unavailable');
  if (foreign && ((kind !== 'account' && kind !== 'terminal') || kind === 'account' && input.authority === 'account_automation'
    || input.credentials.credentialProvenance === 'api_token')) return fail('requester_account_material_unavailable');
  let material: Extract<AccountScopedCryptoMaterial, { type: 'dataKey' }> | undefined;
  if (mode.mode === 'e2ee') {
    if (!input.serverIdentityId) return fail('admission_unavailable');
    try {
      const keyed = requireAccountEncryptionCredentials(input.credentials).encryption;
      material = { type: 'dataKey', machineKey: keyed.type === 'dataKey'
        ? keyed.machineKey : deriveAccountMachineKeyFromRecoverySecret(keyed.secret) };
    } catch { return fail('content_unavailable'); }
  }
  const actionId = ExternalActionActionIdV1Schema.parse(input.actionId);
  const binding = material ? { serverIdentityId: input.serverIdentityId!, accountId, authentication: authentication.data,
    actionId, requestId: input.requestId, target: input.target } satisfies ExternalActionEncryptionBindingV2 : undefined;
  const envelope = binding && material ? sealExternalActionRequestV2({ binding, material, input: input.input, randomBytes })
    : ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: input.requestId, target: input.target, input: input.input });
  let body: unknown = envelope;
  if (foreign || requiresMachineProof) {
    if (!input.serverIdentityId) return fail('admission_unavailable');
    if (foreign && !input.onRequesterSessionCredentialDisclosure) return fail('requester_credential_disclosure_required');
    const readInstalledMachine = async (observed: CurrentAccountMachineInventoryItem) => {
      const publication = await axios.get<unknown>(`${homeUrl}/v1/machines/${encodeURIComponent(observed.id)}`, {
        headers, ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true,
      });
      const raw = publication.data && typeof publication.data === 'object' && 'machine' in publication.data
        ? publication.data.machine : null;
      const installed = ExternalActionMachineBootstrapV1Schema.extend({
        installationPublicKey: z.string().base64().nullish(),
      }).passthrough().safeParse(raw);
      if (publication.status < 200 || publication.status >= 300 || !installed.success || !installed.data.installationId
        || installed.data.id !== observed.id || installed.data.kind !== 'persistent' || installed.data.revokedAt !== null
        || installed.data.replacedByMachineId !== null || installed.data.access?.accessState !== 'ready'
        || installed.data.access.custodian.accountId !== observed.access?.custodian.accountId
        || installed.data.access.resourceMode !== observed.access?.resourceMode || !await isCurrent()) return null;
      return installed.data;
    };
    const installed = await readInstalledMachine(machine);
    if (!installed) return fail('admission_unavailable');
    const minted = await mintExternalActionExecutionAuthorization({ actionId, envelope, machineId: machine.id,
      pat: input.credentials.token, serverHttpBaseUrl: homeUrl, ...(input.signal ? { signal: input.signal } : {}) });
    if (!minted.ok) return fail(minted.code);
    const root = minted.authorization.binding;
    if (!('authentication' in root) || root.authentication.kind !== authentication.data.kind
      || root.authentication.tokenEpoch !== authentication.data.tokenEpoch || root.accountId !== accountId
      || root.custodianAccountId !== machine.access.custodian.accountId || root.serverIdentityId !== input.serverIdentityId
      || root.machineId !== machine.id || root.installationId !== installed.installationId
      || root.accountEncryptionMode !== mode.mode || root.actionId !== actionId || root.requestId !== input.requestId
      || root.requestEnvelopeDigest !== computeExternalActionRequestEnvelopeDigestV1(envelope)
      || !externalActionTargetsEqualV1(root.target, input.target) || root.sessionActionOrigin || root.sessionActionSource
      || root.workflowActionOrigin || root.managedContinuation || root.handoffContinuation
      || !await isCurrent()) return fail('admission_unavailable');
    const confirmDisclosure = async (recipient: CurrentAccountMachineInventoryItem): Promise<ActionExecuteResult | null> => {
      if (kind === 'account' && input.authority === 'account_automation'
        || input.credentials.credentialProvenance === 'api_token') return fail('requester_account_material_unavailable');
      if (!input.onRequesterSessionCredentialDisclosure) return fail('requester_credential_disclosure_required');
      if (mode.mode === 'plain' && input.credentials.encryption !== null) return fail('content_unavailable');
      let confirmed: boolean | void;
      try {
        confirmed = await input.onRequesterSessionCredentialDisclosure(projectRequesterSessionCredentialDisclosure({
          disposition: 'ordinary_requester', accountId, machineId: recipient.id,
          ...(recipient.access ? { custodian: recipient.access.custodian } : {}),
        }));
      } catch { return fail(input.signal?.aborted ? 'cancelled' : 'requester_credential_disclosure_declined'); }
      if (confirmed !== true) return fail('requester_credential_disclosure_declined');
      return await isCurrent() ? null : fail(input.signal?.aborted ? 'cancelled' : 'target_unavailable');
    };
    let authorization = minted.authorization;
    try {
      if (foreign) {
        if (!installed.installationPublicKey) return fail('admission_unavailable');
        const refusal = await confirmDisclosure(machine);
        if (refusal) return refusal;
        authorization = sealExternalActionRequesterAccountContextV1({ authorization,
          credentials: { ...encodeStoredCredentials(input.credentials), token: input.credentials.token }, purpose: { kind: 'external_action' },
          installationPublicKey: decodeBase64(installed.installationPublicKey), randomBytes });
      }
      const wake = authorization.managedFiniteWake;
      if (wake) {
        const controller = machines.find(row => row.id === wake.target.controller.machineId);
        if (!controller || controller.kind !== 'persistent' || controller.revokedAt !== null
          || controller.replacedByMachineId !== null || controller.access?.accessState !== 'ready') return fail('admission_unavailable');
        const installedController = await readInstalledMachine(controller);
        if (!installedController?.installationPublicKey
          || installedController.installationId !== wake.target.controller.installationId) return fail('admission_unavailable');
        const controllerKey = decodeBase64(installedController.installationPublicKey, 'base64');
        if (encodeBase64(controllerKey, 'base64url') !== wake.installationPublicKey) return fail('admission_unavailable');
        if (controller.access.custodian.accountId !== accountId) {
          const refusal = await confirmDisclosure(controller);
          if (refusal) return refusal;
          authorization = sealExternalActionRequesterAccountContextV1({ authorization,
            credentials: { ...encodeStoredCredentials(input.credentials), token: input.credentials.token }, purpose: { kind: 'managed_finite_wake', target: wake.target },
            installationPublicKey: controllerKey, randomBytes });
        }
      }
      body = ExternalActionExecutionAuthorizationRequestV1Schema.parse({ v: 1, machineId: machine.id, envelope,
        executionAuthorization: authorization });
    } catch { return fail('content_unavailable'); }
  }
  input.signal?.throwIfAborted();
  if (!await isCurrent()) return fail('target_unavailable');
  try {
    const response = await axios.post<unknown>(`${homeUrl}${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${actionId}`, body, {
      headers, ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true,
    });
    // A received operation receipt remains true even when observation retired.
    if (response.status < 200 || response.status >= 300) {
      const refusal = ExternalActionHttpErrorSchema.safeParse(response.data);
      if (envelope.v === 2 && refusal.success && 'requestId' in refusal.data && refusal.data.requestId !== envelope.requestId) return fail('invalid_action_output');
      return fail(refusal.success ? 'code' in refusal.data ? refusal.data.code : refusal.data.error : 'project_transport_unavailable');
    }
    if (envelope.v === 2 && material && binding) return openExternalActionResponseV2({ envelope: response.data,
      binding, request: envelope, material }) ?? fail('invalid_action_output');
    const parsed = ExternalActionResponseEnvelopeV1Schema.safeParse(response.data);
    return parsed.success && parsed.data.actionId === actionId && parsed.data.requestId === envelope.requestId
      ? parsed.data.execution : fail('invalid_action_output');
  } catch { return fail('outcome_unknown'); }
}

export function createExternalActionMachineRpcExecution(input: Readonly<{
  context: ActionExecutorContext | undefined;
  effectActionId: string;
  installationId: string;
  method: string;
  requestId?: string;
  params?: unknown;
  workspaceSyncSourceWriterTargetRouting?: WorkspaceSyncSourceWriterTargetRoutingV1;
  privateKey: ExternalActionMachineRequestSigningKey;
}>): ExternalActionMachineRpcExecutionV1 | null {
  const authorization = input.context?.externalActionExecutionAuthorization;
  const target = input.context?.externalActionTarget;
  if (!authorization || !target || !input.requestId) return null;
  const effectActionId = ExternalActionActionIdV1Schema.parse(input.effectActionId);
  return {
    v: 1,
    authorization,
    effectActionId,
    target,
    installationId: input.installationId,
    machineSignature: signExternalActionMachineRpcRequestV1({
      authorizationToken: authorization.token,
      effectActionId,
      target,
      installationId: input.installationId,
      event: SOCKET_RPC_EVENTS.CALL,
      method: input.method,
      requestId: input.requestId,
      ...(input.params === undefined ? {} : { params: input.params }),
      ...(input.workspaceSyncSourceWriterTargetRouting ? { workspaceSyncSourceWriterTargetRouting: input.workspaceSyncSourceWriterTargetRouting } : {}),
      privateKey: input.privateKey,
    }),
  };
}

/**
 * Original Session or exact handoff custody may forward its Home-admitted request.
 * This uses the source key, while the signed bytes still name the actual
 * destination installation. It is never a destination-signature fallback.
 */
export function readExternalActionSourceMachineRpcSigner(
  authorization: ExternalActionExecutionAuthorizationV1,
): Readonly<{ machineId: string; installationId: string }> | null {
  const parsed = ExternalActionExecutionAuthorizationV1Schema.safeParse(authorization);
  if (!parsed.success) return null;
  const binding = parsed.data.binding;
  if ('authentication' in binding && binding.sessionActionOrigin && binding.sessionActionSource) {
    return binding.sessionActionSource;
  }
  const admission = binding.handoffAdmission;
  if (!binding.handoffContinuation || !admission
    || !(binding.machineId === admission.sourceMachineId && binding.installationId === admission.sourceInstallationId
      || binding.machineId === admission.targetMachineId && binding.installationId === admission.targetInstallationId)) return null;
  return { machineId: admission.sourceMachineId, installationId: admission.sourceInstallationId };
}

export function createExternalActionSourceMachineRpcExecution(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  effectActionId: string;
  target: ExternalActionTargetV1;
  sourceMachineId: string;
  sourceInstallationId: string;
  method: string;
  requestId?: string;
  params?: unknown;
  privateKey: ExternalActionMachineRequestSigningKey;
}>): ExternalActionMachineRpcExecutionV1 | null {
  const parsed = ExternalActionExecutionAuthorizationV1Schema.safeParse(input.authorization);
  if (!parsed.success) return null;
  const binding = parsed.data.binding;
  const source = readExternalActionSourceMachineRpcSigner(parsed.data);
  if (!source || source.machineId !== input.sourceMachineId
    || source.installationId !== input.sourceInstallationId
    || input.target.kind !== 'machine' || binding.machineId !== input.target.machineId
    || !externalActionTargetsEqualV1(binding.target, input.target)
    || !input.method.startsWith(`${binding.machineId}:`)) return null;
  return createExternalActionMachineRpcExecution({
    context: { surface: 'rpc', externalActionExecutionAuthorization: input.authorization, externalActionTarget: input.target },
    effectActionId: input.effectActionId,
    installationId: binding.installationId,
    method: input.method,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    ...(input.params === undefined ? {} : { params: input.params }),
    privateKey: input.privateKey,
  });
}

type ExternalActionAuthorizationHttpFailure = Readonly<{
  ok: false;
  code: 'invalid_token' | 'auth_unavailable' | 'server_unavailable';
}>;

export type ExternalActionAuthorizationHttpResult =
  | Readonly<{ ok: true; authorization: ExternalActionExecutionAuthorizationV1 }>
  | ExternalActionAuthorizationHttpFailure;

export function createExternalActionAuthorizedRequestHeaders(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  effectActionId: string;
  target: ExternalActionTargetV1;
  installationId: string;
  method: string;
  path: string;
  body?: unknown;
  privateKey: ExternalActionMachineRequestSigningKey;
}>): Readonly<Record<string, string>> {
  return {
    [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: input.authorization.token,
    [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: input.effectActionId,
    [EXTERNAL_ACTION_RESOLVED_TARGET_HEADER]: encodeExternalActionResolvedTargetV1(input.target),
    [EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER]: signExternalActionMachineRequestV1({
      authorizationToken: input.authorization.token,
      effectActionId: input.effectActionId,
      target: input.target,
      installationId: input.installationId,
      requestId: input.authorization.binding.requestId,
      method: input.method,
      path: input.path,
      ...(input.body === undefined ? {} : { body: input.body }),
      privateKey: input.privateKey,
    }),
  };
}

/** Attach HTTP-only requester ports to the incumbent, Home-proved carrier. */
export async function projectExternalActionRequesterHttpAuthorization(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  serverId: string;
  serverIdentityId: string;
  serverHttpBaseUrl: string;
  target: ExternalActionTargetV1;
  installationId: string;
  privateKey: ExternalActionMachineRequestSigningKey;
  isCurrent?: () => Promise<boolean>;
  signal?: AbortSignal;
}>): Promise<ExternalActionExecutionAuthorizationV1 | null> {
  const parsed = ExternalActionExecutionAuthorizationV1Schema.safeParse(input.authorization);
  if (!parsed.success || parsed.data.binding.serverIdentityId !== input.serverIdentityId
    || parsed.data.binding.installationId !== input.installationId
    || !input.serverId || !input.serverHttpBaseUrl) return null;
  const authorization: ExternalActionExecutionAuthorizationV1 = { ...parsed.data };
  const requesterAccountProjection = input.authorization.requesterAccountProjection;
  if (requesterAccountProjection && (requesterAccountProjection.accountId !== authorization.binding.accountId
    || requesterAccountProjection.serverId !== input.serverId)) return null;
  const locallyCurrent = async (signal?: AbortSignal): Promise<boolean> => {
    try {
      if (input.signal?.aborted || signal?.aborted) return false;
      const current = input.isCurrent ? await input.isCurrent() : true;
      if (!current || input.signal?.aborted || signal?.aborted) return false;
      const accountCurrent = !requesterAccountProjection
        || await requesterAccountProjection.isCurrent();
      return accountCurrent && !input.signal?.aborted && !signal?.aborted;
    } catch {
      return false;
    }
  };
  const isCurrent = async (signal?: AbortSignal): Promise<boolean> => {
    if (!await locallyCurrent(signal)) return false;
    const current = await verifyExternalActionExecutionAuthorizationCurrent({
      authorization,
      effectActionId: authorization.binding.actionId,
      target: input.target,
      installationId: input.installationId,
      privateKey: input.privateKey,
      serverHttpBaseUrl: input.serverHttpBaseUrl,
      ...(signal ?? input.signal ? { signal: signal ?? input.signal } : {}),
    }).catch(() => false);
    return current && await locallyCurrent(signal);
  };
  if (!await isCurrent()) return null;
  if (requesterAccountProjection) {
    Object.defineProperty(authorization, 'requesterAccountProjection', {
      value: requesterAccountProjection, enumerable: false,
    });
  }
  const requesterHttpProjection: NonNullable<ExternalActionExecutionAuthorizationV1['requesterHttpProjection']> = {
    accountId: authorization.binding.accountId,
    serverId: input.serverId,
    serverIdentityId: input.serverIdentityId,
    serverHttpBaseUrl: input.serverHttpBaseUrl,
    ...(authorization.binding.accountEncryptionMode
      ? { accountEncryptionMode: authorization.binding.accountEncryptionMode } : {}),
    isCurrent,
    createRequestHeaders: async (request) => {
      if (!await isCurrent(request.signal)) return null;
      const headers = createExternalActionAuthorizedRequestHeaders({
        authorization, effectActionId: request.effectActionId, target: input.target,
        installationId: input.installationId, privateKey: input.privateKey,
        method: request.method, path: request.path,
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      return await isCurrent(request.signal) ? headers : null;
    },
  };
  Object.defineProperty(authorization, 'requesterHttpProjection', {
    value: Object.freeze(requesterHttpProjection), enumerable: false,
  });
  return Object.freeze(authorization);
}

/** Prepare an original Account invocation; only Home's minted binding admits it. */
export async function prepareExternalActionRequesterAccountAuthorization(input: Readonly<{
  actionId: string;
  input: unknown;
  requestId: string;
  target: ExternalActionTargetV1;
  machineId: string;
  /** Account id and mode obtained from this authenticated Home's profile. */
  accountId: string;
  accountEncryptionMode: 'plain' | 'e2ee';
  /** Unverified associated-data candidate, never an authentication decision. */
  tokenEpochHint: number;
  token: string;
  /** Only the incumbent authenticated Session host supplies this origin. */
  sessionActionOrigin?: ExternalActionExecutionAuthorizationRequestV1['sessionActionOrigin'];
  workflowActionOrigin?: ExternalActionExecutionAuthorizationRequestV1['workflowActionOrigin'];
  /** Exact incumbent Session host, independently of the destination Machine. */
  sourceMachineId?: string;
  /** Accepted managed Session work rechecks current origin policy, not an ended turn. */
  isContinuationCurrent?: (authorization: ExternalActionExecutionAuthorizationV1) => Promise<boolean>;
  material?: Extract<AccountScopedCryptoMaterial, Readonly<{ type: 'dataKey' }>>;
  serverId: string;
  serverIdentityId: string;
  serverHttpBaseUrl: string;
  installationId: string;
  privateKey: ExternalActionMachineRequestSigningKey;
  isCurrent?: () => Promise<boolean>;
  signal?: AbortSignal;
}>): Promise<ExternalActionExecutionAuthorizationV1 | null> {
  const isCurrent = async (): Promise<boolean> => {
    try {
      if (input.signal?.aborted) return false;
      const current = input.isCurrent ? await input.isCurrent() : true;
      return current && !input.signal?.aborted;
    } catch { return false; }
  };
  if (!await isCurrent()) return null;
  let actionId: string;
  let authenticationKind: 'account' | 'terminal';
  let envelope: ExternalActionRequestEnvelope;
  let sessionActionOrigin: ExternalActionExecutionAuthorizationRequestV1['sessionActionOrigin'];
  try {
    actionId = ExternalActionActionIdV1Schema.parse(input.actionId);
    sessionActionOrigin = input.sessionActionOrigin === undefined ? undefined
      : SessionActionRpcOriginV1Schema.parse(input.sessionActionOrigin);
    if (sessionActionOrigin && sessionActionOrigin.requestId !== input.requestId) return null;
    if (sessionActionOrigin && !input.sourceMachineId?.trim()) return null;
    const provenance = readAuthTokenProvenance(decodeJwtPayload(input.token), { allowLegacyHome: false });
    if (provenance?.provenance.kind === 'account' && provenance.provenance.authority === 'present_user') authenticationKind = 'account';
    else if (provenance?.provenance.kind === 'terminal' && provenance.provenance.authority === 'account_automation') authenticationKind = 'terminal';
    else return null;
    const authentication = ExternalActionSignedAuthenticationV1Schema.parse({ kind: authenticationKind, tokenEpoch: input.tokenEpochHint });
    if (!Number.isSafeInteger(authentication.tokenEpoch)) return null;
    if (input.accountEncryptionMode === 'e2ee') {
      if (!input.material) return null;
      envelope = sealExternalActionRequestV2({
        binding: { serverIdentityId: input.serverIdentityId, accountId: input.accountId, authentication,
          actionId, requestId: input.requestId, target: input.target },
        input: input.input, material: input.material, randomBytes,
        ...(actionId === 'session.spawn_new'
          ? { sessionSpawnAdmission: projectApiTokenSessionSpawnAdmissionV1(SessionSpawnNewInputV2Schema.parse(input.input)) }
          : {}),
      });
    } else {
      envelope = ExternalActionRequestEnvelopeSchema.parse({
        v: 1, requestId: input.requestId, target: input.target, input: input.input,
      });
    }
  } catch { return null; }
  if (!await isCurrent()) return null;
  const minted = await mintExternalActionExecutionAuthorization({
    actionId, envelope, machineId: input.machineId, pat: input.token,
    serverHttpBaseUrl: input.serverHttpBaseUrl,
    ...(sessionActionOrigin ? { sessionActionOrigin,
      sessionActionSource: { machineId: input.sourceMachineId!, installationId: input.installationId },
      installationProof: signMachineInstallationProof({
      payload: { version: 1, machineId: input.sourceMachineId!, installationId: input.installationId, accountId: input.accountId,
        externalActionOrigin: { homeId: input.serverIdentityId, actionId, requestId: input.requestId,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin: sessionActionOrigin } },
      privateKey: input.privateKey,
    }) } : {}),
    ...(input.workflowActionOrigin ? { workflowActionOrigin: input.workflowActionOrigin,
      installationProof: signMachineInstallationProof({
        payload: { version: 1, machineId: input.machineId, installationId: input.installationId, accountId: input.accountId,
          externalActionOrigin: { homeId: input.serverIdentityId, actionId, requestId: input.requestId,
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), origin: input.workflowActionOrigin } },
        privateKey: input.privateKey,
      }) } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!minted.ok || !await isCurrent()) return null;
  const binding = minted.authorization.binding;
  if (!('authentication' in binding)
    || binding.accountId !== input.accountId
    || binding.authentication.kind !== authenticationKind
    || binding.authentication.tokenEpoch !== input.tokenEpochHint
    || binding.accountEncryptionMode !== input.accountEncryptionMode
    || binding.serverIdentityId !== input.serverIdentityId
    || (!sessionActionOrigin || input.sourceMachineId === input.machineId) && binding.installationId !== input.installationId
    || binding.machineId !== input.machineId
    || binding.actionId !== actionId
    || binding.requestId !== input.requestId
    || binding.requestEnvelopeDigest !== computeExternalActionRequestEnvelopeDigestV1(envelope)
    || !sameStrictJsonValue(binding.sessionActionOrigin, sessionActionOrigin)
    || !sameStrictJsonValue(binding.workflowActionOrigin, input.workflowActionOrigin)
    || !sameStrictJsonValue(binding.sessionActionSource, sessionActionOrigin
      ? { machineId: input.sourceMachineId, installationId: input.installationId } : undefined)
    || !externalActionTargetsEqualV1(binding.target, input.target)) return null;
  // The destination daemon owns HTTP effect signatures. A remote source only
  // forwards the same Home proof; it must not impersonate the destination signer.
  if (sessionActionOrigin && input.sourceMachineId !== input.machineId) return Object.freeze(minted.authorization);
  const continuationChecker = input.isContinuationCurrent;
  const continuationCurrent = sessionActionOrigin && continuationChecker
    ? async () => await continuationChecker(minted.authorization)
    : isCurrent;
  return await projectExternalActionRequesterHttpAuthorization({
    authorization: minted.authorization,
    serverId: input.serverId, serverIdentityId: input.serverIdentityId,
    serverHttpBaseUrl: input.serverHttpBaseUrl, target: input.target,
    installationId: input.installationId, privateKey: input.privateKey, isCurrent: continuationCurrent,
    ...(input.signal ? { signal: input.signal } : {}),
  });
}

export function resolveExternalActionServerRequestHeaders(input: Readonly<{
  context: ActionExecutorContext | undefined;
  effectActionId: string;
  method: string;
  path: string;
  body?: unknown;
  daemonToken: string;
  serverIdentityId?: string;
  privateKey?: ExternalActionMachineRequestSigningKey;
  installationId?: string;
}>): Readonly<{ ok: true; headers: Readonly<Record<string, string>> }> | Readonly<{ ok: false }> {
  const authorization = input.context?.externalActionExecutionAuthorization;
  if (!authorization) {
    // Public Action execution never falls through to the daemon credential.
    // A direct PAT request may still complete daemon-local work while its Home
    // is unreachable, but any Home-bound effect remains closed.
    if (input.context?.externalActionCredential) return { ok: false };
    return { ok: true, headers: { Authorization: `Bearer ${input.daemonToken}`,
      ...(input.context?.authority === 'account_automation' ? { [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' } : {}) } };
  }
  if (
    !input.privateKey
    || !input.installationId
    || !input.context?.externalActionTarget
    || authorization.binding.serverIdentityId !== input.serverIdentityId
  ) {
    return { ok: false };
  }
  return {
    ok: true,
    headers: createExternalActionAuthorizedRequestHeaders({
      authorization,
      effectActionId: input.effectActionId,
      target: input.context.externalActionTarget,
      installationId: input.installationId,
      method: input.method,
      path: input.path,
      ...(input.body === undefined ? {} : { body: input.body }),
      privateKey: input.privateKey,
    }),
  };
}

/** A fresh managed continuation re-enters the same public Session Action owner.
 * The controller signs only its original acquire proof; Home admits and signs
 * the actual guest invocation with the original requester authority.
 */
export function isManagedSessionStartTransportAvailable(params: Readonly<{
  authorization?: ExternalActionExecutionAuthorizationV1;
  installationId: string;
  material?: Extract<AccountScopedCryptoMaterial, Readonly<{ type: 'dataKey' }>>;
}>): boolean {
  const root = params.authorization?.binding;
  return root?.actionId === 'machines.managed.acquire' && root.installationId === params.installationId
    && root.target.kind === 'machine' && root.target.machineId === root.machineId
    && (root.accountEncryptionMode === 'plain' || (root.accountEncryptionMode === 'e2ee' && params.material?.machineKey.length === 32));
}

type ManagedChildDispatchParams = Readonly<{
  input: SessionSpawnNewInputV2;
  continuation: NonNullable<ExternalActionExecutionAuthorizationRequestV1['managedContinuation']>;
  authorization: ExternalActionExecutionAuthorizationV1;
  installationId: string;
  privateKey: ExternalActionMachineRequestSigningKey;
  serverHttpBaseUrl: string;
  material?: Extract<AccountScopedCryptoMaterial, Readonly<{ type: 'dataKey' }>>;
  signal?: AbortSignal;
}>;
export async function dispatchManagedSessionStart(params: ManagedChildDispatchParams): Promise<ActionExecuteResult> {
  return dispatchManagedChild({ ...params, actionId: 'session.spawn_new', serverId: params.input.executionTarget.serverId,
    targetMachineId: params.input.executionTarget.machineId });
}

async function dispatchManagedChild(params: Omit<ManagedChildDispatchParams, 'input'> & Readonly<{
  input: SessionSpawnNewInputV2 | MachineEnvironmentApplyInputV1;
  actionId: 'session.spawn_new' | 'machines.environment.apply'; serverId: string; targetMachineId: string;
}>): Promise<ActionExecuteResult> {
  const fail = (code: string): ActionExecuteResult => ({ ok: false, errorCode: code, error: code });
  const root = params.authorization.binding;
  if (!isManagedSessionStartTransportAvailable(params)
    || root.requestId !== params.continuation.creationRequestId) return fail('admission_unavailable');
  if (params.signal?.aborted) return fail('cancelled');
  let input: SessionSpawnNewInputV2 | MachineEnvironmentApplyInputV1;
  try {
    const home = await resolveCliHomeTarget({ kind: 'saved_profile', profileRef: params.serverId });
    const serverIdentityId = assertResolvedHomeTargetIdentity(home, root.serverIdentityId);
    const destination = normalizeServerHttpBaseUrl(params.serverHttpBaseUrl);
    const capturedHome = params.authorization.requesterHttpProjection;
    const capturedDestination = capturedHome?.accountId === root.accountId
      && capturedHome.serverIdentityId === serverIdentityId
      && normalizeServerHttpBaseUrl(capturedHome.serverHttpBaseUrl) === destination;
    // An Iroh runtime origin is not the descriptor's HTTPS application URL.
    // Only the existing verified private Home port can admit that destination.
    if (normalizeServerHttpBaseUrl(home.applicationUrl) !== destination
      && (!capturedDestination || !await capturedHome!.isCurrent())) return fail('target_unavailable');
    if (params.actionId === 'session.spawn_new') {
      const parsed = SessionSpawnNewInputV2Schema.parse(params.input);
      input = { ...parsed, executionTarget: { ...parsed.executionTarget, serverId: serverIdentityId } };
    } else {
      const parsed = MachineEnvironmentApplyInputV1Schema.parse(params.input);
      if (parsed.homeId !== serverIdentityId || parsed.machineId !== params.targetMachineId) return fail('target_unavailable');
      input = parsed;
    }
  } catch { return fail('target_unavailable'); }
  if (params.signal?.aborted) return fail('cancelled');
  // The ordinary spawn owner namespaces identity by Action and requester.
  // Preserve its fresh acquisition correlation across an explicit retry.
  const requestId = root.requestId;
  const target = { kind: 'machine' as const, machineId: params.targetMachineId };
  const binding: ExternalActionEncryptionBindingV2 = { serverIdentityId: root.serverIdentityId,
    accountId: root.accountId, actionId: params.actionId, requestId, target,
    ...('authentication' in root ? { authentication: { kind: root.authentication.kind, tokenEpoch: root.authentication.tokenEpoch } }
      : { credentialId: root.credentialId }) };
  const envelope = root.accountEncryptionMode === 'e2ee'
    ? sealExternalActionRequestV2({ binding, input, material: params.material!, randomBytes,
        ...(params.actionId === 'session.spawn_new' ? { sessionSpawnAdmission: projectApiTokenSessionSpawnAdmissionV1(SessionSpawnNewInputV2Schema.parse(input)) } : {}) })
    : { v: 1 as const, requestId, target, input };
  const body = ExternalActionExecutionAuthorizationRequestV1Schema.parse({ v: 1, machineId: target.machineId,
    envelope, managedContinuation: params.continuation });
  const path = `${EXTERNAL_ACTION_HTTP_PATH_PREFIX_V1}${params.actionId}`;
  const headers = createExternalActionAuthorizedRequestHeaders({ authorization: params.authorization,
    effectActionId: 'machines.managed.acquire', target: root.target, installationId: params.installationId,
    method: 'POST', path, body, privateKey: params.privateKey });
  try {
    const response = await axios.post<unknown>(`${params.serverHttpBaseUrl}${path}`, body, {
      headers: { ...headers, 'Content-Type': 'application/json' },
      ...(params.signal ? { signal: params.signal } : {}), validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) {
      const error = ExternalActionHttpErrorSchema.safeParse(response.data);
      return fail(error.success ? 'code' in error.data ? error.data.code : error.data.error : 'target_unavailable');
    }
    if (envelope.v === 2 && params.material) return openExternalActionResponseV2({ envelope: response.data,
      binding, request: envelope, material: params.material }) ?? fail('invalid_encrypted_envelope');
    const responseEnvelope = ExternalActionResponseEnvelopeV1Schema.safeParse(response.data);
    return responseEnvelope.success && responseEnvelope.data.actionId === params.actionId
      && responseEnvelope.data.requestId === requestId ? responseEnvelope.data.execution : fail('invalid_envelope');
  } catch {
    return fail(params.signal?.aborted ? 'cancelled' : 'target_unavailable');
  }
}

export async function dispatchManagedMachineEnvironment(params: Omit<Parameters<typeof dispatchManagedSessionStart>[0], 'input'> & Readonly<{
  input: MachineEnvironmentApplyInputV1;
  serverId: string;
}>): Promise<ActionExecuteResult> {
  return dispatchManagedChild({ ...params, actionId: 'machines.environment.apply', targetMachineId: params.input.machineId });
}

/** Provenance for the incumbent local host Account path, not effect authority.
 * Home still mints and verifies every setup Action's exact target proof. */
export function isOriginalLocalManagedSetupContext(input: Readonly<{
  context: ActionExecutorContext; credentials: StoredCredentials; custodianAccountId: string; homeId: string;
}>): boolean {
  const { context, credentials } = input;
  const accountId = readAccountIdFromToken(credentials.token);
  const provenance = readAuthTokenProvenance(decodeJwtPayload(credentials.token), { allowLegacyHome: false });
  return Boolean(accountId && accountId === input.custodianAccountId
    && credentials.credentialProvenance === 'stored_session' && provenance?.provenance.kind === 'account'
    && provenance.provenance.authority === 'present_user'
    && (context.surface === 'cli' || context.surface === 'ui') && context.actionCaller?.kind === 'host'
    && context.actionRequestId && context.serverIdentityId === input.homeId
    && (!context.runtimeAccountId || context.runtimeAccountId === accountId)
    && !context.machineAdmission && !context.externalActionCredential && !context.externalActionExecutionAuthorization
    && !context.rpcSessionAuthorization && !context.causalPermissionAuthority && !context.sessionInputSource
    && !context.runtimeRunId && !context.executionRunWorkflowRunId);
}

/** Original local host creation has no Session continuation proof. Its setup
 * re-enters the incumbent Account Action ingress, never an unsigned guest RPC. */
export async function dispatchLocalManagedMachineEnvironment(params: Readonly<{
  input: MachineEnvironmentApplyInputV1;
  context: ActionExecutorContext;
  credentials: StoredCredentials;
  custodianAccountId: string;
  serverHttpBaseUrl: string;
  isCurrent(): Promise<boolean>;
}>): Promise<ActionExecuteResult> {
  if (!isOriginalLocalManagedSetupContext({ ...params, homeId: params.input.homeId }))
    return { ok: false, errorCode: 'admission_unavailable', error: 'admission_unavailable' };
  return dispatchOriginalAccountAction({ actionId: 'machines.environment.apply', input: params.input,
    requestId: params.context.actionRequestId!, target: { kind: 'machine', machineId: params.input.machineId },
    credentials: params.credentials, serverHttpBaseUrl: params.serverHttpBaseUrl, serverIdentityId: params.input.homeId,
    ...(params.context.authority ? { authority: params.context.authority } : {}), isCurrent: params.isCurrent,
    ...(params.context.signal ? { signal: params.context.signal } : {}) });
}

export async function mintExternalActionExecutionAuthorization(input: Readonly<{
  actionId: string;
  envelope: ExternalActionRequestEnvelope;
  machineId: string;
  pat: string;
  serverHttpBaseUrl: string;
  sessionActionOrigin?: ExternalActionExecutionAuthorizationRequestV1['sessionActionOrigin'];
  workflowActionOrigin?: ExternalActionExecutionAuthorizationRequestV1['workflowActionOrigin'];
  sessionActionSource?: ExternalActionExecutionAuthorizationRequestV1['sessionActionSource'];
  installationProof?: ExternalActionExecutionAuthorizationRequestV1['installationProof'];
  signal?: AbortSignal;
}>): Promise<ExternalActionAuthorizationHttpResult> {
  const path = bindExternalActionExecutionAuthorizationHttpPathV1(input.actionId);
  let response;
  try {
    response = await axios.post<unknown>(
      `${input.serverHttpBaseUrl}${path}`,
      { v: 1, machineId: input.machineId, envelope: input.envelope,
        ...(input.sessionActionOrigin ? { sessionActionOrigin: input.sessionActionOrigin } : {}),
        ...(input.workflowActionOrigin ? { workflowActionOrigin: input.workflowActionOrigin } : {}),
        ...(input.sessionActionSource ? { sessionActionSource: input.sessionActionSource } : {}),
        ...(input.installationProof ? { installationProof: input.installationProof } : {}) },
      {
        headers: { Authorization: `Bearer ${input.pat}`, 'Content-Type': 'application/json',
          ...(readAuthTokenProvenance(decodeJwtPayload(input.pat), { allowLegacyHome: false })?.provenance.kind === 'terminal'
            ? { [AUTHORITY_CEILING_HEADER_V1]: 'account_automation' } : {}) },
        timeout: 15_000,
        ...(input.signal ? { signal: input.signal } : {}),
        validateStatus: () => true,
      },
    );
  } catch {
    return { ok: false, code: 'server_unavailable' };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, code: 'invalid_token' };
  }
  if ([404, 405, 501].includes(response.status)) {
    return { ok: false, code: 'server_unavailable' };
  }
  if (response.status < 200 || response.status >= 300) {
    return { ok: false, code: 'auth_unavailable' };
  }
  const authorization = ExternalActionExecutionAuthorizationV1Schema.safeParse(response.data);
  return authorization.success
    ? { ok: true, authorization: authorization.data }
    : { ok: false, code: 'auth_unavailable' };
}

/** Continue the accepted handoff after its original Session publisher quiesces. */
export async function prepareExternalActionHandoffContinuationAuthorization(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  handoffId: string;
  actionId: string;
  input: unknown;
  machineId: string;
  sourceMachineId: string;
  sourceInstallationId: string;
  privateKey: ExternalActionMachineRequestSigningKey;
  serverHttpBaseUrl: string;
  material?: Extract<AccountScopedCryptoMaterial, Readonly<{ type: 'dataKey' }>>;
  signal?: AbortSignal;
}>): Promise<ExternalActionExecutionAuthorizationV1 | null> {
  try {
    if (input.signal?.aborted) return null;
    const root = ExternalActionExecutionAuthorizationV1Schema.parse(input.authorization);
    const binding = root.binding;
    const admission = binding.handoffAdmission;
    if (binding.actionId !== 'session.handoff' || binding.handoffContinuation || !admission
      || binding.machineId !== input.sourceMachineId || binding.installationId !== input.sourceInstallationId
      || admission.sourceMachineId !== input.sourceMachineId || admission.sourceInstallationId !== input.sourceInstallationId
      || ![admission.sourceMachineId, admission.targetMachineId].includes(input.machineId)) return null;
    const target = { kind: 'machine' as const, machineId: input.machineId };
    const actionId = ExternalActionActionIdV1Schema.parse(input.actionId);
    const handoffAdmission = { sessionId: admission.sessionId, sourceMachineId: admission.sourceMachineId,
      targetMachineId: admission.targetMachineId };
    if (binding.accountEncryptionMode === 'e2ee' && !input.material) return null;
    const envelope = binding.accountEncryptionMode === 'e2ee' && input.material
      ? { ...sealExternalActionRequestV2({ binding: { serverIdentityId: binding.serverIdentityId,
          accountId: binding.accountId,
          ...('authentication' in binding ? { authentication: binding.authentication }
            : { credentialId: binding.credentialId }), actionId, requestId: binding.requestId, target },
          input: input.input, material: input.material, randomBytes }), handoffAdmission }
      : { v: 1 as const, requestId: binding.requestId, target, input: input.input, handoffAdmission };
    const body = ExternalActionExecutionAuthorizationRequestV1Schema.parse({ v: 1, machineId: input.machineId,
      envelope,
      handoffContinuation: { authorization: root, handoffId: input.handoffId },
    });
    const path = bindExternalActionExecutionAuthorizationHttpPathV1(actionId);
    const response = await axios.post<unknown>(`${input.serverHttpBaseUrl}${path}`, body, {
      headers: { ...createExternalActionAuthorizedRequestHeaders({ authorization: root,
        effectActionId: 'session.handoff', target: binding.target, installationId: input.sourceInstallationId,
        privateKey: input.privateKey, method: 'POST', path, body }), 'Content-Type': 'application/json' },
      timeout: 15_000,
      ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true,
    });
    if (input.signal?.aborted || response.status < 200 || response.status >= 300) return null;
    const child = ExternalActionExecutionAuthorizationV1Schema.safeParse(response.data);
    if (!child.success) return null;
    const next = child.data.binding;
    const expectedInstallation = input.machineId === admission.sourceMachineId
      ? admission.sourceInstallationId : admission.targetInstallationId;
    if (next.accountId !== binding.accountId || next.serverIdentityId !== binding.serverIdentityId
      || next.accountEncryptionMode !== binding.accountEncryptionMode
      || next.machineId !== input.machineId || next.installationId !== expectedInstallation
      || next.actionId !== actionId || next.requestId !== binding.requestId
      || next.requestEnvelopeDigest !== computeExternalActionRequestEnvelopeDigestV1(body.envelope)
      || !externalActionTargetsEqualV1(next.target, target)
      || !sameStrictJsonValue(next.handoffAdmission, admission)
      || !sameStrictJsonValue(next.sessionActionOrigin, binding.sessionActionOrigin)
      || !sameStrictJsonValue(next.sessionActionSource, binding.sessionActionSource)
      || !sameStrictJsonValue(next.handoffContinuation, { rootRequestId: binding.requestId,
        rootRequestEnvelopeDigest: binding.requestEnvelopeDigest, handoffId: input.handoffId })
      || ('authentication' in binding ? !('authentication' in next)
        || !sameStrictJsonValue(next.authentication, binding.authentication)
        : !('credentialId' in next) || next.credentialId !== binding.credentialId
          || next.principalId !== binding.principalId || !sameStrictJsonValue(next.grant, binding.grant))) return null;
    return child.data;
  } catch { return null; }
}

export async function verifyExternalActionExecutionAuthorizationCurrent(input: Readonly<{
  authorization: ExternalActionExecutionAuthorizationV1;
  effectActionId: string;
  target: ExternalActionTargetV1;
  privateKey: ExternalActionMachineRequestSigningKey;
  installationId: string;
  serverHttpBaseUrl: string;
  managedFiniteWakeTarget?: ManagedWakeTargetV1;
  signal?: AbortSignal;
}>): Promise<boolean> {
  const path = bindExternalActionExecutionAuthorizationVerifyHttpPathV1(
    input.authorization.binding.actionId,
  );
  const body = { v: 1 as const, ...(input.managedFiniteWakeTarget ? { managedFiniteWakeTarget: input.managedFiniteWakeTarget } : {}) };
  const headers = createExternalActionAuthorizedRequestHeaders({
    authorization: input.authorization,
    effectActionId: input.effectActionId,
    target: input.target,
    installationId: input.installationId,
    method: 'POST',
    path,
    body,
    privateKey: input.privateKey,
  });
  try {
    const response = await axios.post<unknown>(`${input.serverHttpBaseUrl}${path}`, body, {
      headers: { ...headers, 'Content-Type': 'application/json' },
      timeout: 15_000,
      ...(input.signal ? { signal: input.signal } : {}),
      validateStatus: () => true,
    });
    return response.status >= 200
      && response.status < 300
      && ExternalActionExecutionAuthorizationVerifyResponseV1Schema.safeParse(response.data).success;
  } catch {
    return false;
  }
}
