import type { Locator, Page } from '@playwright/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { waitForInitialAppUi, type InitialAppUiPage } from './waitForInitialAppUi';

function createFakePage(params: Readonly<{
  testIdCounts?: Record<string, number[]>;
  roleCounts?: Record<string, number[]>;
}>): InitialAppUiPage & { reloadCalls: number } {
  const testIdCalls = new Map<string, number>();
  const roleCalls = new Map<string, number>();
  const testIdCounts = params.testIdCounts ?? {};
  const roleCounts = params.roleCounts ?? {};

  const nextCount = (map: Map<string, number>, source: Record<string, number[]>, key: string): number => {
    const idx = map.get(key) ?? 0;
    map.set(key, idx + 1);
    const sequence = source[key] ?? [0];
    return sequence[Math.min(idx, sequence.length - 1)] ?? 0;
  };

  const makeLocator = (key: string, source: Record<string, number[]>, calls: Map<string, number>): Locator => ({
    count: async () => nextCount(calls, source, key),
  } as unknown as Locator);

  const page: InitialAppUiPage & { reloadCalls: number } = {
    reloadCalls: 0,
    getByTestId: ((testId) => makeLocator(String(testId), testIdCounts, testIdCalls)) as Page['getByTestId'],
    getByRole: ((_role, options) => makeLocator(String(options?.name ?? ''), roleCounts, roleCalls)) as Page['getByRole'],
    waitForTimeout: async () => {},
    reload: async () => {
      page.reloadCalls += 1;
      return null;
    },
  };

  return page;
}

describe('waitForInitialAppUi', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns when welcome UI is already visible', async () => {
    const page = createFakePage({
      testIdCounts: { 'welcome-create-account': [1] },
    });

    await expect(waitForInitialAppUi({ page, timeoutMs: 50, reloadOnFailure: false })).resolves.toBeUndefined();
    expect(page.reloadCalls).toBe(0);
  });

  it('reloads once when the first pass never renders but the retry does', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(300)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0);

    const page = createFakePage({
      testIdCounts: { 'session-composer-input': [0, 1] },
    });

    await expect(waitForInitialAppUi({ page, timeoutMs: 250 })).resolves.toBeUndefined();
    expect(page.reloadCalls).toBe(1);
  });

  it('throws with diagnostics when UI never appears', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(300)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(300);

    const page = createFakePage({});

    await expect(
      waitForInitialAppUi({
        page,
        timeoutMs: 250,
        browserDiagnostics: () => '# Browser diagnostics',
      }),
    ).rejects.toThrow('App did not render initial UI within 250ms.');
    await expect(
      waitForInitialAppUi({
        page: createFakePage({}),
        timeoutMs: 250,
        browserDiagnostics: () => '# Browser diagnostics',
      }),
    ).rejects.toThrow('# Browser diagnostics');
  });
});
