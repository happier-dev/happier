import type { Page } from '@playwright/test';

export function normalizeLoopbackBaseUrl(input: string): string {
  try {
    const parsed = new URL(input);
    // Expo web dev server is started with `--host localhost`, and recent Webpack/Metro stacks can
    // reject loopback IP Host headers (127.0.0.1/::1) depending on allowedHosts configuration.
    // Normalise to `localhost` so deep links (e.g. /terminal/connect#key=...) work reliably in
    // Playwright E2E across environments.
    if (parsed.hostname === '127.0.0.1' || parsed.hostname === '0.0.0.0' || parsed.hostname === '::1') {
      parsed.hostname = 'localhost';
    }
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return input.replace(/\/+$/, '');
  }
}

export async function gotoDomContentLoadedWithRetries(page: Page, url: string, timeoutMs = 90_000): Promise<void> {
  const normalizeUrl = (value: string): string => value.replace(/\/+$/, '');
  const targetUrl = normalizeUrl(url);
  const retryable = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('net::ERR_NETWORK_CHANGED')
      || message.includes('net::ERR_CONNECTION_REFUSED')
      || message.includes('net::ERR_CONNECTION_RESET')
      || message.includes('net::ERR_ABORTED')
    );
  };

  const isCommittedTimeout = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes('timeout')) return false;
    return normalizeUrl(page.url()) === targetUrl;
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
      if (isCommittedTimeout(error)) return;
      if (attempt >= 4 || !retryable(error)) throw error;
      await page.waitForTimeout(500 * attempt);
    }
  }
}

function normalizePathname(value: string): string {
  if (!value) return '/';
  let pathname = value.trim();
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  pathname = pathname.replace(/\/+$/, '');
  return pathname || '/';
}

export function isGotoTimeoutOnExpectedPath(page: Page, expectedPathname: string, error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.toLowerCase().includes('timeout')) return false;
  try {
    return normalizePathname(new URL(page.url()).pathname) === normalizePathname(expectedPathname);
  } catch {
    return false;
  }
}

export async function gotoDomContentLoadedWithPathFallback(
  page: Page,
  url: string,
  expectedPathname: string,
  timeoutMs = 90_000,
): Promise<void> {
  try {
    await gotoDomContentLoadedWithRetries(page, url, timeoutMs);
  } catch (error) {
    if (isGotoTimeoutOnExpectedPath(page, expectedPathname, error)) return;
    throw error;
  }
}
