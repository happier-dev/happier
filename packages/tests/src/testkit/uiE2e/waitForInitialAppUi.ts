import type { Page } from '@playwright/test';

export type InitialAppUiPage = Pick<Page, 'getByTestId' | 'getByRole' | 'waitForTimeout' | 'reload'>;

async function countVisible(page: InitialAppUiPage): Promise<number> {
  return (
    (await page.getByTestId('session-getting-started-kind-connect_machine').count())
    + (await page.getByTestId('welcome-create-account').count())
    + (await page.getByRole('button', { name: 'Create account' }).count())
    + (await page.getByTestId('sidebar-expand-button').count())
    + (await page.getByTestId('session-composer-input').count())
  );
}

async function waitForInitialUiOnce(params: Readonly<{
  page: InitialAppUiPage;
  timeoutMs: number;
  browserDiagnostics?: (() => string) | undefined;
}>): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    if ((await countVisible(params.page)) > 0) return;
    await params.page.waitForTimeout(250);
  }
  const diagnostics = params.browserDiagnostics ? `\n\n${params.browserDiagnostics()}` : '';
  throw new Error(`App did not render initial UI within ${params.timeoutMs}ms.${diagnostics}`);
}

export async function waitForInitialAppUi(params: Readonly<{
  page: InitialAppUiPage;
  timeoutMs?: number;
  browserDiagnostics?: (() => string) | undefined;
  reloadOnFailure?: boolean | undefined;
}>): Promise<void> {
  const timeoutMs = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
    ? params.timeoutMs
    : 120_000;
  const reloadOnFailure = params.reloadOnFailure !== false;

  try {
    await waitForInitialUiOnce({
      page: params.page,
      timeoutMs,
      browserDiagnostics: params.browserDiagnostics,
    });
  } catch (error) {
    if (!reloadOnFailure) throw error;
    await params.page.reload({ waitUntil: 'domcontentloaded' });
    await waitForInitialUiOnce({
      page: params.page,
      timeoutMs,
      browserDiagnostics: params.browserDiagnostics,
    });
  }
}
