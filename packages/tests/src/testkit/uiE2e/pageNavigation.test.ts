import { describe, expect, it, vi } from 'vitest';

import { gotoDomContentLoadedWithPathFallback, gotoDomContentLoadedWithRetries } from './pageNavigation';

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

  it('treats a timed-out navigation as usable once the target URL has committed', async () => {
    const targetUrl = 'http://localhost:3000/';
    const goto = vi.fn(async () => {
      throw new Error('page.goto: Timeout 90000ms exceeded.');
    });

    const page = {
      goto,
      waitForTimeout: vi.fn(async () => {}),
      url: () => targetUrl,
    };

    await expect(gotoDomContentLoadedWithRetries(page as never, targetUrl)).resolves.toBeUndefined();
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
