import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { createRunDirs } from '../../src/testkit/runDir';
import {
  gotoDomContentLoadedWithPathFallback,
  normalizeLoopbackBaseUrl,
} from '../../src/testkit/uiE2e/pageNavigation';
import {
  installFakeTauriDesktopBridge,
  navigateSpa,
  releaseFakeTauriDesktopDownload,
} from '../../src/testkit/uiE2e/fakeTauriDesktop';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';

/**
 * R13 (e) visual QA of the Updates surface: the live desktop entry (fake Tauri updater through the
 * real store) and the developer preview of every row state, light and dark, desktop and phone
 * widths. Screenshots land in `HAPPIER_E2E_UPDATES_SCREENS_DIR` (default: the run dir).
 */
const run = createRunDirs({ runLabel: 'ui-e2e' });
const storageScope = `e2e-updates-screens-${run.runId}`;
const screensDir = resolve(process.env.HAPPIER_E2E_UPDATES_SCREENS_DIR ?? run.testDir('updates-screens'));

type Theme = 'light' | 'dark';

async function shot(page: Page, name: string): Promise<void> {
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(screensDir, `${name}.png`), fullPage: false });
}

async function createAccount(page: Page, uiBaseUrl: string): Promise<void> {
  await gotoDomContentLoadedWithPathFallback(page, `${uiBaseUrl}/`, '/', 180_000);
  await waitForInitialAppUi({ page, timeoutMs: 180_000 });
  const continueToAuth = page.getByTestId('setup.continueToAuth');
  if ((await continueToAuth.count()) > 0) {
    await expect(continueToAuth).toBeEnabled({ timeout: 120_000 });
    await continueToAuth.click();
  }
  await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });
}

test.describe('ui e2e: Updates surface screens (R13 e)', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('updates-screens-suite');
  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;

  test.beforeAll(async () => {
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: storageScope,
      // A metro bundle is a development bundle; the desktop updater is off there unless asked.
      EXPO_PUBLIC_HAPPIER_DESKTOP_UPDATES_ENABLED: '1',
      HAPPIER_E2E_UI_WEB_MODE: 'metro',
      HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS ?? '480000',
    };
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
    await mkdir(suiteDir, { recursive: true });
    await mkdir(screensDir, { recursive: true });
    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1' },
    });
    ui = await startUiWeb({
      testDir: suiteDir,
      env: { ...uiWebEnv, EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl },
    });
    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('live desktop entry: available → downloading % → ready, then a failed download', async ({ page }) => {
    test.setTimeout(180_000);
    if (!uiBaseUrl) throw new Error('missing ui base url');

    await page.setViewportSize({ width: 1440, height: 900 });
    await installFakeTauriDesktopBridge(page, {
      state: {
        platform: 'windows',
        strategy: 'custom-controls',
        updateAvailable: { version: '0.2.14', currentVersion: '0.2.13' },
        updateDownload: 'hold',
      },
    });
    await createAccount(page, uiBaseUrl);

    for (const theme of ['light', 'dark'] as const satisfies readonly Theme[]) {
      await page.emulateMedia({ colorScheme: theme });
      if (theme === 'dark') {
        await page.reload();
        await waitForInitialAppUi({ page, timeoutMs: 180_000 });
      }
      const entry = page.getByTestId('desktop-sidebar-updates-button');
      await expect(entry).toBeVisible({ timeout: 120_000 });
      await shot(page, `live-${theme}-desktop-sidebar-available`);

      await entry.click();
      await expect(page.getByTestId('updates.content.popover')).toBeVisible({ timeout: 60_000 });
      await shot(page, `live-${theme}-desktop-popover-available`);

      await page.getByTestId('updates.row.app.action').click();
      await expect(page.getByTestId('updates.content.popover')).toContainText('42%', { timeout: 60_000 });
      await shot(page, `live-${theme}-desktop-popover-downloading`);

      await releaseFakeTauriDesktopDownload(page, true);
      await expect(page.getByTestId('updates.row.app.action')).toBeVisible({ timeout: 60_000 });
      await shot(page, `live-${theme}-desktop-popover-ready`);

      await page.keyboard.press('Escape');
      await navigateSpa(page, '/settings/updates');
      await expect(page.getByTestId('updates.content.screen')).toBeVisible({ timeout: 60_000 });
      await shot(page, `live-${theme}-desktop-settings-ready`);

      // A fresh app open: the offer again, and this time the download fails.
      await page.reload();
      await waitForInitialAppUi({ page, timeoutMs: 180_000 });
      await navigateSpa(page, '/settings/updates');
      await expect(page.getByTestId('updates.row.app.action')).toBeVisible({ timeout: 120_000 });
      await page.getByTestId('updates.row.app.action').click();
      await expect(page.getByTestId('updates.content.screen')).toContainText('42%', { timeout: 60_000 });
      await shot(page, `live-${theme}-desktop-settings-downloading`);
      await releaseFakeTauriDesktopDownload(page, false);
      await expect(page.getByTestId('updates.content.screen')).toContainText('didn’t finish', { timeout: 60_000 });
      await shot(page, `live-${theme}-desktop-settings-failed`);
      await navigateSpa(page, '/');
    }
  });

  test('every row state, desktop and phone widths, light and dark (developer preview)', async ({ page }) => {
    test.setTimeout(180_000);
    if (!uiBaseUrl) throw new Error('missing ui base url');

    await createAccount(page, uiBaseUrl);
    for (const theme of ['light', 'dark'] as const satisfies readonly Theme[]) {
      await page.emulateMedia({ colorScheme: theme });
      await page.setViewportSize({ width: 1280, height: 1000 });
      await navigateSpa(page, '/');
      await page.reload();
      await waitForInitialAppUi({ page, timeoutMs: 180_000 });
      for (const width of [1280, 390] as const) {
        await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
        for (const state of ['available', 'downloading', 'ready', 'failed', 'checking'] as const) {
          const size = width === 390 ? 'phone' : 'desktop';
          for (const section of ['pills', 'popover', 'screen'] as const) {
            if (section === 'pills' && state !== 'available') continue;
            await navigateSpa(page, `/dev/updates-demo?state=${state}&only=${section}`);
            await expect(page.getByTestId(`updates-demo.${section}`)).toBeVisible({ timeout: 120_000 });
            if (section !== 'pills') {
              const cachedCli = page.getByTestId('updates.row.windows:happier-cli');
              await expect(cachedCli).toContainText('hdev self update');
              await expect(cachedCli).not.toContainText('Up to date');
              await expect(cachedCli.getByTestId('updates.row.windows:happier-cli.action')).toHaveCount(0);
            }
            if (section === 'screen' && state === 'checking') {
              await expect(page.getByTestId('updates.checkNow.spinner')).toBeVisible();
              await expect(page.getByTestId('updates.checkNow')).toBeDisabled();
            }
            if (section !== 'pills') await expect(page.getByTestId('updates.updateAll.spinner')).toBeVisible();
            await page.waitForTimeout(300);
            const name = section === 'pills' ? `demo-${theme}-${size}-pills` : `demo-${theme}-${size}-${section}-${state}`;
            await page.getByTestId(`updates-demo.${section}`).screenshot({ path: join(screensDir, `${name}.png`) });
          }
        }
      }
    }
  });
});
