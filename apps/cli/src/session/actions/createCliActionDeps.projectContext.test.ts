import axios from 'axios';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { API_TOKEN_FULL_GRANT_V1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import { ProjectAccountRowMutationRequestV1Schema, type ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';
import { createTempDir, removeTempDir } from '@/testkit/fs/tempDir';
import { createCliActionDeps } from './createCliActionDeps';
import { reloadConfiguration } from '@/configuration';

let taskHome: string;
beforeEach(async () => {
  taskHome = await createTempDir('happier-project-context-');
  vi.stubEnv('HAPPIER_HOME_DIR', taskHome);
  for (const key of ['HAPPIER_SERVER_URL', 'HAPPIER_LOCAL_SERVER_URL', 'HAPPIER_SERVER_ID', 'HAPPIER_WEBAPP_URL']) vi.stubEnv(key, '');
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); reloadConfiguration(); await removeTempDir(taskHome); });
const token = (accountId: string) => `header.${Buffer.from(JSON.stringify({ sub: accountId })).toString('base64url')}.signature`;

describe('CLI personal context qualified Artifact transport', () => {
  it('reads a foreign attachment with its own saved Home authority and never lends it to delegated provenance', async () => {
    const homeToken = token('account-a');
    const foreignToken = token('account-b');
    const homes = [{ id: 'home-a', url: 'https://context-home-a.test', token: homeToken },
      { id: 'home-b', url: 'https://context-home-b.test', token: foreignToken }];
    for (const home of homes) {
      await mkdir(join(taskHome, 'servers', home.id), { recursive: true });
      await writeFile(join(taskHome, 'servers', home.id, 'access.key'), JSON.stringify({ token: home.token }));
    }
    await writeFile(join(taskHome, 'settings.json'), JSON.stringify({ schemaVersion: 6, activeServerId: 'home-b',
      servers: Object.fromEntries(homes.map(home => [home.id, { id: home.id, name: home.id, serverUrl: home.url,
        webappUrl: home.url, createdAt: 1, updatedAt: 1, lastUsedAt: 1 }])) }));
    reloadConfiguration();
    const key = { kind: 'project-organization' as const, serverId: 'home-a', projectKey: 'anchor' };
    let row: ProjectAccountRowV1 = { key, revision: 3, content: { t: 'plain', v: { key, value: { hidden: true, pinned: true } } } };
    let writes = 0;
    const artifactRequests: Readonly<{ url: string; token: unknown }>[] = [];
    // HTTP is the boundary: saved Home selection, credential reads, Account mode,
    // Artifact decoding, semantic admission and organization CAS remain real.
    vi.spyOn(axios, 'get').mockImplementation(async (url, options) => {
      if (String(url).endsWith('/v1/account/encryption')) return { status: 200, data: { mode: 'plain', updatedAt: 0 } };
      artifactRequests.push({ url: String(url), token: options?.headers?.Authorization });
      if (String(url) !== 'https://context-home-b.test/v1/artifacts/doc' || options?.headers?.Authorization !== `Bearer ${foreignToken}`) throw new Error('Wrong Artifact authority');
      return { status: 200, data: { id: 'doc', ownerAccountId: 'account-b', access: 'owner', encryptionMode: 'plain',
        header: encodePlainArtifactStoredContent({ v: 1, kind: 'prompt_doc.v2', title: 'Foreign instructions' }),
        body: encodePlainArtifactStoredContent({ body: JSON.stringify({ v: 1, markdown: 'Instructions', createdAtMs: 0, updatedAtMs: 0 }) }),
        dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER, headerVersion: 1, bodyVersion: 1, seq: 0, createdAt: 0, updatedAt: 0 } };
    });
    vi.spyOn(axios, 'post').mockImplementation(async (url, body, options) => {
      expect(String(url)).toMatch(/^https:\/\/context-home-a\.test\/v1\/account\/project-rows\/(list|mutate)$/);
      expect(options?.headers?.Authorization).toBe(`Bearer ${homeToken}`);
      if (String(url).endsWith('/list')) return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [row] } };
      const mutation = ProjectAccountRowMutationRequestV1Schema.parse(body).mutations[0]!;
      expect(mutation.expectedRevision).toBe(row.revision);
      row = { key, revision: row.revision + 1, content: mutation.content }; writes++;
      return { status: 200, data: { status: 'updated', rows: [row], cursor: row.revision } };
    });
    const action = createCliActionDeps({ token: homeToken, credentials: { token: homeToken, encryption: null },
      serverId: 'home-a', serverHttpBaseUrl: homes[0]!.url, sessionId: 'session-a', mode: 'plain', ctx: null }).projectsContextUpdate!;
    const input = { target: { serverId: 'home-a', projectKey: 'anchor' }, expectedRevision: 3,
      intent: { kind: 'attach' as const, entry: { id: 'new', enabled: true, placement: 'system_append' as const,
        ref: { kind: 'doc' as const, artifactId: 'doc', serverId: 'home-b' } } } };
    expect(await action(input, { externalActionCredential: { accountId: 'account-a', principalId: 'principal',
      credentialId: 'credential', grant: API_TOKEN_FULL_GRANT_V1 } })).toEqual({ ok: false, errorCode: 'project_context_access_denied' });
    expect(await action(input, { externalActionExecutionAuthorization: { v: 1, token: 'signed-request', binding: {
      accountId: 'account-a', custodianAccountId: 'account-a', principalId: 'principal', credentialId: 'credential',
      grant: API_TOKEN_FULL_GRANT_V1, serverIdentityId: 'home-a-identity', machineId: 'machine-a', installationId: 'installation-a',
      actionId: 'projects.context.update', requestId: 'request-a', requestEnvelopeDigest: 'a'.repeat(43),
      target: { kind: 'machine', machineId: 'machine-a' },
    } } })).toEqual({ ok: false, errorCode: 'project_context_access_denied' });
    expect(artifactRequests).toEqual([]);
    expect(writes).toBe(0);
    expect(await action(input, { surface: 'cli' })).toMatchObject({ ok: true, revision: 4,
      row: { hidden: true, pinned: true, promptStack: [{ id: 'new', ref: { serverId: 'home-b', artifactId: 'doc' } }] } });
    expect(artifactRequests).toEqual([{ url: 'https://context-home-b.test/v1/artifacts/doc', token: `Bearer ${foreignToken}` }]);
    expect(writes).toBe(1);
  });
});
