import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { createMinimalCodexPetPackage } from '../../src/testkit/pets/petPackageFixture';
import { setSingleAccountUiFeatureToggle } from '../../src/testkit/pets/uiPetsFeatureToggle';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: pets settings', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('pets-settings-suite');
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
        HAPPIER_FEATURE_PETS_SYNC__ENABLED: '0',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-pets-settings-${run.runId}`,
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

  test('supports daemon-local pet import and hides account sync controls when pets sync is disabled', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing fixtures');

    const testDir = resolve(join(suiteDir, 'settings-local-import'));
    const codexHomeDir = resolve(join(testDir, 'codex-home'));
    await mkdir(testDir, { recursive: true });
    await createMinimalCodexPetPackage({
      rootDir: resolve(join(codexHomeDir, 'pets')),
      petId: 'blink-e2e-fixture',
      displayName: 'Blink E2E Fixture',
    });

    daemon = await authenticateAndStartDaemon({
      page,
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      uiBaseUrl,
      extraEnv: {
        CODEX_HOME: codexHomeDir,
        HAPPIER_FEATURE_PETS_SYNC__ENABLED: '0',
      },
    });

    await setSingleAccountUiFeatureToggle({
      page,
      baseUrl: uiBaseUrl,
      featureId: 'pets.companion',
      enabled: true,
    });

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings?happier_hmr=0`, 180_000);
    await expect(page.getByTestId('settings-pets-row')).toHaveCount(1, { timeout: 120_000 });
    await page.getByTestId('settings-pets-row').click();

    await expect(page.getByTestId('settings-pets-enabled')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('settings-pets-source-list')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('settings-pets-local-library-list')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('settings-pets-built-in-card-grid')).toHaveCount(1, { timeout: 60_000 });
    for (const petId of ['blink', 'fury', 'milo', 'oli', 'titi']) {
      await expect(page.getByTestId(`settings-pets-built-in-source-${petId}`)).toHaveCount(1, {
        timeout: 60_000,
      });
      await expect(page.getByTestId(`settings-pets-built-in-card-${petId}`)).toHaveCount(1, {
        timeout: 60_000,
      });
      await expect(page.getByTestId(`settings-pets-built-in-preview-${petId}`)).toHaveCount(1, {
        timeout: 60_000,
      });
    }
    await expect(page.getByTestId('settings-pets-built-in-source-holly')).toHaveCount(0);
    await expect(page.getByTestId('settings-pets-account-library-list')).toHaveCount(0);
    await expect(page.locator('[data-testid^="settings-pets-import-to-account"]')).toHaveCount(0);

    await page.getByTestId('settings-pets-detect-codex-pets').click();
    await expect(page.getByTestId('settings-pets-detected-codex-pets-grid')).toHaveCount(1, { timeout: 120_000 });
    const detectedPetTile = page.getByTestId('settings-pets-detected-tile-blink-e2e-fixture');
    await expect(detectedPetTile).toHaveCount(1, { timeout: 120_000 });
    await expect(detectedPetTile.getByTestId('settings-pets-detected-source-blink-e2e-fixture')).toHaveCount(1);
    await expect(detectedPetTile.getByTestId('settings-pets-detected-preview-blink-e2e-fixture')).toHaveCount(1);
    await expect(detectedPetTile.getByTestId('settings-pets-import-to-account-blink-e2e-fixture')).toHaveCount(0);
    const useOnThisDeviceAction = detectedPetTile.getByTestId(
      'settings-pets-use-on-this-device-blink-e2e-fixture',
    );
    await expect(useOnThisDeviceAction).toHaveCount(1, { timeout: 120_000 });
    await useOnThisDeviceAction.click();

    const localLibrary = page.getByTestId('settings-pets-local-library-list');
    await expect(localLibrary.locator('[data-testid^="settings-pets-select-source"]')).toHaveCount(1, {
      timeout: 120_000,
    });
    const localPetTile = localLibrary.getByTestId('settings-pets-local-tile-blink-e2e-fixture');
    await expect(localPetTile).toHaveCount(1, { timeout: 120_000 });
    await expect(localPetTile.getByTestId('settings-pets-select-source-local-blink-e2e-fixture')).toHaveCount(1);
    const removeFromDeviceAction = localPetTile.getByTestId('settings-pets-remove-from-device-blink-e2e-fixture');
    await expect(removeFromDeviceAction).toHaveCount(1, { timeout: 60_000 });
    await removeFromDeviceAction.click();
    await expect(localPetTile).toHaveCount(0, { timeout: 120_000 });
  });
});
