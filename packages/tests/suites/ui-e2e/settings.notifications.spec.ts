import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

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

async function confirmPrompt(page: Page, value: string): Promise<void> {
    const dialog = page.getByRole('dialog');
    await expect(dialog).toHaveCount(1, { timeout: 60_000 });
    await dialog.getByTestId('web-prompt-input').fill(value);
    await dialog.getByTestId('web-prompt-confirm').click();
}

test.describe('ui e2e: settings notifications', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('settings-notifications-suite');

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
                EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-settings-notifications-${run.runId}`,
            },
        });

        uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    });

    test.afterAll(async () => {
        test.setTimeout(60_000);
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    });

    test('renders the notifications settings route and adds a webhook channel', async ({ page }) => {
        test.setTimeout(540_000);
        if (!uiBaseUrl) throw new Error('missing ui base url');

        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
        await waitForInitialAppUi({ page, timeoutMs: 180_000 });
        await createAccountIfNeeded(page);

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/notifications?happier_hmr=0`, 180_000);

        await expect(page.getByTestId('settings-notifications-screen')).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByTestId('settings-notifications-badges-enabled')).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByTestId('settings-notifications-local-enabled')).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByTestId('settings-notifications-push-enabled')).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByTestId('settings-notifications-add-webhook')).toHaveCount(1, { timeout: 60_000 });

        const webhookRows = page.locator('[data-testid^="settings-notifications-webhook-"]');
        await expect(webhookRows).toHaveCount(0, { timeout: 60_000 });

        await page.getByTestId('settings-notifications-add-webhook').click();
        await confirmPrompt(page, 'https://hooks.example.test/notify');

        await expect(webhookRows).toHaveCount(1, { timeout: 60_000 });
    });
});
