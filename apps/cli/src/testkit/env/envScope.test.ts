import { describe, expect, it } from 'vitest';

describe('env scope helpers', () => {
  it('patches and restores selected environment keys', async () => {
    const envScope = await import('@/testkit/env/envScope').catch(() => null);

    expect(envScope).not.toBeNull();
    expect(envScope?.createEnvKeyScope).toBeTypeOf('function');

    const previous = process.env.HAPPIER_TESTKIT_ENV_SCOPE;
    const scope = envScope!.createEnvKeyScope(['HAPPIER_TESTKIT_ENV_SCOPE']);

    try {
      scope.patch({ HAPPIER_TESTKIT_ENV_SCOPE: 'patched' });
      expect(process.env.HAPPIER_TESTKIT_ENV_SCOPE).toBe('patched');
    } finally {
      scope.restore();
      if (previous === undefined) {
        expect(process.env.HAPPIER_TESTKIT_ENV_SCOPE).toBeUndefined();
      } else {
        expect(process.env.HAPPIER_TESTKIT_ENV_SCOPE).toBe(previous);
      }
    }
  });
});
