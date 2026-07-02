import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: remote-dev unauth split shell', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('unauth-remote-dev-split-shell-suite');

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;

    const uiWebEnv = {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: '',
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-unauth-remote-dev`,
        HAPPIER_E2E_UI_WEB_MODE: 'metro',
    };

    async function gotoApp(
        page: Parameters<typeof gotoDomContentLoadedWithRetries>[0],
        path = '/',
        options: Readonly<{ disableHmr?: boolean }> = {},
    ): Promise<void> {
        if (!uiBaseUrl) throw new Error('missing ui base url');
        const url = new URL(path, uiBaseUrl);
        if (options.disableHmr !== false) {
            url.searchParams.set('happier_hmr', '0');
        }
        await gotoDomContentLoadedWithRetries(page, url.toString(), 180_000);
    }

    test.beforeAll(async () => {
        test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
        await mkdir(suiteDir, { recursive: true });

        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                AUTH_ANONYMOUS_SIGNUP_ENABLED: '1',
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

    test('desktop first launch shows the split shell and welcome decision', async ({ page }) => {
        test.setTimeout(240_000);
        await page.setViewportSize({ width: 1100, height: 720 });

        await gotoApp(page);
        await waitForInitialAppUi({ page, timeoutMs: 120_000 });

        await expect(page.getByTestId('unauth-shell-brand-pane')).toBeVisible();
        await expect(page.getByTestId('provider-mark-row')).toBeVisible();
        await expect(page.getByTestId('unauth-shell-workflow-pane')).toBeVisible();
        await expect(page.getByTestId('welcome-decision-panel')).toBeVisible();
        await expect(page.getByTestId('welcome-primary-start')).toBeVisible();
        await expect(page.getByTestId('welcome-secondary-login')).toBeVisible();
    });

    test('desktop login enters restore while preserving the split shell', async ({ page }) => {
        test.setTimeout(240_000);
        await page.setViewportSize({ width: 1100, height: 720 });

        await gotoApp(page);
        await expect(page.getByTestId('welcome-secondary-login')).toBeVisible({ timeout: 120_000 });
        await page.getByTestId('welcome-secondary-login').click();

        const restoreShell = page.getByTestId('unauth-shell-route-restore');
        await expect(restoreShell.getByTestId('unauth-shell-brand-pane')).toBeVisible({ timeout: 120_000 });
        await expect(restoreShell.getByTestId('unauth-shell-workflow-pane')).toBeVisible();
        await expect(restoreShell.getByTestId('restore-route-content')).toBeVisible();
    });

    test('desktop self-hosting entry opens relay setup while preserving the split shell', async ({ page }) => {
        test.setTimeout(240_000);
        await page.setViewportSize({ width: 1100, height: 720 });

        await gotoApp(page);
        await expect(page.getByTestId('welcome-footer-relay-action')).toBeVisible({ timeout: 120_000 });
        await page.getByTestId('welcome-footer-relay-action').click();

        const setupShell = page
            .locator('[data-testid="unauth-shell-route-setup-pre-auth"], [data-testid="unauth-shell-route-setup-browser-web"]')
            .last();
        await expect(setupShell.getByTestId('unauth-shell-brand-pane')).toBeVisible({ timeout: 120_000 });
        await expect(setupShell.getByTestId('unauth-shell-workflow-pane')).toBeVisible();
        await expect(setupShell.getByTestId('relay-select-route-content')).toBeVisible();
    });

    test('mobile first launch shows the brand hero and persists dismissal across reload', async ({ page }) => {
        test.setTimeout(240_000);
        await page.setViewportSize({ width: 393, height: 852 });

        await gotoApp(page);
        await expect(page.getByTestId('unauth-shell-brand-pane')).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId('brand-hero-get-started')).toBeVisible();
        await expect(page.getByTestId('welcome-decision-panel')).toHaveCount(0);

        await page.getByTestId('brand-hero-get-started').click();

        await expect(page.getByTestId('welcome-decision-panel')).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId('brand-hero-get-started')).toHaveCount(0);

        await page.reload({ waitUntil: 'domcontentloaded' });

        await expect(page.getByTestId('brand-hero-get-started')).toHaveCount(0);
        await expect(page.getByTestId('welcome-decision-panel')).toBeVisible({ timeout: 120_000 });
    });

    test('mobile direct restore deep link renders restore content without the brand hero', async ({ page }) => {
        test.setTimeout(240_000);
        await page.setViewportSize({ width: 393, height: 852 });

        await gotoApp(page, '/restore');

        await expect(page.getByTestId('debug-router-pathname')).toHaveText('/restore', { timeout: 120_000 });
        const restoreShell = page.getByTestId('unauth-shell-route-restore');
        await expect(restoreShell).toBeVisible({ timeout: 120_000 });
        await expect(restoreShell.getByTestId('restore-route-content')).toBeVisible();
        await expect(page.getByTestId('brand-hero-get-started')).toHaveCount(0);
    });

    test('mobile recovery and relay entries reached from welcome do not show the brand hero', async ({ page }) => {
        test.setTimeout(240_000);
        await page.setViewportSize({ width: 393, height: 852 });

        await gotoApp(page);
        await expect(page.getByTestId('brand-hero-get-started')).toBeVisible({ timeout: 120_000 });
        await page.getByTestId('brand-hero-get-started').click();

        await expect(page.getByTestId('welcome-secondary-login')).toBeVisible({ timeout: 120_000 });
        await page.getByTestId('welcome-secondary-login').click();

        const restoreShell = page.getByTestId('unauth-shell-route-restore');
        await expect(restoreShell).toBeVisible({ timeout: 120_000 });
        await expect(restoreShell.getByTestId('brand-hero-get-started')).toHaveCount(0);

        await gotoApp(page);
        await expect(page.getByTestId('welcome-footer-relay-action')).toBeVisible({ timeout: 120_000 });
        await page.getByTestId('welcome-footer-relay-action').click();

        const setupShell = page
            .locator('[data-testid="unauth-shell-route-setup-pre-auth"], [data-testid="unauth-shell-route-setup-browser-web"]')
            .last();
        await expect(setupShell).toBeVisible({ timeout: 120_000 });
        await expect(setupShell.getByTestId('brand-hero-get-started')).toHaveCount(0);
    });

    test('desktop unavailable server state preserves retry and relay actions inside the split shell', async ({ page }) => {
        test.setTimeout(240_000);
        await page.setViewportSize({ width: 1100, height: 720 });

        await gotoApp(page, `/?server=${encodeURIComponent('http://127.0.0.1:1')}`);
        await waitForInitialAppUi({ page, timeoutMs: 120_000 });

        const welcomeShell = page.getByTestId('unauth-shell-route-welcome');
        await expect(welcomeShell.getByTestId('unauth-shell-brand-pane')).toBeVisible();
        await expect(welcomeShell.getByTestId('unauth-shell-workflow-pane')).toBeVisible();
        await expect(welcomeShell.getByTestId('welcome-server-unavailable')).toBeVisible();
        await expect(welcomeShell.getByTestId('welcome-change-relay')).toBeVisible();
        await expect(welcomeShell.getByTestId('welcome-retry-server')).toBeVisible();

        await welcomeShell.getByTestId('welcome-change-relay').click();

        const setupShell = page
            .locator('[data-testid="unauth-shell-route-setup-pre-auth"], [data-testid="unauth-shell-route-setup-browser-web"]')
            .last();
        await expect(setupShell.getByTestId('unauth-shell-brand-pane')).toBeVisible({ timeout: 120_000 });
        await expect(setupShell.getByTestId('relay-select-route-content')).toBeVisible();
    });

    test('desktop primary start creates an account and reaches authenticated UI', async ({ page }) => {
        test.setTimeout(300_000);
        await page.setViewportSize({ width: 1100, height: 720 });

        await gotoApp(page);
        await expect(page.getByTestId('welcome-primary-start')).toBeVisible({ timeout: 120_000 });
        await page.getByTestId('welcome-primary-start').click();

        await ensureAccountReadyForConnect({ page, timeoutMs: 180_000, clickCreateAccount: false });
    });
});
