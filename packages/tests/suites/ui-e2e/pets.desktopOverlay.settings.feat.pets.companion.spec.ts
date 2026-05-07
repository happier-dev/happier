import { test, expect } from '@playwright/test';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { setSingleAccountPetsEnabled, setSingleAccountUiFeatureToggle } from '../../src/testkit/pets/uiPetsFeatureToggle';
import { repoRootDir } from '../../src/testkit/paths';

const execFileAsync = promisify(execFile);

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: pets desktop overlay settings', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('pets-desktop-overlay-settings-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let daemon: StartedDaemon | null = null;
  let uiBaseUrl: string | null = null;

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    await mkdir(cliHomeDir, { recursive: true });

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
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-pets-overlay-settings-${run.runId}`,
        HAPPIER_E2E_UI_WEB_MODE: 'export',
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('enables the desktop overlay setting in a Tauri shell and exposes a transparent overlay route on web', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing fixtures');

    const testDir = resolve(join(suiteDir, 'desktop-overlay-setting'));
    await mkdir(testDir, { recursive: true });

    daemon = await authenticateAndStartDaemon({
      page,
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      uiBaseUrl,
    });

    await setSingleAccountUiFeatureToggle({
      page,
      baseUrl: uiBaseUrl,
      featureId: 'pets.companion',
      enabled: true,
    });
    await setSingleAccountPetsEnabled({
      page,
      baseUrl: uiBaseUrl,
      enabled: true,
    });

    await page.addInitScript(() => {
      Object.defineProperty(window, '__TAURI_INTERNALS__', {
        configurable: true,
        value: { invoke: () => Promise.resolve(null) },
      });
    });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/pets?happier_hmr=0`, 180_000);
    await expect(page.getByTestId('settings-pets-desktop-overlay-enabled')).toHaveCount(1, { timeout: 120_000 });
    await page.getByTestId('settings-pets-desktop-overlay-enabled').click();
    await expect(page.getByTestId('settings-pets-desktop-overlay-device-override')).toHaveCount(1, {
      timeout: 60_000,
    });
    await expect(page.getByTestId('settings-pets-desktop-overlay-reset-position')).toHaveCount(1, {
      timeout: 60_000,
    });

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/desktop/pet-overlay?happier_hmr=0`, 180_000);
    await expect(page.getByTestId('desktop-pet-overlay-root')).toHaveCount(1, { timeout: 120_000 });
    const sprite = page.getByTestId('desktop-pet-overlay-sprite');
    await expect(sprite).toHaveCount(1, { timeout: 60_000 });

    const backgrounds = await page.evaluate(() => ({
      html: getComputedStyle(document.documentElement).backgroundColor,
      body: getComputedStyle(document.body).backgroundColor,
    }));
    expect([backgrounds.html, backgrounds.body]).toEqual(['rgba(0, 0, 0, 0)', 'rgba(0, 0, 0, 0)']);

    const spriteBounds = await sprite.boundingBox();
    if (!spriteBounds) throw new Error('missing desktop pet overlay sprite bounds');
    const petBounds = [
      Math.round(spriteBounds.x),
      Math.round(spriteBounds.y),
      Math.round(spriteBounds.width),
      Math.round(spriteBounds.height),
    ].join(',');
    const overlayScreenshot = join(testDir, 'desktop-pet-overlay-alpha.png');
    const backgroundScreenshot = join(testDir, 'desktop-pet-overlay-transparent-background.png');
    await page.screenshot({ path: overlayScreenshot, omitBackground: true });
    await page.setContent('<html><body style="margin:0;background:transparent;width:100vw;height:100vh;"></body></html>');
    await page.screenshot({ path: backgroundScreenshot, omitBackground: true });
    await execFileAsync(
      'yarn',
      [
        '-s',
        'tsx',
        'apps/ui/scripts/qa/petsDesktopOverlayQa.ts',
        '--background-screenshot',
        backgroundScreenshot,
        '--overlay-screenshot',
        overlayScreenshot,
        '--pet-bounds',
        petBounds,
        '--run-id',
        `ui-e2e-${run.runId}`,
      ],
      {
        cwd: repoRootDir(),
        env: process.env,
        timeout: 120_000,
      },
    );
  });
});
