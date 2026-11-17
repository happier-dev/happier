import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';

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

function customThemeTiles(page: Page) {
  return page.getByTestId(/^settings-theme-(light|dark):\["artifact",/);
}

async function firstCustomProfileId(page: Page): Promise<string> {
  const tile = customThemeTiles(page).first();
  await expect(tile).toBeVisible({ timeout: 60_000 });
  const testId = await tile.getAttribute('data-testid');
  if (!testId) throw new Error('expected an Artifact theme tile');
  return testId.replace(/^settings-theme-(light|dark):/, '');
}

async function editTheme(page: Page, profileId: string): Promise<void> {
  const tile = await expectVisibleTestId(page, `settings-theme-light:${profileId}`);
  await tile.hover();
  await (await expectVisibleTestId(page, `settings-theme-tile-menu-${profileId}.trigger`)).click();
  await (await expectVisibleTestId(page, 'dropdown-option-edit')).click();
  await expectVisibleTestId(page, 'settings-theme-profile-editor');
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

  test('creates, activates, exports, and imports a custom theme profile through Appearance settings', async ({ page, context, browser }) => {
    test.setTimeout(540_000);
    if (!uiBaseUrl) throw new Error('missing ui fixture');

    await page.setViewportSize({ width: 390, height: 844 });

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 420_000);
    await waitForInitialAppUi({ page, timeoutMs: 420_000 });
    await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });

    await openThemeProfiles({ page, uiBaseUrl });

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/appearance/themes/premiumDark?happier_hmr=0`, 180_000);
    await expectVisibleTestId(page, 'settings-theme-profile-editor');
    await expect(visibleTestId(page, 'settings-theme-profile-save')).toHaveCount(0, { timeout: 60_000 });
    await expect(visibleTestId(page, 'settings-theme-profile-delete')).toHaveCount(0, { timeout: 60_000 });
    await (await expectVisibleTestId(page, 'settings-theme-profile-menu.trigger')).click();
    await expectVisibleTestId(page, 'dropdown-option-duplicate');

    await openThemeProfiles({ page, uiBaseUrl });
    await (await expectVisibleTestId(page, 'settings-theme-appearance-mode:light')).click();
    await (await expectVisibleTestId(page, 'settings-theme-profile-add')).click();
    await expectVisibleTestId(page, 'settings-theme-profile-import');
    await expectVisibleTestId(page, 'settings-theme-profile-store');
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

    await page.goBack();
    await expectVisibleTestId(page, 'settings-theme-profiles-screen');
    const profileId = await firstCustomProfileId(page);
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/session?happier_hmr=0`, 180_000);
    await expectVisibleTestId(page, 'settings-session-sessionListDensity-trigger');
    await openThemeProfiles({ page, uiBaseUrl });
    await expectVisibleTestId(page, `settings-theme-light:${profileId}`);

    // Tile press only previews; Keep commits the selection through the shared try bar.
    await (await expectVisibleTestId(page, `settings-theme-light:${profileId}`)).click();
    await (await expectVisibleTestId(page, 'theme.tryBar:install')).click();
    await expect(visibleTestId(page, 'theme.tryBar')).toHaveCount(0, { timeout: 60_000 });
    await editTheme(page, profileId);
    await (await expectVisibleTestId(page, 'settings-theme-profile-menu.trigger')).click();
    await (await expectVisibleTestId(page, 'dropdown-option-export')).click();
    await expectVisibleTestId(page, 'settings-theme-profile-export-screen');
    const exportedJson = await readInputValue(await expectVisibleTestId(page, 'settings-theme-profile-export-json'));
    expect(JSON.parse(exportedJson)).toMatchObject({
      kind: 'happier.themeProfile',
      schemaVersion: 1,
      profile: {
        id: JSON.parse(profileId)[1],
        overrides: {
          light: {
            'background.canvas': '#123456',
          },
        },
      },
    });

    await openThemeProfiles({ page, uiBaseUrl });
    await (await expectVisibleTestId(page, 'settings-theme-profile-add')).click();
    await (await expectVisibleTestId(page, 'settings-theme-profile-import')).click();
    await expectVisibleTestId(page, 'settings-theme-profile-import-screen');
    await (await expectVisibleTestId(page, 'settings-theme-profile-import-json')).fill(exportedJson);
    await (await expectVisibleTestId(page, 'settings-theme-profile-import-submit')).click();

    await expectVisibleTestId(page, 'settings-theme-profiles-screen');
    await expect(customThemeTiles(page)).toHaveCount(2, { timeout: 60_000 });

    // A second browser gets only this fixture account's credentials/server config.
    // Exclude every settings cache and local preference so the library must arrive over sync.
    const originalState = await context.storageState();
    const secondContext = await browser.newContext({ storageState: {
      cookies: originalState.cookies,
      origins: originalState.origins.map((origin) => ({
        ...origin,
        localStorage: origin.localStorage.filter(({ name }) => {
          const key = name.split('\\').at(-1) ?? name;
          return key !== 'local-settings' && key !== 'settings' && key !== 'pending-settings'
            && !key.startsWith('account-settings:') && !key.startsWith('pending-account-settings:');
        }),
      })),
    }, viewport: { width: 390, height: 844 } });
    const secondPage = await secondContext.newPage();
    const firstDiagnostics = collectBrowserDiagnostics({ page });
    const secondDiagnostics = collectBrowserDiagnostics({ page: secondPage });
    try {
      await gotoDomContentLoadedWithRetries(secondPage, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
      await waitForInitialAppUi({ page: secondPage, timeoutMs: 180_000 });
      await openThemeProfiles({ page: secondPage, uiBaseUrl });
      await expectVisibleTestId(secondPage, `settings-theme-light:${profileId}`);
      await expect(customThemeTiles(secondPage)).toHaveCount(2, { timeout: 60_000 });
      await editTheme(secondPage, profileId);
      await expectVisibleTestId(secondPage, 'settings-theme-profile-editor');
      await (await expectVisibleTestId(secondPage, 'settings-theme-profile-menu.trigger')).click();
      await expect(visibleTestId(secondPage, 'dropdown-option-deactivate')).toHaveCount(0);
      await secondPage.keyboard.press('Escape');

      await openThemeProfiles({ page, uiBaseUrl });
      const firstScreen = await expectVisibleTestId(page, 'settings-theme-profiles-screen');
      const firstBackground = await readBackgroundColor(firstScreen);
      await (await expectVisibleTestId(secondPage, 'settings-theme-profile-name')).fill('Shared ocean');
      await fillThemeColor({ page: secondPage, mode: 'light', tokenId: 'background.canvas', value: '#654321' });
      await (await expectVisibleTestId(secondPage, 'settings-theme-profile-save')).click();
      // The receiving page is not an editor: remote colors must reach the global runtime.
      await expect.poll(() => readBackgroundColor(firstScreen), { timeout: 60_000 }).not.toBe(firstBackground);
      await editTheme(page, profileId);
      await expect(visibleTestId(page, 'settings-theme-profile-name').first()).toHaveValue('Shared ocean', { timeout: 60_000 });
      await expect(visibleTestId(page, 'settings-theme-color-input-light-background.canvas').first()).toHaveValue('#654321');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(visibleTestId(page, 'settings-theme-profile-name').first()).toHaveValue('Shared ocean', { timeout: 60_000 });
      await (await expectVisibleTestId(page, 'settings-theme-profile-menu.trigger')).click();
      await expectVisibleTestId(page, 'dropdown-option-export');
    } catch (error) {
      throw appendBrowserDiagnostics(error, `${firstDiagnostics()}\n\nSecond browser:\n${secondDiagnostics()}`);
    } finally {
      await secondContext.close();
    }

  });
});
