import { describe, expect, it, vi } from 'vitest';

const listServerProfiles = vi.fn();
vi.mock('@/server/serverProfiles', async importOriginal => ({
  ...await importOriginal<typeof import('@/server/serverProfiles')>(),
  listServerProfiles,
}));

import { createCliActionInventoryDeps } from './createCliActionInventoryDeps';

describe('createCliActionInventoryDeps server profile failures', () => {
  it('keeps a profile-store failure typed instead of presenting an empty inventory', async () => {
    listServerProfiles.mockRejectedValueOnce(new Error('profile store unavailable'));
    const inventory = createCliActionInventoryDeps({ token: 'fixture-token', sessionId: '', mode: 'plain', ctx: null });
    await expect(inventory.serversList({})).rejects.toThrow('profile store unavailable');
  });
});
