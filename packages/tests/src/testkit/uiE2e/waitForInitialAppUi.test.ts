import type { Locator, Page } from '@playwright/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { waitForInitialAppUi, type InitialAppUiPage } from './waitForInitialAppUi';

function createFakePage(params: Readonly<{
    testIdCounts?: Record<string, number[]>;
    selectorCounts?: Record<string, number[]>;
    roleCounts?: Record<string, number[]>;
    throwOnRoleNames?: readonly string[];
}>): InitialAppUiPage & { reloadCalls: number; getByRole: Page['getByRole']; locator: Page['locator'] } {
    const testIdCalls = new Map<string, number>();
    const selectorCalls = new Map<string, number>();
    const roleCalls = new Map<string, number>();
    const testIdCounts = params.testIdCounts ?? {};
    const selectorCounts = params.selectorCounts ?? {};
    const roleCounts = params.roleCounts ?? {};
    const throwOnRoleNames = new Set(params.throwOnRoleNames ?? []);

  const nextCount = (map: Map<string, number>, source: Record<string, number[]>, key: string): number => {
    const idx = map.get(key) ?? 0;
    map.set(key, idx + 1);
    const sequence = source[key] ?? [0];
    return sequence[Math.min(idx, sequence.length - 1)] ?? 0;
  };

  const makeLocator = (key: string, source: Record<string, number[]>, calls: Map<string, number>): Locator => ({
    count: async () => nextCount(calls, source, key),
  } as unknown as Locator);

    const page: InitialAppUiPage & { reloadCalls: number; getByRole: Page['getByRole']; locator: Page['locator'] } = {
        reloadCalls: 0,
        getByTestId: ((testId) => makeLocator(String(testId), testIdCounts, testIdCalls)) as Page['getByTestId'],
        locator: ((selector) => makeLocator(String(selector), selectorCounts, selectorCalls)) as Page['locator'],
        getByRole: ((_role, options) => {
            const name = String(options?.name ?? '');
            if (throwOnRoleNames.has(name)) {
        throw new Error(`unexpected role lookup for ${name}`);
      }
      return makeLocator(name, roleCounts, roleCalls);
    }) as Page['getByRole'],
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

    it('returns when the unified welcome decision CTA is visible', async () => {
        const page = createFakePage({
            testIdCounts: { 'welcome-primary-start': [1] },
    });

    await expect(waitForInitialAppUi({ page, timeoutMs: 50, reloadOnFailure: false })).resolves.toBeUndefined();
        expect(page.reloadCalls).toBe(0);
    });

    it('returns when the unified welcome decision is exposed only by role', async () => {
        const page = createFakePage({
            roleCounts: { '/First time here/': [1] },
        });

        await expect(waitForInitialAppUi({ page, timeoutMs: 50, reloadOnFailure: false })).resolves.toBeUndefined();
        expect(page.reloadCalls).toBe(0);
    });

  it('returns when the mobile brand hero CTA is visible', async () => {
    const page = createFakePage({
      testIdCounts: { 'brand-hero-get-started': [1] },
    });

    await expect(waitForInitialAppUi({ page, timeoutMs: 50, reloadOnFailure: false })).resolves.toBeUndefined();
    expect(page.reloadCalls).toBe(0);
  });

  it('does not need a copy-based role fallback when the stable welcome test id is visible', async () => {
    const page = createFakePage({
      testIdCounts: { 'welcome-create-account': [1] },
      throwOnRoleNames: ['Create account'],
    });

    await expect(waitForInitialAppUi({ page, timeoutMs: 50, reloadOnFailure: false })).resolves.toBeUndefined();
    expect(page.reloadCalls).toBe(0);
  });

  it('returns when provider-based welcome actions are visible', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-signup-provider': [1],
        'welcome-restore': [1],
      },
    });

    await expect(waitForInitialAppUi({ page, timeoutMs: 50, reloadOnFailure: false })).resolves.toBeUndefined();
    expect(page.reloadCalls).toBe(0);
  });

  it('returns when deep-linked restore content is visible', async () => {
    const page = createFakePage({
      testIdCounts: {
        'restore-open-manual': [1],
      },
    });

    await expect(waitForInitialAppUi({ page, timeoutMs: 50, reloadOnFailure: false })).resolves.toBeUndefined();
    expect(page.reloadCalls).toBe(0);
  });

  it('returns when deep-linked relay selection content is visible', async () => {
    const page = createFakePage({
      testIdCounts: {
        'onboarding-wizard-relay-diagram': [1],
      },
    });

    await expect(waitForInitialAppUi({ page, timeoutMs: 50, reloadOnFailure: false })).resolves.toBeUndefined();
    expect(page.reloadCalls).toBe(0);
  });

  it('returns when the post-auth setup wizard is visible', async () => {
    const page = createFakePage({
      testIdCounts: {
        'setupWizard.surface': [1],
      },
    });

    await expect(waitForInitialAppUi({ page, timeoutMs: 50, reloadOnFailure: false })).resolves.toBeUndefined();
    expect(page.reloadCalls).toBe(0);
  });

  it('returns when the welcome server loading state is visible', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-server-loading': [1],
      },
    });

    await expect(waitForInitialAppUi({ page, timeoutMs: 50, reloadOnFailure: false })).resolves.toBeUndefined();
    expect(page.reloadCalls).toBe(0);
  });

    it('returns when the authenticated shell is visible via a stable shell test id', async () => {
        const page = createFakePage({
            testIdCounts: {
        'sidebar-expand-button': [1],
      },
      throwOnRoleNames: ['Settings'],
    });

        await expect(waitForInitialAppUi({ page, timeoutMs: 50, reloadOnFailure: false })).resolves.toBeUndefined();
        expect(page.reloadCalls).toBe(0);
    });

    it('returns when an authenticated session list row is visible', async () => {
        const page = createFakePage({
            selectorCounts: { '[data-testid^="session-list-item-"]': [1] },
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

  it('throws when UI never appears', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy
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
  });

  it('throws immediately when the app crash recovery surface appears', async () => {
    const page = createFakePage({
      testIdCounts: { 'app-crash-restart': [1] },
    });

    await expect(
      waitForInitialAppUi({
        page,
        timeoutMs: 250,
        reloadOnFailure: false,
      }),
    ).rejects.toThrow('App crash recovery UI rendered before initial app UI.');
  });

  it('includes browser diagnostics when UI never appears', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(300);

    await expect(
      waitForInitialAppUi({
        page: createFakePage({}),
        timeoutMs: 250,
        browserDiagnostics: () => '# Browser diagnostics',
      }),
    ).rejects.toThrow('# Browser diagnostics');
  });
});
