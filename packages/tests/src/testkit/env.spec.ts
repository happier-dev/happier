import { describe, expect, it } from 'vitest';

import {
  applyEnvOverrides,
  applyEnvValues,
  envFlag,
  restoreEnvValues,
  restoreProcessEnv,
  snapshotEnvValues,
  snapshotProcessEnv,
  withEnvOverrides,
} from './env';

function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = prev;
  }
}

describe('envFlag', () => {
  it('accepts HAPPIER_* flags', () => {
    const prev = process.env.HAPPIER_E2E_SAVE_ARTIFACTS;
    process.env.HAPPIER_E2E_SAVE_ARTIFACTS = '1';
    try {
      expect(envFlag('HAPPIER_E2E_SAVE_ARTIFACTS', false)).toBe(true);
    } finally {
      restoreEnv('HAPPIER_E2E_SAVE_ARTIFACTS', prev);
    }
  });

  it('falls back from HAPPIER_* to HAPPY_* when unset', () => {
    const prevHappier = process.env.HAPPIER_E2E_SAVE_ARTIFACTS;
    const prevHappy = process.env.HAPPY_E2E_SAVE_ARTIFACTS;
    delete process.env.HAPPIER_E2E_SAVE_ARTIFACTS;
    process.env.HAPPY_E2E_SAVE_ARTIFACTS = '1';
    try {
      expect(envFlag('HAPPIER_E2E_SAVE_ARTIFACTS', false)).toBe(true);
    } finally {
      restoreEnv('HAPPIER_E2E_SAVE_ARTIFACTS', prevHappier);
      restoreEnv('HAPPY_E2E_SAVE_ARTIFACTS', prevHappy);
    }
  });

  it('falls back from HAPPY_* to HAPPIER_* when unset', () => {
    const prevHappier = process.env.HAPPIER_E2E_SAVE_ARTIFACTS;
    const prevHappy = process.env.HAPPY_E2E_SAVE_ARTIFACTS;
    delete process.env.HAPPY_E2E_SAVE_ARTIFACTS;
    process.env.HAPPIER_E2E_SAVE_ARTIFACTS = '1';
    try {
      expect(envFlag('HAPPY_E2E_SAVE_ARTIFACTS', false)).toBe(true);
    } finally {
      restoreEnv('HAPPIER_E2E_SAVE_ARTIFACTS', prevHappier);
      restoreEnv('HAPPY_E2E_SAVE_ARTIFACTS', prevHappy);
    }
  });

  it('accepts multiple keys and returns the first match', () => {
    const prevHappier = process.env.HAPPIER_E2E_SAVE_ARTIFACTS;
    const prevHappy = process.env.HAPPY_E2E_SAVE_ARTIFACTS;
    delete process.env.HAPPIER_E2E_SAVE_ARTIFACTS;
    process.env.HAPPY_E2E_SAVE_ARTIFACTS = '1';
    try {
      expect(envFlag(['HAPPIER_E2E_SAVE_ARTIFACTS', 'HAPPY_E2E_SAVE_ARTIFACTS'], false)).toBe(true);
    } finally {
      restoreEnv('HAPPIER_E2E_SAVE_ARTIFACTS', prevHappier);
      restoreEnv('HAPPY_E2E_SAVE_ARTIFACTS', prevHappy);
    }
  });
});

describe('applyEnvOverrides', () => {
  it('restores previous values after applying overrides', () => {
    const prevEnabled = process.env.HAPPIER_TEST_ENABLED;
    const prevRemoved = process.env.HAPPIER_TEST_REMOVED;
    process.env.HAPPIER_TEST_ENABLED = 'before';
    process.env.HAPPIER_TEST_REMOVED = 'remove-me';

    const restore = applyEnvOverrides({
      HAPPIER_TEST_ENABLED: 'after',
      HAPPIER_TEST_REMOVED: undefined,
      HAPPIER_TEST_CREATED: 'created',
    });

    expect(process.env.HAPPIER_TEST_ENABLED).toBe('after');
    expect(process.env.HAPPIER_TEST_REMOVED).toBeUndefined();
    expect(process.env.HAPPIER_TEST_CREATED).toBe('created');

    restore();

    expect(process.env.HAPPIER_TEST_ENABLED).toBe('before');
    expect(process.env.HAPPIER_TEST_REMOVED).toBe('remove-me');
    expect(process.env.HAPPIER_TEST_CREATED).toBeUndefined();

    restoreEnv('HAPPIER_TEST_ENABLED', prevEnabled);
    restoreEnv('HAPPIER_TEST_REMOVED', prevRemoved);
  });
});

describe('withEnvOverrides', () => {
  it('restores env after a successful callback', async () => {
    const prev = process.env.HAPPIER_TEST_SCOPED;
    process.env.HAPPIER_TEST_SCOPED = 'before';

    await withEnvOverrides({ HAPPIER_TEST_SCOPED: 'during' }, async () => {
      expect(process.env.HAPPIER_TEST_SCOPED).toBe('during');
    });

    expect(process.env.HAPPIER_TEST_SCOPED).toBe('before');
    restoreEnv('HAPPIER_TEST_SCOPED', prev);
  });

  it('restores env after a failing callback', async () => {
    const prev = process.env.HAPPIER_TEST_FAILING_SCOPE;
    delete process.env.HAPPIER_TEST_FAILING_SCOPE;

    await expect(
      withEnvOverrides({ HAPPIER_TEST_FAILING_SCOPE: 'during' }, async () => {
        expect(process.env.HAPPIER_TEST_FAILING_SCOPE).toBe('during');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(process.env.HAPPIER_TEST_FAILING_SCOPE).toBeUndefined();
    restoreEnv('HAPPIER_TEST_FAILING_SCOPE', prev);
  });
});

describe('env snapshots', () => {
  it('captures and restores selected values', () => {
    const prevAlpha = process.env.HAPPIER_TEST_ALPHA;
    const prevBeta = process.env.HAPPIER_TEST_BETA;

    process.env.HAPPIER_TEST_ALPHA = 'before-alpha';
    delete process.env.HAPPIER_TEST_BETA;

    const snapshot = snapshotEnvValues(['HAPPIER_TEST_ALPHA', 'HAPPIER_TEST_BETA']);
    applyEnvValues({
      HAPPIER_TEST_ALPHA: 'after-alpha',
      HAPPIER_TEST_BETA: 'after-beta',
    });

    expect(process.env.HAPPIER_TEST_ALPHA).toBe('after-alpha');
    expect(process.env.HAPPIER_TEST_BETA).toBe('after-beta');

    restoreEnvValues(snapshot);

    expect(process.env.HAPPIER_TEST_ALPHA).toBe('before-alpha');
    expect(process.env.HAPPIER_TEST_BETA).toBeUndefined();

    restoreEnv('HAPPIER_TEST_ALPHA', prevAlpha);
    restoreEnv('HAPPIER_TEST_BETA', prevBeta);
  });

  it('captures and restores the full process env', () => {
    const snapshot = snapshotProcessEnv();
    const injectedKey = 'HAPPIER_TEST_FULL_RESTORE';
    const originalPath = process.env.PATH;

    process.env[injectedKey] = 'temporary';
    delete process.env.PATH;

    restoreProcessEnv(snapshot);

    expect(process.env[injectedKey]).toBeUndefined();
    expect(process.env.PATH).toBe(originalPath);
  });
});
