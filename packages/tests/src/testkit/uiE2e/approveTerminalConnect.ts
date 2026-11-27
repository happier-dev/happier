import { type Page } from '@playwright/test';

type TerminalConnectApproveLocator = Readonly<{
  count: () => Promise<number>;
  click: (options?: Readonly<{ timeout?: number; noWaitAfter?: boolean }>) => Promise<void>;
}>;

export type TerminalConnectApprovePage = Readonly<{
  locator: (selector: string) => TerminalConnectApproveLocator;
  getByTestId?: (testId: string) => TerminalConnectApproveLocator;
  getByRole: (role: 'button', options: Readonly<{
    name: string;
    exact?: boolean;
    disabled?: boolean;
  }>) => TerminalConnectApproveLocator;
  waitForTimeout: (ms: number) => Promise<void>;
  waitForURL?: (matcher: (url: URL) => boolean, options?: Readonly<{ timeout?: number }>) => Promise<void>;
}>;

function resolvePollAttempts(timeoutMs: number, intervalMs: number): number {
  return Math.max(1, Math.ceil(timeoutMs / intervalMs));
}

async function waitForLocatorGone(params: Readonly<{
  locator: TerminalConnectApproveLocator;
  page: TerminalConnectApprovePage;
  timeoutMs: number;
  intervalMs?: number;
}>): Promise<void> {
  const intervalMs = params.intervalMs ?? 100;
  const attempts = resolvePollAttempts(params.timeoutMs, intervalMs);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if ((await params.locator.count()) === 0) {
      return;
    }
    await params.page.waitForTimeout(intervalMs);
  }
}

async function maybeAcknowledgeTerminalConnect(params: Readonly<{ page: TerminalConnectApprovePage; timeoutMs: number }>): Promise<boolean> {
  const continueButton = first(params.page.locator('[data-testid="terminal-connect-continue"]:visible'));
  const confirm = first(params.page.locator('[data-testid="web-modal-confirm"]:visible'));
  const button0 = first(params.page.locator('[data-testid="web-modal-button-0"]:visible'));

  const intervalMs = 200;
  const attempts = resolvePollAttempts(params.timeoutMs, intervalMs);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    for (const action of [continueButton, confirm, button0]) {
      if ((await action.count()) === 0) continue;
      await action.click({ timeout: 15_000, noWaitAfter: true });
      await waitForLocatorGone({ locator: action, page: params.page, timeoutMs: 60_000 });
      return true;
    }
    await params.page.waitForTimeout(intervalMs);
  }

  return false;
}

function first(locator: TerminalConnectApproveLocator): TerminalConnectApproveLocator {
  const maybeWithFirst = locator as TerminalConnectApproveLocator & { first?: () => TerminalConnectApproveLocator };
  return typeof maybeWithFirst.first === 'function' ? maybeWithFirst.first() : locator;
}

async function findVisibleApproveLocator(
  page: TerminalConnectApprovePage,
  enabledOnly: boolean,
): Promise<TerminalConnectApproveLocator | null> {
  const enabledSelector = enabledOnly ? ':not(:disabled):not([aria-disabled="true"])' : '';
  const visibleByTestId = first(page.locator(`[data-testid="terminal-connect-approve"]:visible${enabledSelector}`));
  if ((await visibleByTestId.count()) > 0) {
    return visibleByTestId;
  }

  const roleButton = first(page.getByRole('button', {
    name: 'Accept Connection',
    exact: true,
    disabled: enabledOnly ? false : undefined,
  }));
  if ((await roleButton.count()) > 0) {
    return roleButton;
  }

  return null;
}

async function didLeaveTerminalConnect(page: TerminalConnectApprovePage, timeoutMs: number): Promise<boolean> {
  if (typeof page.waitForURL !== 'function') {
    return true;
  }

  try {
    await page.waitForURL((url) => !url.pathname.startsWith('/terminal/connect'), { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

export async function approveTerminalConnect(params: Readonly<{
  page: Page | TerminalConnectApprovePage;
  timeoutMs?: number;
  cliAuthentication?: Promise<void>;
}>): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  const intervalMs = 250;
  const attempts = resolvePollAttempts(timeoutMs, intervalMs);
  let clicked = false;
  let cliAuthenticated = false;
  void params.cliAuthentication?.then(() => { cliAuthenticated = true; }, () => {});

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (clicked && cliAuthenticated) return;
    const approve = await findVisibleApproveLocator(params.page, true);
    if (approve) {
      await approve.click({ timeout: 15_000, noWaitAfter: true });
      clicked = true;
      await params.page.waitForTimeout(intervalMs);
    }
    if (clicked) {
      const acknowledged = await maybeAcknowledgeTerminalConnect({ page: params.page, timeoutMs: 1_000 });
      if (cliAuthenticated) return;
      if ((acknowledged || !(await findVisibleApproveLocator(params.page, false)))
        && await didLeaveTerminalConnect(params.page, 5_000)) {
        return;
      }
    }

    await params.page.waitForTimeout(intervalMs);
  }

  if (clicked && cliAuthenticated) return;
  throw new Error(clicked
    ? 'terminal connect approval did not complete'
    : 'terminal connect approval button did not appear');
}
