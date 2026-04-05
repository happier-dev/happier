import { describe, expect, it, vi } from 'vitest';
import {
  gotoDomContentLoadedWithPathFallback,
  gotoDomContentLoadedWithRetries,
  normalizeLoopbackBaseUrl,
} from './pageNavigation';
import * as pageNavigation from './pageNavigation';

type WaitForAuthenticatedHomeUiPage = Readonly<{
  getByTestId(testId: string): { count: () => Promise<number> };
  reload: () => Promise<void>;
  url: () => string;
  waitForTimeout: (delayMs: number) => Promise<void>;
}>;

describe('gotoDomContentLoadedWithRetries', () => {
  it('retries retryable network errors before succeeding', async () => {
    const goto = vi
      .fn<(_url: string, _options: { waitUntil: 'domcontentloaded'; timeout: number }) => Promise<void>>()
      .mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'))
      .mockResolvedValueOnce(undefined);
    const waitForTimeout = vi.fn(async () => {});

    const page = {
      goto,
      waitForTimeout,
      url: () => 'about:blank',
    };

    await gotoDomContentLoadedWithRetries(page as never, 'http://localhost:3000');

    expect(goto).toHaveBeenCalledTimes(2);
    expect(waitForTimeout).toHaveBeenCalledWith(500);
  });

  it('rejects a timed-out navigation when waiting for DOM content (even if the target URL committed)', async () => {
    const targetUrl = 'http://localhost:3000/';
    const goto = vi.fn(async () => {
      throw new Error('page.goto: Timeout 90000ms exceeded.');
    });

    const page = {
      goto,
      waitForTimeout: vi.fn(async () => {}),
      url: () => targetUrl,
    };

    await expect(gotoDomContentLoadedWithRetries(page as never, targetUrl)).rejects.toThrow(/timeout/i);
    expect(goto).toHaveBeenCalledTimes(1);
  });

  it('treats a timed-out navigation as usable once the expected pathname has committed', async () => {
    const targetUrl = 'http://localhost:3000/?server=http%3A%2F%2F127.0.0.1%3A1';
    const goto = vi.fn(async () => {
      throw new Error('page.goto: Timeout 90000ms exceeded.');
    });

    const page = {
      goto,
      waitForTimeout: vi.fn(async () => {}),
      url: () => 'http://localhost:3000/',
    };

    await expect(gotoDomContentLoadedWithPathFallback(page as never, targetUrl, '/')).resolves.toBeUndefined();
    expect(goto).toHaveBeenCalledTimes(1);
  });
});

describe('gotoCommittedWithRetries', () => {
  it('retries retryable network errors before succeeding', async () => {
    const goto = vi
      .fn<(_url: string, _options: { waitUntil: 'commit'; timeout: number }) => Promise<void>>()
      .mockRejectedValueOnce(new Error('net::ERR_CONNECTION_RESET'))
      .mockResolvedValueOnce(undefined);
    const waitForTimeout = vi.fn(async () => {});

    type PageStub = {
      goto: typeof goto;
      waitForTimeout: typeof waitForTimeout;
      url: () => string;
    };

    const page: PageStub = {
      goto,
      waitForTimeout,
      url: () => 'about:blank',
    };

    const helper = (pageNavigation as Record<string, unknown>).gotoCommittedWithRetries;
    expect(helper).toBeTypeOf('function');
    await expect((helper as (page: PageStub, url: string, timeoutMs?: number) => Promise<void>)(page, 'http://localhost:3000')).resolves.toBeUndefined();

    expect(goto).toHaveBeenCalledTimes(2);
    expect(waitForTimeout).toHaveBeenCalledWith(500);
  });

  it('treats a timed-out navigation as usable once the target URL has committed', async () => {
    const targetUrl = 'http://localhost:3000/';
    const goto = vi.fn(async () => {
      throw new Error('page.goto: Timeout 90000ms exceeded.');
    });

    const waitForTimeout = vi.fn(async () => {});
    type PageStub = {
      goto: typeof goto;
      waitForTimeout: typeof waitForTimeout;
      url: () => string;
    };

    const page: PageStub = {
      goto,
      waitForTimeout,
      url: () => targetUrl,
    };

    const helper = (pageNavigation as Record<string, unknown>).gotoCommittedWithRetries;
    expect(helper).toBeTypeOf('function');
    await expect((helper as (page: PageStub, url: string, timeoutMs?: number) => Promise<void>)(page, targetUrl)).resolves.toBeUndefined();
    expect(goto).toHaveBeenCalledTimes(1);
  });
});

describe('normalizeLoopbackBaseUrl', () => {
  it('preserves routable IPv4 loopback hosts and rewrites non-routable loopback hosts to 127.0.0.1', () => {
    expect(normalizeLoopbackBaseUrl('http://127.0.0.1:60674/')).toBe('http://127.0.0.1:60674');
    expect(normalizeLoopbackBaseUrl('http://0.0.0.0:60674/')).toBe('http://127.0.0.1:60674');
    expect(normalizeLoopbackBaseUrl('http://[::1]:60674/')).toBe('http://127.0.0.1:60674');
  });
});

describe('waitForAuthenticatedHomeUi', () => {
  it('waits for the authenticated root shell after terminal-connect success', async () => {
    const testIdCounts: Record<string, number[]> = {
      'welcome-create-account': [1, 1, 0, 0],
      'session-getting-started-kind-connect_machine': [0, 0, 1, 1],
      'setupWizard.surface': [0, 0, 0, 0],
    };
    const counts = new Map<string, number>();
    const nextCount = (key: string): number => {
      const index = counts.get(key) ?? 0;
      counts.set(key, index + 1);
      const sequence = testIdCounts[key] ?? [0];
      return sequence[Math.min(index, sequence.length - 1)] ?? 0;
    };
    let nowMs = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    const page = {
      getByTestId: (testId: string) => ({ count: async () => nextCount(testId) }),
      waitForTimeout: vi.fn(async (delayMs: number) => {
        nowMs += delayMs;
      }),
      reload: vi.fn(async () => {}),
      url: () => (nowMs < 250 ? 'http://127.0.0.1:3000/terminal/connect' : 'http://127.0.0.1:3000/'),
    };

    const helper = (pageNavigation as Record<string, unknown>).waitForAuthenticatedHomeUi;
    expect(helper).toBeTypeOf('function');

    await expect(
      (helper as (
        params: Readonly<{ page: WaitForAuthenticatedHomeUiPage; timeoutMs?: number; reloadOnFailure?: boolean }>,
      ) => Promise<void>)({ page, timeoutMs: 1_000, reloadOnFailure: false }),
    ).resolves.toBeUndefined();

    expect(page.reload).not.toHaveBeenCalled();
    expect(counts.get('welcome-create-account')).toBeGreaterThanOrEqual(2);
    expect(counts.get('session-getting-started-kind-connect_machine')).toBeGreaterThanOrEqual(2);
  });
});
