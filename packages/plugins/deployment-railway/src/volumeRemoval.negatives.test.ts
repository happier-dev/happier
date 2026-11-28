import { describe, expect, it } from 'vitest';
import { createPluginHttpFixture, createPluginTestkit } from '@happier-dev/plugin-sdk/testing';
import type { HttpRequest } from '@happier-dev/plugin-sdk/http';
import * as entry from './index.js';

const credentialRef = { service: { pluginId: 'happier.machine.railway', localId: 'railway-account' }, accountId: 'connected' };
function preparation(localId: string) {
  return { v: 1, serverId: 'home', environmentId: 'happier-env', expectedRevision: 1, credentialRef,
    credentialPrincipal: { kind: 'account', accountId: 'owner',
      purpose: { consumer: { pluginId: 'happier.deploy.railway-data', localId }, purpose: 'cloud-api' },
      target: { kind: 'account', account: credentialRef } },
    providerEnvironment: { kind: 'native', selection: {} } };
}
const linkedScope = {
  providerIdentity: { providerAccountId: 'project-one', providerResourceId: 'database-one', providerEnvironment: 'production' },
  providerEnvironment: { kind: 'native', selection: { projectId: 'project-one', environmentId: 'production', serviceId: 'database-one' } },
  targetLinkId: 'data-link', expectedTargetLinkRevision: 1,
};
const page = <T>(nodes: T[], endCursor: string | null = null) => ({
  edges: nodes.map(node => ({ node })), pageInfo: { hasNextPage: endCursor !== null, endCursor },
});
const att = (environmentId: string, serviceId: string, volumeId: string, volume?: { id: string; name?: string }) => ({
  environmentId, serviceId, volumeId, deletedAt: null, isPendingDeletion: false, volume });
const inventory = (...envs: { id: string; name?: string; instances: ReturnType<typeof att>[] }[]) => ({ data: { project: {
  id: 'project-one', name: 'Billing',
  environments: page(envs.map(env => ({ id: env.id, name: env.name, volumeInstances: page(env.instances) }))) } } });
const exclusive = inventory({ id: 'production', instances: [att('production', 'database-one', 'vol-1')] });
const shared = inventory({ id: 'production', instances: [att('production', 'database-one', 'vol-1')] },
  { id: 'staging', instances: [att('staging', 'database-one', 'vol-1')] });
const absent = { data: { environment: { id: 'production', projectId: 'project-one',
  serviceInstances: { edges: [], pageInfo: { endCursor: null, hasNextPage: false } } } } };
const present = { data: { environment: { id: 'production', projectId: 'project-one', serviceInstances: { edges: [{ node: {
  serviceId: 'database-one', serviceName: 'Database', deletedAt: null, service: { templateId: 'pg-template' } } }],
  pageInfo: { endCursor: null, hasNextPage: false } } } } };

async function host(...replies: readonly unknown[]) {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const http = createPluginHttpFixture({ async request(request: HttpRequest) {
    const reply = replies[calls.length];
    calls.push(JSON.parse(new TextDecoder().decode(request.body)));
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'number') return { status: reply, body: new Uint8Array(), headers: {} };
    if (reply === undefined) throw new Error('unexpected extra Railway call: ' + calls.at(-1)?.query.slice(0, 60));
    return { status: 200, body: new TextEncoder().encode(JSON.stringify(reply)), headers: {} };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  const run = (localId: string, selection = linkedScope) => kit.invokeAction(localId, { ...preparation(localId), ...selection })
    .then(value => ({ value }), error => ({ error: error as { code?: string; data?: unknown } }));
  return { calls, kit, run };
}
const ops = (calls: { query: string }[]) => calls.map(({ query }) => query.includes('serviceDelete') ? 'serviceDelete'
  : query.includes('volumeDelete') ? 'volumeDelete' : query.includes('volumeInstances') ? 'volumeRead'
    : query.includes('serviceInstances') ? 'observe' : 'other');

describe('SEC negatives: Railway data Delete', () => {
  it('D1 inventory read fails: service deleted, no volume mutation, result kept-unchecked', async () => {
    const h = await host({ errors: [{ message: 'boom', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] }, { data: { serviceDelete: true } });
    try {
      const r = await h.run('database-delete');
      expect(ops(h.calls)).toEqual(['volumeRead', 'serviceDelete']);
      expect(r).toMatchObject({ value: { state: 'succeeded', volumeRemoval: { kind: 'kept-unchecked' } } });
    } finally { await h.kit.dispose(); }
  });

  it('D2 malformed inventory (null volumeInstances elsewhere): never volumeDelete', async () => {
    const h = await host({ data: { project: { id: 'project-one', environments: page([
      { id: 'production', volumeInstances: page([att('production', 'database-one', 'vol-1')]) },
      { id: 'staging', volumeInstances: null }]) } } }, { data: { serviceDelete: true } });
    try {
      const r = await h.run('database-delete');
      expect(ops(h.calls)).not.toContain('volumeDelete');
      expect(r).toMatchObject({ value: { volumeRemoval: { kind: 'kept-unchecked' } } });
    } finally { await h.kit.dispose(); }
  });

  it('D3 shared volume: never volumeDelete, result kept + https railway link', async () => {
    const h = await host(shared, { data: { serviceDelete: true } });
    try {
      const r = await h.run('database-delete');
      expect(ops(h.calls)).toEqual(['volumeRead', 'serviceDelete']);
      expect(r).toMatchObject({ value: { volumeRemoval: { kind: 'kept', otherEnvironments: 1,
        url: 'https://railway.com/project/project-one/volume/vol-1?environmentId=staging' } } });
    } finally { await h.kit.dispose(); }
  });

  it.each([
    { engine: 'PostgreSQL', serviceId: 'postgres-one', volumeName: 'postgres-data' },
    { engine: 'MySQL', serviceId: 'mysql-one', volumeName: 'mysql-data' },
  ])('$engine preview and confirmed Delete name the selected scope and volume without extra calls', async ({ serviceId, volumeName }) => {
    const named = inventory(
      { id: 'staging', name: 'Staging', instances: [att('staging', 'another-service', 'vol-2', { id: 'vol-2', name: 'staging-data' })] },
      { id: 'production', name: 'EU Production', instances: [att('production', serviceId, 'vol-1', { id: 'vol-1', name: volumeName })] },
    );
    const volume = { name: volumeName, provider: 'Railway' };
    const providerScope = { projectName: 'Billing', environmentName: 'EU Production' };
    const selection = { ...linkedScope,
      providerIdentity: { ...linkedScope.providerIdentity, providerResourceId: serviceId },
      providerEnvironment: { ...linkedScope.providerEnvironment,
        selection: { ...linkedScope.providerEnvironment.selection, serviceId } } };
    const preview = await host(named);
    const removal = await host(named, { data: { serviceDelete: true } }, { data: { volumeDelete: true } });
    try {
      const review = await preview.run('teardown-preview', selection);
      const deletion = await removal.run('database-delete', selection);
      expect(ops(preview.calls)).toEqual(['volumeRead']);
      expect(ops(removal.calls)).toEqual(['volumeRead', 'serviceDelete', 'volumeDelete']);
      expect(removal.calls[2]?.variables).toEqual({ volumeId: 'vol-1' });
      expect.soft(review).toEqual({ value: { providerScope, volumeRemoval: { kind: 'removed', volume } } });
      expect(deletion).toMatchObject({ value: { state: 'succeeded', volumeRemoval: { kind: 'removed', volume } } });
      expect(preview.calls[0]?.query).toMatch(/project\(id: \$projectId\)\s*\{\s*id name environments/u);
      expect(preview.calls[0]?.query).toMatch(/node\s*\{\s*id name volumeInstances/u);
      expect(removal.calls[0]?.query).toMatch(/volume\s*\{\s*id name\s*\}/u);
    } finally { await preview.kit.dispose(); await removal.kit.dispose(); }
  });

  it('names the preview scope even when the selected service has no volume', async () => {
    const h = await host(inventory({ id: 'production', name: 'EU Production', instances: [] }));
    try {
      await expect(h.run('teardown-preview')).resolves.toEqual({
        value: { providerScope: { projectName: 'Billing', environmentName: 'EU Production' } },
      });
      expect(ops(h.calls)).toEqual(['volumeRead']);
    } finally { await h.kit.dispose(); }
  });

  it('omits missing names from the preview and confirmed Delete', async () => {
    const unnamed = inventory({ id: 'production', instances: [att('production', 'database-one', 'vol-1', { id: 'vol-1' })] });
    const preview = await host(unnamed);
    const removal = await host(unnamed, { data: { serviceDelete: true } }, { data: { volumeDelete: true } });
    try {
      await expect(preview.run('teardown-preview')).resolves.toEqual({ value: { volumeRemoval: { kind: 'removed' } } });
      const deletion = await removal.run('database-delete');
      expect(deletion).toMatchObject({ value: { state: 'succeeded', volumeRemoval: { kind: 'removed' } } });
      expect(deletion).not.toHaveProperty('value.volumeRemoval.volume');
      expect(ops(preview.calls)).toEqual(['volumeRead']);
      expect(ops(removal.calls)).toEqual(['volumeRead', 'serviceDelete', 'volumeDelete']);
    } finally { await preview.kit.dispose(); await removal.kit.dispose(); }
  });

  it.each([
    { description: 'returns false', reply: { data: { serviceDelete: false } } },
    { description: 'loses its acknowledgement', reply: { errors: [{ extensions: { code: 'INTERNAL_SERVER_ERROR' } }] } },
  ])('D5 service delete $description and service is still present: volume kept unchecked', async ({ reply }) => {
    const h = await host(exclusive, reply, present);
    try {
      const r = await h.run('database-delete');
      expect(ops(h.calls)).toEqual(['volumeRead', 'serviceDelete', 'observe']);
      expect(r).toMatchObject({ error: { code: 'outcome_unknown',
        data: { details: { phase: 'teardown', volumeRemoval: { kind: 'kept-unchecked' } } } } });
    } finally { await h.kit.dispose(); }
  });

  it.each([404, 409, 429])('keeps the volume line when volumeDelete returns HTTP %i', async (status) => {
    const h = await host(exclusive, { data: { serviceDelete: true } }, status);
    try {
      const r = await h.run('database-delete');
      expect(ops(h.calls)).toEqual(['volumeRead', 'serviceDelete', 'volumeDelete']);
      expect(r).toMatchObject({ error: { code: 'railway_http_' + status,
        data: { details: { httpStatus: status, volumeRemoval: { kind: 'kept-unchecked' } } } } });
    } finally { await h.kit.dispose(); }
  });

  it('D6 service gone, volume delete loses its response: outcome_unknown naming the volume phase', async () => {
    const h = await host(exclusive, { data: { serviceDelete: true } }, new TypeError('private response'));
    try {
      const r = await h.run('database-delete');
      expect(ops(h.calls)).toEqual(['volumeRead', 'serviceDelete', 'volumeDelete']);
      expect(r).toMatchObject({ error: { code: 'outcome_unknown', data: { failureCause: { phase: 'deployment.railway.data.volume_delete' } } } });
    } finally { await h.kit.dispose(); }
  });

  it('keeps the volume failure phase after observing a service delete with a lost acknowledgement', async () => {
    const h = await host(exclusive, new TypeError('service response lost'), absent, new TypeError('volume response lost'));
    try {
      const r = await h.run('database-delete');
      expect(ops(h.calls)).toEqual(['volumeRead', 'serviceDelete', 'observe', 'volumeDelete']);
      expect(r).toMatchObject({ error: { code: 'outcome_unknown',
        data: { failureCause: { phase: 'deployment.railway.data.volume_delete' } } } });
    } finally { await h.kit.dispose(); }
  });

  it('D7 volumeDelete answers false: never reported removed', async () => {
    const h = await host(exclusive, { data: { serviceDelete: true } }, { data: { volumeDelete: false } });
    try {
      const r = await h.run('database-delete');
      expect(r).not.toMatchObject({ value: { volumeRemoval: { kind: 'removed' } } });
    } finally { await h.kit.dispose(); }
  });

  it('D8 retry after the service is already gone and its attachment no longer lists it: no volume mutation', async () => {
    const h = await host(inventory({ id: 'production', instances: [att('production', 'some-other-service', 'vol-2')] }),
      { data: { serviceDelete: false } }, absent);
    try {
      const r = await h.run('database-delete');
      expect(ops(h.calls)).toEqual(['volumeRead', 'serviceDelete', 'observe']);
      expect(r).toMatchObject({ value: { state: 'succeeded' } });
    } finally { await h.kit.dispose(); }
  });

  it('D9 observe-only role never reads or deletes a volume', async () => {
    const h = await host(absent);
    try {
      await h.run('database-removal-observe');
      expect(ops(h.calls)).toEqual(['observe']);
    } finally { await h.kit.dispose(); }
  });

  it('D10 preview sends no mutation; failed read is unchecked; shared shows kept', async () => {
    const a = await host(shared);
    const b = await host({ errors: [{ extensions: { code: 'INTERNAL_SERVER_ERROR' } }] });
    try {
      await expect(a.run('teardown-preview')).resolves.toMatchObject({ value: { volumeRemoval: { kind: 'kept', otherEnvironments: 1 } } });
      await expect(b.run('teardown-preview')).resolves.toMatchObject({ value: { volumeRemoval: { kind: 'unchecked' } } });
      expect([...ops(a.calls), ...ops(b.calls)]).toEqual(['volumeRead', 'volumeRead']);
    } finally { await a.kit.dispose(); await b.kit.dispose(); }
  });
});
