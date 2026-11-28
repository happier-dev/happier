import { expect, it } from 'vitest';
import { DeploymentTargetRoleResultV1ProtocolSchema } from '@happier-dev/plugin-sdk';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from '../index.js';

it('contributes the executable Cloudflare Workers runtime through the real public manifest', () => {
  expect(entry.manifest.contributes.actions.find(action => action.id === 'workers-inspect'))
    .toMatchObject({ readOnly: true, dangerLevel: 'safe', surfaces: expect.arrayContaining(['ui', 'agent']) });
  expect(entry.manifest.contributes.actions.some(action => ['workers-prepare', 'pages-prepare'].includes(action.id))).toBe(false);
  expect(entry.manifest.contributes.deploymentTargets ?? []).toContainEqual(expect.objectContaining({
    role: 'runtime', targetKind: 'cloudflare-workers', actions: expect.objectContaining({
      inspect: 'workers-inspect', link: expect.any(String), deploy: expect.any(String), observe: expect.any(String), cancel: expect.any(String),
    }),
  }));
});

it('activates prepare/link and exact-SHA lifecycle roles using the captured canonical trigger without a deployment-time Git probe', async () => {
  const accountId = 'a'.repeat(32), workerTag = 'b'.repeat(32), triggerUuid = 'trigger-selected';
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    let result: unknown;
    if (request.url.endsWith(`/workers/workers/${workerTag}`)) result = { id: workerTag, name: 'app' };
    else if (request.url.endsWith('/triggers')) result = [{ trigger_uuid: triggerUuid, external_script_id: workerTag,
      repo_connection: { provider_type: 'github', provider_account_name: 'example', repo_name: 'app', repo_id: '123' } }];
    else if (request.url.endsWith('/cancel')) result = { build_uuid: 'build-selected', build_outcome: 'cancelled' };
    else result = { build_uuid: 'build-selected', status: request.method === 'POST' ? 'queued' : 'running' };
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true, result })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  const invoke = kit.invokeAction;
  const credentialRef = { service: { pluginId: entry.manifest.id, localId: 'cloudflare' }, accountId: 'selected-profile' };
  const preparation = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1, credentialRef,
    credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: { consumer: { pluginId: entry.manifest.id,
      localId: 'workers-inspect' }, purpose: 'deploy.manage' }, target: { kind: 'account', account: credentialRef } },
    providerIdentity: { providerAccountId: accountId, providerResourceId: workerTag, providerEnvironment: 'script:app' },
    providerEnvironment: { kind: 'native', selection: { kind: 'script', scriptName: 'app' } } };
  try {
    const input = { ...preparation, triggerUuid, repository: { kind: 'github', deployment: 'https://github.com', repository: 'example/app' } };
    await expect(kit.invokeAction('workers-inspect', { ...preparation, repository: input.repository })).rejects.toThrow();
    expect(requests).toHaveLength(0);
    const prepared = await invoke('workers-inspect', input);
    expect(prepared).toMatchObject({ credentialPrincipal: preparation.credentialPrincipal,
      providerIdentity: preparation.providerIdentity, repositoryAccess: { status: 'ready' },
      preparedNative: { projectName: 'app', triggerUuid } });
    if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) throw new Error('Expected prepared link content');
    const linked = await kit.invokeAction('workers-link', { ...preparation, ...prepared });
    expect(linked).toMatchObject({ preparedNative: { projectName: 'app', triggerUuid } });
    expect(requests).toHaveLength(2);
    const common = { ...preparation, ...prepared, targetLinkId: 'link', expectedTargetLinkRevision: 1,
      deploymentId: 'receipt', expectedDeploymentRevision: 1, actionOperationId: 'operation' };
    const deploy = { ...common, sourceMethod: 'gitIntegration', sourceIntent: { kind: 'repository', projectSourceId: 'source',
      sourceRevision: 1, sha: 'f'.repeat(40), compose: { path: 'compose.yaml', profiles: [], services: [] } } };
    expect(DeploymentTargetRoleResultV1ProtocolSchema.parse(await invoke('workers-deploy', deploy))).toMatchObject({ state: 'queued', providerDeploymentId: 'build-selected' });
    expect(DeploymentTargetRoleResultV1ProtocolSchema.parse(await invoke('workers-observe', { ...common, providerDeploymentId: 'build-selected' }))).toMatchObject({ state: 'running' });
    expect(DeploymentTargetRoleResultV1ProtocolSchema.parse(await invoke('workers-cancel', { ...common, providerDeploymentId: 'build-selected' }))).toMatchObject({ state: 'cancelled' });
    expect(await invoke('workers-deploy', { ...deploy, providerDeploymentId: 'build-selected' })).toMatchObject({ state: 'running' });
    expect(requests.map(request => request.method)).toEqual(['GET', 'GET', 'POST', 'GET', 'PUT', 'GET']);
    expect(requests[2].url).toBe(`https://api.cloudflare.com/client/v4/accounts/${accountId}/builds/triggers/${triggerUuid}/builds`);
    expect(JSON.parse(new TextDecoder().decode(requests[2].body))).toEqual({ commit_hash: 'f'.repeat(40) });
    expect(requests.every(request => request.credentialBinding?.kind === 'connectedAccountPurpose'
      && request.credentialBinding.purpose === 'deploy.manage')).toBe(true);
  } finally { await kit.dispose(); }
});

it('activates native Preview preparation and lifecycle on the existing Worker target using only captured Preview coordinates', async () => {
  const accountId = 'a'.repeat(32), workerTag = 'b'.repeat(32), previewId = 'c'.repeat(32);
  const scriptName = 'parent-worker', previewName = 'review/name', gitBranch = 'actual-git-branch';
  const root = `https://api.cloudflare.com/client/v4/accounts/${accountId}`;
  const requests: HttpRequest[] = [];
  let missing = false;
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    if (missing) return { status: 404, headers: {}, body: new Uint8Array() };
    let result: unknown;
    if (request.url.endsWith(`/workers/workers/${workerTag}`)) result = { id: workerTag, name: scriptName };
    else if (request.url.endsWith('/previews/review%2Fname')) result = { id: previewId, name: previewName };
    else if (request.url.endsWith(`/previews/${previewId}`)) result = { preview_id: previewId, branch: gitBranch };
    else if (request.url.endsWith(`/builds/workers/${workerTag}`)) result = { script_tag: workerTag, previews_enabled: true,
      git_repository: { provider_type: 'github', provider_account_name: 'example', repo_name: 'app', repo_id: '123' } };
    else if (request.url.endsWith('/cancel')) result = { build_uuid: 'preview-build', build_outcome: 'cancelled' };
    else result = { build_uuid: 'preview-build', status: request.method === 'POST' ? 'queued' : 'running' };
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true, result })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  const invoke = kit.invokeAction;
  const credentialRef = { service: { pluginId: entry.manifest.id, localId: 'cloudflare' }, accountId: 'selected-profile' };
  const preparation = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1, credentialRef,
    credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: { consumer: { pluginId: entry.manifest.id,
      localId: 'workers-inspect' }, purpose: 'deploy.manage' }, target: { kind: 'account', account: credentialRef } },
    providerIdentity: { providerAccountId: accountId, providerResourceId: workerTag, providerEnvironment: 'selected' },
    providerEnvironment: { kind: 'native', selection: { kind: 'preview', scriptName, previewName } } };
  const input = { ...preparation, repository: { kind: 'github', deployment: 'https://github.com', repository: 'example/app' } };
  try {
    const prepared = await invoke('workers-inspect', input);
    expect(prepared).toMatchObject({ credentialPrincipal: preparation.credentialPrincipal,
      providerIdentity: { providerAccountId: accountId, providerResourceId: workerTag,
        providerEnvironment: `preview:${JSON.stringify([scriptName, previewName])}` },
      providerEnvironment: preparation.providerEnvironment, repositoryAccess: { status: 'ready' },
      preparedNative: { projectName: scriptName, previewId, gitBranch, workerTag, scriptName } });
    if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) throw new Error('Expected prepared Preview');
    expect(await kit.invokeAction('workers-link', { ...preparation, ...prepared })).toEqual(prepared);
    expect(requests.map(request => request.url)).toEqual([
      `${root}/workers/workers/${workerTag}`, `${root}/workers/workers/${scriptName}/previews/review%2Fname`,
      `${root}/builds/workers/${workerTag}/previews/${previewId}`, `${root}/builds/workers/${workerTag}`,
    ]);
    const common = { ...preparation, ...prepared, targetLinkId: 'link', expectedTargetLinkRevision: 1,
      deploymentId: 'receipt', expectedDeploymentRevision: 1, actionOperationId: 'operation' };
    const deploy = { ...common, sourceMethod: 'gitIntegration', sourceIntent: { kind: 'repository', projectSourceId: 'source',
      sourceRevision: 1, sha: 'f'.repeat(40), compose: { path: 'compose.yaml', profiles: [], services: [] } } };
    expect(DeploymentTargetRoleResultV1ProtocolSchema.parse(await invoke('workers-deploy', deploy)))
      .toMatchObject({ state: 'queued', providerDeploymentId: 'preview-build' });
    expect(await invoke('workers-observe', { ...common, providerDeploymentId: 'preview-build' })).toMatchObject({ state: 'running' });
    expect(await invoke('workers-cancel', { ...common, providerDeploymentId: 'preview-build' })).toMatchObject({ state: 'cancelled' });
    expect(await invoke('workers-deploy', { ...deploy, providerDeploymentId: 'preview-build' })).toMatchObject({ state: 'running' });
    expect(requests.slice(4).map(request => [request.method, request.url])).toEqual([
      ['POST', `${root}/builds/workers/${workerTag}/previews/${previewId}/builds`],
      ['GET', `${root}/builds/builds/preview-build`], ['PUT', `${root}/builds/builds/preview-build/cancel`],
      ['GET', `${root}/builds/builds/preview-build`],
    ]);
    expect(JSON.parse(new TextDecoder().decode(requests[4].body))).toEqual({ commit_hash: 'f'.repeat(40), branch: gitBranch });
    const beforeMissing = requests.length;
    await expect(invoke('workers-deploy', { ...deploy, preparedNative: { projectName: scriptName } }))
      .rejects.toMatchObject({ code: 'deployment_content_unavailable' });
    expect(requests).toHaveLength(beforeMissing);
    missing = true;
    await expect(invoke('workers-deploy', deploy)).rejects.toMatchObject({ code: 'deployment_unavailable' });
    await expect(invoke('workers-inspect', input)).rejects.toMatchObject({ code: 'deployment_unavailable' });
    expect(requests.slice(beforeMissing).map(request => [request.method, request.url])).toEqual([
      ['POST', `${root}/builds/workers/${workerTag}/previews/${previewId}/builds`],
      ['GET', `${root}/workers/workers/${workerTag}`],
    ]);
    expect(requests.every(request => request.credentialBinding?.kind === 'connectedAccountPurpose'
      && request.credentialBinding.purpose === 'deploy.manage')).toBe(true);
  } finally { await kit.dispose(); }
});
