import { describe, expect, it } from 'vitest';

describe('Protocol root permission-mediation import closure', () => {
  it('loads the canonical Action catalog with every registered mediation Action', async () => {
    const protocol = await import('./index.js');

    for (const actionId of [
      'session.permission.remote.pending.list',
      'session.permission.remote.respond',
      'session.permission.remote.grants.list',
      'session.permission.remote.grants.revoke',
    ] as const) {
      expect(protocol.getActionSpec(actionId).id).toBe(actionId);
    }
  }, 30_000);
});
