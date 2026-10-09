import axios from 'axios';
import { createServer, type Server } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import tweetnacl from 'tweetnacl';
import { EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER, EXTERNAL_ACTION_EFFECT_ACTION_HEADER,
  EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER, ExternalActionExecutionAuthorizationV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { verifyExternalActionMachineRequestV1 } from '@happier-dev/protocol/actions/externalActionExecutionAuthorization';
import { createCliActionDeps } from './createCliActionDeps';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createCredentialedAccountArtifactStore } from '@/api/artifacts/accountArtifactStore';
import { runWithServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { createProjectAccountRowCipherV1 } from '@happier-dev/protocol/projects/projectAccountRowCipherV1';

afterEach(() => vi.restoreAllMocks());

const token = `header.${Buffer.from(JSON.stringify({ sub: 'source-account' })).toString('base64url')}.signature`;
const source = { id: 'source/a', revision: 2, name: 'App', repository: {
  provider: { id: 'github', kind: 'github' as const, displayName: 'GitHub', baseUrl: 'https://github.com' },
  repository: { nameWithOwner: 'happier-dev/happier', cloneUrl: 'https://github.com/happier-dev/happier.git', visibility: 'public' as const }, protocol: 'https' as const,
}, audience: [], createdByAccountId: 'source-account' };
function deps() {
  return createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: 'source-session',
    mode: 'plain', ctx: null, serverId: 'source-home', serverHttpBaseUrl: 'https://source-home.test' });
}

describe('Source Actions through the CLI Account front door', () => {
  it('accepts only a current qualified requester Artifact through the same admitted carrier', async () => {
    const bobToken = `header.${Buffer.from(JSON.stringify({ sub: 'bob' })).toString('base64url')}.signature`;
    const artifacts = createCredentialedAccountArtifactStore({ token: bobToken, encryption: null });
    const artifactId = '11111111-1111-4111-8111-111111111111';
    let current = true;
    let retireAfterRead = false;
    const read = vi.spyOn(axios, 'get').mockImplementation(async (url, config) => {
      expect(config?.headers).toMatchObject({ Authorization: `Bearer ${bobToken}` });
      if (url === 'https://source-home.test/v1/account/encryption') return { status: 200, data: { mode: 'plain', updatedAt: 1 } };
      expect(url).toBe(`https://source-home.test/v1/artifacts/${artifactId}`);
      if (retireAfterRead) current = false;
      return { status: 200, data: { id: artifactId, ownerAccountId: 'bob', access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ kind: 'widget-area-layout.v1' }),
        body: encodePlainArtifactStoredContent({ body: '{}' }), dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
        headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 } };
    });
    const write = vi.spyOn(axios, 'request').mockImplementation(async request => {
      expect(request.headers).toMatchObject({ 'x-requester-proof': 'bob' });
      expect(request.headers).not.toHaveProperty('Authorization');
      return { status: 200, data: { ok: true, source, canManage: true } };
    });
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'original-proof', binding: {
      accountId: 'bob', authentication: { kind: 'account', tokenEpoch: 1 }, serverIdentityId: 'source-home-identity',
      machineId: 'source-machine', custodianAccountId: 'source-account', installationId: 'source-installation',
      actionId: 'projects.sources.update', requestId: 'source-request', requestEnvelopeDigest: 'A'.repeat(43),
      target: { kind: 'session', sessionId: 'source-session' }, accountEncryptionMode: 'plain',
    } });
    Object.defineProperty(authorization, 'requesterAccountProjection', { value: { accountId: 'bob', serverId: 'source-home',
      accountEncryptionMode: 'plain', projectAccountRowCipher: createProjectAccountRowCipherV1({ mode: 'plain', material: null,
        randomBytes: n => new Uint8Array(n) }), isCurrent: async () => current,
      readArtifact: async (ref: { serverId: string; artifactId: string }, options?: { signal?: AbortSignal }) => {
        if (ref.serverId !== 'source-home') return null;
        const artifact = await runWithServerHttpBaseUrl('https://source-home.test', () => artifacts.read(ref.artifactId, { ...options, includeSharedAudience: false }));
        return artifact ? { artifactId: artifact.artifactId, header: artifact.header } : null;
      } } });
    Object.defineProperty(authorization, 'requesterHttpProjection', { value: { accountId: 'bob', serverId: 'source-home',
      serverIdentityId: 'source-home-identity', serverHttpBaseUrl: 'https://source-home.test', accountEncryptionMode: 'plain',
      isCurrent: async () => current, createRequestHeaders: async () => current ? { 'x-requester-proof': 'bob' } : null } });
    const input = { serverId: 'source-home', sourceId: source.id, expectedRevision: 2,
      patch: { attachment: { kind: 'attach' as const, attachment: { purpose: 'dashboard' as const,
        ref: { kind: 'doc' as const, artifactId, serverId: 'source-home' } } } } };
    const context = { externalActionExecutionAuthorization: authorization };
    const accepted = await deps().projectSourcesUpdate!(input, context);
    expect(accepted, JSON.stringify(accepted)).toMatchObject({ ok: true, canManage: true });
    write.mockClear(); read.mockClear();
    expect(await deps().projectSourcesUpdate!({ ...input, patch: { attachment: { ...input.patch.attachment,
      attachment: { ...input.patch.attachment.attachment, ref: { ...input.patch.attachment.attachment.ref, serverId: 'foreign-home' } } } } }, context))
      .toEqual({ ok: false, error: 'artifact_unavailable' });
    expect(read).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
    retireAfterRead = true;
    expect(await deps().projectSourcesUpdate!(input, context)).toEqual({ ok: false, error: 'artifact_unavailable' });
    expect(write).not.toHaveBeenCalled();
  });

  it('uses admitted foreign requester signatures for metadata without a custodian credential or Artifact fallback', async () => {
    const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
    const target = { kind: 'session' as const, sessionId: 'source-session' };
    const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'signed-requester-authorization', binding: {
      accountId: 'foreign-requester', principalId: 'foreign-requester', credentialId: 'requester-token', grant: API_TOKEN_FULL_GRANT_V1,
      serverIdentityId: 'source-home-identity', machineId: 'source-machine', custodianAccountId: 'source-account',
      installationId: 'source-installation', actionId: 'projects.sources.read', requestId: 'source-request',
      requestEnvelopeDigest: 'A'.repeat(43), target,
    } });
    const owner = createCliActionDeps({ token, credentials: { token, encryption: null }, sessionId: 'source-session',
      mode: 'plain', ctx: null, serverId: 'source-home', serverHttpBaseUrl: 'https://source-home.test',
      serverIdentityId: 'source-home-identity', externalActionMachineRequestPrivateKey: keys.secretKey,
      externalActionMachineInstallationId: 'source-installation' });
    const request = vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { ok: true, source, canManage: false } });
    const artifactRead = vi.spyOn(axios, 'get');
    const context = { externalActionExecutionAuthorization: authorization, externalActionTarget: target };
    const input = { serverId: 'source-home', sourceId: source.id };
    expect(await owner.projectSourcesRead!(input, context)).toEqual({ ok: true, source, canManage: false });
    const headers = request.mock.calls[0]?.[0].headers;
    expect(headers).toMatchObject({ [EXTERNAL_ACTION_EXECUTION_AUTHORIZATION_HEADER]: authorization.token,
      [EXTERNAL_ACTION_EFFECT_ACTION_HEADER]: 'projects.sources.read' });
    expect(headers).not.toHaveProperty('Authorization');
    expect(verifyExternalActionMachineRequestV1({ authorizationToken: authorization.token, effectActionId: 'projects.sources.read',
      target, installationId: 'source-installation', requestId: authorization.binding.requestId, method: 'GET',
      path: '/v1/projects/sources/source%2Fa?serverId=source-home',
      signature: String(headers?.[EXTERNAL_ACTION_MACHINE_SIGNATURE_HEADER] ?? ''), publicKey: keys.publicKey })).toBe(true);
    request.mockClear();
    expect(await owner.projectSourcesRead!(input, { externalActionCredential: {
      accountId: 'foreign-requester', principalId: 'foreign-requester', credentialId: 'requester-token', grant: API_TOKEN_FULL_GRANT_V1,
    } })).toMatchObject({ ok: false, errorCode: 'project_requester_authority_unavailable' });
    expect(await owner.projectSourcesRead!(input, { ...context, externalActionExecutionAuthorization: {
      ...authorization, binding: { ...authorization.binding, serverIdentityId: 'another-home-identity' },
    } })).toMatchObject({ ok: false, errorCode: 'project_requester_authority_unavailable' });
    expect(await owner.projectSourcesUpdate!({ ...input, expectedRevision: 2, patch: { attachment: {
      kind: 'attach', attachment: { purpose: 'dashboard', ref: { kind: 'doc', artifactId: 'dashboard', serverId: 'source-home' } },
    } } }, { ...context, externalActionExecutionAuthorization: { ...authorization,
      binding: { ...authorization.binding, actionId: 'projects.sources.update' } } })).toEqual({ ok: false, error: 'artifact_unavailable' });
    expect(request).not.toHaveBeenCalled();
    expect(artifactRead).not.toHaveBeenCalled();
  });

  it('exposes all five ports and keeps current management, acknowledged creation and metadata-only deletion results', async () => {
    const request = vi.spyOn(axios, 'request').mockResolvedValueOnce({ status: 200, data: { ok: true, source, canManage: false } })
      .mockResolvedValueOnce({ status: 201, data: { ok: true, source, canManage: true } })
      .mockResolvedValueOnce({ status: 200, data: { ok: true, sourceId: source.id, revision: 3 } });
    const owner = deps();
    expect(await owner.projectSourcesRead!({ serverId: 'source-home', sourceId: source.id }, {})).toEqual({ ok: true, source, canManage: false });
    expect(await owner.projectSourcesCreate!({ serverId: 'source-home', requestKey: 'create-app', name: source.name, repository: source.repository }, {})).toEqual({ ok: true, source, canManage: true });
    expect(await owner.projectSourcesDelete!({ serverId: 'source-home', sourceId: source.id, expectedRevision: 2 }, {})).toEqual({ ok: true, sourceId: source.id, revision: 3 });
    expect(request.mock.calls.map(([config]) => [config.method, config.url])).toEqual([
      ['GET', 'https://source-home.test/v1/projects/sources/source%2Fa?serverId=source-home'],
      ['POST', 'https://source-home.test/v1/projects/sources'], ['DELETE', 'https://source-home.test/v1/projects/sources/source%2Fa'],
    ]);
  });

  it('reads keyless metadata on the captured Home and preserves conflict rows from non-success HTTP', async () => {
    const request = vi.spyOn(axios, 'request').mockResolvedValueOnce({ status: 200, data: { ok: true, sources: [source], coverage: { complete: false, nextCursor: 'next' } } })
      .mockResolvedValueOnce({ status: 409, data: { ok: false, error: 'source_conflict', current: source } });
    const owner = createActionExecutor(deps());
    expect(await owner.execute('projects.sources.list', { serverId: 'source-home', query: 'app', limit: 5 }, { surface: 'cli', bypassApprovals: true }))
      .toMatchObject({ ok: true, result: { sources: [source], coverage: { complete: false, nextCursor: 'next' } } });
    expect(request.mock.calls[0]?.[0]).toMatchObject({ method: 'GET', url: 'https://source-home.test/v1/projects/sources?serverId=source-home&query=app&limit=5', headers: { Authorization: `Bearer ${token}` } });
    expect(await owner.execute('projects.sources.update', { serverId: 'source-home', sourceId: source.id, expectedRevision: 1, patch: { name: 'Changed' } }, { surface: 'agent', bypassApprovals: true }))
      .toMatchObject({ ok: true, result: { ok: false, error: 'source_conflict', current: source } });
    expect(request.mock.calls[1]?.[0]).toMatchObject({ method: 'PATCH', url: 'https://source-home.test/v1/projects/sources/source%2Fa', data: { serverId: 'source-home', expectedRevision: 1 } });
  });

  it('refuses wrong Home and foreign requester before any Account network read', async () => {
    const request = vi.spyOn(axios, 'request');
    const owner = deps();
    expect(owner.projectSourcesRead).toBeTypeOf('function');
    expect(await owner.projectSourcesRead!({ serverId: 'other-home', sourceId: source.id }, {}))
      .toMatchObject({ ok: false, errorCode: 'server_scope_mismatch' });
    expect(await owner.projectSourcesRead!({ serverId: 'source-home', sourceId: source.id }, { runtimeAccountId: 'other-account' }))
      .toMatchObject({ ok: false, errorCode: 'project_requester_authority_unavailable' });
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps mutation uncertainty after dispatch and cancels before dispatch without retry', async () => {
    const request = vi.spyOn(axios, 'request').mockRejectedValue(new Error('connection_reset'));
    const owner = deps();
    expect(owner.projectSourcesCreate).toBeTypeOf('function');
    const input = { serverId: 'source-home', requestKey: 'create-uncertain-app', name: source.name, repository: source.repository };
    expect(await owner.projectSourcesCreate!(input, {})).toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
    const controller = new AbortController(); controller.abort();
    expect(await owner.projectSourcesCreate!(input, { signal: controller.signal })).toMatchObject({ ok: false, errorCode: 'cancelled' });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('retains the caller create request key across explicit recovery without replacing it with an Action invocation id', async () => {
    const request = vi.spyOn(axios, 'request').mockRejectedValueOnce(new Error('connection_reset'))
      .mockResolvedValueOnce({ status: 200, data: { ok: true, source, canManage: true } });
    const owner = createActionExecutor(deps());
    const input = { serverId: 'source-home', requestKey: 'same-create-intent', name: source.name, repository: source.repository };
    expect(await owner.execute('projects.sources.create', input, { surface: 'cli', bypassApprovals: true, actionRequestId: 'first-invocation' }))
      .toMatchObject({ ok: false, errorCode: 'outcome_unknown' });
    expect(request).toHaveBeenCalledTimes(1);
    expect(await owner.execute('projects.sources.create', input, { surface: 'cli', bypassApprovals: true, actionRequestId: 'recovery-invocation' }))
      .toMatchObject({ ok: true, result: { source, canManage: true } });
    expect(request.mock.calls.map(([config]) => config.data)).toEqual([input, input]);
  });

  it('admits qualified foreign Artifacts without confusing same-id local rows or borrowing saved credentials for public callers', async () => {
    await withTempDir('happier-source-qualified-artifacts-', async taskHome => {
      const peers: Server[] = [];
      vi.resetModules();
      vi.stubEnv('HAPPIER_HOME_DIR', taskHome);
      for (const key of ['HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_SERVER_ID', 'HAPPIER_WEBAPP_URL']) vi.stubEnv(key, '');
      try {
        const artifactId = '11111111-1111-4111-8111-111111111111';
        const foreignToken = `header.${Buffer.from(JSON.stringify({ sub: 'source-account', aud: 'foreign-home' })).toString('base64url')}.signature`;
        // Real profile resolution, credentials and Artifact codecs run above HTTP/FS peers.
        async function home(id: string, actorToken: string) {
          const requests: string[] = [];
          let kind = 'widget-area-layout.v1';
          let status = 200;
          const peer = createServer((request, response) => {
            requests.push(request.url ?? '/');
            const allowed = request.headers.authorization === `Bearer ${actorToken}` && request.url === `/v1/artifacts/${artifactId}`;
            response.writeHead(allowed ? status : 403, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify(allowed && status === 200 ? {
              id: artifactId, ownerAccountId: 'artifact-owner', access: 'view', encryptionMode: 'plain',
              header: encodePlainArtifactStoredContent({ kind }), body: encodePlainArtifactStoredContent({ body: '{}' }),
              dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1,
            } : { error: 'forbidden' }));
          });
          peers.push(peer);
          await new Promise<void>(resolve => peer.listen(0, '127.0.0.1', resolve));
          const address = peer.address();
          if (!address || typeof address === 'string') throw new Error('HTTP fixture did not bind');
          const url = `http://127.0.0.1:${address.port}`;
          await mkdir(join(taskHome, 'servers', id), { recursive: true });
          await writeFile(join(taskHome, 'servers', id, 'access.key'), JSON.stringify({ token: actorToken }));
          return { id, url, requests, setKind: (value: string) => { kind = value; }, setStatus: (value: number) => { status = value; } };
        }
        const local = await home('source-home', token);
        const foreign = await home('foreign-home', foreignToken);
        // The explicit Source Home is not the active profile: its token must not leak into the foreign read.
        await writeFile(join(taskHome, 'settings.json'), JSON.stringify({ schemaVersion: 6, activeServerId: foreign.id,
          servers: Object.fromEntries([local, foreign].map(peer => [peer.id, { id: peer.id, name: peer.id,
            serverUrl: peer.url, webappUrl: peer.url, createdAt: 1, updatedAt: 1, lastUsedAt: 1 }])) }));
        const { default: qualifiedAxios } = await import('axios');
        const { createCliActionDeps: createQualifiedDeps } = await import('./createCliActionDeps');
        const keys = tweetnacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(9));
        const owner = createQualifiedDeps({ token, credentials: { token, encryption: null }, sessionId: 'source-session',
          mode: 'plain', ctx: null, serverId: local.id, serverHttpBaseUrl: local.url,
          serverIdentityId: 'source-home-identity', externalActionMachineRequestPrivateKey: keys.secretKey,
          externalActionMachineInstallationId: 'source-installation' });
        const write = vi.spyOn(qualifiedAxios, 'request').mockResolvedValue({ status: 200, data: { ok: true, source, canManage: true } });
        const input = { serverId: local.id, sourceId: source.id, expectedRevision: 2,
          patch: { attachment: { kind: 'attach' as const, attachment: { purpose: 'dashboard' as const,
            ref: { kind: 'doc' as const, artifactId, serverId: foreign.id } } } } };
        expect(await owner.projectSourcesUpdate!(input, {})).toMatchObject({ ok: true, canManage: true });
        expect(foreign.requests).toEqual([`/v1/artifacts/${artifactId}`]);
        expect(local.requests).toEqual([]);
        expect(write.mock.calls[0]?.[0]).toMatchObject({ method: 'PATCH', url: `${local.url}/v1/projects/sources/source%2Fa`,
          headers: { Authorization: `Bearer ${token}` }, data: input });
        write.mockClear();
        foreign.setKind('prompt_doc.v2');
        expect(await owner.projectSourcesUpdate!(input, {})).toEqual({ ok: false, error: 'artifact_wrong_kind' });
        expect(local.requests).toEqual([]);
        expect(write).not.toHaveBeenCalled();
        // The same id on the containing Home remains a distinct valid dashboard.
        expect(await owner.projectSourcesUpdate!({ ...input, patch: { attachment: { ...input.patch.attachment,
          attachment: { ...input.patch.attachment.attachment, ref: { kind: 'doc', artifactId, serverId: local.id } } } } }, {}))
          .toMatchObject({ ok: true, canManage: true });
        expect(local.requests).toEqual([`/v1/artifacts/${artifactId}`]);
        write.mockClear();
        foreign.setStatus(403);
        expect(await owner.projectSourcesUpdate!(input, {})).toEqual({ ok: false, error: 'artifact_unavailable' });
        expect(write).not.toHaveBeenCalled();
        const target = { kind: 'session' as const, sessionId: 'source-session' };
        const credential = { accountId: 'source-account', principalId: 'source-account', credentialId: 'public-token', grant: API_TOKEN_FULL_GRANT_V1 };
        const authorization = ExternalActionExecutionAuthorizationV1Schema.parse({ v: 1, token: 'signed-requester-authorization', binding: {
          ...credential, serverIdentityId: 'source-home-identity', machineId: 'source-machine', custodianAccountId: 'source-account',
          installationId: 'source-installation', actionId: 'projects.sources.update', requestId: 'source-request',
          requestEnvelopeDigest: 'A'.repeat(43), target,
        } });
        foreign.setStatus(200);
        foreign.setKind('widget-area-layout.v1');
        expect(await owner.projectSourcesUpdate!(input, { externalActionCredential: credential,
          externalActionExecutionAuthorization: authorization, externalActionTarget: target }))
          .toEqual({ ok: false, error: 'artifact_unavailable' });
        expect(await owner.projectSourcesUpdate!(input, {
          externalActionExecutionAuthorization: authorization, externalActionTarget: target }))
          .toEqual({ ok: false, error: 'artifact_unavailable' });
        expect(foreign.requests).toHaveLength(3);
        expect(write).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
        await Promise.all(peers.map(async peer => {
          peer.closeAllConnections();
          await new Promise<void>((resolve, reject) => peer.close(error => error ? reject(error) : resolve()));
        }));
      }
    });
  });

  it('reads an attached dashboard as the invoking actor and refuses inaccessible or wrong-kind Artifacts', async () => {
    const read = vi.spyOn(axios, 'get');
    const write = vi.spyOn(axios, 'request').mockResolvedValue({ status: 200, data: { ok: true, source, canManage: true } });
    const owner = deps();
    const artifactId = '11111111-1111-4111-8111-111111111111';
    const input = { serverId: 'source-home', sourceId: source.id, expectedRevision: 2,
      patch: { attachment: { kind: 'attach' as const, attachment: { purpose: 'dashboard' as const, ref: { kind: 'doc' as const, artifactId } } } } };
    const artifact = (kind: string) => ({ id: artifactId, ownerAccountId: 'other-account', access: 'view', encryptionMode: 'plain',
      header: encodePlainArtifactStoredContent({ kind }), body: encodePlainArtifactStoredContent({ body: '{}' }),
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 1, createdAt: 1, updatedAt: 1 });
    read.mockResolvedValueOnce({ status: 403, data: { error: 'forbidden' } });
    expect(await owner.projectSourcesUpdate!(input, {})).toEqual({ ok: false, error: 'artifact_unavailable' });
    read.mockResolvedValueOnce({ status: 200, data: artifact('prompt_doc.v2') });
    expect(await owner.projectSourcesUpdate!(input, {})).toEqual({ ok: false, error: 'artifact_wrong_kind' });
    expect(write).not.toHaveBeenCalled();
    read.mockResolvedValueOnce({ status: 200, data: artifact('widget-area-layout.v1') });
    expect(await owner.projectSourcesUpdate!(input, {})).toMatchObject({ ok: true, canManage: true });
    expect(read.mock.calls[0]).toMatchObject(['https://source-home.test/v1/artifacts/' + artifactId,
      { headers: { Authorization: `Bearer ${token}` } }]);
    expect(write.mock.calls[0]?.[0]).toMatchObject({ method: 'PATCH', data: input });
  });

  it('refuses an unsealed public caller rather than substituting the captured Account token', async () => {
    const request = vi.spyOn(axios, 'request');
    const artifactRead = vi.spyOn(axios, 'get');
    const owner = deps();
    const context = {
      externalActionCredential: { accountId: 'source-account', principalId: 'source-account', credentialId: 'public-token', grant: API_TOKEN_FULL_GRANT_V1 },
    };
    expect(await owner.projectSourcesRead!({ serverId: 'source-home', sourceId: source.id }, context)).toMatchObject({ ok: false, errorCode: 'project_requester_authority_unavailable' });
    expect(await owner.projectSourcesUpdate!({ serverId: 'source-home', sourceId: source.id, expectedRevision: 2,
      patch: { attachment: { kind: 'attach', attachment: { purpose: 'dashboard', ref: { kind: 'doc', artifactId: 'dashboard' } } } } }, context))
      .toMatchObject({ ok: false, errorCode: 'project_requester_authority_unavailable' });
    expect(request).not.toHaveBeenCalled();
    expect(artifactRead).not.toHaveBeenCalled();
  });
});
