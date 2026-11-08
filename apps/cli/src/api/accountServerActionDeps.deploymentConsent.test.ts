import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { createAccountServerActionDeps } from './accountServerActionDeps';
import tweetnacl from 'tweetnacl';
import { ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { wrapApiTokenEncryptionAccessV1 } from '@happier-dev/protocol/crypto/apiTokenEncryptionAccess';
import { encodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { createAccountEncryptionCurrentnessFixture } from '@/testkit/backends/sessionFixtures';
import { retainApiTokenDeploymentContentAccess } from '@/auth/apiTokenDeploymentCustody';
import { prepareApiTokenDeploymentAccountProjection, readApiTokenDeploymentArtifactStore } from '@/daemon/sessionEncryption/requesterAccountActionProjection';
import { DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 } from '@happier-dev/deployment-protocol';
import { readCarrierMutation } from '@/api/artifacts/accountArtifactStore.testkit';
import { tryDeriveArtifactStoredKindV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createDeploymentEnvironmentDetailV1 } from '@happier-dev/deployment-protocol/testing/v1';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('token deployment authoring through the native Account HTTP owner', () => {
  it.each(['production', 'nonProduction'] as const)('preselects omitted mode from one admitted Environment header (%s)', async protection => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-owner' })).toString('base64url')}.signature`;
    const detail = createDeploymentEnvironmentDetailV1();
    detail.environment.protection = protection;
    const requests: string[] = [];
    let mutation: unknown;
    vi.spyOn(axios, 'request').mockImplementation(async request => {
      const path = new URL(String(request.url)).pathname;
      requests.push(path);
      if (path === `/v1/deployments/environments/${detail.environment.id}`) return { status: 200,
        data: { ok: true, environment: detail.environment, targetLinks: detail.targetLinks.map(row => row.targetLink) } };
      mutation = request.data;
      return { status: 403, data: { error: 'present_user_required' } };
    });
    vi.spyOn(axios, 'get').mockImplementation(async () => { throw new Error('Initial choice cannot open private content'); });
    const deps = createAccountServerActionDeps({ token, credentials: { token, encryption: null }, serverId: 'home',
      serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://token.test', isCredentialCurrent: async () => true });
    await deps.accountApiTokensCreateAction!({ input: { tokenId: '11111111-1111-4111-8111-111111111111', label: 'CI',
      grant: { ...API_TOKEN_FULL_GRANT_V1, actions: { families: [], ids: ['deployments.deploy', 'action.operations.get'] },
        targets: { sessions: [], machines: [], environments: [detail.environment.id] } },
      deployment: { serverId: 'home', environmentId: detail.environment.id } },
      context: { surface: 'cli', authority: 'present_user', actionCaller: { kind: 'host' },
        runtimeAccountId: 'account-owner', serverId: 'home', actionRequestId: 'initial-save' } });
    expect(requests).toEqual([`/v1/deployments/environments/${detail.environment.id}`, '/v1/auth/api-tokens/create']);
    expect(mutation).toMatchObject({ deployment: { serverId: 'srv_home', deployApproval: protection === 'production' ? 'ask' : 'automatic' } });
  });
  it('retains E2EE token custody for admitted content when a redundant token-self read would fail', async () => {
    const accountId = 'account-owner';
    const tokenId = '11111111-1111-4111-8111-111111111111';
    const machineKey = new Uint8Array(32).fill(9);
    const contentPublicKey = encodeBase64(tweetnacl.box.keyPair.fromSecretKey(machineKey).publicKey);
    const wrappingSecret = new Uint8Array(32).fill(3);
    const grant = { ...API_TOKEN_FULL_GRANT_V1,
      actions: { families: [], ids: ['deployments.deploy', 'action.operations.get'] },
      targets: { sessions: [], machines: [], environments: ['staging'] } };
    const authorization = { ...ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'signed-execution', binding: {
      serverIdentityId: 'srv_home', accountId, principalId: accountId, credentialId: tokenId,
      grant, accountEncryptionMode: 'e2ee', machineId: 'machine-a', installationId: 'installation-a',
      custodianAccountId: accountId, actionId: 'deployments.deploy', requestId: 'candidate', requestEnvelopeDigest: 'a'.repeat(43),
      environmentId: 'staging', target: { kind: 'machine', machineId: 'machine-a' },
    } }), requesterHttpProjection: {
      accountId, serverId: 'srv_home', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://token.test',
      accountEncryptionMode: 'e2ee' as const, isCurrent: async () => true,
      createRequestHeaders: async () => ({ 'x-test-root': 'signed' }),
    } };
    let selfReads = 0;
    let wrappedAccountId = 'another-account';
    vi.spyOn(axios, 'request').mockImplementation(async request => {
      const path = new URL(String(request.url)).pathname;
      if (path === '/v1/auth/api-tokens/self') {
        selfReads++;
        return { status: 503, data: { error: 'unavailable' } };
      }
      if (path === '/v1/auth/api-tokens/encryption-access') return { status: 200, data: { v: 1, accountId: wrappedAccountId, tokenId,
        encryptionAccess: wrapApiTokenEncryptionAccessV1({ context: { serverIdentityId: 'srv_home', accountId, tokenId, contentPublicKey },
          wrappingSecret, contentPrivateKey: machineKey, randomBytes: length => new Uint8Array(length).fill(1) }) } };
      throw new Error('Unexpected requester HTTP read');
    });
    let stored: ReturnType<typeof readCarrierMutation> | undefined;
    let storedMode: 'e2ee' | 'plain' = 'e2ee';
    vi.spyOn(axios, 'get').mockImplementation(async url => {
      if (String(url).endsWith('/v1/account/encryption/currentness')) return { status: 200,
        data: createAccountEncryptionCurrentnessFixture({ mode: 'e2ee' }) };
      if (stored && String(url).endsWith(`/v1/artifacts/${stored.id}`)) return { status: 200, data: {
        ...stored, ownerAccountId: accountId, access: 'owner', encryptionMode: storedMode,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
      } };
      throw new Error('Unexpected requester content read');
    });
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(JSON.stringify({
      features: { artifacts: { queryHints: { enabled: true } } }, capabilities: {},
    }), { status: 200, headers: { 'content-type': 'application/json' } })));
    const writes = vi.spyOn(axios, 'post').mockImplementation(async (_url, raw) => {
      const value = readCarrierMutation(raw);
      expect(value.kind).toBe(tryDeriveArtifactStoredKindV1({ kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1 }));
      expect(value.dataEncryptionKey).not.toBe(ARTIFACT_PLAIN_DATA_KEY_MARKER);
      stored = value;
      return { status: 200, data: { id: value.id, headerVersion: 1, bodyVersion: 1 } };
    });
    const retire = retainApiTokenDeploymentContentAccess(authorization, { contentPublicKey,
      wrappingSecret: encodeBase64(wrappingSecret, 'base64url') });
    // S8: Home's signed root supplies mode; acquired key custody still binds the Account.
    expect(await prepareApiTokenDeploymentAccountProjection(authorization)).toBeNull();
    wrappedAccountId = accountId;
    const custody = await prepareApiTokenDeploymentAccountProjection(authorization);
    try {
      expect(custody).not.toBeNull();
      const store = readApiTokenDeploymentArtifactStore(authorization);
      if (!store) throw new Error('Expected token-owned Artifact store');
      await store.create({ artifactId: '22222222-2222-4222-8222-222222222222',
        header: { kind: DEPLOYMENT_RECEIPT_ARTIFACT_KIND_V1, title: 'Candidate' }, body: '{"candidate":true}',
        authorizationHeaders: async () => ({ 'x-test-root': 'signed' }) });
      expect(writes).toHaveBeenCalledTimes(1);
      await expect(store.read('22222222-2222-4222-8222-222222222222', { prepareRecipients: false,
        includeSharedAudience: false, authorizationHeaders: async () => ({ 'x-test-root': 'signed' }) }))
        .resolves.toMatchObject({ body: '{"candidate":true}' });
      expect(selfReads).toBe(0);
      storedMode = 'plain';
      await expect(store.read('22222222-2222-4222-8222-222222222222', { prepareRecipients: false,
        includeSharedAudience: false, authorizationHeaders: async () => ({ 'x-test-root': 'signed' }) }))
        .rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
      storedMode = 'e2ee';
      if (!stored) throw new Error('Expected the encrypted Artifact write');
      stored = { ...stored, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER };
      await expect(store.read('22222222-2222-4222-8222-222222222222', { prepareRecipients: false,
        includeSharedAudience: false, authorizationHeaders: async () => ({ 'x-test-root': 'signed' }) }))
        .rejects.toMatchObject({ code: 'artifact_account_mode_mismatch' });
      custody?.dispose();
      expect(readApiTokenDeploymentArtifactStore(authorization)).toBeNull();
      await expect(store.read('22222222-2222-4222-8222-222222222222', { prepareRecipients: false,
        includeSharedAudience: false, authorizationHeaders: async () => ({ 'x-test-root': 'signed' }) }))
        .rejects.toThrow('action_forbidden');
    } finally { custody?.dispose(); retire(); }
  });
  it('authors Automatic from actual person consent with zero Environment or content reads', async () => {
    const token = `header.${Buffer.from(JSON.stringify({ sub: 'account-owner' })).toString('base64url')}.signature`;
    const requests: string[] = [];
    const mutations: unknown[] = [];
    vi.spyOn(axios, 'request').mockImplementation(async request => {
      const path = new URL(String(request.url)).pathname;
      requests.push(path);
      mutations.push(request.data);
      return { status: 403, data: { error: 'present_user_required' } };
    });
    vi.spyOn(axios, 'get').mockImplementation(async () => { throw new Error('Automatic authoring must not open content'); });
    const deps = createAccountServerActionDeps({ token, credentials: { token, encryption: null }, serverId: 'home',
      serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://token.test', isCredentialCurrent: async () => true });
    const grant = { ...API_TOKEN_FULL_GRANT_V1,
      actions: { families: [], ids: ['deployments.deploy', 'action.operations.get'] },
      targets: { sessions: [], machines: [], environments: ['staging'] } };
    const context = { surface: 'cli' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const },
      runtimeAccountId: 'account-owner', serverId: 'home', actionRequestId: 'save-token' };
    for (const fields of [
      { grant: { ...grant, deployApproval: 'automatic' as const } },
      { grant, deployment: { serverId: 'home', environmentId: 'staging', deployApproval: 'automatic' as const } },
    ]) {
      const input = { tokenId: '11111111-1111-4111-8111-111111111111', label: 'CI', ...fields };
      await deps.accountApiTokensCreateAction!({ input, context });
      expect(requests).toEqual(['/v1/auth/api-tokens/create']);
      expect(mutations.at(-1)).toMatchObject({ grant: { deployApproval: 'automatic' } });
      if (fields.deployment) expect(mutations.at(-1)).toMatchObject({ deployment: { serverId: 'srv_home' } });
      requests.length = 0;
      await expect(deps.accountApiTokensCreateAction!({ input,
        context: { ...context, surface: 'agent', authority: 'account_automation',
          actionCaller: { kind: 'session', sessionId: 'agent-session', starterDepth: 0, turnDepth: 0 } } }))
        .resolves.toMatchObject({ ok: false, errorCode: 'approval_required' });
      expect(requests).toEqual([]);
    }
  });
});
