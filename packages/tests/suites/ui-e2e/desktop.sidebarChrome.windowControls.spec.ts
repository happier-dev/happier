import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { createRunDirs } from '../../src/testkit/runDir';
import {
  gotoCommittedWithRetries,
  gotoDomContentLoadedWithPathFallback,
  normalizeLoopbackBaseUrl,
} from '../../src/testkit/uiE2e/pageNavigation';
import {
  installFakeTauriDesktopBridge,
  readFakeTauriDesktopState,
} from '../../src/testkit/uiE2e/fakeTauriDesktop';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e' });
const storageScope = `e2e-desktop-sidebar-chrome-${run.runId}`;

async function createAccountWithoutDaemon(params: Readonly<{
  page: Page;
  uiBaseUrl: string;
}>): Promise<void> {
  await gotoDomContentLoadedWithPathFallback(params.page, `${params.uiBaseUrl}/`, '/', 180_000);
  await waitForInitialAppUi({ page: params.page, timeoutMs: 180_000 });
  const continueToAuth = params.page.getByTestId('setup.continueToAuth');
  if ((await continueToAuth.count()) > 0) {
    await expect(continueToAuth).toBeEnabled({ timeout: 120_000 });
    await continueToAuth.click();
  }
  await expect(params.page.getByTestId('welcome-create-account')).toHaveCount(1, { timeout: 120_000 });
  await params.page.getByTestId('welcome-create-account').click();
  await expect.poll(async () => (
    await params.page.getByTestId('sidebar-view').count()
    + await params.page.getByTestId('sidebar-expand-button').count()
    + await params.page.getByTestId('session-getting-started-kind-connect_machine').count()
  ), { timeout: 120_000 }).toBeGreaterThan(0);
}

async function launchDesktopShell(page: Page, params: Readonly<{
  uiBaseUrl: string;
  updateVersion?: string;
}>): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installFakeTauriDesktopBridge(page, {
    state: {
      platform: 'windows',
      strategy: 'custom-controls',
      updateAvailable: params.updateVersion ? { version: params.updateVersion } : null,
    },
  });
  await createAccountWithoutDaemon({ page, uiBaseUrl: params.uiBaseUrl });
}

async function readUtilityRowTestIds(page: Page): Promise<string[]> {
  return await page.getByTestId('desktop-sidebar-chrome-utility-row').evaluate((node) => {
    return Array.from(node.children)
      .map((child) => child.getAttribute('data-testid'))
      .filter((testId): testId is string => typeof testId === 'string' && testId.length > 0);
  });
}

async function dragFromMainContentTitlebar(page: Page): Promise<void> {
    const sidebarBox = await page.getByTestId('desktop-sidebar-chrome').boundingBox();
    if (!sidebarBox) throw new Error('missing desktop sidebar chrome bounds');

    await page.mouse.move(sidebarBox.x + sidebarBox.width + 96, 40);
    await page.mouse.down();
    await page.mouse.up();
}

async function doubleClickMainContentTitlebar(page: Page): Promise<void> {
    const sidebarBox = await page.getByTestId('desktop-sidebar-chrome').boundingBox();
    if (!sidebarBox) throw new Error('missing desktop sidebar chrome bounds');

    await page.mouse.dblclick(sidebarBox.x + sidebarBox.width + 96, 40);
}

test.describe('ui e2e: desktop sidebar chrome window controls', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('desktop-sidebar-chrome-suite');

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;

  test.beforeAll(async () => {
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: storageScope,
      HAPPIER_E2E_UI_WEB_MODE: 'metro',
      HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS ?? '480000',
    };

    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
    await mkdir(suiteDir, { recursive: true });

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...uiWebEnv,
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('renders shell-owned desktop controls and update status in the wide sidebar', async ({ page }) => {
    test.setTimeout(420_000);
    if (!uiBaseUrl) throw new Error('missing ui base url');

    await launchDesktopShell(page, { uiBaseUrl, updateVersion: '9.9.9' });

    await expect(page.getByTestId('desktop-sidebar-chrome')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('sidebar-view').locator('[data-testid="desktop-sidebar-chrome"]')).toHaveCount(1);
    await expect(page.getByTestId('desktop-window-controls-host')).toHaveCount(1);
    await expect(page.getByTestId('desktop-window-controls-minimize')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('desktop-window-controls-toggle-maximize')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('desktop-window-controls-close')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('desktop-update-indicator-host')).toHaveCount(1);
    await expect(page.getByTestId('desktop-update-indicator-host').locator('[data-testid="sidebar-shell-app-update-status-tag"]')).toHaveCount(1);

    await expect.poll(async () => readUtilityRowTestIds(page), { timeout: 60_000 }).toEqual([
      'sidebar-back-button',
      'sidebar-forward-button',
      'sidebar-inbox-button',
      'nav-settings',
      'sidebar-collapse-button',
    ]);

    await dragFromMainContentTitlebar(page);
    await expect.poll(async () => readFakeTauriDesktopState(page), { timeout: 60_000 }).toMatchObject({
      controls: { dragCount: 1 },
    });

    await doubleClickMainContentTitlebar(page);
    await expect.poll(async () => readFakeTauriDesktopState(page), { timeout: 60_000 }).toMatchObject({
      controls: {
        toggleMaximizeCount: 1,
      },
      isMaximized: true,
    });

    await page.getByTestId('desktop-window-controls-minimize').click();
    await page.getByTestId('desktop-window-controls-toggle-maximize').click();
    await page.getByTestId('desktop-window-controls-close').click();

    await expect.poll(async () => readFakeTauriDesktopState(page), { timeout: 60_000 }).toMatchObject({
      controls: {
        closeCount: 1,
        minimizeCount: 1,
        toggleMaximizeCount: 2,
      },
      isMaximized: false,
    });
  });

  test('does not render Tauri desktop controls in plain web mode', async ({ page }) => {
    test.setTimeout(300_000);
    if (!uiBaseUrl) throw new Error('missing ui base url');

    await page.setViewportSize({ width: 1440, height: 900 });
    await createAccountWithoutDaemon({ page, uiBaseUrl });

    await expect(page.getByTestId('desktop-window-controls-host')).toHaveCount(0);
    await expect(page.getByTestId('desktop-window-controls-minimize')).toHaveCount(0);
    await expect(page.getByTestId('desktop-sidebar-chrome-controls-row')).toHaveCount(0);
    await expect(page.getByTestId('desktop-sidebar-chrome-utility-row')).toHaveCount(0);
  });

  test('excludes global desktop chrome from the desktop pet overlay route', async ({ page }) => {
    test.setTimeout(300_000);
    if (!uiBaseUrl) throw new Error('missing ui base url');

    await page.setViewportSize({ width: 800, height: 600 });
    await installFakeTauriDesktopBridge(page, {
      state: {
        currentWindowLabel: 'pet_overlay',
        platform: 'windows',
        strategy: 'custom-controls',
        updateAvailable: { version: '9.9.9' },
      },
    });
    await gotoCommittedWithRetries(page, `${uiBaseUrl}/desktop/pet-overlay?happier_hmr=0&desktopPetOverlayWindow=1`, 180_000);

    await expect(page.getByTestId('desktop-pet-overlay-root')).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId('desktop-window-controls-host')).toHaveCount(0);
    await expect(page.getByTestId('desktop-sidebar-chrome')).toHaveCount(0);
    await expect(page.getByTestId('root-shell-app-update-status-tag')).toHaveCount(0);
    await expect(page.getByTestId('app-update-status-tag')).toHaveCount(0);
  });
});
