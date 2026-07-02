import type { Page } from '@playwright/test';

export type InitialAppUiPage = Pick<Page, 'getByTestId' | 'getByRole' | 'locator' | 'waitForTimeout' | 'reload'>;

async function countCrashRecoveryVisible(page: InitialAppUiPage): Promise<number> {
    return (
        (await page.getByTestId('app-crash-restart').count())
        + (await page.getByTestId('app-crash-copy-details').count())
        + (await page.getByTestId('app-crash-report-bug').count())
    );
}

async function countVisible(page: InitialAppUiPage): Promise<number> {
    return (
        (await page.getByTestId('session-getting-started-kind-connect_machine').count())
        + (await page.getByTestId('brand-hero-get-started').count())
        + (await page.getByTestId('welcome-primary-start').count())
        + (await page.getByRole('button', { name: /First time here/ }).count())
        + (await page.getByTestId('setupWizard.surface').count())
        + (await page.getByTestId('setup.postAuth').count())
        + (await page.getByTestId('setup.continueToAuth').count())
    + (await page.getByTestId('welcome-server-loading').count())
    + (await page.getByTestId('welcome-server-unavailable').count())
    + (await page.getByTestId('welcome-create-account').count())
    + (await page.getByTestId('welcome-signup-provider').count())
    + (await page.getByTestId('welcome-restore').count())
    + (await page.getByTestId('welcome-mtls-login').count())
        + (await page.getByTestId('restore-open-manual').count())
        + (await page.getByTestId('onboarding-wizard-relay-diagram').count())
        // Use stable shell test ids for authenticated readiness so copy/localization changes do not affect e2e.
        + (await page.getByTestId('nav-new-session').count())
        + (await page.getByTestId('main-header-start-new-session').count())
        + (await page.getByTestId('home-header-start-new-session').count())
        + (await page.getByTestId('sidebar-expand-button').count())
        + (await page.locator('[data-testid^="session-list-item-"]').count())
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
    if ((await countCrashRecoveryVisible(params.page)) > 0) {
      const diagnostics = params.browserDiagnostics ? `\n\n${params.browserDiagnostics()}` : '';
      throw new Error(`App crash recovery UI rendered before initial app UI.${diagnostics}`);
    }
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
    await params.page.reload({ waitUntil: 'commit' });
    await waitForInitialUiOnce({
      page: params.page,
      timeoutMs,
      browserDiagnostics: params.browserDiagnostics,
    });
  }
}
