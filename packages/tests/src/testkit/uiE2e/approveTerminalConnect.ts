import { type Page } from '@playwright/test';

type TerminalConnectApproveLocator = Readonly<{
  count: () => Promise<number>;
  click: (options?: Readonly<{ timeout?: number; noWaitAfter?: boolean; force?: boolean }>) => Promise<void>;
  evaluate?: <T>(callback: (element: HTMLElement) => T | Promise<T>) => Promise<T>;
}>;

export type TerminalConnectApprovePage = Readonly<{
  locator: (selector: string) => TerminalConnectApproveLocator;
  getByTestId?: (testId: string) => TerminalConnectApproveLocator;
  getByRole: (role: 'button', options: Readonly<{ name: string; exact?: boolean }>) => TerminalConnectApproveLocator;
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

async function maybeDismissWebModal(params: Readonly<{ page: TerminalConnectApprovePage; timeoutMs: number }>): Promise<boolean> {
  const confirm = first(params.page.locator('[data-testid="web-modal-confirm"]:visible'));
  const button0 = first(params.page.locator('[data-testid="web-modal-button-0"]:visible'));

  const intervalMs = 200;
  const attempts = resolvePollAttempts(params.timeoutMs, intervalMs);
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if ((await confirm.count()) > 0) {
      await confirm.click({ timeout: 15_000 });
      await waitForLocatorGone({ locator: confirm, page: params.page, timeoutMs: 60_000 });
      return true;
    }
    if ((await button0.count()) > 0) {
      await button0.click({ timeout: 15_000 });
      await waitForLocatorGone({ locator: button0, page: params.page, timeoutMs: 60_000 });
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

async function findVisibleApproveLocator(page: TerminalConnectApprovePage): Promise<TerminalConnectApproveLocator | null> {
  const visibleByTestId = first(page.locator('[data-testid="terminal-connect-approve"]:visible'));
  if ((await visibleByTestId.count()) > 0) {
    return visibleByTestId;
  }

  const roleButton = first(page.getByRole('button', { name: 'Accept Connection', exact: true }));
  if ((await roleButton.count()) > 0) {
    return roleButton;
  }

  return null;
}

async function isApprovalSurfaceVisible(page: TerminalConnectApprovePage): Promise<boolean> {
  return (await findVisibleApproveLocator(page)) !== null;
}

async function activateApproveLocator(locator: TerminalConnectApproveLocator): Promise<void> {
  await locator.click({ timeout: 15_000, noWaitAfter: true, force: true });
  if (typeof locator.evaluate !== 'function') return;

  await locator.evaluate((element) => {
    element.click();
  });
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

export async function approveTerminalConnect(params: Readonly<{ page: Page | TerminalConnectApprovePage; timeoutMs?: number }>): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  const intervalMs = 250;
  const attempts = resolvePollAttempts(timeoutMs, intervalMs);
  let clicked = false;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const approve = await findVisibleApproveLocator(params.page);
    if (approve) {
      clicked = true;
      await activateApproveLocator(approve);
      await params.page.waitForTimeout(intervalMs);
      if (await maybeDismissWebModal({ page: params.page, timeoutMs: 1_000 })) {
        if (await didLeaveTerminalConnect(params.page, 5_000)) {
          return;
        }
      }
      if (!(await isApprovalSurfaceVisible(params.page))) {
        if (await didLeaveTerminalConnect(params.page, 5_000)) {
          return;
        }
      }
    }

    await params.page.waitForTimeout(intervalMs);
  }

  throw new Error(clicked
    ? 'terminal connect approval did not complete'
    : 'terminal connect approval button did not appear');
}
