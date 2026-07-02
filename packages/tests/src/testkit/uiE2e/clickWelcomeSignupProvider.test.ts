import type { Locator, Page } from '@playwright/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const playwrightExpect = vi.hoisted(() => vi.fn());

vi.mock('@playwright/test', () => ({
  expect: playwrightExpect,
}));

import { clickWelcomeSignupProvider } from './clickWelcomeSignupProvider';

function createLocator(params: Readonly<{
  count?: number;
  visible?: boolean;
  onClick?: () => void;
}>): Locator {
  return {
    count: async () => params.count ?? 0,
    isVisible: async () => params.visible ?? true,
    click: async () => {
      params.onClick?.();
    },
  } as unknown as Locator;
}

function createProviderSignupLocator(): Locator {
  const hiddenProvider = createLocator({
    count: 1,
    visible: false,
    onClick: () => {
      throw new Error('should not click hidden provider CTA');
    },
  });
  const visibleProvider = createLocator({
    count: 1,
    visible: true,
    onClick: () => {
      clicked.push('visible-provider');
    },
  });
  const empty = createLocator({ count: 0, visible: false });

  const clicked: string[] = [];
  const providerLocator = {
    clicked,
    count: async () => 2,
    isVisible: async () => false,
    first: () => hiddenProvider,
    nth: (index: number) => (index === 0 ? hiddenProvider : index === 1 ? visibleProvider : empty),
  } as unknown as Locator & { clicked: string[] };

  return providerLocator;
}

function createFakePage(): Pick<Page, 'getByTestId' | 'getByRole' | 'locator' | 'waitForTimeout'> & {
  clicked: string[];
} {
  const providerSignup = createProviderSignupLocator() as Locator & { clicked: string[] };
  const empty = createLocator({ count: 0, visible: false });

  return {
    clicked: providerSignup.clicked,
    getByTestId: ((testId: string) => testId === 'welcome-signup-provider' ? providerSignup : empty) as Page['getByTestId'],
    getByRole: (() => empty) as Page['getByRole'],
    locator: (() => empty) as Page['locator'],
    waitForTimeout: async () => {},
  };
}

describe('clickWelcomeSignupProvider', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    playwrightExpect.mockReset();
    playwrightExpect.mockImplementation(() => ({
      toBeEnabled: async () => {},
    }));
  });

  it('clicks the visible provider CTA when hidden nodes share the same test id', async () => {
    const page = createFakePage();

    await clickWelcomeSignupProvider({ page: page as unknown as Page, timeoutMs: 50 });

    expect(page.clicked).toEqual(['visible-provider']);
  });
});
