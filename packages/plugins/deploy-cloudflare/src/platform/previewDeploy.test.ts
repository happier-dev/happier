import { expect, it, vi } from 'vitest';
import { DeploymentTargetRoleResultV1ProtocolSchema, PluginError } from '@happier-dev/plugin-sdk';
import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from './previewDeploy.js';

const accountId = 'a'.repeat(32), workerTag = 'b'.repeat(32), previewId = 'c'.repeat(32);
const preview = { accountId, workerTag, scriptName: 'parent-worker', previewId, previewName: 'review/name', gitBranch: 'actual-git-branch',
  repositoryAccess: { status: 'ready' as const,
    repository: { kind: 'github' as const, deployment: 'https://github.com', repository: 'example/app' } } };
const sourceIntent = { kind: 'repository' as const, projectSourceId: 'source', sourceRevision: 1, sha: 'f'.repeat(40),
  compose: { path: 'compose.yaml', profiles: [], services: [] } };
const observed = { providerDeploymentId: 'build-1' };
const root = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
const artifactUrl = 'https://9387e76d-review.my-subdomain.workers.dev';
const completedBuild = { build_uuid: 'build-1', status: 'stopped', build_outcome: 'success', preview_url: artifactUrl };

// Official Cloudflare OpenAPI schema vectors read 2026-10-31, not tenant captures.
// Only HTTP is replaced; credential custody stays in the canonical request owner.
function fixture(responses: unknown[]) {
  const controller = new AbortController();
  const request = vi.fn(async (input: HttpRequest) => {
    expect(input.headers ?? {}).not.toHaveProperty('authorization');
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true, result: next })) };
  });
  return { controller, request, context: { http: createPluginHttpFixture({ request }), signal: controller.signal, now: () => 123 } };
}

it('builds only the captured Preview using reviewed SHA and the independently observed Git branch', async () => {
  const h = fixture([{ build_uuid: 'build-1', status: 'queued' }]);
  expect(DeploymentTargetRoleResultV1ProtocolSchema.parse(await entry.deployPreview({ sourceIntent }, preview, h.context)))
    .toMatchObject({ state: 'queued', providerDeploymentId: 'build-1' });
  expect(h.request.mock.calls.map(([request]) => [request.method, request.url])).toEqual([
    ['POST', `${root}/builds/workers/${workerTag}/previews/${previewId}/builds`],
  ]);
  const request = h.request.mock.calls[0][0];
  expect(JSON.parse(new TextDecoder().decode(request.body))).toEqual({ commit_hash: sourceIntent.sha, branch: preview.gitBranch });
  expect(request).toMatchObject({ redirect: 'error', credentialBinding: {
    kind: 'connectedAccountPurpose', purpose: 'deploy.manage', origin: 'https://api.cloudflare.com', method: 'POST', headerNames: ['authorization'],
  } });
});

it('recovers a retained build with GET only, without re-probing access or rebuilding', async () => {
  const h = fixture([{ build_uuid: 'build-1', status: 'running' }]);
  expect(await entry.deployPreview({ sourceIntent, ...observed }, preview, h.context)).toMatchObject({ state: 'running' });
  expect(h.request.mock.calls.map(([request]) => [request.method, request.url])).toEqual([
    ['GET', `${root}/builds/builds/build-1`],
  ]);
});

it('requires the successful build artifact to belong to the latest native Preview deployment', async () => {
  const h = fixture([completedBuild, { id: 'deployment-1', urls: [artifactUrl] }]);
  expect(DeploymentTargetRoleResultV1ProtocolSchema.parse(await entry.observePreview(observed, preview, h.context)))
    .toEqual({ v: 1, state: 'succeeded', providerDeploymentId: 'build-1', observedAtMs: 123, urls: [artifactUrl] });
  expect(h.request.mock.calls.map(([request]) => request.url)).toEqual([
    `${root}/builds/builds/build-1`, `${root}/workers/workers/parent-worker/previews/${previewId}/deployments/latest`,
  ]);
});

it.each([
  { id: 'deployment-old', urls: ['https://other.workers.dev'] },
  { id: 'deployment-1', urls: [] },
  new Error('private-native-read-failure'),
])('keeps missing or mismatched Preview serving proof unknown without production fallback', async deployment => {
  const h = fixture([completedBuild, deployment]);
  expect(await entry.observePreview(observed, preview, h.context)).toMatchObject({ state: 'outcome_unknown', providerDeploymentId: 'build-1' });
  expect(h.request).toHaveBeenCalledTimes(2);
  expect(h.request.mock.calls.some(([request]) => request.url.includes('/workers/scripts/'))).toBe(false);
});

it('does not mistake arbitrary successful build commands or a missing artifact for Preview deployment', async () => {
  const h = fixture([{ ...completedBuild, preview_url: undefined }]);
  expect(await entry.observePreview(observed, preview, h.context)).toMatchObject({ state: 'outcome_unknown' });
  expect(h.request).toHaveBeenCalledTimes(1);
});

it.each(['fail', 'cancelled', 'terminated', 'skipped'] as const)('normalizes native %s without serving reads', async outcome => {
  const h = fixture([{ ...completedBuild, build_outcome: outcome }]);
  expect(await entry.observePreview(observed, preview, h.context)).toMatchObject({
    state: outcome === 'fail' ? 'failed' : outcome === 'skipped' ? 'outcome_unknown' : 'cancelled',
  });
  expect(h.request).toHaveBeenCalledTimes(1);
});

it('cancels the retained native build once and preserves an uncertain cancellation', async () => {
  const h = fixture([{ build_uuid: 'build-1', build_outcome: 'cancelled' }, new Error('private-cancel-detail'),
    completedBuild, { id: 'deployment-1', urls: [artifactUrl] },
    { build_uuid: 'another-build', build_outcome: 'cancelled' }]);
  expect(await entry.cancelPreview(observed, preview, h.context)).toMatchObject({ state: 'cancelled', providerDeploymentId: 'build-1' });
  expect(await entry.cancelPreview(observed, preview, h.context)).toEqual({ v: 1, code: 'outcome_unknown', phase: 'cancel', retryable: false });
  expect(await entry.cancelPreview(observed, preview, h.context)).toEqual({
    v: 1, state: 'succeeded', providerDeploymentId: 'build-1', observedAtMs: 123, urls: [artifactUrl],
  });
  expect(await entry.cancelPreview(observed, preview, h.context)).toEqual({
    v: 1, code: 'outcome_unknown', phase: 'cancel', retryable: false,
  });
  expect(h.request.mock.calls.map(([request]) => [request.method, request.url])).toEqual([
    ['PUT', `${root}/builds/builds/build-1/cancel`], ['PUT', `${root}/builds/builds/build-1/cancel`],
    ['PUT', `${root}/builds/builds/build-1/cancel`],
    ['GET', `${root}/workers/workers/parent-worker/previews/${previewId}/deployments/latest`],
    ['PUT', `${root}/builds/builds/build-1/cancel`],
  ]);
});

it('preserves lost-write ambiguity and canonical credential failure without replay', async () => {
  const h = fixture([new Error('private-send-detail')]);
  expect(await entry.deployPreview({ sourceIntent }, preview, h.context)).toEqual({ v: 1, code: 'outcome_unknown', phase: 'send', retryable: false });
  expect(h.request).toHaveBeenCalledTimes(1);
  const denied = fixture([new PluginError({ code: 'credential_unavailable' })]);
  await expect(entry.deployPreview({ sourceIntent }, preview, denied.context)).rejects.toMatchObject({ code: 'credential_unavailable' });
});

it('settles missing build identity and unavailable Git access with zero provider writes', async () => {
  const h = fixture([]);
  expect(await entry.observePreview({}, preview, h.context)).toMatchObject({ code: 'outcome_unknown', phase: 'observe' });
  expect(await entry.cancelPreview({}, preview, h.context)).toMatchObject({ code: 'outcome_unknown', phase: 'cancel' });
  expect(await entry.deployPreview({ sourceIntent }, { ...preview,
    repositoryAccess: { ...preview.repositoryAccess, status: 'needsGitAccess' } }, h.context)).toMatchObject({ code: 'needsGitAccess' });
  expect(h.request).not.toHaveBeenCalled();
});

it('does not normalize a different build identity or send after local cancellation', async () => {
  const h = fixture([{ build_uuid: 'other-build', status: 'running' }]);
  expect(await entry.observePreview(observed, preview, h.context)).toMatchObject({ code: 'provider_response_invalid', phase: 'observe' });
  const cancelled = fixture([]); cancelled.controller.abort();
  await expect(entry.deployPreview({ sourceIntent }, preview, cancelled.context)).rejects.toMatchObject({ name: 'AbortError' });
  expect(cancelled.request).not.toHaveBeenCalled();
});

it('keeps an absent or evicted Preview unavailable and never creates a replacement or writes production', async () => {
  const h = fixture([]);
  h.request.mockImplementationOnce(async () => ({ status: 404, headers: {}, body: new Uint8Array() }));
  await expect(entry.deployPreview({ sourceIntent }, preview, h.context))
    .rejects.toMatchObject({ code: 'deployment_unavailable', details: { phase: 'send' }, retryable: false });
  expect(h.request.mock.calls.map(([request]) => [request.method, request.url])).toEqual([
    ['POST', `${root}/builds/workers/${workerTag}/previews/${previewId}/builds`],
  ]);
});

it('keeps provider 503 after the native build request unknown and never retries it', async () => {
  const h = fixture([]);
  h.request.mockImplementationOnce(async () => ({ status: 503, headers: {}, body: new TextEncoder().encode('private-provider-failure') }));
  expect(await entry.deployPreview({ sourceIntent }, preview, h.context))
    .toEqual({ v: 1, code: 'outcome_unknown', phase: 'send', retryable: false });
  expect(h.request).toHaveBeenCalledTimes(1);
});
