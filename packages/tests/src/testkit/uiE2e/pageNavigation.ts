import type { Page } from '@playwright/test';

export function normalizeLoopbackBaseUrl(input: string): string {
  try {
    const parsed = new URL(input);
    if (parsed.hostname === 'localhost') parsed.hostname = '127.0.0.1';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return input.replace(/\/+$/, '');
  }
}

export async function gotoDomContentLoadedWithRetries(page: Page, url: string, timeoutMs = 90_000): Promise<void> {
  const retryable = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('net::ERR_NETWORK_CHANGED')
      || message.includes('net::ERR_CONNECTION_REFUSED')
      || message.includes('net::ERR_CONNECTION_RESET')
      || message.includes('net::ERR_ABORTED')
    );
  };

  const start = Date.now();
  let attempt = 0;
  // Metro can briefly restart or drop connections during bundling; retry a few times for stability.
  while (attempt < 4) {
    attempt += 1;
    try {
      const remaining = Math.max(5_000, timeoutMs - (Date.now() - start));
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: remaining });
      return;
    } catch (error) {
      if (attempt >= 4 || !retryable(error)) throw error;
      await page.waitForTimeout(500 * attempt);
    }
  }
}

