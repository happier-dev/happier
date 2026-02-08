import { describe, expect, it } from 'vitest';

import { envFlag } from './env';

describe('envFlag', () => {
  const restoreEnv = (key: string, prev: string | undefined) => {
    if (prev === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = prev;
    }
  };

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
