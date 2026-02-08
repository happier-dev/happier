import { describe, expect, it } from 'vitest';

import { openBrowser } from './openBrowser';

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
    const prev = process.env.HAPPIER_NO_BROWSER_OPEN;
    process.env.HAPPIER_NO_BROWSER_OPEN = '1';

    try {
      const ok = await openBrowser('https://example.com');
      expect(ok).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.HAPPIER_NO_BROWSER_OPEN;
      else process.env.HAPPIER_NO_BROWSER_OPEN = prev;
      restoreTty?.();
    }
  });

  it('returns false in CI environments', async () => {
    const restoreTty = trySetStdoutIsTty(true);
    const previousCi = process.env.CI;
    const previousNoBrowser = process.env.HAPPIER_NO_BROWSER_OPEN;
    delete process.env.HAPPIER_NO_BROWSER_OPEN;
    process.env.CI = '1';

    try {
      const ok = await openBrowser('https://example.com');
      expect(ok).toBe(false);
    } finally {
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
      if (previousNoBrowser === undefined) delete process.env.HAPPIER_NO_BROWSER_OPEN;
      else process.env.HAPPIER_NO_BROWSER_OPEN = previousNoBrowser;
      restoreTty?.();
    }
  });

  it('returns false when stdout is not interactive', async () => {
    const restoreTty = trySetStdoutIsTty(false);
    const previousCi = process.env.CI;
    const previousNoBrowser = process.env.HAPPIER_NO_BROWSER_OPEN;
    delete process.env.CI;
    delete process.env.HAPPIER_NO_BROWSER_OPEN;

    try {
      const ok = await openBrowser('https://example.com');
      expect(ok).toBe(false);
    } finally {
      if (previousCi === undefined) delete process.env.CI;
      else process.env.CI = previousCi;
      if (previousNoBrowser === undefined) delete process.env.HAPPIER_NO_BROWSER_OPEN;
      else process.env.HAPPIER_NO_BROWSER_OPEN = previousNoBrowser;
      restoreTty?.();
    }
  });
});
