import { expect, type Page } from '@playwright/test';

import { gotoDomContentLoadedWithRetries } from './pageNavigation';

export async function enableEnhancedSessionWizard(params: Readonly<{
  page: Page;
  baseUrl: string;
  timeoutMs?: number;
}>): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/settings/session`, timeoutMs);

  const wizardModeItem = params.page.getByTestId('settings-new-session-wizard-mode');
  await expect(wizardModeItem).toHaveCount(1, { timeout: timeoutMs });

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
