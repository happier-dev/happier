import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e' });

async function createAccountIfNeeded(page: Page): Promise<void> {
    const createAccount = page.getByTestId('welcome-create-account');
    if (await createAccount.count()) {
        await createAccount.click({ timeout: 60_000, force: true });
        await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });
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
        test.setTimeout(540_000);
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
                ...process.env,
                EXPO_PUBLIC_DEBUG: '1',
                EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
                EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-settings-sidebar-${run.runId}`,
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

                if (wantsScreenshots()) {
                    await page.screenshot({ path: join(screenshotDir, `settings-sidebar.${viewport.label}.notifications.png`), fullPage: true });
                }
            });
        }
    });
});
