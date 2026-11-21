import { expect, it, vi } from 'vitest';
import { DeploymentTargetRoleResultV1ProtocolSchema, PluginError, isPluginError } from '@happier-dev/plugin-sdk';
import { createPluginHttpFixture } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from './workers.js';

const accountId = 'a'.repeat(32), workerTag = 'b'.repeat(32), triggerUuid = 'trigger-1';
const selection = { accountId, workerTag, scriptName: 'app', triggerUuid,
  repository: { kind: 'github' as const, deployment: 'https://github.com', repository: 'example/app' } };
const scope = { providerIdentity: { providerAccountId: accountId, providerResourceId: workerTag, providerEnvironment: 'script:app' },
  providerEnvironment: { kind: 'native' as const, selection: { kind: 'script' as const, scriptName: 'app' } } };
const worker = { ...scope, triggerUuid, repositoryAccess: { status: 'ready' as const, repository: selection.repository } };
const sourceIntent = { kind: 'repository' as const, projectSourceId: 'source', sourceRevision: 1, sha: 'f'.repeat(40),
  compose: { path: 'compose.yaml', profiles: [], services: [] } };
const build = { build_uuid: 'build-1', status: 'stopped', build_outcome: 'success' };
const root = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;

// Current official v4 schema vectors, NOT tenant captures. Only HTTP is replaced.
// These exercise the internal native adapter, not qualified role admission.
function fixture(responses: unknown[], publicStatus?: number) {
  const controller = new AbortController();
  const request = vi.fn(async (input: HttpRequest) => {
    expect(input.headers ?? {}).not.toHaveProperty('authorization');
    if (input.url === 'https://app.my-account.workers.dev') {
      expect(input).toMatchObject({ method: 'GET', redirect: 'manual', responseBody: 'discard' });
      expect(input).not.toHaveProperty('credentialBinding');
      if (publicStatus === undefined) throw new Error('An address probe was not expected');
      return { status: publicStatus, headers: {}, body: new Uint8Array() };
    }
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true, result: next })) };
  });
  return { controller, request, context: { http: createPluginHttpFixture({ request }), signal: controller.signal, now: () => 123 } };
}
const observed = { ...scope, providerDeploymentId: 'build-1' };

it.each([
  { enabled: false, status: undefined, addresses: [] },
  { enabled: true, status: 200, addresses: ['https://app.my-account.workers.dev'] },
  { enabled: true, status: 302, addresses: ['https://app.my-account.workers.dev'] },
  { enabled: true, status: 404, addresses: undefined },
])('publishes a Worker address only when enabled and reachable (enabled=$enabled, status=$status)', async ({
  enabled, status, addresses,
}) => {
  const h = fixture([{ deployments: [{ versions: [{ version_id: 'exact', percentage: 100 }] }] },
    { enabled, previews_enabled: false }, ...(enabled ? [{ subdomain: 'my-account' }] : [])], status);
  const result = DeploymentTargetRoleResultV1ProtocolSchema.parse(
    await entry.observeUploadedWorker({ ...scope, providerDeploymentId: 'version:exact' }, h.context));
  expect(result.state).toBe('succeeded');
  expect(result.urls).toEqual(addresses);
  expect(result.builtInUrls).toEqual(addresses);
  const publicReads = h.request.mock.calls.filter(([request]) => request.url === 'https://app.my-account.workers.dev');
  expect(publicReads).toHaveLength(enabled ? 1 : 0);
});

it('preserves proven activation when address discovery is unavailable', async () => {
  const h = fixture([{ deployments: [{ versions: [{ version_id: 'exact', percentage: 100 }] }] },
    new PluginError({ code: 'deployment_access_denied', retryable: false })]);
  const outcome = await entry.observeUploadedWorker({ ...scope, providerDeploymentId: 'version:exact' }, h.context);
  expect(outcome).toMatchObject({ state: 'succeeded' });
  expect(outcome).not.toHaveProperty('urls');
});

it('preserves proven activation when optional address discovery is cancelled', async () => {
  const h = fixture([{ deployments: [{ versions: [{ version_id: 'exact', percentage: 100 }] }] }]);
  const read = h.request.getMockImplementation()!;
  h.request.mockImplementation(async request => {
    if (request.url.endsWith('/subdomain')) {
      h.controller.abort();
      throw h.controller.signal.reason;
    }
    return read(request);
  });
  const outcome = await entry.observeUploadedWorker({ ...scope, providerDeploymentId: 'version:exact' }, h.context);
  expect(outcome).toMatchObject({ state: 'succeeded' });
  expect(outcome).not.toHaveProperty('urls');
});

it('prepares the exact tag/trigger and repository once, without credential or native scope duplication', async () => {
  const h = fixture([[{ trigger_uuid: triggerUuid, external_script_id: workerTag, deleted_on: null,
    repo_connection: { provider_type: 'github', provider_account_name: 'example', repo_name: 'app', repo_id: '123', deleted_on: null } }]]);
  expect(await entry.prepareWorker(selection, h.context)).toEqual(worker);
  expect(h.request.mock.calls.map(([request]) => [request.method, request.url])).toEqual([
    ['GET', `${root}/builds/workers/${workerTag}/triggers`],
  ]);
  const missing = fixture([[]]);
  expect(await entry.prepareWorker(selection, missing.context)).toMatchObject({ repositoryAccess: { status: 'needsGitAccess' } });
  expect(missing.request.mock.calls.every(([request]) => request.method === 'GET')).toBe(true);
});

it('sends the approved SHA only and recovers retained receipt identity without another build or Git probe', async () => {
  const h = fixture([{ build_uuid: 'build-1', status: 'queued' }, { build_uuid: 'build-1', status: 'running' }]);
  expect(DeploymentTargetRoleResultV1ProtocolSchema.parse(await entry.deployWorker({ sourceIntent }, worker, h.context)))
    .toMatchObject({ state: 'queued', providerDeploymentId: 'build-1' });
  expect(JSON.parse(new TextDecoder().decode(h.request.mock.calls[0][0].body))).toEqual({ commit_hash: sourceIntent.sha });
  expect(h.request.mock.calls[0][0]).toMatchObject({ method: 'POST', url: `${root}/builds/triggers/${triggerUuid}/builds`,
    credentialBinding: { kind: 'connectedAccountPurpose', purpose: 'deploy.manage', method: 'POST' } });
  expect(await entry.deployWorker({ sourceIntent, providerDeploymentId: 'build-1' }, worker, h.context)).toMatchObject({ state: 'running' });
  expect(h.request.mock.calls.map(([request]) => request.method)).toEqual(['POST', 'GET']);
  expect(h.request.mock.calls[1][0].url).toBe(`${root}/builds/builds/build-1`);
});

it('does not equate a successful arbitrary deploy command with serving the intended Worker', async () => {
  const h = fixture([build, { deployments: [{ id: 'traffic-1', versions: [{ version_id: 'version-old', percentage: 100 }] }] },
    { builds: { arbitraryMapKey: { ...build, build_uuid: 'other-build' } } }]);
  expect(await entry.observeWorker(observed, h.context)).toMatchObject({ state: 'outcome_unknown', providerDeploymentId: 'build-1' });
  expect(h.request.mock.calls.map(([request]) => request.url)).toEqual([
    `${root}/builds/builds/build-1`, `${root}/workers/scripts/app/deployments`, `${root}/builds/builds?version_ids=version-old`,
  ]);
});

it('proves every traffic-bearing version by documented build association, not map keys or uniqueness', async () => {
  const h = fixture([build, { deployments: [{ id: 'traffic-1', versions: [
    { version_id: 'version-a', percentage: 30 }, { version_id: 'version-b', percentage: 70 }, { version_id: 'inactive', percentage: 0 },
  ] }] }, { builds: { unrelatedKey: { ...build, build_uuid: 'other-build' }, secondKey: build } }, { builds: { randomKey: build } }]);
  expect(DeploymentTargetRoleResultV1ProtocolSchema.parse(await entry.observeWorker(observed, h.context)))
    .toEqual({ v: 1, state: 'succeeded', providerDeploymentId: 'build-1', observedAtMs: 123 });
  expect(h.request.mock.calls.map(([request]) => request.url).slice(2)).toEqual([
    `${root}/builds/builds?version_ids=version-a`, `${root}/builds/builds?version_ids=version-b`, `${root}/workers/scripts/app/subdomain`,
  ]);
  expect(h.request).toHaveBeenCalledTimes(5);
});

it.each(['fail', 'cancelled', 'terminated', 'skipped'] as const)('normalizes terminal %s without serving reads or invented success', async outcome => {
  const h = fixture([{ ...build, build_outcome: outcome }]);
  expect(await entry.observeWorker(observed, h.context)).toMatchObject({
    state: outcome === 'fail' ? 'failed' : outcome === 'skipped' ? 'outcome_unknown' : 'cancelled',
  });
  expect(h.request).toHaveBeenCalledTimes(1);
});

it('uses the native cancel acknowledgement and never replays a lost build mutation', async () => {
  const h = fixture([{ build_uuid: 'build-1', build_outcome: 'cancelled' }]);
  expect(await entry.cancelWorker(observed, h.context)).toMatchObject({ state: 'cancelled', providerDeploymentId: 'build-1' });
  expect(h.request.mock.calls.map(([request]) => [request.method, request.url])).toEqual([
    ['PUT', `${root}/builds/builds/build-1/cancel`],
  ]);
  const lost = fixture([new Error('private-provider-detail'), { build_uuid: 'build-1', status: 'running' }]);
  expect(await entry.deployWorker({ sourceIntent }, worker, lost.context)).toMatchObject({ code: 'outcome_unknown', phase: 'send', retryable: false });
  expect(await entry.observeWorker(observed, lost.context)).toMatchObject({ state: 'running' });
  expect(lost.request.mock.calls.map(([request]) => request.method)).toEqual(['POST', 'GET']);
});

it('preserves canonical HTTP failures and distinguishes pre-send cancellation from an ambiguous sent mutation', async () => {
  const ownerError = new PluginError({ code: 'credential_unavailable' });
  const h = fixture([ownerError]);
  await expect(entry.deployWorker({ sourceIntent }, worker, h.context)).rejects.toBe(ownerError);
  expect(isPluginError(ownerError)).toBe(true);
  h.request.mockImplementationOnce(async () => { h.controller.abort(); throw new Error('private abort detail'); });
  expect(await entry.deployWorker({ sourceIntent }, worker, h.context)).toMatchObject({ code: 'outcome_unknown', phase: 'send' });
  const before = fixture([]); before.controller.abort();
  await expect(entry.observeWorker(observed, before.context)).rejects.toMatchObject({ name: 'AbortError' });
  expect(before.request).not.toHaveBeenCalled();
});

it('rejects native Preview scope and missing Git access before any production build request', async () => {
  const h = fixture([]);
  expect(await entry.observeWorker({ ...observed, providerEnvironment: { kind: 'native', selection: { kind: 'preview', scriptName: 'app', previewName: 'feature' } } }, h.context))
    .toMatchObject({ code: 'unsupported_action' });
  expect(await entry.deployWorker({ sourceIntent }, { ...worker, repositoryAccess: { status: 'needsGitAccess', repository: selection.repository } }, h.context))
    .toMatchObject({ code: 'needsGitAccess' });
  expect(h.request).not.toHaveBeenCalled();
});

it('keeps malformed or denied vendor output typed and secret-free, and incomplete serving evidence unknown', async () => {
  const h = fixture([{ build_uuid: 'other', status: 'running' }]);
  expect(await entry.observeWorker(observed, h.context)).toMatchObject({ code: 'provider_response_invalid', phase: 'observe' });
  h.request.mockImplementationOnce(async () => ({ status: 403, headers: {}, body: new TextEncoder().encode('private-provider-detail') }));
  await expect(entry.observeWorker(observed, h.context)).rejects.toMatchObject({
    name: 'PluginError', code: 'deployment_access_denied',
    data: { failureCause: { phase: 'deployment.provider.observe', errorClass: 'Error', errorCode: null, httpStatus: 403 } },
  });
  const incomplete = fixture([build, { deployments: [{ id: 'traffic-1', versions: [] }] }]);
  expect(await entry.observeWorker(observed, incomplete.context)).toMatchObject({ state: 'outcome_unknown' });
});

it('keeps a successful build unknown when serving evidence is unavailable instead of falsely failing the workload', async () => {
  const h = fixture([build, new Error('private-read-failure')]);
  expect(await entry.observeWorker(observed, h.context)).toMatchObject({ state: 'outcome_unknown', providerDeploymentId: 'build-1' });
  expect(h.request).toHaveBeenCalledTimes(2);
});

it('does not re-enforce the provider traffic total with a competing floating-point equality guard', async () => {
  const h = fixture([build, { deployments: [{ id: 'traffic-1', versions: [
    { version_id: 'version-a', percentage: 0.01 }, { version_id: 'version-b', percentage: 64.04 }, { version_id: 'version-c', percentage: 35.95 },
  ] }] }, ...Array.from({ length: 3 }, () => ({ builds: { arbitraryKey: build } }))]);
  expect(await entry.observeWorker(observed, h.context)).toMatchObject({ state: 'succeeded' });
  expect(h.request).toHaveBeenCalledTimes(6);
});

it('retains the canonical cancel phase when the native cancel response is lost', async () => {
  const h = fixture([new Error('private-cancel-detail')]);
  expect(await entry.cancelWorker(observed, h.context)).toEqual({ v: 1, code: 'outcome_unknown', phase: 'cancel', retryable: false });
  expect(h.request).toHaveBeenCalledTimes(1);
});
