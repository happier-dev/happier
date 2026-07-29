import { describe, expect, it } from 'vitest';

import {
  getManagedServerLaunchSpec,
  getManagedServerShutdownCleanup,
  listManagedServerClaimDescriptors,
} from './catalogHooks';

describe('managed-server catalog hooks', () => {
  it('loads managed-server launch, shutdown, and claim hooks from daemon ownership', async () => {
    await expect(getManagedServerLaunchSpec('opencode')).resolves.toMatchObject({
      command: expect.any(String),
      args: expect.any(Array),
    });
    await expect(getManagedServerShutdownCleanup('opencode')).resolves.toBeTypeOf('function');

    const descriptors = await listManagedServerClaimDescriptors();
    expect(descriptors).toEqual(expect.arrayContaining([
      expect.objectContaining({
        agentId: 'opencode',
        statePathEnvKey: expect.any(String),
        isExpectedProcessCommand: expect.any(Function),
      }),
    ]));
  });
});
