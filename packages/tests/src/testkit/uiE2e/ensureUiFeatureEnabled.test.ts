import type { Locator, Page } from '@playwright/test';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const playwrightExpect = vi.hoisted(() => vi.fn());
const gotoDomContentLoadedWithRetries = vi.hoisted(() => vi.fn());

vi.mock('@playwright/test', () => ({ expect: playwrightExpect }));
vi.mock('./pageNavigation', () => ({ gotoDomContentLoadedWithRetries }));

import { ensureUiFeatureEnabled } from './ensureUiFeatureEnabled';

function createToggle(initiallyChecked: boolean): Locator & { clickCount: number } {
  let checked = initiallyChecked;
  const toggle = {
    clickCount: 0,
    count: async () => 1,
    getAttribute: async (name: string) => name === 'aria-checked' ? String(checked) : null,
    click: async () => {
      toggle.clickCount += 1;
      checked = true;
    },
  } as unknown as Locator & { clickCount: number };
  return toggle;
}

describe('ensureUiFeatureEnabled', () => {
  beforeEach(() => {
    gotoDomContentLoadedWithRetries.mockReset();
    playwrightExpect.mockReset();
    playwrightExpect.mockImplementation((locator: Locator) => ({
      toHaveCount: async (count: number) => expect(await locator.count()).toBe(count),
      toHaveAttribute: async (name: string, value: string) => expect(await locator.getAttribute(name)).toBe(value),
    }));
  });

  it('navigates to feature settings and idempotently enables experiments plus the named feature', async () => {
    const experiments = createToggle(false);
    const feature = createToggle(false);
    const page = {
      getByTestId: (testId: string) => testId === 'settings-feature-experiments-toggle' ? experiments : feature,
    } as unknown as Page;

    await ensureUiFeatureEnabled({ page, baseUrl: 'http://ui.test', featureId: 'connectedServices' });
    await ensureUiFeatureEnabled({ page, baseUrl: 'http://ui.test', featureId: 'connectedServices' });

    expect(gotoDomContentLoadedWithRetries).toHaveBeenCalledTimes(2);
    expect(gotoDomContentLoadedWithRetries).toHaveBeenCalledWith(page, 'http://ui.test/settings/features?happier_hmr=0', 180_000);
    expect(experiments.clickCount).toBe(1);
    expect(feature.clickCount).toBe(1);
  });
});
