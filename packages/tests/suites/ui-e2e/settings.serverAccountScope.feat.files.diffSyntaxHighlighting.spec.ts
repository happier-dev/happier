import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import {
  gotoDomContentLoadedWithPathFallback,
  gotoDomContentLoadedWithRetries,
  normalizeLoopbackBaseUrl,
} from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e' });
const DIFF_SYNTAX_TOGGLE_ID = 'settings-feature-toggle-files.diffSyntaxHighlighting';

async function createAccountWithoutDaemon(params: Readonly<{
  page: Page;
  uiBaseUrl: string;
}>): Promise<void> {
  await gotoDomContentLoadedWithPathFallback(params.page, `${params.uiBaseUrl}/`, '/', 120_000);
  await waitForInitialAppUi({ page: params.page, timeoutMs: 180_000 });
  await createAccountIfNeeded(params.page);
}

async function createAccountIfNeeded(page: Page): Promise<void> {
  const welcomeCreateAccount = page.getByTestId('welcome-create-account');
  if (await welcomeCreateAccount.count()) {
    await welcomeCreateAccount.click({ timeout: 60_000, force: true });
    await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });
    return;
  }

  const welcomeSignupProvider = page.getByTestId('welcome-signup-provider');
  if (await welcomeSignupProvider.count()) {
    await welcomeSignupProvider.click({ timeout: 60_000, force: true });
    await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });
  }
}

function deriveServerIdFromUrl(serverUrl: string): string {
  const normalized = serverUrl.trim();
  const parsed = new URL(normalized);
  const port = parsed.port ? `-${parsed.port}` : '';
  const base = `${parsed.hostname.toLowerCase()}${port}`;
  return base.replace(/[^a-z0-9._-]/g, '_').replace(/_+/g, '_') || 'custom';
}

async function expectDiffSyntaxToggleChecked(page: Page, uiBaseUrl: string, checked: boolean): Promise<void> {
  await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/features?happier_hmr=0`, 180_000);
  const toggle = page.getByTestId(DIFF_SYNTAX_TOGGLE_ID);
  await expect(toggle).toHaveCount(1, { timeout: 60_000 });
  if (checked) {
    await expect(toggle).toBeChecked({ timeout: 60_000 });
  } else {
    await expect(toggle).not.toBeChecked({ timeout: 60_000 });
  }
}

test.describe('ui e2e: server/account scoped settings', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('settings-server-account-scope-suite');

  let primaryServer: StartedServer | null = null;
  let secondaryServer: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;

  test.beforeAll(async () => {
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-settings-scope-${run.runId}`,
    };

    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
    await mkdir(suiteDir, { recursive: true });

    primaryServer = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
      },
    });

    secondaryServer = await startServerLight({
      testDir: resolve(join(suiteDir, 'secondary-server')),
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...uiWebEnv,
        EXPO_PUBLIC_HAPPY_SERVER_URL: primaryServer.baseUrl,
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await ui?.stop().catch(() => {});
    await secondaryServer?.stop().catch(() => {});
    await primaryServer?.stop().catch(() => {});
  });

  test('keeps synced settings isolated when switching between server accounts', async ({ page }) => {
    test.setTimeout(360_000);
    if (!primaryServer || !secondaryServer || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    await page.setViewportSize({ width: 1440, height: 900 });
    await createAccountWithoutDaemon({ page, uiBaseUrl });
    const primaryServerId = deriveServerIdFromUrl(primaryServer.baseUrl);

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/features?happier_hmr=0`, 180_000);
    const primaryToggle = page.getByTestId(DIFF_SYNTAX_TOGGLE_ID);
    await expect(primaryToggle).toHaveCount(1, { timeout: 60_000 });
    await expect(primaryToggle).toBeChecked({ timeout: 60_000 });
    await primaryToggle.click();
    await expect(primaryToggle).not.toBeChecked({ timeout: 60_000 });

    await gotoDomContentLoadedWithPathFallback(page, `${uiBaseUrl}/server`, '/server', 120_000);
    await page.getByTestId('server-settings-add-server-toggle').click();
    await page.getByTestId('server-settings-add-url-input').fill(secondaryServer.baseUrl);
    await page.getByTestId('server-settings-add-name-input').fill('Settings Scope B');
    await page.getByTestId('server-settings-add-confirm').click();
    const continueSwitch = page.getByTestId('web-modal-confirm');
    await expect(continueSwitch).toHaveCount(1, { timeout: 60_000 });
    await continueSwitch.click();
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });
    await createAccountIfNeeded(page);

    await expectDiffSyntaxToggleChecked(page, uiBaseUrl, true);

    await gotoDomContentLoadedWithPathFallback(page, `${uiBaseUrl}/server`, '/server', 120_000);
    await expect(page.getByTestId(`saved-server-switch-${primaryServerId}`)).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId(`saved-server-switch-${primaryServerId}`).click();
    await expectDiffSyntaxToggleChecked(page, uiBaseUrl, false);
  });
});
