import { describe, expect, it } from 'vitest';

describe('env snapshot helpers', () => {
  it('snapshots and restores process.env values', async () => {
    const envSnapshot = await import('@/testkit/env/envSnapshot').catch(() => null);

    expect(envSnapshot).not.toBeNull();
    expect(envSnapshot?.snapshotProcessEnv).toBeTypeOf('function');
    expect(envSnapshot?.restoreProcessEnv).toBeTypeOf('function');

    const original = process.env.HAPPIER_TESTKIT_ENV_SNAPSHOT;
    const snapshot = envSnapshot!.snapshotProcessEnv();

    process.env.HAPPIER_TESTKIT_ENV_SNAPSHOT = 'mutated';
    envSnapshot!.restoreProcessEnv(snapshot);

    if (original === undefined) {
      expect(process.env.HAPPIER_TESTKIT_ENV_SNAPSHOT).toBeUndefined();
    } else {
      expect(process.env.HAPPIER_TESTKIT_ENV_SNAPSHOT).toBe(original);
    }
  });
});
