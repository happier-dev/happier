import { afterEach, expect, it, vi } from 'vitest';
import { GITLAB_PLUGIN } from './manifest.js';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';

const provider = { id: `${GITLAB_PLUGIN.manifest.id}/gitlab`, kind: 'gitlab' as const, displayName: 'GitLab',
  baseUrl: 'https://forge.example.test/GitLab' };
const runtimeServices = { resolveScmHostingTokenMaterialization: async () => ({ kind: 'available' as const, token: 'bound-token' }) };
afterEach(() => vi.unstubAllGlobals());

it('registers GitLab publishing through the declared capability', async () => {
  const operations = GITLAB_PLUGIN.manifest.contributes.scmHostingProviders[0]?.operationActions;
  expect(operations).toMatchObject({ describePublishTargets: expect.any(String), createRepository: expect.any(String), getRepository: expect.any(String) });
  const kit = await createPluginTestkit({ manifest: GITLAB_PLUGIN.manifest, module: { activate: GITLAB_PLUGIN.activate } });
  try {
    const registration = kit.registration('scmHostingProviders', 'gitlab');
    expect(registration?.adapter.repositoryPublishing).toBeDefined();
  } finally { await kit.dispose(); }
});

async function publishing() {
  const kit = await createPluginTestkit({ manifest: GITLAB_PLUGIN.manifest, module: { activate: GITLAB_PLUGIN.activate } });
  const adapter = kit.registration('scmHostingProviders', 'gitlab')?.adapter.repositoryPublishing;
  if (!adapter) { await kit.dispose(); throw new Error('GitLab publishing capability missing'); }
  return { adapter, dispose: () => kit.dispose() };
}
const project = { path_with_namespace: 'alice/app', web_url: `${provider.baseUrl}/alice/app`,
  http_url_to_repo: `${provider.baseUrl}/alice/app.git`, ssh_url_to_repo: 'git@forge.example.test:alice/app.git',
  visibility: 'private', default_branch: null };

it.each(['https://gitlab.com', provider.baseUrl])('creates in the personal namespace on %s without a namespace override', async baseUrl => {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe(`${baseUrl}/api/v4/projects`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(new TextDecoder().decode(init.body as Uint8Array))).toEqual({ name: 'app', path: 'app', visibility: 'private' });
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer bound-token');
    return Response.json(project, { status: 201 });
  });
  vi.stubGlobal('fetch', fetcher);
  const kit = await publishing();
  try {
    await expect(kit.adapter.createRepository({ provider: { ...provider, baseUrl }, runtimeServices,
      owner: 'alice', ownerKind: 'user', repositoryName: 'app', visibility: 'private' }))
      .resolves.toMatchObject({ nameWithOwner: 'alice/app', visibility: 'private', defaultBranch: null });
  } finally { await kit.dispose(); }
});

it.each(['org', undefined] as const)('resolves a subgroup namespace id and preserves visibility and description (ownerKind=%s)', async ownerKind => {
  const fetcher = vi.fn(async (url: string, init: RequestInit) => {
    if (init.method === 'GET') {
      expect(url).toBe(`${provider.baseUrl}/api/v4/namespaces/team%2Fnested`);
      return Response.json({ id: 42, kind: 'group', full_path: 'team/nested' });
    }
    expect(JSON.parse(new TextDecoder().decode(init.body as Uint8Array))).toEqual({ name: 'app', path: 'app', namespace_id: 42,
      visibility: 'public', description: 'Example' });
    return Response.json({ ...project, path_with_namespace: 'team/nested/app', visibility: 'public' }, { status: 201 });
  });
  vi.stubGlobal('fetch', fetcher);
  const kit = await publishing();
  try {
    await expect(kit.adapter.createRepository({ provider, runtimeServices, owner: 'team/nested', ownerKind,
      repositoryName: 'app', visibility: 'public', description: 'Example' })).resolves.toMatchObject({ nameWithOwner: 'team/nested/app', visibility: 'public' });
  } finally { await kit.dispose(); }
});

it('returns a typed permission refusal and does not replay a rejected creation', async () => {
  const fetcher = vi.fn(async () => Response.json({ message: 'Forbidden' }, { status: 403 }));
  vi.stubGlobal('fetch', fetcher);
  const kit = await publishing();
  try {
    await expect(kit.adapter.createRepository({ provider, runtimeServices, owner: 'alice', ownerKind: 'user',
      repositoryName: 'app', visibility: 'private' })).rejects.toMatchObject({ errorCode: 'REMOTE_AUTH_REQUIRED', effectNotApplied: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
  } finally { await kit.dispose(); }
});

it('enumerates personal and subgroup publish targets over every namespace page', async () => {
  const next = `${provider.baseUrl}/api/v4/namespaces?page=2`;
  vi.stubGlobal('fetch', async (url: string) => url.endsWith('/user') ? Response.json({ username: 'alice' })
    : url === next ? Response.json([{ id: 42, kind: 'group', full_path: 'team/nested' }])
    : Response.json([{ id: 1, kind: 'user', full_path: 'alice' }], { headers: { Link: `<${next}>; rel="next"` } }));
  const kit = await publishing();
  try {
    await expect(kit.adapter.describePublishTargets({ provider, runtimeServices, defaultRepositoryName: 'app' })).resolves.toMatchObject({
      auth: { state: 'authenticated', profileKind: 'connected_account' },
      targets: [{ owner: 'alice', ownerKind: 'user', isDefault: true }, { owner: 'team/nested', ownerKind: 'org' }],
    });
  } finally { await kit.dispose(); }
});

it('reads an existing repository and maps provider not-found to null for publish recovery', async () => {
  const fetcher = vi.fn(async () => Response.json(project));
  vi.stubGlobal('fetch', fetcher);
  const kit = await publishing();
  try {
    await expect(kit.adapter.getRepository({ provider, runtimeServices, owner: 'alice', repositoryName: 'app' }))
      .resolves.toMatchObject({ nameWithOwner: 'alice/app', cloneUrl: project.http_url_to_repo });
    fetcher.mockImplementation(async () => Response.json({ message: 'Not found' }, { status: 404 }));
    await expect(kit.adapter.getRepository({ provider, runtimeServices, owner: 'alice', repositoryName: 'app' })).resolves.toBeNull();
  } finally { await kit.dispose(); }
});

it.each([500, 201])('keeps an uncertain create outcome recoverable (%s)', async status => {
  vi.stubGlobal('fetch', async () => new Response(status === 201 ? 'unreadable JSON' : '{}', { status }));
  const kit = await publishing();
  try {
    await expect(kit.adapter.createRepository({ provider, runtimeServices, owner: 'alice', ownerKind: 'user',
      repositoryName: 'app', visibility: 'private' })).rejects.toMatchObject({ effectNotApplied: false });
  } finally { await kit.dispose(); }
});
