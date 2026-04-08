export type TerminalConnectApprovalReadyPage = Readonly<{
  locator: (selector: string) => Readonly<{ count: () => Promise<number> }>;
  waitForTimeout: (ms: number) => Promise<void>;
  waitForURL: (matcher: (url: URL) => boolean, options?: Readonly<{ timeout?: number }>) => Promise<void>;
}>;

export async function waitForTerminalConnectReadySurface(
  page: TerminalConnectApprovalReadyPage,
  timeoutMs = 120_000,
): Promise<'restore' | 'approve'> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if ((await page.locator('[data-testid="welcome-restore"]:visible').count()) > 0) {
      return 'restore';
    }
    if ((await page.locator('[data-testid="terminal-connect-approve"]:visible').count()) > 0) {
      return 'approve';
    }
    await page.waitForTimeout(250);
  }

  throw new Error('terminal connect did not reach restore or approve surface');
}

export async function ensurePendingTerminalConnectReadyForApproval(params: Readonly<{
  page: TerminalConnectApprovalReadyPage;
  connectUrlForBrowser: string;
  gotoConnectUrl: (url: string) => Promise<void>;
  restoreAccount: () => Promise<void>;
  timeoutMs?: number;
}>): Promise<'approve'> {
  const timeoutMs = params.timeoutMs ?? 120_000;
  const startedAt = Date.now();

  while (true) {
    const remainingTimeoutMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
    const readySurface = await waitForTerminalConnectReadySurface(params.page, remainingTimeoutMs);
    if (readySurface === 'approve') {
      return 'approve';
    }

    await params.restoreAccount();
    await params.gotoConnectUrl(params.connectUrlForBrowser);
    await params.page.waitForURL((url) => url.pathname.startsWith('/terminal'), {
      timeout: remainingTimeoutMs,
    });
  }
}
