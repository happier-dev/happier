import { expect, type Page } from '@playwright/test';

export async function selectSessionForkStrategy(
  page: Page,
  strategy: 'native' | 'replay',
): Promise<void> {
  const modal = page.getByTestId('session-fork-strategy-modal');
  await expect(modal).toBeVisible({ timeout: 60_000 });
  const option = page.getByTestId(`session-fork-strategy-${strategy}`);
  await expect(option).toBeVisible({ timeout: 60_000 });
  await expect(option).toBeEnabled({ timeout: 60_000 });
  await option.click();
}
