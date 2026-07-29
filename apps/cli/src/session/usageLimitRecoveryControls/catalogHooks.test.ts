import { describe, expect, it } from 'vitest';

import { resolveInactiveSessionUsageLimitRecoveryControls } from './catalogHooks';

describe('usage-limit recovery catalog hooks', () => {
  it('resolves a fresh native inactive adapter only for declared capabilities', async () => {
    const first = await resolveInactiveSessionUsageLimitRecoveryControls('codex');
    const second = await resolveInactiveSessionUsageLimitRecoveryControls('codex');

    expect(first).toMatchObject({
      checkNow: expect.any(Function),
    });
    expect(second).not.toBe(first);
    expect(first).not.toHaveProperty('legacy');
    await expect(resolveInactiveSessionUsageLimitRecoveryControls('ohMyPi')).resolves.toBeNull();
  });
});
