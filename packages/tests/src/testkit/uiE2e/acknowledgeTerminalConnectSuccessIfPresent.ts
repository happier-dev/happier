import type { Page } from '@playwright/test';

export async function acknowledgeTerminalConnectSuccessIfPresent(page: Page): Promise<void> {
  const okButton = page.getByRole('button', { name: 'OK' });
  try {
    await okButton.first().waitFor({ state: 'visible', timeout: 1500 });
    await okButton.first().click();
  } catch {
    // Not present.
  }
}
