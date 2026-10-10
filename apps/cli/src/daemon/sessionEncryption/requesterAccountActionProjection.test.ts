import axios from 'axios';
import nacl from 'tweetnacl';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { ApiTokenGrantV1Schema } from '@happier-dev/protocol/auth/apiTokenGrant';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import type { StoredCredentials } from '@/persistence';
import { projectRequesterAccountActionAuthorization } from './requesterSessionCredentials';
import { projectExternalActionRequesterHttpAuthorization } from '@/api/externalActionExecutionAuthorization';
import * as requesterAccountOwner from './requesterAccountActionProjection';
import { getActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createActionOperationRunner } from '../actionOperations/actionOperationRunner';
import { createActionOperationStore } from '../actionOperations/actionOperationStore';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';

afterEach(() => vi.restoreAllMocks());

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
    expect(context?.authorization.requesterAccountProjection?.accountId).toBe('bob');
    expect(context?.accountSettingsContext.source).toBe('network');
    const readContext = Reflect.get(requesterAccountOwner, 'readRequesterAccountActionContext');
    expect(typeof readContext).toBe('function');
    if (typeof readContext !== 'function') throw new Error('Missing admitted private custody consumer port');
    expect(readContext(context.authorization)).toBe(context);
    expect(readContext(ExternalActionExecutionAuthorizationV1Schema.parse(context.authorization))).toBeNull();
    expect(JSON.stringify(context.authorization)).not.toContain('bob-ordinary');
    expect(getActiveAccountSettingsSnapshot()).toBe(before);
    expect(reads.mock.calls.some(([url]) => String(url).includes('/sessions'))).toBe(false);
    await context.dispose();
    expect(await context.authorization.requesterAccountProjection.isCurrent()).toBe(false);
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
    live = false;
    expect(await carrier?.requesterHttpProjection?.createRequestHeaders({ effectActionId: 'projects.context.update',
      method: 'POST', path: '/v1/projects/account-rows/list', body: {} })).toBeNull();
  });

  it('uses the admitted requester Artifact owner at the original Home and withholds a read after access loss', async () => {
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
    expect(await projected.requesterAccountProjection.readArtifact(ref)).toMatchObject({ artifactId, header,
      promptLibraryArtifact: { id: artifactId, header, body: 'private body', revision: { headerVersion: 1, bodyVersion: 1 } } });
    expect(reads.mock.calls.every(([url, config]) => String(url).startsWith('https://requester-home.test/')
      && config?.headers?.Authorization === 'Bearer bob-ordinary')).toBe(true);
    loseAdmissionDuringRead = true;
    expect(await projected.requesterAccountProjection.readArtifact(ref)).toBeNull();
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
