import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { createAccountAndReachConnectMachineState, gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e' });

async function createAccountIfNeeded(page: Page): Promise<void> {
    const createAccount = page.getByTestId('welcome-create-account');
    if (await createAccount.count()) {
        await createAccountAndReachConnectMachineState({ page });
    }
}

function wantsScreenshots(): boolean {
    const raw = String(process.env.HAPPIER_UI_E2E_CAPTURE_SCREENSHOTS ?? '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

test.describe('ui e2e: settings sidebar', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('settings-sidebar-suite');

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;

    test.beforeAll(async () => {
        const uiWebEnv = {
            ...process.env,
            EXPO_PUBLIC_DEBUG: '1',
            EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-settings-sidebar-${run.runId}`,
            HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS: '900000',
            HAPPIER_E2E_UI_WEB_EXPORT_WORKSPACE_PREBUILD_TIMEOUT_MS: '900000',
            HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS: '300000',
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
        test.setTimeout(60_000);
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    });

    test('renders the nested settings sidebar and supports page search', async ({ page }) => {
        test.setTimeout(540_000);
        if (!uiBaseUrl) throw new Error('missing ui base url');

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
        await waitForInitialAppUi({ page, timeoutMs: 180_000 });
        await createAccountIfNeeded(page);

        const screenshotDir = join(suiteDir, 'screenshots');
        if (wantsScreenshots()) {
            await mkdir(screenshotDir, { recursive: true });
        }

        const viewports = [
            { label: 'desktop', width: 1440, height: 900 },
            { label: 'tablet', width: 1024, height: 768 },
        ] as const;

        for (const viewport of viewports) {
            await test.step(`viewport: ${viewport.label}`, async () => {
                await page.setViewportSize({ width: viewport.width, height: viewport.height });
                await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings?happier_hmr=0`, 180_000);

                // Global app sidebar still renders on desktop/tablet.
                await expect(page.getByTestId('nav-settings')).toHaveCount(1, { timeout: 60_000 });

                // Nested settings navigation renders inside the main content region.
                await expect(page.getByTestId('settings-sidebar')).toHaveCount(1, { timeout: 60_000 });

                if (wantsScreenshots()) {
                    await page.screenshot({ path: join(screenshotDir, `settings-sidebar.${viewport.label}.initial.png`), fullPage: true });
                }

                await page.getByTestId('settings-sidebar.searchInput').fill('notif');
                await expect(page.getByTestId('settings-sidebar.searchResult.notifications')).toHaveCount(1, { timeout: 60_000 });

                if (wantsScreenshots()) {
                    await page.screenshot({ path: join(screenshotDir, `settings-sidebar.${viewport.label}.search.png`), fullPage: true });
                }

                await page.getByTestId('settings-sidebar.searchResult.notifications').click();

                await expect(page).toHaveURL(/\/settings\/notifications/);
                await expect(page.getByTestId('settings-notifications-screen')).toHaveCount(1, { timeout: 60_000 });

                await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings?happier_hmr=0`, 180_000);
                await page.getByTestId('settings-sidebar.searchInput').fill('plugin');
                await expect(page.getByTestId('settings-sidebar.searchResult.plugins')).toHaveCount(1, { timeout: 60_000 });
                await page.getByTestId('settings-sidebar.searchResult.plugins').click();

                await expect(page).toHaveURL(/\/settings\/plugins/);
                await expect(page.getByTestId('settings.plugins.marketplace.catalogUrl')).toHaveCount(1, { timeout: 60_000 });

                if (wantsScreenshots()) {
                    await page.screenshot({ path: join(screenshotDir, `settings-sidebar.${viewport.label}.notifications.png`), fullPage: true });
                }

                await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/appearance?happier_hmr=0`, 180_000);
                const settingsSidebarToggleRow = page.getByTestId('settings-appearance-settings-nav-sidebar-enabled');
                await expect(settingsSidebarToggleRow).toHaveCount(1, { timeout: 60_000 });

                await settingsSidebarToggleRow.click();
                await expect(page.getByTestId('settings-sidebar')).toHaveCount(0, { timeout: 60_000 });

                await settingsSidebarToggleRow.click();
                await expect(page.getByTestId('settings-sidebar')).toHaveCount(1, { timeout: 60_000 });
            });
        }
    });
});
