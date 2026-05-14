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
    if ((await page.getByRole?.('button', { name: 'Accept Connection', exact: true }).count()) > 0) {
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
    let readySurface: 'restore' | 'approve';
    try {
      readySurface = await waitForTerminalConnectReadySurface(params.page, Math.min(remainingTimeoutMs, 30_000));
    } catch (error) {
      if (remainingTimeoutMs <= 1) {
        throw error;
      }
      await params.gotoConnectUrl(params.connectUrlForBrowser);
      await waitForTerminalRoute(params.page, remainingTimeoutMs);
      continue;
    }
    if (readySurface === 'approve') {
      return 'approve';
    }

    await params.restoreAccount();
    await params.gotoConnectUrl(params.connectUrlForBrowser);
    await waitForTerminalRoute(params.page, remainingTimeoutMs);
  }
}
