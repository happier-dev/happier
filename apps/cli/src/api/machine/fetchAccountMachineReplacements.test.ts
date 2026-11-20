import { describe, expect, it } from 'vitest';
import fastify from 'fastify';
import { resolveCanonicalMachineId } from '@happier-dev/protocol';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';
import { fetchAccountMachineReplacements } from './fetchAccountMachineReplacements';

describe('retained Machine replacement identity', () => {
  it('preserves a revoked predecessor for the real canonical replacement walk', async () => {
    const origin = 'https://home.example.test';
    const app = fastify();
    app.get<{ Querystring: { includeRevoked?: string } }>('/v1/machines', async ({ query }) => (
      query.includeRevoked === 'true'
        ? [{ id: 'old', replacedByMachineId: 'current', revokedAt: 1 }, { id: 'current' }]
        : [{ id: 'current' }]
    ));
    const restoreAdapter = installAxiosFastifyAdapter({ app, origin });
    try {
      const records = await fetchAccountMachineReplacements({
        credentials: { token: 'fixture-token' },
        serverUrl: origin,
      });
      expect(resolveCanonicalMachineId('old', records ?? [])?.machineId).toBe('current');
    } finally {
      restoreAdapter();
      await app.close();
    }
  });
});
