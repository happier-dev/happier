import { expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from '../index.js';
import { projectDeploymentReceiptInvestigationV1 } from '@happier-dev/protocol/deployments/deploymentReceiptEventsV1';
import { resolvePublishTargetRecommendation } from '@happier-dev/protocol/deployments/resolvePublishTargetRecommendation';
import { DeploymentTargetLinkProviderContentV1ProtocolSchema, DeploymentTargetRoleResultV1ProtocolSchema, type JsonValue } from '@happier-dev/plugin-sdk';

// Provider response projection from the Pages create API example, read 2026-11-16.
// https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/create/
const credentialRef = { service: { pluginId: entry.manifest.id, localId: 'cloudflare' }, accountId: 'profile' };
it.each([
  { product: 'pages', sourceMethod: 'upload', notices: ['final at creation', 'Uploads build on the selected Machine'] },
  { product: 'pages', sourceMethod: 'gitIntegration', notices: ['final at creation', 'latest commit', 'branch'] },
  { product: 'workers', sourceMethod: 'upload', notices: ['controller', 'Wrangler'] },
  { product: 'workers', sourceMethod: 'gitIntegration', notices: ['Workers Builds', 'branch'] },
])('inspects the $product $sourceMethod notice before Create without resource discovery', async ({ product, sourceMethod, notices }) => {
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry });
  try {
    const providerEnvironment: JsonValue = { kind: 'native', selection: product === 'workers' ? { kind: 'script', scriptName: 'reviewed-app' } : { kind: 'production' } };
    const draft = { v: 1, serverId: 'home', credentialRef, providerEnvironment,
      credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: { consumer: { pluginId: entry.manifest.id,
        localId: 'targets-inspect-v1' }, purpose: 'deploy.manage' }, target: { kind: 'account', account: credentialRef } },
      product, sourceMethod };
    const result = await kit.invokeAction('targets-inspect-v1', draft);
    expect(result).toMatchObject({ preparedNative: { reviewNotice: expect.any(String) } });
    const notice = (result as { preparedNative: { reviewNotice: string } }).preparedNative.reviewNotice;
    for (const fact of notices) expect(notice).toContain(fact);
    if (sourceMethod === 'gitIntegration') expect(notice).not.toContain('Wrangler');
    const { product: _product, ...productDraft } = draft;
    const alias = `${product}-inspect`;
    expect(await kit.invokeAction(alias, { ...productDraft,
      credentialPrincipal: { ...draft.credentialPrincipal, purpose: { ...draft.credentialPrincipal.purpose,
        consumer: { pluginId: entry.manifest.id, localId: alias } } } })).toEqual(result);
  } finally { await kit.dispose(); }
});
function input(kind: string) {
  return { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1, credentialRef,
    credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: { consumer: { pluginId: entry.manifest.id,
      localId: 'pages-create' }, purpose: 'deploy.manage' }, target: { kind: 'account', account: credentialRef } },
    providerAccountId: 'account', providerEnvironment: { kind: 'native', selection: { kind: 'production' } }, requestKey: 'persisted-request',
    resourceName: 'my-project', sourceMethod: 'gitIntegration', productionBranch: 'main',
    repository: { kind, deployment: `https://${kind}.com`, repository: 'my-org/my-repo' } };
}
it.each(['github', 'gitlab'])('creates a %s Pages source and retains final mode and repository readiness', async kind => {
  const requests: HttpRequest[] = [];
  const source = { type: kind, config: { owner: 'my-org', repo_name: 'my-repo', production_branch: 'main' } };
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request(request) {
      requests.push(request);
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true,
        result: { id: 'project-id', name: 'my-project', production_branch: 'main', source } })) };
    } }),
  } });
  try {
    const result = await kit.invokeAction('pages-create', input(kind));
    expect(result).toMatchObject({ sourceMethod: 'gitIntegration', repositoryAccess: { status: 'ready', repository: input(kind).repository },
      preparedNative: { pages: { projectMode: 'gitIntegration', productionBranch: 'main' } } });
    expect(requests.map(r => [r.method, new URL(r.url).pathname])).toEqual([['POST', '/client/v4/accounts/account/pages/projects']]);
    expect(JSON.parse(new TextDecoder().decode(requests[0].body))).toEqual({ name: 'my-project', production_branch: 'main', source });
  } finally { await kit.dispose(); }
});
// Cloudflare client/v4 Workers Builds REST examples, checked 2026-11-23.
const buildTokenUuid = '42c231bf-fa21-41e4-94e8-5de1b555ba20';
const repoConnectionUuid = '9af1436c-bc09-428c-9dfa-ac29d927431e';
const triggerUuid = 'fbcb312f-859e-4a3c-bc81-43a7e9d36263';
function workerConnection(kind: 'github' | 'gitlab') {
  return { repo_connection_uuid: repoConnectionUuid, provider_type: kind, provider_account_id: '101',
    provider_account_name: 'my-org', repo_id: '100', repo_name: 'my-repo' };
}
function workersGitInput(kind: 'github' | 'gitlab') {
  const draft = input(kind);
  return { ...draft, credentialPrincipal: { ...draft.credentialPrincipal,
    purpose: { ...draft.credentialPrincipal.purpose, consumer: { pluginId: entry.manifest.id, localId: 'workers-create' } } },
    providerEnvironment: { kind: 'native', selection: { kind: 'script', scriptName: 'my-project',
      builds: { repositoryId: '100', namespaceId: '101', buildTokenUuid } } } };
}

it.each(['github', 'gitlab'] as const)('creates a Worker with a %s Builds trigger on its reviewed production branch', async kind => {
  const calls: Record<string, unknown>[] = [];
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request(request) {
      const path = new URL(request.url).pathname;
      const body: unknown = request.body === undefined ? undefined : JSON.parse(new TextDecoder().decode(request.body));
      calls.push({ path, method: request.method, body });
      const result = path.endsWith('/connections') ? workerConnection(kind)
        : path.endsWith('/triggers') ? { trigger_uuid: triggerUuid }
        : path.endsWith('/scripts') ? [{ id: 'my-project', tag: 'worker-tag' }]
        : { id: 'worker-id', name: 'my-project' };
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true, result })) };
    } }),
  } });
  try {
    const draft = workersGitInput(kind);
    const result = await kit.invokeAction('workers-create', draft);
    expect(result).toMatchObject({ sourceMethod: 'gitIntegration', repositoryAccess: { status: 'ready', repository: draft.repository },
      providerIdentity: { providerResourceId: 'worker-tag' }, preparedNative: { projectName: 'my-project', triggerUuid } });
    expect(calls).toEqual([
      { method: 'PUT', path: '/client/v4/accounts/account/builds/repos/connections',
        body: { provider_type: kind, provider_account_id: '101', provider_account_name: 'my-org', repo_id: '100', repo_name: 'my-repo' } },
      { method: 'POST', path: '/client/v4/accounts/account/workers/workers', body: expect.objectContaining({ name: 'my-project' }) },
      { method: 'GET', path: '/client/v4/accounts/account/workers/scripts', body: undefined },
      { method: 'POST', path: '/client/v4/accounts/account/builds/triggers',
        body: expect.objectContaining({ external_script_id: 'worker-tag', repo_connection_uuid: repoConnectionUuid,
          branch_includes: ['main'], branch_excludes: [], build_token_uuid: buildTokenUuid, deploy_command: 'npx wrangler deploy' }) },
    ]);
    expect(JSON.stringify(result)).not.toContain(buildTokenUuid);
  } finally { await kit.dispose(); }
});

it.each([
  { status: 403, nativeCode: 10000, code: 'cloudflare_builds_configuration_edit_required',
    details: { requiredPermission: 'Workers Builds Configuration (Edit)' } },
  { status: 404, nativeCode: 12000, code: 'needsGitAccess',
    details: { grantUrl: expect.stringContaining('dash.cloudflare.com') } },
  { status: 404, nativeCode: 8000008, code: 'needsGitAccess',
    details: { grantUrl: expect.stringContaining('dash.cloudflare.com') } },
])('surfaces the Builds repository connection refusal $code before creating a Worker', async ({ status, nativeCode, code, details }) => {
  const requests: HttpRequest[] = [];
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request(request) {
      requests.push(request);
      return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify({
        success: false, errors: [{ code: nativeCode }] })) };
    } }),
  } });
  try {
    await expect(kit.invokeAction('workers-create', workersGitInput('github')))
      .rejects.toMatchObject({ code, details: expect.objectContaining(details) });
    expect(requests.map(request => new URL(request.url).pathname)).toEqual(['/client/v4/accounts/account/builds/repos/connections']);
  } finally { await kit.dispose(); }
});

it.each([
  ['a different repository', { ...workerConnection('github'), repo_name: 'different-repo' }],
  ['an identity-free acknowledgement', { repo_connection_uuid: repoConnectionUuid }],
])('refuses to attach a production trigger to %s', async (_name, connection) => {
  const paths: string[] = [];
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request(request) {
      const path = new URL(request.url).pathname;
      paths.push(path);
      const result = path.endsWith('/connections') ? connection
        : path.endsWith('/triggers') ? { trigger_uuid: triggerUuid }
        : path.endsWith('/scripts') ? [{ id: 'my-project', tag: 'worker-tag' }]
        : { id: 'worker-id', name: 'my-project' };
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true, result })) };
    } }),
  } });
  try {
    await expect(kit.invokeAction('workers-create', workersGitInput('github')))
      .rejects.toMatchObject({ code: 'outcome_unknown' });
    expect(paths).toEqual(['/client/v4/accounts/account/builds/repos/connections']);
  } finally { await kit.dispose(); }
});

it.each([
  { status: 503, nativeCode: null },
  { status: 403, nativeCode: 10000 },
])('retains an acknowledged Worker and the trigger failure after HTTP $status', async ({ status, nativeCode }) => {
  const paths: string[] = [];
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request(request) {
      const path = new URL(request.url).pathname;
      paths.push(path);
      if (path.endsWith('/triggers')) return { status, headers: {}, body: nativeCode === null ? new Uint8Array()
        : new TextEncoder().encode(JSON.stringify({ success: false, errors: [{ code: nativeCode }] })) };
      const result = path.endsWith('/connections') ? workerConnection('github')
        : path.endsWith('/scripts') ? [{ id: 'my-project', tag: 'worker-tag' }]
        : { id: 'worker-id', name: 'my-project' };
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true, result })) };
    } }),
  } });
  try {
    const result = DeploymentTargetLinkProviderContentV1ProtocolSchema.parse(
      await kit.invokeAction('workers-create', workersGitInput('github')),
    );
    expect(result).toMatchObject({
      providerIdentity: { providerResourceId: 'worker-tag' },
      preparedNative: { productionBranchOutcome: { status: 'unconfirmed', requestedBranch: 'main',
        failureCause: { httpStatus: status, ...(nativeCode === null ? { errorCode: null } : {
          nativeErrorCode: String(nativeCode),
          errorCode: 'cloudflare_builds_configuration_edit_required',
        }) } } },
    });
    expect(result).not.toHaveProperty('preparedNative.productionBranchOutcome.failureCause.requiredPermission');
    expect(result).not.toHaveProperty('repositoryAccess.status', 'needsGitAccess');
    expect(paths.filter(path => path.endsWith('/triggers'))).toHaveLength(1);
  } finally { await kit.dispose(); }
});

it('keeps an acknowledged project identity and supplies the dashboard grant when its source is absent', async () => {
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request() {
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true,
        result: { id: 'project-id', name: 'my-project', production_branch: 'main' } })) };
    } }),
  } });
  try {
    expect(await kit.invokeAction('pages-create', input('github'))).toMatchObject({
      providerIdentity: { providerResourceId: 'project-id' }, repositoryAccess: { status: 'needsGitAccess', grantUrl: expect.stringContaining('dash.cloudflare.com') },
      preparedNative: { pages: { projectMode: 'directUpload' } },
    });
  } finally { await kit.dispose(); }
});

it('builds the Pages Git branch and reports the observed SHA through the receipt without relabelling it as the reviewed commit', async () => {
  const requests: HttpRequest[] = [];
  const sourceIntent = { kind: 'repository' as const, projectSourceId: 'source', sourceRevision: 1, sha: 'a'.repeat(40) };
  const builtSha = 'b'.repeat(40);
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: {
    http: createPluginHttpFixture({ async request(request) {
      requests.push(request);
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify({ success: true,
        result: { id: 'deployment', environment: 'production', latest_stage: { name: 'deploy', status: 'success' },
          deployment_trigger: { metadata: { branch: 'main', commit_hash: builtSha } } } })) };
    } }),
  } });
  try {
    const result = await kit.invokeAction('pages-deploy', { v: 1, credentialRef, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
      targetLinkId: 'link', expectedTargetLinkRevision: 1, deploymentId: 'receipt', expectedDeploymentRevision: 1, actionOperationId: 'operation',
      credentialPrincipal: input('github').credentialPrincipal, sourceMethod: 'gitIntegration', sourceIntent,
      providerIdentity: { providerAccountId: 'account', providerResourceId: 'project-id', providerEnvironment: 'production' },
      providerEnvironment: { kind: 'native', selection: { kind: 'production' } }, preparedNative: { projectName: 'my-project',
        pages: { projectMode: 'gitIntegration', productionBranch: 'main' } } });
    expect(result).toMatchObject({ state: 'succeeded', providerDeploymentId: 'deployment', builtSha });
    const contentType = requests[0].headers?.['content-type'];
    if (!contentType) throw new Error('Expected the native deployment form');
    const form = await new Response(Uint8Array.from(requests[0].body!), { headers: { 'content-type': contentType } }).formData();
    expect(form.get('branch')).toBe('main');
    expect(form.has('commit_hash')).toBe(false);
    expect(projectDeploymentReceiptInvestigationV1({ sourceIntent,
      platform: { observation: DeploymentTargetRoleResultV1ProtocolSchema.parse(result) } })).toMatchObject({ source: { sha: sourceIntent.sha, builtSha } });
  } finally { await kit.dispose(); }
});

it.each(['github', 'gitlab', 'bitbucket', 'gitea'])('offers executable Cloudflare source paths for %s', repositoryProviderKind => {
  const targets = entry.manifest.contributes.deploymentTargets!.filter(target => target.role === 'runtime').map(target => ({
    ...target, sources: target.sources ? { ...target.sources, gitIntegration: [...target.sources.gitIntegration] } : undefined,
    targetClass: 'platform' as const, availability: 'available' as const,
  }));
  const recommend = (output: 'static' | 'workers', uploadAvailable: boolean) => resolvePublishTargetRecommendation({
    definition: null, deploy: { framework: 'html', output }, targets, repositoryProviderKind,
    publishProviderKinds: [repositoryProviderKind], uploadAvailable,
  }).compatibleTargetIds;
  const pages = targets.find(target => target.targetKind === 'cloudflare-pages')!;
  const workers = targets.find(target => target.targetKind === 'cloudflare-workers')!;
  expect(recommend('static', false)).toEqual(['github', 'gitlab'].includes(repositoryProviderKind) ? [pages.id] : []);
  expect(recommend('static', true)).toEqual([pages.id]);
  expect(recommend('workers', false)).toEqual(['github', 'gitlab'].includes(repositoryProviderKind) ? [workers.id] : []);
  expect(recommend('workers', true)).toEqual([workers.id]);
});
