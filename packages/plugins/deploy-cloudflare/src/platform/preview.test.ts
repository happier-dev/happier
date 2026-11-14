import { expect, it, vi } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import { preparePreview } from './preview.js';

const accountId = 'a'.repeat(32), workerTag = 'b'.repeat(32), previewId = 'c'.repeat(32);
const selection = { accountId, workerTag, scriptName: 'parent-worker', previewName: 'feature/one',
  repository: { kind: 'github' as const, deployment: 'https://github.com', repository: 'example/app' } };
const root = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
const git = { script_tag: workerTag, previews_enabled: true,
  git_repository: { provider_type: 'github', provider_account_name: 'example', repo_name: 'app', repo_id: '123' } };

// Constructed vectors from current official Cloudflare OpenAPI (2026-10-31),
// workers_Preview / builds_PreviewResponse / builds_WorkerResponse, not tenant captures.
function fixture(values: unknown[]) {
  const controller = new AbortController();
  const request = vi.fn(async (_request: HttpRequest) => {
    const value = values.shift();
    if (value instanceof Error) throw value;
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true, result: value })) };
  });
  return { request, controller, context: { http: createPluginHttpFixture({ request }), signal: controller.signal, now: () => 123 } };
}

it('resolves an exact named Preview to its immutable id and checks its native Builds branch/repository at Connect', async () => {
  const h = fixture([{ id: previewId, name: selection.previewName },
    { preview_id: previewId, branch: selection.previewName }, git]);
  expect(await preparePreview(selection, h.context)).toEqual({ previewId, previewName: selection.previewName, gitBranch: selection.previewName,
    repositoryAccess: { status: 'ready', repository: selection.repository } });
  expect(h.request.mock.calls.map(([request]) => [request.method, request.url])).toEqual([
    ['GET', `${root}/workers/workers/${selection.scriptName}/previews/feature%2Fone`],
    ['GET', `${root}/builds/workers/${workerTag}/previews/${previewId}`],
    ['GET', `${root}/builds/workers/${workerTag}`],
  ]);
  for (const [request] of h.request.mock.calls) {
    expect(request).toMatchObject({ credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'deploy.manage', method: 'GET' }, redirect: 'error' });
    expect(request.headers ?? {}).not.toHaveProperty('authorization');
  }
});

it('keeps two branch Previews distinct on one parent and never creates a production or staging Worker', async () => {
  const secondId = 'd'.repeat(32);
  const h = fixture([{ id: previewId, name: selection.previewName }, { preview_id: previewId, branch: selection.previewName }, git,
    { id: secondId, name: 'feature/two' }, { preview_id: secondId, branch: 'feature/two' }, git]);
  expect(await preparePreview(selection, h.context)).toMatchObject({ previewId });
  expect(await preparePreview({ ...selection, previewName: 'feature/two' }, h.context)).toMatchObject({ previewId: secondId });
  expect(h.request.mock.calls.map(([request]) => request.method)).toEqual(Array(6).fill('GET'));
});

it('keeps a named Preview independent from the provider-configured Git branch', async () => {
  const h = fixture([{ id: previewId, name: 'qa-preview' },
    { preview_id: previewId, branch: 'feature/one' }, git]);
  expect(await preparePreview({ ...selection, previewName: 'qa-preview' }, h.context)).toEqual({
    previewId, previewName: 'qa-preview', gitBranch: 'feature/one',
    repositoryAccess: { status: 'ready', repository: selection.repository },
  });
});

it('returns missing or evicted Preview as unavailable with zero fallback reads or production writes', async () => {
  const h = fixture([]);
  h.request.mockResolvedValueOnce({ status: 404, headers: {}, body: new Uint8Array() });
  await expect(preparePreview(selection, h.context)).rejects.toMatchObject({ code: 'deployment_unavailable', details: { phase: 'link' }, retryable: false });
  expect(h.request).toHaveBeenCalledTimes(1);
});

it.each([
  [{ id: 'version-url', name: selection.previewName }],
  [{ id: previewId, name: 'other' }],
  [{ id: previewId, name: selection.previewName }, { preview_id: 'd'.repeat(32), branch: selection.previewName }],
  [{ id: previewId, name: selection.previewName }, { preview_id: previewId, branch: '' }],
])('refuses a mismatched native identity instead of adopting a sibling or version URL', async (...values: unknown[]) => {
  const h = fixture(values);
  expect(await preparePreview(selection, h.context)).toMatchObject({ code: 'provider_response_invalid', phase: 'link' });
  expect(h.request.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
});

it('reports missing native Git configuration without losing the exact Preview and never exposes Base secrets', async () => {
  const h = fixture([{ id: previewId, name: selection.previewName, env: { SECRET: { type: 'secret_text', text: 'private' } } },
    { preview_id: previewId, branch: selection.previewName, settings: { environment_variables: { SECRET: { value: 'private' } } } },
    { ...git, git_repository: { ...git.git_repository, repo_name: 'other' } }]);
  expect(await preparePreview(selection, h.context)).toEqual({ previewId, previewName: selection.previewName, gitBranch: selection.previewName,
    repositoryAccess: { status: 'needsGitAccess', repository: selection.repository } });
});

it('preserves canonical HTTP custody failures and cancels before sending', async () => {
  const error = new PluginError({ code: 'credential_unavailable' });
  const h = fixture([error]);
  await expect(preparePreview(selection, h.context)).rejects.toBe(error);
  h.controller.abort();
  await expect(preparePreview(selection, h.context)).rejects.toMatchObject({ name: 'AbortError' });
  expect(h.request).toHaveBeenCalledTimes(1);
});
