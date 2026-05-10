import type { Locator } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';

import { ensureAccountReadyForConnect, type EnsureAccountReadyForConnectPage } from './ensureAccountReadyForConnect';

function createFakePage(params: Readonly<{
  testIdCounts?: Record<string, number[]>;
  roleCounts?: Record<string, number[]>;
  clickErrors?: Record<string, (Error | undefined)[]>;
}>): EnsureAccountReadyForConnectPage & {
  clickCalls: Record<string, number>;
} {
  const testIdCalls = new Map<string, number>();
  const roleCalls = new Map<string, number>();
  const clickErrorCalls = new Map<string, number>();
  const testIdCounts = params.testIdCounts ?? {};
  const roleCounts = params.roleCounts ?? {};
  const clickErrors = params.clickErrors ?? {};
  const clickCalls: Record<string, number> = {};

  const nextCount = (map: Map<string, number>, source: Record<string, number[]>, key: string): number => {
    const idx = map.get(key) ?? 0;
    map.set(key, idx + 1);
    const sequence = source[key] ?? [0];
    return sequence[Math.min(idx, Math.max(sequence.length - 1, 0))] ?? 0;
  };

  const makeLocator = (key: string, source: Record<string, number[]>, calls: Map<string, number>) => ({
    count: async () => nextCount(calls, source, key),
    click: async () => {
      clickCalls[key] = (clickCalls[key] ?? 0) + 1;
      const idx = clickErrorCalls.get(key) ?? 0;
      clickErrorCalls.set(key, idx + 1);
      const errorSequence = clickErrors[key] ?? [];
      const maybeError = errorSequence[Math.min(idx, Math.max(errorSequence.length - 1, 0))];
      if (maybeError) throw maybeError;
    },
    first: () => makeLocator(key, source, calls),
  } as unknown as Locator);

  return {
    getByTestId: (testId: string) => makeLocator(testId, testIdCounts, testIdCalls),
    getByRole: (_role: string, options: { name: string }) => makeLocator(options.name, roleCounts, roleCalls),
    waitForTimeout: async () => {},
    clickCalls,
  };
}

describe('ensureAccountReadyForConnect', () => {
  it('resolves immediately when connect machine controls are already visible', async () => {
    const page = createFakePage({
      testIdCounts: {
        'session-getting-started-kind-connect_machine': [1],
      },
    });

    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 50 })).resolves.toBeUndefined();
    expect(page.clickCalls['welcome-create-account'] ?? 0).toBe(0);
  });

  it('resolves when role-based ready controls are visible', async () => {
    const page = createFakePage({
      roleCounts: {
        Settings: [1],
      },
    });

    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 50 })).resolves.toBeUndefined();
  });

  it('clicks create-account by test id when requested and waits until ready', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [1],
        'session-getting-started-kind-connect_machine': [0, 0, 1],
      },
    });

    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 250 })).resolves.toBeUndefined();
    expect(page.clickCalls['welcome-create-account'] ?? 0).toBe(1);
  });

  it('clicks create-account by role when no test id button is present', async () => {
    const page = createFakePage({
      roleCounts: {
        'Create account': [1],
      },
      testIdCounts: {
        'session-getting-started-kind-connect_machine': [0, 0, 1],
      },
    });

    await expect(ensureAccountReadyForConnect({ page, timeoutMs: 250 })).resolves.toBeUndefined();
    expect(page.clickCalls['Create account'] ?? 0).toBe(1);
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
        'welcome-create-account': [1, 1],
        'session-getting-started-kind-connect_machine': [0, 0, 0, 1],
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
      .mockReturnValueOnce(300)
      .mockReturnValueOnce(600)
      .mockReturnValue(900);
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
});
