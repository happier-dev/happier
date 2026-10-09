import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { configuration } from '@/configuration';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { resolveSessionProjectPromptStack } from './sessionProjectPromptStack';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';

const endpointReleases: Array<() => void> = [];

it('resolves Project association on the supplied exact Home rather than the active Home', async () => {
  const serverId = 'remember-home';
  const key = { kind: 'workspace-ref', serverId, id: 'checkout' };
  const organizationKey = { kind: 'project-organization', serverId, projectKey: 'project' };
  const entry = { id: 'project.memory', ref: { kind: 'doc', artifactId: 'memory' }, enabled: true, placement: 'system_append' };
  vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 0 } });
  vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete', rows: [
    { key, revision: 1, content: { t: 'plain', v: { key, value: { id: 'checkout', serverId, machineId: 'machine',
      rootPath: '/repo', createdAtMs: 1, projectKey: 'project' } } } },
    { key: organizationKey, revision: 3, content: { t: 'plain', v: { key: organizationKey, value: { promptStack: [entry] } } } },
  ] } });
  await expect(resolveSessionProjectPromptStack({ serverId, credentials: { token: 'project-token', encryption: null },
    metadata: { workspaceId: 'checkout', projectId: 'project', path: '/repo' }, machineId: 'machine',
  })).resolves.toMatchObject([{ id: 'project.memory', ref: { serverId } }]);
});

afterEach(() => { vi.restoreAllMocks(); withdrawActiveProjectAccountRowsSnapshot();
  for (const release of endpointReleases.splice(0)) release(); });
it('keeps the Source read on the captured Home endpoint when runtime publication changes during Project discovery', async () => {
  const serverId = configuration.activeServerId;
  endpointReleases.push(publishServerHttpRuntimeOrigin('http://captured-home.invalid', 'https'));
  const workspaceKey = { kind: 'workspace-ref', serverId, id: 'checkout' };
  const workspace = { id: 'checkout', serverId, machineId: 'machine', rootPath: '/repo', createdAtMs: 1,
    projectKey: 'project', source: { sourceId: 'source', revision: 1 } };
  vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 0 } });
  vi.spyOn(axios, 'post').mockImplementation(async () => {
    endpointReleases.push(publishServerHttpRuntimeOrigin('http://replacement-home.invalid', 'https'));
    return { status: 200, data: { status: 'listed', coverage: 'complete', rows: [
      { key: workspaceKey, revision: 1, content: { t: 'plain', v: { key: workspaceKey, value: workspace } } },
    ] } };
  });
  const sourceRead = vi.spyOn(axios, 'request').mockResolvedValue({ status: 503,
    data: { ok: false, error: 'source_backend_unavailable' } });
  await expect(resolveSessionProjectPromptStack({ credentials: { token: 'project-token', encryption: null },
    metadata: { workspaceId: 'checkout', projectId: 'project', path: '/repo' }, machineId: 'machine', directory: '/repo',
  })).rejects.toMatchObject({ code: 'preparation_pending', reason: 'project_source_unavailable' });
  expect(sourceRead.mock.calls[0]?.[0]).toMatchObject({
    url: `http://captured-home.invalid/v1/projects/sources/source?serverId=${encodeURIComponent(serverId)}`,
  });
});
it('uses only current Source context for a Source-backed Project and retains the personal row without projecting it', async () => {
  const serverId = configuration.activeServerId;
  const workspace = { id: 'checkout', serverId, machineId: 'machine', rootPath: '/repo', createdAtMs: 1,
    projectKey: 'project', source: { sourceId: 'source', revision: 1 } };
  const workspaceKey = { kind: 'workspace-ref', serverId, id: workspace.id };
  const organizationKey = { kind: 'project-organization', serverId, projectKey: 'project' };
  const entry = (id: string) => ({ id, ref: { kind: 'doc', artifactId: id }, enabled: true, placement: 'system_append' });
  vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 0 } });
  vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete', rows: [
    { key: workspaceKey, revision: 1, content: { t: 'plain', v: { key: workspaceKey, value: workspace } } },
    { key: organizationKey, revision: 1, content: { t: 'plain', v: { key: organizationKey, value: { promptStack: [entry('personal')] } } } },
  ] } });
  const source = { id: 'source', revision: 2, name: 'Current Source', createdByAccountId: 'account', audience: [],
    repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
      repository: { nameWithOwner: 'owner/repo', cloneUrl: 'https://github.com/owner/repo.git', visibility: 'public' }, protocol: 'https' } };
  vi.spyOn(axios, 'request').mockResolvedValueOnce({ status: 200, data: { ok: true, canManage: false, source: {
    ...source, attachments: [{ purpose: 'context', entry: entry('shared') }, { purpose: 'dashboard', ref: { kind: 'doc', artifactId: 'dashboard' } }],
  } } }).mockResolvedValueOnce({ status: 200, data: { ok: true, canManage: false, source: {
    ...source, revision: 3, attachments: [{ purpose: 'context', entry: entry('shared-new') }],
  } } });
  const input = { credentials: { token: 'project-token', encryption: null }, machineId: 'machine', directory: '/container',
    metadata: { workspaceId: 'checkout', projectId: 'project', path: '/container', work: { promptStack: [entry('lead')] },
      sessionWorkspaceLocationV1: { v: 1, machineId: 'machine', agentPath: '/container', machinePath: '/repo' } } };
  expect(await resolveSessionProjectPromptStack(input)).toMatchObject([
    { id: 'shared', ref: { serverId } },
  ]);
  expect((await resolveSessionProjectPromptStack(input)).map(value => value.id)).toEqual(['shared-new']);
});
it('reads only the exact current Project association and reports unavailable Source rather than omitting its context', async () => {
  const serverId = configuration.activeServerId;
  const workspace = { id: 'checkout', serverId, machineId: 'machine', rootPath: '/repo', createdAtMs: 1,
    projectKey: 'project', source: { sourceId: 'source', revision: 1 } };
  const key = { kind: 'workspace-ref', serverId, id: workspace.id };
  vi.spyOn(axios, 'get').mockResolvedValue({ status: 200, data: { mode: 'plain', updatedAt: 0 } });
  vi.spyOn(axios, 'post').mockResolvedValue({ status: 200, data: { status: 'listed', coverage: 'complete', rows: [
    { key, revision: 1, content: { t: 'plain', v: { key, value: workspace } } },
  ] } });
  const sourceRead = vi.spyOn(axios, 'request').mockResolvedValue({ status: 503, data: { ok: false, error: 'source_backend_unavailable' } });
  await expect(resolveSessionProjectPromptStack({ credentials: { token: 'project-token', encryption: null },
    metadata: { workspaceId: 'checkout', projectId: 'project', path: '/repo' }, machineId: 'machine', directory: '/repo',
  })).rejects.toMatchObject({ code: 'preparation_pending', reason: 'project_source_unavailable' });
  expect(sourceRead.mock.calls[0]?.[0]).toMatchObject({ method: 'GET' });
  await expect(resolveSessionProjectPromptStack({ credentials: { token: 'project-token', encryption: null },
    metadata: { workspaceId: 'checkout', projectId: 'project', path: '/different' }, machineId: 'machine', directory: '/different',
  })).rejects.toMatchObject({ code: 'preparation_pending', reason: 'project_association_unavailable' });
});
