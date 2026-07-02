import type { Locator, Page } from '@playwright/test';

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

const READY_PRESENCE_ONLY_TEST_IDS = [
  'session-getting-started-kind-connect_machine',
  'session-getting-started-kind-start_daemon',
  'session-getting-started-kind-create_session',
  'session-getting-started-kind-select_session',
] as const;

const AUTHENTICATED_READY_TEST_IDS = [
  'session-getting-started-kind-connect_machine',
  'session-getting-started-kind-start_daemon',
  'session-getting-started-kind-create_session',
  'session-getting-started-kind-select_session',
  'session-composer-input',
  'new-session-composer-input',
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

const STORY_DECK_PRIMARY_ROLE_BUTTON_NAMES = [
  'Next',
  'Continue',
  'Get Started',
  'Get started',
] as const;

async function countReadySignals(page: EnsureAccountReadyForConnectPage): Promise<number> {
  let total = 0;
  for (const testId of READY_TEST_IDS) {
    if ((READY_PRESENCE_ONLY_TEST_IDS as readonly string[]).includes(testId)) {
      total += await page.getByTestId(testId).count();
      continue;
    }
    total += await countVisible(page.getByTestId(testId));
  }
  for (const name of READY_ROLE_BUTTON_NAMES) {
    total += await countVisible(page.getByRole('button', { name }));
  }
  return total;
}

async function countAuthenticatedReadySignals(page: EnsureAccountReadyForConnectPage): Promise<number> {
  let total = 0;
  for (const testId of AUTHENTICATED_READY_TEST_IDS) {
    total += await countVisible(page.getByTestId(testId));
  }
  return total;
}

async function countVisible(locator: Locator): Promise<number> {
  const count = await locator.count();
  let visible = 0;
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible().catch(() => false)) {
      visible += 1;
    }
  }
  return visible;
}

async function firstVisible(locator: Locator): Promise<Locator | null> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      return candidate;
    }
  }
  return null;
}

async function clickLocatorWithFallback(params: Readonly<{
  page: EnsureAccountReadyForConnectPage;
  testId: string;
}>): Promise<boolean> {
  const byTestId = await firstVisible(params.page.getByTestId(params.testId));
  if (!byTestId) return false;
  try {
    await byTestId.click({ timeout: 1_500 });
    return true;
  } catch {
    // Some startup overlays can intercept pointer events. Retry with force to
    // keep startup deterministic when the CTA is otherwise visible.
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
  const byRole = await firstVisible(params.page.getByRole('button', { name: params.name }));
  if (!byRole) return false;
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

async function clickCreateAccountIfPresent(page: EnsureAccountReadyForConnectPage): Promise<boolean> {
  if (await clickLocatorWithFallback({ page, testId: 'welcome-primary-start' })) return true;
  if (await clickLocatorWithFallback({ page, testId: 'welcome-create-account' })) return true;
  if (await clickRoleButtonWithFallback({ page, name: 'Create account' })) return true;
  return false;
}

async function hasCreateAccountCta(page: EnsureAccountReadyForConnectPage): Promise<boolean> {
  if (await firstVisible(page.getByTestId('welcome-primary-start'))) return true;
  if (await firstVisible(page.getByTestId('welcome-create-account'))) return true;
  if (await firstVisible(page.getByRole('button', { name: 'Create account' }))) return true;
  return false;
}

async function advanceStoryDeckIfPresent(page: EnsureAccountReadyForConnectPage): Promise<boolean> {
  for (const testId of STORY_DECK_PRIMARY_TEST_IDS) {
    if (await clickLocatorWithFallback({ page, testId })) return true;
  }
  for (const name of STORY_DECK_PRIMARY_ROLE_BUTTON_NAMES) {
    if (await clickRoleButtonWithFallback({ page, name })) return true;
  }
  return false;
}

async function ensureReadyOrProgress(params: Readonly<{
  page: EnsureAccountReadyForConnectPage;
  clickCreateAccount: boolean;
}>): Promise<boolean> {
  if (params.clickCreateAccount) {
    if (await clickCreateAccountIfPresent(params.page)) {
      return (await countAuthenticatedReadySignals(params.page)) > 0;
    }
  } else if (await hasCreateAccountCta(params.page)) {
    return false;
  }
  if ((await countReadySignals(params.page)) > 0) return true;
  await advanceStoryDeckIfPresent(params.page);
  if ((await countReadySignals(params.page)) > 0) return true;
  if (!params.clickCreateAccount) return false;
  if (await clickCreateAccountIfPresent(params.page)) {
    return (await countAuthenticatedReadySignals(params.page)) > 0;
  }
  return false;
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
