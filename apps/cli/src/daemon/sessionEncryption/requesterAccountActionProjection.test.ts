import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FeaturesResponseSchema, API_TOKEN_FULL_GRANT_V1, projectDeploymentChildRoutingV1, DeploymentChildRpcV1Schema, MachineAdmissionVerifyResponseV1Schema } from '@happier-dev/protocol';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { prepareRequesterOperationMaterial } from '@/daemon/connectedServices/purposeBindings/requesterOperationMaterial';
import { createPluginReloadController } from '@/plugins/runtime/reload/controller';
import { createDeploymentChildRequesterHarness } from '@/testkit/backends/deploymentChildRequesterHarness';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { bindHomeDomainHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainHttpBinding';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, ExternalActionExecutionAuthorizationV1Schema,
  projectDeploymentPreparationAdmissionV1, createDeploymentCandidatePublicationV1, deriveWorkspaceSyncRelationshipId,
  projectExternalActionDeploymentNativeEnvelopeAdmissionV1 } from '@happier-dev/protocol/actions/externalActionApi';
import { ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { bindRequesterSessionCredentialScope, sameStoredCredentials, type StoredCredentials } from '@/persistence';
import * as persistence from '@/persistence';
import { projectRequesterAccountActionAuthorization } from './requesterSessionCredentials';
import { createExternalActionMachineRpcExecution, createExternalActionAuthorizedRequestHeaders, dispatchOriginalAccountAction, projectExternalActionRequesterHttpAuthorization, isReviewedSessionActionCreationChild, createReviewedSecondOpinionSessionCreationAuthorization, isReviewedDeploymentChild } from '@/api/externalActionExecutionAuthorization';
import { verifyMachineInstallationProof } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { buildDiscussionModelSessionCreationProofPayloadV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationAuthorizationV1';
import { deriveSessionCreationTagV1 } from '@happier-dev/protocol/sessions/creation/sessionCreationIdentityV1';
import { SessionSpawnNewInputV2Schema } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewInputV2';
import { StrictJsonValueSchema } from '@happier-dev/protocol/json/strictJsonValue';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import * as requesterAccountOwner from './requesterAccountActionProjection';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createDeploymentTargetRoleAdmissionHost } from '@/deployments/targets/createDeploymentTargetRoleAdmissionHost';
import { createActionOperationRunner } from '../actionOperations/actionOperationRunner';
import { createActionOperationStore } from '../actionOperations/actionOperationStore';
import { createHostActionOperationRuntime } from '../actionOperations/createHostActionOperationRuntime';
import { deriveAccountMachineKeyFromRecoverySecret, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { verifyExternalActionExecutionAuthorizationCurrent } from '@/api/externalActionExecutionAuthorization';
import { openExternalActionRequesterAccountContextV1, sealExternalActionRequesterAccountContextV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import * as installationStore from '@/daemon/identity/store';
import { createCurrentMachineExecutionOriginContextResolver } from '@/api/machine/resolveCurrentMachineExecutionOriginContext';
import { createServerUrlServerFeaturesSnapshotStore } from '@/features/serverFeaturesSnapshotStore';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { logger } from '@/ui/logger';
import { publishServerHttpRuntimeOrigin, resolveServerHttpBaseUrl, runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { encodeStoredCredentials } from '@/persistence';
import { createActionExecutor, computeExternalActionRequestEnvelopeDigestV1,
  sealExternalActionRequestV2, openExternalActionRequestV2, openExternalActionResponseV2 } from '@happier-dev/protocol/actions';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { registerExternalActionRpcHandler } from '@/rpc/handlers/externalAction';
import { EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1, ExternalActionRequestEnvelopeSchema, parseExternalActionDaemonDispatchResultV1,
  projectExternalActionHttpError } from '@happier-dev/protocol/actions/externalActionApi';
import { ACTION_API_SERVER_ORIGIN } from '@happier-dev/protocol/socketRpc';
import type { RpcHandler } from '@/api/rpc/types';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER } from '@happier-dev/protocol/actions/externalActionApi';
import { decodeDeploymentChildExecutionV1, verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { resolveProjectSetupAcceptedWorkspace } from '@/workspaces/projectSetup/projectSetupAcceptedWorkspace';
import { createPlainProjectAccountRefRow, projectAccountRowsReadHttpResponse } from '@/workspaces/projectAccountRows.testkit';
import { createDeploymentEnvironmentV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
import { DeploymentDeployActionInputV1Schema } from '@happier-dev/protocol';
import { createDeploymentReceiptArtifactHeaderV1 } from '@happier-dev/deployment-protocol';
import { createCliDeploymentActionDeps } from '@/deployments/createCliDeploymentActionDeps';
import { createAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { captureRequesterCurrentnessRefusal } from '@/daemon/sessionEncryption/requesterCurrentness';
import { createDaemonDeploymentActionDeps } from '@/deployments/createDaemonDeploymentActionDeps';
import { buildDeploymentAccountChangeV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { buildAccountIdentitiesChangeV1, type ChangeEntry } from '@happier-dev/protocol/changes';
import { DeploymentEnvironmentArtifactHeaderV1Schema, DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, readDeploymentEnvironmentArtifactV1,
  readDeploymentReceiptArtifactV1 } from '@happier-dev/deployment-protocol';

let channel: Awaited<ReturnType<typeof createRequesterCurrentnessSocketHarness>>;
it.each(['plain', 'e2ee'] as const)('carries exact native incumbent custody through the %s installed review HTTP projection', async encryptionMode => {
  const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'review', actionId: 'deployments.deploy',
    machineId: 'receiver', installationId: 'receiver-installation', input: { serverId: 'srv_archive_home',
      environmentId: 'environment', targetLinkId: 'link', expectedRevision: 1, expectedTargetLinkRevision: 1,
      requestKey: 'request', contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 } });
  const f = await createDeploymentChildRequesterHarness({ encryptionMode, job });
  vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
    if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
    if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: f.settingsContent, version: 1 } };
    if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: f.currentness };
    throw new Error('Unexpected native review bootstrap read');
  });
  const prepared = await f.prepare();
  try {
    const projection = prepared.authorization.requesterHttpProjection;
    if (!projection) throw new Error('Missing installed review projection');
    const spec = getActionSpec('deployments.receipts.get');
    if (!spec.serverTransport) throw new Error('Missing receipt transport');
    const path = bindHomeDomainHttpRequestV1({ transport: spec.serverTransport, inputSchema: spec.inputSchema,
      input: { serverId: f.homeIdentityId, environmentId: 'environment', deploymentId: 'mixed-incumbent' } }).path;
    const nativeIncumbentSource = { environmentId: 'environment', sourceDeploymentId: 'mixed-incumbent', rootFingerprint: 'a'.repeat(64) };
    const request = { effectActionId: job.actionId, method: 'GET', path, nativeIncumbentSource };
    const headers = await projection.createRequestHeaders(request);
    const proof = decodeDeploymentChildExecutionV1(headers?.[EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER] ?? '',
      headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]);
    expect(proof?.nativeIncumbentSource).toEqual(nativeIncumbentSource);
    expect(verifyExternalActionMachineRequestV1({ authorizationToken: f.root.token, effectActionId: job.actionId,
      target: f.root.binding.target, installationId: f.installed.installationId, requestId: f.root.binding.requestId,
      method: 'GET', path, deploymentChildExecution: proof ?? undefined,
      signature: headers?.['x-happier-action-machine-signature'] ?? '', publicKey: f.receiver.publicKey })).toBe(true);
    // Incumbent custody rides only a bodyless review GET; any other request is a named local refusal.
    expect(await captureRequesterCurrentnessRefusal(() => projection.createRequestHeaders({ ...request, method: 'POST', body: {} })))
      .toEqual({ value: null, branch: 'native_incumbent_source' });
    f.setCurrent(false);
    const admittedHeaders = await projection.createRequestHeaders(request);
    expect(decodeDeploymentChildExecutionV1(admittedHeaders?.[EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER] ?? '',
      admittedHeaders?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER])?.nativeIncumbentSource)
      .toEqual(nativeIncumbentSource);
    await expect(f.prepare()).rejects.toThrow('Missing private requester receiver custody');
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await projection.createRequestHeaders({ ...request, signal: cancelled.signal })).toBeNull();
  } finally { await prepared.dispose(); }
});
beforeEach(async () => { channel = await createRequesterCurrentnessSocketHarness(); });
afterEach(async () => { await channel.close(); vi.restoreAllMocks(); });

const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'home-invocation', binding: {
  accountId: 'bob', principalId: 'bob', credentialId: 'pat', custodianAccountId: 'alice',
  serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation',
  actionId: 'projects.context.update', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
  target: { kind: 'machine', machineId: 'machine' },
  grant: ApiTokenGrantV1Schema.parse({ v: 1, actions: { families: [], ids: ['projects.context.update'] },
    targets: { sessions: [], machines: ['machine'] }, approve: false, origins: [], models: null,
    permissionModes: null, create: null }),
} });

function bootstrap(credentials: StoredCredentials, isCurrent = async () => true) {
  return { credentials, serverHttpBaseUrl: 'https://requester-home.test', isCurrent,
    attribution: { serverId: 'home-profile', accountId: 'bob', machineId: 'machine', installationId: 'installation' } };
}

describe('admitted requester Action projection', () => {
  it('prepares SOURCE projection with one source observation and no bracketing custody reads', async () => {
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error('Unexpected SOURCE projection read');
    });
    const observations: string[] = [];
    const admitted = await requesterAccountOwner.admitRequesterAccountActionContext({
      authorization: { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'plain' } },
      credentials: { token: 'bob-source-projection', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test',
      purpose: { kind: 'workspace_sync_prepare', controller: { machineId: 'controller', installationId: 'installation' },
        request: { sourceWorkspaceRefId: 'source', targetWorkspaceRefId: 'target' } },
      isCurrent: async () => { observations.push('source'); return true; },
      isCustodyCurrent: async () => { observations.push('custody'); return true; },
    });
    if (!admitted) throw new Error('Missing SOURCE projection');
    try {
      const sourceReads = observations.filter(value => value === 'source');
      // Admission and the completed SOURCE projection each observe the source once.
      expect(sourceReads).toHaveLength(2);
      const custodyReads = observations.filter(value => value === 'custody').length;
      expect(await admitted.isCurrent()).toBe(true);
      expect(observations.filter(value => value === 'source')).toHaveLength(sourceReads.length + 1);
      expect(observations.filter(value => value === 'custody'), 'no custody rereads around the SOURCE observation')
        .toHaveLength(custodyReads);
    } finally { await admitted.dispose(); }
  });

  it('retires retained Environment disclosure through the original requester push port without native-event reads', async () => {
    let cursor = 0;
    let requesterCurrent = true;
    let changes: Omit<ChangeEntry, 'cursor' | 'changedAt'>[] = [];
    let accessReads = 0;
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.includes('/v2/changes?')) return { status: 200, data: { changes: changes.map(change => ({ ...change,
        cursor, changedAt: cursor })), nextCursor: cursor } };
      throw new Error('Unexpected Environment observer HTTP read');
    });
    vi.spyOn(axios, 'request').mockImplementation(async request => {
      expect(request.url).toBe('https://requester-home.test/v1/deployments/environments/access');
      accessReads++;
      return { status: 200, data: { ok: true, items: [{ environmentId: 'environment', read: true, deploy: false }] } };
    });
    const context = await requesterAccountOwner.admitRequesterAccountActionContext({
      authorization: { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'plain' } },
      credentials: { token: 'bob-environment-observer', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => requesterCurrent,
    });
    if (!context) throw new Error('Missing original requester custody');
    const deps = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://requester-home.test',
      localAccount: { accountId: 'alice', token: 'alice-local-credential' },
      admitAccount: async () => null, resolveRequestHeaders: async () => ({}),
      async dispatchReceipt() { throw new Error('Observation must not dispatch native effects'); },
    });
    const observe = Reflect.get(deps, 'observeEnvironmentAccessChanges');
    let visible = true;
    const observed: unknown[] = [];
    let subscription: { dispose(): Promise<void> } | undefined;
    try {
      expect(typeof observe).toBe('function');
      if (typeof observe !== 'function') throw new Error('Missing Environment access observation port');
      const actionContext = { externalActionExecutionAuthorization: context.authorization };
      const stripped = { externalActionExecutionAuthorization: ExternalActionExecutionAuthorizationV1Schema.parse(
        JSON.parse(JSON.stringify(context.authorization))) };
      expect(await observe({ serverId: 'stable-home' }, stripped, () => {})).toMatchObject({ ok: false, errorCode: 'admission_unavailable' });
      const otherHome = createCliDeploymentActionDeps({ serverHttpBaseUrl: 'https://other-home.test',
        admitAccount: async () => null, resolveRequestHeaders: async () => ({}),
        async dispatchReceipt() { throw new Error('Observation must not dispatch native effects'); },
      });
      const observeOtherHome = Reflect.get(otherHome, 'observeEnvironmentAccessChanges');
      if (typeof observeOtherHome !== 'function') throw new Error('Missing Environment access observation port');
      expect(await observeOtherHome({ serverId: 'stable-home' }, actionContext, () => {})).toMatchObject({ ok: false,
        errorCode: 'admission_unavailable' });
      expect(await deps.readEnvironmentAccess({ serverId: 'stable-home', environmentIds: ['environment'] }, actionContext,
        'machines.services.list')).toMatchObject({ ok: true, items: [{ environmentId: 'environment' }] });
      const observedSubscription = await observe({ serverId: 'stable-home' }, actionContext, (fact: unknown) => {
        observed.push(fact);
        visible = false;
      });
      if (!('dispose' in observedSubscription)) throw new Error('Expected an Environment access subscription');
      subscription = observedSubscription;
      await channel.settleTransport();
      await context.dispose();
      observed.length = 0;
      visible = true;
      cursor++;
      changes = [buildDeploymentAccountChangeV1({ projectSourceId: 'source', environmentId: 'environment', revision: 2 })];
      await channel.hintAccountChange(cursor);
      await vi.waitFor(() => expect(observed).toContainEqual({ kind: 'changes', environmentIds: ['environment'] }));
      expect(visible).toBe(false);
      expect(accessReads).toBe(1);
      observed.length = 0;
      visible = true;
      cursor++;
      changes = [buildAccountIdentitiesChangeV1()];
      await channel.hintAccountChange(cursor);
      await vi.waitFor(() => expect(observed).toEqual([{ kind: 'reset' }]));
      expect(visible).toBe(false);
      expect(accessReads).toBe(1);
      requesterCurrent = false;
      expect(await observe({ serverId: 'stable-home' }, actionContext, () => {})).toMatchObject({ ok: false,
        errorCode: 'action_forbidden' });
      requesterCurrent = true;
      const abort = new AbortController();
      const abortedFacts: unknown[] = [];
      const abortSubscription = await observe({ serverId: 'stable-home' }, { ...actionContext, signal: abort.signal },
        (fact: unknown) => abortedFacts.push(fact));
      expect(abortSubscription).toHaveProperty('dispose');
      if (!('dispose' in abortSubscription)) throw new Error('Expected an Environment access subscription');
      abort.abort();
      expect(abortedFacts.at(-1)).toEqual({ kind: 'retired' });
      await abortSubscription.dispose();
      const publicationsAtAbort = abortedFacts.length;
      observed.length = 0;
      await channel.disconnect();
      await vi.waitFor(() => expect(observed).toContainEqual({ kind: 'retired' }));
      expect(abortedFacts).toHaveLength(publicationsAtAbort);
      expect(accessReads).toBe(1);
      expect(JSON.stringify(context.authorization)).not.toContain('subscribeEnvironmentAccess');
    } finally { await subscription?.dispose(); await context.dispose(); }
  });
  it('does not inspect installed credentials from the parallel Settings floor before requester identity admission', async () => {
    // Credential storage and Home HTTP are system boundaries. Keep the real
    // currentness helper so its legacy-recovery branch remains observable.
    const storedCredentials = vi.spyOn(persistence, 'readStoredCredentials').mockResolvedValue(null);
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'another-account' } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 400, data: {
        error: 'migration-required', recipientEnvelopeReadiness: { status: 'unavailable', reason: 'encryption_setup_required' },
      } };
      throw new Error('Rejected identity must not open Settings');
    });
    await expect(requesterAccountOwner.admitRequesterAccountActionContext({
      authorization: { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'plain' } },
      credentials: { token: 'bob', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => true,
    })).resolves.toBeNull();
    expect(storedCredentials).not.toHaveBeenCalled();
  });

  it('takes one requester mode observation per parallel admitted request and retains each Settings floor', async () => {
    let modeReads = 0;
    const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: ++modeReads,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 3 } };
      throw new Error(`Unexpected parallel requester read ${url}`);
    });
    const admitted = await Promise.all(Array.from({ length: 3 }, () => requesterAccountOwner.admitRequesterAccountActionContext({
      authorization: { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'plain' } },
      credentials: { token: 'bob', encryption: null }, serverId: 'parallel-home', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://parallel-requester-home.test', isCurrent: async () => true,
    })));
    try {
      expect(admitted.every(context => context !== null)).toBe(true);
      expect(admitted.map(context => context?.accountEncryptionCurrentness.settingsVersion)).toEqual([1, 2, 3]);
      expect(modeReads).toBe(admitted.length);
      for (const context of admitted) for (let read = 0; read < 5; read++) expect(await context!.isCurrent()).toBe(true);
      expect(modeReads).toBe(admitted.length);
      expect(get.mock.calls.filter(([url]) => String(url).endsWith('/v2/account/settings'))).toHaveLength(admitted.length);
    } finally { await Promise.all(admitted.map(context => context?.dispose())); }
  });

  it('admits requester identity independently of unrelated pool data before opening its observation and Settings floor', async () => {
    let releaseProfile!: () => void;
    const profileHeld = new Promise<void>(resolve => { releaseProfile = resolve; });
    let profileStarted = false;
    let floorStarted = false;
    let settingsReads = 0;
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) {
        profileStarted = true;
        await profileHeld;
        return { status: 200, data: { id: 'bob', connectedAccountGroupsV4: [{ policy: { v: 2 } }] } };
      }
      if (url.endsWith('/v1/account/encryption/currentness')) {
        floorStarted = true;
        return { status: 200, data: { mode: 'plain', version: 1, settingsVersion: 2,
          signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      }
      if (url.endsWith('/v2/account/settings')) {
        settingsReads++;
        return { status: 200, data: { content: { t: 'plain', v: {} }, version: 2 } };
      }
      throw new Error(`Unexpected requester HTTP read ${url}`);
    });
    const input = { authorization: { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'plain' as const } },
      credentials: { token: 'bob', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => true };
    const pending = requesterAccountOwner.admitRequesterAccountActionContext(input);
    try {
      await vi.waitFor(() => expect(profileStarted).toBe(true));
      expect(floorStarted).toBe(false);
      expect(settingsReads).toBe(0);
    } finally {
      releaseProfile();
      const admitted = await pending;
      try { expect(admitted?.accountSettingsContext.settingsVersion).toBe(2); }
      finally { await admitted?.dispose(); }
    }
    settingsReads = 0;
    reads.mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'another-account' } };
      if (url.endsWith('/v1/account/encryption/currentness')) throw new Error('Unavailable Settings floor');
      settingsReads++;
      throw new Error('Identity must be admitted before opening Settings');
    });
    await expect(requesterAccountOwner.admitRequesterAccountActionContext(input)).resolves.toBeNull();
    expect(settingsReads).toBe(0);
    expect(floorStarted).toBe(true);
  });

  it('cancels the held Settings HTTP read when finite requester admission is aborted', async () => {
    let settingsStarted!: () => void;
    const requested = new Promise<void>(resolve => { settingsStarted = resolve; });
    let releaseSettings: (() => void) | undefined;
    let settingsClosed = false;
    const home = createServer((request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/v1/account/profile') response.end(JSON.stringify({ id: 'bob' }));
      else if (request.url === '/v1/account/encryption/currentness') response.end(JSON.stringify({ mode: 'plain',
        version: 1, settingsVersion: 1, updatedAt: 1, signingKeyFingerprint: null, contentKeyFingerprint: null }));
      else if (request.url === '/v2/account/settings') {
        // A real Axios request owns this TCP response; no private body is released before abort.
        response.once('close', () => { settingsClosed = true; });
        response.flushHeaders();
        releaseSettings = () => { response.end(JSON.stringify({ content: { t: 'plain', v: {} }, version: 1 })); };
        settingsStarted();
      } else { response.statusCode = 404; response.end('{}'); }
    });
    await new Promise<void>(resolve => home.listen(0, '127.0.0.1', resolve));
    const address = home.address();
    if (!address || typeof address === 'string') throw new Error('Missing finite requester Home address');
    const caller = new AbortController();
    const custody: { cleanup?: () => Promise<void> } = {};
    const admission = requesterAccountOwner.admitRequesterAccountActionContext({
      authorization: { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'plain' } },
      credentials: { token: 'bob', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: `http://127.0.0.1:${address.port}`, signal: caller.signal, isCurrent: async () => true,
    }).then(result => { custody.cleanup = result?.dispose; return { admitted: result !== null }; },
      () => ({ admitted: false }));
    try {
      await Promise.race([requested, admission.then(() => { throw new Error('Admission ended before the held Settings request'); })]);
      caller.abort();
      await vi.waitFor(() => expect(settingsClosed).toBe(true));
      await expect(admission).resolves.toEqual({ admitted: false });
    } finally {
      caller.abort();
      releaseSettings?.();
      await admission;
      await custody.cleanup?.();
      home.closeAllConnections();
      await new Promise<void>((resolve, reject) => home.close(error => error ? reject(error) : resolve()));
    }
  });

  it('opens the immutable opinion root and proves the creator-bound current model slot for public spawn and read-only preflight', async () => {
    const launch = { executionTarget: { serverId: 'home-profile', machineId: 'model-machine' },
      directory: { kind: 'path', path: '/reviewed' },
      agentTarget: { kind: 'agent', identity: { pluginId: 'happier.agent.codex', localId: 'codex' } } } as const;
    const source = { kind: 'session', message: { kind: 'session', session: { serverId: 'home-profile', sessionId: 'source-session' }, messageId: 'answer' } } as const;
    const reviewer = { selection: { kind: 'model', launch }, participantSlotId: 'reviewed-slot', sourceAccess: 'read' } as const;
    const input = { intent: 'ask', source, title: 'Review', question: 'Check this', reviewers: [reviewer],
      retry: { creationLocalId: 'opinion-create', quoteLocalId: 'opinion-quote', questionLocalId: 'opinion-question' },
      confirmedPreview: { source, sourceAudienceAccountIds: ['bob'], sourceContentReady: true,
        discussionAudienceAccountIds: ['bob'], missingDiscussionSourceAccountIds: [], discussionDisclosure: { ok: true }, canGrantSource: true,
        reviewers: [{ ...reviewer, runtimeAccountId: 'bob', audienceAccountIds: ['bob'], missingSourceAccountIds: [],
          canGrantSource: true, disclosure: { ok: true } }] } };
    const envelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: 'reviewed-opinion',
      target: { kind: 'machine', machineId: 'source-machine' }, input });
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'opinion-root', binding: {
      accountId: 'bob', custodianAccountId: 'source-owner', authentication: { kind: 'account', tokenEpoch: 1 },
      serverIdentityId: 'stable-home', machineId: 'source-machine', installationId: 'source-installation', accountEncryptionMode: 'plain',
      actionId: 'discussion.second_opinion.start', requestId: envelope.requestId, target: envelope.target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
    } });
    let current = true, archivedAt: number | null = null, creationLocalId = input.retry.creationLocalId;
    let slotPath: string = launch.directory.path;
    const summary = () => ({ id: 'created-opinion', ownerAccountId: 'bob', encryptionMode: 'plain', anchor: null,
      access: 'owner', keyReadiness: true, dataEncryptionKey: null, creationLocalId,
      titleContent: { t: 'plain', v: { v: 1, title: 'Review' } },
      latestMessage: { id: 'quote', localId: 'opinion-quote', seq: 1, authorAccountId: null, accountActor: null, producerV1: null, createdAt: 1 },
      messageSeq: 1, lastReadSeq: 0, unreadCount: 0, unreadMentionCount: 0, recentAuthorAccountIds: [], archivedAt,
      capabilities: { postMessages: true, rename: true, archive: true, restore: false, askAgent: true, sendToSession: true, manageAccess: true, leave: false } });
    // HTTP and current installed custody are the boundaries; original-envelope
    // opening, strict child derivation and the retained Account owner stay real.
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.endsWith('/v1/discussions?creationLocalId=opinion-create')) return { status: 200, data: { discussions: [summary()], nextCursor: null } };
      if (url.endsWith('/v1/discussions/created-opinion')) return { status: 200, data: { discussion: summary() } };
      if (url.endsWith('/v1/discussions/created-opinion/participants')) return { status: 200, data: {
        discussionId: 'created-opinion', ownerAccountId: 'bob', access: 'owner', grants: [], participants: [{
          participant: { kind: 'model', participantSlotId: 'reviewed-slot' }, sessionId: null, createdAt: 1,
          answerPolicy: 'when_addressed', launch: { ...launch, directory: { kind: 'path', path: slotPath } } }] } };
      throw new Error(`Unexpected opinion custody HTTP ${url}`);
    });
    const admit = () => requesterAccountOwner.admitRequesterAccountActionContext({ authorization: root,
      credentials: { token: 'bob-private', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => current });
    const admitted = await admit();
    if (!admitted) throw new Error('Missing opinion requester custody');
    const spawn = { ...launch, creationKey: 'reviewed-slot', initialTriggers: [],
      discussionParticipant: { discussionId: 'created-opinion', participantSlotId: 'reviewed-slot' } };
    const verify = (params: unknown = spawn, method: string = RPC_METHODS.SESSION_SPAWN_NEW, original: unknown = envelope) =>
      isReviewedSessionActionCreationChild({ authorization: admitted.authorization, envelope: original,
        machineId: 'model-machine', actionId: 'session.spawn_new', params, method });
    try {
      expect(await verify()).toBe(true);
      expect(await verify({ directory: launch.directory }, RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT)).toBe(true);
      expect(await verify({ ...spawn, initialInput: { text: 'unreviewed work' } })).toBe(false);
      expect(await verify({ ...spawn, creationKey: 'another-slot' })).toBe(false);
      expect(await verify({ directory: { kind: 'path', path: '/unreviewed' } }, RPC_METHODS.DAEMON_SESSION_CREATION_DIRECTORY_PREFLIGHT)).toBe(false);
      expect(await verify(spawn, RPC_METHODS.SPAWN_HAPPY_SESSION)).toBe(false);
      expect(await verify(spawn, RPC_METHODS.SESSION_SPAWN_NEW, { ...envelope, requestId: 'another-root' })).toBe(false);
      creationLocalId = 'unrelated-opinion'; expect(await verify()).toBe(false); creationLocalId = input.retry.creationLocalId;
      archivedAt = 1; expect(await verify()).toBe(false); archivedAt = null;
      slotPath = '/changed'; expect(await verify()).toBe(false); slotPath = launch.directory.path;
      current = false;
      expect(await verify()).toBe(true);
      expect(await admit()).toBeNull();
      current = true;
      const [{ RpcHandlerManager }, machineAdmission] = await Promise.all([
        import('@/api/rpc/RpcHandlerManager'), import('@/api/machine/machineRpcAuthorization'),
      ]);
      const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(51));
      const installation = { version: 1 as const, installationId: 'model-installation', createdAt: 1,
        publicKey: Buffer.from(keys.publicKey).toString('base64url'), privateKey: Buffer.from(keys.secretKey).toString('base64url') };
      vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(installation);
      let nativeAdmissionProofs = 0;
      let withdrawAfterNativeAdmission = false;
      vi.spyOn(axios, 'post').mockImplementation(async url => {
        if (String(url).endsWith('/v1/machines/model-machine/admission/verify')) {
          nativeAdmissionProofs += 1;
          const admitted = current;
          if (withdrawAfterNativeAdmission) current = false;
          return { status: 200, data: { v: 1, ok: admitted } };
        }
        throw new Error(`Unexpected native opinion admission ${url}`);
      });
      const nativeDiagnostics: unknown[] = [];
      const rpc = new RpcHandlerManager({ scopePrefix: 'model-machine', localMachineId: 'model-machine',
        encryptionMode: 'plain', logger: (_message, detail) => { nativeDiagnostics.push(detail); }, authorizeRequest: request => machineAdmission.authorizeMachineRpcRequest(request, {
          machineId: 'model-machine', resolveCustodianAccountId: async () => 'model-owner', resolveInstallationId: () => installation.installationId,
          verifyMachineAdmission: request => machineAdmission.verifyMachineRpcAdmissionCurrent({ ...request,
            privateKey: keys.secretKey, daemonToken: 'model-owner-token', serverHttpBaseUrl: 'https://requester-home.test' }),
        }), prepareRequesterAccountContext: request => requesterAccountOwner.prepareInstalledRequesterAccountActionContext({
          ...request, purpose: request.purpose ?? { kind: 'external_action' }, machineId: 'model-machine',
          serverId: 'home-profile', serverHttpBaseUrl: 'https://requester-home.test',
          resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'model-machine', serverIdentityId: 'stable-home' }),
          createExecutor: () => ({ execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) }),
        }) });
      let effects = 0;
      rpc.registerHandler(RPC_METHODS.SESSION_SPAWN_NEW, async (_value, context) => {
        if (!context) throw new Error('Missing native custody');
        const creation = createReviewedSecondOpinionSessionCreationAuthorization({ context: {
          ...context, externalActionExecutionAuthorization: context.callerInputAuthorization,
          originalActionEnvelope: context.workspaceSyncSourceExecution?.originalActionEnvelope,
        }, publicInput: SessionSpawnNewInputV2Schema.parse(_value), installationId: installation.installationId, privateKey: keys.secretKey });
        expect(creation?.token).toBe(root.token);
        const body = { originKind: 'discussion', discussionParticipant: spawn.discussionParticipant,
          discussionParticipantLaunch: launch, tag: deriveSessionCreationTagV1({
            callerCreationNamespace: JSON.stringify(['discussion-participant', spawn.discussionParticipant.discussionId]),
            creationKey: spawn.discussionParticipant.participantSlotId }) };
        const proof = await creation?.prepareRequestProof?.(body);
        expect(proof).toBeTruthy();
        if (!proof) throw new Error('Missing selected receiver proof');
        const payload = buildDiscussionModelSessionCreationProofPayloadV1({ ...proof, body });
        expect(verifyMachineInstallationProof({ publicKey: keys.publicKey, proof: proof.proof, payload })).toBe(true);
        expect(verifyMachineInstallationProof({ publicKey: keys.publicKey, proof: proof.proof,
          payload: buildDiscussionModelSessionCreationProofPayloadV1({ ...proof, body: { ...body, tag: 'another-session' } }) })).toBe(false);
        await expect(creation?.prepareRequestProof?.({ ...body, discussionParticipantLaunch: { ...launch,
          directory: { kind: 'path', path: '/unreviewed' } } })).rejects.toThrow();
        effects += 1;
        return { accepted: true, rootAction: context?.callerInputAuthorization?.binding.actionId };
      });
      const native = async (value: unknown) => {
        const method = `model-machine:${RPC_METHODS.SESSION_SPAWN_NEW}`;
        const sealed = sealExternalActionRequesterAccountContextV1({ authorization: root,
          purpose: { kind: 'machine_rpc', method: RPC_METHODS.SESSION_SPAWN_NEW, params: value,
            recipient: { machineId: 'model-machine', installationId: installation.installationId } },
          credentials: { token: 'bob-private', secret: null, encryption: null },
          installationPublicKey: keys.publicKey, randomBytes: nacl.randomBytes });
        const execution = createExternalActionMachineRpcExecution({ context: { externalActionExecutionAuthorization: sealed,
          externalActionTarget: root.binding.target }, effectActionId: 'session.spawn_new', installationId: root.binding.installationId,
          method, requestId: 'native-opinion', params: value, privateKey: nacl.sign.keyPair().secretKey });
        if (!execution) throw new Error('Missing installed source proof');
        return rpc.handleRequest({ method, params: value, requestId: 'native-opinion', originalActionEnvelope: envelope,
          callerAuthority: 'present_user', callerInputAuthorization: sealed,
          workspaceSyncSourceExecution: { method, params: StrictJsonValueSchema.parse(value), requestId: 'native-opinion', originalActionEnvelope: envelope,
            externalActionExecution: execution }, machineAdmission: { actorAccountId: 'bob', custodianAccountId: 'model-owner',
            machineId: 'model-machine', installationId: installation.installationId, role: 'use', encryptionMode: 'plain' } });
      };
      expect(await native(spawn), JSON.stringify(nativeDiagnostics)).toEqual({ accepted: true, rootAction: 'discussion.second_opinion.start' });
      expect(nativeAdmissionProofs).toBe(1);
      expect(await native({ ...spawn, initialInput: { text: 'unreviewed work' } })).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
      expect(effects).toBe(1);
      withdrawAfterNativeAdmission = true;
      const beforeWithdrawal = nativeAdmissionProofs;
      expect(await native(spawn)).toEqual({ accepted: true, rootAction: 'discussion.second_opinion.start' });
      expect(nativeAdmissionProofs - beforeWithdrawal).toBe(1);
      expect(await native(spawn)).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
      expect(effects).toBe(2);
    } finally { await admitted.dispose(); }
  });
  it.each([
    { mode: 'plain', failure: 'network', expected: 'project_requester_home_unavailable' },
    { mode: 'e2ee', failure: 'network', expected: 'project_requester_home_unavailable' },
    { mode: 'plain', failure: 'authentication', expected: 'invalid_envelope' },
    { mode: 'e2ee', failure: 'authentication', expected: 'invalid_encrypted_envelope' },
    { mode: 'plain', failure: 'authorization', expected: 'invalid_token' },
    { mode: 'e2ee', failure: 'authorization', expected: 'invalid_token' },
  ] as const)('preserves unavailable Home admission without accepting refused custody ($mode/$failure)', async ({ mode, failure, expected }) => {
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(45));
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'bob', tokenEpoch: 7,
      provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.signature`;
    const credentials: StoredCredentials = { token,
      encryption: mode === 'plain' ? null : { type: 'legacy', secret: new Uint8Array(32).fill(46) } };
    const target = { kind: 'session' as const, sessionId: 'c123456789012345678901234' };
    const executor = createActionExecutor(createUnavailableActionTransportDeps());
    const input = { sessionId: target.sessionId, message: 'Correction', localId: 'correction', modelOverride: 'claude-haiku-4-5' };
    const failures: string[] = [];
    // Only Home HTTP is substituted. The real CLI producer, strict envelope
    // consumer and private requester admission run together before any effect.
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode, updatedAt: 1 } };
      if (url.endsWith('/v1/account/profile')) {
        if (failure === 'authentication') return { status: 401, data: { error: 'invalid_token' } };
        throw new axios.AxiosError('Home read unavailable', 'ECONNRESET');
      }
      throw new Error('Unexpected Home read');
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      if (url.endsWith('/verify')) return failure === 'authorization'
        ? { status: 401, data: { error: 'invalid_token', authorizationRefusal: 'machine_admission_after_principal' } }
        : { status: 200, data: { ok: true } };
      const envelope = ExternalActionRequestEnvelopeSchema.parse(raw);
      expect(envelope.v).toBe(mode === 'plain' ? 1 : 2);
      const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'send-root', binding: {
        accountId: 'bob', custodianAccountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 },
        accountEncryptionMode: mode, serverIdentityId: 'srv_fx45_home', machineId: 'machine', installationId: 'installation',
        actionId: 'session.message.send', requestId: envelope.requestId, target,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      } });
      if (envelope.v === 2) {
        if (credentials.encryption?.type !== 'legacy') throw new Error('Expected fixture encryption material');
        expect(openExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, envelope, binding: { serverIdentityId: 'srv_fx45_home', accountId: 'bob',
          authentication: { kind: 'account', tokenEpoch: 7 }, actionId: 'session.message.send', requestId: 'correction', target },
          material: { type: 'dataKey', machineKey: deriveAccountMachineKeyFromRecoverySecret(credentials.encryption.secret) } }))
          .toEqual({ input });
      } else expect(envelope.input).toEqual(input);
      const result = await executeExternalAction({ actionId: root.binding.actionId, envelope,
        principal: { accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 7 }, authority: 'present_user' },
        currentMachineId: 'machine', currentServerId: 'home-profile', currentInstallationId: 'installation',
        executionAuthorization: root, externalActionMachineRequestPrivateKey: keys.secretKey,
        verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
          installationId: 'installation', privateKey: keys.secretKey, serverHttpBaseUrl: 'https://requester-home.test' }),
        prepareRequesterAccountContext: request => requesterAccountOwner.prepareRequesterAccountActionContext({
          authorization: request.authorization, purpose: { kind: 'external_action' }, machineId: 'machine',
          installationId: 'installation', installationPrivateKey: keys.secretKey, serverId: 'home-profile',
          serverIdentityId: 'srv_fx45_home', serverHttpBaseUrl: 'https://requester-home.test', ownCredentials: credentials,
          isCurrent: () => verifyExternalActionExecutionAuthorizationCurrent({ authorization: request.authorization,
            effectActionId: root.binding.actionId, target, installationId: 'installation',
            privateKey: keys.secretKey, serverHttpBaseUrl: 'https://requester-home.test' }), createExecutor: () => executor,
        }), executor,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials }),
      });
      if (result.kind !== 'invalid_request') throw new Error('Unavailable admission must refuse before the effect');
      failures.push(result.errorCode);
      const projected = projectExternalActionHttpError(result.errorCode, envelope.requestId);
      return { status: projected.statusCode, data: projected.payload };
    });
    expect(await dispatchOriginalAccountAction({ actionId: 'session.message.send', input, requestId: 'correction', target,
      credentials, serverIdentityId: 'srv_fx45_home', serverHttpBaseUrl: 'https://requester-home.test' }))
      .toEqual({ ok: false, errorCode: expected, error: expected,
        ...(failure === 'authorization' ? {} : { requestId: 'correction' }) });
    expect(failures).toEqual([expected]);
  });
  it.each(['projects.prepare', 'projects.script.run', 'projects.compute.exec', 'projects.inspect', 'projects.worker.status', 'localServices.launcher.start',
    'machines.terminal.open', 'machines.terminal.restart', 'execution.run.start', 'execution.run.ensure', 'execution.run.send', 'execution.run.ensure_or_start'] as const)('uses retained requester custody only for private Project preparation reads on %s', async actionId => {
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'finite-root', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation',
      actionId, requestId: 'finite-request', requestEnvelopeDigest: 'a'.repeat(43), target: { kind: 'machine', machineId: 'machine' },
    } });
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error('Unexpected requester read');
    });
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    const admitted = await requesterAccountOwner.admitRequesterAccountActionContext({ authorization: root,
      credentials: { token: 'bob-preparation', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => true });
    if (!admitted) throw new Error('Missing admitted requester custody');
    const input = { serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
      target: root.binding.target, installationId: 'installation', privateKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31)).secretKey };
    try {
      const carrier = await projectExternalActionRequesterHttpAuthorization({ ...input, authorization: admitted.authorization });
      if (!carrier?.requesterHttpProjection) throw new Error('Missing requester HTTP port');
      if (actionId === 'machines.terminal.open' || actionId === 'machines.terminal.restart') {
        const workspace = { id: 'bob-checkout', serverId: input.serverId, machineId: 'machine', rootPath: '/bob/repo',
          projectKey: 'bob-project', createdAtMs: 1 };
        const rows = [createPlainProjectAccountRefRow(workspace)];
        // A terminal effect proof does not grant private Account-row reads.
        vi.mocked(axios.post).mockImplementation(async (url, body, options) => {
          if (String(url).includes('/v1/account/project-rows/')) {
            if (options?.headers?.Authorization !== 'Bearer bob-preparation') return { status: 403, data: { error: 'forbidden' } };
            return projectAccountRowsReadHttpResponse(rows, String(url), body);
          }
          return { status: 200, data: { ok: true } };
        });
        const accepted = { authorization: carrier, effectActionId: actionId, serverId: input.serverId,
          serverHttpBaseUrl: input.serverHttpBaseUrl, address: { serverId: input.serverId,
            workspaceId: workspace.id, machineId: workspace.machineId, rootPath: workspace.rootPath } };
        await expect(resolveProjectSetupAcceptedWorkspace(accepted)).resolves.toEqual({ workspace,
          project: { serverId: workspace.serverId, projectId: workspace.projectKey } });
        await expect(resolveProjectSetupAcceptedWorkspace({ ...accepted, address: { ...accepted.address, workspaceId: 'alice-checkout' } }))
          .rejects.toMatchObject({ code: 'project_workspace_unavailable' });
        await expect(resolveProjectSetupAcceptedWorkspace({ ...accepted, address: { ...accepted.address, machineId: 'foreign-machine' } }))
          .rejects.toMatchObject({ code: 'project_workspace_changed' });
      }
      const headers = (method: string, path: string) => carrier.requesterHttpProjection!.createRequestHeaders({ effectActionId: actionId, method, path });
      const machineRead = await headers('GET', '/v1/machines/source-machine');
      if (actionId === 'projects.prepare' || actionId === 'projects.inspect'
        || actionId === 'machines.terminal.open' || actionId === 'machines.terminal.restart') {
        expect(machineRead).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token });
      } else expect(machineRead).toEqual({ Authorization: 'Bearer bob-preparation' });
      for (const path of ['/v1/account/project-rows/read', '/v1/account/project-rows/list']) {
        expect(await headers('POST', path)).toEqual({ Authorization: 'Bearer bob-preparation' });
        expect(await carrier.requesterHttpProjection.createRequestHeaders({ effectActionId: 'projects.open', method: 'POST', path }))
          .toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token });
        expect(await headers('GET', path)).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token });
      }
      for (const [method, path] of [['GET', '/v1/machines/machine'], ['POST', '/v1/machines/source-machine'],
        ['GET', '/v1/account/profile'], ['POST', '/v1/account/project-rows/mutate'],
        ['POST', '/v1/account/project-trust/read'], ['POST', '/v1/projects/execution/config/read']] as const) {
        const signed = await headers(method, path);
        if (actionId.startsWith('execution.run.') && (method === 'GET' && path === '/v1/machines/machine'
          || method === 'POST' && (path === '/v1/account/project-trust/read' || path === '/v1/projects/execution/config/read'))) {
          expect(signed).toEqual({ Authorization: 'Bearer bob-preparation' });
          continue;
        }
        expect(signed).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token });
        expect(signed).not.toHaveProperty('Authorization');
      }
      const wire = await projectExternalActionRequesterHttpAuthorization({ ...input, authorization: root });
      expect(await wire?.requesterHttpProjection?.createRequestHeaders({ effectActionId: actionId, method: 'GET', path: '/v1/machines/source-machine' }))
        .toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token });
      expect(await wire?.requesterHttpProjection?.createRequestHeaders({ effectActionId: actionId, method: 'POST', path: '/v1/account/project-rows/list' }))
        .toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token });
      const rpc = createExternalActionMachineRpcExecution({ context: { externalActionExecutionAuthorization: carrier, externalActionTarget: root.binding.target },
        installationId: input.installationId, privateKey: input.privateKey, effectActionId: actionId,
        method: 'machine:projects.worker.status', requestId: 'rpc-read', params: {} });
      expect(rpc).not.toBeNull();
      expect(JSON.stringify(rpc)).not.toContain('bob-preparation');
      expect(JSON.stringify(rpc)).not.toContain('requesterHttpProjection');
      await admitted.dispose();
      expect(await headers('GET', '/v1/machines/source-machine')).toBeNull();
      expect(await headers('POST', '/v1/account/project-rows/list')).toBeNull();
    } finally { await admitted.dispose(); }
  });
  it('publishes retained finite requester Settings over envelopes, hints and reconnect without per-Action reads', async () => {
    let version = 1;
    let settings = { experiments: false };
    let reads = 0;
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) {
        reads++;
        return { status: 200, data: { content: { t: 'plain', v: settings }, version } };
      }
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error('Unexpected private requester read');
    });
    const context = await requesterAccountOwner.admitRequesterAccountActionContext({
      authorization: { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'plain', admittedMachineRole: 'use' } },
      credentials: { token: 'bob-settings', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => true,
    });
    if (!context) throw new Error('Missing requester custody');
    // Native-source acquisition consumes the signed Machine grant (SEC-BATCH-1101 S1).
    expect(context.savedSecretOperationContext.machineAdmission)
      .toEqual({ actorAccountId: 'bob', custodianAccountId: 'alice', role: 'use' });
    const release = context.retain();
    try {
      expect(await context.refreshAccountSettings()).toBe(true);
      const initialReads = reads;
      expect(await context.refreshAccountSettings()).toBe(true);
      expect(reads).toBe(initialReads);
      await context.dispose();
      settings = { experiments: true };
      version++;
      await channel.pushSettings('bob', settings, version);
      expect(await context.refreshAccountSettings()).toBe(true);
      expect(context.savedSecretOperationContext.readSnapshot()).toMatchObject({ settingsVersion: version, settings });
      expect(reads).toBe(initialReads);
      await channel.pushSettings('other-account', {}, version + 100);
      expect(await context.refreshAccountSettings()).toBe(true);
      expect(reads).toBe(initialReads);
      version++;
      await channel.hintSettings(version);
      expect(await context.refreshAccountSettings()).toBe(true);
      expect(context.savedSecretOperationContext.readSnapshot()?.settingsVersion).toBe(version);
      expect(reads).toBe(initialReads + 1);
      const beforeInvalid = context.savedSecretOperationContext.readSnapshot();
      await channel.pushInvalidSettings('bob');
      expect(context.savedSecretOperationContext.readSnapshot()).toEqual(beforeInvalid);
      expect(await context.refreshAccountSettings()).toBe(true);
      expect(reads).toBe(initialReads + 2);
      expect(context.savedSecretOperationContext.readSnapshot()).toMatchObject({ settingsVersion: version, settings });
      await channel.pushSettings('bob', settings, ++version);
      expect(await context.refreshAccountSettings()).toBe(true);
      await channel.disconnect();
      await expect(context.refreshAccountSettings()).rejects.toMatchObject({ retryable: true });
      version++;
      await channel.reconnect();
      expect(await context.refreshAccountSettings()).toBe(true);
      expect(context.savedSecretOperationContext.readSnapshot()?.settingsVersion).toBe(version);
    } finally { await context.dispose(); await release(); }
    expect(await context.refreshAccountSettings()).toBe(false);
    expect(context.savedSecretOperationContext.readSnapshot()).toBeNull();
  });
  it.each([
    ['daemon', new URL('../startDaemon.ts', import.meta.url)],
    ['Machine Session handlers', new URL('../../api/apiMachine.ts', import.meta.url)],
  ])('admits installed E2EE custody through the %s runtime HTTP origin in a non-default home', async (_name, sourcePath) => {
    // Generated fixtures only: no installed user identity, Account or endpoint is read.
    const home = mkdtempSync(join(tmpdir(), 'happier-fx18-runtime-origin-'));
    const previous = { happyHomeDir: configuration.happyHomeDir,
      installationIdentityFile: configuration.installationIdentityFile,
      serverUrl: configuration.serverUrl, apiServerUrl: configuration.apiServerUrl };
    const secret = nacl.randomBytes(32);
    const credentials: StoredCredentials = { token: 'fx18-test-requester', encryption: { type: 'legacy', secret } };
    const settings = { experiments: true };
    const settingsContent = { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings',
      material: { type: 'legacy', secret }, payload: settings, randomBytes: nacl.randomBytes }) };
    const currentness = { mode: 'e2ee', version: 1, signingKeyFingerprint: 'test-signing',
      contentKeyFingerprint: computeAccountEncryptionMigrateKeyFingerprintV1(nacl.box.keyPair.fromSecretKey(
        deriveAccountMachineKeyFromRecoverySecret(secret)).publicKey), updatedAt: 1 };
    const features = FeaturesResponseSchema.parse({ features: {},
      capabilities: { serverIdentity: { serverIdentityId: 'srv_fx18_test_home' } } });
    const requestedPaths: string[] = [];
    const http = createServer((request, response) => {
      requestedPaths.push(request.url ?? '');
      response.setHeader('Content-Type', 'application/json');
      const data = request.url === '/v1/features' ? features
        : request.url === '/v1/account/profile' ? { id: 'bob' }
        : request.url === '/v1/account/encryption/currentness' ? currentness
        : request.url === '/v2/account/settings' ? { content: settingsContent, version: 1 }
        : request.url?.endsWith('/verify') ? { ok: true } : null;
      response.statusCode = data ? 200 : 404;
      response.end(JSON.stringify(data));
    });
    let release: (() => void) | undefined;
    let prepared: Awaited<ReturnType<typeof requesterAccountOwner.prepareInstalledRequesterAccountActionContext>> = null;
    const phaseLog = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    try {
      // Close an ephemeral listener to obtain a genuinely unreachable canonical address.
      await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
      const canonicalAddress = http.address();
      if (!canonicalAddress || typeof canonicalAddress === 'string') throw new Error('Missing test listener');
      const canonical = `http://127.0.0.1:${canonicalAddress.port}`;
      await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
      await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
      const runtimeAddress = http.address();
      if (!runtimeAddress || typeof runtimeAddress === 'string') throw new Error('Missing test listener');
      const runtime = `http://127.0.0.1:${runtimeAddress.port}`;
      Object.assign(configuration, { happyHomeDir: home, installationIdentityFile: join(home, 'installation-identity.json'),
        serverUrl: canonical, apiServerUrl: canonical });
      const installation = installationStore.readOrCreateInstallationIdentitySync();
      release = publishServerHttpRuntimeOrigin(runtime, 'iroh');
      const material = { type: 'dataKey' as const, machineKey: deriveAccountMachineKeyFromRecoverySecret(secret) };
      const binding = { accountId: 'bob', credentialId: '00000000-0000-4000-8000-000000000018', actionId: 'browser.diagnostics.snapshot',
        requestId: 'fx18-test-request', serverIdentityId: 'srv_fx18_test_home', target: { kind: 'machine' as const, machineId: 'machine' } };
      const envelope = sealExternalActionRequestV2({ projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1, binding, material, randomBytes: nacl.randomBytes,
        input: { browserSessionId: 'test-browser', viewId: 'test-view' } });
      const grant = ApiTokenGrantV1Schema.parse({ v: 1, actions: { families: [], ids: [binding.actionId] },
        targets: { sessions: [], machines: ['machine'] }, approve: false, origins: [], models: null,
        permissionModes: null, create: null });
      const root = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization, binding: { ...authorization.binding,
        ...binding, grant, installationId: installation.installationId, accountEncryptionMode: 'e2ee',
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } });
      const purpose = { kind: 'external_action' } as const;
      const sealed = sealExternalActionRequesterAccountContextV1({ authorization: root, purpose,
        credentials: encodeStoredCredentials(credentials), installationPublicKey: Buffer.from(installation.publicKey, 'base64url'),
        randomBytes: nacl.randomBytes });
      // Exercise the exact production initializer without starting a daemon or its background services.
      // This remains sensitive to either call site being wired to the canonical identity address.
      const source = readFileSync(sourcePath, 'utf8');
      const initializer = source.match(/const resolveCurrentMachineExecutionOriginContext\s*=\s*(createCurrentMachineExecutionOriginContextResolver\(\{[\s\S]*?\}\));/u)?.[1];
      if (!initializer) throw new Error('Missing production origin composition');
      // The daemon shares this lexical resolver with its Machine target owner;
      // evaluate its production body too rather than replacing it in the fixture.
      const homeIdentityHelper = source.match(/const resolveBoundHomeServerIdentityId = \(\) => \{[\s\S]*?\n {4}\};/u)?.[0] ?? '';
      const homeTransportCancellation = new AbortController();
      const serverFeaturesSnapshotStore = createServerUrlServerFeaturesSnapshotStore({
        serverUrl: resolveServerHttpBaseUrl(), token: credentials.token,
      });
      await serverFeaturesSnapshotStore.refresh();
      const resolveOrigin = new Function('createCurrentMachineExecutionOriginContextResolver', 'configuration',
        'readManagedPolicyServerHttpBaseUrl', 'readMachineRuntimeServerHttpBaseUrl', 'machineId', 'homeTransportCancellation', 'homeTarget', 'serverFeaturesSnapshotStore',
        `${homeIdentityHelper}\nreturn ${initializer};`).call({ machine: { id: 'machine' }, lifecycleDependencies: {} },
          createCurrentMachineExecutionOriginContextResolver, configuration, resolveServerHttpBaseUrl, resolveServerHttpBaseUrl, 'machine',
          homeTransportCancellation, { homeServerIdentityId: null }, serverFeaturesSnapshotStore) as
          ReturnType<typeof createCurrentMachineExecutionOriginContextResolver>;
      const executor = createActionExecutor(createUnavailableActionTransportDeps());
      prepared = await requesterAccountOwner.prepareInstalledRequesterAccountActionContext({ authorization: sealed, purpose,
        machineId: 'machine', serverId: 'fx18-test-profile', serverHttpBaseUrl: resolveServerHttpBaseUrl(),
        resolveCurrentMachineExecutionOriginContext: resolveOrigin, createExecutor: () => executor });
      const phases = phaseLog.mock.calls.map(([, value]) => (value as { phase?: string }).phase);
      expect(phases).not.toContain('requester_origin_unavailable');
      expect(Boolean(prepared)).toBe(true);
      const custody = requesterAccountOwner.readRequesterAccountActionContext(prepared?.authorization);
      expect(custody?.accountSettingsContext.source).toBe('network');
      expect(custody?.accountSettingsContext.settings.experiments).toBe(true);
      expect(prepared?.authorization.requesterAccountProjection?.accountEncryptionMode).toBe('e2ee');
      expect(await custody?.isCurrent()).toBe(true);
      const result = await executeExternalAction({ actionId: binding.actionId, envelope,
        principal: { accountId: 'bob', principalId: 'bob', credentialId: binding.credentialId, grant, authority: 'account_automation' },
        currentMachineId: 'machine', currentServerId: 'fx18-test-profile', currentInstallationId: installation.installationId,
        executionAuthorization: sealed, externalActionMachineRequestPrivateKey: installation.privateKey,
        verifyExecutionAuthorization: request => verifyExternalActionExecutionAuthorizationCurrent({ ...request,
          installationId: installation.installationId, privateKey: installation.privateKey, serverHttpBaseUrl: resolveServerHttpBaseUrl() }),
        prepareRequesterAccountContext: request => requesterAccountOwner.prepareInstalledRequesterAccountActionContext({
          authorization: request.authorization, purpose, machineId: 'machine', serverId: 'fx18-test-profile',
          serverHttpBaseUrl: resolveServerHttpBaseUrl(), resolveCurrentMachineExecutionOriginContext: resolveOrigin,
          createExecutor: () => executor }),
        resolveTarget: async () => binding.target, executor });
      expect(result.kind).toBe('response');
      if (result.kind !== 'response') throw new Error('Test diagnostics request failed before dispatch');
      // No Browser host is installed in this fixture: preserve the real, protected typed refusal.
      expect(openExternalActionResponseV2({ envelope: result.response, request: envelope, binding, material }))
        .toMatchObject({ ok: false, errorCode: 'unsupported_action' });
      expect(requestedPaths).toContain('/v1/features');
      expect(requestedPaths).toContain('/v2/account/settings');
      expect(requestedPaths.some(path => path.endsWith('/verify'))).toBe(true);
      expect(await prepared?.authorization.requesterHttpProjection?.createRequestHeaders({
        effectActionId: root.binding.actionId, method: 'POST', path: '/v1/account/project-rows/list',
      })).toHaveProperty(EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER);
    } finally {
      await prepared?.dispose();
      release?.();
      Object.assign(configuration, previous);
      http.closeAllConnections();
      await new Promise<void>(resolve => http.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('identifies a missing installation without obscuring it as an origin refusal', async () => {
    const home = mkdtempSync(join(tmpdir(), 'happier-fx18-missing-installation-'));
    const previous = configuration.installationIdentityFile;
    Object.assign(configuration, { installationIdentityFile: join(home, 'installation-identity.json') });
    const phaseLog = vi.spyOn(logger, 'warnLocalFile').mockImplementation(() => {});
    try {
      expect(await requesterAccountOwner.prepareInstalledRequesterAccountActionContext({
        authorization, purpose: { kind: 'external_action' }, machineId: 'machine', serverId: 'home-profile',
        serverHttpBaseUrl: '', resolveCurrentMachineExecutionOriginContext: async () => null,
        createExecutor: () => { throw new Error('Missing installation cannot execute'); },
      })).toBeNull();
      expect(phaseLog).toHaveBeenCalledWith('[external-action-phase]', expect.objectContaining({
        machineId: 'machine', phase: 'requester_installation_missing',
      }));
    } finally {
      Object.assign(configuration, { installationIdentityFile: previous });
      rmSync(home, { recursive: true, force: true });
    }
  });
  it.each([
    'projects.service.relocate',
    'execution.run.start',
    'scm.diffSummary.generate',
    'scm.diffSummary.draftPullRequest',
    'scm.diffSummary.refine',
    'scm.diffSummary.addOutputs',
    'scm.diffSummary.discuss',
  ] as const)('uses local %s custody for private native preparation reads without spending its fresh SOURCE proof', async rootActionId => {
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'local-move-root', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: 'stable-home', machineId: 'source', installationId: 'source-installation',
      actionId: rootActionId, requestId: 'move', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'source' },
    } });
    // Home HTTP and installed authority observations are the boundaries; custody stays real.
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      throw new Error('Unexpected requester read');
    });
    let sourceCurrent = true;
    let custodyCurrent = true;
    const admitted = await requesterAccountOwner.admitRequesterAccountActionContext({ authorization: root,
      credentials: { token: 'bob-local-private', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => sourceCurrent,
      isCustodyCurrent: async () => custodyCurrent });
    if (!admitted) throw new Error('Missing local Move custody');
    try {
      const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
        serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
        target: root.binding.target, installationId: 'source-installation', privateKey: nacl.sign.keyPair().secretKey });
      const http = carrier?.requesterHttpProjection;
      if (!http) throw new Error('Missing local Move HTTP port');
      const read = () => http.createRequestHeaders({ effectActionId: root.binding.actionId,
        method: 'POST', path: '/v1/account/project-rows/list' });
      sourceCurrent = false;
      // Admission spent the root proof; this finite operation keeps local custody.
      expect(await admitted.isCurrent()).toBe(true);
      expect(await admitted.isCustodyCurrent?.()).toBe(true);
      const readHeaders = await read();
      expect(Object.keys(readHeaders ?? {})).toEqual(['Authorization']);
      expect(readHeaders?.Authorization === 'Bearer bob-local-private').toBe(true);
      custodyCurrent = false;
      expect(await read()).toBeNull();
    } finally { await admitted.dispose(); }
  });

  it('separates installed Move recipient custody from its fresh retained SOURCE proof', async () => {
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(30));
    const installed = { version: 1 as const, installationId: 'recipient-installation', createdAt: 1,
      publicKey: Buffer.from(keys.publicKey).toString('base64url'), privateKey: Buffer.from(keys.secretKey).toString('base64url') };
    const installation = vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(installed);
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'move-root', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: 'stable-home', machineId: 'source', installationId: 'source-installation',
      actionId: 'projects.service.relocate', requestId: 'move', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'source' },
    } });
    const purpose = { kind: 'machine_rpc', method: 'projects.worker.status', params: {},
      recipient: { machineId: 'recipient', installationId: installed.installationId } } as const;
    const sealed = sealExternalActionRequesterAccountContextV1({ authorization: root, purpose,
      credentials: { token: 'bob-private', secret: null, encryption: null }, installationPublicKey: keys.publicKey,
      randomBytes: nacl.randomBytes });
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      throw new Error('Unexpected requester read');
    });
    let sourceCurrent = true;
    const ingress = new AbortController();
    const prepare = () => requesterAccountOwner.prepareInstalledRequesterAccountActionContext({ authorization: sealed, purpose,
      machineId: 'recipient', serverId: 'home-profile', serverHttpBaseUrl: 'https://requester-home.test',
      signal: ingress.signal,
      verifyServiceMoveChildCurrent: async () => sourceCurrent,
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'recipient', serverIdentityId: 'stable-home' }),
      createExecutor: () => ({ execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) }) });
    const prepared = await prepare();
    expect(prepared).not.toBeNull();
    try {
      const custody = requesterAccountOwner.readRequesterAccountActionContext(prepared?.authorization);
      expect(await custody?.isCustodyCurrent?.()).toBe(true);
      expect(installation.mock.calls.length,
        'installation reads follow admitted requests, never retained custody uses').toBe(1);
      expect(await prepared?.authorization.requesterHttpProjection?.createRequestHeaders({ effectActionId: 'localServices.launcher.start',
        method: 'POST', path: '/v1/account/project-rows/list' })).toEqual({ Authorization: 'Bearer bob-private' });
      sourceCurrent = false;
      expect(await custody?.isCurrent()).toBe(false);
      expect(await custody?.isCustodyCurrent?.()).toBe(true);
      expect(await prepared?.authorization.requesterHttpProjection?.createRequestHeaders({ effectActionId: 'localServices.launcher.start',
        method: 'POST', path: '/v1/account/project-rows/list' })).toBeNull();
      sourceCurrent = true;
      installation.mockReturnValue({ ...installed, installationId: 'replaced' });
      expect(await custody?.isCustodyCurrent?.()).toBe(true);
      expect(await custody?.isCurrent()).toBe(true);
      expect(await prepared?.authorization.requesterHttpProjection?.createRequestHeaders({ effectActionId: 'localServices.launcher.start',
        method: 'POST', path: '/v1/account/project-rows/list' })).toEqual({ Authorization: 'Bearer bob-private' });
      expect(installation.mock.calls.length).toBe(1);
      // The next request admits the current installation and refuses this old recipient binding.
      expect(await prepare()).toBeNull();
      expect(installation.mock.calls.length).toBe(2);
      ingress.abort();
      expect(await custody?.isCustodyCurrent?.()).toBe(false);
      expect(installation.mock.calls.length).toBe(2);
    } finally { await prepared?.dispose(); }
  });

  it.each([['account', false], ['terminal', false], ['environment-token', false], ['account', true]] as const)('keeps the %s deployment root on installed receiver HTTP without substituting backing Account authority (semantic=%s)', async (kind, semantic) => {
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
    const installed = { version: 1 as const, installationId: 'receiver-installation', createdAt: 1,
      publicKey: Buffer.from(keys.publicKey).toString('base64url'), privateKey: Buffer.from(keys.secretKey).toString('base64url') };
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(installed);
    const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'member', actionId: 'deployments.deploy',
      machineId: 'receiver', installationId: installed.installationId, phase: 'activate', deploymentId: 'deployment',
      selectedDeploymentId: 'deployment', actionOperationId: 'operation', input: { serverId: 'stable-home', environmentId: 'environment',
        targetLinkId: 'link', expectedRevision: 1, expectedTargetLinkRevision: 1, requestKey: 'request',
        contentArtifactId: 'candidate', contentHeaderVersion: 1, contentBodyVersion: 1 } });
    if (job.kind !== 'member') throw new Error('Expected member deployment fixture');
    const requestId = 'deployment-request';
    const envelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId,
      target: { kind: 'machine', machineId: 'controller' }, input: semantic ? {
        serverId: job.input.serverId, environmentId: job.input.environmentId, targetLinkId: job.input.targetLinkId,
      } : job.input });
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'deployment-root', binding: {
      accountId: 'bob', custodianAccountId: 'controller-owner', accountEncryptionMode: 'plain', serverIdentityId: 'stable-home',
      machineId: 'controller', installationId: 'controller-installation', actionId: 'deployments.deploy', requestId: envelope.requestId,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target: envelope.target,
      deploymentChildRoot: true,
      deploymentCandidatePublication: createDeploymentCandidatePublicationV1({ accountId: 'bob', serverIdentityId: 'stable-home',
        actionId: 'deployments.deploy', requestId,
        requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        environmentId: job.input.environmentId, source: { id: 'source', revision: 1 } }),
      ...(kind === 'environment-token' ? { principalId: 'bob', credentialId: 'environment-token', grant: {
        ...API_TOKEN_FULL_GRANT_V1, actions: { ids: ['deployments.deploy'], families: [] },
        targets: { sessions: [], machines: [], environments: ['environment'] }, approve: false, create: null,
      } } : { authentication: { kind, tokenEpoch: 1 } }),
    } });
    const purpose = { kind: 'machine_rpc', method: RPC_METHODS.DAEMON_DEPLOYMENT_CHILD, params: job,
      recipient: { machineId: 'receiver', installationId: installed.installationId } } as const;
    const sealed = sealExternalActionRequesterAccountContextV1({ authorization: root, purpose,
      credentials: { token: 'bob-private', secret: null, encryption: null }, installationPublicKey: keys.publicKey,
      randomBytes: nacl.randomBytes });
    const packet = { method: `receiver:${RPC_METHODS.DAEMON_DEPLOYMENT_CHILD}`, requestId: 'child-request', params: job,
      originalActionEnvelope: envelope, externalActionExecution: { v: 1 as const, authorization: sealed,
        effectActionId: root.binding.actionId, target: root.binding.target, installationId: root.binding.installationId,
        machineSignature: 'a'.repeat(86), deploymentChildRouting: projectDeploymentChildRoutingV1(job) } };
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      throw new Error('Unexpected requester read');
    });
    let rootCurrent = true;
    const prepare = () => requesterAccountOwner.prepareInstalledRequesterAccountActionContext({ authorization: sealed, purpose,
      deploymentChildExecution: packet, machineId: 'receiver', serverId: 'home-profile', serverHttpBaseUrl: 'https://requester-home.test',
      verifyServiceMoveChildCurrent: async () => rootCurrent,
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'receiver', serverIdentityId: 'stable-home' }),
      createExecutor: () => ({ execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) }) });
    const prepared = await prepare();
    expect(prepared).not.toBeNull();
    try {
      const review = (params: unknown) => isReviewedDeploymentChild({ authorization: prepared!.authorization,
        envelope, actionId: job.actionId, machineId: job.machineId, params });
      expect(await review(job)).toBe(true);
      expect(await review({ ...job, input: { ...job.input, environmentId: 'another-environment' } })).toBe(false);
      expect(await review({ ...job, input: { ...job.input, targetLinkId: 'another-link' } })).toBe(false);
      if (!semantic) expect(await review({ ...job, input: { ...job.input, contentArtifactId: 'another-candidate' } })).toBe(false);
      const path = '/v1/deployments/environments/environment/deployments/deployment/transitions';
      const body = { kind: 'stage', state: 'running', machineId: 'receiver', installationId: installed.installationId, actionOperationId: 'operation' };
      const read = () => prepared?.authorization.requesterHttpProjection?.createRequestHeaders({ effectActionId: 'deployments.deploy', method: 'POST', path, body });
      const headers = await read();
      expect(headers?.Authorization).toBeUndefined();
      expect(headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(root.token);
      const proof = decodeDeploymentChildExecutionV1(headers?.[EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER] ?? '',
        headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]);
      expect(proof?.externalActionExecution.authorization.binding).toEqual(root.binding);
      expect(verifyExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId: 'deployments.deploy',
        target: root.binding.target, installationId: installed.installationId, requestId: root.binding.requestId,
        method: 'POST', path, body, deploymentChildExecution: proof ?? undefined,
        signature: headers?.['x-happier-action-machine-signature'] ?? '', publicKey: keys.publicKey })).toBe(true);
      rootCurrent = false;
      expect((await read())?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(root.token);
      expect(await prepare()).toBeNull();
    } finally { await prepared?.dispose(); }
  });

  it('uses admitted requester E2EE archive custody while the installed receiver keeps its own finite socket identity', async () => {
    const [{ callExactMachineRpc }, { socketRpcCodec }, { SOCKET_RPC_EVENTS }, { sealEncryptedDataKeyEnvelopeV1 },
      { createMachineContentCodec }, { createDeploymentChildRequesterHarness }] = await Promise.all([
      import('@/session/transport/rpc/machineRpc'), import('@happier-dev/sync-client'),
      import('@happier-dev/protocol/socketRpc'), import('@happier-dev/protocol/crypto/encryptedDataKeyEnvelopeV1'),
      import('@/api/machine/machineStoredContent'), import('@/testkit/backends/deploymentChildRequesterHarness'),
    ]);
    const fixture = await createDeploymentChildRequesterHarness();
    const { receiver, installed, secret, bob, ann, machineKey, job, root, envelope } = fixture;
    const archiveOrigin = { environmentId: 'environment', deploymentId: 'deployment',
      holderMachineId: 'holder', holderInstallationId: 'holder-installation' };
    const holderKey = new Uint8Array(32).fill(75);
    const holderCodec = createMachineContentCodec({ encryptionKey: holderKey, encryptionVariant: 'dataKey' });
    if (holderCodec.mode !== 'e2ee') throw new Error('Expected private holder codec');
    const content = { mode: 'e2ee' as const, cipher: {
      encryptRaw: async (value: unknown) => holderCodec.encodeRpc(value),
      decryptRaw: async (value: string) => holderCodec.decodeRpc(value),
    } };
    const publishedKey = Buffer.from(sealEncryptedDataKeyEnvelopeV1({ dataKey: holderKey,
      recipientPublicKey: nacl.box.keyPair.fromSecretKey(machineKey).publicKey, randomBytes: nacl.randomBytes })).toString('base64');
    let machineMode: 'e2ee' | undefined = 'e2ee';
    let machineReads = 0;
    vi.spyOn(axios, 'get').mockImplementation(async (url: string, options) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: fixture.settingsContent, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: fixture.currentness };
      if (url.endsWith('/v1/machines/holder')) {
        machineReads++;
        const headers = options?.headers;
        expect(headers?.Authorization).toBeUndefined();
        expect(headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(root.token);
        const proof = decodeDeploymentChildExecutionV1(String(headers?.[EXTERNAL_ACTION_DEPLOYMENT_CHILD_EXECUTION_HEADER] ?? ''),
          String(headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] ?? ''));
        expect(proof?.externalActionExecution.authorization.binding).toEqual(root.binding);
        expect(proof?.archiveOrigin).toEqual(archiveOrigin);
        expect(verifyExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId: root.binding.actionId,
          target: root.binding.target, installationId: installed.installationId, requestId: root.binding.requestId,
          method: 'GET', path: '/v1/machines/holder', deploymentChildExecution: proof ?? undefined,
          signature: String(headers?.['x-happier-action-machine-signature'] ?? ''), publicKey: receiver.publicKey })).toBe(true);
        return { status: 200, data: { machine: { id: 'holder', kind: 'persistent', installationId: 'holder-installation',
          storageMode: machineMode, dataEncryptionKey: publishedKey } } };
      }
      throw new Error(`Unexpected private archive read: ${new URL(url).pathname}`);
    });
    const prepared = await fixture.prepare();
    const boundaryErrors: unknown[] = [];
    let archiveCalls = 0;
    const request = { rootPath: '/release', path: '/release/image.tar', format: 'entry_tree', asZip: false };
    channel.server.on('connection', socket => {
      if (socket.handshake.auth.token !== ann.token) return;
      socket.on(SOCKET_RPC_EVENTS.CALL, (payload: import('@happier-dev/protocol/socketRpc').SocketRpcRequestPayload, ack: (value: unknown) => void) => {
        void (async () => {
          expect(socket.handshake.auth.token).toBe(ann.token);
          expect(payload.externalActionExecution?.installationId).toBe(installed.installationId);
          expect(payload.externalActionExecution?.authorization.binding).toEqual(root.binding);
          expect(payload.externalActionExecution?.deploymentChildExecution?.archiveOrigin).toEqual(archiveOrigin);
          const serialized = JSON.stringify(payload);
          expect(serialized).not.toContain(bob.token);
          expect(serialized).not.toContain(Buffer.from(secret).toString('base64'));
          // The unchanged controller signature retains its receiver-only sealed
          // box in the parent proof; the holder receives no new requester box.
          expect(payload.externalActionExecution?.authorization.requesterAccountContext).toBeUndefined();
          const decoded = await socketRpcCodec.decodeRequestParams(content, payload.params, payload.method);
          expect(decoded.params).toEqual(request);
          archiveCalls++;
          ack({ ok: true, result: await socketRpcCodec.encodeResponse(content, { archiveDescriptor: 'verified-source' }, decoded.callId) });
        })().catch(error => { boundaryErrors.push(error); ack({ ok: false, error: 'archive boundary rejected' }); });
      });
    });
    const call = (signal?: AbortSignal) => callExactMachineRpc({ credentials: ann, machineId: 'holder',
      serverUrl: 'https://requester-home.test', method: RPC_METHODS.DAEMON_FILESYSTEM_DOWNLOAD, request,
      externalAction: { context: { externalActionExecutionAuthorization: prepared.authorization,
        externalActionTarget: root.binding.target, originalActionEnvelope: ExternalActionRequestEnvelopeSchema.parse(envelope), ...(signal ? { signal } : {}) },
        effectActionId: 'daemon.filesystem.download', installationId: installed.installationId, privateKey: receiver.secretKey,
        deploymentArchiveOrigin: archiveOrigin },
      ...(signal ? { signal } : {}) });
    try {
      expect(await isReviewedDeploymentChild({ authorization: prepared.authorization, envelope: ExternalActionRequestEnvelopeSchema.parse(envelope),
        actionId: job.actionId, machineId: job.machineId, params: job })).toBe(true);
      expect(await call()).toEqual({ archiveDescriptor: 'verified-source' });
      expect(boundaryErrors).toEqual([]);
      expect(archiveCalls).toBe(1);
      machineMode = undefined;
      await expect(call()).rejects.toMatchObject({ code: 'machine_content_key_unavailable' });
      expect(machineReads).toBe(2);
      expect(archiveCalls).toBe(1);
      fixture.setCurrent(false);
      machineMode = 'e2ee';
      expect(await call()).toEqual({ archiveDescriptor: 'verified-source' });
      await expect(fixture.prepare()).rejects.toThrow('Missing private requester receiver custody');
      const cancelled = new AbortController();
      cancelled.abort();
      await expect(call(cancelled.signal)).rejects.toMatchObject({ name: 'AbortError' });
      expect(machineReads).toBe(3);
      expect(archiveCalls).toBe(2);
    } finally { await prepared.dispose(); }
  });

  it.each(['prepared', 'compact'] as const)('permits only preparation-owned promotion review references under unchanged %s source and destination intent', async (form) => {
    const original = { serverId: 'stable-home', environmentId: 'destination', targetLinkId: 'runtime',
      expectedRevision: 1, expectedTargetLinkRevision: 1, requestKey: 'promote', contentArtifactId: 'source-candidate',
      contentHeaderVersion: 1, contentBodyVersion: 1, sourceEnvironmentId: 'source', sourceDeploymentId: 'selected',
      artifact: 'image',
      destinationContent: { contentArtifactId: 'old-destination', contentHeaderVersion: 1, contentBodyVersion: 1 } };
    const requestId = 'promotion-root';
    const rootInput = form === 'prepared' ? original : { serverId: original.serverId, environmentId: original.environmentId,
      sourceEnvironmentId: original.sourceEnvironmentId, sourceDeploymentId: original.sourceDeploymentId,
      artifact: original.artifact, requestKey: original.requestKey };
    const envelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId,
      target: { kind: 'machine', machineId: 'controller' }, input: rootInput });
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'promotion-root', binding: {
      accountId: 'bob', custodianAccountId: 'controller-owner', authentication: { kind: 'account', tokenEpoch: 1 },
      deploymentChildRoot: true,
      accountEncryptionMode: 'plain', serverIdentityId: 'stable-home', machineId: 'controller', installationId: 'controller-install',
      actionId: 'deployments.promote', requestId: envelope.requestId, target: envelope.target,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
      environmentId: original.environmentId,
      deploymentNativeAdmission: projectExternalActionDeploymentNativeEnvelopeAdmissionV1({
        actionId: 'deployments.promote', envelope }),
    } });
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      throw new Error('Unexpected requester read');
    });
    const admitted = await requesterAccountOwner.admitRequesterAccountActionContext({ authorization,
      credentials: { token: 'bob-private', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => true });
    if (!admitted) throw new Error('Missing promotion requester custody');
    const job = DeploymentChildRpcV1Schema.parse({ v: 1, kind: 'review', actionId: 'deployments.promote',
      machineId: 'receiver', installationId: 'receiver-install', input: { ...original, contentArtifactId: 'effective-receipt',
        contentHeaderVersion: 2, contentBodyVersion: 2, destinationContent: {
          contentArtifactId: 'prepared-destination', contentHeaderVersion: 1, contentBodyVersion: 1 } } });
    const review = (params: unknown) => isReviewedDeploymentChild({ authorization: admitted.authorization,
      envelope, actionId: job.actionId, machineId: job.machineId, params });
    try {
      expect(await review(job)).toBe(true);
      for (const patch of [{ environmentId: 'another-destination' }, { sourceDeploymentId: 'another-source' },
        { artifact: 'rebuild' }, { requestKey: 'another-request' }]) {
        expect(await review({ ...job, input: { ...job.input, ...patch } })).toBe(false);
      }
    } finally { await admitted.dispose(); }
  });

  it('admits finite SOURCE preparation once and keeps local custody while refusing the next withdrawn request', async () => {
    const [{ RpcHandlerManager }, machineAdmission, { createWorkspaceSyncTargetContent }, { socketRpcCodec },
      { PROJECT_ACTION_INPUT_SCHEMAS_V1 }, { WorkspaceSyncSourceRoutingV1Schema, WorkspaceSyncSourceExecutionV1Schema }] = await Promise.all([
      import('@/api/rpc/RpcHandlerManager'), import('@/api/machine/machineRpcAuthorization'),
      import('@/api/rpc/workspaceSyncTargetContent'), import('@happier-dev/sync-client'),
      import('@happier-dev/protocol/actions/projectActionFamily'), import('@happier-dev/protocol/socketRpc'),
    ]);
    const controller = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(61));
    const worker = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(62));
    const installation = { version: 1 as const, installationId: 'controller-installation', createdAt: 1,
      publicKey: Buffer.from(controller.publicKey).toString('base64url'), privateKey: Buffer.from(controller.secretKey).toString('base64url') };
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(installation);
    const admission = { actorAccountId: 'bob', custodianAccountId: 'source-owner', machineId: 'source',
      installationId: 'source-installation', role: 'use' as const, encryptionMode: 'plain' as const };
    const envelope = ExternalActionRequestEnvelopeSchema.parse({ v: 1, requestId: 'source-preparation',
      input: PROJECT_ACTION_INPUT_SCHEMAS_V1['projects.script.run'].parse({ workspace: {
        serverId: 'stable-home', workspaceId: 'source-ref', machineId: 'source', rootPath: '/source',
      }, selection: { kind: 'named', name: 'test' } }), target: { kind: 'machine', machineId: 'worker' } });
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'source-root', binding: {
      accountId: 'bob', custodianAccountId: 'worker-owner', authentication: { kind: 'terminal', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: 'stable-home', machineId: 'worker', installationId: 'worker-installation',
      actionId: 'projects.script.run', requestId: envelope.requestId,
      requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope), target: envelope.target,
      workspaceSyncAdmission: { relationshipId: deriveWorkspaceSyncRelationshipId(envelope.requestId),
        sourceWorkspaceRefId: 'source-ref', source: admission },
    } });
    const params = { sourceWorkspaceRefId: 'source-ref', targetWorkspaceRefId: 'worker-ref' };
    const purpose = { kind: 'workspace_sync_prepare', controller: { machineId: 'controller', installationId: installation.installationId },
      request: params } as const;
    const sealed = sealExternalActionRequesterAccountContextV1({ authorization: root, purpose,
      credentials: { token: 'bob-private', secret: null, encryption: null }, installationPublicKey: controller.publicKey,
      randomBytes: nacl.randomBytes });
    const routing = WorkspaceSyncSourceRoutingV1Schema.parse({ v: 1, phase: 'prepare', operationId: 'source-sync',
      accountServerId: 'stable-home', sourceMachineId: 'source', sourceRootPath: '/source', originalActionEnvelope: envelope,
      sourceContext: { machineAdmission: admission, callerAuthority: 'account_automation', workspaceWrites: 'allow' } });
    const method = `controller:${RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN}`;
    const content = createWorkspaceSyncTargetContent({ destination: { machineId: 'controller',
      installationId: installation.installationId, installationPublicKey: installation.publicKey }, method, routing });
    const callId = '0123456789abcdef0123456789abcdef';
    const encoded = await socketRpcCodec.encodeParams(content, params, { method, callId });
    const packet = WorkspaceSyncSourceExecutionV1Schema.parse({ method, requestId: 'source-packet', params: encoded,
      externalActionExecution: createExternalActionMachineRpcExecution({ context: {
        externalActionExecutionAuthorization: sealed, externalActionTarget: root.binding.target },
        effectActionId: root.binding.actionId, installationId: root.binding.installationId,
        method, requestId: 'source-packet', params: encoded, privateKey: worker.secretKey, workspaceSyncSourceRouting: routing }) });
    let current = true;
    let afterSettings: (() => void) | undefined;
    let revokeAtOperation = false;
    let revokeAtSettingsRefresh = false;
    let proofs = 0;
    let effects = 0;
    let executors = 0;
    const preparationProofs: number[] = [];
    // Only Home HTTP and the installation file are substituted. The real
    // Manager verifies the exact SOURCE packet once at each request admission.
    vi.spyOn(axios, 'post').mockImplementation(async (url, raw) => {
      expect(new URL(String(url)).pathname).toBe('/v1/machines/controller/admission/verify');
      const body = raw as { proof: Parameters<typeof verifyMachineInstallationProof>[0]['proof'] };
      expect(verifyMachineInstallationProof({ publicKey: controller.publicKey, proof: body.proof,
        payload: { version: 1, machineId: 'controller', installationId: installation.installationId,
          accountId: 'controller-owner', rpcAdmission: { context: admission, method, callerInputAuthorization: sealed,
            workspaceSyncSourceRouting: routing, workspaceSyncSourceExecution: packet } } })).toBe(true);
      proofs += 1;
      // Home returns the physical controller's grant independently of SOURCE custody.
      return { status: 200, data: current ? MachineAdmissionVerifyResponseV1Schema.parse({ v: 1, ok: true,
        receivingMachineAdmission: { actorAccountId: 'bob', custodianAccountId: 'controller-owner', machineId: 'controller',
          installationId: installation.installationId, role: 'manage', encryptionMode: 'plain' } }) : { v: 1, ok: false } };
    });
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (url.endsWith('/v2/account/settings')) {
        const change = afterSettings;
        afterSettings = undefined;
        change?.();
        return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      }
      throw new Error(`Unexpected SOURCE preparation read: ${new URL(url).pathname}`);
    });
    const rpc = new RpcHandlerManager({ scopePrefix: 'controller', localMachineId: 'controller', encryptionMode: 'plain', logger: () => {},
      authorizeRequest: request => machineAdmission.authorizeMachineRpcRequest(request, { machineId: 'controller',
        resolveCustodianAccountId: async () => 'controller-owner', resolveInstallationId: () => installation.installationId,
        verifyMachineAdmission: request => machineAdmission.readMachineRpcAdmissionCurrent({ ...request,
          privateKey: controller.secretKey, daemonToken: 'controller-token', serverHttpBaseUrl: 'https://requester-home.test',
          workspaceSyncSourceReceiver: { machineId: 'controller', installationId: installation.installationId, accountId: 'controller-owner' } }),
      }), prepareRequesterAccountContext: async request => {
        const before = proofs;
        try { return await requesterAccountOwner.prepareInstalledRequesterAccountActionContext({ ...request,
          purpose: request.purpose ?? { kind: 'external_action' }, machineId: 'controller', serverId: 'home-profile',
          serverHttpBaseUrl: 'https://requester-home.test',
          resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'controller', serverIdentityId: 'stable-home' }),
          createExecutor: () => { executors += 1; return { execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) }; },
        }); } finally { preparationProofs.push(proofs - before); }
      },
    });
    rpc.registerHandler(RPC_METHODS.DAEMON_WORKSPACE_SYNC_PREPARE_BETWEEN, async (_body, context) => {
      const custody = requesterAccountOwner.readRequesterAccountActionContext(context?.callerInputAuthorization);
      if (!custody) throw new Error('Missing admitted SOURCE custody');
      if (revokeAtSettingsRefresh) {
        current = false;
        const before = proofs;
        await channel.pushSettings('bob', {}, 2);
        expect(await custody.refreshAccountSettings()).toBe(true);
        expect(proofs).toBe(before);
        expect(custody.savedSecretOperationContext.readSnapshot()).not.toBeNull();
      }
      if (revokeAtOperation) current = false;
      const before = proofs;
      const allowed = await custody.isCurrent();
      expect(proofs - before).toBe(0);
      if (!allowed) return { prepared: false };
      effects += 1;
      return { prepared: true };
    });
    const invoke = async () => {
      const result = await rpc.handleRequest({ method, params: encoded, requestId: 'source-packet',
        machineAdmission: admission, callerAuthority: 'account_automation', callerInputAuthorization: sealed,
        workspaceSyncSourceRouting: routing, workspaceSyncSourceExecution: packet });
      if (result && typeof result === 'object' && 'errorCode' in result) return result;
      return await socketRpcCodec.decodeResult(content, { ok: true, result }, callId);
    };
    expect(await invoke()).toEqual({ prepared: true });
    expect(preparationProofs).toEqual([0]);
    expect(proofs).toBe(1);
    expect(await invoke()).toEqual({ prepared: true });
    expect(preparationProofs).toEqual([0, 0]);
    expect(proofs).toBe(2);
    expect(effects).toBe(2);

    afterSettings = () => { current = false; };
    expect(await invoke()).toEqual({ prepared: true });
    expect(proofs).toBe(3);
    expect(await invoke()).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    expect(effects).toBe(3);
    expect(executors).toBe(3);
    expect(channel.clients.every(client => client.disconnected)).toBe(true);
    current = true;
    revokeAtOperation = true;
    expect(await invoke()).toEqual({ prepared: true });
    expect(await invoke()).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    expect(effects).toBe(4);
    revokeAtOperation = false;
    current = true;
    revokeAtSettingsRefresh = true;
    expect(await invoke()).toEqual({ prepared: true });
    expect(await invoke()).toMatchObject({ errorCode: 'RPC_FORBIDDEN' });
    expect(effects).toBe(5);
    expect(channel.clients.every(client => client.disconnected)).toBe(true);
  });

  it('opens finite preparation custody at its controller, keeps the worker root, and retires its private Account reads', async () => {
    const controller = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(30));
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
      installationId: 'controller-installation', createdAt: 1, publicKey: Buffer.from(controller.publicKey).toString('base64url'),
      privateKey: Buffer.from(controller.secretKey).toString('base64url') });
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'finite-root', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'terminal', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: 'stable-home', machineId: 'worker', installationId: 'worker-installation',
      actionId: 'projects.compute.exec', requestId: 'run', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'worker' },
    } });
    const purpose = { kind: 'workspace_sync_prepare', controller: { machineId: 'controller', installationId: 'controller-installation' },
      request: { sourceWorkspaceRefId: 'source', targetWorkspaceRefId: 'target' } } as const;
    const sealed = sealExternalActionRequesterAccountContextV1({ authorization: root, purpose,
      credentials: { token: 'bob-private', secret: null, encryption: null }, installationPublicKey: controller.publicKey,
      randomBytes: nacl.randomBytes });
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      throw new Error('Unexpected requester read');
    });
    // The controller must never try spending the worker's effect as its own HTTP signature.
    const writes = vi.spyOn(axios, 'post').mockRejectedValue(new Error('unexpected controller effect proof'));
    let current = true;
    let installedCurrent = true;
    const input: Parameters<typeof requesterAccountOwner.prepareInstalledRequesterAccountActionContext>[0] = {
      authorization: sealed, purpose, machineId: 'controller', serverId: 'home-profile',
      serverHttpBaseUrl: 'https://requester-home.test', verifyWorkspaceSyncPrepareCurrent: async () => current,
      isRetainedCustodyCurrent: async () => installedCurrent,
      resolveCurrentMachineExecutionOriginContext: async () => ({ machineId: 'controller', serverIdentityId: 'stable-home' }),
      ownCredentials: { token: 'alice-own', encryption: null },
      createExecutor: () => ({ execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) }),
    };
    const prepared = await requesterAccountOwner.prepareInstalledRequesterAccountActionContext(input);
    expect(prepared).not.toBeNull();
    let retained: ReturnType<NonNullable<import('./requesterAccountActionContext').RequesterAccountActionContext['retainCustody']>> | undefined;
    try {
      expect(prepared?.authorization.binding).toEqual(root.binding);
      expect(prepared?.authorization.requesterHttpProjection).toBeUndefined();
      const custody = requesterAccountOwner.readRequesterAccountActionContext(prepared?.authorization);
      expect(custody?.credentials.token).toBe('bob-private');
      retained = custody?.retainCustody?.();
      expect(retained).toBeDefined();
      expect(await custody?.isCurrent()).toBe(true);
      current = false;
      expect(await custody?.isCurrent()).toBe(false);
      await prepared?.dispose();
      expect(await retained?.isCurrent()).toBe(true);
      installedCurrent = false;
      expect(await retained?.isCurrent()).toBe(false);
      expect(writes).not.toHaveBeenCalled();
    } finally { await retained?.release(); await prepared?.dispose(); }
    current = true;
    expect(await requesterAccountOwner.prepareInstalledRequesterAccountActionContext({ ...input, authorization: root })).toBeNull();
    expect(await requesterAccountOwner.prepareInstalledRequesterAccountActionContext({ ...input, authorization: {
      ...root, binding: { ...root.binding, custodianAccountId: 'bob' },
    }, ownCredentials: { token: 'bob-own', encryption: null } })).toBeNull();
    expect(await requesterAccountOwner.prepareInstalledRequesterAccountActionContext({ ...input,
      verifyWorkspaceSyncPrepareCurrent: undefined })).toBeNull();
  });
  it.each([
    ['plain', 'observed_account_encryption_currentness'], ['plain', 'local_abort_signal'],
    ['e2ee', 'observed_account_encryption_currentness'], ['e2ee', 'local_abort_signal'],
    ['plain', 'ingress_abort'], ['e2ee', 'ingress_abort'],
  ] as const)('exposes the r31 local header refusal without releasing headers (%s/%s)', async (mode, branch) => {
    const refusals = vi.spyOn(logger, 'warnLocalFile');
    const privateKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31)).secretKey;
    const installation = nacl.sign.keyPair.fromSecretKey(privateKey);
    const identity = { version: 1 as const, installationId: 'installation', createdAt: 1,
      publicKey: Buffer.from(installation.publicKey).toString('base64url'), privateKey: Buffer.from(privateKey).toString('base64url') };
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue(identity);
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'rollback-root', binding: {
      accountId: 'bob', custodianAccountId: 'bob', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: mode, serverIdentityId: 'srv_current_machine_fixture', machineId: 'machine', installationId: 'installation',
      actionId: 'deployments.rollback', requestId: 'r31-rollback', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'machine' },
    } });
    const credentials: StoredCredentials = { token: 'bob-ordinary', encryption: mode === 'plain' ? null
      : { type: 'legacy', secret: new Uint8Array(32).fill(8) } };
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: mode === 'plain'
        ? { content: { t: 'plain', v: {} }, version: 1 } : { content: null, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode, version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error('Unexpected requester bootstrap read');
    });
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({
      features: {}, capabilities: { serverIdentity: { serverIdentityId: root.binding.serverIdentityId } },
    })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const purpose = { kind: 'external_action' } as const;
    const ingress = new AbortController();
    const sealed = sealExternalActionRequesterAccountContextV1({ authorization: root, purpose,
      credentials: { ...encodeStoredCredentials(credentials), token: credentials.token },
      installationPublicKey: installation.publicKey, randomBytes: nacl.randomBytes });
    const prepared = await requesterAccountOwner.prepareInstalledRequesterAccountActionContext({ authorization: sealed,
      purpose, machineId: 'machine', serverId: 'home-profile', serverHttpBaseUrl: 'https://requester-home.test',
      signal: ingress.signal,
      resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
        serverUrl: 'https://requester-home.test', resolveCurrentMachineId: () => 'machine' }),
      createExecutor: () => ({ execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) }) });
    if (!prepared) throw new Error(`Missing real rollback custody: ${JSON.stringify(refusals.mock.calls.map(([, value]) =>
      value && typeof value === 'object' && 'phase' in value ? value.phase : null).filter(Boolean))}`);
    const local = new AbortController();
    const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: prepared.authorization,
      serverId: 'home-profile', serverIdentityId: root.binding.serverIdentityId, serverHttpBaseUrl: 'https://requester-home.test',
      target: root.binding.target, installationId: 'installation', privateKey, signal: local.signal,
      isCurrent: requesterAccountOwner.readRequesterAccountActionContext(prepared.authorization)?.isCustodyCurrent });
    if (!carrier?.requesterHttpProjection) throw new Error('Missing real rollback HTTP projection');
    const request = { effectActionId: 'deployments.rollback', method: 'GET', path: '/v1/deployments/environments/r31-environment' };
    const deps = createDaemonDeploymentActionDeps({ credentials, machineId: 'machine',
      serverId: 'home-profile', serverHttpBaseUrl: 'https://requester-home.test' });
    const http = vi.spyOn(axios, 'request');
    const refused = () => deps.deploymentAction('deployments.environments.get',
      { serverId: 'home-profile', environmentId: 'r31-environment' },
      { surface: 'ui', externalActionExecutionAuthorization: carrier });
    try {
      expect(await carrier.requesterHttpProjection.createRequestHeaders(request)).not.toBeNull();
      if (branch === 'ingress_abort') ingress.abort();
      else await channel.disconnect();
      // The first actual branch wins when a disconnected observation and abort coexist.
      if (branch === 'local_abort_signal') local.abort();
      expect(await refused()).toMatchObject({ ok: false, errorCode: 'action_forbidden',
        error: `action_forbidden (home_request_headers_refused:${branch === 'ingress_abort' ? 'local_abort_signal' : branch})` });
      expect(http).not.toHaveBeenCalled();
    } finally { await prepared.dispose(); }
  });

  it('admits a foreign-requester finite wake once and keeps it on local custody and cancel afterwards', async () => {
    const privateKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(37)).secretKey;
    const installation = nacl.sign.keyPair.fromSecretKey(privateKey);
    const wakeTarget = { homeId: 'srv_current_machine_fixture', managedId: 'managed', enrolledMachineId: 'private-guest',
      expectedIntentRevision: 1, controller: { machineId: 'machine', installationId: 'installation' },
      origin: { kind: 'finite-command' as const, actionRequestId: 'private-finite' }, reason: 'admitted-work' as const };
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'private-finite-root', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 1 }, accountEncryptionMode: 'plain',
      serverIdentityId: 'srv_current_machine_fixture', machineId: 'private-guest', installationId: 'guest-installation',
      actionId: 'projects.prepare', requestId: 'private-finite', target: { kind: 'machine', machineId: 'private-guest' },
      requestEnvelopeDigest: 'a'.repeat(43),
    }, managedFiniteWake: { target: wakeTarget, installationPublicKey: Buffer.from(installation.publicKey).toString('base64url') } });
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: null, version: 0 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error(`Unexpected requester GET ${url}`);
    });
    // Genuine Home transport boundary: count every root verification.
    const posts = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    const verifies = () => posts.mock.calls.filter(([url]) => String(url).endsWith('/verify')).length;
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
      installationId: 'installation', createdAt: 1, publicKey: Buffer.from(installation.publicKey).toString('base64url'),
      privateKey: Buffer.from(privateKey).toString('base64url') });
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({
      features: {}, capabilities: { serverIdentity: { serverIdentityId: 'srv_current_machine_fixture' } },
    })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const purpose = { kind: 'managed_finite_wake' as const, target: wakeTarget };
    const sealed = sealExternalActionRequesterAccountContextV1({ authorization: root, purpose,
      credentials: { token: 'bob-ordinary', secret: null, encryption: null }, installationPublicKey: installation.publicKey,
      randomBytes: nacl.randomBytes });
    const cancel = new AbortController();
    const prepare = (wake = purpose) => requesterAccountOwner.prepareInstalledRequesterAccountActionContext({ authorization: sealed,
      purpose: wake, machineId: 'machine', serverId: 'home-profile', serverHttpBaseUrl: 'https://requester-home.test',
      resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
        serverUrl: 'https://requester-home.test', resolveCurrentMachineId: () => 'machine',
      }), createExecutor: () => ({ execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) }),
      signal: cancel.signal });
    const prepared = await prepare();
    const admitted = requesterAccountOwner.readRequesterAccountActionContext(prepared?.authorization);
    if (!prepared || !admitted) throw new Error('Missing admitted finite-wake custody');
    try {
      expect(verifies()).toBe(1);
      // Home is now unavailable for the same root; the admitted wake still runs locally.
      posts.mockClear();
      posts.mockResolvedValue({ status: 403, data: { ok: false } });
      expect(await admitted.isCurrent()).toBe(true);
      expect(verifies()).toBe(0);
      // A changed wake target is a fresh admission and refuses.
      expect(await prepare({ ...purpose, target: { ...wakeTarget, expectedIntentRevision: 2 } })).toBeNull();
      cancel.abort();
      expect(await admitted.isCurrent()).toBe(false);
    } finally { await prepared.dispose(); }
  });

  it('uses observed custody for signed HTTP and spends one Home verification per admitted operation', async () => {
    const envelope = { v: 1 as const, requestId: authorization.binding.requestId,
      target: authorization.binding.target, input: {} };
    const root = { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'plain' as const,
      serverIdentityId: 'srv_current_machine_fixture', requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope) } };
    const privateKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31)).secretKey;
    const actionsSettingsV1 = { v: 1, actions: { 'machines.setup.plan': { enabled: false } } };
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: { actionsSettingsV1 } }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error(`Unexpected requester GET ${url}`);
    });
    const posts = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    const installation = nacl.sign.keyPair.fromSecretKey(privateKey);
    vi.spyOn(installationStore, 'readInstallationIdentityIfExistsSync').mockReturnValue({ version: 1,
      installationId: 'installation', createdAt: 1, publicKey: Buffer.from(installation.publicKey).toString('base64url'),
      privateKey: Buffer.from(privateKey).toString('base64url') });
    const purpose = { kind: 'external_action' } as const;
    let homeIdentity = 'srv_current_machine_fixture';
    const homeReads = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(FeaturesResponseSchema.parse({
      features: {}, capabilities: { serverIdentity: { serverIdentityId: homeIdentity } },
    })), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const sealed = sealExternalActionRequesterAccountContextV1({ authorization: root, purpose,
      credentials: { token: 'bob-ordinary', secret: null, encryption: null }, installationPublicKey: installation.publicKey,
      randomBytes: nacl.randomBytes });
    // Use the installed owner; only HTTP and installation/origin OS boundaries
    // are substituted, including the real split of root and local custody.
    const prepared = await requesterAccountOwner.prepareInstalledRequesterAccountActionContext({ authorization: sealed,
      purpose, machineId: 'machine', serverId: 'home-profile', serverHttpBaseUrl: 'https://requester-home.test',
      resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
        serverUrl: 'https://requester-home.test', resolveCurrentMachineId: () => 'machine',
      }),
      createExecutor: () => ({ execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) }) });
    const admitted = requesterAccountOwner.readRequesterAccountActionContext(prepared?.authorization);
    if (!admitted) throw new Error('Missing real private custody');
    try {
      expect(prepared?.actionsSettings).toEqual(admitted.accountSettingsContext.settings.actionsSettingsV1);
      expect(prepared?.actionsSettings).toMatchObject(actionsSettingsV1);
      // One admission decision opens this operation's custody. Constructing
      // its HTTP ports must reuse that decision; native effects reverify below.
      expect(posts.mock.calls.filter(([url]) => String(url).endsWith('/verify'))).toHaveLength(1);
      posts.mockClear();
      const carrier = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
        serverId: 'home-profile', serverIdentityId: root.binding.serverIdentityId, serverHttpBaseUrl: 'https://requester-home.test',
        target: root.binding.target, installationId: 'installation', privateKey, isCurrent: admitted.isCustodyCurrent });
      if (!carrier?.requesterHttpProjection) throw new Error('Missing real HTTP projection');
      expect(posts).not.toHaveBeenCalled();
      const substituted = Object.defineProperty({ ...admitted.authorization, token: 'different-operation-root' },
        'requesterAccountProjection', { value: admitted.authorization.requesterAccountProjection });
      expect(await projectExternalActionRequesterHttpAuthorization({ authorization: substituted,
        serverId: 'home-profile', serverIdentityId: root.binding.serverIdentityId, serverHttpBaseUrl: 'https://requester-home.test',
        target: root.binding.target, installationId: 'installation', privateKey, isCurrent: admitted.isCustodyCurrent })).toBeNull();
      expect(posts).not.toHaveBeenCalled();
      reads.mockClear(); posts.mockClear(); homeReads.mockClear();
      expect(await admitted.isCurrent()).toBe(true);
      expect(homeReads.mock.calls).toHaveLength(0);
      expect({ encryption: reads.mock.calls.filter(([url]) => String(url).endsWith('/currentness')).length,
        verify: posts.mock.calls.filter(([url]) => String(url).endsWith('/verify')).length }).toEqual({ encryption: 0, verify: 0 });
      posts.mockClear(); homeReads.mockClear();
      posts.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 20));
        return { status: 200, data: { ok: true } };
      });
      const headerStarted = performance.now();
      const headers = await carrier.requesterHttpProjection.createRequestHeaders({ effectActionId: root.binding.actionId,
        method: 'POST', path: '/v1/account/project-rows/list' });
      const headerMeasurement = { elapsedMs: Math.round(performance.now() - headerStarted),
        verify: posts.mock.calls.filter(([url]) => String(url).endsWith('/verify')).length };
      expect(headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]).toBe(root.token);
      // Home validates the signed effect at its destination; local signing
      // consumes this operation's admitted custody and pushed invalidation.
      expect(headerMeasurement.verify).toBe(0);
      expect(homeReads.mock.calls).toHaveLength(0);
      const handlers = new Map<string, RpcHandler>();
      const executor = createActionExecutor(createUnavailableActionTransportDeps());
      registerExternalActionRpcHandler({ registerHandler: (method, handler) => { handlers.set(method, handler); } }, {
        machineId: 'machine', currentServerId: 'home-profile', currentServerHttpBaseUrl: 'https://requester-home.test',
        resolveAccountId: async () => 'alice', resolveInstallationId: () => 'installation',
        externalActionMachineRequestPrivateKey: privateKey, executor,
        resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: 'unused-custodian', encryption: null } }),
        verifyExecutionAuthorization: input => verifyExternalActionExecutionAuthorizationCurrent({ ...input,
          installationId: 'installation', privateKey, serverHttpBaseUrl: 'https://requester-home.test' }),
        prepareRequesterAccountContext: input => requesterAccountOwner.prepareInstalledRequesterAccountActionContext({
          ...input, purpose, machineId: 'machine', serverId: 'home-profile', serverHttpBaseUrl: 'https://requester-home.test',
          resolveCurrentMachineExecutionOriginContext: createCurrentMachineExecutionOriginContextResolver({
            serverUrl: 'https://requester-home.test', resolveCurrentMachineId: () => 'machine',
          }), createExecutor: () => executor }),
      });
      if (!('grant' in root.binding)) throw new Error('Fixture requires a scoped API principal');
      posts.mockClear();
      const dispatch = {
        actionId: root.binding.actionId, envelope, executionAuthorization: sealed,
        principal: { accountId: 'bob', principalId: 'bob', credentialId: 'pat', grant: root.binding.grant, authority: 'account_automation' },
        placement: { machineId: 'machine', target: root.binding.target },
      };
      const relay = () => handlers.get(EXTERNAL_ACTION_DAEMON_RPC_METHOD_V1)?.(dispatch,
        { authorization: ACTION_API_SERVER_ORIGIN, signal: new AbortController().signal });
      const relayed = parseExternalActionDaemonDispatchResultV1(await relay());
      expect(relayed?.kind).toBe('response');
      if (relayed?.kind !== 'response') throw new Error('Registered ingress did not reach the Action owner');
      expect(relayed.prepared.response).toMatchObject({ execution: { ok: false, errorCode: 'invalid_parameters' } });
      // Private custody admission owns the pre-open root proof. An unchanged
      // resolved target spends that proof; a changed one would verify separately.
      expect(posts.mock.calls.filter(([url]) => String(url).endsWith('/verify'))).toHaveLength(1);
      posts.mockResolvedValueOnce({ status: 403, data: { ok: false } });
      reads.mockClear();
      expect(await relay())
        .toMatchObject({ kind: 'invalid_request', errorCode: 'invalid_envelope' });
      // The canonical custody admission must refuse a retired root before
      // requester profile/settings reads, without a redundant outer verifier.
      expect(reads).not.toHaveBeenCalled();
      posts.mockClear();
      // A replaced Home reaches the next admission's origin read, not finite work.
      homeIdentity = 'srv_replaced_machine_fixture';
      expect(await admitted.isCurrent()).toBe(true);
      expect(posts).not.toHaveBeenCalled();
      homeIdentity = root.binding.serverIdentityId;
      // A different Machine/local guard is a separate fact, even with the same
      // Account facet. It must still veto headers before any Home request.
      let installedCurrent = true;
      const distinct = await projectExternalActionRequesterHttpAuthorization({ authorization: admitted.authorization,
        serverId: 'home-profile', serverIdentityId: root.binding.serverIdentityId, serverHttpBaseUrl: 'https://requester-home.test',
        target: root.binding.target, installationId: 'installation', privateKey, isCurrent: async () => installedCurrent });
      expect(distinct).not.toBeNull();
      installedCurrent = false;
      reads.mockClear(); posts.mockClear();
      expect(await distinct?.requesterHttpProjection?.createRequestHeaders({ effectActionId: root.binding.actionId,
        method: 'POST', path: '/v1/account/project-rows/list' })).toBeNull();
      expect(reads).not.toHaveBeenCalled();
      expect(posts).not.toHaveBeenCalled();
    } finally {
      await admitted.dispose();
      reads.mockClear(); posts.mockClear();
      expect(await admitted.isCurrent()).toBe(false);
      expect(reads).not.toHaveBeenCalled();
      expect(posts).not.toHaveBeenCalled();
    }
  });

  it.each(['mode', 'signing key', 'content key', 'retirement'] as const)('refuses headers and projection output when %s changes during Home verification', async change => {
    const secret = new Uint8Array(32).fill(8);
    const mode = change === 'signing key' || change === 'content key' ? 'e2ee' : 'plain';
    const signingKeyFingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(nacl.sign.keyPair.fromSeed(secret).publicKey);
    const contentKeyFingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(nacl.box.keyPair.fromSecretKey(
      deriveAccountMachineKeyFromRecoverySecret(secret)).publicKey);
    const changedKeyFingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9)).publicKey);
    let currentness = { mode: mode as 'plain' | 'e2ee', version: 1, updatedAt: 1,
      signingKeyFingerprint: mode === 'e2ee' ? signingKeyFingerprint : null,
      contentKeyFingerprint: mode === 'e2ee' ? contentKeyFingerprint : null };
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: mode === 'e2ee'
        ? { content: null, version: 0 } : { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: currentness };
      throw new Error(`Unexpected private requester read ${url}`);
    });
    let holdVerify = false;
    let entered!: () => void;
    let release!: () => void;
    const awaited = new Promise<void>(resolve => { entered = resolve; });
    const pendingVerify = new Promise<void>(resolve => { release = resolve; });
    vi.spyOn(axios, 'post').mockImplementation(async (url: string) => {
      if (!url.endsWith('/verify')) throw new Error(`Unexpected private requester write ${url}`);
      if (holdVerify) { entered(); await pendingVerify; }
      return { status: 200, data: { ok: true } };
    });
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization,
      binding: { ...authorization.binding, accountEncryptionMode: mode } });
    const privateKey = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31)).secretKey;
    const admitted = await requesterAccountOwner.admitRequesterAccountActionContext({ authorization: root,
      credentials: { token: 'bob-ordinary', encryption: mode === 'e2ee' ? { type: 'legacy', secret } : null },
      serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: () => change === 'retirement'
        ? verifyExternalActionExecutionAuthorizationCurrent({ authorization: root, effectActionId: root.binding.actionId,
          target: root.binding.target, installationId: 'installation', privateKey, serverHttpBaseUrl: 'https://requester-home.test' })
        : Promise.resolve(true) });
    if (!admitted) throw new Error('Missing real private custody');
    const input = { authorization: admitted.authorization, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', target: root.binding.target, installationId: 'installation',
      privateKey, isCurrent: admitted.isCurrent };
    const carrier = await projectExternalActionRequesterHttpAuthorization(input);
    if (!carrier?.requesterHttpProjection) throw new Error('Missing real HTTP projection');
    holdVerify = true;
    try {
      const headers = carrier.requesterHttpProjection.createRequestHeaders({ effectActionId: root.binding.actionId,
        method: 'POST', path: '/v1/account/project-rows/list', body: { keys: [] } });
      const projection = projectExternalActionRequesterHttpAuthorization(input);
      const local = change === 'retirement' ? admitted.isCurrent() : null;
      await awaited;
      if (change === 'retirement') await admitted.dispose();
      else {
        currentness = { ...currentness, ...(change === 'mode' ? { mode: 'e2ee' as const, signingKeyFingerprint, contentKeyFingerprint }
          : change === 'signing key' ? { signingKeyFingerprint: changedKeyFingerprint } : { contentKeyFingerprint: changedKeyFingerprint }) };
        await channel.push('bob', currentness);
      }
      release();
      // Signing a request is no disclosure, and Home refuses a stale one. The
      // next request after the pushed change is the boundary that must stop.
      await headers;
      expect(await carrier.requesterHttpProjection.createRequestHeaders({ effectActionId: root.binding.actionId,
        method: 'POST', path: '/v1/account/project-rows/list', body: { keys: [] } })).toBeNull();
      expect(await projection).toBeNull();
      if (local) expect(await local).toBe(false);
    } finally { release(); await admitted.dispose(); }
  });

  it.each(['plain', 'e2ee'] as const)('scopes borrowed own-Account credentials without retiring installed custody (%s)', async mode => {
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'own-account-root', binding: {
      accountId: 'bob', custodianAccountId: 'bob', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: mode, serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation',
      actionId: 'projects.context.update', requestId: 'request', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'machine' },
    } });
    const credentials: StoredCredentials = { token: 'own-account', credentialProvenance: 'stored_session',
      encryption: mode === 'plain' ? null : { type: 'legacy', secret: new Uint8Array(32).fill(8) } };
    const installed = { ...credentials };
    // HTTP is the system boundary; admission, provenance, scoping and projection stay real.
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: mode === 'plain'
        ? { content: { t: 'plain', v: {} }, version: 0 } : { content: null, version: 0 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode, version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      throw new Error('Unexpected own-Account read');
    });
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    const input: Parameters<typeof requesterAccountOwner.prepareRequesterAccountActionContext>[0] = {
      authorization: root, purpose: { kind: 'external_action' }, machineId: 'machine', installationId: 'installation',
      installationPrivateKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31)).secretKey,
      serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
      ownCredentials: credentials, isCurrent: async () => true, isRetainedCustodyCurrent: async () => true,
      createExecutor: () => ({ execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) }),
    };
    const prepared = await requesterAccountOwner.prepareRequesterAccountActionContext(input);
    expect(prepared).not.toBeNull();
    expect(sameStoredCredentials(credentials, installed)).toBe(true);
    expect(credentials.requesterSessionCredentialScope).toBeUndefined();
    const requester = requesterAccountOwner.readRequesterAccountActionContext(prepared?.authorization);
    expect(requester?.credentials).toMatchObject({ credentialProvenance: 'stored_session', requesterSessionCredentialScope: {
      serverId: 'home-profile', serverHttpBaseUrl: 'https://requester-home.test',
    } });
    expect(ExternalActionExecutionAuthorizationV1Schema.parse(prepared?.authorization)).toEqual(root);
    if (!requester?.retainForOperation) throw new Error('Missing retained own-Account operation ports');
    const retained = await requester.retainForOperation(new AbortController().signal);
    try {
      expect(requesterAccountOwner.readRequesterDeploymentArtifactStore(prepared?.authorization)).not.toBeNull();
      expect(requesterAccountOwner.readRequesterDeploymentArtifactStore(retained.authorization)).not.toBeNull();
      expect(requesterAccountOwner.readRequesterAccountEncryptionMaterialSnapshot(retained.authorization)).toEqual(
        mode === 'plain' ? null : requesterAccountOwner.readRequesterAccountEncryptionMaterialSnapshot(prepared?.authorization));
      if (mode === 'e2ee') expect(requesterAccountOwner.readRequesterAccountEncryptionMaterialSnapshot(retained.authorization))
        .toMatchObject({ accountEncryptionMode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(8) } });
    } finally { await retained.dispose(); }
    await prepared?.dispose?.();
    expect(await requester?.isCurrent()).toBe(false);
    // Existing private scope remains binding; borrowing must not strip it.
    bindRequesterSessionCredentialScope(credentials, { serverId: 'other-home', serverHttpBaseUrl: 'https://other-home.test' });
    expect(await requesterAccountOwner.prepareRequesterAccountActionContext(input)).toBeNull();
    expect(credentials.requesterSessionCredentialScope?.serverId).toBe('other-home');
    expect(await requesterAccountOwner.prepareRequesterAccountActionContext({ ...input, isCurrent: async () => false })).toBeNull();
    expect(await requesterAccountOwner.prepareRequesterAccountActionContext({ ...input, authorization: {
      ...root, binding: { ...root.binding, custodianAccountId: 'alice' },
    } })).toBeNull();
  });

  it.each(['plain', 'e2ee'] as const)('binds scoped Project Open ports to the observed Home before private HTTP effects (%s)', async mode => {
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'requester-open', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'terminal', tokenEpoch: 0 },
      serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation', accountEncryptionMode: mode,
      actionId: 'projects.open', requestId: 'open', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'machine' },
    } });
    const credentials: StoredCredentials = { token: `fixture.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`, encryption: mode === 'plain' ? null
      : { type: 'legacy', secret: new Uint8Array(32).fill(8) } };
    // Account mode and Home root verification are HTTP boundaries; both projection owners stay real.
    const reads = vi.spyOn(axios, 'get').mockImplementation(async url => ({ status: 200, data:
      String(url).endsWith('/v1/account/profile') ? { id: 'bob' }
        : String(url).endsWith('/v2/account/settings') ? { content: null, version: 0 }
          : { mode, version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 },
    }));
    const posts = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    let current = true;
    const accountInput = { authorization: root, serverIdentityId: 'stable-home', bootstrap: bootstrap(credentials, async () => current) };
    const account = await projectRequesterAccountActionAuthorization(accountInput);
    expect(account?.requesterAccountProjection).toMatchObject({ accountId: 'bob', accountEncryptionMode: mode });
    if (!account) throw new Error('Expected admitted Project Open Account custody');
    const installation = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
    const seal = account.requesterAccountProjection?.sealRequesterAccountContext;
    if (!seal) throw new Error('Expected admitted requester sealing port');
    const sealInput = { authorization: root, purpose: { kind: 'external_action' as const }, installationPublicKey: installation.publicKey };
    const sealed = await seal(sealInput);
    if (!sealed) throw new Error('Expected same-destination requester custody');
    const openInput = { authorization: sealed, purpose: sealInput.purpose, machineId: 'machine', installationId: 'installation',
      serverIdentityId: 'stable-home', installationPrivateKey: installation.secretKey };
    expect(openExternalActionRequesterAccountContextV1(openInput)).toEqual({
      ...encodeStoredCredentials(credentials), token: credentials.token,
    });
    expect(openExternalActionRequesterAccountContextV1({ ...openInput, installationId: 'another-installation' })).toBeNull();
    for (const binding of [{ ...root.binding, accountId: 'alice' }, { ...root.binding, serverIdentityId: 'another-home' }]) {
      expect(await seal({ ...sealInput, authorization: { ...root, binding } })).toBeNull();
    }
    const httpInput = { authorization: account, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', target: root.binding.target, installationId: 'installation',
      privateKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31)).secretKey };
    const carrier = await projectExternalActionRequesterHttpAuthorization(httpInput);
    expect(carrier?.requesterHttpProjection).toMatchObject({ accountId: 'bob', serverIdentityId: 'stable-home',
      accountEncryptionMode: mode });
    const custody = await requesterAccountOwner.admitRequesterAccountActionContext({ authorization: root, credentials,
      serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
      isCurrent: async () => current });
    if (!custody) throw new Error('Expected admitted installed Account custody');
    try {
      const installed = await projectExternalActionRequesterHttpAuthorization({ ...httpInput, authorization: custody.authorization });
      if (!installed) throw new Error('Expected installed HTTP projection');
      const deploymentHost = await createDeploymentTargetRoleAdmissionHost({ externalActionExecutionAuthorization: installed }, {
        resolveRequesterIdentity: async () => ({ kind: 'unknown', reason: 'requester_authority_unavailable' }),
        readCurrentMachineId: () => 'machine',
      });
      expect(deploymentHost).toMatchObject({ serverId: 'stable-home', credentialOwnerAccountId: 'bob' });
    } finally { await custody.dispose(); }
    expect(ExternalActionExecutionAuthorizationV1Schema.parse(carrier)).toEqual(root);
    expect(Object.isFrozen(carrier?.requesterHttpProjection)).toBe(true);
    reads.mockClear(); posts.mockClear();
    expect(await projectRequesterAccountActionAuthorization({ ...accountInput, serverIdentityId: 'another-home' })).toBeNull();
    expect(await requesterAccountOwner.admitRequesterAccountActionContext({ authorization: root, credentials,
      serverId: 'home-profile', serverIdentityId: 'another-home', serverHttpBaseUrl: 'https://requester-home.test',
      isCurrent: async () => true })).toBeNull();
    expect(await projectExternalActionRequesterHttpAuthorization({ ...httpInput, serverIdentityId: 'another-home' })).toBeNull();
    expect(reads).not.toHaveBeenCalled();
    expect(posts).not.toHaveBeenCalled();
    expect(ExternalActionExecutionAuthorizationV1Schema.safeParse({ ...root,
      requesterHttpProjection: { ...carrier?.requesterHttpProjection, serverIdentityId: 'another-home' } }).success).toBe(false);
    current = false;
    expect(await seal(sealInput)).toBeNull();
  });

  it('keeps private custody current across unrelated Account sequence updates but retires it on encryption transitions', async () => {
    let version = 1;
    let updatedAt = 1;
    // Home root verification is the network boundary; Account custody remains real.
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    vi.spyOn(axios, 'get').mockImplementation(async () => ({ status: 200, data: {
      mode: 'plain', version: version++, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt,
    } }));
    const projected = await projectRequesterAccountActionAuthorization({ authorization,
      serverIdentityId: 'stable-home', bootstrap: bootstrap({ token: 'bob', encryption: null }) });
    expect(projected?.requesterAccountProjection).toBeDefined();
    expect(await projected?.requesterAccountProjection?.isCurrent()).toBe(true);
    const http = projected && await projectExternalActionRequesterHttpAuthorization({ authorization: projected,
      serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
      target: authorization.binding.target, installationId: 'installation', privateKey: nacl.sign.keyPair().secretKey,
      isCurrent: async () => true });
    expect(http).not.toBeNull();
    updatedAt = 2;
    expect(await projected?.requesterAccountProjection?.isCurrent()).toBe(false);
  });
  it.each(['retained', 'denied'] as const)('retires Session input source custody at its Account Action lifetime boundary (%s)', async outcome => {
    const sessionId = 'requester-input-session';
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'session-input-root', binding: {
      accountId: 'bob', custodianAccountId: 'alice', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation',
      actionId: 'session.message.send', requestId: 'session-input', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'session', sessionId },
    } });
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error('Unexpected private requester read');
    });
    vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    // Use another genuine Account context as source custody: its private ports
    // prove retirement without replacing the lifecycle owner with a spy.
    const source = await requesterAccountOwner.admitRequesterAccountActionContext({ authorization: root,
      credentials: { token: 'bob-session-input', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => true });
    if (!source) throw new Error('Missing real Session input source custody');
    let prepared: Awaited<ReturnType<typeof requesterAccountOwner.prepareRequesterAccountActionContext>> = null;
    let release: (() => Promise<void>) | undefined;
    try {
      prepared = await requesterAccountOwner.prepareRequesterAccountActionContext({
        authorization: outcome === 'denied' ? { ...root, binding: { ...root.binding, installationId: 'other-installation' } } : root,
        purpose: { kind: 'external_action' }, machineId: 'machine', installationId: 'installation',
        installationPrivateKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31)).secretKey,
        serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
        requesterSessionBootstrap: { ...bootstrap(source.credentials, source.isCurrent), getBoundSessionId: () => sessionId,
          release: source.dispose },
        isCurrent: source.isCurrent,
        createExecutor: () => ({ execute: async () => ({ ok: false, errorCode: 'unused', error: 'unused' }) }),
      });
      if (outcome === 'denied') {
        expect(prepared).toBeNull();
        expect(await source.isCurrent()).toBe(false);
        return;
      }
      const custody = requesterAccountOwner.readRequesterAccountActionContext(prepared?.authorization);
      if (!prepared || !custody) throw new Error('Missing real Account Action custody');
      release = custody.retain();
      await prepared.dispose();
      expect(await custody.isCurrent()).toBe(true);
      expect(await source.isCurrent()).toBe(true);
      await release();
      expect(await custody.isCurrent()).toBe(false);
      expect(await source.isCurrent()).toBe(false);
    } finally { await prepared?.dispose(); await release?.(); await source.dispose(); }
  });
  it('retains Sync Account custody beyond Open cancellation without replaying root admission', async () => {
    const ingress = new AbortController();
    let installedCurrent = true;
    let rootCurrent = true;
    const credentials = { token: 'bob-retained-sync', encryption: null } as const;
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error('Unexpected retained requester read');
    });
    const admitted = await requesterAccountOwner.admitRequesterAccountActionContext({
      authorization: { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'plain' } },
      credentials, serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
      isCurrent: async () => rootCurrent, isRetainedCustodyCurrent: async () => installedCurrent, signal: ingress.signal,
    });
    if (!admitted) throw new Error('Missing admitted requester custody');
    const retained = admitted.retainCustody?.();
    let material: Awaited<ReturnType<typeof prepareRequesterOperationMaterial>> | undefined;
    try {
      expect(retained).toBeDefined();
      material = await prepareRequesterOperationMaterial({ requesterAccount: admitted, retainedCustody: retained,
        requesterIdentity: { kind: 'isolated', separationRequired: true, homeServerIdentityId: 'stable-home', requester: {
          serverId: 'home-profile', accountId: 'bob', machineId: 'machine', installationId: 'installation' } },
        reloadController: createPluginReloadController(), signal: new AbortController().signal });
      expect(retained?.savedSecretOperationContext).toBeDefined();
      expect(material.operationContext).toBe(retained?.savedSecretOperationContext);
      ingress.abort();
      rootCurrent = false;
      await admitted.dispose();
      expect(await admitted.isCurrent()).toBe(false);
      const before = reads.mock.calls.length;
      expect(await retained?.isCurrent()).toBe(true);
      expect(await retained?.isCurrent()).toBe(true);
      expect(await material.operationContext.isCurrent()).toBe(true);
      expect(material.credentials).toBe(credentials);
      expect(reads.mock.calls).toHaveLength(before);
      expect(admitted.credentials).toBe(credentials);
      expect(admitted.authorization.binding.accountId).toBe('bob');
      installedCurrent = false;
      expect(await retained?.isCurrent()).toBe(false);
      expect(await material.isCurrent()).toBe(false);
      installedCurrent = true;
      expect(await retained?.isCurrent()).toBe(true);
      await channel.push('bob', { mode: 'e2ee', version: 2, signingKeyFingerprint: null,
        contentKeyFingerprint: null, updatedAt: 2 });
      expect(await retained?.isCurrent()).toBe(false);
    } finally { await material?.dispose(); await retained?.release(); await admitted.dispose(); }
    expect(await retained?.isCurrent()).toBe(false);
    expect(await retained?.savedSecretOperationContext.isCurrent()).toBe(false);
  });

  it('keeps template operation requester ports usable after its transport is cancelled', async () => {
    const ingress = new AbortController();
    let installedCurrent = true;
    const artifactId = '11111111-1111-4111-8111-111111111111';
    const header = { kind: 'prompt_doc.v2', title: 'Template private input' };
    const input = { mode: 'apply', serverId: 'stable-home', machineId: 'machine', projectSourceId: 'project',
      templateRef: { sourceId: 'builtin:apps', itemId: 'uptime-kuma', version: '1',
        ref: { kind: 'content', digest: `sha256:${'a'.repeat(64)}` } },
      environment: { kind: 'create', name: 'Uptime Kuma', requestKey: 'create-app', protection: 'nonProduction',
        purpose: 'standard', deployerMode: 'managers', controllerMachineId: 'machine' },
      target: { kind: 'new', installationId: 'installation' }, destination: { kind: 'stored' }, bindings: [] };
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'template-root', binding: {
      accountId: 'bob', custodianAccountId: 'bob', authentication: { kind: 'account', tokenEpoch: 1 },
      accountEncryptionMode: 'plain', serverIdentityId: 'stable-home', machineId: 'machine', installationId: 'installation',
      actionId: 'deployments.templates.instantiate', requestId: 'template-request', requestEnvelopeDigest: 'a'.repeat(43),
      deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1('deployments.templates.instantiate', input),
      target: { kind: 'machine', machineId: 'machine' },
    } });
    // Only the Home HTTP boundary is replaced; admission, custody, private ports
    // and the operation runner all execute their real implementations.
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url.endsWith('/access/grants')) return { status: 200, data: { artifactId, ownerAccountId: 'bob', access: 'owner', grants: [] } };
      if (url.endsWith(`/v1/artifacts/${artifactId}`)) return { status: 200, data: { id: artifactId,
        ownerAccountId: 'bob', access: 'owner', encryptionMode: 'plain', header: encodePlainArtifactStoredContent(header),
        body: encodePlainArtifactStoredContent({ body: 'private body' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
      throw new Error(`Unexpected template custody read: ${new URL(url).pathname}`);
    });
    const verify = vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { ok: true } });
    const prepared = await requesterAccountOwner.prepareRequesterAccountActionContext({ authorization: root,
      purpose: { kind: 'external_action' }, machineId: 'machine', installationId: 'installation',
      installationPrivateKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31)).secretKey,
      serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
      ownCredentials: { token: 'bob-ordinary', encryption: null }, isCurrent: async () => true,
      isRetainedCustodyCurrent: async () => installedCurrent, signal: ingress.signal,
      createExecutor: () => createActionExecutor(createUnavailableActionTransportDeps()),
    });
    if (!prepared) throw new Error('Missing admitted template requester');
    const runtime = createHostActionOperationRuntime({ machineId: 'machine', resolveAccountId: async () => 'bob',
      generateOperationId: () => 'template-custody-operation' });
    let operationAuthorization: typeof prepared.authorization | undefined;
    try {
      const requester = requesterAccountOwner.readRequesterAccountActionContext(prepared.authorization);
      if (!requester?.retainForOperation) throw new Error('Missing installed operation retention');
      for (const retirement of ['owned_cancel', 'installation_retired'] as const) {
        const owned = new AbortController();
        const retained = await requester.retainForOperation(owned.signal);
        try {
          expect(await retained.authorization.requesterHttpProjection?.isCurrent()).toBe(true);
          if (retirement === 'owned_cancel') owned.abort(); else installedCurrent = false;
          expect(await retained.authorization.requesterHttpProjection?.createRequestHeaders({
            effectActionId: 'deployments.templates.instantiate', method: 'GET', path: '/v1/deployments/receipts/receipt' })).toBeNull();
          expect(await retained.authorization.requesterAccountProjection?.readArtifact({ kind: 'doc', serverId: 'home-profile', artifactId })).toBeNull();
          expect(await requesterAccountOwner.readRequesterAccountActionContext(retained.authorization)?.savedSecretOperationContext.isCurrent()).toBe(false);
        } finally { installedCurrent = true; await retained.dispose(); }
      }
      const invocation = runtime.runActionOperation({ actionId: 'deployments.templates.instantiate', input,
        context: { signal: ingress.signal, actionRequestId: root.binding.requestId,
          externalActionExecutionAuthorization: prepared.authorization }, execute: async context => {
          const retained = context.externalActionExecutionAuthorization;
          operationAuthorization = retained;
          if (!retained?.requesterHttpProjection || !retained.requesterAccountProjection) throw new Error('Missing operation requester ports');
          expect(context.signal).not.toBe(ingress.signal);
          const receiptRequest = { effectActionId: 'deployments.templates.instantiate', method: 'GET',
            path: '/v1/deployments/receipts/receipt', signal: context.signal };
          const artifactRef = { kind: 'doc' as const, serverId: 'home-profile', artifactId };
          expect(await retained.requesterHttpProjection.createRequestHeaders(receiptRequest)).not.toBeNull();
          expect(await retained.requesterAccountProjection.readArtifact(artifactRef)).toMatchObject({ artifactId, header });
          const admissionReads = reads.mock.calls.filter(([url]) => String(url).endsWith('/v1/account/encryption/currentness')).length;
          const homeVerifications = verify.mock.calls.length;
          ingress.abort(new Error('template_transport_closed'));
          await prepared.dispose();
          expect(context.signal?.aborted).toBe(false);
          const receiptHeaders = await retained.requesterHttpProjection.createRequestHeaders(receiptRequest);
          const settlementHeaders = await retained.requesterHttpProjection.createRequestHeaders({
            effectActionId: 'deployments.templates.instantiate', method: 'POST',
            path: '/v1/deployments/environments/environment/deployments/receipt/transitions',
            body: { state: 'Ready' }, signal: context.signal });
          const artifact = await retained.requesterAccountProjection.readArtifact(artifactRef);
          const artifactStore = requesterAccountOwner.readRequesterDeploymentArtifactStore(retained);
          if (!artifactStore) throw new Error('Missing retained deployment Artifact store');
          expect(await runWithServerHttpBaseUrl('https://requester-home.test', () => artifactStore.read(artifactId,
            { includeSharedAudience: false }))).toMatchObject({ artifactId, header });
          expect.soft(receiptHeaders, 'Receipt reread keeps admitted operation authority').not.toBeNull();
          expect.soft(settlementHeaders, 'Terminal settlement keeps admitted operation authority').not.toBeNull();
          expect.soft(artifact, 'Private content stays with the admitted operation').toMatchObject({ artifactId, header });
          // An already-retired ingress snapshot must not become the source for
          // a later child operation while its retained parent is still live.
          expect(await requester.savedSecretOperationContext.isCurrent()).toBe(false);
          const operationRequester = requesterAccountOwner.readRequesterAccountActionContext(retained);
          if (!operationRequester?.retainForOperation) throw new Error('Missing nested operation retention');
          const nested = await operationRequester.retainForOperation(new AbortController().signal);
          try {
            expect(await nested.authorization.requesterHttpProjection?.createRequestHeaders(receiptRequest)).not.toBeNull();
            expect(await nested.authorization.requesterAccountProjection?.readArtifact(artifactRef)).toMatchObject({ artifactId, header });
          } finally { await nested.dispose(); }
          expect(reads.mock.calls.filter(([url]) => String(url).endsWith('/v1/account/encryption/currentness'))).toHaveLength(admissionReads);
          expect(verify.mock.calls).toHaveLength(homeVerifications);
          return { ok: true, result: { settled: true } };
        } });
      // The RPC reply owner can stop delivering to the cancelled transport;
      // this admitted invocation must still settle its native effect.
      expect(await invocation).toMatchObject({ ok: true, result: { settled: true } });
      expect(await runtime.runner.waitForTerminal({ accountId: 'bob', machineId: 'machine' }, 'template-custody-operation'))
        .toMatchObject({ state: 'succeeded', result: { settled: true } });
      expect(await operationAuthorization?.requesterHttpProjection?.isCurrent()).toBe(false);
      expect(await operationAuthorization?.requesterAccountProjection?.readArtifact({ kind: 'doc', serverId: 'home-profile', artifactId })).toBeNull();
    } finally { await prepared.dispose(); }
  });

  it('keeps accepted private work current after the ingress releases custody and retires it on actual settlement', async () => {
    const admit = Reflect.get(requesterAccountOwner, 'admitRequesterAccountActionContext');
    expect(typeof admit).toBe('function');
    if (typeof admit !== 'function') throw new Error('Missing standalone requester Account admission');
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error('Unexpected private requester read');
    });
    const admitted = await admit({ authorization: { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'plain' } },
      credentials: { token: 'bob-ordinary', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => true });
    expect(admitted).not.toBeNull();
    if (!admitted?.authorization.requesterAccountProjection) throw new Error('Missing admitted requester projection');
    expect(admitted.retainCustody).toBeUndefined();
    const scope = { accountId: 'bob', machineId: 'machine' };
    const runner = createActionOperationRunner({ store: createActionOperationStore(), generateOperationId: () => 'private-operation',
      resolveAction: actionId => ({ actionId, title: 'Script', operation: {
        version: 1, visibility: 'activity', progress: 'reported', presentation: { onStart: 'current' },
      } }) });
    let settle!: () => void;
    const nativeSettlement = new Promise<void>(resolve => { settle = resolve; });
    await runner.observe({ actionId: 'projects.script.run', scope, execute: async context => {
      const release = admitted.retain();
      try {
        context.publishOwnerUpdate({ domainRef: { kind: 'projectCommand', purpose: 'script', serverId: 'home-profile',
          machineId: 'machine', workspaceRefId: 'workspace', cwd: '/project' }, state: 'running' });
        await nativeSettlement;
        return { ok: true, result: { requesterCurrent: await admitted.isCurrent() } };
      } finally { await release(); }
    } });
    await admitted.dispose();
    expect(await admitted.isCurrent()).toBe(true);
    settle();
    expect(await runner.waitForTerminal(scope, 'private-operation')).toMatchObject({ state: 'succeeded', result: { requesterCurrent: true } });
    expect(await admitted.authorization.requesterAccountProjection.isCurrent()).toBe(false);
  });
  it('admits an arbitrary-Machine Account invocation without creating a Session or changing daemon settings', async () => {
    const admit = Reflect.get(requesterAccountOwner, 'admitRequesterAccountActionContext');
    expect(typeof admit).toBe('function');
    if (typeof admit !== 'function') throw new Error('Missing standalone requester Account admission');
    const before = getActiveAccountSettingsSnapshot();
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => {
      expect(config?.headers?.Authorization).toBe('Bearer bob-ordinary');
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: { mode: 'plain', version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } };
      throw new Error('Unexpected private requester read');
    });
    let live = true;
    const context = await admit({ authorization: { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'plain' } },
      credentials: { token: 'bob-ordinary', encryption: null }, serverId: 'home-profile', serverIdentityId: 'stable-home',
      serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => live });
    try {
      expect(context?.authorization.requesterAccountProjection?.accountId).toBe('bob');
      expect(reads.mock.calls.filter(([url]) => String(url).endsWith('/v1/account/encryption/currentness'))).toHaveLength(1);
      expect(context?.accountSettingsContext.source).toBe('network');
      if (!context?.authorization.requesterAccountProjection) throw new Error('Missing admitted requester projection');
      const readContext = Reflect.get(requesterAccountOwner, 'readRequesterAccountActionContext');
      expect(typeof readContext).toBe('function');
      if (typeof readContext !== 'function') throw new Error('Missing admitted private custody consumer port');
      expect(readContext(context.authorization)).toBe(context);
      expect(readContext(ExternalActionExecutionAuthorizationV1Schema.parse(context.authorization))).toBeNull();
      expect(JSON.stringify(context.authorization)).not.toContain('bob-ordinary');
      // The signed requester is plain while the Machine custodian is E2EE.
      // This must spend the admitted requester observation, never custodian mode.
      const writes = vi.spyOn(axios, 'post').mockImplementation(async (_url, body) => ({ status: 200,
        data: { id: readCarrierMutation(body).id, headerVersion: 1, bodyVersion: 1 } }));
      const artifacts = createAccountArtifactStore({ credentials: { token: 'alice-custodian', encryption: {
        type: 'legacy', secret: new Uint8Array(32).fill(42) } }, getAccountEncryptionMode: async () => 'e2ee' });
      const authorizationHeaders = async (request: { method: string; path: string; body?: unknown }) => ({
        ...createExternalActionAuthorizedRequestHeaders({ authorization: context.authorization,
          effectActionId: context.authorization.binding.actionId, target: context.authorization.binding.target,
          installationId: 'installation', privateKey: nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(43)).secretKey,
          ...request }),
      });
      await runWithServerHttpBaseUrl('https://requester-home.test', () => artifacts.create({ artifactId: 'requester-receipt',
        header: { kind: 'example.v1' }, body: 'requester content', authorizationHeaders }));
      expect(readCarrierMutation(writes.mock.calls[0]![1]).dataEncryptionKey).toBe(ARTIFACT_PLAIN_DATA_KEY_MARKER);
      expect(reads.mock.calls.filter(([url]) => String(url).endsWith('/v1/account/encryption/currentness'))).toHaveLength(1);
      expect(getActiveAccountSettingsSnapshot()).toBe(before);
      expect(reads.mock.calls.some(([url]) => String(url).includes('/sessions'))).toBe(false);
    } finally { await context?.dispose(); }
    expect(await context!.authorization.requesterAccountProjection!.isCurrent()).toBe(false);
    live = false;
    expect(await admit({ authorization, credentials: { token: 'bob-ordinary', encryption: null },
      serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
      isCurrent: async () => live })).toBeNull();
  });
  it('refuses stale requester E2EE material against the published Home content fingerprint before first private writes', async () => {
    const secret = new Uint8Array(32).fill(12);
    const fingerprint = computeAccountEncryptionMigrateKeyFingerprintV1(nacl.box.keyPair.fromSecretKey(
      deriveAccountMachineKeyFromRecoverySecret(secret)).publicKey);
    vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/profile')) return { status: 200, data: { id: 'bob' } };
      if (url.endsWith('/v2/account/settings')) return { status: 200, data: { content: null, version: 0 } };
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing', contentKeyFingerprint: fingerprint, updatedAt: 1,
      } };
      throw new Error('Unexpected private requester read');
    });
    const admit = requesterAccountOwner.admitRequesterAccountActionContext;
    const input = { authorization: { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'e2ee' as const } },
      serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test', isCurrent: async () => true };
    const admitted = await admit({ ...input, credentials: { token: 'bob-private', encryption: { type: 'legacy', secret } } });
    expect(admitted).not.toBeNull();
    await admitted?.dispose();
    expect(await admit({ ...input, credentials: { token: 'bob-private', encryption: {
      type: 'legacy', secret: new Uint8Array(32).fill(13),
    } } })).toBeNull();
  });
  it('uses the exact admitted source Session for a Home-proved remote Project Action', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
    const sourceAuthorization = ExternalActionExecutionAuthorizationV1Schema.parse({
      ...authorization, binding: { ...authorization.binding, machineId: 'destination', installationId: 'destination-installation',
        target: { kind: 'machine', machineId: 'destination' },
        sessionActionSource: { machineId: 'machine', installationId: 'installation' },
        sessionActionOrigin: { v: 1, caller: { kind: 'session', sessionId: 'bob-session', starterDepth: 0, turnDepth: 0 },
          sourceTurnId: 'turn', callerPermissionMode: null, requestId: 'request' } },
    });
    const admitted = { ...bootstrap({ token: 'bob-ordinary', encryption: null }), getBoundSessionId: () => 'bob-session' };
    expect((await projectRequesterAccountActionAuthorization({ authorization: sourceAuthorization,
      serverIdentityId: 'stable-home', bootstrap: admitted }))?.requesterAccountProjection?.accountId).toBe('bob');
    expect(await projectRequesterAccountActionAuthorization({ authorization: sourceAuthorization,
      serverIdentityId: 'stable-home', bootstrap: { ...admitted, getBoundSessionId: () => 'another-session' } })).toBeNull();
  });
  it.each(['continuation', 'preflight'] as const)('projects the verified handoff %s to its exact admitted target Session without replacing the original source', async phase => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
    const child = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization, binding: {
      ...authorization.binding, actionId: phase === 'preflight' ? 'session.handoff' : 'session.handoff.prepare',
      sessionActionOrigin: { v: 1, caller: { kind: 'session', sessionId: 'original-caller', starterDepth: 0, turnDepth: 0 },
        sourceTurnId: 'turn', callerPermissionMode: null, requestId: 'request' },
      sessionActionSource: { machineId: 'source', installationId: 'source-installation' },
      handoffAdmission: { sessionId: 'transferred-session', sourceMachineId: 'source', targetMachineId: 'machine',
        sourceInstallationId: 'source-installation', targetInstallationId: 'installation' },
      ...(phase === 'preflight'
        ? { handoffPreflight: { rootRequestId: 'request', rootRequestEnvelopeDigest: 'b'.repeat(43) } }
        : { handoffContinuation: { handoffId: 'handoff', rootRequestId: 'request', rootRequestEnvelopeDigest: 'b'.repeat(43) } }),
    } });
    const admitted = { ...bootstrap({ token: 'bob-ordinary', encryption: null }), getBoundSessionId: () => 'transferred-session' };
    expect((await projectRequesterAccountActionAuthorization({ authorization: child,
      serverIdentityId: 'stable-home', bootstrap: admitted }))?.requesterAccountProjection?.accountId).toBe('bob');
    expect(await projectRequesterAccountActionAuthorization({ authorization: child,
      serverIdentityId: 'stable-home', bootstrap: { ...admitted, getBoundSessionId: () => 'other-session' } })).toBeNull();
  });

  it('retains the original requester HTTP proof while attaching private Account ports on the same carrier', async () => {
    const keys = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(31));
    let live = true;
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', version: 1,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 } });
    vi.spyOn(axios, 'post').mockImplementation(async () => ({ status: live ? 200 : 403,
      data: live ? { ok: true } : {} }));
    const original = await projectExternalActionRequesterHttpAuthorization({ authorization,
      serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
      target: authorization.binding.target, installationId: 'installation', privateKey: keys.secretKey });
    if (!original?.requesterHttpProjection) throw new Error('Expected the original Home HTTP proof');
    const carrier = await projectRequesterAccountActionAuthorization({ authorization: original,
      serverIdentityId: 'stable-home', bootstrap: bootstrap({ token: 'bob-ordinary', encryption: null }) });
    expect(carrier?.requesterAccountProjection?.accountId).toBe('bob');
    expect(await carrier?.requesterHttpProjection?.createRequestHeaders({ effectActionId: 'projects.context.update',
      method: 'POST', path: '/v1/projects/account-rows/list', body: {} })).toMatchObject({
      [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
    });
    expect(JSON.parse(JSON.stringify(carrier))).toEqual(authorization);
    // Withdrawal reaches the next admission: this operation signs on, Home decides
    // each signed call, and a new carrier spends a new proof.
    live = false;
    expect(await carrier?.requesterHttpProjection?.createRequestHeaders({ effectActionId: 'projects.context.update',
      method: 'POST', path: '/v1/projects/account-rows/list', body: {} })).toMatchObject({
      [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
    });
    expect(await projectExternalActionRequesterHttpAuthorization({ authorization,
      serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
      target: authorization.binding.target, installationId: 'installation', privateKey: keys.secretKey })).toBeNull();
  });

  it('finishes an admitted own-Session workspace read and refuses the next read after access loss', async () => {
    const { createSessionNotificationContextFixture } = await import('@/testkit/backends/sessionFixtures');
    const { createTestMetadata } = await import('@/testkit/backends/sessionMetadata');
    const sessionId = 'caaaaaaaaaaaaaaaaaaaaaaaa';
    const session = { ...createSessionNotificationContextFixture(sessionId), encryptionMode: 'plain',
      metadata: JSON.stringify(createTestMetadata({ machineId: 'machine', path: '/workspace' })) };
    let live = true;
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (new URL(url).pathname === `/v2/sessions/${sessionId}`) return { status: 200, data: { session } };
      if (url.endsWith('/v1/account/encryption')) {
        live = false;
        return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      }
      throw new Error(`Unexpected workspace read: ${new URL(url).pathname}`);
    });
    const projected = await projectRequesterAccountActionAuthorization({ authorization,
      serverIdentityId: 'stable-home', bootstrap: bootstrap({ token: 'bob-ordinary', encryption: null }, async () => live) });
    const reader = projected?.requesterAccountProjection;
    if (!reader?.readOwnSessionWorkspace) throw new Error('Expected admitted workspace reader');
    const request = { sessionId, machineId: 'machine', currentMachineHost: 'test-host', currentMachineHomeDir: '/tmp' };
    const cancelled = new AbortController();
    cancelled.abort();
    const before = reads.mock.calls.length;
    expect(await reader.readOwnSessionWorkspace({ ...request, signal: cancelled.signal })).toBeNull();
    expect(reads.mock.calls).toHaveLength(before);
    expect(await reader.readOwnSessionWorkspace(request)).toEqual({ rootPath: '/workspace' });
    const sessionReads = () => reads.mock.calls.filter(([url]) => new URL(String(url)).pathname === `/v2/sessions/${sessionId}`);
    const admittedReads = sessionReads().length;
    expect(await reader.readOwnSessionWorkspace(request)).toBeNull();
    expect(sessionReads()).toHaveLength(admittedReads);
  });

  it('finishes an admitted requester Artifact read at its original Home and refuses the next read after access loss', async () => {
    const artifactId = '11111111-1111-4111-8111-111111111111';
    let live = true;
    let loseAdmissionDuringRead = false;
    const header = { kind: 'prompt_doc.v2', title: 'Bob private doc' };
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url.endsWith('/access/grants')) return { status: 200, data: { artifactId, ownerAccountId: 'bob', access: 'owner', grants: [] } };
      if (loseAdmissionDuringRead) live = false;
      return { status: 200, data: { id: artifactId, ownerAccountId: 'bob', access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent(header), body: encodePlainArtifactStoredContent({ body: 'private body' }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
    });
    const projected = await projectRequesterAccountActionAuthorization({ authorization,
      serverIdentityId: 'stable-home', bootstrap: bootstrap({ token: 'bob-ordinary', encryption: null }, async () => live) });
    if (!projected?.requesterAccountProjection) throw new Error('Expected admitted reader');
    const ref = { kind: 'doc' as const, serverId: 'home-profile', artifactId };
    const opened = await projected.requesterAccountProjection.readArtifact(ref);
    expect(opened).toMatchObject({ artifactId, header,
      promptLibraryArtifact: { id: artifactId, header, body: 'private body', revision: { headerVersion: 1, bodyVersion: 1 } } });
    expect(opened).not.toHaveProperty('document');
    expect(reads.mock.calls.every(([url, config]) => String(url).startsWith('https://requester-home.test/')
      && config?.headers?.Authorization === 'Bearer bob-ordinary')).toBe(true);
    loseAdmissionDuringRead = true;
    expect(await projected.requesterAccountProjection.readArtifact(ref)).toMatchObject({ artifactId, header });
    const artifactReads = () => reads.mock.calls.filter(([url]) => new URL(String(url)).pathname.startsWith('/v1/artifacts/'));
    const admittedReads = artifactReads().length;
    expect(await projected.requesterAccountProjection.readArtifact(ref)).toBeNull();
    expect(artifactReads()).toHaveLength(admittedReads);
  });

  function createPreparedDeploymentFixture(options: Readonly<{ serverId: string; artifactId: string }>) {
    const receipt = createDeploymentReceiptDetailV1();
    const input = DeploymentDeployActionInputV1Schema.parse({ serverId: options.serverId,
      environmentId: receipt.deployment.environmentId, targetLinkId: receipt.deployment.targetLinkId,
      expectedRevision: 1, expectedTargetLinkRevision: 1, requestKey: receipt.deployment.requestKey,
      contentArtifactId: options.artifactId, contentHeaderVersion: 1, contentBodyVersion: 1 });
    return { input, artifact: { artifactId: options.artifactId,
      header: createDeploymentReceiptArtifactHeaderV1('Deployment', receipt.content),
      body: JSON.stringify(receipt.content), revision: { headerVersion: 1, bodyVersion: 1 } } };
  }

  it.each(['registries.updates.check', 'projects.sources.update', 'projects.setup.set'] as const)(
    'opens %s content through its unchanged signed requester proof without an ambient bearer', async actionId => {
    const artifactId = '11111111-1111-4111-8111-111111111111';
    const candidate = createPreparedDeploymentFixture({ serverId: 'stable-home', artifactId });
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization, binding: {
      ...authorization.binding, actionId,
      ...(actionId === 'registries.updates.check'
        ? { registryAppUpdateAdmission: { environments: [{ environmentId: 'staging', expectedRevision: 1 }] } } : {}),
    } });
    const sourceScope = actionId === 'projects.sources.update'
      ? { projectSourceId: 'source', projectSourcePatch: { audience: [] } } : {};
    const artifactPath = `/v1/artifacts/${artifactId}${sourceScope.projectSourceId ? '?projectSourceId=source' : ''}`;
    let live = true;
    vi.spyOn(axios, 'post').mockImplementation(async url => {
      expect(String(url)).toBe(`https://requester-home.test/v1/actions/${actionId}/execution-authorization/verify`);
      return { status: live ? 200 : 403, data: live ? { ok: true } : {} };
    });
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      if (url !== `https://requester-home.test${artifactPath}`) throw new Error('unexpected_app_content_read');
      return { status: 200, data: { id: artifactId, ownerAccountId: 'bob', access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent(candidate.artifact.header),
        body: encodePlainArtifactStoredContent({ body: candidate.artifact.body }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
    });
    const keys = nacl.sign.keyPair();
    const signed = await projectExternalActionRequesterHttpAuthorization({ authorization: root,
      serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
      target: root.binding.target, installationId: 'installation', privateKey: keys.secretKey, isCurrent: async () => live });
    if (!signed) throw new Error('signed_registry_read_required');
    const projected = await projectRequesterAccountActionAuthorization({ authorization: signed,
      serverIdentityId: 'stable-home', bootstrap: bootstrap({ token: 'bob-ordinary', encryption: null }, async () => live) });
    if (!projected?.requesterAccountProjection) throw new Error('registry_account_projection_required');
    const ref = { kind: 'doc' as const, serverId: 'home-profile', artifactId };
    expect(await projected.requesterAccountProjection.readArtifact(ref, { ...sourceScope, authorization: projected })).toMatchObject({
      document: { artifactId, header: candidate.artifact.header, body: candidate.artifact.body },
    });
    const contentReads = () => reads.mock.calls.filter(([url]) => String(url).includes('/v1/artifacts/'));
    expect(contentReads()).toHaveLength(1);
    const headers = contentReads()[0]?.[1]?.headers;
    expect(headers).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token });
    expect(headers).not.toHaveProperty('Authorization');
    const count = contentReads().length;
    expect(await projected.requesterAccountProjection.readArtifact(ref, sourceScope)).toBeNull();
    live = false;
    expect(await projected.requesterAccountProjection.readArtifact(ref, { ...sourceScope, authorization: projected })).toBeNull();
    expect(contentReads()).toHaveLength(count);
  });

  it.each(['machines.setup.plan', 'machines.setup.apply'] as const)(
    'opens the admitted %s candidate and Environment documents only through the unchanged signed proof', async actionId => {
    const candidate = createPreparedDeploymentFixture({ serverId: 'stable-home',
      artifactId: '11111111-1111-4111-8111-111111111111' });
    const environmentContent = createDeploymentEnvironmentV1().content;
    if (environmentContent.t !== 'plain') throw new Error('plain_environment_fixture_required');
    const environmentArtifact = { artifactId: '22222222-2222-4222-8222-222222222222',
      header: DeploymentEnvironmentArtifactHeaderV1Schema.parse({ kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_KIND_V1, title: 'Staging' }),
      body: JSON.stringify(environmentContent.v), revision: { headerVersion: 1, bodyVersion: 1 } };
    const target = { homeId: 'stable-home', machineId: 'runtime', sources: [{ kind: 'direct', setup: {} }],
      ...(actionId === 'machines.setup.apply' ? { desiredRevision: 0, recipePlans: [] } : {}),
      appChildren: [{ sourceIndex: 0, itemIndex: 0, actionId: 'deployments.deploy', input: candidate.input }] };
    const root = ExternalActionExecutionAuthorizationV1Schema.parse({ ...authorization, binding: {
      ...authorization.binding, actionId,
      deploymentPreparationAdmission: projectDeploymentPreparationAdmissionV1(actionId,
        { homeId: 'stable-home', machineId: 'machine', targets: [target] }),
    } });
    expect(root.binding.deploymentPreparationAdmission).toMatchObject({ operation: 'setup', deployments: [{
      candidate: { contentArtifactId: candidate.artifact.artifactId, contentHeaderVersion: 1, contentBodyVersion: 1 },
    }] });
    const keys = nacl.sign.keyPair();
    let live = true;
    vi.spyOn(axios, 'post').mockImplementation(async url => {
      expect(String(url)).toBe(`https://requester-home.test/v1/actions/${actionId}/execution-authorization/verify`);
      return { status: live ? 200 : 403, data: live ? { ok: true } : {} };
    });
    const reads = vi.spyOn(axios, 'get').mockImplementation(async (url: string, config) => {
      if (url.endsWith('/v1/account/encryption/currentness')) return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (url.endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      const artifact = [candidate.artifact, environmentArtifact].find(value => url === `https://requester-home.test/v1/artifacts/${value.artifactId}`);
      const headers = config?.headers;
      // Preserve Home's ordinary Account read as well: the regression must
      // expose the projector dropping an available document, not fixture denial.
      const ordinary = headers?.Authorization === 'Bearer bob-ordinary';
      if (!artifact || !live || !ordinary && (headers?.Authorization !== undefined
        || headers?.[EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER] !== root.token
        || !verifyExternalActionMachineRequestV1({ authorizationToken: root.token, effectActionId: actionId,
          target: root.binding.target, installationId: 'installation', requestId: root.binding.requestId,
          method: 'GET', path: `/v1/artifacts/${artifact.artifactId}`,
          signature: String(headers?.['x-happier-action-machine-signature'] ?? ''), publicKey: keys.publicKey })))
        return { status: 403, data: {} };
      return { status: 200, data: { id: artifact.artifactId, ownerAccountId: 'bob', access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent(artifact.header), body: encodePlainArtifactStoredContent({ body: artifact.body }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, ...artifact.revision, seq: 1, createdAt: 1, updatedAt: 1 } };
    });
    const signed = await projectExternalActionRequesterHttpAuthorization({ authorization: root,
      serverId: 'home-profile', serverIdentityId: 'stable-home', serverHttpBaseUrl: 'https://requester-home.test',
      target: root.binding.target, installationId: 'installation', privateKey: keys.secretKey, isCurrent: async () => live });
    if (!signed) throw new Error('signed_setup_required');
    const projected = await projectRequesterAccountActionAuthorization({ authorization: signed,
      serverIdentityId: 'stable-home', bootstrap: bootstrap({ token: 'bob-ordinary', encryption: null }, async () => live) });
    if (!projected?.requesterAccountProjection) throw new Error('setup_account_projection_required');
    const reader = projected.requesterAccountProjection;
    const ref = { kind: 'doc' as const, serverId: 'home-profile', artifactId: candidate.artifact.artifactId };
    const openedCandidate = await reader.readArtifact(ref, { authorization: projected });
    expect(openedCandidate).toMatchObject({ artifactId: candidate.artifact.artifactId });
    expect(readDeploymentReceiptArtifactV1(candidate.input, openedCandidate?.document ?? null))
      .toMatchObject({ ok: true });
    const openedEnvironment = await reader.readArtifact({ ...ref, artifactId: environmentArtifact.artifactId }, { authorization: projected });
    expect(readDeploymentEnvironmentArtifactV1({ contentArtifactId: environmentArtifact.artifactId,
      contentHeaderVersion: 1, contentBodyVersion: 1 }, openedEnvironment?.document ?? null)).toMatchObject({ ok: true });
    const artifactReads = () => reads.mock.calls.filter(([url]) => String(url).includes('/v1/artifacts/'));
    expect(artifactReads()).toHaveLength(2);
    for (const [, config] of artifactReads()) {
      expect(config?.headers).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: root.token });
      expect(config?.headers).not.toHaveProperty('Authorization');
    }
    expect(await reader.readArtifact({ ...ref, artifactId: '33333333-3333-4333-8333-333333333333' }, { authorization: projected })).toBeNull();
    const count = artifactReads().length;
    expect(await reader.readArtifact(ref)).toBeNull();
    expect(await reader.readArtifact(ref, { authorization: root })).toBeNull();
    const substituted = Object.defineProperty({ ...projected, token: 'another-root' }, 'requesterHttpProjection',
      { value: projected.requesterHttpProjection });
    expect(await reader.readArtifact(ref, { authorization: substituted })).toBeNull();
    live = false;
    expect(await reader.readArtifact(ref, { authorization: projected })).toBeNull();
    expect(artifactReads()).toHaveLength(count);
  });

  it('supplies Bob private-row crypto on the existing carrier without serializing private ports', async () => {
    const secret = new Uint8Array(32).fill(7);
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'e2ee', version: 1,
      signingKeyFingerprint: 'signing', contentKeyFingerprint: 'content', updatedAt: 1 } });
    const result = await projectRequesterAccountActionAuthorization({ authorization,
      serverIdentityId: 'stable-home', bootstrap: bootstrap({ token: 'bob-ordinary', encryption: { type: 'legacy', secret } }) });
    const projection = result?.requesterAccountProjection;
    expect(projection).toBeDefined();
    const key = { kind: 'project-organization', serverId: 'home-profile', projectKey: 'project' } as const;
    const payload = { key, value: { pinned: true } };
    const sealed = projection!.projectAccountRowCipher.seal(payload);
    expect(createProjectAccountRowCipherV1({ mode: 'e2ee', material: { type: 'legacy', secret },
      randomBytes: length => new Uint8Array(length) }).open(key, sealed)).toEqual(payload);
    expect(() => createProjectAccountRowCipherV1({ mode: 'e2ee', material: { type: 'legacy', secret: new Uint8Array(32).fill(8) },
      randomBytes: length => new Uint8Array(length) }).open(key, sealed)).toThrow();
    expect(JSON.parse(JSON.stringify(result))).toEqual(authorization);
    expect(ExternalActionExecutionAuthorizationV1Schema.parse(result)).toEqual(authorization);
    expect(await projection!.readArtifact({ kind: 'doc', serverId: 'another-home', artifactId: 'artifact' })).toBeNull();
  });

  it('refuses wrong requester, Home, installation and lost admission before opening any private content', async () => {
    const read = vi.spyOn(axios, 'get');
    const admitted = bootstrap({ token: 'bob', encryption: null });
    for (const binding of [
      { ...authorization.binding, accountId: 'alice' },
      { ...authorization.binding, installationId: 'replaced' },
      { ...authorization.binding, machineId: 'another-machine' },
    ]) {
      expect(await projectRequesterAccountActionAuthorization({ authorization: { ...authorization, binding },
        serverIdentityId: 'stable-home', bootstrap: admitted })).toBeNull();
    }
    expect(await projectRequesterAccountActionAuthorization({ authorization, serverIdentityId: 'another-home', bootstrap: admitted })).toBeNull();
    expect(await projectRequesterAccountActionAuthorization({ authorization, serverIdentityId: 'stable-home',
      bootstrap: bootstrap(admitted.credentials, async () => false) })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it('does not turn missing E2EE material into plaintext, or expose a read that loses current admission', async () => {
    let live = true;
    vi.spyOn(axios, 'get').mockImplementation(async () => {
      live = false;
      return { status: 200, data: { mode: 'e2ee', version: 1, signingKeyFingerprint: 'signing', contentKeyFingerprint: 'content', updatedAt: 1 } };
    });
    expect(await projectRequesterAccountActionAuthorization({ authorization, serverIdentityId: 'stable-home',
      bootstrap: bootstrap({ token: 'bob', encryption: null }, async () => live) })).toBeNull();
  });

  it('refuses private ports when the authenticated Account mode no longer matches the Home proof', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', version: 2,
      signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 2 } });
    const e2eeProof = { ...authorization, binding: { ...authorization.binding, accountEncryptionMode: 'e2ee' as const } };
    expect(await projectRequesterAccountActionAuthorization({ authorization: e2eeProof,
      serverIdentityId: 'stable-home', bootstrap: bootstrap({ token: 'bob', encryption: null }) })).toBeNull();
  });
});
