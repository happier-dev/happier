import axios from 'axios';
import { afterEach, expect, it, vi } from 'vitest';
import { configuration } from '@/configuration';
import { withdrawActiveProjectAccountRowsSnapshot } from '@/workspaces/projectAccountRows';
import { createSessionProjectPromptStackPreparation, readCliProjectPromptStackContext, resolveSessionProjectPromptStack } from './sessionProjectPromptStack';
import { publishServerHttpRuntimeOrigin } from '@/api/client/serverHttpBaseUrl';
import { createPlainProjectAccountRefRow, mockProjectAccountRowsHttpBoundary } from '@/workspaces/projectAccountRows.testkit';
import type { ProjectAccountRowV1 } from '@happier-dev/protocol/projects/projectAccountRowsV1';

const endpointReleases: Array<() => void> = [];

it('reads only same-Home checkout refs and the selected current Project context, even with 1024 unrelated organizations', async () => {
  const serverId = 'remember-home';
  const key = { kind: 'workspace-ref' as const, serverId, id: 'checkout' };
  const organizationKey = { kind: 'project-organization' as const, serverId, projectKey: 'project' };
  const entry = { id: 'project.memory', ref: { kind: 'doc' as const, artifactId: 'memory' }, enabled: true, placement: 'system_append' as const };
  const rows: ProjectAccountRowV1[] = [
    { key, revision: 1, content: { t: 'plain', v: { key, value: { id: 'checkout', serverId, machineId: 'machine',
      rootPath: '/repo', createdAtMs: 1, projectKey: 'project' } } } },
    { key: organizationKey, revision: 3, content: { t: 'plain', v: { key: organizationKey, value: { promptStack: [entry] } } } },
  ];
  for (let index = 0; index < 1024; index++) {
    const unrelated = { kind: 'project-organization' as const, serverId, projectKey: `other-${index}` };
    rows.push({ key: unrelated, revision: 1, content: { t: 'plain', v: { key: unrelated, value: { label: `Other ${index}` } } } });
  }
  rows.push(createPlainProjectAccountRefRow({ id: 'foreign', serverId: 'foreign-home', machineId: 'machine',
    rootPath: '/repo', createdAtMs: 1, projectKey: 'foreign' }));
  rows.push({ key: { kind: 'relationship-graph' }, revision: 1,
    content: { t: 'plain', v: { key: { kind: 'relationship-graph' }, value: { relationships: [] } } } });
  const transport = mockProjectAccountRowsHttpBoundary(rows);
  const input = { serverId, credentials: { token: 'project-token', encryption: null },
    metadata: { workspaceId: 'checkout', projectId: 'project', path: '/repo' }, machineId: 'machine',
  };
  await expect(resolveSessionProjectPromptStack(input)).resolves.toMatchObject({ entries: [{ id: 'project.memory', ref: { serverId } }] });
  expect(transport.mock.calls.map(([, body]) => body)).toEqual([
    { kinds: ['workspace-ref'], serverId }, { key: organizationKey },
  ]);
  rows[1] = { key: organizationKey, revision: 4, content: { t: 'plain', v: { key: organizationKey,
    value: { promptStack: [{ ...entry, id: 'changed-context' }] } } } };
  await expect(resolveSessionProjectPromptStack(input)).resolves.toMatchObject({ entries: [{ id: 'changed-context' }] });
  expect(transport.mock.calls.map(([, body]) => body)).toEqual([
    { kinds: ['workspace-ref'], serverId }, { key: organizationKey },
    { kinds: ['workspace-ref'], serverId }, { key: organizationKey },
  ]);
});

afterEach(() => { vi.restoreAllMocks(); withdrawActiveProjectAccountRowsSnapshot();
  for (const release of endpointReleases.splice(0)) release(); });
it('shares one finite checkout observation while reading each selected Project context exactly once', async () => {
  const serverId = 'finite-context-home';
  const rows: ProjectAccountRowV1[] = [];
  for (const projectKey of ['one', 'two']) {
    rows.push(createPlainProjectAccountRefRow({ id: projectKey, serverId, machineId: 'machine',
      rootPath: `/${projectKey}`, projectKey, createdAtMs: 1 }));
    const key = { kind: 'project-organization' as const, serverId, projectKey };
    rows.push({ key, revision: 1, content: { t: 'plain', v: { key, value: { promptStack: [{ id: projectKey,
      ref: { kind: 'doc', artifactId: projectKey }, enabled: true, placement: 'system_append' }] } } } });
  }
  const transport = mockProjectAccountRowsHttpBoundary(rows);
  const preparation = createSessionProjectPromptStackPreparation({ credentials: { token: 'project-token', encryption: null }, serverId });
  for (const projectKey of ['one', 'two', 'one']) {
    await expect(preparation.resolve({ metadata: { workspaceId: projectKey, projectId: projectKey },
      machineId: 'machine', directory: `/${projectKey}` })).resolves.toMatchObject({ entries: [{ id: projectKey }] });
  }
  await preparation.assertCurrent();
  expect(transport.mock.calls.map(([, body]) => body)).toEqual([
    { kinds: ['workspace-ref'], serverId },
    { key: { kind: 'project-organization', serverId, projectKey: 'one' } },
    { key: { kind: 'project-organization', serverId, projectKey: 'two' } },
  ]);
});
it('refuses personal context if Account mode changes after checkout resolution', async () => {
  const serverId = 'mode-context-home';
  const transport = mockProjectAccountRowsHttpBoundary([createPlainProjectAccountRefRow({ id: 'checkout', serverId,
    machineId: 'machine', rootPath: '/repo', projectKey: 'project', createdAtMs: 1 })]);
  const boundary = transport.getMockImplementation()!;
  transport.mockImplementation(async (...args) => {
    const response = await boundary(...args);
    vi.mocked(axios.get).mockResolvedValue({ status: 200, data: { mode: 'e2ee', updatedAt: 1 } });
    return response;
  });
  await expect(resolveSessionProjectPromptStack({ credentials: { token: 'project-token', encryption: null }, serverId,
    metadata: { workspaceId: 'checkout', projectId: 'project' }, machineId: 'machine', directory: '/repo' }))
    .rejects.toMatchObject({ code: 'ACCOUNT_SETTINGS_ENCRYPTION_MATERIAL_UNAVAILABLE' });
  expect(transport.mock.calls.map(([, body]) => body)).toEqual([{ kinds: ['workspace-ref'], serverId }]);
});
it.each([false, true])('keeps named Project context selection without unrelated rows (source=%s)', async sourced => {
  const serverId = 'named-context-home';
  const key = { kind: 'project-organization' as const, serverId, projectKey: 'project' };
  const rows: ProjectAccountRowV1[] = [createPlainProjectAccountRefRow({ id: 'checkout', serverId,
    machineId: 'machine', rootPath: '/repo', projectKey: 'project', createdAtMs: 1,
    ...(sourced ? { source: { sourceId: 'source', revision: 1 } } : {}) }),
    { key, revision: 1, content: { t: 'plain', v: { key, value: { label: 'Project', promptStack: [
      { id: 'named-context', ref: { kind: 'doc', artifactId: 'named-context' }, enabled: true, placement: 'system_append' },
    ] } } } },
  ];
  for (let index = 0; index < 1024; index++) {
    const unrelated = { kind: 'project-organization' as const, serverId, projectKey: `other-${index}` };
    rows.push({ key: unrelated, revision: 1, content: { t: 'plain', v: { key: unrelated, value: {} } } });
  }
  rows.push({ key: { kind: 'relationship-graph' }, revision: 1,
    content: { t: 'plain', v: { key: { kind: 'relationship-graph' }, value: { relationships: [] } } } });
  const transport = mockProjectAccountRowsHttpBoundary(rows);
  vi.spyOn(axios, 'request').mockResolvedValue({ status: 503, data: { ok: false, error: 'source_backend_unavailable' } });
  const context = readCliProjectPromptStackContext({ credentials: { token: 'project-token', encryption: null },
    projectRef: { serverId, projectKey: 'project' } });
  if (sourced) await expect(context).rejects.toMatchObject({ code: 'project_context_unavailable' });
  else await expect(context).resolves.toMatchObject({ entries: [{ id: 'named-context', ref: { serverId } }] });
  expect(transport.mock.calls.map(([, body]) => body)).toEqual([
    { kinds: ['workspace-ref'], serverId }, ...(sourced ? [] : [{ key }]),
  ]);
});
it.each([false, true])('keeps the Source read on the captured Home endpoint during Project discovery (shared=%s)', async shared => {
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
  const input = { credentials: { token: 'project-token', encryption: null },
    metadata: { workspaceId: 'checkout', projectId: 'project', path: '/repo' }, machineId: 'machine', directory: '/repo' };
  const preparation = shared ? createSessionProjectPromptStackPreparation({ credentials: input.credentials, serverId }) : null;
  await expect(preparation ? preparation.resolve(input) : resolveSessionProjectPromptStack(input))
    .rejects.toMatchObject({ code: 'preparation_pending', reason: 'project_source_unavailable' });
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
  mockProjectAccountRowsHttpBoundary([
    { key: workspaceKey, revision: 1, content: { t: 'plain', v: { key: workspaceKey, value: workspace } } },
    { key: organizationKey, revision: 1, content: { t: 'plain', v: { key: organizationKey, value: { promptStack: [entry('personal')] } } } },
  ]);
  const source = { id: 'source', revision: 2, name: 'Current Source', createdByAccountId: 'account', audience: [],
    repository: { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
      repository: { nameWithOwner: 'owner/repo', cloneUrl: 'https://github.com/owner/repo.git', visibility: 'public' }, protocol: 'https' } };
  const sourceRead = vi.spyOn(axios, 'request').mockResolvedValueOnce({ status: 200, data: { ok: true, canManage: false, source: {
    ...source, attachments: [{ purpose: 'context', entry: entry('shared') }, { purpose: 'dashboard', ref: { kind: 'doc', artifactId: 'dashboard' } }],
  } } }).mockResolvedValueOnce({ status: 200, data: { ok: true, canManage: false, source: {
    ...source, revision: 3, attachments: [{ purpose: 'context', entry: entry('shared-new') }],
  } } });
  const input = { credentials: { token: 'project-token', encryption: null }, machineId: 'machine', directory: '/container',
    metadata: { workspaceId: 'checkout', projectId: 'project', path: '/container', work: { promptStack: [entry('lead')] },
      sessionWorkspaceLocationV1: { v: 1, machineId: 'machine', agentPath: '/container', machinePath: '/repo' } } };
  expect((await resolveSessionProjectPromptStack(input)).entries).toMatchObject([
    { id: 'shared', ref: { serverId } },
  ]);
  expect((await resolveSessionProjectPromptStack(input)).entries.map(value => value.id)).toEqual(['shared-new']);
  sourceRead.mockResolvedValue({ status: 200, data: { ok: true, canManage: false, source: {
    ...source, revision: 4, attachments: [{ purpose: 'context', entry: entry('shared-current') }],
  } } });
  const before = sourceRead.mock.calls.length;
  const rowsBefore = vi.mocked(axios.post).mock.calls.length;
  const preparation = createSessionProjectPromptStackPreparation({ credentials: input.credentials, serverId });
  for (let session = 0; session < 3; session++) {
    expect((await preparation.resolve(input)).entries.map(value => value.id)).toEqual(['shared-current']);
  }
  await preparation.assertCurrent();
  // Same finite union, one authenticated refs read and one Source read. A later
  // preparation must reobserve access rather than borrowing this result.
  expect(sourceRead.mock.calls.length - before).toBe(1);
  expect(vi.mocked(axios.post).mock.calls.length - rowsBefore).toBe(1);
  expect(vi.mocked(axios.post).mock.calls.map(([, body]) => body)).toEqual([
    { kinds: ['workspace-ref'], serverId }, { kinds: ['workspace-ref'], serverId }, { kinds: ['workspace-ref'], serverId },
  ]);
  sourceRead.mockResolvedValue({ status: 403, data: { ok: false, error: 'permission_denied' } });
  const next = createSessionProjectPromptStackPreparation({ credentials: input.credentials, serverId });
  await expect(next.resolve(input)).rejects.toMatchObject({ code: 'preparation_pending', reason: 'project_source_unavailable' });
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
    metadata: { projectId: 'project', path: '/different' }, machineId: 'machine', directory: '/different',
  })).rejects.toMatchObject({ code: 'preparation_pending', reason: 'project_association_unavailable' });
});
