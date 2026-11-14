import { expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from '../index.js';

const credentialRef = { service: { pluginId: entry.manifest.id, localId: 'cloudflare' }, accountId: 'selected-profile' };
const preparation = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1, credentialRef,
  credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: { consumer: { pluginId: entry.manifest.id,
    localId: 'pages-inspect' }, purpose: 'deploy.manage' }, target: { kind: 'account', account: credentialRef } },
  providerIdentity: { providerAccountId: 'account', providerResourceId: 'project-id', providerEnvironment: 'production' },
  providerEnvironment: { kind: 'production' }, preparedNative: { projectName: 'existing-pages' } };
const repository = { kind: 'gitlab', deployment: 'https://gitlab.com', repository: 'example/app' };

it('prepares and links a direct upload without requiring provider Git access', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true,
      result: { id: 'project-id', name: 'existing-pages', production_branch: 'main' } })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const prepared = await kit.invokeAction('pages-inspect', { ...preparation, repository, sourceMethod: 'upload' });
    expect(prepared).toMatchObject({ sourceMethod: 'upload', providerIdentity: preparation.providerIdentity,
      preparedNative: { reviewNotice: expect.stringContaining('Wrangler'), pages: { projectMode: 'directUpload' } } });
    expect(prepared).not.toHaveProperty('repositoryAccess');
    if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) throw new Error('Expected prepared Pages project');
    expect(await kit.invokeAction('pages-link', { ...preparation, ...prepared })).toEqual(prepared);
    expect(requests.map(request => [request.method, new URL(request.url).pathname]))
      .toEqual([['GET', '/client/v4/accounts/account/pages/projects/existing-pages']]);
  } finally { await kit.dispose(); }
});

it('adopts the exact existing Pages project, discloses native mode/build configuration and links without another provider read', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true,
      result: { id: 'project-id', name: 'existing-pages', production_branch: 'main',
        source: { type: 'github', config: { owner: 'other', repo_name: 'provider-repo' } },
        build_config: { build_command: 'npm run build', destination_dir: 'dist', root_dir: 'web' },
        deployment_configs: { production: { env_vars: { PRIVATE: { value: 'private-provider-value' } } } } } })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    const target = entry.manifest.contributes.deploymentTargets.find(value => value.targetKind === 'cloudflare-pages');
    expect(target).toMatchObject({ actions: { inspect: 'pages-inspect', link: 'pages-link', uploadDeploy: 'pages-upload', observe: 'pages-observe' } });
    expect(target?.role === 'runtime' && target.actions).not.toHaveProperty('cancel');
    const prepared = await kit.invokeAction('pages-inspect', { ...preparation, repository });
    expect(prepared).toMatchObject({ credentialPrincipal: preparation.credentialPrincipal,
      providerIdentity: preparation.providerIdentity, repositoryAccess: { status: 'needsGitAccess', repository },
      preparedNative: { projectName: 'existing-pages', pages: { projectMode: 'gitIntegration', productionBranch: 'main',
        buildCommand: 'npm run build', buildOutputDirectory: 'dist', rootDirectory: 'web' } } });
    expect(JSON.stringify(prepared)).not.toContain('private-provider-value');
    if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) throw new Error('Expected prepared Pages project');
    expect(await kit.invokeAction('pages-link', { ...preparation, ...prepared })).toEqual(prepared);
    expect(requests.map(request => [request.method, request.url])).toEqual([
      ['GET', 'https://api.cloudflare.com/client/v4/accounts/account/pages/projects/existing-pages'],
    ]);
    expect(requests[0].credentialBinding).toMatchObject({ purpose: 'deploy.manage', method: 'GET' });
  } finally { await kit.dispose(); }
});

it('refuses a mismatched adopted project instead of selecting by display name or creating another resource', async () => {
  const requests: HttpRequest[] = [];
  const http = createPluginHttpFixture({ async request(request) {
    requests.push(request);
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true,
      result: { id: 'another-project-id', name: 'existing-pages', production_branch: 'main' } })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction('pages-inspect', { ...preparation, repository }))
      .rejects.toMatchObject({ code: 'provider_response_invalid' });
    expect(requests.map(request => request.method)).toEqual(['GET']);
  } finally { await kit.dispose(); }
});

it.each(['../../outside', '/outside', 'C:\\outside'])('refuses provider build root %s before admitting a Pages link', async rootDirectory => {
  const http = createPluginHttpFixture({ async request() {
    return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true,
      result: { id: 'project-id', name: 'existing-pages', production_branch: 'main', build_config: { root_dir: rootDirectory } } })) };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  try {
    await expect(kit.invokeAction('pages-inspect', { ...preparation, repository })).rejects.toMatchObject({ code: 'provider_response_invalid' });
  } finally { await kit.dispose(); }
});
