import type { Page } from '@playwright/test';

export type EnsureAccountReadyForConnectPage = Pick<Page, 'getByTestId' | 'getByRole' | 'waitForTimeout'>;

const READY_TEST_IDS = [
  'session-getting-started-kind-connect_machine',
  'session-getting-started-kind-start_daemon',
  'session-getting-started-kind-create_session',
  'session-getting-started-kind-select_session',
  'sidebar-expand-button',
  'session-composer-input',
  'new-session-composer-input',
  'settings-button',
] as const;

const READY_ROLE_BUTTON_NAMES = [
  'Settings',
  'Start New Session',
  'Sessions',
  'Home',
] as const;

const STORY_DECK_PRIMARY_TEST_IDS = [
  'onboarding-showcase-primary',
  'release-notes-primary',
] as const;

async function countReadySignals(page: EnsureAccountReadyForConnectPage): Promise<number> {
  let total = 0;
  for (const testId of READY_TEST_IDS) {
    total += await page.getByTestId(testId).count();
  }
  for (const name of READY_ROLE_BUTTON_NAMES) {
    total += await page.getByRole('button', { name }).count();
  }
  return total;
}

async function clickLocatorWithFallback(params: Readonly<{
  page: EnsureAccountReadyForConnectPage;
  testId: string;
}>): Promise<boolean> {
  const byTestId = params.page.getByTestId(params.testId).first();
  if ((await byTestId.count()) <= 0) return false;
  try {
    await byTestId.click({ timeout: 1_500 });
    return true;
  } catch {
    try {
      await byTestId.click({ timeout: 1_500, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

async function clickRoleButtonWithFallback(params: Readonly<{
  page: EnsureAccountReadyForConnectPage;
  name: string;
}>): Promise<boolean> {
  const byRole = params.page.getByRole('button', { name: params.name }).first();
  if ((await byRole.count()) <= 0) return false;
  try {
    await byRole.click({ timeout: 1_500 });
    return true;
  } catch {
    try {
      await byRole.click({ timeout: 1_500, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

async function clickCreateAccountIfPresent(page: EnsureAccountReadyForConnectPage): Promise<void> {
  if (await clickLocatorWithFallback({ page, testId: 'welcome-create-account' })) return;
  if (await clickRoleButtonWithFallback({ page, name: 'Create account' })) return;
}

async function advanceStoryDeckIfPresent(page: EnsureAccountReadyForConnectPage): Promise<boolean> {
  for (const testId of STORY_DECK_PRIMARY_TEST_IDS) {
    if (await clickLocatorWithFallback({ page, testId })) return true;
  }
  return false;
}

async function ensureReadyOrProgress(params: Readonly<{
  page: EnsureAccountReadyForConnectPage;
  clickCreateAccount: boolean;
}>): Promise<boolean> {
  if ((await countReadySignals(params.page)) > 0) return true;
  await advanceStoryDeckIfPresent(params.page);
  if ((await countReadySignals(params.page)) > 0) return true;
  if (!params.clickCreateAccount) return false;
  await clickCreateAccountIfPresent(params.page);
  return (await countReadySignals(params.page)) > 0;
}

export async function ensureAccountReadyForConnect(params: Readonly<{
  page: EnsureAccountReadyForConnectPage;
  timeoutMs?: number;
  clickCreateAccount?: boolean;
}>): Promise<void> {
  const timeoutMs = typeof params.timeoutMs === 'number' && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0
    ? params.timeoutMs
    : 120_000;
  const clickCreateAccount = params.clickCreateAccount !== false;

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await ensureReadyOrProgress({ page: params.page, clickCreateAccount })) return;
    await params.page.waitForTimeout(250);
  }

  throw new Error(`Account did not reach a ready UI state within ${timeoutMs}ms.`);
}
