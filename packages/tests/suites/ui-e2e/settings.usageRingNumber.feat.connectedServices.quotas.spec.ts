import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { setUiFeatureToggle } from '../../src/testkit/uiE2e/setUiFeatureToggle';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('usage ring center-number preference', () => {
    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let baseUrl: string;

    test.beforeAll(async () => {
        test.setTimeout(540_000);
        const testDir = run.testDir('usage-ring-number');
        await mkdir(testDir, { recursive: true });
        server = await startServerLight({ testDir, dbProvider: 'sqlite', extraEnv: {
            HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
            HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: '1',
            HAPPIER_FEATURE_CONNECTED_SERVICES_QUOTAS__ENABLED: '1',
        } });
        ui = await startUiWeb({ testDir, env: {
            ...process.env, EXPO_PUBLIC_DEBUG: '1', EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
            EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-usage-ring-number-${run.runId}`,
        } });
        baseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    });

    test.afterAll(async () => {
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    });

    test('retains the number choice after reload without changing gauge windows', async ({ page }) => {
        test.setTimeout(180_000);
        const diagnostics = collectBrowserDiagnostics({ page });
        try {
            await gotoDomContentLoadedWithRetries(page, `${baseUrl}/?happier_hmr=0`, 180_000);
            await waitForInitialAppUi({ page, timeoutMs: 180_000 });
            await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });
            for (const featureId of ['connectedServices', 'connectedServices.quotas']) {
                await setUiFeatureToggle({ page, baseUrl, featureId, enabled: true });
            }
            await gotoDomContentLoadedWithRetries(page, `${baseUrl}/settings/usage?happier_hmr=0`, 180_000);
            const windows = page.getByTestId('settings-session-providerUsageGauge-window-trigger');
            await expect(windows).toBeVisible();
            const before = await windows.textContent() ?? '';
            const number = page.getByTestId('settings-session-providerUsageGauge-number-trigger');
            await number.click();
            await page.getByTestId('settings-session-providerUsageGauge-number:weekly').click();
            await expect(number).toContainText('Weekly');
            await expect(windows).toHaveText(before);
            await page.reload();
            await expect(number).toContainText('Weekly');
            await expect(windows).toHaveText(before);
            await page.screenshot({ path: run.testDir('usage-ring-number') + '/settings.png' });
        } catch (error) {
            throw appendBrowserDiagnostics(error, diagnostics());
        }
    });
});
