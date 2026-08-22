import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createTestAuth } from '../../src/testkit/auth';
import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl, waitForAuthenticatedRouteUi } from '../../src/testkit/uiE2e/pageNavigation';
import { buildAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/buildAuthBootstrapStorageSnapshot';
import { installAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';

const run = createRunDirs({ runLabel: 'ui-e2e' });

async function readWebSwitchChecked(locator: Locator): Promise<boolean | null> {
    return await locator.evaluate((node) => {
        if (node instanceof HTMLInputElement) return node.checked;
        const aria = node.getAttribute('aria-checked');
        if (aria === 'true') return true;
        if (aria === 'false') return false;
        return null;
    });
}

async function clickSwitchAndWaitForChange(locator: Locator): Promise<boolean | null> {
    const before = await readWebSwitchChecked(locator);
    await locator.click({ timeout: 60_000, force: true });
    await expect.poll(async () => readWebSwitchChecked(locator)).not.toBe(before);
    return await readWebSwitchChecked(locator);
}

async function openActionDetailFromList(params: Readonly<{
    page: Page;
    baseUrl: string;
    actionId: string;
    requiredTestId?: string;
}>): Promise<void> {
    const actionRowId = `settings-actions:action:${params.actionId}`;
    await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/settings/actions?happier_hmr=0`, 180_000);
    await waitForAuthenticatedRouteUi({
        page: params.page,
        expectedPathname: '/settings/actions',
        requiredTestIds: [actionRowId],
        timeoutMs: 120_000,
    });
    await params.page.getByTestId(actionRowId).scrollIntoViewIfNeeded();
    await params.page.getByTestId(actionRowId).click({ timeout: 60_000 });
    await expect(params.page).toHaveURL(new RegExp(`/settings/actions/${encodeURIComponent(params.actionId)}(?:[?#].*)?$`), {
        timeout: 60_000,
    });
    if (params.requiredTestId) {
        await expect(params.page.getByTestId(params.requiredTestId)).toHaveCount(1, { timeout: 120_000 });
    }
}

test.describe('ui e2e: actions settings detail approval modes', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('settings-actions-approvals-toggle-suite');

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
                EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-settings-actions-approvals-${run.runId}`,
            },
        });

        uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    });

    test.afterAll(async () => {
        test.setTimeout(60_000);
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    });

    test('persists action detail approval modes and keeps non-approval targets simple', async ({ page }) => {
        test.setTimeout(540_000);
        if (!server || !uiBaseUrl) throw new Error('missing fixtures');

        const actionId = 'session.spawn_new';
        const actionRowId = `settings-actions:action:${actionId}`;
        const actionEnabledId = `settings-actions:action:${actionId}:enabled`;
        const cliModeId = `settings-actions:action:${actionId}:target:cli:mode`;
        const cliAskFirstId = `settings-actions:action:${actionId}:target:cli:mode:ask_first`;
        const cliAllowedId = `settings-actions:action:${actionId}:target:cli:mode:allowed`;
        const cliOffId = `settings-actions:action:${actionId}:target:cli:mode:off`;
        const commandPaletteEnabledId = `settings-actions:action:${actionId}:target:command_palette:enabled`;
        const commandPaletteAskFirstId = `settings-actions:action:${actionId}:target:command_palette:mode:ask_first`;

        await page.setViewportSize({ width: 1440, height: 900 });
        const auth = await createTestAuth(server.baseUrl);
        await installAuthBootstrapStorageSnapshot(page, buildAuthBootstrapStorageSnapshot({
            serverUrl: server.baseUrl,
            auth,
            mode: 'legacy',
            storageScope: `e2e-settings-actions-${run.runId}`,
        }));

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/actions?happier_hmr=0`, 180_000);
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/settings/actions',
            requiredTestIds: [actionRowId],
            timeoutMs: 120_000,
        });

        const actionRow = page.getByTestId(actionRowId);
        await expect(actionRow).toHaveCount(1, { timeout: 120_000 });
        await actionRow.scrollIntoViewIfNeeded();

        const actionEnabled = page.getByTestId(actionEnabledId);
        const disabledState = await clickSwitchAndWaitForChange(actionEnabled);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.goto(`${uiBaseUrl}/settings/actions?happier_hmr=0`, { waitUntil: 'domcontentloaded' });
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/settings/actions',
            requiredTestIds: [actionEnabledId],
            timeoutMs: 120_000,
        });
        await expect.poll(async () => readWebSwitchChecked(page.getByTestId(actionEnabledId))).toBe(disabledState);

        await clickSwitchAndWaitForChange(page.getByTestId(actionEnabledId));

        await page.getByTestId(actionRowId).click({ timeout: 60_000 });
        await expect(page).toHaveURL(new RegExp(`/settings/actions/${encodeURIComponent(actionId)}(?:[?#].*)?$`), {
            timeout: 60_000,
        });

        await expect(page.getByTestId(cliModeId)).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId(cliAskFirstId).click({ timeout: 60_000 });
        await openActionDetailFromList({
            page,
            baseUrl: uiBaseUrl,
            actionId,
            requiredTestId: cliAskFirstId,
        });
        await expect(page.getByTestId(cliAskFirstId)).toHaveAttribute('aria-selected', 'true', { timeout: 60_000 });

        await page.getByTestId(cliAllowedId).click({ timeout: 60_000 });
        await expect(page.getByTestId(cliAllowedId)).toHaveAttribute('aria-selected', 'true', { timeout: 60_000 });

        await page.getByTestId(cliOffId).click({ timeout: 60_000 });
        await openActionDetailFromList({
            page,
            baseUrl: uiBaseUrl,
            actionId,
            requiredTestId: cliOffId,
        });
        await expect(page.getByTestId(cliOffId)).toHaveAttribute('aria-selected', 'true', { timeout: 60_000 });

        await expect(page.getByTestId(commandPaletteEnabledId)).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByTestId(commandPaletteAskFirstId)).toHaveCount(0);
    });
});
