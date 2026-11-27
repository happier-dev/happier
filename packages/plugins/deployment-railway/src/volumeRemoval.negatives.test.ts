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
const att = (environmentId: string, serviceId: string, volumeId: string) => ({
  environmentId, serviceId, volumeId, deletedAt: null, isPendingDeletion: false });
const inventory = (...envs: { id: string; instances: ReturnType<typeof att>[] }[]) => ({ data: { project: { id: 'project-one',
  environments: page(envs.map(env => ({ id: env.id, volumeInstances: page(env.instances) }))) } } });
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
    if (reply === undefined) throw new Error('unexpected extra Railway call: ' + calls.at(-1)?.query.slice(0, 60));
    return { status: 200, body: new TextEncoder().encode(JSON.stringify(reply)), headers: {} };
  } });
  const kit = await createPluginTestkit({ manifest: entry.manifest, module: entry, services: { http } });
  const run = (localId: string) => kit.invokeAction(localId, { ...preparation(localId), ...linkedScope })
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

  it('D4 exclusive volume: service deleted FIRST, then exactly the reviewed volume id', async () => {
    const h = await host(exclusive, { data: { serviceDelete: true } }, { data: { volumeDelete: true } });
    try {
      const r = await h.run('database-delete');
      expect(ops(h.calls)).toEqual(['volumeRead', 'serviceDelete', 'volumeDelete']);
      expect(h.calls[2]?.variables).toEqual({ volumeId: 'vol-1' });
      expect(r).toMatchObject({ value: { state: 'succeeded', volumeRemoval: { kind: 'removed' } } });
    } finally { await h.kit.dispose(); }
  });

  it('D5 service delete fails and service still present: volume untouched', async () => {
    const h = await host(exclusive, { errors: [{ extensions: { code: 'INTERNAL_SERVER_ERROR' } }] }, present);
    try {
      const r = await h.run('database-delete');
      expect(ops(h.calls)).not.toContain('volumeDelete');
      expect(r).toMatchObject({ error: { code: 'outcome_unknown' } });
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
