import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import { PluginError } from '@happier-dev/plugin-sdk/errors';
import { expect, it } from 'vitest';
import * as plugin from '../index.js';
import { railwayIdentity } from './account.js';
import { nativeDeploymentId, providerEnvironment, providerIdentity, providerObservation, railwayAccount,
  railwayServiceInstance, repository, reviewedSha } from './fixtures/service.js';

const base = { v: 1, serverId: 'home', environmentId: 'environment', expectedRevision: 1,
  credentialRef: railwayAccount, credentialPrincipal: { kind: 'account', accountId: 'owner', purpose: {
    consumer: { pluginId: railwayIdentity.id, localId: 'targets-inspect-v1' }, purpose: 'cloud-api' },
    target: { kind: 'account', account: railwayAccount } }, providerIdentity, providerEnvironment,
};
const lifecycle = { ...base, targetLinkId: 'link', expectedTargetLinkRevision: 1, deploymentId: 'local-deployment',
  expectedDeploymentRevision: 1, actionOperationId: 'operation', preparedNative: { projectName: 'Backend' },
  repositoryAccess: { status: 'ready', repository } };
const deploy = { ...lifecycle, sourceMethod: 'gitIntegration', sourceIntent: { kind: 'repository', projectSourceId: 'source',
  sourceRevision: 1, sha: reviewedSha } };
const coordinates = providerEnvironment.selection;

type GraphqlRequest = { query: string; variables: Record<string, unknown> };
function withVendor(respond: (request: GraphqlRequest) => unknown, run: (kit: Awaited<ReturnType<typeof createPluginTestkit>>,
  requests: readonly GraphqlRequest[]) => Promise<void>) {
  return (async () => {
    const requests: GraphqlRequest[] = [];
    const http = createPluginHttpFixture({ async request(request) {
      expect(request.url).toBe('https://backboard.railway.com/graphql/v2');
      expect(request.credentialBinding).toMatchObject({ kind: 'connectedAccountPurpose', purpose: 'cloud-api' });
      const payload = JSON.parse(new TextDecoder().decode(request.body)) as GraphqlRequest;
      requests.push(payload);
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(respond(payload))) };
    } });
    const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: { http } });
    try { await run(kit, requests); } finally { await kit.dispose(); }
  })();
}

it.each([true, false])('inspects the selected service and reports Railway GitHub grant %s in one request', hasAccess =>
  withVendor(() => ({ data: { serviceInstance: railwayServiceInstance, gitHubRepoAccessAvailable: { hasAccess, isPublic: false } } }),
    async (kit, requests) => {
      await expect(kit.invokeAction('targets-inspect-v1', { ...base, repository })).resolves.toMatchObject({
        providerIdentity, providerEnvironment, sourceMethod: 'gitIntegration', preparedNative: { projectName: 'Backend' },
        repositoryAccess: hasAccess ? { status: 'ready', repository }
          : { status: 'needsGitAccess', repository, grantUrl: 'https://github.com/apps/railway-app' },
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.query).toContain('gitHubRepoAccessAvailable');
      expect(requests[0]?.variables).toMatchObject({ environmentId: coordinates.environmentId, serviceId: coordinates.serviceId });
    }));

it('uses retained repository readiness and triggers the exact reviewed SHA once', () => withVendor(() => ({ data:
  { serviceInstanceDeployV2: nativeDeploymentId } }),
async (kit, requests) => {
  await expect(kit.invokeAction('deploy', deploy)).resolves.toMatchObject({ state: 'queued', providerDeploymentId: nativeDeploymentId });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.query).toContain('serviceInstanceDeployV2');
  expect(requests[0]?.variables).toEqual({ environmentId: coordinates.environmentId, serviceId: coordinates.serviceId, commitSha: reviewedSha });
}));

it('preserves uncertainty when the exact deployment response exceeds the host limit', () => withVendor(() => {
  throw new PluginError({ code: 'plugin_fetch_response_too_large' });
}, async (kit, requests) => {
  await expect(kit.invokeAction('deploy', deploy)).rejects.toMatchObject({
    code: 'outcome_unknown',
    data: { failureCause: { errorCode: 'plugin_fetch_response_too_large' } },
  });
  expect(requests).toHaveLength(1);
}));

it('reports a repository mismatch during link inspection despite access to the requested repo', () => withVendor(() => ({ data: {
  serviceInstance: { ...railwayServiceInstance, source: { repo: 'other/backend', image: null } },
  gitHubRepoAccessAvailable: { hasAccess: true, isPublic: false },
} }), async (kit, requests) => {
  await expect(kit.invokeAction('targets-inspect-v1', { ...base, repository })).resolves.toMatchObject({
    repositoryAccess: { status: 'needsGitAccess', repository,
      grantUrl: 'https://docs.railway.com/services#deploying-from-a-github-repo' },
  });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.query.trim().startsWith('query')).toBe(true);
}));

it.each([true, false])('projects the service address only while this deployment is serving (%s)', serving => withVendor(() => ({ data: {
  deployment: providerObservation, serviceInstance: { ...railwayServiceInstance,
    activeDeployments: [{ id: serving ? nativeDeploymentId : 'different-deployment' }],
    domains: { serviceDomains: [{ domain: 'backend.up.railway.app', syncStatus: 'ACTIVE' }] } },
} }), async (kit, requests) => {
  const result = await kit.invokeAction('observe', { ...lifecycle, providerDeploymentId: nativeDeploymentId });
  expect(result).toMatchObject({ state: 'succeeded', builtSha: reviewedSha, providerDeploymentId: nativeDeploymentId });
  if (serving) expect(result).toMatchObject({ urls: ['https://backend.up.railway.app'], builtInUrls: ['https://backend.up.railway.app'] });
  else expect(result).not.toHaveProperty('urls');
  expect(requests).toHaveLength(1);
}));

it('cancels the retained deployment once and observes the acknowledgement', () =>
  withVendor(request => ({ data: request.query.includes('deploymentCancel') ? { deploymentCancel: true }
    : { deployment: { ...providerObservation, status: 'REMOVED' } } }), async (kit, requests) => {
    await expect(kit.invokeAction('cancel', { ...lifecycle, providerDeploymentId: nativeDeploymentId }))
      .resolves.toMatchObject({ state: 'cancelled', providerDeploymentId: nativeDeploymentId });
    expect(requests).toHaveLength(2);
    expect(requests[0]?.query).toContain('deploymentCancel');
    expect(requests[0]?.variables).toEqual({ id: nativeDeploymentId });
  }));

it('settles an acknowledged environment-scoped deletion without another read', () => withVendor(() => ({
  data: { serviceDelete: true },
}), async (kit, requests) => {
  await expect(kit.invokeAction('teardown', { ...lifecycle, operation: 'teardown' }))
    .resolves.toMatchObject({ state: 'succeeded', providerResourceAbsent: true });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.variables).toEqual({ id: coordinates.serviceId, environmentId: coordinates.environmentId });
}));

it('settles service removal from one Environment inventory read after a negative acknowledgement', () => withVendor(request => {
  if (request.query.includes('serviceDelete')) return { data: { serviceDelete: false } };
  return { data: { environment: { id: coordinates.environmentId, projectId: coordinates.projectId,
    serviceInstances: { edges: [{ node: { serviceId: 'other-service', serviceName: 'Other', deletedAt: null } }],
      pageInfo: { hasNextPage: false, endCursor: null } } } } };
}, async (kit, requests) => {
  await expect(kit.invokeAction('teardown', { ...lifecycle, operation: 'teardown' }))
    .resolves.toMatchObject({ state: 'succeeded', providerResourceAbsent: true });
  expect(requests).toHaveLength(2);
  expect(requests[0]?.variables).toEqual({ id: coordinates.serviceId, environmentId: coordinates.environmentId });
  expect(requests[1]?.variables).toMatchObject({ projectId: coordinates.projectId, environmentId: coordinates.environmentId });
}));

it('leaves a lost deletion reply unknown and observes the selected instance without repeating the delete', () => withVendor(request => {
  if (request.query.includes('serviceDelete')) throw new Error('Connection closed after the request was sent');
  return { data: { environment: { id: coordinates.environmentId, projectId: coordinates.projectId,
    serviceInstances: { edges: [{ node: { serviceId: 'other-service', serviceName: 'Other', deletedAt: null } }],
      pageInfo: { hasNextPage: false, endCursor: null } } } } };
}, async (kit, requests) => {
  await expect(kit.invokeAction('teardown', { ...lifecycle, operation: 'teardown' })).rejects.toMatchObject({
    code: 'outcome_unknown',
    data: { failureCause: { phase: 'deployment.railway.teardown.send', errorCode: 'railway_unavailable' } },
  });
  expect(requests).toHaveLength(1);
  await expect(kit.invokeAction('observe', { ...lifecycle, operation: 'teardown' }))
    .resolves.toMatchObject({ state: 'succeeded', providerResourceAbsent: true });
  expect(requests).toHaveLength(2);
  expect(requests[1]?.variables).toMatchObject({ projectId: coordinates.projectId, environmentId: coordinates.environmentId });
}));

it('leaves service removal uncertain after one incomplete Environment inventory read', () => withVendor(request => {
  if (request.query.includes('serviceDelete')) return { data: { serviceDelete: false } };
  return { data: { environment: { id: coordinates.environmentId, projectId: coordinates.projectId,
    serviceInstances: { edges: [{ node: { serviceId: 'other-service', serviceName: 'Other', deletedAt: null } }],
      pageInfo: { hasNextPage: request.variables.after === null, endCursor: 'next-page' } } } } };
}, async (kit, requests) => {
  await expect(kit.invokeAction('teardown', { ...lifecycle, operation: 'teardown' }))
    .rejects.toMatchObject({ code: 'outcome_unknown' });
  expect(requests).toHaveLength(2);
  expect(requests[1]?.variables).toEqual({ projectId: coordinates.projectId, environmentId: coordinates.environmentId, after: null });
}));

it('creates the Git-connected service in one mutation using the selected branch', () => withVendor(() => ({
  data: { serviceCreate: { id: coordinates.serviceId, projectId: coordinates.projectId, name: 'Backend' } },
}), async (kit, requests) => {
  const { providerIdentity: _existing, ...input } = base;
  await expect(kit.invokeAction('service-create', { ...input, sourceMethod: 'gitIntegration',
    providerAccountId: coordinates.projectId, providerEnvironment: { kind: 'native',
      selection: { projectId: coordinates.projectId, environmentId: coordinates.environmentId } },
    requestKey: 'create', resourceName: 'Backend', repository, productionBranch: 'feature/backend' }))
    .resolves.toMatchObject({ providerIdentity, providerEnvironment, repositoryAccess: { status: 'ready', repository } });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.query).toContain('serviceCreate');
  expect(requests[0]?.variables).toEqual({ input: { projectId: coordinates.projectId,
    environmentId: coordinates.environmentId, name: 'Backend', source: { repo: repository.repository },
    branch: 'feature/backend' } });
}));
