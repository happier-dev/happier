import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createUnavailableActionTransportDeps } from '../../../testkit/actionTransportDeps';

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
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...inventory });
    await expect(executor.execute('servers.list', {})).resolves.toMatchObject({
      ok: false,
      errorCode: 'action_failed',
    });
  });
});
