import { describe, expect, it } from 'vitest';

import { createEnvKeyScope } from '@/testkit/env/envScope';
import { openBrowser } from './openBrowser';

const envScope = createEnvKeyScope([
  'CI',
  'HAPPIER_NO_BROWSER_OPEN',
]);

function trySetStdoutIsTty(value: boolean): (() => void) | null {
  const desc = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  try {
    Object.defineProperty(process.stdout, 'isTTY', { value, configurable: true });
    return () => {
      try {
        if (desc) {
          Object.defineProperty(process.stdout, 'isTTY', desc);
        }
      } catch {
        // ignore restore failures
      }
    };
  } catch {
    return null;
  }
}

describe('openBrowser', () => {
  it('returns false when HAPPIER_NO_BROWSER_OPEN is set', async () => {
    const restoreTty = trySetStdoutIsTty(true);
    envScope.patch({ HAPPIER_NO_BROWSER_OPEN: '1' });

    try {
      const ok = await openBrowser('https://example.com');
      expect(ok).toBe(false);
    } finally {
      envScope.restore();
      restoreTty?.();
    }
  });

  it('returns false in CI environments', async () => {
    const restoreTty = trySetStdoutIsTty(true);
    envScope.patch({
      CI: '1',
      HAPPIER_NO_BROWSER_OPEN: undefined,
    });

    try {
      const ok = await openBrowser('https://example.com');
      expect(ok).toBe(false);
    } finally {
      envScope.restore();
      restoreTty?.();
    }
  });

  it('returns false when stdout is not interactive', async () => {
    const restoreTty = trySetStdoutIsTty(false);
    envScope.patch({
      CI: undefined,
      HAPPIER_NO_BROWSER_OPEN: undefined,
    });

    try {
      const ok = await openBrowser('https://example.com');
      expect(ok).toBe(false);
    } finally {
      envScope.restore();
      restoreTty?.();
    }
  });
});
