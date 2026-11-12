import { describe, expect, it, vi } from 'vitest';
import { createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { PluginActionContributionV2Schema, pluginActionRequiresPresentUserIntent } from '@happier-dev/protocol';
import { GITHUB_HOSTING_OPERATION_ACTION_IDS_V1 } from '../actions/hostingActionIds.js';
import { activate, activateAccount } from '../activate.js';
import { PLUGIN_MANIFEST } from '../manifest.js';
import { ForgeReleaseActionResultSchemasV1 } from '@happier-dev/triage-protocol/releases/v1';
import { createForgeReleaseV1Fixture } from '@happier-dev/triage-protocol/releases/testing/v1';
import { GITHUB_RELEASE_ACTION_IDS_V1, GITHUB_RELEASE_ACTIONS_V1 } from './contribution.js';
import type { GithubHttpInvocationContextV1 } from '../observations/githubHttpInvocation.js';
import { createStubGithubTransport, readRecordedJsonBody, GITHUB_TEST_ACCOUNT } from '../triage/testkit/githubTriage.test-support.js';

const repository = { kind: 'github', deployment: 'https://github.com', repository: 'acme/widgets' } as const;
const target = { repository, repositoryId: '42' };
const stamp = '2026-10-24T10:00:00Z';
const reviewed = createForgeReleaseV1Fixture({ name: 'Release 7', body: 'Notes', repositoryVisibility: 'private',
  assets: { rows: [], omittedRowCount: 0, projectionTruncated: false, continuation: null, incomplete: null } });
function release(id = 7, overrides: Record<string, unknown> = {}) {
  return { id, tag_name: `v${id}`, target_commitish: 'main', name: `Release ${id}`, body: 'Notes',
    draft: true, prerelease: false, updated_at: stamp, created_at: stamp, published_at: null,
    html_url: `https://github.com/acme/widgets/releases/${id}`, assets: [], ...overrides };
}
async function harness(respond: Parameters<typeof createStubGithubTransport>[0]['respond'], readable = true) {
  const stub = createStubGithubTransport({ nativeMaterialization: { kind: 'httpHeaders', headers: { authorization: 'Bearer fixture' } },
    respond: request => new URL(request.url).pathname === '/repos/acme/widgets'
      ? readable ? { status: 200, body: { id: 42, full_name: 'acme/widgets', private: true } } : { status: 404 } : respond(request) });
  const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
    http: stub.context.services.http, connectedAccounts: stub.context.services.connectedAccounts,
  } });
  return { ...stub, plugin, invoke: async (operation: string, input: Record<string, unknown> = {}) => {
    const result = await plugin.invokeAction(`github/releases/${operation}`, { ...target, ...input });
    const key = (Object.keys(GITHUB_RELEASE_ACTION_IDS_V1) as Array<keyof typeof GITHUB_RELEASE_ACTION_IDS_V1>)
      .find(key => GITHUB_RELEASE_ACTION_IDS_V1[key] === `github/releases/${operation}`)!;
    return ForgeReleaseActionResultSchemasV1[key].parse(result);
  } };
}

describe('registered release Actions through real GitHub admission', () => {
  it('retains latest-stable clone selection through the declared Account Action contract', async () => {
    const stub = createStubGithubTransport({ nativeMaterialization: { kind: 'httpHeaders', headers: { authorization: 'Bearer fixture' } },
      respond: request => new URL(request.url).pathname.endsWith('/releases/latest')
        ? { status: 200, body: release(7, { draft: false, published_at: stamp }) }
        : { status: 200, body: { id: 42, full_name: 'acme/widgets', private: true,
          html_url: 'https://github.com/acme/widgets', clone_url: 'https://github.com/acme/widgets.git', default_branch: 'develop' } } });
    const plugin = await createPluginTestkit({ manifest: PLUGIN_MANIFEST, module: { activate, activateAccount }, services: {
      http: stub.context.services.http, connectedAccounts: stub.context.services.connectedAccounts,
    } });
    const paths: string[] = [];
    // Repository provisioning's established transport is fetch beneath the
    // shared GitHub Account request owner; only that system boundary is mocked.
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async url => {
      const path = new URL(String(url)).pathname;
      paths.push(path);
      return new Response(JSON.stringify(path.endsWith('/releases/latest')
        ? release(7, { draft: false, published_at: stamp })
        : { id: 42, full_name: 'acme/widgets', private: true,
          html_url: 'https://github.com/acme/widgets', clone_url: 'https://github.com/acme/widgets.git', default_branch: 'develop' }), { status: 200 });
    });
    try {
      const result = await plugin.invokeAction(GITHUB_HOSTING_OPERATION_ACTION_IDS_V1.describeCloneTargets, {
        provider: { id: 'happier.scm.forge.github/github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com' },
        repository: { nameWithOwner: 'acme/widgets' }, revision: 'latest-stable',
      });
      expect(result).toMatchObject({ initialCheckoutRef: 'refs/tags/v7' });
      expect(paths).toEqual(['/repos/acme/widgets', '/repos/acme/widgets/releases/latest']);
    } finally { fetchMock.mockRestore(); await plugin.dispose(); }
  });
  it('reads the selected Account release through the same HTTP owner without Machine services', async () => {
    const transport = createStubGithubTransport({ respond: request => new URL(request.url).pathname === '/repos/acme/widgets'
      ? { status: 200, body: { id: 42, full_name: 'acme/widgets', private: true } }
      : { status: 200, body: release(7, { draft: false }) } });
    const context = {
      plugin: transport.context.plugin, signal: transport.context.signal, invokedAtMs: 0,
      services: { http: transport.context.services.http, connectedAccounts: {
        ...transport.context.services.connectedAccounts,
        async materialize(_purpose, _request, options) {
          expect(options?.expectedAccount).toEqual(GITHUB_TEST_ACCOUNT);
          expect(options?.nativeService).toBeUndefined();
          return { kind: 'httpHeaders', headers: { authorization: 'Bearer synthetic-account' } };
        },
      } },
    } satisfies GithubHttpInvocationContextV1;
    const result = await GITHUB_RELEASE_ACTIONS_V1[GITHUB_RELEASE_ACTION_IDS_V1.readLatestRelease].run({ repository }, context);
    expect(ForgeReleaseActionResultSchemasV1.readLatestRelease.parse(result)).toMatchObject({ kind: 'value',
      value: { repositoryId: '42', releaseId: '7', draft: false } });
    expect(transport.requests).toHaveLength(2);
  });
  it('declares person-direct Save, irreversible Publish and dangerous automated writes', () => {
    const actions = new Map(PLUGIN_MANIFEST.contributes.actions?.map(action => [action.id, action]));
    for (const id of ['github/releases/draft-create', 'github/releases/draft-edit']) {
      expect(actions.get(id)).toMatchObject({ dangerLevel: 'writesRemote', confirmationWhen: { presentUserUi: false } });
    }
    expect(actions.get('github/releases/draft-publish')).toMatchObject({ dangerLevel: 'destructive' });
    expect(actions.get('github/releases/draft-publish')).toMatchObject({ irreversible: true });
    expect(actions.get('github/releases/draft-publish')?.confirmationWhen).toBeUndefined();
    const publish = PluginActionContributionV2Schema.parse(actions.get('github/releases/draft-publish'));
    for (const surface of ['agent', 'mcp', 'cli', 'ui']) {
      expect(pluginActionRequiresPresentUserIntent(publish, surface, { ...target, releaseId: reviewed.releaseId, reviewed, makeLatest: 'legacy' }, 'account_automation')).toBe(true);
    }
    expect(actions.get('ui/release-view-v1')).toMatchObject({ dangerLevel: 'safe', execution: { target: 'client' } });
    expect(actions.get(GITHUB_RELEASE_ACTION_IDS_V1.downloadAsset)).toMatchObject({
      dangerLevel: 'writesLocal', confirmationWhen: { presentUserUi: false },
      operation: { version: 1, visibility: 'activity', progress: 'indeterminate', presentation: { onStart: 'activity' } },
    });
  });

  it('resolves the current native repository id on an initial Project read', async () => {
    const h = await harness(() => ({ status: 200, body: release(7, { draft: false }) }));
    try {
      const result = await h.plugin.invokeAction('github/releases/latest-read', { repository });
      expect(ForgeReleaseActionResultSchemasV1.readLatestRelease.parse(result)).toMatchObject({ kind: 'value', value: { repositoryId: '42' } });
      expect(h.requests).toHaveLength(2);
    } finally { await h.plugin.dispose(); }
  });
  it('reads provider latest and only the requested list page, without asset or history fanout', async () => {
    const h = await harness(request => {
      const path = new URL(request.url).pathname;
      if (path.endsWith('/releases/latest')) return { status: 200, body: release(3, { draft: false }) };
      if (path.endsWith('/releases')) return { status: 200, body: [release(9), release(8, { prerelease: true })],
        headers: { link: '<https://api.github.com/repos/acme/widgets/releases?per_page=30&page=2>; rel="next"', etag: '"page"' } };
      return undefined;
    });
    try {
      expect(await h.invoke('list')).toMatchObject({ kind: 'value', value: { rows: [{ releaseId: '9' }, { releaseId: '8' }] }, validator: '"page"' });
      expect(await h.invoke('latest-read')).toMatchObject({ kind: 'value', value: { releaseId: '3', draft: false } });
      expect(h.requests.filter(r => r.url.includes('/releases'))).toHaveLength(2);
      expect(h.requests.some(r => r.url.includes('/assets'))).toBe(false);
    } finally { await h.plugin.dispose(); }
    const masked = await harness(() => ({ status: 404 }), false);
    try { expect(await masked.invoke('latest-read')).toMatchObject({ kind: 'unavailable', failure: { class: 'unknown' } }); }
    finally { await masked.plugin.dispose(); }
  });

  it('keeps masked latest absence unknown and distinguishes readable-repository absence', async () => {
    const h = await harness(() => ({ status: 404 }));
    try {
      expect(await h.invoke('latest-read')).toEqual({ kind: 'value', value: null });
      expect(await h.invoke('latest-read', { repositoryId: '43' })).toMatchObject({ kind: 'unavailable' });
    } finally { await h.plugin.dispose(); }
  });

  it('generates an unsaved proposal and creates only an explicit draft', async () => {
    const h = await harness(request => request.url.endsWith('/generate-notes')
      ? { status: 200, body: { name: 'Generated', body: 'Proposal' } }
      : { status: 201, body: release() });
    try {
      expect(await h.invoke('notes-generate', { tagName: 'v7', targetCommitish: 'main', previousTagName: 'v6', configurationFilePath: '.github/release.yml' }))
        .toEqual({ kind: 'value', value: { name: 'Generated', body: 'Proposal' } });
      expect(h.requests.filter(r => r.method === 'POST')).toHaveLength(1);
      expect(readRecordedJsonBody(h.requests.find(r => r.url.endsWith('/generate-notes'))!)).toEqual({ tag_name: 'v7', target_commitish: 'main', previous_tag_name: 'v6', configuration_file_path: '.github/release.yml' });
      expect(await h.invoke('draft-create', { tagName: 'v7', targetCommitish: 'main', name: 'My title', body: 'Edited', prerelease: false }))
        .toMatchObject({ kind: 'confirmed', release: { releaseId: '7', draft: true } });
      expect(readRecordedJsonBody(h.requests.find(r => r.method === 'POST' && !r.url.endsWith('/generate-notes'))!))
        .toEqual({ tag_name: 'v7', target_commitish: 'main', name: 'My title', body: 'Edited', prerelease: false, draft: true });
    } finally { await h.plugin.dispose(); }
  });

  it('refuses changed or published drafts before any edit or publish effect', async () => {
    const h = await harness(() => ({ status: 200, body: release(7, { updated_at: '2026-10-24T11:00:00Z' }) }));
    try {
      expect(await h.invoke('draft-edit', { releaseId: '7', observedUpdatedAt: stamp, changes: { body: 'Local unsaved text' } }))
        .toMatchObject({ kind: 'conflict' });
      expect(await h.invoke('draft-publish', { releaseId: '7', reviewed, makeLatest: 'legacy' }))
        .toMatchObject({ kind: 'conflict' });
      expect(h.requests.filter(r => r.method === 'PATCH')).toHaveLength(0);
    } finally { await h.plugin.dispose(); }
    const published = await harness(() => ({ status: 200, body: release(7, { draft: false }) }));
    try {
      expect(await published.invoke('draft-edit', { releaseId: '7', observedUpdatedAt: stamp, changes: { body: 'Changed' } }))
        .toMatchObject({ kind: 'rejected', failure: { code: 'github_release_not_a_draft' } });
      expect(published.requests.some(request => request.method === 'PATCH')).toBe(false);
    } finally { await published.plugin.dispose(); }
  });

  it('publishes one exact fresh draft and reads back the exact identity', async () => {
    let published = false;
    const h = await harness(request => {
      if (request.method === 'PATCH') { published = true; return { status: 200, body: release(7, { draft: false }) }; }
      if (request.url.includes('/assets?')) return { status: 200, body: [] };
      return { status: 200, body: release(7, { draft: !published }) };
    });
    try {
      expect(await h.invoke('draft-publish', { releaseId: '7', reviewed, makeLatest: 'false' }))
        .toMatchObject({ kind: 'confirmed', release: { releaseId: '7', draft: false } });
      const writes = h.requests.filter(r => r.method === 'PATCH');
      expect(writes).toHaveLength(1);
      expect(writes[0]?.url).toBe('https://api.github.com/repos/acme/widgets/releases/7');
      expect(readRecordedJsonBody(writes[0]!)).toEqual({ draft: false, make_latest: 'false' });
      expect(h.requests.at(-1)?.url).toBe(writes[0]?.url);
    } finally { await h.plugin.dispose(); }
  });

  it('reports unknown create, edit and publish outcomes without replay', async () => {
    const h = await harness(request => {
      if (request.method === 'POST' || request.method === 'PATCH') throw new Error('response lost');
      if (request.url.includes('/assets?')) return { status: 200, body: [] };
      return { status: 200, body: release() };
    });
    try {
      const fields = { tagName: 'v7', targetCommitish: 'main', name: 'Title', body: 'Text', prerelease: false };
      expect(await h.invoke('draft-create', fields)).toMatchObject({ kind: 'outcome_unknown' });
      expect(await h.invoke('draft-edit', { releaseId: '7', observedUpdatedAt: stamp, changes: { body: 'Changed' } })).toMatchObject({ kind: 'outcome_unknown', releaseId: '7' });
      expect(await h.invoke('draft-publish', { releaseId: '7', reviewed, makeLatest: 'legacy' })).toMatchObject({ kind: 'outcome_unknown', releaseId: '7' });
      expect(h.requests.filter(r => r.method === 'POST' || r.method === 'PATCH')).toHaveLength(3);
    } finally { await h.plugin.dispose(); }
  });
});
