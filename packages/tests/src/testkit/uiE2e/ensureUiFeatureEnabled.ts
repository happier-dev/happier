import { expect, type Locator, type Page } from '@playwright/test';

import { gotoDomContentLoadedWithRetries } from './pageNavigation';

async function ensureSwitchEnabled(toggle: Locator, timeoutMs: number): Promise<void> {
  await expect(toggle).toHaveCount(1, { timeout: timeoutMs });
  if ((await toggle.getAttribute('aria-checked')) !== 'true') {
    await toggle.click();
  }
  await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: timeoutMs });
}

export async function ensureUiFeatureEnabled(params: Readonly<{
  page: Page;
  baseUrl: string;
  featureId: string;
  timeoutMs?: number;
}>): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 180_000;
  await gotoDomContentLoadedWithRetries(
    params.page,
    `${params.baseUrl}/settings/features?happier_hmr=0`,
    timeoutMs,
  );
  await ensureSwitchEnabled(params.page.getByTestId('settings-feature-experiments-toggle'), timeoutMs);
  await ensureSwitchEnabled(params.page.getByTestId(`settings-feature-toggle-${params.featureId}`), timeoutMs);
}
