export type TerminalConnectApprovalReadyPage = Readonly<{
  locator: (selector: string) => Readonly<{ count: () => Promise<number> }>;
  getByRole?: (role: 'button', options: Readonly<{ name: string; exact?: boolean }>) => Readonly<{ count: () => Promise<number> }>;
  waitForTimeout: (ms: number) => Promise<void>;
  waitForURL: (matcher: (url: URL) => boolean, options?: Readonly<{ timeout?: number }>) => Promise<void>;
  url?: () => string;
}>;

function isCurrentTerminalRoute(page: TerminalConnectApprovalReadyPage): boolean {
  if (typeof page.url !== 'function') return false;
  try {
    return new URL(page.url()).pathname.startsWith('/terminal');
  } catch {
    return false;
  }
}

async function waitForTerminalRoute(page: TerminalConnectApprovalReadyPage, timeoutMs: number): Promise<void> {
  if (isCurrentTerminalRoute(page)) {
    return;
  }

  await page.waitForURL((url) => url.pathname.startsWith('/terminal'), {
    timeout: timeoutMs,
  });
}

async function hasUnauthWelcomeStartSurface(page: TerminalConnectApprovalReadyPage): Promise<boolean> {
  if ((await page.locator('[data-testid="brand-hero-get-started"]:visible').count()) > 0) {
    return true;
  }
  if ((await page.locator('[data-testid="welcome-primary-start"]:visible').count()) > 0) {
    return true;
  }

  const firstTimeButton = page.getByRole?.('button', { name: "First time here — let's start", exact: true });
  return firstTimeButton ? (await firstTimeButton.count()) > 0 : false;
}

export async function waitForTerminalConnectReadySurface(
  page: TerminalConnectApprovalReadyPage,
  timeoutMs = 120_000,
): Promise<'restore' | 'approve'> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if ((await page.locator('[data-testid="terminal-connect-approve"]:visible').count()) > 0) {
      return 'approve';
    }
    const approveButton = page.getByRole?.('button', { name: 'Accept Connection', exact: true });
    if (approveButton && (await approveButton.count()) > 0) {
      return 'approve';
    }
    if ((await page.locator('[data-testid="welcome-restore"]:visible').count()) > 0) {
      return 'restore';
    }
    if (await hasUnauthWelcomeStartSurface(page)) {
      return 'restore';
    }
    await page.waitForTimeout(250);
  }

  throw new Error('terminal connect did not reach restore or approve surface');
}

export async function ensurePendingTerminalConnectReadyForApproval(params: Readonly<{
  page: TerminalConnectApprovalReadyPage;
  connectUrlForBrowser: string;
  gotoConnectUrl: (url: string, timeoutMs: number) => Promise<void>;
  restoreAccount: () => Promise<void>;
  timeoutMs?: number;
}>): Promise<'approve'> {
  const timeoutMs = params.timeoutMs ?? 120_000;
  const startedAt = Date.now();
  const timeoutError = (): Error => new Error('terminal connect did not reach restore or approve surface');
  const readRemainingTimeoutMs = (): number => timeoutMs - (Date.now() - startedAt);
  const requireRemainingTimeoutMs = (error: unknown): number => {
    const remainingTimeoutMs = readRemainingTimeoutMs();
    if (remainingTimeoutMs <= 0) {
      throw error;
    }
    return remainingTimeoutMs;
  };

  while (true) {
    const remainingTimeoutMs = requireRemainingTimeoutMs(timeoutError());
    let readySurface: 'restore' | 'approve';
    try {
      readySurface = await waitForTerminalConnectReadySurface(params.page, Math.min(remainingTimeoutMs, 30_000));
    } catch (error) {
      const remainingAfterWaitMs = requireRemainingTimeoutMs(error);
      await params.gotoConnectUrl(params.connectUrlForBrowser, remainingAfterWaitMs);
      await waitForTerminalRoute(params.page, requireRemainingTimeoutMs(error));
      continue;
    }
    if (readySurface === 'approve') {
      return 'approve';
    }

    requireRemainingTimeoutMs(timeoutError());
    await params.restoreAccount();
    const remainingAfterRestoreMs = requireRemainingTimeoutMs(timeoutError());
    await params.gotoConnectUrl(params.connectUrlForBrowser, remainingAfterRestoreMs);
    await waitForTerminalRoute(
      params.page,
      requireRemainingTimeoutMs(timeoutError()),
    );
  }
}
