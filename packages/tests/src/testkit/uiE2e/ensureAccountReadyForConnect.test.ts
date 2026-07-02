import type { Locator, Page } from '@playwright/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ensureAccountReadyForConnect, type EnsureAccountReadyForConnectPage } from './ensureAccountReadyForConnect';

function createFakePage(params: Readonly<{
  testIdCounts?: Record<string, number[]>;
  roleCounts?: Record<string, number[]>;
  testIdVisible?: Record<string, boolean[]>;
  roleVisible?: Record<string, boolean[]>;
  clickErrors?: Record<string, (Error | undefined)[]>;
}>): EnsureAccountReadyForConnectPage & {
  clickCalls: Record<string, number>;
  waitCalls: number;
} {
  const testIdCalls = new Map<string, number>();
  const roleCalls = new Map<string, number>();
  const testIdVisibleCalls = new Map<string, number>();
  const roleVisibleCalls = new Map<string, number>();
  const clickErrorCalls = new Map<string, number>();
  const testIdCounts = params.testIdCounts ?? {};
  const roleCounts = params.roleCounts ?? {};
  const testIdVisible = params.testIdVisible ?? {};
  const roleVisible = params.roleVisible ?? {};
  const clickErrors = params.clickErrors ?? {};
  const clickCalls: Record<string, number> = {};

  const nextCount = (map: Map<string, number>, source: Record<string, number[]>, key: string): number => {
    const idx = map.get(key) ?? 0;
    map.set(key, idx + 1);
    const sequence = source[key] ?? [0];
    return sequence[Math.min(idx, sequence.length - 1)] ?? 0;
  };

  const nextVisible = (map: Map<string, number>, source: Record<string, boolean[]>, key: string): boolean => {
    const idx = map.get(key) ?? 0;
    map.set(key, idx + 1);
    const sequence = source[key] ?? [true];
    return sequence[Math.min(idx, sequence.length - 1)] ?? true;
  };

  const makeLocator = (
    key: string,
    source: Record<string, number[]>,
    calls: Map<string, number>,
    visibleSource: Record<string, boolean[]>,
    visibleCalls: Map<string, number>,
  ): Locator => ({
    count: async () => nextCount(calls, source, key),
    isVisible: async () => nextVisible(visibleCalls, visibleSource, key),
    click: async () => {
      clickCalls[key] = (clickCalls[key] ?? 0) + 1;
      const idx = clickErrorCalls.get(key) ?? 0;
      clickErrorCalls.set(key, idx + 1);
      const errorSequence = clickErrors[key] ?? [];
      const maybeError = errorSequence[Math.min(idx, Math.max(errorSequence.length - 1, 0))];
      if (maybeError) throw maybeError;
    },
    first: () => makeLocator(key, source, calls, visibleSource, visibleCalls),
    nth: () => makeLocator(key, source, calls, visibleSource, visibleCalls),
  } as unknown as Locator);

  const page = {
    clickCalls,
    waitCalls: 0,
    getByTestId: ((testId) => makeLocator(String(testId), testIdCounts, testIdCalls, testIdVisible, testIdVisibleCalls)) as Page['getByTestId'],
    getByRole: ((_role, options) => makeLocator(String(options?.name ?? ''), roleCounts, roleCalls, roleVisible, roleVisibleCalls)) as Page['getByRole'],
    waitForTimeout: async () => {
      page.waitCalls += 1;
    },
  };
  return page;
}

function createBrandHeroTransitionPage(): EnsureAccountReadyForConnectPage & {
  clickCalls: Record<string, number>;
  waitCalls: number;
} {
  const clickCalls: Record<string, number> = {};
  const visibleByKey = new Map<string, number>([
    ['brand-hero-get-started', 1],
    ['welcome-primary-start', 0],
    ['session-getting-started-kind-connect_machine', 0],
    ['Get Started', 1],
  ]);

  const makeLocator = (key: string): Locator => ({
    count: async () => visibleByKey.get(key) ?? 0,
    isVisible: async () => (visibleByKey.get(key) ?? 0) > 0,
    click: async () => {
      clickCalls[key] = (clickCalls[key] ?? 0) + 1;
      if (key === 'brand-hero-get-started') {
        visibleByKey.set('brand-hero-get-started', 0);
        visibleByKey.set('welcome-primary-start', 1);
        return;
      }
      if (key === 'welcome-primary-start') {
        visibleByKey.set('welcome-primary-start', 0);
        visibleByKey.set('session-getting-started-kind-connect_machine', 1);
      }
    },
    first: () => makeLocator(key),
    nth: () => makeLocator(key),
  } as unknown as Locator);

  const page = {
    clickCalls,
    waitCalls: 0,
    getByTestId: ((testId) => makeLocator(String(testId))) as Page['getByTestId'],
    getByRole: ((_role, options) => makeLocator(String(options?.name ?? ''))) as Page['getByRole'],
    waitForTimeout: async () => {
      page.waitCalls += 1;
    },
  };

  return page;
}

describe('ensureAccountReadyForConnect', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('passes when account is already in a ready state without create-account CTA', async () => {
    const page = createFakePage({
      testIdCounts: {
        'session-getting-started-kind-create_session': [1],
      },
    });

    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 50 })).resolves.toBeUndefined();
    expect(page.clickCalls['welcome-create-account'] ?? 0).toBe(0);
    expect(page.clickCalls['Create account'] ?? 0).toBe(0);
  });

  it('passes when the signed-in shell is visible via role-based controls', async () => {
    const page = createFakePage({
      roleCounts: {
        Settings: [1],
      },
    });

    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 50 })).resolves.toBeUndefined();
  });

  it('passes when the authenticated setup surface is visible', async () => {
    const page = createFakePage({
      testIdCounts: {
        'setupWizard.surface': [1],
      },
    });

    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 50 })).resolves.toBeUndefined();
  });

  it('treats hidden getting-started kind markers as a ready authenticated state', async () => {
    const page = createFakePage({
      testIdCounts: {
        'session-getting-started-kind-connect_machine': [1],
      },
      testIdVisible: {
        'session-getting-started-kind-connect_machine': [false],
      },
    });

    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 50 })).resolves.toBeUndefined();
  });

  it('does not treat hidden ready controls as an authenticated state', async () => {
    const page = createFakePage({
      roleCounts: {
        Settings: [1, 1],
        'Create account': [1, 0],
      },
      roleVisible: {
        Settings: [false, false, true],
      },
      testIdCounts: {
        'session-getting-started-kind-connect_machine': [0, 0, 1],
      },
    });

    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 250 })).resolves.toBeUndefined();
    expect(page.clickCalls['Create account'] ?? 0).toBe(1);
  });

  it('does not treat welcome-screen navigation controls as an authenticated state', async () => {
    const page = createFakePage({
      roleCounts: {
        Settings: [1, 1],
        'Create account': [1, 0],
      },
      testIdCounts: {
        'session-getting-started-kind-connect_machine': [0, 0, 1],
      },
    });

    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 250 })).resolves.toBeUndefined();
    expect(page.clickCalls['Create account'] ?? 0).toBe(1);
  });

  it('waits after clicking create account when only welcome navigation is visible', async () => {
    const page = createFakePage({
      roleCounts: {
        Settings: [1, 1, 1],
        'Create account': [1, 1, 0],
      },
      testIdCounts: {
        'session-getting-started-kind-connect_machine': [0, 0, 1],
      },
    });

    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 250 })).resolves.toBeUndefined();
    expect(page.clickCalls['Create account'] ?? 0).toBeGreaterThan(0);
    expect(page.waitCalls).toBeGreaterThan(0);
  });

  it('waits after fallback create-account click when only welcome navigation is visible', async () => {
    const page = createFakePage({
      roleCounts: {
        Settings: [0, 0, 1, 1],
        'Create account': [0, 1, 1, 0],
      },
      testIdCounts: {
        'session-getting-started-kind-connect_machine': [0, 0, 0, 1],
      },
    });

    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 250 })).resolves.toBeUndefined();
    expect(page.clickCalls['Create account'] ?? 0).toBeGreaterThan(0);
    expect(page.waitCalls).toBeGreaterThan(0);
  });

  it('clicks the testID create-account CTA when present, then waits for ready state', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [1, 0],
        'session-getting-started-kind-connect_machine': [0, 1],
      },
    });

    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 250 })).resolves.toBeUndefined();
    expect(page.clickCalls['welcome-create-account'] ?? 0).toBe(1);
  });

  it('clicks the unified welcome primary CTA when present, then waits for ready state', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-primary-start': [1, 0],
        'session-getting-started-kind-connect_machine': [0, 1],
      },
    });

    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 250 })).resolves.toBeUndefined();
    expect(page.clickCalls['welcome-primary-start'] ?? 0).toBe(1);
  });

  it('prefers the brand-hero get-started testID before copy-based onboarding fallback', async () => {
    const page = createBrandHeroTransitionPage();

    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 250 })).resolves.toBeUndefined();
    expect(page.clickCalls['brand-hero-get-started'] ?? 0).toBe(1);
    expect(page.clickCalls['Get Started'] ?? 0).toBe(0);
  });

  it('dismisses the brand hero as pre-auth progression without treating it as account creation', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(300);
    const page = createBrandHeroTransitionPage();

    await expect(
      ensureAccountReadyForConnect({ page, timeoutMs: 250, clickCreateAccount: false }),
    ).rejects.toThrow('Account did not reach a ready UI state within 250ms.');

    expect(page.clickCalls['brand-hero-get-started'] ?? 0).toBe(1);
    expect(page.clickCalls['welcome-primary-start'] ?? 0).toBe(0);
  });

    it('falls back to the role-based create-account CTA when testID is absent', async () => {
        const page = createFakePage({
            roleCounts: {
        'Create account': [1, 0],
      },
      testIdCounts: {
        'session-getting-started-kind-connect_machine': [0, 1],
      },
    });

        await expect(ensureAccountReadyForConnect({ page, timeoutMs: 250 })).resolves.toBeUndefined();
        expect(page.clickCalls['Create account'] ?? 0).toBe(1);
    });

    it('falls back to the role-based first-time CTA when testID is absent', async () => {
        const page = createFakePage({
            roleCounts: {
                '/First time here/': [1, 0],
            },
            testIdCounts: {
                'session-getting-started-kind-connect_machine': [0, 1],
            },
        });

        await expect(ensureAccountReadyForConnect({ page, timeoutMs: 250 })).resolves.toBeUndefined();
        expect(page.clickCalls['/First time here/'] ?? 0).toBe(1);
    });

  it('continues when the create-account CTA is temporarily blocked by an overlay', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [1],
        'session-getting-started-kind-connect_machine': [1],
      },
      clickErrors: {
        'welcome-create-account': [new Error('intercepts pointer events')],
      },
    });

    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 250 })).resolves.toBeUndefined();
  });

  it('retries create-account with a second click when the first attempt is intercepted', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [1, 0],
        'session-getting-started-kind-connect_machine': [0, 1],
      },
      clickErrors: {
        'welcome-create-account': [new Error('intercepts pointer events')],
      },
    });

    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 250 })).resolves.toBeUndefined();
    expect(page.clickCalls['welcome-create-account'] ?? 0).toBe(2);
  });

  it('throws when no ready state appears in time', async () => {
    const nowSpy = vi.spyOn(Date, 'now');
    nowSpy
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(300);

    const page = createFakePage({});
    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 250 })).rejects.toThrow(
      'Account did not reach a ready UI state within 250ms.',
    );
  });

  it('advances onboarding story cards until a ready signal appears', async () => {
    const page = createFakePage({
      testIdCounts: {
        'onboarding-showcase-primary': [1, 1, 1, 0],
        'session-getting-started-kind-connect_machine': [0, 0, 1],
      },
    });

    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 400 })).resolves.toBeUndefined();
    expect(page.clickCalls['onboarding-showcase-primary'] ?? 0).toBeGreaterThan(0);
  });

  it('advances onboarding with role-based next buttons when story testIDs are absent', async () => {
    const page = createFakePage({
      roleCounts: {
        Next: [1, 1, 0],
        'Create account': [0, 1],
      },
      testIdCounts: {
        'session-getting-started-kind-connect_machine': [0, 0, 0, 1],
      },
    });

    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 500 })).resolves.toBeUndefined();
    expect(page.clickCalls.Next ?? 0).toBeGreaterThan(0);
  });
});
