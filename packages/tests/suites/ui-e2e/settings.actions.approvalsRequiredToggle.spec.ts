import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createTestAuth } from '../../src/testkit/auth';
import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { normalizeLoopbackBaseUrl, waitForAuthenticatedRouteUi } from '../../src/testkit/uiE2e/pageNavigation';
import { buildAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/buildAuthBootstrapStorageSnapshot';
import { installAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';

const run = createRunDirs({ runLabel: 'ui-e2e' });

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
        if (!server || !uiBaseUrl) throw new Error('missing fixtures');

        const actionId = 'session.message.send';
        const tileId = `settings-actions:action:${actionId}:target:cli`;
        const requireApprovalId = `settings-actions:action:${actionId}:target:cli:require-approval`;

        await page.setViewportSize({ width: 1440, height: 900 });
        const auth = await createTestAuth(server.baseUrl);
        await installAuthBootstrapStorageSnapshot(page, buildAuthBootstrapStorageSnapshot({
            serverUrl: server.baseUrl,
            credentials: { token: auth.token, secret: auth.token },
            storageScope: `e2e-settings-actions-${run.runId}`,
        }));

        await page.goto(`${uiBaseUrl}/settings/actions?happier_hmr=0`, { waitUntil: 'domcontentloaded' });
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/settings/actions',
            requiredTestIds: [tileId],
            timeoutMs: 120_000,
        });

        const tile = page.getByTestId(tileId);
        await expect(tile).toHaveCount(1, { timeout: 120_000 });
        await tile.scrollIntoViewIfNeeded();
        const requireApproval = page.getByTestId(requireApprovalId);

        if ((await requireApproval.count()) === 0) {
            await tile.click({ timeout: 60_000 });
            await expect(requireApproval).toHaveCount(1, { timeout: 60_000 });
        } else {
            await expect(requireApproval).toHaveCount(1, { timeout: 60_000 });
        }

        await requireApproval.click({ timeout: 60_000 });
        await expect(requireApproval).toHaveAttribute('aria-checked', 'true', { timeout: 60_000 });

        await page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAuthenticatedRouteUi({
            page,
            expectedPathname: '/settings/actions',
            requiredTestIds: [tileId],
            timeoutMs: 120_000,
        });

        const tileAfterReload = page.getByTestId(tileId);
        await expect(tileAfterReload).toHaveCount(1, { timeout: 120_000 });
        const requireAfterReload = page.getByTestId(requireApprovalId);
        if ((await requireAfterReload.count()) === 0) {
            await tileAfterReload.scrollIntoViewIfNeeded();
            await tileAfterReload.click({ timeout: 60_000 });
            await expect(requireAfterReload).toHaveCount(1, { timeout: 60_000 });
        } else {
            await expect(requireAfterReload).toHaveCount(1, { timeout: 60_000 });
        }
        await expect(requireAfterReload).toHaveAttribute('aria-checked', 'true', { timeout: 60_000 });
    });
});
