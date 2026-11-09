import { describe, expect, it, vi } from 'vitest';

import { createDiscordIdentifyConcurrency } from './discordGatewayIdentifyConcurrency.js';

describe('Discord Identify concurrency', () => {
  it('holds the unsharded application bucket for Discord’s full five-second window', async () => {
    vi.useFakeTimers();
    try {
      const gate = createDiscordIdentifyConcurrency();
      const first = await gate.acquire({
        applicationId: 'application-1',
        signal: new AbortController().signal,
      });
      let secondGranted = false;
      const secondPromise = gate.acquire({
        applicationId: 'application-1',
        signal: new AbortController().signal,
      }).then((permit) => {
        secondGranted = true;
        return permit;
      });
      const otherApplication = await gate.acquire({
        applicationId: 'application-2',
        signal: new AbortController().signal,
      });

      await Promise.resolve();
      expect(secondGranted).toBe(false);
      otherApplication.release();
      first.commit();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(secondGranted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const second = await secondPromise;
      expect(secondGranted).toBe(true);
      second.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it('releases an abandoned reservation before an Identify attempt so later work is not stranded', async () => {
    const gate = createDiscordIdentifyConcurrency();
    const first = await gate.acquire({
      applicationId: 'application-1',
      signal: new AbortController().signal,
    });
    let secondGranted = false;
    const secondPromise = gate.acquire({
      applicationId: 'application-1',
      signal: new AbortController().signal,
    }).then((permit) => {
      secondGranted = true;
      return permit;
    });

    await Promise.resolve();
    expect(secondGranted).toBe(false);
    first.release();
    const second = await secondPromise;
    expect(secondGranted).toBe(true);
    second.release();
  });
});
