import type { Page } from '@playwright/test';

export { normalizeLoopbackBaseUrl } from '../network/loopbackBaseUrl';
import { expandLoopbackBaseUrlCandidates } from '../network/loopbackBaseUrl';
import { normalizeLoopbackBaseUrl } from '../network/loopbackBaseUrl';
import { dismissSetupWizardIfVisible } from './createAccountAndReachConnectMachineState';

export {
  createAccountAndReachConnectMachineState,
  createAccountAndReachSetupWizardState,
  dismissSetupWizardIfVisible,
} from './createAccountAndReachConnectMachineState';

type GotoPage = Pick<Page, 'goto' | 'url' | 'waitForTimeout'>;

const AUTHENTICATED_ROUTE_REVISIT_INTERVAL_MS = 1_000;

export async function gotoDomContentLoadedWithRetries(page: GotoPage, url: string, timeoutMs = 90_000): Promise<void> {
  await gotoWithRetries(page, url, timeoutMs, 'domcontentloaded');
}

export async function gotoCommittedWithRetries(page: GotoPage, url: string, timeoutMs = 90_000): Promise<void> {
  await gotoWithRetries(page, url, timeoutMs, 'commit');
}

async function gotoWithRetries(page: GotoPage, url: string, timeoutMs: number, waitUntil: 'commit' | 'domcontentloaded'): Promise<void> {
  const normalizeUrl = (value: string): string => value.replace(/\/+$/, '');
  const normalizeLoopbackUrl = (value: string): string => normalizeUrl(normalizeLoopbackBaseUrl(value));
  const isChromeWebDataErrorNavigation = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('chrome-error://chromewebdata/');
  };
  const isInterruptedByAnotherNavigation = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    return message.includes('is interrupted by another navigation');
  };
  const retryable = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('net::ERR_NETWORK_CHANGED')
      || message.includes('net::ERR_CONNECTION_REFUSED')
      || message.includes('net::ERR_CONNECTION_RESET')
      || message.includes('ECONNRESET')
      || message.includes('EPIPE')
      || message.includes('net::ERR_ABORTED')
      || message.includes('is interrupted by another navigation')
      // Chromium navigates to a chrome-error:// page when it cannot reach the target origin.
      // Treat this as a transient connectivity failure and retry alternate loopback candidates.
      || message.includes('chrome-error://chromewebdata/')
    );
  };

  const shouldTryNextCandidateImmediately = (error: unknown): boolean => {
    const message = error instanceof Error ? error.message : String(error);
    return (
      message.includes('net::ERR_CONNECTION_REFUSED')
      || message.includes('net::ERR_ABORTED')
      || isInterruptedByAnotherNavigation(error)
      || isChromeWebDataErrorNavigation(error)
    );
  };

  const isCommittedTimeout = (error: unknown, candidateUrl: string): boolean => {
    if (waitUntil !== 'commit') return false;
    const message = error instanceof Error ? error.message : String(error);
    if (!message.toLowerCase().includes('timeout')) return false;
    return normalizeLoopbackUrl(page.url()) === normalizeLoopbackUrl(candidateUrl);
  };

  const start = Date.now();
  let attempt = 0;
  const candidateUrls = expandLoopbackBaseUrlCandidates(url);
  // Metro can briefly restart or drop connections during bundling; retry a few times for stability.
  let lastRetryableError: unknown = null;
  while (Date.now() - start < timeoutMs) {
    attempt += 1;
    lastRetryableError = null;
    for (const candidateUrl of candidateUrls) {
      try {
        const remaining = Math.max(5_000, timeoutMs - (Date.now() - start));
        await page.goto(candidateUrl, { waitUntil, timeout: remaining });
        return;
      } catch (error) {
        if (isCommittedTimeout(error, candidateUrl)) return;
        if (!retryable(error)) throw error;
        lastRetryableError = error;
        if (!shouldTryNextCandidateImmediately(error)) break;
      }
    }

    if (lastRetryableError == null) {
      throw new Error('Navigation failed.');
    }

    if (Date.now() - start >= timeoutMs) {
      break;
    }

    await page.waitForTimeout(Math.min(5_000, 500 * attempt));
  }

  if (lastRetryableError != null) {
    throw lastRetryableError instanceof Error
      ? lastRetryableError
      : new Error(String(lastRetryableError ?? 'Navigation failed.'));
  }
}

function normalizePathname(value: string): string {
  if (!value) return '/';
  let pathname = value.trim();
  if (!pathname.startsWith('/')) pathname = `/${pathname}`;
  pathname = pathname.replace(/\/+$/, '');
  return pathname || '/';
}

export function isGotoTimeoutOnExpectedPath(page: Pick<Page, 'url'>, expectedPathname: string, error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.toLowerCase().includes('timeout')) return false;
  return hasPathname(page.url(), expectedPathname);
}

export function hasPathname(url: string, expectedPathname: string): boolean {
  try {
    return normalizePathname(new URL(url).pathname) === normalizePathname(expectedPathname);
  } catch {
    return false;
  }
}

export async function gotoDomContentLoadedWithPathFallback(
  page: GotoPage,
  url: string,
  expectedPathname: string,
  timeoutMs = 90_000,
): Promise<void> {
  try {
    await gotoDomContentLoadedWithRetries(page, url, timeoutMs);
  } catch (error) {
    if (isGotoTimeoutOnExpectedPath(page, expectedPathname, error)) return;
    throw error;
  }
}

export async function waitForAuthenticatedHomeUi(params: Readonly<{
  page: Pick<Page, 'getByTestId' | 'reload' | 'url' | 'waitForTimeout'>;
  timeoutMs?: number;
  browserDiagnostics?: (() => string) | undefined;
  reloadOnFailure?: boolean | undefined;
}>): Promise<void> {
  await waitForHomeUi({
    page: params.page,
    timeoutMs: params.timeoutMs,
    browserDiagnostics: params.browserDiagnostics,
    reloadOnFailure: params.reloadOnFailure,
    requireSessionActions: false,
  });
}

export async function waitForSessionActionsHomeUi(params: Readonly<{
  page: Pick<Page, 'getByTestId' | 'reload' | 'url' | 'waitForTimeout'>;
  timeoutMs?: number;
  browserDiagnostics?: (() => string) | undefined;
  reloadOnFailure?: boolean | undefined;
}>): Promise<void> {
  await waitForHomeUi({
    page: params.page,
    timeoutMs: params.timeoutMs,
    browserDiagnostics: params.browserDiagnostics,
    reloadOnFailure: params.reloadOnFailure,
    requireSessionActions: true,
  });
}

export async function waitForAuthenticatedRouteUi(params: Readonly<{
  page: Pick<Page, 'getByTestId' | 'goto' | 'reload' | 'url' | 'waitForTimeout'>;
  expectedPathname: string;
  requiredTestIds: readonly string[];
  blockedTestIds?: readonly string[] | undefined;
  targetUrl?: string | undefined;
  timeoutMs?: number;
  browserDiagnostics?: (() => string) | undefined;
  reloadOnFailure?: boolean | undefined;
}>): Promise<void> {
  const timeoutMs = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
    ? params.timeoutMs
    : 120_000;
  const reloadOnFailure = params.reloadOnFailure !== false;
  const expectedPathname = normalizePathname(params.expectedPathname);
  const requiredTestIds = params.requiredTestIds.filter((value) => typeof value === 'string' && value.trim().length > 0);
  const blockedTestIds = (params.blockedTestIds ?? ['welcome-create-account'])
    .filter((value) => typeof value === 'string' && value.trim().length > 0);

  if (requiredTestIds.length === 0) {
    throw new Error('waitForAuthenticatedRouteUi requires at least one required test id.');
  }

  const initialTargetUrl = params.targetUrl ?? params.page.url();

  const waitForRouteUiOnce = async (): Promise<void> => {
    const startedAt = Date.now();
    let lastTargetNavigationAt = 0;
    while (Date.now() - startedAt < timeoutMs) {
      const now = Date.now();
      let pathname: string;
      try {
        pathname = normalizePathname(new URL(params.page.url()).pathname);
      } catch {
        pathname = '';
      }

      if (pathname !== expectedPathname) {
        if (
          params.targetUrl
          && hasPathname(params.targetUrl, expectedPathname)
          && now - lastTargetNavigationAt >= AUTHENTICATED_ROUTE_REVISIT_INTERVAL_MS
        ) {
          lastTargetNavigationAt = now;
          const remainingTimeoutMs = Math.max(1, timeoutMs - (now - startedAt));
          await gotoDomContentLoadedWithPathFallback(
            params.page,
            params.targetUrl,
            expectedPathname,
            remainingTimeoutMs,
          );
          continue;
        }
        await params.page.waitForTimeout(250);
        continue;
      }

      const blockedCounts = await Promise.all(blockedTestIds.map((testId) => params.page.getByTestId(testId).count()));
      const requiredCounts = await Promise.all(requiredTestIds.map((testId) => params.page.getByTestId(testId).count()));
      const blockedVisible = blockedCounts.some((count) => count > 0);
      const requiredVisible = requiredCounts.every((count) => count > 0);

      if (!blockedVisible && requiredVisible) {
        return;
      }

      await params.page.waitForTimeout(250);
    }

    const diagnostics = params.browserDiagnostics ? `\n\n${params.browserDiagnostics()}` : '';
    throw new Error(
      `App did not reach the authenticated route UI for ${expectedPathname} within ${timeoutMs}ms.${diagnostics}`,
    );
  };

  try {
    await waitForRouteUiOnce();
  } catch (error) {
    if (!reloadOnFailure) throw error;
    if (hasPathname(initialTargetUrl, expectedPathname) && !hasPathname(params.page.url(), expectedPathname)) {
      await gotoDomContentLoadedWithPathFallback(params.page, initialTargetUrl, expectedPathname, timeoutMs);
    } else {
      await params.page.reload({ waitUntil: 'domcontentloaded' });
    }
    await waitForRouteUiOnce();
  }
}

async function waitForHomeUi(params: Readonly<{
  page: Pick<Page, 'getByTestId' | 'reload' | 'url' | 'waitForTimeout'>;
  timeoutMs?: number;
  browserDiagnostics?: (() => string) | undefined;
  reloadOnFailure?: boolean | undefined;
  requireSessionActions: boolean;
}>): Promise<void> {
  const timeoutMs = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
    ? params.timeoutMs
    : 120_000;
  const reloadOnFailure = params.reloadOnFailure !== false;

  const waitForHomeUiOnce = async (): Promise<void> => {
    const startedAt = Date.now();
    let switchedToSessionsTab = false;
    while (Date.now() - startedAt < timeoutMs) {
      let pathname: string;
      try {
        pathname = normalizePathname(new URL(params.page.url()).pathname);
      } catch {
        pathname = '';
      }

      if (pathname !== '/') {
        await params.page.waitForTimeout(250);
        continue;
      }

      const welcomeVisible = await params.page.getByTestId('welcome-create-account').count();
      const connectMachineVisible = await params.page.getByTestId('session-getting-started-kind-connect_machine').count();
      const createSessionVisible = await params.page.getByTestId('session-getting-started-kind-create_session').count();
      const selectSessionVisible = await params.page.getByTestId('session-getting-started-kind-select_session').count();
      const startNewSessionVisible = await params.page.getByTestId('main-header-start-new-session').count();
      const setupWizardVisible = await params.page.getByTestId('setupWizard.surface').count();
      const authenticatedHomeVisible = params.requireSessionActions
        ? createSessionVisible > 0 || selectSessionVisible > 0
        : connectMachineVisible > 0
          || createSessionVisible > 0
          || selectSessionVisible > 0
          || startNewSessionVisible > 0;

      if (welcomeVisible === 0 && setupWizardVisible > 0) {
        await dismissSetupWizardIfVisible({ page: params.page });
        await params.page.waitForTimeout(250);
        continue;
      }

      if (welcomeVisible === 0 && authenticatedHomeVisible) {
        return;
      }

      if (!switchedToSessionsTab) {
        const sessionsTab = params.page.getByTestId('tabbar-tab-sessions');
        if (await sessionsTab.count() > 0) {
          try {
            await sessionsTab.click();
            switchedToSessionsTab = true;
          } catch {
            await params.page.waitForTimeout(250);
            continue;
          }
          await params.page.waitForTimeout(250);
          continue;
        }
      }

      await params.page.waitForTimeout(250);
    }

    const diagnostics = params.browserDiagnostics ? `\n\n${params.browserDiagnostics()}` : '';
    throw new Error(`App did not reach the authenticated home UI within ${timeoutMs}ms.${diagnostics}`);
  };

  try {
    await waitForHomeUiOnce();
  } catch (error) {
    if (!reloadOnFailure) throw error;
    await params.page.reload({ waitUntil: 'domcontentloaded' });
    await waitForHomeUiOnce();
  }
}
