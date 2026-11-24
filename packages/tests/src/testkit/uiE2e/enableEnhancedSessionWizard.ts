import { expect, type Locator, type Page } from '@playwright/test';

import { gotoDomContentLoadedWithPathFallback } from './pageNavigation';

const SESSION_SETTINGS_PATHNAME = '/settings/session';
const WIZARD_OPTION_TEST_ID = 'settings-session-startWith:wizard';

export async function enableEnhancedSessionWizard(params: Readonly<{
  page: Page;
  baseUrl: string;
  timeoutMs?: number;
}>): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  const wizardOption = await waitForWizardOption({
    page: params.page,
    baseUrl: params.baseUrl,
    timeoutMs,
  });

  if (await wizardOption.getAttribute('aria-checked') !== 'true') {
    await wizardOption.click();
  }
  await expect(wizardOption).toHaveAttribute('aria-checked', 'true', { timeout: timeoutMs });
}

async function waitForWizardOption(params: Readonly<{
  page: Page;
  baseUrl: string;
  timeoutMs: number;
}>): Promise<Locator> {
  const settingsUrl = `${params.baseUrl}${SESSION_SETTINGS_PATHNAME}`;
  const startedAt = Date.now();
  let attemptedNavigation = false;

  while (Date.now() - startedAt < params.timeoutMs) {
    const remainingTimeoutMs = Math.max(1, params.timeoutMs - (Date.now() - startedAt));
    if (!attemptedNavigation || readPathname(params.page) !== SESSION_SETTINGS_PATHNAME) {
      attemptedNavigation = true;
      await gotoDomContentLoadedWithPathFallback(
        params.page,
        settingsUrl,
        SESSION_SETTINGS_PATHNAME,
        remainingTimeoutMs,
      );
    }

    const wizardOption = params.page.getByTestId(WIZARD_OPTION_TEST_ID);
    if ((await wizardOption.count()) === 1) {
      return wizardOption;
    }

    await params.page.waitForTimeout(Math.min(250, remainingTimeoutMs));
  }

  const wizardOption = params.page.getByTestId(WIZARD_OPTION_TEST_ID);
  await expect(wizardOption).toHaveCount(1, { timeout: 1 });
  return wizardOption;
}

function readPathname(page: Pick<Page, 'url'>): string | null {
  try {
    return new URL(page.url()).pathname;
  } catch {
    return null;
  }
}
