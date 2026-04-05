import type { Locator, Page } from '@playwright/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createAccountAndReachConnectMachineState,
  dismissSetupWizardIfVisible,
  type CreateAccountAndReachConnectMachineStatePage,
} from './createAccountAndReachConnectMachineState';

type FakeLocator = Locator & {
  clickCalls: number;
};

function createFakePage(params: Readonly<{
  testIdCounts?: Record<string, number[]>;
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
