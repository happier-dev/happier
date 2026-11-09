import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { onTestFinished, vi } from 'vitest';
import axios, { type AxiosRequestConfig } from 'axios';
import nacl from 'tweetnacl';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ExternalActionExecutionAuthorizationV1Schema, ExternalActionExecutionAuthorizationVerifyResponseV1Schema,
  ExternalActionRequestEnvelopeSchema, bindExternalActionExecutionAuthorizationVerifyHttpPathV1,
  createDeploymentCandidatePublicationV1, projectDeploymentNativeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { computeExternalActionRequestEnvelopeDigestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { sealExternalActionRequestV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { ACTION_OPERATION_RPC_METHODS_V1 } from '@happier-dev/protocol/actions/operations/v1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import type { RpcHandlerConfig } from '@/api/rpc/types';
import { authorizeMachineRpcRequest, verifyMachineRpcAdmissionCurrent } from '@/api/machine/machineRpcAuthorization';
import { prepareInstalledRequesterAccountActionContext } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { readOrCreateInstallationIdentity } from '@/daemon/identity/store';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { reloadConfiguration } from '@/configuration';
import { encodeStoredCredentials, type StoredCredentials } from '@/persistence';
import { resetInMemoryAccountSettingsContextForTests } from '@/settings/accountSettings/bootstrapAccountSettingsContext';
import { logger } from '@/ui/logger';
import type { ActionOperationStore } from './actionOperationStore';
import type { ActionOperationRunner } from './actionOperationRunner';
import { createActionOperationRpcHandlers, registerActionOperationRpcHandlers } from './actionOperationRpcHandlers';

type HttpReply = Readonly<{ status: number; data: unknown }>;
type HomeHttpRequest = Readonly<{ method: 'GET' | 'POST'; url: string; body?: unknown; options?: AxiosRequestConfig }>;
type CancellationAdmissionDiagnostic = Readonly<{
  admissionPredicate?: string;
  outcomeCode?: string;
  failedPhase?: string;
  causeCode?: string;
  requesterPhase?: string;
  refusalBranch?: string;
  factoryReturnedNull?: true;
  endpoint?: 'profile' | 'encryption_currentness' | 'settings' | 'machine_admission' | 'root_verification' | 'other';
  httpStatus?: number;
  rootVerificationSchemaValid?: boolean;
}>;

const requesterRefusalPhases = new Set([
  'requester_installation_missing', 'requester_origin_unavailable', 'requester_origin_machine_mismatch',
  'requester_preparation_root', 'requester_move_root', 'requester_workspace_preparation_root',
  'requester_finite_wake_target', 'requester_preparation_recipient', 'requester_session_custody',
  'requester_preparation_cancelled', 'requester_preparation_custody', 'requester_preparation_currentness',
  'requester_session_currentness', 'requester_credentials_open', 'requester_account_admission',
  'requester_admission', 'requester_profile', 'requester_encryption_currentness', 'requester_account_mode',
  'requester_content_key', 'requester_settings', 'requester_account_projection', 'requester_saved_secret_context',
  'requester_http_projection', 'requester_executor', 'requester_projection_currentness', 'requester_projection_ports',
  'requester_projection_cipher', 'requester_projection_mode', 'requester_projection_material',
  'requester_projection_custody', 'requester_projection_root',
  'signed_root_http_request', 'signed_root_http_response', 'signed_root_http_status',
]);
const requesterRefusalBranches = new Set([
  'schema', 'home', 'cancelled', 'currentness', 'profile_identity', 'mode', 'mode_material',
  'custody', 'settings_identity', 'settings_source', 'null_projection', 'exception',
]);

/** Real requester admission, cryptography and RPC owner; only Home network boundaries are substituted. */
export async function createActionOperationCancellationFixture(input: Readonly<{
  mode: 'plain' | 'e2ee';
  accountId: string;
  actionId?: 'action.operations.cancel' | 'deployments.deploy';
  actionInput?: unknown;
  deploymentCandidateSource?: Readonly<{ id: string; revision: number }>;
  admittedMachineRole?: 'use' | 'manage';
  address: Readonly<{ serverId: string; machineId: string; operationId: string }>;
  store: ActionOperationStore;
  runner: ActionOperationRunner;
  handlers?: ReturnType<typeof createActionOperationRpcHandlers>;
  requestHttp?: (request: HomeHttpRequest) => HttpReply | undefined | Promise<HttpReply | undefined>;
}>) {
  const { mode, accountId, address, store, runner } = input;
  const actionId = input.actionId ?? 'action.operations.cancel';
  const diagnostics: CancellationAdmissionDiagnostic[] = [];
  const machineId = address.machineId;
  const directory = await mkdtemp(join(tmpdir(), 'happier-cancel-address-'));
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL']);
  env.patch({ HAPPIER_HOME_DIR: directory, HAPPIER_ACTIVE_SERVER_ID: address.serverId, HAPPIER_SERVER_URL: 'https://cancel-home.invalid' });
  reloadConfiguration();
  let channel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>> | undefined;
  onTestFinished(async () => {
    await channel?.close();
    vi.restoreAllMocks();
    resetInMemoryAccountSettingsContextForTests();
    env.restore(); reloadConfiguration();
    await rm(directory, { recursive: true, force: true });
  });
  channel = await createRequesterCurrentnessSocketHarness();
  const installation = await readOrCreateInstallationIdentity();
  const token = `header.${Buffer.from(JSON.stringify({ sub: accountId, tokenEpoch: 7,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
  const machineKey = nacl.randomBytes(32);
  const publicKey = nacl.box.keyPair.fromSecretKey(machineKey).publicKey;
  const material = { type: 'dataKey' as const, machineKey };
  const credentials: StoredCredentials = { token, encryption: mode === 'plain' ? null : { ...material, publicKey } };
  const encodeSettings = (settings: Readonly<Record<string, unknown>>) => mode === 'plain'
    ? { t: 'plain' as const, v: settings }
    : { t: 'encrypted' as const, c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material,
      payload: settings, randomBytes: nacl.randomBytes }) };
  let settingsContent = encodeSettings({});
  let settingsVersion = 1;
  let current = true;
  const respondHome = async (request: HomeHttpRequest): Promise<HttpReply> => {
    const { method, url } = request;
    if (method === 'GET' && url.endsWith('/v1/account/profile')) return { status: 200, data: { id: accountId } };
    if (method === 'GET' && url.endsWith('/v2/account/settings')) return { status: 200, data: { content: settingsContent, version: settingsVersion } };
    if (method === 'GET' && url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
      mode, version: 1, signingKeyFingerprint: null,
      contentKeyFingerprint: mode === 'plain' ? null : computeAccountEncryptionMigrateKeyFingerprintV1(publicKey), updatedAt: 1 } };
    if (method === 'POST' && url.endsWith(`/v1/machines/${machineId}/admission/verify`)) return {
      status: current ? 200 : 403, data: current ? { v: 1, ok: true } : { code: 'access_denied' } };
    if (method === 'POST' && [actionId, 'action.operations.cancel'].some(id => url.endsWith(bindExternalActionExecutionAuthorizationVerifyHttpPathV1(id)))) return {
      status: current ? 200 : 403,
      data: current ? ExternalActionExecutionAuthorizationVerifyResponseV1Schema.parse({ ok: true }) : { code: 'access_denied' } };
    const result = await input.requestHttp?.(request);
    if (result) return result;
    throw new Error(`Unexpected cancellation HTTP ${method} ${url}`);
  };
  const requestHome = async (request: HomeHttpRequest): Promise<HttpReply> => {
    const endpoint: CancellationAdmissionDiagnostic['endpoint'] = request.url.endsWith('/v1/account/profile') ? 'profile'
      : request.url.endsWith('/v1/account/encryption/currentness') ? 'encryption_currentness'
      : request.url.endsWith('/v2/account/settings') ? 'settings'
      : request.url.endsWith(`/v1/machines/${machineId}/admission/verify`) ? 'machine_admission'
      : request.url.endsWith(bindExternalActionExecutionAuthorizationVerifyHttpPathV1(actionId)) ? 'root_verification' : 'other';
    try {
      const response = await respondHome(request);
      diagnostics.push({ endpoint, httpStatus: response.status,
        ...(endpoint === 'root_verification' ? { rootVerificationSchemaValid:
          ExternalActionExecutionAuthorizationVerifyResponseV1Schema.safeParse(response.data).success } : {}) });
      return response;
    } catch (error) { diagnostics.push({ endpoint }); throw error; }
  };
  vi.spyOn(axios, 'get').mockImplementation(async (url, options) => requestHome({ method: 'GET', url: String(url), options }));
  vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => requestHome({ method: 'POST', url: String(url), body, options }));
  vi.spyOn(axios, 'request').mockImplementation(async options => {
    const method = (options.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'POST') throw new Error(`Unexpected cancellation HTTP method ${method}`);
    return requestHome({ method, url: String(options.url), body: options.data, options });
  });
  // Observe the genuine file-logging boundary without replacing any admission owner.
  const phaseLog = vi.spyOn(logger, 'warnLocalFile');
  const prepareRequester: NonNullable<RpcHandlerConfig['prepareRequesterAccountContext']> = async request => {
    const firstLog = phaseLog.mock.calls.length;
    const prepared = await prepareInstalledRequesterAccountActionContext({ ...request,
      purpose: request.purpose ?? { kind: 'external_action' }, machineId, serverId: address.serverId,
      serverHttpBaseUrl: 'https://cancel-home.invalid',
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId, serverIdentityId: address.serverId }),
      createExecutor: () => createActionExecutor(createUnavailableActionTransportDeps()),
    });
    if (!prepared) {
      for (const [message, data] of phaseLog.mock.calls.slice(firstLog)) {
        if (message !== '[external-action-phase]' || !data || typeof data !== 'object') continue;
        const record = data as Record<string, unknown>;
        if (typeof record.phase !== 'string' || !requesterRefusalPhases.has(record.phase)) continue;
        diagnostics.push({ requesterPhase: record.phase,
          ...(typeof record.refusalBranch === 'string' && requesterRefusalBranches.has(record.refusalBranch)
            ? { refusalBranch: record.refusalBranch } : {}) });
      }
      diagnostics.push({ factoryReturnedNull: true });
    }
    return prepared;
  };
  const rpc = new RpcHandlerManager({ scopePrefix: machineId, localMachineId: machineId, encryptionMode: 'plain',
    logger: (_message, data) => {
      if (!data || typeof data !== 'object') return;
      const record = data as Record<string, unknown>;
      const failure = record.failure && typeof record.failure === 'object' ? record.failure as Record<string, unknown> : null;
      const diagnostic: CancellationAdmissionDiagnostic = {
        ...(typeof record.admissionPredicate === 'string' ? { admissionPredicate: record.admissionPredicate } : {}),
        ...(typeof record.outcomeCode === 'string' ? { outcomeCode: record.outcomeCode } : {}),
        ...(typeof failure?.failedPhase === 'string' ? { failedPhase: failure.failedPhase } : {}),
        ...(typeof failure?.causeCode === 'string' ? { causeCode: failure.causeCode } : {}),
      };
      if (Object.keys(diagnostic).length > 0) diagnostics.push(diagnostic);
    },
    authorizeRequest: request => authorizeMachineRpcRequest(request, { machineId,
      resolveCustodianAccountId: async () => 'custodian', resolveInstallationId: () => installation.installationId,
      verifyMachineAdmission: request => verifyMachineRpcAdmissionCurrent({ ...request,
        privateKey: Buffer.from(installation.privateKey, 'base64url'), daemonToken: 'daemon', serverHttpBaseUrl: 'https://cancel-home.invalid' }) }),
    prepareRequesterAccountContext: prepareRequester });
  registerActionOperationRpcHandlers(rpc, input.handlers ?? createActionOperationRpcHandlers({ store, runner, machineId,
    resolveAccountId: async () => 'custodian' }));
  const target = { kind: 'machine' as const, machineId };
  const encryptionBinding = { serverIdentityId: address.serverId, accountId, actionId,
    requestId: 'reviewed-cancel', target, authentication: { kind: 'account' as const, tokenEpoch: 7 } };
  const envelope = ExternalActionRequestEnvelopeSchema.parse(mode === 'plain'
    ? { v: 1, requestId: encryptionBinding.requestId, target, input: input.actionInput ?? address }
    : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: encryptionBinding, input: input.actionInput ?? address, material, randomBytes: nacl.randomBytes }));
  const requestEnvelopeDigest = computeExternalActionRequestEnvelopeDigestV1(envelope);
  const deploymentNativeAdmission = actionId === 'deployments.deploy' && input.deploymentCandidateSource
    ? projectDeploymentNativeAdmissionV1(actionId, input.actionInput) : undefined;
  const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-cancel-root', binding: {
    ...encryptionBinding, custodianAccountId: 'custodian', machineId, installationId: installation.installationId,
    accountEncryptionMode: mode, requestEnvelopeDigest,
    ...(input.admittedMachineRole ? { admittedMachineRole: input.admittedMachineRole } : {}),
    ...(deploymentNativeAdmission && input.deploymentCandidateSource ? {
      deploymentCandidatePublication: createDeploymentCandidatePublicationV1({ accountId, serverIdentityId: address.serverId,
        actionId, requestId: envelope.requestId, requestEnvelopeDigest, environmentId: deploymentNativeAdmission.environmentId,
        source: input.deploymentCandidateSource }),
    } : {}) } });
  const sealCancellationAuthorization = (operationId: string) => {
    const params = { operationId };
    return sealExternalActionRequesterAccountContextV1({ authorization: root,
      purpose: { kind: 'machine_rpc', method: ACTION_OPERATION_RPC_METHODS_V1.cancel, params },
      credentials: encodeStoredCredentials(credentials), installationPublicKey: Buffer.from(installation.publicKey, 'base64url'),
      randomBytes: nacl.randomBytes });
  };
  const cancel = (operationId: string) => {
    const params = { operationId };
    const cancelBinding = { ...encryptionBinding, actionId: 'action.operations.cancel' as const };
    const cancelInput = { ...address, operationId };
    const cancelEnvelope = actionId === 'action.operations.cancel' ? envelope
      : ExternalActionRequestEnvelopeSchema.parse(mode === 'plain'
        ? { v: 1, requestId: cancelBinding.requestId, target, input: cancelInput }
        : sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding: cancelBinding, input: cancelInput, material, randomBytes: nacl.randomBytes }));
    const cancelRoot = actionId === 'action.operations.cancel' ? root : ExternalActionExecutionAuthorizationV1Schema.parse({
      v: 1, token: 'home-pending-cancel-root', binding: { ...cancelBinding,
        custodianAccountId: 'custodian', machineId, installationId: installation.installationId,
        accountEncryptionMode: mode, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(cancelEnvelope) } });
    const authorization = actionId === 'action.operations.cancel' ? sealCancellationAuthorization(operationId)
      : sealExternalActionRequesterAccountContextV1({ authorization: cancelRoot,
        purpose: { kind: 'machine_rpc', method: ACTION_OPERATION_RPC_METHODS_V1.cancel, params },
        credentials: encodeStoredCredentials(credentials), installationPublicKey: Buffer.from(installation.publicKey, 'base64url'),
        randomBytes: nacl.randomBytes });
    return rpc.handleRequest({ method: `${machineId}:${ACTION_OPERATION_RPC_METHODS_V1.cancel}`, params,
      callerAuthority: 'present_user', callerInputAuthorization: authorization, originalActionEnvelope: cancelEnvelope,
      machineAdmission: { actorAccountId: accountId, custodianAccountId: 'custodian', machineId,
        installationId: installation.installationId, role: 'use', encryptionMode: mode } });
  };
  return { rpc, root, envelope, cancel, credentials, material, installation, diagnostics, socketServer: channel.server,
    prepareRoot: () => prepareRequester({ authorization: actionId === 'action.operations.cancel'
      ? sealCancellationAuthorization(address.operationId)
      : sealExternalActionRequesterAccountContextV1({ authorization: root, purpose: { kind: 'external_action' },
          credentials: encodeStoredCredentials(credentials), installationPublicKey: Buffer.from(installation.publicKey, 'base64url'),
          randomBytes: nacl.randomBytes }),
      purpose: actionId === 'action.operations.cancel'
        ? { kind: 'machine_rpc', method: ACTION_OPERATION_RPC_METHODS_V1.cancel, params: { operationId: address.operationId } }
        : { kind: 'external_action' },
      signal: new AbortController().signal }),
    scope: { accountId, machineId }, setCurrent(value: boolean) { current = value; },
    setAccountSettings(settings: Readonly<Record<string, unknown>>) {
      settingsContent = encodeSettings(settings);
      settingsVersion += 1;
    } };
}
