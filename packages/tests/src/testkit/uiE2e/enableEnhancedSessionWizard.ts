import { expect, type Locator, type Page } from '@playwright/test';

import { gotoDomContentLoadedWithPathFallback } from './pageNavigation';

const SESSION_SETTINGS_PATHNAME = '/settings/session';
const WIZARD_MODE_TEST_ID = 'settings-new-session-wizard-mode';

export async function enableEnhancedSessionWizard(params: Readonly<{
  page: Page;
  baseUrl: string;
  timeoutMs?: number;
}>): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  const wizardModeItem = await waitForWizardModeItem({
    page: params.page,
    baseUrl: params.baseUrl,
    timeoutMs,
  });

  const wizardModeSwitch = wizardModeItem.locator('input[type="checkbox"]').first();
  if ((await wizardModeSwitch.count()) === 0) {
    await wizardModeItem.click();
    return;
  }

  const isChecked = await wizardModeSwitch.isChecked().catch(() => false);
  if (!isChecked) {
    await wizardModeItem.click();
  }
  await expect(wizardModeSwitch).toBeChecked({ timeout: timeoutMs });
}

async function waitForWizardModeItem(params: Readonly<{
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

    const wizardModeItem = params.page.getByTestId(WIZARD_MODE_TEST_ID);
    if ((await wizardModeItem.count()) === 1) {
      return wizardModeItem;
    }

    await params.page.waitForTimeout(Math.min(250, remainingTimeoutMs));
  }

  const wizardModeItem = params.page.getByTestId(WIZARD_MODE_TEST_ID);
  await expect(wizardModeItem).toHaveCount(1, { timeout: 1 });
  return wizardModeItem;
}

function readPathname(page: Pick<Page, 'url'>): string | null {
  try {
    return new URL(page.url()).pathname;
  } catch {
    return null;
  }
}
