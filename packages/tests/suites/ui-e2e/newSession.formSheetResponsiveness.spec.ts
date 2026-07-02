import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import {
    createAccountAndReachConnectMachineState,
    gotoDomContentLoadedWithRetries,
    normalizeLoopbackBaseUrl,
} from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });

const startNewSessionTestIds = [
    'main-header-start-new-session',
    'home-header-start-new-session',
    'nav-new-session',
    'session-getting-started-start-new-session',
] as const;

async function firstVisibleByTestId(
    page: Page,
    testIds: readonly string[],
): Promise<Locator | null> {
    for (const testId of testIds) {
        const locator = page.getByTestId(testId);
        const count = await locator.count();
        for (let index = 0; index < count; index += 1) {
            const candidate = locator.nth(index);
            if (await candidate.isVisible().catch(() => false)) {
                return candidate;
            }
        }
    }
    return null;
}

async function waitForVisibleByTestId(
    page: Page,
    testIds: readonly string[],
    timeoutMs: number,
): Promise<Locator> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const locator = await firstVisibleByTestId(page, testIds);
        if (locator) return locator;

        await page.waitForTimeout(250);
    }

    throw new Error(`Timed out waiting for visible testID in ${testIds.join(', ')}`);
}

test.describe('ui e2e: new-session formSheet responsiveness', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('new-session-formsheet-responsiveness-suite');
    const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let daemon: StartedDaemon | null = null;

    test.beforeAll(async () => {
        test.setTimeout(540_000);
        await mkdir(suiteDir, { recursive: true });
        await mkdir(cliHomeDir, { recursive: true });

        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
            },
        });

        ui = await startUiWeb({
            testDir: suiteDir,
            env: {
                ...process.env,
                EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
                EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
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

    test('opens from the sessions surface and closes through the stable cancel affordance', async ({ page }) => {
        test.setTimeout(360_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 240_000);
        await createAccountAndReachConnectMachineState({ page });
        daemon = await authenticateAndStartDaemon({
            page,
            testDir: suiteDir,
            cliHomeDir,
            serverUrl: server.baseUrl,
            uiBaseUrl,
            createAccount: false,
            terminalConnectUrlTimeoutMs: 180_000,
            daemonStartupTimeoutMs: 180_000,
        });
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 240_000);

        const startNewSession = await waitForVisibleByTestId(page, startNewSessionTestIds, 120_000);
        await startNewSession.click();

        await page.waitForURL((url) => url.pathname.endsWith('/new'), { timeout: 60_000 });
        await expect(page.getByTestId('new-session-composer-input')).toBeVisible({ timeout: 60_000 });

        await page.getByTestId('new-session-composer-input').fill('formsheet responsiveness smoke');
        await expect(page.getByTestId('new-session-composer-input')).toHaveValue('formsheet responsiveness smoke');
        await expect(page.getByTestId('new-session-composer-send')).toBeVisible({ timeout: 60_000 });

        await expect(page.getByTestId('new-session-cancel')).toBeVisible({ timeout: 60_000 });
        await page.getByTestId('new-session-cancel').click();

        await page.waitForURL((url) => !url.pathname.endsWith('/new'), { timeout: 60_000 });
        await expect(page.getByTestId('new-session-composer-input')).toHaveCount(0);
    });
});
