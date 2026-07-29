import { describe, expect, it, vi } from 'vitest';

import { resolveCliTestLaunchSpecOrOverride, type CliTestLaunchSpec } from './cliLaunchSpec';

describe('resolveCliTestLaunchSpecOrOverride', () => {
  it('uses an explicit packed-candidate launch spec without resolving checkout source or dist', async () => {
    const explicit: CliTestLaunchSpec = {
      command: process.execPath,
      args: ['/candidate/node_modules/@happier-dev/cli/bin/happier.mjs'],
      cwd: '/candidate',
    };
    const resolveDefault = vi.fn();

    await expect(resolveCliTestLaunchSpecOrOverride(explicit, resolveDefault)).resolves.toBe(explicit);
    expect(resolveDefault).not.toHaveBeenCalled();
  });

  it('resolves the normal test launch spec when no explicit candidate is supplied', async () => {
    const fallback: CliTestLaunchSpec = { command: 'fallback', args: [] };
    const resolveDefault = vi.fn(async () => fallback);

    await expect(resolveCliTestLaunchSpecOrOverride(undefined, resolveDefault)).resolves.toBe(fallback);
    expect(resolveDefault).toHaveBeenCalledTimes(1);
  });
});
