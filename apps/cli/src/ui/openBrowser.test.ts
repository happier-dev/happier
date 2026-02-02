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
});
