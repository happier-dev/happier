import type { Locator, Page } from '@playwright/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createAccountAndReachConnectMachineState,
  createAccountAndReachSetupWizardState,
  dismissSetupWizardIfVisible,
  type CreateAccountAndReachConnectMachineStatePage,
} from './createAccountAndReachConnectMachineState';

type FakeLocator = Locator & {
  clickCalls: number;
};

function createFakePage(params: Readonly<{
  testIdCounts?: Record<string, number[]>;
  onEvaluate?: () => void;
}>): CreateAccountAndReachConnectMachineStatePage {
  const testIdCalls = new Map<string, number>();
  const testIdCounts = params.testIdCounts ?? {};
  const clickCounts = new Map<string, number>();

  const nextCount = (key: string): number => {
    const idx = testIdCalls.get(key) ?? 0;
    testIdCalls.set(key, idx + 1);
    const sequence = testIdCounts[key] ?? [0];
    return sequence[Math.min(idx, sequence.length - 1)] ?? 0;
  };

  const makeLocator = (key: string): FakeLocator => ({
    count: async () => nextCount(key),
    click: async () => {
      clickCounts.set(key, (clickCounts.get(key) ?? 0) + 1);
    },
    first: () => makeLocator(key),
    get clickCalls() {
      return clickCounts.get(key) ?? 0;
    },
  } as unknown as FakeLocator);

  return {
    getByTestId: ((testId) => makeLocator(String(testId))) as Page['getByTestId'],
    evaluate: vi.fn(async (_fn: unknown, _arg?: unknown) => {
      params.onEvaluate?.();
      return undefined;
    }) as unknown as Page['evaluate'],
  };
}

describe('createAccountAndReachConnectMachineState', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('reaches connect-machine directly when no setup wizard appears', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [1, 1],
        'session-getting-started-kind-connect_machine': [0, 1, 1],
        'setupWizard.surface': [0, 0],
      },
    });

    await expect(createAccountAndReachConnectMachineState({ page })).resolves.toBeUndefined();
  });

  it('dismisses the setup wizard before requiring connect-machine', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [1, 1],
        'session-getting-started-kind-connect_machine': [0, 0, 1, 1],
        'setupWizard.surface': [0, 1, 1, 0],
        'setupWizard.surface-skip': [1, 1],
      },
    });

    await expect(createAccountAndReachConnectMachineState({ page })).resolves.toBeUndefined();
  });

  it('accepts an already-visible connect-machine state without requiring create-account first', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [0],
        'session-getting-started-kind-connect_machine': [1, 1],
        'setupWizard.surface': [0],
      },
    });

    await expect(createAccountAndReachConnectMachineState({ page })).resolves.toBeUndefined();
  });

  it('dismisses setup wizard only when visible', async () => {
    const page = createFakePage({
      testIdCounts: {
        'setupWizard.surface': [1, 1, 0],
        'setupWizard.surface-skip': [1, 1],
      },
    });

    await expect(dismissSetupWizardIfVisible({ page })).resolves.toBeUndefined();
  });
});

describe('createAccountAndReachSetupWizardState', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('clicks create-account and waits for the setup wizard', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [1, 1],
        'setupWizard.surface': [0, 1, 1],
      },
    });

    await expect(createAccountAndReachSetupWizardState({ page })).resolves.toBeUndefined();
  });

  it('accepts an already-visible setup wizard without requiring create-account first', async () => {
    const page = createFakePage({
      testIdCounts: {
        'welcome-create-account': [0],
        'setupWizard.surface': [1, 1],
      },
    });

    await expect(createAccountAndReachSetupWizardState({ page })).resolves.toBeUndefined();
  });

  it('navigates to the setup wizard when the authenticated shell is visible but the modal did not auto-open', async () => {
    const testIdCounts = {
      'welcome-create-account': [1, 1],
      'setupWizard.surface': [0, 0, 0, 1],
      'setup.postAuth': [0, 1, 1],
    };

    const page = createFakePage({
      testIdCounts: {
        ...testIdCounts,
      },
      onEvaluate: () => {
        testIdCounts['setupWizard.surface'] = [1, 1];
      },
    });

    await expect(createAccountAndReachSetupWizardState({ page })).resolves.toBeUndefined();
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });
});
