import type { Page } from '@playwright/test';

export async function acknowledgeTerminalConnectSuccessIfPresent(page: Page): Promise<void> {
  const okButton = page.getByRole('button', { name: 'OK' });
  if (await okButton.count()) {
    await okButton.click();
  }
}
