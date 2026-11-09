import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { withdrawActiveProjectAccountRowsSnapshot } from './projectAccountRows';
import { resolveSessionProjectKey } from './resolveSessionProjectKey';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { reloadConfiguration } from '@/configuration';
import { addServerProfile, adoptServerProfileHomeConnectionDescriptor } from '@/server/serverProfiles';
import { buildCommittedLaunchMetadata } from '@/agent/runtime/createSessionMetadata';
import { createPlainProjectAccountRefRow, mockProjectAccountRowsHttpBoundary } from './projectAccountRows.testkit';

const serverId = 'association-home';
const input = { credentials: { token: 'association-token', encryption: null }, serverId, machineId: 'machine', directory: '/repo',
  metadata: { workspaceId: 'checkout', projectId: 'project', path: '/repo' } };
const workspaceRef = { id: 'checkout', serverId, machineId: 'machine', rootPath: '/repo', projectKey: 'project', createdAtMs: 1 };
function readRows(refs = [workspaceRef]) {
  return mockProjectAccountRowsHttpBoundary(refs.map(ref => createPlainProjectAccountRefRow(ref, 1)));
}
afterEach(() => { vi.restoreAllMocks(); withdrawActiveProjectAccountRowsSnapshot(); });
it('resolves the exact Account workspace reference and Project key', async () => {
  readRows();
  await expect(resolveSessionProjectKey(input)).resolves.toMatchObject({ kind: 'resolved', projectKey: 'project', workspaceRef });
});
it('retains an explicit accepted checkout for subdirectory births and changed sandbox paths', async () => {
  readRows();
  await expect(resolveSessionProjectKey({ ...input, machineId: 'sandbox', directory: '/container/subdir' }))
    .resolves.toMatchObject({ kind: 'resolved', projectKey: 'project', workspaceRef });
});
it('checks a legacy Project marker against the accepted exact-directory ref instead of treating the marker as authority', async () => {
  readRows();
  await expect(resolveSessionProjectKey({ ...input, metadata: { projectId: 'project' } }))
    .resolves.toMatchObject({ kind: 'resolved', projectKey: 'project', workspaceRef });
  await expect(resolveSessionProjectKey({ ...input, directory: undefined, metadata: { projectId: 'project' } }))
    .resolves.toEqual({ kind: 'pending', reason: 'project_association_unavailable' });
});
it('resolves a directory-only Session through its exact Account checkout', async () => {
  readRows();
  const metadata = buildCommittedLaunchMetadata({ directory: '/repo', options: { directory: '/repo', machineId: 'machine', memoryEnabled: true } });
  expect(metadata).not.toHaveProperty('workspaceId');
  expect(metadata).not.toHaveProperty('projectId');
  await expect(resolveSessionProjectKey({ ...input, metadata })).resolves.toMatchObject({
    kind: 'resolved', projectKey: 'project', workspaceRef,
  });
});
it('resolves the local Home profile to the portable Account checkout identity', async () => {
  await withTempDir('happier-session-project-home-', async home => {
    const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
    env.patch({ HAPPIER_HOME_DIR: home, HAPPIER_ACTIVE_SERVER_ID: undefined, HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined });
    reloadConfiguration();
    try {
      const profile = await addServerProfile({ name: 'local-project-profile', serverUrl: 'https://project-home.example.test',
        webappUrl: 'https://project-home.example.test', use: true });
      const homeId = 'srv_sessionctx_home';
      await adoptServerProfileHomeConnectionDescriptor({ expectedProfileId: profile.id, observation: 'exact', descriptor: {
        v: 1, homeServerIdentityId: homeId, canonicalServerUrl: profile.serverUrl, revision: 1,
        endpoints: [{ kind: 'https', url: profile.serverUrl }],
      } });
      const ref = { ...workspaceRef, serverId: homeId };
      readRows([ref]);
      for (const metadata of [input.metadata, { path: '/repo' }]) {
        await expect(resolveSessionProjectKey({ ...input, serverId: profile.id, metadata })).resolves.toMatchObject({
          kind: 'resolved', projectKey: 'project', workspaceRef: ref,
        });
      }
    } finally { env.restore(); reloadConfiguration(); }
  });
});
it.each(['/repo/child', '/repo-sibling', '/outside'])('does not invent an association by containment: %s', async directory => {
  readRows();
  await expect(resolveSessionProjectKey({ ...input, directory, metadata: {} })).resolves.toEqual({ kind: 'none' });
});
it('uses the platform-aware exact-root owner for Windows spelling and rejects sibling prefixes', async () => {
  readRows([{ ...workspaceRef, rootPath: 'C:\\Work\\Repo' }]);
  await expect(resolveSessionProjectKey({ ...input, directory: 'c:/work/repo/', metadata: {} })).resolves.toMatchObject({
    kind: 'resolved', projectKey: 'project',
  });
  await expect(resolveSessionProjectKey({ ...input, directory: 'c:/work/repo2', metadata: {} })).resolves.toEqual({ kind: 'none' });
});
it('returns none without a directory or association without reading the Account', async () => {
  const request = readRows();
  await expect(resolveSessionProjectKey({ ...input, directory: undefined, metadata: {} })).resolves.toEqual({ kind: 'none' });
  expect(request).not.toHaveBeenCalled();
});
it('keeps an ambiguous exact-checkout association pending', async () => {
  readRows([workspaceRef, { ...workspaceRef, id: 'second-checkout' }]);
  await expect(resolveSessionProjectKey({ ...input, metadata: {} })).resolves.toEqual({
    kind: 'pending', reason: 'project_association_unavailable',
  });
});
it.each([{ workspaceId: 'checkout', projectId: 'other' },
  { workspaceId: 'missing', projectId: 'project' }])('keeps incomplete or mismatched association pending: %j', async metadata => {
  readRows();
  await expect(resolveSessionProjectKey({ ...input, metadata })).resolves.toEqual({ kind: 'pending', reason: 'project_association_unavailable' });
});
it('does not treat an unreadable Account association as none', async () => {
  readRows().mockRejectedValue(new Error('network_unavailable'));
  await expect(resolveSessionProjectKey(input)).resolves.toEqual({ kind: 'pending', reason: 'project_association_unavailable' });
});
it.each([
  [503, 'preparation_pending', 'unavailable', true],
  [403, 'attachment_unavailable', 'locked', false],
] as const)('preserves Home read classification instead of hiding HTTP %s as association ambiguity', async (status, code, reason, retryable) => {
  readRows().mockResolvedValue({ status, data: { error: 'PRIVATE_RESPONSE' } });
  await expect(resolveSessionProjectKey(input)).rejects.toMatchObject({
    code, reason, cause: { classification: { statusCode: status, retryable } },
  });
});
it('keeps a timed-out Home association read in the existing retryable preparation path', async () => {
  readRows().mockRejectedValue(Object.assign(new Error('private HTTP request'), { code: 'ECONNABORTED' }));
  await expect(resolveSessionProjectKey(input)).rejects.toMatchObject({
    code: 'preparation_pending', reason: 'unavailable', cause: { classification: { retryable: true } },
  });
});
it('preserves cancellation rather than converting it to pending', async () => {
  const controller = new AbortController();
  const reason = new Error('cancelled');
  readRows().mockImplementation(async () => { controller.abort(reason); throw reason; });
  await expect(resolveSessionProjectKey({ ...input, signal: controller.signal })).rejects.toBe(reason);
});
