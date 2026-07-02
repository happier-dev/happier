import { expect, type Locator, type Page } from '@playwright/test';

export type ClickWelcomeSignupProviderPage = Pick<Page, 'getByTestId' | 'getByRole' | 'locator' | 'waitForTimeout'>;

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

async function clickVisible(locator: Locator): Promise<boolean> {
  const target = await firstVisible(locator);
  if (!target) return false;
  try {
    await target.click({ timeout: 1_500 });
    return true;
  } catch {
    try {
      await target.click({ timeout: 1_500, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

export async function clickWelcomeSignupProvider(params: Readonly<{
  page: ClickWelcomeSignupProviderPage;
  timeoutMs?: number;
}>): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 120_000;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const providerSignup = params.page.getByTestId('welcome-signup-provider');
    const visibleProviderSignup = await firstVisible(providerSignup);
    if (visibleProviderSignup) {
      await expect(visibleProviderSignup).toBeEnabled({ timeout: 30_000 });
      await visibleProviderSignup.click();
      return;
    }

    if (await clickVisible(params.page.getByTestId('brand-hero-get-started'))) {
      await params.page.waitForTimeout(250);
      continue;
    }

    if (await clickVisible(params.page.getByTestId('onboarding-showcase-primary'))) {
      await params.page.waitForTimeout(250);
      continue;
    }

    if (await clickVisible(params.page.getByTestId('release-notes-primary'))) {
      await params.page.waitForTimeout(250);
      continue;
    }

    if (await clickVisible(params.page.getByRole('button', { name: 'Get started' }))) {
      await params.page.waitForTimeout(250);
      continue;
    }

    await params.page.waitForTimeout(250);
  }

  const visibleWelcomeTestIds = await params.page.locator('[data-testid]').evaluateAll((nodes) => {
    return nodes
      .map((node) => node.getAttribute('data-testid'))
      .filter((value): value is string => typeof value === 'string' && value.startsWith('welcome-'));
  }).catch(() => []);

  throw new Error(`Timed out waiting for welcome provider signup CTA. Visible welcome testIDs: ${
    visibleWelcomeTestIds.length > 0 ? visibleWelcomeTestIds.join(', ') : '(none)'
  }`);
}
