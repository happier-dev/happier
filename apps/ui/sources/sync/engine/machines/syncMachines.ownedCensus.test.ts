import { describe, expect, it, vi } from 'vitest';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { fetchLiveOwnedMachineRows } from './syncMachines';

vi.mock('@/log', () => ({ log: { log: vi.fn() } }));

const credentials = {
  token: `e30.${btoa(JSON.stringify({ sub: 'account-a' }))}.signature`,
} satisfies AuthCredentials;

describe('fetchLiveOwnedMachineRows', () => {
  it('keeps the Account’s own rows, including offline and access-less Machines, and drops retired and shared rows', async () => {
    const owned = createPlainMachineRowFixture({
      id: 'owned',
      accountId: 'account-a',
    });
    const shared = createPlainMachineRowFixture({
      id: 'shared',
      accountId: 'account-b',
    });
    const { access: _access, ...legacy } = createPlainMachineRowFixture({
      id: 'legacy-own',
      accountId: 'account-a',
    });
    const revoked = {
      ...createPlainMachineRowFixture({
        id: 'revoked-own',
        accountId: 'account-a',
      }),
      revokedAt: 1,
    };
    const retired = { ...owned, id: 'retired-own', replacedByMachineId: owned.id };
    const paths: string[] = [];
    const rows = await fetchLiveOwnedMachineRows({
      credentials,
      accountId: 'account-a',
      fresh: true,
      request: async (path) => {
        paths.push(path);
        return new Response(JSON.stringify([owned, shared, legacy, revoked, retired]), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    });
    expect(rows.map((row) => row.id)).toEqual([
      'owned',
      'legacy-own',
    ]);
    expect(paths).toEqual(['/v1/machines?includeRevoked=true']);
  });
});
