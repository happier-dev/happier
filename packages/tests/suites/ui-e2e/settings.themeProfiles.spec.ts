import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';

const run = createRunDirs({ runLabel: 'ui-e2e' });

function visibleTestId(page: Page, testId: string): ReturnType<Page['locator']> {
  const escaped = testId.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
  return page.locator(`[data-testid="${escaped}"]:visible`);
}

async function expectVisibleTestId(page: Page, testId: string): Promise<ReturnType<Page['locator']>> {
  const locator = visibleTestId(page, testId).first();
  await expect(locator).toBeVisible({ timeout: 60_000 });
  return locator;
}

async function createAccountIfNeeded(page: Page): Promise<void> {
  const createAccountByTestId = page.getByTestId('welcome-create-account');
  if (await createAccountByTestId.count()) {
    await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });
    return;
  }

  const createAccountByRole = page.getByRole('button', { name: 'Create account' });
  if (await createAccountByRole.count()) {
    await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });
  }
}

async function openThemeProfiles(params: Readonly<{ page: Page; uiBaseUrl: string }>): Promise<void> {
  await gotoDomContentLoadedWithRetries(params.page, `${params.uiBaseUrl}/settings/appearance?happier_hmr=0`, 180_000);
  await (await expectVisibleTestId(params.page, 'settings-appearance-themeProfiles')).click();
  await expectVisibleTestId(params.page, 'settings-theme-profiles-screen');
}

async function fillThemeColor(params: Readonly<{
  page: Page;
  mode: 'light' | 'dark';
  tokenId: string;
  value: string;
}>): Promise<void> {
  const input = await expectVisibleTestId(params.page, `settings-theme-color-input-${params.mode}-${params.tokenId}`);
  await input.fill(params.value);
}

async function readInputValue(locator: ReturnType<Page['getByTestId']>): Promise<string> {
  return await locator.evaluate((element) => {
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      return element.value;
    }
    return element.textContent ?? '';
  });
}

async function readBackgroundColor(locator: ReturnType<Page['getByTestId']>): Promise<string> {
  return await locator.evaluate((element) => getComputedStyle(element).backgroundColor);
}

function activeProfileIdFromUrl(page: Page): string {
  const profileId = new URL(page.url()).pathname.split('/').filter(Boolean).at(-1);
  if (!profileId) throw new Error(`expected profile id in current URL, got ${page.url()}`);
  return decodeURIComponent(profileId);
}

async function firstCustomProfileId(page: Page): Promise<string> {
  const row = page.locator('[data-testid^="settings-theme-profile-custom-theme_"]:visible').first();
  await expect(row).toBeVisible({ timeout: 60_000 });
  const testId = await row.getAttribute('data-testid');
  const prefix = 'settings-theme-profile-custom-';
  if (!testId?.startsWith(prefix)) throw new Error(`expected custom theme row test id, got ${testId ?? 'null'}`);
  return testId.slice(prefix.length);
}

test.describe('ui e2e: custom theme profiles', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('settings-theme-profiles-suite');

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    await mkdir(suiteDir, { recursive: true });

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-theme-profiles-${run.runId}`,
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('creates, activates, exports, and imports a custom theme profile through Appearance settings', async ({ page }) => {
    test.setTimeout(540_000);
    if (!uiBaseUrl) throw new Error('missing ui fixture');

    await page.setViewportSize({ width: 390, height: 844 });

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 420_000);
    await waitForInitialAppUi({ page, timeoutMs: 420_000 });
    await createAccountIfNeeded(page);

    await openThemeProfiles({ page, uiBaseUrl });

    await expectVisibleTestId(page, 'settings-theme-profile-built-in-premiumDark');
    await expectVisibleTestId(page, 'settings-theme-profile-built-in-premiumLight');
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/appearance/themes/premiumDark?happier_hmr=0`, 180_000);
    await expectVisibleTestId(page, 'settings-theme-profile-editor');
    await expect(visibleTestId(page, 'settings-theme-profile-save')).toHaveCount(0, { timeout: 60_000 });
    await expect(visibleTestId(page, 'settings-theme-profile-delete')).toHaveCount(0, { timeout: 60_000 });
    await expectVisibleTestId(page, 'settings-theme-profile-clone-premiumDark');

    await openThemeProfiles({ page, uiBaseUrl });
    await (await expectVisibleTestId(page, 'settings-theme-profile-create')).click();
    await expectVisibleTestId(page, 'settings-theme-profile-editor');

    expect(activeProfileIdFromUrl(page)).toBe('new');
    const canvasSwatch = visibleTestId(page, 'settings-theme-color-swatch-light-background.canvas').first();
    const initialCanvasColor = await readBackgroundColor(canvasSwatch);

    await fillThemeColor({ page, mode: 'light', tokenId: 'background.canvas', value: '#123456' });
    await expect.poll(async () => readBackgroundColor(canvasSwatch), { timeout: 30_000 }).not.toBe(initialCanvasColor);
    await expectVisibleTestId(page, 'settings-theme-color-reset-light-background.canvas');

    await fillThemeColor({ page, mode: 'light', tokenId: 'text.primary', value: '#123456' });
    await expectVisibleTestId(page, 'settings-theme-contrast-warning-light-text.primary');
    await expect(visibleTestId(page, 'settings-theme-profile-deactivate')).toHaveCount(0, { timeout: 60_000 });
    const saveButton = await expectVisibleTestId(page, 'settings-theme-profile-save');
    await expect(saveButton).toBeEnabled({ timeout: 60_000 });
    await saveButton.click();

    await openThemeProfiles({ page, uiBaseUrl });
    const profileId = await firstCustomProfileId(page);
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/session?happier_hmr=0`, 180_000);
    await expectVisibleTestId(page, 'settings-session-sessionListDensity-trigger');
    await openThemeProfiles({ page, uiBaseUrl });
    await expectVisibleTestId(page, `settings-theme-profile-custom-${profileId}`);

    await (await expectVisibleTestId(page, 'settings-theme-profile-export')).click();
    await expectVisibleTestId(page, 'settings-theme-profile-export-screen');
    const exportedJson = await readInputValue(await expectVisibleTestId(page, 'settings-theme-profile-export-json'));
    expect(JSON.parse(exportedJson)).toMatchObject({
      kind: 'happier.themeProfile',
      schemaVersion: 1,
      profile: {
        id: profileId,
        overrides: {
          light: {
            'background.canvas': '#123456',
          },
        },
      },
    });

    await openThemeProfiles({ page, uiBaseUrl });
    await (await expectVisibleTestId(page, 'settings-theme-profile-import')).click();
    await expectVisibleTestId(page, 'settings-theme-profile-import-screen');
    await (await expectVisibleTestId(page, 'settings-theme-profile-import-json')).fill(exportedJson);
    await (await expectVisibleTestId(page, 'settings-theme-profile-import-submit')).click();

    await expectVisibleTestId(page, 'settings-theme-profiles-screen');
    await expect(page.locator('[data-testid^="settings-theme-profile-custom-theme_"]:visible')).toHaveCount(2, { timeout: 60_000 });
  });
});
