import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { ActionsService } from '@happier-dev/plugin-sdk/actions';
import { expect, it, vi } from 'vitest';
import * as plugin from '../index.js';
import { railwayAccount } from './fixtures/service.js';

const credentials = {
  credentialRef: railwayAccount,
  credentialPrincipal: {
    kind: 'account', accountId: 'owner',
    purpose: { consumer: { pluginId: 'happier.deploy.railway', localId: 'project-delete-preview' }, purpose: 'cloud-api' },
    target: { kind: 'account', account: railwayAccount },
  },
};
const accountScope = { serverId: 'home', accountId: 'owner' };
const project = { id: 'project', name: 'Orders' };
const environment = { id: 'staging', name: 'Staging' };
const checkout = { id: 'checkout', name: 'Checkout' };
const volume = { id: 'disk', name: 'Checkout data' };
const database = { id: 'orders-db', name: 'Orders database', templateId: 'postgres-template' };
const expectedDatabase = { id: database.id, name: database.name };
const happierEnvironment = { id: 'happier-staging', name: 'Orders staging' };
const link = { id: 'runtime-link', name: 'Orders runtime' };
const retainedLink = { id: 'previous-link', name: 'Previous runtime' };
const environmentReview = { scope: environment, environments: [], services: [checkout, expectedDatabase],
  databases: [expectedDatabase], volumes: [volume], happierEnvironments: [happierEnvironment], links: [link, retainedLink] };
const connection = (items: object[]) => ({ edges: items.map(node => ({ node })), pageInfo: { hasNextPage: false, endCursor: null } });

type Request = { query: string; variables: Record<string, unknown> };
const serviceNode = (service: { id: string; name: string; templateId?: string }) => ({ serviceId: service.id, serviceName: service.name, deletedAt: null,
  service: { templateId: service.templateId ?? null } });
const attachment = { environmentId: environment.id, serviceId: checkout.id, volumeId: volume.id, deletedAt: null,
  isPendingDeletion: false, volume };
function vendorInventory({ query }: Request, services: Array<{ id: string; name: string; templateId?: string }> = [checkout, database]) {
  const postgres = { id: database.templateId };
  if (query.includes('project(id:')) return { postgres, project: { ...project, services: connection(services),
    environments: connection([environment]), volumes: connection([volume]) } };
  if (query.includes('environment(id:')) return { postgres, environment: { ...environment, projectId: project.id,
    serviceInstances: connection(services.map(serviceNode)), volumeInstances: connection([attachment]) } };
  throw new Error('Unexpected Railway query');
}

function withVendor(
  respond: (request: Request) => unknown,
  run: (kit: Awaited<ReturnType<typeof createPluginTestkit>>, requests: readonly Request[]) => Promise<void>,
) {
  return (async () => {
    const requests: Request[] = [];
    const http = createPluginHttpFixture({ async request(request) {
      expect(request.credentialBinding).toMatchObject({ kind: 'connectedAccountPurpose', purpose: 'cloud-api' });
      const payload = JSON.parse(new TextDecoder().decode(request.body)) as Request;
      requests.push(payload);
      const result = respond(payload);
      return { status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(result)) };
    } });
    const revision = { headerVersion: 1, bodyVersion: 1 };
    // The host read boundary provides only the invoking Account's readable Environment and Artifact pages.
    const item = { ...happierEnvironment, projectSourceId: 'source' };
    const linkHeader = (item: { id: string }) => ({ id: item.id, environmentId: happierEnvironment.id, state: 'configured',
      source: { kind: 'plugin', contribution: { pluginId: plugin.manifest.id, localId: 'runtime' } },
      contentArtifactId: 'artifact-' + item.id, contentHeaderVersion: 1, contentBodyVersion: 1 });
    const otherLink = { id: 'sibling-link', name: 'Production runtime' };
    const visibleLinks = [link, retainedLink, otherLink];
    const execute = vi.fn(async (id: string, input: { serverId?: string; environmentId?: string; artifactId?: string }) => {
      if (id === 'deployments.environments.list') {
        expect(input.serverId).toBe(accountScope.serverId);
        return { ok: true, items: [item], nextCursor: null, runtimeTargetLinks: [linkHeader(link)] };
      }
      if (id === 'deployments.environments.get') {
        expect(input.environmentId).toBe(item.id);
        return { ok: true, environment: item, targetLinks: visibleLinks.map(linkHeader) };
      }
      expect(id).toBe('artifact.get');
      const stored = visibleLinks.find(candidate => input.artifactId === 'artifact-' + candidate.id);
      expect(stored).toBeDefined();
      return { artifact: { artifactId: input.artifactId, revision, header: { kind: 'deployment-target-link.v1', title: stored!.name },
        body: JSON.stringify({ providerIdentity: { providerAccountId: project.id,
          providerEnvironment: stored === otherLink ? 'production' : environment.id,
          providerResourceId: checkout.id } }) } };
    });
    const kit = await createPluginTestkit({ manifest: plugin.manifest, module: plugin, services: {
      http, actions: { execute } as unknown as ActionsService,
    } });
    try { await run(kit, requests); } finally { await kit.dispose(); }
  })();
}

it('previews the selected environment and its named inventory', () => withVendor(
  request => ({ data: vendorInventory(request) }),
  async (kit, requests) => {
    await expect(kit.invokeAction('environment-delete-preview', { ...credentials, projectId: project.id,
      environmentId: environment.id }, { accountScope })).resolves.toEqual(environmentReview);
    expect(requests.filter(request => request.query.includes('serviceInstances'))).toHaveLength(1);
    expect(requests.filter(request => request.query.includes('volumeInstances'))).toHaveLength(1);
    expect(requests.some(request => request.query.includes('mutation'))).toBe(false);
  },
));

it('refuses an addition or a mismatched scope name before sending any mutation', () => withVendor(
  request => ({ data: vendorInventory(request, [checkout, { id: 'reconciliation', name: 'Reconciliation' }]) }),
  async (kit, requests) => {
    const input = { ...credentials, projectId: project.id, environmentId: environment.id, ...environmentReview };
    await expect(kit.invokeAction('environment-delete', input)).rejects.toMatchObject({ code: 'railway_scope_review_again' });
    await expect(kit.invokeAction('environment-delete', { ...input, services: [...input.services, { id: 'reconciliation', name: 'Reconciliation' }],
      scope: { ...environment, name: 'Production' } })).rejects.toMatchObject({ code: 'railway_scope_review_again' });
    expect(requests.some(request => request.query.includes('mutation'))).toBe(false);
  },
));

it('refuses a volume found on a continuation page that was absent at preview', () => withVendor(
  request => {
    if (!request.query.includes('volumeInstances')) return { data: vendorInventory(request) };
    const late = { id: 'late-volume', name: 'Reconciliation data' };
    const first = request.variables.after === undefined;
    return { data: { environment: { ...environment, projectId: project.id, volumeInstances: first
      ? { ...connection([attachment]), pageInfo: { hasNextPage: true, endCursor: 'volumes-2' } }
      : connection([{ ...attachment, volumeId: late.id, volume: late }]) } } };
  },
  async (kit, requests) => {
    await expect(kit.invokeAction('environment-delete', { ...credentials, projectId: project.id,
      environmentId: environment.id, ...environmentReview })).rejects.toMatchObject({ code: 'railway_scope_review_again' });
    expect(requests.filter(request => request.query.includes('volumeInstances')).map(request => request.variables.after))
      .toEqual([undefined, 'volumes-2']);
    expect(requests).toHaveLength(3);
    expect(requests.some(request => request.query.includes('mutation'))).toBe(false);
  },
));

it('deletes only the reviewed environment even when a reviewed child has disappeared', () => withVendor(
  request => ({ data: request.query.includes('environmentDelete') ? { environmentDelete: true } : vendorInventory(request) }),
  async (kit, requests) => {
    await expect(kit.invokeAction('environment-delete', { ...credentials, projectId: project.id, environmentId: environment.id,
      ...environmentReview, services: [...environmentReview.services, { id: 'gone', name: 'Old worker' }] })).resolves.toEqual({ status: 'removed' });
    expect(requests.filter(request => request.query.includes('mutation')).map(request => request.variables)).toEqual([{ id: environment.id }]);
    expect(requests.filter(request => request.query.includes('serviceInstances'))).toHaveLength(1);
  },
));

it.each(['absent', 'present', 'read failed', 'lost acknowledgement', 'vendor refused'] as const)(
  'settles project deletion with %s', outcome => {
    let attempted = false;
    return withVendor(request => {
      if (request.query.includes('projectDelete')) {
        attempted = true;
        if (outcome === 'lost acknowledgement') throw new Error('Transport disconnected after send');
        if (outcome === 'vendor refused') return { errors: [{ extensions: { code: 'FORBIDDEN' } }] };
        return { data: { projectDelete: false } };
      }
      if (!attempted) return { data: vendorInventory(request) };
      if (outcome === 'read failed') throw new Error('Transport disconnected during confirmation');
      return { data: { project: outcome === 'present' ? project : null } };
    }, async (kit, requests) => {
      const review = await kit.invokeAction('project-delete-preview', { ...credentials, projectId: project.id }, { accountScope });
      expect(review).toMatchObject({ scope: project, environments: [environment], services: [checkout, expectedDatabase],
        databases: [expectedDatabase], volumes: [volume], links: [link, retainedLink, { id: 'sibling-link', name: 'Production runtime' }] });
      const previewRequests = requests.length;
      const result = kit.invokeAction('project-delete', { ...credentials, projectId: project.id,
        ...(review as typeof environmentReview) });
      if (outcome === 'vendor refused') {
        await expect(result).rejects.toMatchObject({ code: 'deployment_access_denied', data: { failureCause: { nativeErrorCode: 'FORBIDDEN' } } });
      } else {
        await expect(result).resolves.toEqual({ status: outcome === 'absent' || outcome === 'lost acknowledgement' ? 'removed' : 'kept-unchecked' });
      }
      const effectRequests = requests.slice(previewRequests);
      expect(effectRequests.find(request => request.query.includes('mutation'))?.variables).toEqual({ id: project.id });
      expect(effectRequests).toHaveLength(previewRequests + 1 + Number(outcome !== 'vendor refused'));
    });
  },
);
