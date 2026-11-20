import type { Page } from '@playwright/test';

export async function acknowledgeTerminalConnectSuccessIfPresent(page: Page): Promise<void> {
  const okButton = page.getByTestId('terminal-connect-continue').or(page.getByTestId('web-modal-button-0')).first();
  try {
    await okButton.waitFor({ state: 'visible', timeout: 1500 });
    await okButton.click();
  } catch {
    // Not present.
  }
}
