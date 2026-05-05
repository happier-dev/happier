import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createTestAuth } from '../../src/testkit/auth';
import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import {
    gotoCommittedWithRetries,
    normalizeLoopbackBaseUrl,
    waitForAuthenticatedHomeUi,
} from '../../src/testkit/uiE2e/pageNavigation';
import { buildAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/buildAuthBootstrapStorageSnapshot';
import {
    installFakeTauriDesktopBridge,
    readFakeTauriDesktopState,
} from '../../src/testkit/uiE2e/fakeTauriDesktop';
import { installAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e' });

async function launchDesktopShell(page: Page, params: Readonly<{
    baseUrl: string;
    serverUrl: string;
    storageScope: string;
}>): Promise<void> {
    await page.setViewportSize({ width: 1440, height: 900 });
    const auth = await createTestAuth(params.serverUrl);
    await installAuthBootstrapStorageSnapshot(page, buildAuthBootstrapStorageSnapshot({
        serverUrl: params.serverUrl,
        credentials: { token: auth.token, secret: auth.token },
        storageScope: params.storageScope,
    }));
    await installFakeTauriDesktopBridge(page, {
        state: {
            platform: 'windows',
            strategy: 'custom-controls',
        },
    });

    await gotoCommittedWithRetries(page, `${params.baseUrl}/?happier_hmr=0`, 180_000);
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });
    await waitForAuthenticatedHomeUi({ page, timeoutMs: 180_000 });
}

async function collapseDesktopSidebar(page: Page): Promise<void> {
    const resizeHandle = page.getByRole('slider').first();
    await expect(resizeHandle).toBeVisible({ timeout: 60_000 });
    const box = await resizeHandle.boundingBox();
    if (!box) {
        throw new Error('missing sidebar resize handle bounds');
    }

    const centerY = box.y + box.height / 2;
    const startX = box.x + box.width / 2;
    await page.mouse.move(startX, centerY);
    await page.mouse.down();
    await page.mouse.move(startX - 320, centerY, { steps: 12 });
    await page.mouse.up();
}

async function dragFromMainContentTitlebar(page: Page): Promise<void> {
    const sidebarBox = await page.getByTestId('desktop-sidebar-chrome').boundingBox();
    if (!sidebarBox) {
        throw new Error('missing desktop sidebar chrome bounds');
    }

    await page.mouse.move(sidebarBox.x + sidebarBox.width + 96, 40);
    await page.mouse.down();
    await page.mouse.up();
}

test.describe('ui e2e: desktop sidebar chrome', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('desktop-sidebar-chrome-suite');

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;

    test.beforeAll(async () => {
        const uiWebEnv = {
            ...process.env,
            EXPO_PUBLIC_DEBUG: '1',
            EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-desktop-sidebar-chrome-${run.runId}`,
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

    test('renders shell-owned desktop chrome without duplicating the route header strip', async ({ page }) => {
        test.setTimeout(420_000);
        if (!server || !uiBaseUrl) {
            throw new Error('missing ui base url');
        }

        await launchDesktopShell(page, {
            baseUrl: uiBaseUrl,
            serverUrl: server.baseUrl,
            storageScope: `e2e-desktop-sidebar-chrome-${run.runId}`,
        });

        await expect(page.getByTestId('desktop-sidebar-chrome')).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByTestId('sidebar-view').locator('[data-testid="desktop-sidebar-chrome"]')).toHaveCount(1);
        await expect(page.locator('[data-testid="desktop-window-controls-host"]')).toHaveCount(1);
        await expect(page.getByTestId('sidebar-view').locator('[data-testid="desktop-window-controls-host"]')).toHaveCount(1);
        await expect(page.getByTestId('desktop-sidebar-chrome-actions-row')).toHaveCount(1);
        await expect(page.getByTestId('nav-new-session')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('desktop-window-controls-minimize')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('desktop-window-controls-toggle-maximize')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('desktop-window-controls-close')).toBeVisible({ timeout: 60_000 });

        await dragFromMainContentTitlebar(page);
        await expect
            .poll(async () => readFakeTauriDesktopState(page), { timeout: 60_000 })
            .toMatchObject({
                controls: {
                    dragCount: 1,
                },
            });

        await page.getByTestId('desktop-window-controls-minimize').click();
        await page.getByTestId('desktop-window-controls-toggle-maximize').click();
        await page.getByTestId('desktop-window-controls-close').click();

        await expect
            .poll(async () => readFakeTauriDesktopState(page), { timeout: 60_000 })
            .toMatchObject({
                controls: {
                    closeCount: 1,
                    minimizeCount: 1,
                    toggleMaximizeCount: 1,
                },
                isMaximized: true,
            });
    });

    test('keeps the desktop shell controls available after collapsing the permanent sidebar', async ({ page }) => {
        test.setTimeout(420_000);
        if (!server || !uiBaseUrl) {
            throw new Error('missing ui base url');
        }

        await launchDesktopShell(page, {
            baseUrl: uiBaseUrl,
            serverUrl: server.baseUrl,
            storageScope: `e2e-desktop-sidebar-chrome-${run.runId}`,
        });
        await collapseDesktopSidebar(page);

        await expect(page.getByTestId('desktop-collapsed-shell-chrome')).toHaveCount(1, { timeout: 60_000 });
        await expect(page.locator('[data-testid="desktop-window-controls-host"]')).toHaveCount(1);
        await expect(page.getByTestId('desktop-window-controls-minimize')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('desktop-window-controls-toggle-maximize')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('desktop-window-controls-close')).toBeVisible({ timeout: 60_000 });
        await expect(page.getByTestId('sidebar-expand-button')).toBeVisible({ timeout: 60_000 });
    });

    test('renders the pre-auth desktop shell chrome without the authenticated sidebar hosts', async ({ page }) => {
        test.setTimeout(420_000);
        if (!uiBaseUrl) {
            throw new Error('missing ui base url');
        }

        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoCommittedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
        await installFakeTauriDesktopBridge(page, {
            state: {
                platform: 'windows',
                strategy: 'custom-controls',
            },
        });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForInitialAppUi({ page, timeoutMs: 180_000 });

        await expect(page.getByTestId('desktop-unauth-shell-chrome')).toHaveCount(1, { timeout: 60_000 });
        await expect(page.locator('[data-testid="desktop-window-controls-host"]')).toHaveCount(1);
        await expect(page.locator('[data-testid="desktop-update-indicator-host"]')).toHaveCount(1);
        await expect(page.getByTestId('desktop-sidebar-chrome')).toHaveCount(0);
        await expect(page.getByTestId('onboarding-wizard')).toHaveCount(1);
    });
});
