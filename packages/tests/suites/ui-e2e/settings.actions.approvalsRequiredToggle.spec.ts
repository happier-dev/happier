import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e' });

async function createAccountIfNeeded(baseUrl: string, page: Page): Promise<void> {
    const createAccount = page.getByTestId('welcome-create-account');
    if (await createAccount.count()) {
        await createAccount.click({ timeout: 60_000, force: true });
        await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });
        await gotoDomContentLoadedWithRetries(page, `${baseUrl}/settings/actions?happier_hmr=0`, 180_000);
    }
}

async function readWebSwitchChecked(locator: Locator): Promise<boolean | null> {
    return await locator.evaluate((node) => {
        if (node instanceof HTMLInputElement) return node.checked;
        const aria = node.getAttribute('aria-checked');
        if (aria === 'true') return true;
        if (aria === 'false') return false;
        return null;
    });
}

test.describe('ui e2e: actions settings approvals-required toggle', () => {
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

    test('shows the Require approval toggle only when a surface tile is selected, and persists its value', async ({ page }) => {
        test.setTimeout(540_000);
        if (!uiBaseUrl) throw new Error('missing ui base url');

        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
        await waitForInitialAppUi({ page, timeoutMs: 180_000 });

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/actions?happier_hmr=0`, 180_000);
        await createAccountIfNeeded(uiBaseUrl, page);

        const actionId = 'session.message.send';
        const tileId = `settings-actions:action:${actionId}:target:cli`;
        const requireApprovalId = `settings-actions:action:${actionId}:target:cli:require-approval`;

        const tile = page.getByTestId(tileId);
        await expect(tile).toHaveCount(1, { timeout: 120_000 });
        await tile.scrollIntoViewIfNeeded();

        const requireApproval = page.getByTestId(requireApprovalId);

        if (await requireApproval.count()) {
            await tile.click({ timeout: 60_000 });
            await expect(requireApproval).toHaveCount(0, { timeout: 60_000 });
        }

        await tile.click({ timeout: 60_000 });
        await expect(requireApproval).toHaveCount(1, { timeout: 60_000 });

        const before = await readWebSwitchChecked(requireApproval);
        await requireApproval.click({ timeout: 60_000, force: true });
        await expect.poll(async () => readWebSwitchChecked(requireApproval)).not.toBe(before);

        const after = await readWebSwitchChecked(requireApproval);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/actions?happier_hmr=0`, 180_000);

        const tileAfterReload = page.getByTestId(tileId);
        await expect(tileAfterReload).toHaveCount(1, { timeout: 120_000 });
        await tileAfterReload.scrollIntoViewIfNeeded();
        await tileAfterReload.click({ timeout: 60_000 });

        const requireAfterReload = page.getByTestId(requireApprovalId);
        await expect(requireAfterReload).toHaveCount(1, { timeout: 60_000 });
        await expect.poll(async () => readWebSwitchChecked(requireAfterReload)).toBe(after);
    });
});
