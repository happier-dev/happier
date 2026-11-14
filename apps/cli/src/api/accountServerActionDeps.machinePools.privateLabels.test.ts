import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fastify from 'fastify';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createAccountServerActionDeps } from './accountServerActionDeps';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';

const poolId = '99d55938-f860-4af8-8023-01fecec86f35';
const label = { content: { t: 'plain' as const, v: 'Private workers' }, recipientEnvelope: null };
const wire = { pool: { id: poolId, name: { kind: 'available' as const, label }, description: null,
  revision: 0, createdAt: 1, updatedAt: 1, members: [] },
  availability: { state: 'known' as const, connectedCount: 0, enabledCount: 0 } };

describe('Machine Pool recipient labels through Account HTTP Actions', () => {
  let app = fastify();
  let restore = () => {};
  beforeEach(() => {
    app = fastify();
    restore = installAxiosFastifyAdapter({ app, origin: 'http://account.test' });
    app.get('/v1/account/encryption/currentness', async () => ({ mode: 'plain', version: 1,
      settingsVersion: 1, signingKeyFingerprint: null, contentKeyFingerprint: null, updatedAt: 1 }));
    app.post('/v1/machines/pools/get', async () => wire);
    app.post('/v1/machines/pools/list', async () => ({ pools: [wire] }));
  });
  afterEach(async () => { restore(); await app.close(); });
  it('opens server wire projections before the shared Action validates and exposes the result', async () => {
    const executor = createActionExecutor(createAccountServerActionDeps({ token: 'bound-home-token',
      serverId: 'home', serverHttpBaseUrl: 'http://account.test' }));
    await expect(executor.execute('machines.pools.get', { poolId }, { surface: 'cli' }))
      .resolves.toMatchObject({ ok: true, result: { pool: { id: poolId, name: 'Private workers' } } });
    await expect(executor.execute('machines.pools.list', {}, { surface: 'cli' }))
      .resolves.toMatchObject({ ok: true, result: { pools: [{ pool: { name: 'Private workers' } }] } });
  });
});
