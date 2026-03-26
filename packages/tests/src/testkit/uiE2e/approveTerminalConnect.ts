import { expect, type Page } from '@playwright/test';

async function maybeDismissWebModal(params: Readonly<{ page: Page; timeoutMs: number }>): Promise<boolean> {
  const startedAt = Date.now();
  const confirm = params.page.locator('[data-testid="web-modal-confirm"]:visible').first();
  const button0 = params.page.locator('[data-testid="web-modal-button-0"]:visible').first();

  while (Date.now() - startedAt < params.timeoutMs) {
    if ((await confirm.count()) > 0) {
      await confirm.click({ timeout: 15_000 });
      await expect(confirm).toHaveCount(0, { timeout: 60_000 });
      return true;
    }
    if ((await button0.count()) > 0) {
      await button0.click({ timeout: 15_000 });
      await expect(button0).toHaveCount(0, { timeout: 60_000 });
      return true;
    }
    await params.page.waitForTimeout(200);
  }

  return false;
}

export async function approveTerminalConnect(params: Readonly<{ page: Page }>): Promise<void> {
  const approve = params.page.getByTestId('terminal-connect-approve');
  await expect(approve).toHaveCount(1, { timeout: 60_000 });
  await approve.click();

  // Terminal connect can succeed with a web modal (OK button) that must be dismissed before
  // continuing to drive the UI.
  await maybeDismissWebModal({ page: params.page, timeoutMs: 30_000 });
}
