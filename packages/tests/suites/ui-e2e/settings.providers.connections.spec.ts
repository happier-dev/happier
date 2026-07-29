import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { readCliAccessKey } from '../../src/testkit/cliAccessKey';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import {
  buildLmStudioProviderUiE2eSettings,
  hasProviderUiE2eConnectionGrant,
  replaceProviderUiE2eSettings,
} from '../../src/testkit/providers/uiE2eProviderSettings';
import { createRunDirs } from '../../src/testkit/runDir';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { waitForDaemonMachineIdFromCliSettings } from '../../src/testkit/uiE2e/daemonMachineId';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });

async function openProvidersThroughSettingsSearch(page: Page, uiBaseUrl: string): Promise<void> {
  await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings?happier_hmr=0`, 180_000);
  await navigateToProvidersThroughSettingsSearch(page);
}

async function navigateToProvidersThroughSettingsSearch(page: Page): Promise<void> {
  await expect(page.getByTestId('settings-sidebar')).toHaveCount(1, { timeout: 120_000 });
  await page.getByTestId('settings-sidebar.searchInput').fill('providers');
  await expect(page.getByTestId('settings-sidebar.searchResult.providers')).toHaveCount(1, { timeout: 60_000 });
  await page.getByTestId('settings-sidebar.searchResult.providers').click();
  await expect(page).toHaveURL(/\/settings\/providers/);
  await expect(page.getByTestId('settings-providers-screen')).toHaveCount(1, { timeout: 120_000 });
}

async function openProvidersAfterRetainedSettingsCycles(page: Page, uiBaseUrl: string): Promise<void> {
  await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
  await expect(page.getByTestId('nav-settings')).toHaveCount(1, { timeout: 120_000 });

  for (let cycle = 0; cycle < 2; cycle += 1) {
    await page.getByTestId('nav-settings').click();
    await navigateToProvidersThroughSettingsSearch(page);
    await page.goBack();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 60_000 }).toBe('/settings');
    await page.goBack();
    await expect.poll(() => new URL(page.url()).pathname, { timeout: 60_000 }).toBe('/');
    await expect(page.getByTestId('nav-settings')).toHaveCount(1, { timeout: 60_000 });
  }

  await page.getByTestId('nav-settings').click();
  await navigateToProvidersThroughSettingsSearch(page);
}

test.describe('ui e2e: Provider connections settings', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('settings-provider-connections-suite');
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
        ...process.env,
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        HAPPIER_FEATURE_PROVIDERS__ENABLED: '1',
        HAPPIER_FEATURE_PROVIDERS_LOCAL_DISCOVERY__ENABLED: '1',
        HAPPIER_FEATURE_PROVIDERS_LOCAL_MODEL_MANAGEMENT__ENABLED: '1',
      },
    });
    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-providers-settings-${run.runId}`,
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

  test('covers Provider settings identity, catalog recovery, and custom-authoring browser history', async ({ page }) => {
    test.setTimeout(600_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');
    const providerUiBaseUrl = uiBaseUrl;
    await page.setViewportSize({ width: 1440, height: 1100 });

    daemon = await authenticateAndStartDaemon({
      page,
      testDir: suiteDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      uiBaseUrl,
      daemonStartupTimeoutMs: 180_000,
    });
    const machineId = await waitForDaemonMachineIdFromCliSettings({ cliHomeDir, timeoutMs: 120_000 });
    const accessKey = await readCliAccessKey(cliHomeDir);
    if (!accessKey) throw new Error('expected CLI access key after terminal connect');
    await replaceProviderUiE2eSettings({
      baseUrl: server.baseUrl,
      accessKey,
      providerSettings: buildLmStudioProviderUiE2eSettings({ machineId }),
    });

    await openProvidersThroughSettingsSearch(page, providerUiBaseUrl);

    const personal = page.getByTestId('settings-provider-connection:pc_e2e_lmstudio_1');
    const work = page.getByTestId('settings-provider-connection:pc_e2e_lmstudio_2');
    await expect(personal).toContainText('LM Studio Personal');
    await expect(work).toContainText('LM Studio Work');

    await expect(page.getByTestId('settings-providers-search:input')).toHaveCount(1);
    await page.getByTestId('settings-providers-search:input').fill('missing-provider-name');
    await expect(personal).toHaveCount(0);
    await page.getByTestId('settings-providers-search:input').fill('LM Studio Personal');
    await expect(personal).toHaveCount(1);
    await expect(work).toHaveCount(0);
    await page.getByTestId('settings-providers-search:input').fill('');

    const enabledSwitch = page.getByTestId('settings-provider-connection-enabled:pc_e2e_lmstudio_1');
    await enabledSwitch.click();
    await expect(enabledSwitch).toBeChecked({ timeout: 120_000 });
    await expect.poll(() => hasProviderUiE2eConnectionGrant({
      baseUrl: server!.baseUrl,
      accessKey,
      connectionId: 'pc_e2e_lmstudio_1',
      machineId,
    }), { timeout: 120_000 }).toBe(true);
    await personal.focus();
    await expect(personal).toBeFocused();
    await personal.click();
    await expect(page).toHaveURL(/\/settings\/providers\/pc_e2e_lmstudio_1/);
    await page.goBack();
    await expect(page).toHaveURL(/\/settings\/providers(?:\?|$)/, { timeout: 60_000 });
    await expect(personal).toBeFocused();

    await personal.click();
    await expect(page).toHaveURL(/\/settings\/providers\/pc_e2e_lmstudio_1/);
    await page.getByTestId('provider-connection-manage-models').click();
    await expect(page.getByTestId('provider-connection-models')).toHaveCount(1, { timeout: 120_000 });
    const manualModel = page.getByTestId('provider-connection-models')
      .getByRole('option', { name: /^Provider E2E Model,/ });
    await expect(manualModel).toHaveCount(1);

    await page.getByTestId('provider-model-catalog-refresh').click();
    await expect(page.getByTestId('provider-error:provider_endpoint_unreachable')).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId('provider-error-action:provider_endpoint_unreachable')).toHaveCount(1);
    await expect(manualModel).toHaveCount(1);

    await test.step('keeps a dirty custom Provider draft on repeated browser Back and discards explicitly', async () => {
      await openProvidersAfterRetainedSettingsCycles(page, providerUiBaseUrl);
      const addCustomRow = page.getByTestId('settings-provider-add-custom');
      await addCustomRow.focus();
      await expect(addCustomRow).toBeFocused();
      await addCustomRow.click();
      await expect(page.getByTestId('settings-provider-authoring')).toHaveCount(1, { timeout: 120_000 });

      const authoringUrl = page.url();
      expect(new URL(authoringUrl).pathname).toBe('/settings/providers/new');
      const nameInput = page.getByTestId('settings-provider-authoring-name');
      await nameInput.fill('Provider history guard draft');
      await nameInput.blur();
      await expect(nameInput).toHaveValue('Provider history guard draft');

      const modalButtons = page.locator('[data-testid^="web-modal-button-"]');
      const discardButton = page.getByTestId('web-modal-button-0');
      const keepEditingButton = page.getByTestId('web-modal-button-2');
      const beforeUnloadDialog = page.waitForEvent('dialog', { timeout: 60_000 });
      const reloadAttempt = page.evaluate(() => window.location.reload());
      const dialog = await beforeUnloadDialog;
      expect(dialog.type()).toBe('beforeunload');
      await dialog.dismiss();
      await reloadAttempt;
      await expect(page).toHaveURL(authoringUrl, { timeout: 60_000 });
      await expect(nameInput).toHaveValue('Provider history guard draft');

      await page.evaluate(() => window.history.back());
      await expect(keepEditingButton).toHaveCount(1, { timeout: 60_000 });
      await expect(nameInput).toHaveValue('Provider history guard draft');
      await expect.poll(() => modalButtons.first().evaluate((button) => (
        button.closest('[role="dialog"]')?.contains(document.activeElement) ?? false
      ))).toBe(true);

      const firstModalButton = modalButtons.first();
      const lastModalButton = modalButtons.last();
      await lastModalButton.focus();
      await page.keyboard.press('Tab');
      await expect(firstModalButton).toBeFocused();
      await firstModalButton.focus();
      await page.keyboard.press('Shift+Tab');
      await expect(lastModalButton).toBeFocused();
      await keepEditingButton.click();

      await expect(modalButtons).toHaveCount(0, { timeout: 60_000 });
      await expect(page).toHaveURL(authoringUrl, { timeout: 60_000 });
      await expect(nameInput).toHaveValue('Provider history guard draft');

      await page.goBack();
      await expect(keepEditingButton).toHaveCount(1, { timeout: 60_000 });
      await expect(nameInput).toHaveValue('Provider history guard draft');
      await discardButton.click();

      await expect(modalButtons).toHaveCount(0, { timeout: 60_000 });
      await expect(page).toHaveURL(/\/settings\/providers(?:\?|$)/, { timeout: 60_000 });
      await expect(page.getByTestId('settings-providers-screen')).toHaveCount(1, { timeout: 60_000 });
      await expect(page.getByTestId('settings-provider-authoring-name')).toHaveCount(0);
      await expect(addCustomRow).toBeFocused();
    });

    await test.step('clears the unsaved guard after a successful custom Provider save', async () => {
      await page.getByTestId('settings-provider-add-custom').click();
      await expect(page.getByTestId('settings-provider-authoring')).toHaveCount(1, { timeout: 120_000 });
      await page.getByTestId('settings-provider-authoring-name').fill('Provider saved guard draft');
      await page.getByTestId('settings-provider-authoring-base-url').fill('https://provider-save.invalid/v1');

      const requiresApiKey = page.getByTestId('settings-provider-authoring-requires-api-key');
      await expect(requiresApiKey).toBeChecked();
      await requiresApiKey.click();
      await expect(requiresApiKey).not.toBeChecked();

      const enableAfterSave = page.getByTestId('settings-provider-authoring-enable-after-save');
      await expect(enableAfterSave).toBeChecked();
      await enableAfterSave.click();
      await expect(enableAfterSave).not.toBeChecked();

      await page.getByTestId('settings-provider-authoring-save').click();
      await expect.poll(() => new URL(page.url()).pathname, { timeout: 120_000 })
        .toMatch(/^\/settings\/providers\/pc_/u);
      await expect(page.getByTestId('provider-connection-manage-models')).toHaveCount(1, { timeout: 120_000 });
      await expect(page.locator('[data-testid^="web-modal-button-"]')).toHaveCount(0);

      await page.goBack();
      await expect(page).toHaveURL(/\/settings\/providers(?:\?|$)/, { timeout: 60_000 });
      await expect(page.getByTestId('settings-providers-screen')).toHaveCount(1, { timeout: 60_000 });
      await expect(page.locator('[data-testid^="web-modal-button-"]')).toHaveCount(0);
    });
  });
});
