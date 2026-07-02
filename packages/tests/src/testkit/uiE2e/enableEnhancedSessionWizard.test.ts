import type { Locator, Page } from '@playwright/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const pageNavigationMocks = vi.hoisted(() => ({
  gotoDomContentLoadedWithPathFallback: vi.fn(async () => {}),
  gotoDomContentLoadedWithRetries: vi.fn(async () => {}),
}));

vi.mock('@playwright/test', () => ({
  expect: (locator: Locator) => ({
    async toHaveCount(expectedCount: number) {
      const actualCount = await locator.count();
      if (actualCount !== expectedCount) {
        throw new Error(`expected locator count ${expectedCount}, received ${actualCount}`);
      }
    },
    async toBeChecked() {
      const checked = await (locator as unknown as { isChecked: () => Promise<boolean> }).isChecked();
      if (!checked) {
        throw new Error('expected locator to be checked');
      }
    },
  }),
}));

vi.mock('./pageNavigation', () => ({
  gotoDomContentLoadedWithPathFallback: pageNavigationMocks.gotoDomContentLoadedWithPathFallback,
  gotoDomContentLoadedWithRetries: pageNavigationMocks.gotoDomContentLoadedWithRetries,
}));

import { enableEnhancedSessionWizard } from './enableEnhancedSessionWizard';

function createWizardModePage(params?: Readonly<{
  isWizardModeVisible?: () => boolean;
}>): Page {
  const switchLocator = {
    count: async () => 1,
    isChecked: async () => true,
  };
  const itemLocator = {
    count: async () => params?.isWizardModeVisible?.() === false ? 0 : 1,
    locator: () => ({
      first: () => switchLocator,
    }),
    click: async () => {},
  };

  return {
    url: () => 'http://127.0.0.1:3000/settings/session',
    waitForTimeout: async () => {},
    getByTestId: ((testId: string) => {
      if (testId !== 'settings-new-session-wizard-mode') {
        throw new Error(`unexpected test id: ${testId}`);
      }
      return itemLocator;
    }) as unknown as Page['getByTestId'],
  } as unknown as Page;
}

describe('enableEnhancedSessionWizard', () => {
  beforeEach(() => {
    pageNavigationMocks.gotoDomContentLoadedWithPathFallback.mockClear();
    pageNavigationMocks.gotoDomContentLoadedWithRetries.mockClear();
  });

  it('navigates to session settings through the path fallback helper', async () => {
    const page = createWizardModePage();

    await enableEnhancedSessionWizard({
      page,
      baseUrl: 'http://127.0.0.1:3000',
      timeoutMs: 12_345,
    });

    expect(pageNavigationMocks.gotoDomContentLoadedWithPathFallback).toHaveBeenCalledWith(
      page,
      'http://127.0.0.1:3000/settings/session',
      '/settings/session',
      12_345,
    );
  });

  it('retries the session settings route when auth restoration redirects to home first', async () => {
    let currentPath = '/';
    let navigationCount = 0;
    pageNavigationMocks.gotoDomContentLoadedWithPathFallback.mockImplementation(async () => {
      navigationCount += 1;
      currentPath = navigationCount === 1 ? '/' : '/settings/session';
    });
    const page = createWizardModePage({
      isWizardModeVisible: () => currentPath === '/settings/session',
    });
    page.url = () => `http://127.0.0.1:3000${currentPath}`;

    await enableEnhancedSessionWizard({
      page,
      baseUrl: 'http://127.0.0.1:3000',
      timeoutMs: 12_345,
    });

    expect(pageNavigationMocks.gotoDomContentLoadedWithPathFallback).toHaveBeenCalledTimes(2);
  });
});
