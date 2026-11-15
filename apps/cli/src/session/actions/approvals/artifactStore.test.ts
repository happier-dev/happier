import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import { z } from 'zod/mini';
import tweetnacl from 'tweetnacl';
import { computeExternalActionRequestEnvelopeDigestV1, signExternalActionApprovalInputV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';

import type { Credentials, StoredCredentials } from '@/persistence';
import { decodeBase64, decryptWithDataKey, encryptWithDataKey, encodeBase64, libsodiumPublicKeyFromSecretKey } from '@/api/encryption';
import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  API_TOKEN_FULL_GRANT_V1,
  ApprovalRequestV1Schema,
  ApprovalRequestV2Schema,
  ExecutionRunHostActionApprovalRequestV1Schema,
  TargetActionApprovalRequestV1Schema,
  encodePlainArtifactStoredContent,
  decodePlainArtifactStoredContent,
  openEncryptedDataKeyEnvelopeV1,
  updatePromptDocInLibrary,
  createPromptDocInLibrary,
  setPromptDocFavorite,
  listPromptLibrary,
} from '@happier-dev/protocol';

import { executeExternalAction } from '@/daemon/externalActions/executeExternalAction';
import { sealManagedControllerActionCodecV1 } from '@happier-dev/protocol/sessions/creation/sessionRequesterBootstrapV1';
import { createDaemonExternalActionTargetResolver } from '@/daemon/externalActions/daemonExternalActionTargetResolver';
import { sealExternalActionRequestV2, openExternalActionResponseV2 } from '@happier-dev/protocol/actions/externalActionEncryption';
import { projectExternalActionMachineRuntimeDemandV1 } from '@happier-dev/protocol/actions/actionSpecs';
import { normalizeActionExecuteResult, projectCliActionFailure } from '@/cli/commands/session/shared/normalizeActionExecuteResult';
import { finiteActionExitCode } from '@/cli/actions/finiteOutcome';
import { ActionsSettingsV1Schema } from '@happier-dev/protocol/actions/actionSettings';
import { createCliActionExecutorHarness } from '../createCliActionExecutorHarness';
import { createCliApprovalsArtifactStore } from './artifactStore';
import { buildApprovalRequestArtifactHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { encodeAccountArtifactListCursor } from '@/api/artifacts/accountArtifactStore';
import { ArtifactHttpReadV1Schema, ArtifactHttpHeaderReadV1Schema, ArtifactReadBatchInputV1Schema, ArtifactReadBatchResponseV1Schema,
  ArtifactReadHeadersBatchInputV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { sealManagedMachinePresetContentV1, projectManagedMachinePresetForRecipientV1, createManagedMachinePresetAcquireOverrideV1 } from '@happier-dev/protocol/machines/managed/managedMachinePresetContentV1';
import { ManagedAcquireInputV1Schema } from '@happier-dev/protocol/machines/managed/actionsV1';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createProjectServiceDeclarationTargetIdV1 } from '@happier-dev/protocol/local/services/actions/v1';
import { DaemonLocalServiceLauncherStartRequestV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import { executeArtifactFolderActionV1 } from '@happier-dev/protocol/prompts/library/promptFolderActionsV1';
import { PromptLibraryCatalogKeyV1Schema, PromptLibraryRowMutationV1Schema, openPromptLibraryContentV1, sealPromptLibraryContentV1, type PromptLibraryRecordV1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { createAccountScopedCryptoMaterialSnapshotV1, sealAccountScopedBlobCiphertext } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { accountSettingsParse } from '@happier-dev/protocol/account/settings/accountSettings';
import { setActiveAccountSettingsSnapshot, resetActiveAccountSettingsSnapshotForTests } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { resolveAccountSettingsScopeKey } from '@/settings/accountSettings/accountSettingsScopeKey';
import { artifactListResponse } from '@/testkit/http/artifactHome';
import { requesterAccountEncryptionMode } from '@/daemon/sessionEncryption/requesterAccountActionContext';

const { mockGet, mockPost } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
}));

const fixtureArtifacts = vi.hoisted(() => new Map<string, Record<string, unknown>>());

/** Opaque HTTP storage for the creation owner's exact-id read/create/rejoin. */
function createdArtifactResponse(input: Readonly<Record<string, unknown>>, encryptionMode: 'plain' | 'e2ee', ownerAccountId = 'acc_1') {
  if (typeof input.id !== 'string') throw new Error('fixture_artifact_id_required');
  fixtureArtifacts.set(input.id, { ...input, ownerAccountId, access: 'owner', encryptionMode, publicAudience: 'none',
    headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
  return { status: 200, data: { id: input.id, headerVersion: 1, bodyVersion: 1 } };
}

function batchFixtureItem(artifactId: string, raw: unknown) {
  if (!raw || typeof raw !== 'object') throw new Error('Missing Artifact HTTP fixture');
  const artifact = ArtifactHttpReadV1Schema.parse({ ...raw, publicAudience: Reflect.get(raw, 'publicAudience') ?? 'none' });
  return { artifactId, ok: true as const, artifact, recipientCensus: artifact.encryptionMode === 'plain' ? null : {
    artifactId, ownerAccountId: artifact.ownerAccountId, access: artifact.access, encryptionMode: artifact.encryptionMode,
    dataEncryptionKey: artifact.dataEncryptionKey, callerDataEncryptionKey: artifact.dataEncryptionKey, recipients: [],
  } };
}

vi.mock('axios', () => ({
  default: {
    defaults: {},
    get: vi.fn(async (url: string, config?: unknown) => {
      if (url.endsWith('/recipients')) {
        const artifactId = decodeURIComponent(url.split('/').at(-3) ?? '');
        const artifact = fixtureArtifacts.get(artifactId);
        if (!artifact) throw new Error('Missing Artifact HTTP census fixture');
        return { status: 200, data: { artifactId, ownerAccountId: artifact.ownerAccountId,
          access: artifact.access, encryptionMode: artifact.encryptionMode,
          dataEncryptionKey: artifact.dataEncryptionKey, callerDataEncryptionKey: artifact.dataEncryptionKey, recipients: [] } };
      }
      let response = await mockGet(url, config);
      // Unconfigured exact-record reads are absent until this fixture's
      // successful HTTP create. Explicit responses keep precedence.
      if (response === undefined && /^\/v1\/artifacts\/[^/]+$/.test(new URL(url).pathname)) {
        const record = fixtureArtifacts.get(decodeURIComponent(new URL(url).pathname.split('/').at(-1)!));
        response = record ? { status: 200, data: record } : { status: 404, data: { error: 'artifact_not_found' } };
      }
      const payload: unknown = response?.data;
      const envelopeItems: unknown = payload && typeof payload === 'object' ? Reflect.get(payload, 'items') : undefined;
      const rows: unknown[] = Array.isArray(payload) ? payload : Array.isArray(envelopeItems) ? envelopeItems : [payload];
      for (const row of rows) {
        if (row && typeof row === 'object' && typeof Reflect.get(row, 'id') === 'string') {
          fixtureArtifacts.set(Reflect.get(row, 'id'), row as Record<string, unknown>);
        }
      }
      // Model the real Home response for the selected request, while keeping
      // each case's codecs, row revisions and list/body assertions intact.
      return new URL(url).pathname === '/v1/artifacts' && Array.isArray(payload)
        ? { ...response, data: artifactListResponse(url, payload) }
        : response;
    }),
    post: mockPost,
  },
}));

vi.mock('@/configuration', () => ({
  configuration: {
    apiServerUrl: 'http://127.0.0.1:24599',
    activeServerId: 'home',
    activeServerDir: '/tmp/happier-cli-artifact-store-test',
  },
}));

describe('createCliApprovalsArtifactStore', () => {
  it.each(['plain', 'e2ee'] as const)('creates and reads %s approvals with the configured signed Artifact request', async mode => {
    const credentials: StoredCredentials = mode === 'plain'
      ? { token: 'unusable-daemon-bearer', encryption: null } : createCredentials();
    const signedHeaders = vi.fn(async () => ({ 'x-external-action-execution-authorization': 'signed-parent-root',
      [requesterAccountEncryptionMode]: mode }));
    const store = createCliApprovalsArtifactStore({ credentials,
      getAccountEncryptionMode: async () => mode, approvalAuthorizationHeaders: signedHeaders });
    const target = { kind: 'session' as const, sessionId: 's1' };
    const envelope = { v: 1 as const, requestId: 'signed-approval', target,
      input: { sessionId: 's1', message: 'hello' } };
    const request = ApprovalRequestV2Schema.parse({ v: 2, actionId: 'session.message.send', status: 'open',
      summary: 'Review message', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli', sessionId: 's1' }, actionArgs: envelope.input,
      executionOriginV1: { v: 1, authority: 'account_automation', surface: 'api', caller: { kind: 'host' },
        accountId: 'acc_1', principalId: 'principal-1', credentialId: 'credential-1',
        serverId: 'home', serverIdentityId: 'home', sessionId: 's1', target,
        actionId: 'session.message.send', requestId: envelope.requestId, machineId: 'machine-1',
        externalActionInputSignature: 'a'.repeat(86), originalActionEnvelope: envelope,
        externalActionExecutionAuthorization: { v: 1, token: 'home-signed-root', binding: {
          accountId: 'acc_1', custodianAccountId: 'acc_1', principalId: 'principal-1', credentialId: 'credential-1',
          grant: API_TOKEN_FULL_GRANT_V1, serverIdentityId: 'home', machineId: 'machine-1',
          installationId: 'installation-1', actionId: 'session.message.send', requestId: envelope.requestId,
          target, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } },
      },
    });
    mockPost.mockImplementation(async (url: string, body: Readonly<Record<string, unknown>>, config: Readonly<{ headers?: Record<string, string> }>) => {
      expect(new URL(url).pathname).toBe('/v1/artifacts');
      expect(config.headers).toMatchObject({ 'x-external-action-execution-authorization': 'signed-parent-root' });
      expect(config.headers?.Authorization).toBeUndefined();
      return createdArtifactResponse(body, mode);
    });
    mockGet.mockImplementation(async (url: string, config: Readonly<{ headers?: Record<string, string> }>) => {
      if (new URL(url).pathname.startsWith('/v1/artifacts/')) {
        expect(config.headers).toMatchObject({ 'x-external-action-execution-authorization': 'signed-parent-root' });
        expect(config.headers?.Authorization).toBeUndefined();
      }
      return undefined;
    });

    const created = await store.approvalsCreate({ request, serverId: 'home' });
    expect(await store.approvalsGet({ artifactId: created.artifactId, serverId: 'home' })).toMatchObject(request);
    expect(await store.approvalsCreate({ request, serverId: 'home' })).toMatchObject({ artifactId: created.artifactId });
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(signedHeaders).toHaveBeenCalledWith(expect.objectContaining({ method: 'POST', path: '/v1/artifacts' }));
  });

  it.each((['plain', 'e2ee'] as const).flatMap(mode => (['one-off', 'preset'] as const).map(selection => ({ mode, selection }))))(
    'settles foreign $mode $selection terminal acquire approval custody before writing a custodian Artifact', async ({ mode, selection }) => {
    const actionId = 'machines.managed.acquire';
    const target = { kind: 'machine' as const, machineId: 'company-controller' };
    const launch = { provider: { pluginId: 'machine.example', localId: 'vm' }, schemaVersion: 1, name: 'Work VM', choices: {} };
    const enrollmentIdentity = { kind: 'dedicatedDaemonUser', username: 'happier', serviceMode: 'user', role: 'server', adminAccessAtCreation: 'none' } as const;
    const controller = { machineId: target.machineId, installationId: 'company-installation' };
    const retention = { kind: 'until-delete' } as const;
    const presetId = 'shared-preset';
    const sealed = sealManagedMachinePresetContentV1({ presetId, mode: 'plain', content: { v: 1, name: 'Shared preset', launch } });
    const presetContentOverride = createManagedMachinePresetAcquireOverrideV1({ presetId, mode: 'plain', enrollmentIdentity,
      projection: projectManagedMachinePresetForRecipientV1({ ...sealed, recipientAccountId: 'requester' }) });
    if (!presetContentOverride) throw new Error('Expected canonical preset override');
    const input = ManagedAcquireInputV1Schema.parse(selection === 'one-off' ? {
      enrollmentIdentity, selection: { kind: 'one-off', homeId: 'srv_home', controller, launch, retention, wakeOnAcceptedMessage: false },
    } : {
      selection: { kind: 'preset', homeId: 'srv_home', id: presetId, revision: 1 },
      controller, retention, wakeOnAcceptedMessage: false, presetContentOverride,
    });
    const envelope = { v: 1 as const, requestId: 'foreign-approval', target, input };
    const request = ApprovalRequestV2Schema.parse({ v: 2, actionId, status: 'open', summary: 'Review delivery',
      createdAtMs: 1, updatedAtMs: 1, createdBy: { surface: 'cli' }, actionArgs: envelope.input,
      executionOriginV1: { v: 1, authority: 'present_user', surface: 'cli', caller: { kind: 'host' },
        accountId: 'requester', serverId: 'home', serverIdentityId: 'srv_home', target,
        actionId, requestId: envelope.requestId, machineId: target.machineId,
        externalActionInputSignature: 'a'.repeat(86), originalActionEnvelope: envelope,
        externalActionExecutionAuthorization: { v: 1, token: 'home-signed-root', binding: {
          accountId: 'requester', custodianAccountId: 'company', authentication: { kind: 'terminal', tokenEpoch: 1 },
          accountEncryptionMode: 'plain', serverIdentityId: 'srv_home', machineId: target.machineId,
          installationId: 'company-installation', actionId, requestId: envelope.requestId, target,
          requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
        } },
      },
    });
    const tokenFor = (accountId: string) => `fixture.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;
    mockPost.mockImplementation(async (_url: string, body: Readonly<{ id: string }>) =>
      createdArtifactResponse(body, 'plain', request.executionOriginV1.accountId));
    const custodianCredentials: StoredCredentials = { token: tokenFor('company'),
      encryption: mode === 'plain' ? null : createCredentials().encryption };
    const custodian = createStore(custodianCredentials, mode);
    await expect(custodian.approvalsCreate({ request, serverId: 'home' })).rejects.toMatchObject({ code: 'credential_scope_denied' });
    expect(mockPost).not.toHaveBeenCalled();
    const installation = tweetnacl.sign.keyPair();
    const deliveries: unknown[] = [];
    const actionsSettings = ActionsSettingsV1Schema.parse({ v: 1,
      actions: { [actionId]: { approvalRequiredSurfaces: ['cli'] } } });
    const executorFor = (store: typeof custodian, credentials: StoredCredentials) => createCliActionExecutorHarness({
      token: credentials.token, credentials, sessionId: 'cli-global', serverId: 'home', serverIdentityId: 'srv_home',
      serverHttpBaseUrl: 'http://127.0.0.1:24599', runtimeActionMachineId: target.machineId,
      actionsSettingsProvider: { getActionsSettings: () => actionsSettings, getAccountSettings: () => null },
    }, {
      ...createUnavailableActionTransportDeps(), ...store,
      managedMachineAction: async input => { deliveries.push(input); return { managedId: 'must-not-exist' }; },
    }).executor;
    // Home authorization is the ingress boundary. Preparation, origin signing,
    // approval creation and the custodian's persistent store remain real.
    const context = { surface: 'cli' as const, authority: 'present_user' as const,
      serverId: 'home', serverIdentityId: 'srv_home', runtimeAccountId: 'requester',
      defaultSessionMachineId: target.machineId, externalActionTarget: target,
      actionRequestId: envelope.requestId, originalActionEnvelope: envelope,
      externalActionExecutionAuthorization: request.executionOriginV1.externalActionExecutionAuthorization,
      signExternalActionApprovalInput: input =>
        signExternalActionApprovalInputV1({ actionId: input.actionId, input: input.input, target: input.target,
          authorizationToken: input.authorization.token, privateKey: installation.secretKey }),
    } satisfies import('@happier-dev/protocol').ActionExecutorContext;
    const executor = executorFor(custodian, custodianCredentials);
    const prepared = await executor.prepare(actionId, envelope.input, context);
    expect(prepared, JSON.stringify(prepared)).toMatchObject({
      kind: 'settled', result: { ok: false, errorCode: 'credential_scope_denied' },
    });
    await expect(executor.execute(actionId, envelope.input, context)).resolves.toMatchObject({
      ok: false, errorCode: 'credential_scope_denied',
    });
    const material = { type: 'dataKey' as const, machineKey: new Uint8Array(32).fill(45) };
    const binding = { serverIdentityId: 'srv_home', accountId: 'requester',
      authentication: { kind: 'terminal' as const, tokenEpoch: 1 }, actionId, requestId: envelope.requestId, target };
    const wireEnvelope = mode === 'plain' ? envelope : sealExternalActionRequestV2({
      projectMachineRuntimeDemand: projectExternalActionMachineRuntimeDemandV1,
      binding, material, input, randomBytes: tweetnacl.randomBytes,
    });
    const authorization = sealManagedControllerActionCodecV1({ authorization: { v: 1 as const, token: 'home-signed-root', binding: { ...binding,
      machineId: target.machineId, custodianAccountId: 'company', installationId: controller.installationId,
      accountEncryptionMode: mode, requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(wireEnvelope) } },
      material, installationPublicKey: installation.publicKey, randomBytes: tweetnacl.randomBytes });
    // Home verification and installed keys are external boundaries. The real
    // receiver chooses its context, executes and seals the typed refusal.
    const received = await executeExternalAction({ actionId, envelope: wireEnvelope,
      principal: { accountId: 'requester', authentication: binding.authentication, authority: 'account_automation' },
      executionAuthorization: authorization, surface: 'cli', currentAccountId: 'company',
      currentMachineId: target.machineId, currentServerId: binding.serverIdentityId,
      currentInstallationId: controller.installationId, externalActionMachineRequestPrivateKey: installation.secretKey,
      verifyExecutionAuthorization: async () => true,
      resolveEncryption: async () => ({ serverIdentityId: binding.serverIdentityId, material }),
      resolveTarget: createDaemonExternalActionTargetResolver({ credentials: { token: tokenFor('company'), encryption: null } }),
      executor,
    });
    expect(received, JSON.stringify(received)).toMatchObject({ kind: 'response' });
    if (received.kind !== 'response') throw new Error('Expected admitted receiver response');
    const execution = wireEnvelope.v === 2 ? openExternalActionResponseV2({
      envelope: received.response, binding, material, request: wireEnvelope,
    }) : received.response.v === 1 ? received.response.execution : null;
    expect(execution, JSON.stringify(execution)).toMatchObject({ ok: false, errorCode: 'credential_scope_denied',
      error: 'credential_scope_denied', requestId: envelope.requestId,
      failureCause: { errorClass: 'Error', errorCode: 'credential_scope_denied' } });
    if (!execution || execution.ok) throw new Error('Expected typed custody refusal');
    const cliFailure = normalizeActionExecuteResult(execution);
    if (cliFailure.ok) throw new Error('Expected CLI failure projection');
    expect(projectCliActionFailure(cliFailure)).toMatchObject({ code: 'credential_scope_denied', requestId: envelope.requestId });
    expect(finiteActionExitCode(cliFailure.errorCode)).toBe(1);
    // Missing dispatch evidence stays absent; it does not turn a known refusal
    // into uncertainty at the CLI projection. Native and persistence effects
    // are asserted independently below.
    expect(execution.effectAttempted).toBeUndefined();
    expect(cliFailure.effectAttempted).toBeUndefined();
    expect(deliveries).toEqual([]);
    expect(mockPost).not.toHaveBeenCalled();
    const requesterCredentials = { token: tokenFor('requester'), encryption: null };
    const requester = createStore(requesterCredentials, 'plain');
    await expect(executorFor(requester, requesterCredentials).prepare(actionId, envelope.input, context)).resolves.toMatchObject({
      kind: 'settled', result: { ok: true, result: { kind: 'approval_request_created', artifactId: expect.any(String) } },
    });
    expect(deliveries).toEqual([]);
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
  it('places a received Artifact through the real private row transport and refuses stale, cancelled and retired-Home writes', async () => {
    const credentials: StoredCredentials = { token: 'folder-account-token', encryption: null };
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    const store = createCliApprovalsArtifactStore({ credentials, serverId: 'home', getAccountEncryptionMode: async () => 'plain' });
    const port = store.promptLibraryStore.organization!;
    let revision = 1;
    let value: Extract<PromptLibraryRecordV1, { key: 'folders' }> = { key: 'folders', value: { v: 1, folders: [{ id: 'personal', name: 'Personal' }] } };
    let retireOnHeaderRead = false;
    let writes = 0;
    const shared = { id: 'received', ownerAccountId: 'other-account', access: 'view', encryptionMode: 'plain',
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      header: encodePlainArtifactStoredContent({ v: 1, kind: 'memory_doc.v1', title: 'Shared memory', folderId: 'owner-private', tags: ['Private tag'] }) };
    mockGet.mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/v1/account/encryption/currentness') return { status: 200, data: {
        mode: 'plain', version: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1,
      } };
      if (parsed.pathname === '/v1/account/entity-rows/prompt-library') return { status: 200, data: { status: 'listed',
        rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: key === 'folders' ? revision : 0,
          content: key === 'folders' ? { t: 'plain', v: value } : null })) } };
      if (parsed.pathname === '/v2/account/settings') return { status: 200, data: { content: { t: 'plain', v: {} }, version: 1 } };
      if (parsed.pathname === '/v1/artifacts') {
        expect(parsed.searchParams.get('includeBody')).toBeNull();
        if (retireOnHeaderRead) setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
          loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'replacement-home' });
        return { status: 200, data: [shared] };
      }
      // History is outside this organization contract; the real importer retains cleanup pending.
      return { status: 503, data: {} };
    });
    mockPost.mockImplementation(async (url: string, input: unknown) => {
      if (new URL(url).pathname === '/v1/artifacts/read') {
        expect(input).toEqual({ artifactIds: ['received'], projection: 'headers' });
        if (retireOnHeaderRead) setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), settingsVersion: 1,
          loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: 'replacement-home' });
        return { status: 200, data: { projection: 'headers', items: [{ artifactId: shared.id, ok: true, artifact: { ...shared, publicAudience: 'none' } }] } };
      }
      expect(new URL(url).pathname).toBe('/v1/account/entity-rows/prompt-library/folders');
      const mutation = PromptLibraryRowMutationV1Schema.parse(input);
      if (mutation.expectedRevision !== revision) return { status: 409, data: { status: 'conflict', revision } };
      if (mutation.content?.t !== 'plain' || mutation.content.v.key !== 'folders') throw new Error('Wrong private row');
      value = mutation.content.v; revision++; writes++;
      return { status: 200, data: { status: 'updated', revision, cursor: revision } };
    });
    try {
      expect(await executeArtifactFolderActionV1({ port, actionId: 'artifact.folders.list', input: {} }))
        .toEqual({ status: 'ready', items: [{ id: 'personal', name: 'Personal', parentId: null }], revision: 1,
          coverage: 'complete', nextCursor: null });
      expect(await executeArtifactFolderActionV1({ port, actionId: 'artifact.folders.read', input: { folderId: 'personal' } }))
        .toEqual({ status: 'ready', item: { id: 'personal', name: 'Personal', parentId: null }, revision: 1, coverage: 'complete' });
      expect(await executeArtifactFolderActionV1({ port, actionId: 'artifact.folder.set',
        input: { artifactId: shared.id, folderId: 'personal', expectedRevision: 1 } }))
        .toEqual({ status: 'updated', revision: 2 });
      expect(value).toMatchObject({ value: { artifactHeadersById: { received: { folderId: 'personal' } } } });
      expect(JSON.stringify(value)).not.toContain('Private tag');
      expect(mockGet.mock.calls.filter(([url]) => new URL(url).pathname === '/v1/artifacts')).toHaveLength(0);
      expect(await executeArtifactFolderActionV1({ port, actionId: 'artifact.folder.set',
        input: { artifactId: shared.id, folderId: null, expectedRevision: 1 } })).toEqual({ status: 'conflict', revision: 2 });
      const controller = new AbortController(); controller.abort();
      await expect(executeArtifactFolderActionV1({ port, actionId: 'artifact.folder.set',
        input: { artifactId: shared.id, folderId: null, expectedRevision: 2 }, signal: controller.signal })).rejects.toThrow();
      retireOnHeaderRead = true;
      await expect(executeArtifactFolderActionV1({ port, actionId: 'artifact.folder.set',
        input: { artifactId: shared.id, folderId: null, expectedRevision: 2 } })).rejects.toMatchObject({ code: 'scope-retired' });
      expect(writes).toBe(1);
      expect(decodePlainArtifactStoredContent(shared.header)).toMatchObject({ folderId: 'owner-private', tags: ['Private tag'] });
    } finally { resetActiveAccountSettingsSnapshotForTests(); }
  });
  it('refuses a prompt update based on an earlier read instead of overwriting a concurrent writer', async () => {
    const store = createStore({ token: 'token-only', encryption: null }, 'plain');
    let record = {
      id: 'prompt-race', ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Original' }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: 'original', createdAtMs: 1, updatedAtMs: 1 }) }),
      headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
    };
    const concurrent = { ...record, headerVersion: 2, bodyVersion: 2,
      header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Concurrent' }),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: 'concurrent', createdAtMs: 1, updatedAtMs: 2 }) }),
    };
    mockGet.mockImplementation(async () => ({ status: 200, data: record }));
    mockPost.mockImplementation(async (_url: string, input: { header: string; body: string; expectedHeaderVersion: number; expectedBodyVersion: number }) => {
      if (input.expectedHeaderVersion !== record.headerVersion || input.expectedBodyVersion !== record.bodyVersion) {
        return { status: 200, data: { success: false, error: 'version-mismatch' } };
      }
      record = { ...record, header: input.header, body: input.body, headerVersion: 3, bodyVersion: 3 };
      return { status: 200, data: { success: true, headerVersion: 3, bodyVersion: 3 } };
    });
    await expect(updatePromptDocInLibrary({ store: store.promptLibraryStore,
      request: { artifactId: record.id, title: 'Stale', markdown: 'stale' },
      nowMs: () => { record = concurrent; return 3; },
    })).rejects.toMatchObject({ code: 'version_mismatch' });
    expect(record).toEqual(concurrent);
  });
  beforeEach(() => {
    fixtureArtifacts.clear();
    mockGet.mockReset();
    mockPost.mockReset();
    // Model the existing selected-body HTTP endpoint as well as legacy exact
    // reads. Domain admission, decryption and correspondence remain real.
    mockPost.mockImplementation(async (url: string, input: unknown) => {
      if (new URL(url).pathname !== '/v1/artifacts/read') throw new Error('Unexpected Artifact fixture POST');
      const request = ArtifactReadBatchInputV1Schema.parse(input);
      const items = await Promise.all(request.artifactIds.map(async artifactId => {
        const retained = fixtureArtifacts.get(artifactId);
        const artifact = retained && typeof retained.body === 'string' ? retained
          : (await mockGet(`http://127.0.0.1:24599/v1/artifacts/${encodeURIComponent(artifactId)}`)).data;
        return batchFixtureItem(artifactId, artifact);
      }));
      return { status: 200, data: ArtifactReadBatchResponseV1Schema.parse({ items }) };
    });
  });

  type DataKeyCredentials = Credentials & Readonly<{
    encryption: Extract<Credentials['encryption'], { type: 'dataKey' }>;
  }>;

  type EncryptedArtifactPayload = Readonly<{
    id: string;
    header: string;
    body: string;
    dataEncryptionKey: string;
  }>;

  function createCredentials(): DataKeyCredentials {
    const machineKey = new Uint8Array(32).fill(7);
    const publicKey = libsodiumPublicKeyFromSecretKey(machineKey);
    return {
      token: 'token-1',
      encryption: {
        type: 'dataKey',
        publicKey,
        machineKey,
      },
    };
  }

  function createStore(
    credentials: StoredCredentials,
    accountMode: 'plain' | 'e2ee' = 'e2ee',
  ) {
    return createCliApprovalsArtifactStore({
      credentials,
      getAccountEncryptionMode: async () => accountMode,
    });
  }

  it('requires qualified native review before publishing a declared service Auto approval Artifact', async () => {
    const store = createStore({ token: 'captured-personal-account-token', encryption: null }, 'plain');
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...store });
    const source = { id: '00000000-0000-4000-8000-000000000031', serverId: 'service-home',
      machineId: 'source-machine' };
    const selection = { kind: 'manifest', name: 'web' } as const;
    const input = DaemonLocalServiceLauncherStartRequestV1Schema.parse({
      machineId: source.machineId,
      targetId: createProjectServiceDeclarationTargetIdV1(source, selection),
      workspace: { serverId: source.serverId, machineId: source.machineId,
        workspaceId: source.id, rootPath: '/projects/source' },
      declaration: { workspaceRefId: source.id, selection },
      choice: { kind: 'workers', destination: {
        kind: 'pool', poolId: '00000000-0000-4000-8000-000000000032', selection: 'automatic',
      } },
    });
    const published: unknown[] = [];
    // Only Account HTTP is replaced. The executor, approval policy, origin,
    // Artifact codec and durable creation all remain their canonical owners.
    mockPost.mockImplementation(async (_url: string, payload: Record<string, unknown>) => {
      const envelope = decodePlainArtifactStoredContent(String(payload.body));
      published.push(envelope);
      return { status: 200, data: { id: payload.id, headerVersion: 1, bodyVersion: 1 } };
    });

    const prepared = await executor.prepare('localServices.launcher.start', input, {
      surface: 'cli', authority: 'account_automation', serverId: source.serverId,
      serverIdentityId: 'service-home-identity', runtimeAccountId: 'personal-account',
      actionRequestId: 'declared-service-auto-review',
    });

    // A SOURCE generic approval is not consent for the still-unselected worker,
    // current copy/setup or native Start effect. Missing compound review must
    // refuse before durable approval custody, without changing caller authority.
    expect(published).toEqual([]);
    expect(prepared).toMatchObject({ kind: 'settled', result: { ok: false,
      errorCode: 'approval_context_unavailable' } });
  });

  it('creates approval requests as encrypted artifacts with an inbox-compatible header', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);

    const request = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'open',
      summary: 'Approve sending a message',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionArgs: { sessionId: 's1', message: 'hello' },
    });

    let capturedCreateBody: any = null;
    mockPost.mockImplementationOnce(async (url: string, body: any) => {
      capturedCreateBody = { url, body };
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    });

    const created = await store.approvalsCreate({ request, serverId: null });
    expect(created.artifactId).toEqual(expect.any(String));

    expect(capturedCreateBody?.url).toContain('/v1/artifacts');
    const createPayload = capturedCreateBody?.body;
    expect(z.string().check(z.uuid()).safeParse(createPayload?.id).success).toBe(true);
    expect(typeof createPayload?.header).toBe('string');
    expect(typeof createPayload?.body).toBe('string');
    expect(typeof createPayload?.dataEncryptionKey).toBe('string');

    const dataKey = openEncryptedDataKeyEnvelopeV1({
      envelope: decodeBase64(createPayload.dataEncryptionKey),
      recipientSecretKeyOrSeed: (credentials.encryption as any).machineKey,
    });
    expect(dataKey).not.toBeNull();
    expect(dataKey?.length).toBe(32);

    const decryptedHeader = decryptWithDataKey(decodeBase64(createPayload.header), dataKey!);
    expect(decryptedHeader).toMatchObject({
      v: 1,
      kind: 'approval_request.v1',
      title: request.summary,
      approvalStatus: request.status,
      actionId: request.actionId,
      sessions: ['s1'],
      sessionId: 's1',
    });

    const decryptedBody = decryptWithDataKey(decodeBase64(createPayload.body), dataKey!);
    expect(decryptedBody).toEqual({ body: JSON.stringify(request) });
  });

  it('persists V2 execution provenance at the same approval Artifact owner and binds the header to it', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);
    const envelope = { v: 1 as const, requestId: 'request-1', target: { kind: 'session' as const, sessionId: 's1' },
      input: { sessionId: 's1', message: 'hello' } };
    const request = ApprovalRequestV2Schema.parse({
      v: 2,
      actionId: 'session.message.send',
      status: 'open',
      summary: 'Approve sending a message',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'mcp' },
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'api',
        caller: { kind: 'host' },
        accountId: 'account-1',
        principalId: 'principal-1',
        credentialId: 'credential-1',
        serverId: 'server-1',
        serverIdentityId: 'stable-home-identity',
        sessionId: 's1',
        target: { kind: 'session', sessionId: 's1' },
        actionId: 'session.message.send',
        requestId: 'request-1',
        machineId: 'machine-1',
        externalActionInputSignature: 'a'.repeat(86),
        originalActionEnvelope: envelope,
        externalActionExecutionAuthorization: {
          v: 1,
          token: 'home-signed-invocation-requires-machine-possession',
          binding: {
            serverIdentityId: 'stable-home-identity', accountId: 'account-1', principalId: 'principal-1',
            credentialId: 'credential-1', machineId: 'machine-1',
            custodianAccountId: 'account-1', installationId: 'installation-1',
            grant: API_TOKEN_FULL_GRANT_V1,
            actionId: 'session.message.send', requestId: 'request-1',
            requestEnvelopeDigest: computeExternalActionRequestEnvelopeDigestV1(envelope),
            target: { kind: 'session', sessionId: 's1' },
          },
        },
      },
      actionArgs: { sessionId: 's1', message: 'hello' },
    });
    let capturedCreateBody: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      capturedCreateBody = body;
      return createdArtifactResponse(body, 'e2ee');
    });

    await store.approvalsCreate({ request, serverId: 'server-1' });
    const dataKey = openEncryptedDataKeyEnvelopeV1({
      envelope: decodeBase64(capturedCreateBody.dataEncryptionKey),
      recipientSecretKeyOrSeed: (credentials.encryption as any).machineKey,
    });
    const header = decryptWithDataKey(decodeBase64(capturedCreateBody.header), dataKey!);
    const body = decryptWithDataKey(decodeBase64(capturedCreateBody.body), dataKey!);
    expect(header).toMatchObject({
      kind: 'approval_request.v1',
      actionId: 'session.message.send',
      serverId: 'server-1',
      serverIdentityId: 'stable-home-identity',
      sessionId: 's1',
    });
    expect(body).toEqual({ body: JSON.stringify(request) });
    const persistedRow = {
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
      ...capturedCreateBody, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
    };
    mockGet.mockResolvedValue({ status: 200, data: persistedRow });
    // The HTTP Artifact boundary retains replay custody. Every public Action
    // surface passes through the same executor projection after opening it.
    await expect(store.approvalsGet({ artifactId: capturedCreateBody.id, serverId: 'server-1' })).resolves.toEqual(request);
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...store });
    for (const surface of ['cli', 'rpc', 'mcp', 'agent', 'ui'] as const) {
      const disclosed = await executor.execute('approval.request.get', { artifactId: capturedCreateBody.id },
        { surface, serverId: 'server-1' });
      expect(disclosed).toMatchObject({ ok: true, result: { request: {
        actionArgs: request.actionArgs, executionOriginV1: { requestId: 'request-1', machineId: 'machine-1' },
      } } });
      expect(JSON.stringify(disclosed)).not.toContain('home-signed-invocation-requires-machine-possession');
      expect(JSON.stringify(disclosed)).not.toContain('externalActionExecutionAuthorization');
      expect(JSON.stringify(disclosed)).not.toContain('externalActionInputSignature');
      expect(JSON.stringify(disclosed)).not.toContain('originalActionEnvelope');
    }
    // A public read must never strip or replace the private stored subject.
    await expect(store.approvalsGet({ artifactId: capturedCreateBody.id, serverId: 'server-1' })).resolves.toEqual(request);
    mockGet.mockResolvedValue({ status: 200, data: {
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
      ...capturedCreateBody, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      header: encodeBase64(encryptWithDataKey({ ...(header as Record<string, unknown>), serverIdentityId: 'wrong-home' }, dataKey!)),
    } });
    await expect(store.approvalsGet({ artifactId: capturedCreateBody.id, serverId: 'server-1' })).resolves.toBeNull();

    mockGet.mockResolvedValueOnce({ status: 200, data: {
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
      ...capturedCreateBody, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      header: encodeBase64(encryptWithDataKey({
        ...(header as Record<string, unknown>),
        serverIdentityId: ' stable-home-identity ',
      }, dataKey!)),
    } });
    await expect(store.approvalsGet({ artifactId: capturedCreateBody.id, serverId: 'server-1' })).resolves.toBeNull();

    mockGet.mockResolvedValueOnce({
      status: 200,
      data: {
        id: capturedCreateBody.id,
        header: capturedCreateBody.header,
        headerVersion: 1,
        body: capturedCreateBody.body,
        bodyVersion: 1,
        ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
        dataEncryptionKey: capturedCreateBody.dataEncryptionKey,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    mockPost.mockClear();
    const mutatedOrigin = ApprovalRequestV2Schema.parse({
      ...request,
      status: 'approved',
      updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
      executionOriginV1: {
        ...request.executionOriginV1,
        externalActionExecutionAuthorization: {
          ...request.executionOriginV1.externalActionExecutionAuthorization!,
          token: 'substituted-home-authorization',
        },
      },
    });
    await expect(store.approvalsUpdate({
      artifactId: capturedCreateBody.id,
      request: mutatedOrigin,
      serverId: 'server-1',
    })).resolves.toEqual({
      ok: false,
      errorCode: 'subject_mismatch',
      error: 'approval_request_subject_mismatch',
      writeCommitted: false,
    });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('permits only the released V1 approved-to-stale tombstone transition', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);
    const approved = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.title.set',
      status: 'approved',
      summary: 'Set title',
      createdAtMs: 1,
      updatedAtMs: 2,
      createdBy: { surface: 'system', sessionId: 'session-1' },
      actionArgs: { sessionId: 'session-1', title: 'Legacy' },
      decision: { kind: 'approve', decidedAtMs: 2 },
    });
    const terminal = ApprovalRequestV1Schema.parse({
      ...approved,
      status: 'failed',
      updatedAtMs: 3,
      execution: { executedAtMs: 3, ok: false, errorCode: 'approval_stale', error: 'approval_stale' },
    });
    let createdPayload: EncryptedArtifactPayload | null = null;
    mockPost.mockImplementationOnce(async (_url: string, body: EncryptedArtifactPayload) => {
      createdPayload = body;
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const created = await store.approvalsCreate({ request: approved, serverId: null });
    mockPost.mockClear();
    // Transition validation and CAS share this one fresh row and its encrypted key.
    mockGet.mockResolvedValue({ status: 200, data: {
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
      ...createdPayload!,
      headerVersion: 1,
      bodyVersion: 1,
      seq: 1,
      createdAt: 1,
      updatedAt: 2,
    } });

    mockPost.mockImplementationOnce(async () => ({
      status: 200, data: { success: true, headerVersion: 2, bodyVersion: 2 },
    }));
    await expect(store.approvalsUpdate({ artifactId: created.artifactId, request: terminal, serverId: null }))
      .resolves.toEqual({ ok: true });
    expect(mockPost).toHaveBeenCalledOnce();

    const nonStaleFailure = ApprovalRequestV1Schema.parse({
      ...approved,
      status: 'failed',
      updatedAtMs: 3,
      execution: { executedAtMs: 3, ok: false, errorCode: 'action_disabled', error: 'action_disabled' },
    });
    await expect(store.approvalsUpdate({ artifactId: created.artifactId, request: nonStaleFailure, serverId: null }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_transition' });
  });

  it('creates, reads, lists, and updates plain approval artifacts with token-only credentials', async () => {
    const credentials: StoredCredentials = { token: 'token-only', encryption: null };
    const store = createCliApprovalsArtifactStore({ credentials });
    const open = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'open',
      summary: 'Approve sending a message',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionArgs: { sessionId: 's1', message: 'hello' },
    });

    let createdPayload: any = null;
    // Mode authority is a live HTTP route, including final create/update admission.
    mockGet.mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 1 } });
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      createdPayload = body;
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const created = await store.approvalsCreate({ request: open, serverId: 'server-1' });

    expect(createdPayload.dataEncryptionKey).toBe(ARTIFACT_PLAIN_DATA_KEY_MARKER);
    expect(decodePlainArtifactStoredContent(createdPayload.header)).toMatchObject({
      kind: 'approval_request.v1',
      approvalStatus: 'open',
      serverId: 'server-1',
    });
    expect(decodePlainArtifactStoredContent(createdPayload.body)).toEqual({
      body: JSON.stringify(open),
    });

    const record = (header: string, body: string, version: number) => ({
      id: created.artifactId,
      header,
      headerVersion: version,
      body,
      bodyVersion: version,
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      seq: version,
      createdAt: 1,
      updatedAt: version,
    });
    mockGet.mockImplementation(async (url: string) => ({ status: 200, data: url.endsWith('/v1/account/encryption')
      ? { mode: 'plain', updatedAt: 1 }
      : new URL(url).pathname === '/v1/artifacts' ? [record(createdPayload.header, createdPayload.body, 1)]
        : record(createdPayload.header, createdPayload.body, 1) }));
    await expect(store.approvalsGet({ artifactId: created.artifactId, serverId: 'server-1' }))
      .resolves.toEqual(open);

    await expect(store.approvalsList({ status: 'open', limit: 10, serverId: 'server-1' }))
      .resolves.toMatchObject({
        items: [{ artifactId: created.artifactId, status: 'open', serverId: 'server-1' }],
      });

    const approved = ApprovalRequestV1Schema.parse({
      ...open,
      status: 'approved',
      updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
    });
    let updatedPayload: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      updatedPayload = body;
      return { status: 200, data: { success: true, headerVersion: 2, bodyVersion: 2 } };
    });

    await expect(store.approvalsUpdate({
      artifactId: created.artifactId,
      request: approved,
      serverId: 'server-1',
    })).resolves.toEqual({ ok: true });
    expect(decodePlainArtifactStoredContent(updatedPayload.header)).toMatchObject({
      approvalStatus: 'approved',
    });
    expect(decodePlainArtifactStoredContent(updatedPayload.body)).toEqual({
      body: JSON.stringify(approved),
    });

    const artifactGets = mockGet.mock.calls.filter(([url]) =>
      String(url).includes('/v1/artifacts'));
    const artifactPosts = mockPost.mock.calls.filter(([url]) =>
      String(url).includes('/v1/artifacts') && !String(url).endsWith('/v1/artifacts/read'));
    expect(artifactPosts).toHaveLength(2);
    for (const [, config] of artifactGets) {
      expect(config).toMatchObject({
        headers: {
          Authorization: 'Bearer token-only',
        },
      });
    }
    for (const [, , config] of artifactPosts) {
      expect(config).toMatchObject({
        headers: {
          Authorization: 'Bearer token-only',
        },
      });
    }
  });

  it('serializes invitation approval custody with only the Account-bound continuation', async () => {
    const invitationToken = 'invitation-bearer-must-never-enter-the-artifact';
    const request = ApprovalRequestV2Schema.parse({
      v: 2,
      actionId: 'teams.invitations.accept',
      status: 'open',
      summary: 'Accept Team invitation',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'cli' },
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'cli',
        caller: { kind: 'host' },
        serverId: 'home-1',
        actionId: 'teams.invitations.accept',
        requestId: 'request-invitation-1',
      },
      actionArgs: {
        v: 1,
        continuation: {
          v: 1,
          kind: 'post_auth_invitation',
          reference: 'prepared-continuation-reference',
          teamId: 'team-1',
        },
      },
      preview: {
        actionId: 'teams.invitations.accept',
        actionArgs: {
          homeServerId: 'home-1',
          continuation: { teamId: 'team-1' },
          teamName: 'Platform',
        },
      },
    });
    const store = createStore({ token: 'token-only', encryption: null }, 'plain');
    let createdPayload: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      createdPayload = body;
      return createdArtifactResponse(body, 'plain');
    });

    await store.approvalsCreate({ request, serverId: 'home-1' });

    const serializedBody = decodePlainArtifactStoredContent(createdPayload.body);
    expect(serializedBody).toEqual({ body: JSON.stringify(request) });
    expect(JSON.stringify(serializedBody)).toContain('prepared-continuation-reference');
    expect(JSON.stringify(serializedBody)).not.toContain(invitationToken);
  });

  it.each(['plain', 'e2ee'] as const)('creates and favourites prompts through the real %s Artifact adapter', async (mode) => {
    const currentAccountKeyPair = tweetnacl.box.keyPair.fromSecretKey(new Uint8Array(32).fill(9));
    const credentials = mode === 'plain' ? { token: 'token-only', encryption: null } : {
      token: 'token-current-e2ee', encryption: { type: 'dataKey' as const,
        publicKey: currentAccountKeyPair.publicKey, machineKey: currentAccountKeyPair.secretKey },
    };
    setActiveAccountSettingsSnapshot({ source: 'network', settings: accountSettingsParse({}), rawSettings: {}, settingsVersion: 1,
      loadedAtMs: 1, settingsSecretsReadKeys: [], scopeKey: resolveAccountSettingsScopeKey(credentials) });
    const store = createStore(credentials, mode);
    const signal = new AbortController().signal;
    const encryption = credentials.encryption;
    const material = encryption ? { type: 'dataKey' as const, machineKey: encryption.machineKey } : null;
    const contentKeyFingerprint = encryption ? convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
      createAccountScopedCryptoMaterialSnapshotV1({ accountEncryptionMode: 'e2ee', material: { type: 'dataKey', machineKey: encryption.machineKey },
        dataKeyPublicKey: encryption.publicKey }).contentPublicKeyFingerprint) : null;
    const settingsContent = material ? { t: 'encrypted', c: sealAccountScopedBlobCiphertext({ kind: 'account_settings', material,
      payload: {}, randomBytes: length => new Uint8Array(length).fill(5) }) } : { t: 'plain', v: {} };
    let folderRevision = 1;
    let folders: PromptLibraryRecordV1 = { key: 'folders', value: { v: 1, folders: [{ id: 'folder', name: 'Folder' }] } };
    let record: Record<string, unknown> | null = null;
    mockGet.mockImplementation(async (url: string) => {
      const path = new URL(url).pathname;
      if (path === '/v1/account/encryption/currentness') return { status: 200, data: { mode, version: 1,
        signingKeyFingerprint: null, contentKeyFingerprint, updatedAt: 1 } };
      if (path === '/v1/account/entity-rows/prompt-library') return { status: 200, data: { status: 'listed',
        rows: PromptLibraryCatalogKeyV1Schema.options.map(key => ({ key, revision: key === 'folders' ? folderRevision : 0,
          content: key === 'folders' ? sealPromptLibraryContentV1({ mode, material, record: folders }) : null })) } };
      if (path === '/v2/account/settings') return { status: 200, data: { version: 1, content: settingsContent } };
      if (path === '/v1/artifacts') return { status: 200, data: artifactListResponse(url, record ? [record] : []) };
      if (path.startsWith('/v1/artifacts/')) return { status: 200, data: record };
      return { status: 503, data: {} };
    });
    mockPost.mockImplementation(async (url: string, body: unknown, config: { signal?: AbortSignal }) => {
      const path = new URL(url).pathname;
      if (path === '/v1/artifacts/read') {
        const request = ArtifactReadHeadersBatchInputV1Schema.parse(body);
        const projected: Record<string, unknown> = { ...record, publicAudience: 'none' };
        delete projected.body;
        const header = ArtifactHttpHeaderReadV1Schema.parse(projected);
        expect(request.artifactIds).toEqual([header.id]);
        return { status: 200, data: { projection: request.projection,
          items: [{ artifactId: header.id, ok: true, artifact: header }] } };
      }
      if (path === '/v1/account/entity-rows/prompt-library/folders') {
        const mutation = PromptLibraryRowMutationV1Schema.parse(body);
        expect(mutation.expectedRevision).toBe(folderRevision);
        const opened = openPromptLibraryContentV1({ key: 'folders', mode, material, content: mutation.content });
        if (opened.status !== 'opened') throw new Error(opened.reason);
        folders = opened.record; folderRevision++;
        return { status: 200, data: { status: 'updated', revision: folderRevision, cursor: folderRevision } };
      }
      if (!body || typeof body !== 'object') throw new Error('Invalid Artifact write');
      expect(config.signal).toBe(signal);
      if (path === '/v1/artifacts') {
        record = { ...body, headerVersion: 1, bodyVersion: 1, ownerAccountId: 'account-1', access: 'owner', encryptionMode: mode,
          seq: 1, createdAt: 1, updatedAt: 1 };
        return { status: 200, data: { id: Reflect.get(body, 'id'), headerVersion: 1, bodyVersion: 1 } };
      }
      if (path.startsWith('/v1/artifacts/') && record) {
        record = { ...record, ...body, headerVersion: 2, bodyVersion: 2 };
        return { status: 200, data: { success: true, headerVersion: 2, bodyVersion: 2 } };
      }
      throw new Error('Unexpected HTTP mutation');
    });
    try {
      const { artifactId } = await createPromptDocInLibrary({ store: store.promptLibraryStore,
        request: { title: 'Prompt', markdown: '# Prompt', folderId: 'folder', tags: ['topic'] }, signal, nowMs: () => 1 });
      const stored = await store.promptLibraryStore.read(artifactId, { signal });
      expect(stored).toMatchObject({ id: artifactId, revision: { headerVersion: 1, bodyVersion: 1 },
        header: { v: 1, kind: 'prompt_doc.v2', title: 'Prompt' },
        body: JSON.stringify({ v: 1, markdown: '# Prompt', createdAtMs: 1, updatedAtMs: 1 }) });
      expect(stored?.header).not.toHaveProperty('folderId');
      expect(stored?.header).not.toHaveProperty('tags');
      expect(folders).toMatchObject({ value: { artifactHeadersById: { [artifactId]: { folderId: 'folder', tags: ['topic'] } } } });
      await expect(setPromptDocFavorite({ store: store.promptLibraryStore,
        request: { artifactId, favorite: true }, signal })).resolves.toEqual({ ok: true, artifactId });
      await expect(listPromptLibrary({ store: store.promptLibraryStore, request: {} })).resolves.toMatchObject({
        coverage: 'complete', items: [{ artifactId, folderId: 'folder', tags: ['topic'] }] });
      const artifactBeforeDelete = JSON.stringify(record);
      const artifactRequestsBeforeDelete = mockGet.mock.calls.filter(([url]) => new URL(url).pathname.startsWith('/v1/artifacts')).length
        + mockPost.mock.calls.filter(([url]) => new URL(url).pathname.startsWith('/v1/artifacts')).length;
      expect(await executeArtifactFolderActionV1({ port: store.promptLibraryStore.organization!, actionId: 'artifact.folders.delete',
        input: { folderId: 'folder', expectedRevision: folderRevision } })).toMatchObject({ status: 'updated' });
      expect(folders).toMatchObject({ value: { deletedLegacyFolderIds: ['folder'],
        artifactHeadersById: { [artifactId]: { folderId: null, tags: ['topic'] } } } });
      expect(mockGet.mock.calls.filter(([url]) => new URL(url).pathname.startsWith('/v1/artifacts')).length
        + mockPost.mock.calls.filter(([url]) => new URL(url).pathname.startsWith('/v1/artifacts')).length).toBe(artifactRequestsBeforeDelete);
      expect(JSON.stringify(record)).toBe(artifactBeforeDelete);
      expect(await executeArtifactFolderActionV1({ port: store.promptLibraryStore.organization!, actionId: 'artifact.folders.create',
        input: { id: 'folder', name: 'Recreated', expectedRevision: folderRevision } })).toMatchObject({ status: 'updated' });
      expect(folders).toMatchObject({ value: { deletedLegacyFolderIds: ['folder'] } });
    } finally { resetActiveAccountSettingsSnapshotForTests(); }
  });


  it('durably creates and reads a truthful target-action approval artifact', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);
    const request = TargetActionApprovalRequestV1Schema.parse({
      v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli',
      qualifiedActionId: 'acme.alpha/actions/run', input: { value: 'x', credential: 'synthetic-legacy-secret' },
      secretInputPaths: ['credential'],
      executionOriginV1: {
        v: 1, authority: 'account_automation', surface: 'cli', caller: { kind: 'host' }, serverId: 'home',
        accountId: 'account-1', serverIdentityId: 'stable-home-identity', machineId: 'machine-1',
        actionId: 'action.invoke', requestId: 'target-request', target: { kind: 'machine', machineId: 'machine-1' },
        externalActionInputSignature: 'a'.repeat(86),
        externalActionExecutionAuthorization: { v: 1, token: 'synthetic-target-signed-authorization', binding: {
          serverIdentityId: 'stable-home-identity', accountId: 'account-1', authentication: { kind: 'terminal', tokenEpoch: 1 },
          custodianAccountId: 'account-1', installationId: 'installation-1', machineId: 'machine-1',
          actionId: 'action.invoke', requestId: 'target-request', requestEnvelopeDigest: 'a'.repeat(43),
          target: { kind: 'machine', machineId: 'machine-1' },
        } },
      },
      sourceCustody: { kind: 'development', registeredRootId: 'root-7' },
      policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'a'.repeat(64), summary: 'Approve run',
    });
    let payload: any;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => { payload = body; return createdArtifactResponse(body, 'e2ee'); });
    const created = await store.targetActionApprovalsCreate({ request });
    const serializedTransport = JSON.stringify(payload);
    expect(serializedTransport).not.toContain(request.qualifiedActionId);
    expect(serializedTransport).not.toContain(request.summary);
    expect(serializedTransport).not.toContain(request.subjectFingerprint);
    expect(serializedTransport).not.toContain('"value":"x"');
    mockGet.mockImplementationOnce(async () => ({ status: 200, data: {
      id: created.artifactId, header: payload.header, headerVersion: 1, body: payload.body, bodyVersion: 1,
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
      dataEncryptionKey: payload.dataEncryptionKey, seq: 1, createdAt: 1, updatedAt: 1,
    } }));
    await expect(store.targetActionApprovalsGet({ artifactId: created.artifactId })).resolves.toEqual(request);
    const row = {
      id: created.artifactId, header: payload.header, headerVersion: 1, body: payload.body, bodyVersion: 1,
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
      dataEncryptionKey: payload.dataEncryptionKey, seq: 1, createdAt: 1, updatedAt: 1,
    };
    mockGet.mockImplementation(async (url: string) => ({ status: 200,
      data: new URL(url).pathname === '/v1/artifacts' ? [row] : row }));
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...store });
    const disclosed = await executor.execute('approval.request.get', { artifactId: created.artifactId }, { surface: 'cli' });
    expect(disclosed)
      .toMatchObject({ ok: true, result: { artifactId: created.artifactId,
        request: { kind: 'plugin_target_action', qualifiedActionId: request.qualifiedActionId,
          input: { value: 'x', credential: '[REDACTED]' } } } });
    expect(JSON.stringify(disclosed)).not.toContain('synthetic-legacy-secret');
    expect(JSON.stringify(disclosed)).not.toContain('synthetic-target-signed-authorization');
    expect(JSON.stringify(disclosed)).not.toContain('externalActionInputSignature');
    const { readWorkflowActionApprovalSettlement } = await import('@/daemon/workflows/actionApproval');
    await expect(readWorkflowActionApprovalSettlement({ runId: 'workflow-run', execution: {
      kind: 'action', actionId: request.qualifiedActionId, actionRequestId: 'workflow-request', localInputId: 'workflow-input', input: {},
      output: { kind: 'approval_request_created', artifactId: created.artifactId, actionId: 'action.invoke' },
    }, read: async () => disclosed.ok ? disclosed.result : null })).resolves.toEqual({ kind: 'unresolved', code: 'approval_unavailable' });
    expect(await executor.execute('approval.request.list', { status: 'open' }, { surface: 'cli' }))
      .toMatchObject({ ok: true, result: { items: [{ artifactId: created.artifactId, actionId: 'action.invoke', status: 'open' }] } });
    const key = openEncryptedDataKeyEnvelopeV1({ envelope: decodeBase64(payload.dataEncryptionKey), recipientSecretKeyOrSeed: (credentials.encryption as any).machineKey });
    expect(decryptWithDataKey(decodeBase64(payload.header), key!)).toMatchObject({
      kind: 'target_action_approval.v1', qualifiedActionId: request.qualifiedActionId,
      subjectFingerprint: request.subjectFingerprint,
    });
  });

  it('durably creates, reads, and updates an execution-run host-action approval artifact', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);
    const request = ExecutionRunHostActionApprovalRequestV1Schema.parse({
      v: 1, kind: 'execution_run_host_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'agent', sessionId: 'session-1' }, requestedSurface: 'agent',
      actionId: 'reviews.comments.create', sessionId: 'session-1', runId: 'run-1', callId: 'call-1',
      profileId: 'acme.review/review', pluginId: 'acme.review', agentId: 'claude', projectId: 'project-1',
      workspaceId: 'workspace-1', serverId: 'server-1',
      proposalCount: 1,
      proposalPreview: [{
        pathLabel: 'src/a.ts', pathSha256: 'b'.repeat(64), startLine: 3, endLine: 3,
        bodySha256: 'c'.repeat(64), bodyPreview: 'Fix this.',
      }],
      subjectFingerprint: 'a'.repeat(64), summary: 'Create 1 proposed review comment',
    });
    let openPayload: EncryptedArtifactPayload | null = null;
    let approvedPayload: EncryptedArtifactPayload | null = null;
    mockPost.mockImplementationOnce(async (_url: string, body: unknown) => {
      const payload = body as EncryptedArtifactPayload;
      openPayload = payload;
      return { status: 200, data: { id: payload.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const created = await store.executionRunHostActionApprovalsCreate({ request });
    const fullRecord = (payload: EncryptedArtifactPayload, version: number) => ({ status: 200, data: {
      id: created.artifactId, header: payload.header, headerVersion: version,
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
      body: payload.body, bodyVersion: version, dataEncryptionKey: openPayload!.dataEncryptionKey,
      seq: version, createdAt: 1, updatedAt: version,
    } });
    mockGet.mockImplementationOnce(async () => fullRecord(openPayload!, 1));
    await expect(store.executionRunHostActionApprovalsGet({ artifactId: created.artifactId }))
      .resolves.toEqual(request);

    // The executor's initial family read must classify this same stored body;
    // host-family routing must not need another independent Artifact read.
    mockGet.mockImplementationOnce(async () => fullRecord(openPayload!, 1));
    await expect(store.approvalsGet({ artifactId: created.artifactId }))
      .resolves.toEqual(request);

    const approved = ExecutionRunHostActionApprovalRequestV1Schema.parse({
      ...request, status: 'approved', updatedAtMs: 2, decision: { kind: 'approve', decidedAtMs: 2 },
    });
    mockGet.mockImplementationOnce(async () => fullRecord(openPayload!, 1));
    mockPost.mockImplementationOnce(async (_url: string, body: unknown) => {
      approvedPayload = body as EncryptedArtifactPayload;
      return { status: 200, data: { success: true, headerVersion: 2, bodyVersion: 2 } };
    });
    await expect(store.executionRunHostActionApprovalsUpdate({ artifactId: created.artifactId, request: approved }))
      .resolves.toEqual({ ok: true });

    mockGet.mockImplementationOnce(async () => fullRecord(approvedPayload!, 2));
    await expect(store.executionRunHostActionApprovalsGet({ artifactId: created.artifactId }))
      .resolves.toEqual(approved);
    const key = openEncryptedDataKeyEnvelopeV1({
      envelope: decodeBase64(openPayload!.dataEncryptionKey),
      recipientSecretKeyOrSeed: credentials.encryption.machineKey,
    });
    expect(decryptWithDataKey(decodeBase64(openPayload!.header), key!)).toMatchObject({
      kind: 'execution_run_host_action_approval.v1', actionId: 'reviews.comments.create',
      sessionId: 'session-1', runId: 'run-1', subjectFingerprint: request.subjectFingerprint,
    });
  });

  it('keeps execution-run host-action artifacts out of the built-in approval request queue', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);
    const request = ExecutionRunHostActionApprovalRequestV1Schema.parse({
      v: 1, kind: 'execution_run_host_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'agent', sessionId: 'session-1' }, requestedSurface: 'agent',
      actionId: 'reviews.comments.create', sessionId: 'session-1', runId: 'run-1', callId: 'call-1',
      profileId: 'acme.review/review', pluginId: 'acme.review', agentId: 'claude', projectId: 'project-1',
      workspaceId: 'workspace-1', serverId: 'server-1', proposalCount: 1,
      proposalPreview: [{
        pathLabel: 'a.ts', pathSha256: 'a'.repeat(64), bodySha256: 'b'.repeat(64), bodyPreview: 'Fix this.',
      }],
      subjectFingerprint: 'c'.repeat(64), summary: 'Create 1 proposed review comment',
    });
    let payload: Readonly<{ id: string; header: string; dataEncryptionKey: string }> | null = null;
    mockPost.mockImplementationOnce(async (_url: string, body: unknown) => {
      const record = body as Readonly<{ id: string; header: string; dataEncryptionKey: string }>;
      payload = record;
      return { status: 200, data: { id: record.id, headerVersion: 1, bodyVersion: 1 } };
    });
    await store.executionRunHostActionApprovalsCreate({ request });
    mockGet.mockResolvedValueOnce({ status: 200, data: [{
      id: payload!.id, header: payload!.header, headerVersion: 1,
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
      dataEncryptionKey: payload!.dataEncryptionKey, seq: 1, createdAt: 1, updatedAt: 1,
    }] });

    await expect(store.approvalsList({ status: 'open', limit: 10, serverId: 'server-1' }))
      .resolves.toMatchObject({ items: [] });
  });

  it('rejects a target-action decision update that mutates the approved subject', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);
    const request = TargetActionApprovalRequestV1Schema.parse({
      v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli',
      qualifiedActionId: 'acme.alpha/actions/run', input: { value: 'x' },
      sourceCustody: { kind: 'development', registeredRootId: 'root-7' },
      policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'a'.repeat(64), summary: 'Approve run',
    });
    let payload: any;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => { payload = body; return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } }; });
    const created = await store.targetActionApprovalsCreate({ request });
    mockGet.mockImplementationOnce(async () => ({ status: 200, data: {
      id: created.artifactId, header: payload.header, headerVersion: 1, body: payload.body, bodyVersion: 1,
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
      dataEncryptionKey: payload.dataEncryptionKey, seq: 1, createdAt: 1, updatedAt: 1,
    } }));
    const mutated = TargetActionApprovalRequestV1Schema.parse({
      ...request, sourceCustody: { kind: 'development', registeredRootId: 'root-8' }, status: 'approved', updatedAtMs: 2,
      decision: { kind: 'approve', decidedAtMs: 2 },
    });
    await expect(store.targetActionApprovalsUpdate({ artifactId: created.artifactId, request: mutated }))
      .resolves.toMatchObject({ ok: false, errorCode: 'subject_mismatch' });
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('requires target-action approved→executing→terminal CAS transitions', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);
    const open = TargetActionApprovalRequestV1Schema.parse({
      v: 1, kind: 'plugin_target_action', status: 'open', createdAtMs: 1, updatedAtMs: 1,
      createdBy: { surface: 'cli' }, requestedSurface: 'cli',
      qualifiedActionId: 'acme.alpha/actions/run', input: { value: 'x' },
      sourceCustody: { kind: 'development', registeredRootId: 'root-7' },
      policyFingerprint: 'b'.repeat(64), subjectFingerprint: 'a'.repeat(64), summary: 'Approve run',
    });
    let createdPayload: any;
    let approvedPayload: any;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => { createdPayload = body; return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } }; });
    const created = await store.targetActionApprovalsCreate({ request: open });
    const fullRecord = (payload: any, version: number) => ({ status: 200, data: {
      id: created.artifactId, header: payload.header, headerVersion: version,
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
      body: payload.body, bodyVersion: version, dataEncryptionKey: createdPayload.dataEncryptionKey,
      seq: version, createdAt: 1, updatedAt: version,
    } });
    mockGet.mockImplementationOnce(async () => fullRecord(createdPayload, 1));
    mockPost.mockImplementationOnce(async (_url: string, body: any) => { approvedPayload = body; return { status: 200, data: { success: true, headerVersion: 2, bodyVersion: 2 } }; });
    const approved = TargetActionApprovalRequestV1Schema.parse({
      ...open, status: 'approved', updatedAtMs: 2, decision: { kind: 'approve', decidedAtMs: 2 },
    });
    await expect(store.targetActionApprovalsUpdate({ artifactId: created.artifactId, request: approved }))
      .resolves.toEqual({ ok: true });

    const directTerminal = TargetActionApprovalRequestV1Schema.parse({
      ...approved, status: 'executed', updatedAtMs: 3,
      execution: { executedAtMs: 3, ok: true, result: { published: true } },
    });
    mockGet.mockImplementationOnce(async () => fullRecord(approvedPayload, 2));
    await expect(store.targetActionApprovalsUpdate({ artifactId: created.artifactId, request: directTerminal }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_transition' });
    expect(mockPost).toHaveBeenCalledTimes(2);

    let executingPayload: any;
    const executing = TargetActionApprovalRequestV1Schema.parse({
      ...approved, status: 'executing', updatedAtMs: 3,
    });
    mockGet.mockImplementationOnce(async () => fullRecord(approvedPayload, 2));
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      executingPayload = body;
      return { status: 200, data: { success: true, headerVersion: 3, bodyVersion: 3 } };
    });
    await expect(store.targetActionApprovalsUpdate({ artifactId: created.artifactId, request: executing }))
      .resolves.toEqual({ ok: true });
    expect(mockPost).toHaveBeenCalledTimes(3);

    // An executing row proves another caller already won the exclusive claim.
    // Byte-identical claim bytes must not turn that observation into ownership.
    mockGet.mockImplementationOnce(async () => fullRecord(executingPayload, 3));
    await expect(store.targetActionApprovalsUpdate({ artifactId: created.artifactId, request: executing }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_transition' });
    expect(mockPost).toHaveBeenCalledTimes(3);

    let executedPayload: any;
    const executed = TargetActionApprovalRequestV1Schema.parse({
      ...executing,
      status: 'executed',
      updatedAtMs: 4,
      execution: { executedAtMs: 4, ok: true, result: { published: true } },
    });
    mockGet.mockImplementationOnce(async () => fullRecord(executingPayload, 3));
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      executedPayload = body;
      return { status: 200, data: { success: true, headerVersion: 4, bodyVersion: 4 } };
    });
    await expect(store.targetActionApprovalsUpdate({ artifactId: created.artifactId, request: executed }))
      .resolves.toEqual({ ok: true });
    expect(mockPost).toHaveBeenCalledTimes(4);

    mockGet.mockImplementationOnce(async () => fullRecord(executedPayload, 4));
    await expect(store.targetActionApprovalsUpdate({ artifactId: created.artifactId, request: executed }))
      .resolves.toEqual({ ok: true });
    expect(mockPost).toHaveBeenCalledTimes(4);

    mockGet.mockImplementationOnce(async () => fullRecord(executedPayload, 3));
    const rejected = TargetActionApprovalRequestV1Schema.parse({
      ...open, status: 'rejected', updatedAtMs: 4, decision: { kind: 'reject', decidedAtMs: 4 },
    });
    await expect(store.targetActionApprovalsUpdate({ artifactId: created.artifactId, request: rejected }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_transition' });
    expect(mockPost).toHaveBeenCalledTimes(4);
  });

  it('reads approval requests by decrypting artifact bodies', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);

    const request = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'open',
      summary: 'Approve sending a message',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionArgs: { sessionId: 's1', message: 'hello' },
    });

    const storeCreate = createStore(credentials);
    let createdPayload: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      createdPayload = body;
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const created = await storeCreate.approvalsCreate({ request, serverId: null });

    mockGet.mockImplementationOnce(async (url: string) => {
      expect(url).toContain(`/v1/artifacts/${encodeURIComponent(created.artifactId)}`);
      return {
        status: 200,
        data: {
          id: created.artifactId,
          header: createdPayload.header,
          headerVersion: 1,
          body: createdPayload.body,
          bodyVersion: 1,
          ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
          dataEncryptionKey: createdPayload.dataEncryptionKey,
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      };
    });

    const read = await store.approvalsGet({ artifactId: created.artifactId, serverId: null });
    expect(read).toEqual(request);
  });

  it('distinguishes a retained encrypted approval from a missing artifact for token-only credentials', async () => {
    const store = createStore({ token: 'token-only', encryption: null }, 'e2ee');
    const retainedArtifact = {
      id: 'retained-approval',
      header: 'retained-encrypted-header',
      headerVersion: 2,
      body: 'retained-encrypted-body',
      bodyVersion: 4,
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
      dataEncryptionKey: 'retained-encrypted-data-key',
      seq: 3,
      createdAt: 1,
      updatedAt: 2,
    };

    mockGet.mockResolvedValueOnce({ status: 200, data: retainedArtifact });
    await expect(store.approvalsGet({
      artifactId: retainedArtifact.id,
      serverId: null,
    })).rejects.toMatchObject({
      code: 'artifact_encryption_material_unavailable',
    });

    mockGet.mockResolvedValueOnce({ status: 404, data: { error: 'not_found' } });
    await expect(store.approvalsGet({
      artifactId: 'missing-approval',
      serverId: null,
    })).resolves.toBeNull();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it.each([
    ['header', true],
    ['body', false],
  ] as const)('fails typed when a retained plain approval has a malformed %s envelope', async (_field, corruptHeader) => {
    const store = createStore({ token: 'token-only', encryption: null }, 'plain');
    const request = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'open',
      summary: 'Approve sending a message',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionArgs: { sessionId: 's1', message: 'hello' },
    });
    const malformedPlainEnvelope = encodeBase64(
      new TextEncoder().encode(JSON.stringify({ t: 'plain' })),
      'base64',
    );
    const validHeader = encodeBase64(
      new TextEncoder().encode(JSON.stringify({
        t: 'plain',
        v: {
          v: 1,
          kind: 'approval_request.v1',
          title: request.summary,
          approvalStatus: request.status,
          actionId: request.actionId,
        },
      })),
      'base64',
    );
    const validBody = encodeBase64(
      new TextEncoder().encode(JSON.stringify({
        t: 'plain',
        v: { body: JSON.stringify(request) },
      })),
      'base64',
    );

    mockGet.mockResolvedValueOnce({
      status: 200,
      data: {
        id: 'malformed-plain-approval',
        header: corruptHeader ? malformedPlainEnvelope : validHeader,
        headerVersion: 1,
        body: corruptHeader ? validBody : malformedPlainEnvelope,
        bodyVersion: 1,
        ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    });

    await expect(store.approvalsGet({
      artifactId: 'malformed-plain-approval',
      serverId: null,
    })).rejects.toMatchObject({
      code: 'artifact_encryption_material_unavailable',
    });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('fails typed as retryable read-unavailable, not absence or locked content, when the Artifact API returns 500 (list keeps list_failed)', async () => {
    const store = createStore({ token: 'token-only', encryption: null }, 'plain');

    mockGet.mockResolvedValueOnce({
      status: 500,
      data: { error: 'Failed to get artifact' },
    });
    await expect(store.approvalsGet({
      artifactId: 'unavailable-approval',
      serverId: null,
    })).rejects.toMatchObject({
      code: 'artifact_read_unavailable',
    });

    mockGet.mockResolvedValueOnce({
      status: 500,
      data: { error: 'Failed to get artifacts' },
    });
    await expect(store.approvalsList({
      status: 'open',
      limit: 10,
      serverId: null,
    })).rejects.toMatchObject({
      code: 'list_failed',
    });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('fetches only exact-Session approval rows with a thousand foreign approvals, without narrowing Account lists', async () => {
    const store = createStore({ token: 'token-only', encryption: null }, 'plain');
    const records = Array.from({ length: 1002 }, (_, index) => {
      const sessionId = index < 1000 ? `foreign-session-${index}` : 'selected-session';
      const request = ApprovalRequestV1Schema.parse({
        v: 1, actionId: 'session.message.send', status: 'open', summary: 'Approval metadata',
        createdAtMs: 1, updatedAtMs: 2000 - index, createdBy: { surface: 'cli', sessionId },
        actionArgs: { sessionId, message: 'Approved message' },
      });
      return { sessionId, row: {
        id: `approval-${index}`, ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1,
        seq: index + 1, createdAt: 1, updatedAt: 2000 - index,
        header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: 'server-1' })),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }),
      } };
    });
    let fetchedHeaders = 0;
    const fetchedBodies: string[] = [];
    // Only HTTP is replaced. The Action's target attenuation, queue producer,
    // header paging, actual codecs and strict body correspondence remain real.
    mockGet.mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname !== '/v1/artifacts') throw new Error(`Unexpected read ${parsed.pathname}`);
      const selectedIds: unknown = JSON.parse(parsed.searchParams.get('approvalSessionIds') ?? 'null');
      const selected = records.filter(record => !Array.isArray(selectedIds) || selectedIds.includes(record.sessionId));
      const cursor = parsed.searchParams.get('cursor');
      const start = cursor ? selected.findIndex(({ row }) => encodeAccountArtifactListCursor({ artifactId: row.id, updatedAt: row.updatedAt }) === cursor) + 1 : 0;
      if (cursor && start === 0) throw new Error('Unknown source cursor');
      const rows = selected.slice(start, start + Number(parsed.searchParams.get('limit'))).map(({ row }) => {
        const { body: _body, ...header } = row;
        return header;
      });
      fetchedHeaders += rows.length;
      return { status: 200, data: rows };
    });
    mockPost.mockImplementation(async (url: string, input: unknown) => {
      expect(new URL(url).pathname).toBe('/v1/artifacts/read');
      const request = ArtifactReadBatchInputV1Schema.parse(input);
      fetchedBodies.push(...request.artifactIds);
      return { status: 200, data: ArtifactReadBatchResponseV1Schema.parse({ items: request.artifactIds.map(artifactId =>
        batchFixtureItem(artifactId, records.find(({ row }) => row.id === artifactId)?.row)) }) };
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...store });
    const exact = await executor.execute('approval.request.list', { status: 'open', limit: 10 }, {
      surface: 'cli', serverId: 'server-1', externalActionTarget: { kind: 'session', sessionId: 'selected-session' },
    });
    expect(exact).toMatchObject({ ok: true, result: { items: [
      { artifactId: 'approval-1000', sessionId: 'selected-session' },
      { artifactId: 'approval-1001', sessionId: 'selected-session' },
    ], nextCursor: null } });
    expect(fetchedHeaders).toBe(2);
    expect(fetchedBodies).toEqual(['approval-1000', 'approval-1001']);

    fetchedHeaders = 0;
    fetchedBodies.length = 0;
    const account = await executor.execute('approval.request.list', { status: 'open', limit: 2 }, { surface: 'cli', serverId: 'server-1' });
    expect(account).toMatchObject({ ok: true, result: { items: [
      { artifactId: 'approval-0', sessionId: 'foreign-session-0' },
      { artifactId: 'approval-1', sessionId: 'foreign-session-1' },
    ] } });
    expect(fetchedBodies).toEqual(['approval-0', 'approval-1']);
  });

  it('pages the real approval-list Action beyond 100 rows and filters without dropping matches at a source-page boundary', async () => {
    const store = createStore({ token: 'token-only', encryption: null }, 'plain');
    const rows = Array.from({ length: 105 }, (_, index) => {
      const request = ApprovalRequestV1Schema.parse({
        v: 1, actionId: index === 0 || index >= 102 ? 'session.message.send' : 'automation.event.source.status.report',
        status: 'open', summary: 'Approval metadata', createdAtMs: 1, updatedAtMs: 200 - index,
        createdBy: { surface: 'cli' }, actionArgs: {},
      });
      return { id: `approval-${index}`, ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1,
        seq: index + 1, createdAt: 1, updatedAt: 200 - index,
        header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(request, { legacyServerId: 'server-1' })),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify(request) }) };
    });
    mockGet.mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname !== '/v1/artifacts') throw new Error(`Unexpected read ${parsed.pathname}`);
      expect(JSON.parse(parsed.searchParams.get('approvalStates')!)).toEqual(['open']);
      expect(JSON.parse(parsed.searchParams.get('kinds')!)).toEqual(['approval_request.v1', 'target_action_approval.v1']);
      const cursor = parsed.searchParams.get('cursor');
      const start = cursor ? rows.findIndex(row => encodeAccountArtifactListCursor({ artifactId: row.id, updatedAt: row.updatedAt }) === cursor) + 1 : 0;
      if (cursor && start === 0) throw new Error('Unknown source cursor');
      const limit = Number(parsed.searchParams.get('limit'));
      return { status: 200, data: rows.slice(start, start + limit) };
    });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...store });
    const list = async (input: Record<string, unknown>) => {
      const result = await executor.execute('approval.request.list', input, { surface: 'cli', serverId: 'server-1' });
      if (!result.ok) throw new Error(result.errorCode);
      return result.result as { items: Array<{ artifactId: string }>; nextCursor: string | null };
    };
    const first = await list({ status: 'open', limit: 100 });
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await list({ status: 'open', limit: 100, cursor: first.nextCursor });
    expect(second.items.map(item => item.artifactId)).toEqual(rows.slice(100).map(row => row.id));
    expect(second.nextCursor).toBeNull();
    const filtered = await list({ status: 'open', actionId: 'session.message.send', limit: 3 });
    expect(filtered.items.map(item => item.artifactId)).toEqual(['approval-0', 'approval-102', 'approval-103']);
    expect(filtered.nextCursor).toEqual(expect.any(String));
    const tail = await list({ status: 'open', actionId: 'session.message.send', limit: 3, cursor: filtered.nextCursor });
    expect(tail.items.map(item => item.artifactId)).toEqual(['approval-104']);
    expect(tail.nextCursor).toBeNull();
  });

  it('scans Artifact cursors until it finds the requested matching approval', async () => {
    const store = createStore({ token: 'token-only', encryption: null }, 'plain');
    const encodedHeader = (value: Record<string, unknown>) => encodeBase64(
      new TextEncoder().encode(JSON.stringify({ t: 'plain', v: value })),
      'base64',
    );
    const approval = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'open',
      summary: 'Approve message',
      createdAtMs: 7,
      updatedAtMs: 94,
      createdBy: { surface: 'cli' },
      actionArgs: { sessionId: 'session-1', message: 'hello' },
    });
    const approvalHeader = encodedHeader({
      v: 1,
      kind: 'approval_request.v1',
      title: approval.summary,
      approvalStatus: approval.status,
      actionId: approval.actionId,
      serverId: 'server-1',
    });
    const approvalBody = encodePlainArtifactStoredContent({ body: JSON.stringify(approval) });
    const rows = [
      ...Array.from({ length: 501 }, (_, index) => ({
        id: `unrelated-${index}`,
        header: encodedHeader({ v: 1, kind: 'prompt_library_item.v1', title: `Other ${index}` }),
        headerVersion: 1,
        ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        seq: index + 1,
        createdAt: index + 1,
        updatedAt: 1000 - index,
      })),
      {
        id: 'approval-after-unrelated',
        header: approvalHeader,
        headerVersion: 1,
        ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        seq: 502,
        createdAt: 502,
        updatedAt: 499,
      },
    ];
    mockGet.mockImplementation(async (url: string) => {
      if (url.includes('/v1/artifacts/approval-after-unrelated')) {
        return {
          status: 200,
          data: {
            id: 'approval-after-unrelated',
            header: approvalHeader,
            headerVersion: 1,
            body: approvalBody,
            bodyVersion: 1,
            ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
            dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
            seq: 502,
            createdAt: 502,
            updatedAt: 499,
          },
        };
      }
      const query = new URL(url).searchParams;
      const cursor = query.get('cursor');
      const start = cursor ? rows.findIndex(row => encodeAccountArtifactListCursor({ artifactId: row.id, updatedAt: row.updatedAt }) === cursor) + 1 : 0;
      return { status: 200, data: rows.slice(start, start + Number(query.get('limit'))) };
    });

    await expect(store.approvalsList({ status: 'open', limit: 1, serverId: 'server-1' }))
      .resolves.toMatchObject({
        items: [{ artifactId: 'approval-after-unrelated', status: 'open', serverId: 'server-1' }],
        queryPlan: { kind: 'approval_artifact_header_scan' },
      });
    expect(mockGet.mock.calls.filter(([url]) => new URL(String(url)).pathname === '/v1/artifacts')).toHaveLength(2);
  });

  it('lists a strict approval from the complete page while individual body reads are unavailable', async () => {
    const store = createStore({ token: 'token-only', encryption: null }, 'plain');
    const approval = ApprovalRequestV1Schema.parse({
      v: 1, actionId: 'session.message.send', status: 'open', summary: 'Approve message',
      createdAtMs: 1, updatedAtMs: 2, createdBy: { surface: 'cli' },
      actionArgs: { sessionId: 'session-1', message: 'hello' },
    });
    const { buildApprovalRequestArtifactHeaderV1 } = await import('@happier-dev/protocol/approvals/approvalArtifactHeaderV1');
    const row = {
      id: 'paged-approval', ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1,
      header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1(approval, { legacyServerId: 'server-1' })),
      body: encodePlainArtifactStoredContent({ body: JSON.stringify(approval) }),
      seq: 1, createdAt: 1, updatedAt: 2,
    };
    mockGet.mockImplementation(async (url: string) => {
      const parsed = new URL(url);
      if (parsed.pathname !== '/v1/artifacts') return { status: 503, data: { error: 'unavailable' } };
      const content = parsed.searchParams.get('includeBody') === 'true' ? {} : { body: undefined };
      return { status: 200, data: [{ ...row, ...content }, {
        ...row, ...content, id: 'mismatched-page-approval',
        header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1({ ...approval, summary: 'Wrong subject' }, { legacyServerId: 'server-1' })),
      }] };
    });
    mockPost.mockImplementation(async (url: string, input: unknown) => {
      expect(new URL(url).pathname).toBe('/v1/artifacts/read');
      const request = ArtifactReadBatchInputV1Schema.parse(input);
      return { status: 200, data: ArtifactReadBatchResponseV1Schema.parse({ items: request.artifactIds.map(artifactId =>
        batchFixtureItem(artifactId, artifactId === row.id ? row : { ...row, id: artifactId,
          header: encodePlainArtifactStoredContent(buildApprovalRequestArtifactHeaderV1({ ...approval, summary: 'Wrong subject' }, { legacyServerId: 'server-1' })) })) }) };
    });
    await expect(store.approvalsList({ status: 'open', limit: 10, serverId: 'server-1' }))
      .resolves.toMatchObject({ items: [{ artifactId: row.id, status: 'open', summary: approval.summary }] });
  });

  it('fails a retained encrypted approval list with typed locked state instead of omitting the row', async () => {
    const store = createStore({ token: 'token-only', encryption: null }, 'e2ee');
    mockGet.mockResolvedValueOnce({
      status: 200,
      data: [{
        id: 'retained-approval',
        header: 'retained-encrypted-header',
        headerVersion: 2,
        ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
        dataEncryptionKey: 'retained-encrypted-data-key',
        seq: 3,
        createdAt: 1,
        updatedAt: 2,
      }],
    });

    await expect(store.approvalsList({
      status: 'open',
      limit: 10,
      serverId: null,
    })).rejects.toMatchObject({
      code: 'artifact_encryption_material_unavailable',
    });
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('lists approval queue items only after the encrypted header and body agree', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);

    const request = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'open',
      summary: 'Approve sending a message',
      createdAtMs: 1,
      updatedAtMs: 2,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionArgs: { sessionId: 's1', message: 'hello' },
    });

    let createdPayload: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      createdPayload = body;
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const created = await store.approvalsCreate({ request, serverId: 'server-1' });

    mockGet
      .mockImplementationOnce(async (url: string) => {
        expect(url).toContain('/v1/artifacts');
        return {
          status: 200,
          data: [
            {
              id: created.artifactId,
              header: createdPayload.header,
              headerVersion: 1,
              ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
              dataEncryptionKey: createdPayload.dataEncryptionKey,
              seq: 1,
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        };
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          id: created.artifactId,
          header: createdPayload.header,
          headerVersion: 1,
          body: createdPayload.body,
          bodyVersion: 1,
          ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
          dataEncryptionKey: createdPayload.dataEncryptionKey,
          seq: 1,
          createdAt: 1,
          updatedAt: 2,
        },
      });

    const listed = await store.approvalsList({ status: 'open', limit: 10, serverId: 'server-1' });

    expect(listed).toEqual({
      nextCursor: null,
      items: [
        {
          artifactId: created.artifactId,
          status: 'open',
          actionId: 'session.message.send',
          summary: 'Approve sending a message',
          sessionId: 's1',
          serverId: 'server-1',
          updatedAtMs: 2,
        },
      ],
      queryPlan: {
        kind: 'approval_artifact_header_scan',
        backingStore: 'ArtifactStore',
        boundedBy: 'ArtifactStore source exhaustion',
        serverLimit: 10,
        hydratedTranscripts: false,
      },
    });
  });

  it('omits an open candidate that settles before its body-authoritative read', async () => {
    const store = createStore({ token: 'token-only', encryption: null }, 'plain');
    const encodeHeader = (value: Record<string, unknown>) => encodeBase64(
      new TextEncoder().encode(JSON.stringify({ t: 'plain', v: value })),
      'base64',
    );
    const approved = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'approved',
      summary: 'Approve sending a message',
      createdAtMs: 1,
      updatedAtMs: 2,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionArgs: { sessionId: 's1', message: 'hello' },
      decision: { kind: 'approve', decidedAtMs: 2 },
    });
    const staleListHeader = encodeHeader({
      v: 1,
      kind: 'approval_request.v1',
      title: approved.summary,
      approvalStatus: 'open',
      actionId: approved.actionId,
      sessions: ['s1'],
      sessionId: 's1',
      serverId: 'server-1',
    });
    const hydratedHeader = encodeHeader({
      v: 1,
      kind: 'approval_request.v1',
      title: approved.summary,
      approvalStatus: 'approved',
      actionId: approved.actionId,
      sessions: ['s1'],
      sessionId: 's1',
      serverId: 'server-1',
    });
    mockGet
      .mockResolvedValueOnce({
        status: 200,
        data: [{
          id: 'approval-raced',
          header: staleListHeader,
          headerVersion: 1,
          ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
          dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
          seq: 1,
          createdAt: 1,
          updatedAt: 1,
        }],
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          id: 'approval-raced',
          header: hydratedHeader,
          headerVersion: 2,
          body: encodePlainArtifactStoredContent({ body: JSON.stringify(approved) }),
          bodyVersion: 2,
          ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'plain',
          dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
          seq: 2,
          createdAt: 1,
          updatedAt: 2,
        },
      });

    // The atomic server query selected the open header. Its exact read may
    // observe a later settlement, which must disappear from the open queue.
    await expect(store.approvalsList({ status: 'open', limit: 10, serverId: 'server-1' }))
      .resolves.toMatchObject({ items: [] });
  });

  it('excludes unscoped approval artifacts from server-scoped list queries', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);

    const request = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'open',
      summary: 'Approve sending a message',
      createdAtMs: 1,
      updatedAtMs: 2,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionArgs: { sessionId: 's1', message: 'hello' },
    });

    let createdPayload: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      createdPayload = body;
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const created = await store.approvalsCreate({ request, serverId: null });

    mockGet.mockImplementationOnce(async () => ({
      status: 200,
      data: [
        {
          id: created.artifactId,
          header: createdPayload.header,
          headerVersion: 1,
          ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
          dataEncryptionKey: createdPayload.dataEncryptionKey,
          seq: 1,
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    })).mockResolvedValueOnce({
      status: 200,
      data: {
        id: created.artifactId,
        header: createdPayload.header,
        headerVersion: 1,
        body: createdPayload.body,
        bodyVersion: 1,
        ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
        dataEncryptionKey: createdPayload.dataEncryptionKey,
        seq: 1,
        createdAt: 1,
        updatedAt: 2,
      },
    });

    const listed = await store.approvalsList({ status: 'open', limit: 10, serverId: 'server-1' });

    expect(listed.items).toEqual([]);
  });

  it('does not return approval artifacts from another server scope', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);

    const request = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'open',
      summary: 'Approve sending a message',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionArgs: { sessionId: 's1', message: 'hello' },
    });

    let createdPayload: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      createdPayload = body;
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const created = await store.approvalsCreate({ request, serverId: 'server-2' });

    mockGet.mockImplementationOnce(async () => ({
      status: 200,
      data: {
        id: created.artifactId,
        header: createdPayload.header,
        headerVersion: 1,
        body: createdPayload.body,
        bodyVersion: 1,
        ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
        dataEncryptionKey: createdPayload.dataEncryptionKey,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    })).mockResolvedValueOnce({
      status: 200,
      data: {
        id: created.artifactId,
        header: createdPayload.header,
        headerVersion: 1,
        body: createdPayload.body,
        bodyVersion: 1,
        ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
        dataEncryptionKey: createdPayload.dataEncryptionKey,
        seq: 1,
        createdAt: 1,
        updatedAt: 2,
      },
    });

    const read = await store.approvalsGet({ artifactId: created.artifactId, serverId: 'server-1' });

    expect(read).toBeNull();
  });

  it('lists canceled approval queue items from encrypted artifact headers', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);

    const request = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'canceled',
      summary: 'Canceled send request',
      createdAtMs: 1,
      updatedAtMs: 2,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionArgs: { sessionId: 's1', message: 'hello' },
    });

    let createdPayload: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      createdPayload = body;
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const created = await store.approvalsCreate({ request, serverId: 'server-1' });

    mockGet
      .mockImplementationOnce(async () => ({
        status: 200,
        data: [
          {
            id: created.artifactId,
            header: createdPayload.header,
            headerVersion: 1,
            ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
            dataEncryptionKey: createdPayload.dataEncryptionKey,
            seq: 1,
            createdAt: 1,
            updatedAt: 2,
          },
        ],
      }))
      .mockImplementationOnce(async () => ({
        status: 200,
        data: {
          id: created.artifactId,
          header: createdPayload.header,
          headerVersion: 1,
          body: createdPayload.body,
          bodyVersion: 1,
          ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
          dataEncryptionKey: createdPayload.dataEncryptionKey,
          seq: 1,
          createdAt: 1,
          updatedAt: 2,
        },
      }));

    const listed = await store.approvalsList({ status: 'canceled', limit: 10, serverId: 'server-1' });

    expect(listed.items).toEqual([
      expect.objectContaining({
        artifactId: created.artifactId,
        status: 'canceled',
        actionId: 'session.message.send',
        summary: 'Canceled send request',
        sessionId: 's1',
        serverId: 'server-1',
      }),
    ]);
  });

  it('updates approval artifacts using optimistic versions', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);

    const request = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'approved',
      summary: 'Approve sending a message',
      createdAtMs: 1,
      updatedAtMs: 2,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionArgs: { sessionId: 's1', message: 'hello' },
      decision: { kind: 'approve', decidedAtMs: 2 },
    });

    // Create a stable on-server artifact record to update.
    const updateStore = createStore(credentials);
    let createPayload: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      createPayload = body;
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const created = await updateStore.approvalsCreate({
      request: ApprovalRequestV1Schema.parse({ ...request, status: 'open', updatedAtMs: 1, decision: undefined }),
      serverId: null,
    });

    const storedRecord = {
      id: created.artifactId,
      header: createPayload.header,
      headerVersion: 3,
      body: createPayload.body,
      bodyVersion: 4,
      ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
      dataEncryptionKey: createPayload.dataEncryptionKey,
      seq: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    mockGet.mockImplementationOnce(async () => ({
      status: 200,
      data: storedRecord,
    })).mockImplementationOnce(async () => ({ status: 200, data: storedRecord }));

    let capturedUpdateBody: any = null;
    mockPost.mockImplementationOnce(async (url: string, body: any) => {
      expect(url).toContain(`/v1/artifacts/${encodeURIComponent(created.artifactId)}`);
      capturedUpdateBody = body;
      return { status: 200, data: { success: true, headerVersion: 4, bodyVersion: 5 } };
    });

    const res = await store.approvalsUpdate({ artifactId: created.artifactId, request, serverId: null });
    expect(res).toEqual({ ok: true });

    expect(capturedUpdateBody).toMatchObject({
      expectedHeaderVersion: 3,
      expectedBodyVersion: 4,
    });

    const dataKey = openEncryptedDataKeyEnvelopeV1({
      envelope: decodeBase64(createPayload.dataEncryptionKey),
      recipientSecretKeyOrSeed: (credentials.encryption as any).machineKey,
    });
    expect(dataKey).not.toBeNull();

    const decryptedHeader = decryptWithDataKey(decodeBase64(capturedUpdateBody.header), dataKey!);
    expect(decryptedHeader).toMatchObject({
      kind: 'approval_request.v1',
      approvalStatus: 'approved',
      title: request.summary,
      actionId: request.actionId,
    });

    const decryptedBody = decryptWithDataKey(decodeBase64(capturedUpdateBody.body), dataKey!);
    expect(decryptedBody).toEqual({ body: JSON.stringify(request) });
  });

  it('admits the executing claim only for current V2 approvals and only through the artifact revision CAS', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);

    const open = ApprovalRequestV2Schema.parse({
      v: 2,
      actionId: 'session.message.send',
      status: 'open',
      summary: 'Approve sending a message',
      createdAtMs: 1,
      updatedAtMs: 1,
      createdBy: { surface: 'mcp' },
      requestedSurface: 'mcp',
      executionOriginV1: {
        v: 1,
        authority: 'account_automation',
        surface: 'mcp',
        caller: { kind: 'host' },
        serverId: 'server-1',
        sessionId: 's1',
        target: { kind: 'session', sessionId: 's1' },
        actionId: 'session.message.send',
        requestId: 'request-1',
      },
      actionArgs: { sessionId: 's1', message: 'hello' },
    });
    const approved = ApprovalRequestV2Schema.parse({
      ...open, status: 'approved', updatedAtMs: 2, decision: { kind: 'approve', decidedAtMs: 2 },
    });
    const executing = ApprovalRequestV2Schema.parse({ ...approved, status: 'executing', updatedAtMs: 3 });
    const executed = ApprovalRequestV2Schema.parse({
      ...approved,
      status: 'executed',
      updatedAtMs: 4,
      execution: { executedAtMs: 4, ok: true, result: { status: 'accepted', localId: 'local-1' } },
    });

    let createPayload: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      createPayload = body;
      return createdArtifactResponse(body, 'e2ee');
    });
    const created = await store.approvalsCreate({ request: open, serverId: 'server-1' });

    const dataKey = openEncryptedDataKeyEnvelopeV1({
      envelope: decodeBase64(createPayload.dataEncryptionKey),
      recipientSecretKeyOrSeed: (credentials.encryption as any).machineKey,
    });
    const recordFor = (request: unknown, headerVersion: number, bodyVersion: number) => {
      const header = { ...(decryptWithDataKey(decodeBase64(createPayload.header), dataKey!) as any) };
      header.approvalStatus = (request as { status: string }).status;
      return {
        id: created.artifactId,
        header: encodeBase64(encryptWithDataKey(header, dataKey!)),
        headerVersion,
        body: encodeBase64(encryptWithDataKey({ body: JSON.stringify(request) }, dataKey!)),
        bodyVersion,
        ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
        dataEncryptionKey: createPayload.dataEncryptionKey,
        seq: headerVersion,
        createdAt: 1,
        updatedAt: headerVersion,
      };
    };

    // An open row cannot be claimed: the decision must be committed first.
    mockGet.mockResolvedValue({ status: 200, data: recordFor(open, 1, 1) });
    await expect(store.approvalsUpdate({ artifactId: created.artifactId, request: executing, serverId: 'server-1' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_transition' });

    // approved -> executing rides the exact read revision as its CAS precondition.
    mockGet.mockResolvedValue({ status: 200, data: recordFor(approved, 5, 6) });
    let claimBody: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      claimBody = body;
      return { status: 200, data: { success: true, headerVersion: 6, bodyVersion: 7 } };
    });
    await expect(store.approvalsUpdate({ artifactId: created.artifactId, request: executing, serverId: 'server-1' }))
      .resolves.toEqual({ ok: true });
    expect(claimBody).toMatchObject({ expectedHeaderVersion: 5, expectedBodyVersion: 6 });

    // Exact terminal settlements stay idempotent, but an exact executing row is
    // evidence that this caller did not win the approved -> executing claim.
    mockGet.mockResolvedValueOnce({ status: 200, data: recordFor(executing, 6, 7) });
    const postsBeforeDuplicateClaim = mockPost.mock.calls.length;
    await expect(store.approvalsUpdate({ artifactId: created.artifactId, request: executing, serverId: 'server-1' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_transition' });
    expect(mockPost.mock.calls.length).toBe(postsBeforeDuplicateClaim);

    // A concurrent claimant that lost the server CAS gets a typed version mismatch, not a silent write.
    mockPost.mockImplementationOnce(async () => ({
      status: 200, data: { success: false, error: 'version-mismatch' },
    }));
    await expect(store.approvalsUpdate({ artifactId: created.artifactId, request: executing, serverId: 'server-1' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'version_mismatch' });

    // executing -> terminal is the only transition an already-claimed row admits.
    mockGet.mockResolvedValue({ status: 200, data: recordFor(executing, 6, 7) });
    await expect(store.approvalsUpdate({ artifactId: created.artifactId, request: approved, serverId: 'server-1' }))
      .resolves.toMatchObject({ ok: false, errorCode: 'invalid_transition' });
    mockPost.mockImplementationOnce(async () => ({
      status: 200, data: { success: true, headerVersion: 7, bodyVersion: 8 },
    }));
    await expect(store.approvalsUpdate({ artifactId: created.artifactId, request: executed, serverId: 'server-1' }))
      .resolves.toEqual({ ok: true });

    // A duplicate terminal write against the settled row is idempotent, not a second effect.
    mockGet.mockResolvedValue({ status: 200, data: recordFor(executed, 7, 8) });
    const postsBeforeDuplicate = mockPost.mock.calls.length;
    await expect(store.approvalsUpdate({ artifactId: created.artifactId, request: executed, serverId: 'server-1' }))
      .resolves.toEqual({ ok: true });
    expect(mockPost.mock.calls.length).toBe(postsBeforeDuplicate);

    // Released V1 owns no executing state at all, at the schema or the store.
    const legacyApproved = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'approved',
      summary: 'Approve sending a message',
      createdAtMs: 1,
      updatedAtMs: 2,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionArgs: { sessionId: 's1', message: 'hello' },
      decision: { kind: 'approve', decidedAtMs: 2 },
    });
    expect(ApprovalRequestV1Schema.safeParse({ ...legacyApproved, status: 'executing' }).success).toBe(false);
  });

  it('rejects updates to approval artifacts from another server scope', async () => {
    const credentials = createCredentials();
    const store = createStore(credentials);

    const request = ApprovalRequestV1Schema.parse({
      v: 1,
      actionId: 'session.message.send',
      status: 'approved',
      summary: 'Approve sending a message',
      createdAtMs: 1,
      updatedAtMs: 2,
      createdBy: { surface: 'cli', sessionId: 's1' },
      actionArgs: { sessionId: 's1', message: 'hello' },
      decision: { kind: 'approve', decidedAtMs: 2 },
    });

    let createPayload: any = null;
    mockPost.mockImplementationOnce(async (_url: string, body: any) => {
      createPayload = body;
      return { status: 200, data: { id: body.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const created = await store.approvalsCreate({
      request: ApprovalRequestV1Schema.parse({ ...request, status: 'open', updatedAtMs: 1, decision: undefined }),
      serverId: 'server-2',
    });

    mockGet.mockImplementationOnce(async () => ({
      status: 200,
      data: {
        id: created.artifactId,
        header: createPayload.header,
        headerVersion: 3,
        body: createPayload.body,
        bodyVersion: 4,
        ownerAccountId: 'account-1', access: 'owner', encryptionMode: 'e2ee',
        dataEncryptionKey: createPayload.dataEncryptionKey,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    }));
    mockPost.mockImplementationOnce(async () => ({
      status: 200,
      data: { success: true, headerVersion: 4, bodyVersion: 5 },
    }));

    const res = await store.approvalsUpdate({ artifactId: created.artifactId, request, serverId: 'server-1' });

    expect(res).toEqual({ ok: false, errorCode: 'not_found', error: 'artifact_not_found', writeCommitted: false });
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
});
