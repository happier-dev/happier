import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: setup control panel flow', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('setup-control-panel-flow-suite');

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    const uiWebEnv = {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: '',
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
        HAPPIER_E2E_UI_WEB_MODE: 'metro',
    };

    test.beforeAll(async () => {
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

    test('shows the desktop-only setup notice on web', async ({ page }) => {
        test.setTimeout(300_000);
        if (!uiBaseUrl) throw new Error('missing ui base url');

        await page.setViewportSize({ width: 1440, height: 900 });

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/setup?happier_hmr=0`, 180_000);

        await expect(page.getByTestId('setup.desktopOnlyNotice')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('setup.primaryActions')).toHaveCount(0);
        await expect(page.getByTestId('setup.changeRelay')).toHaveCount(0);
        await expect(page.getByTestId('setup.discard')).toHaveCount(0);
        await expect(page.getByTestId('setup.postAuth')).toHaveCount(0);
        await expect(page.getByTestId('setup.summary.activeRelay')).toHaveCount(0);
        await expect(page.getByTestId('setup.summary.thisComputer')).toHaveCount(0);
        await expect(page.getByTestId('setup.summary.nextAction')).toHaveCount(0);
        await expect(page.getByTestId('setup.webRelayDriftNotice')).toHaveCount(0);
        await expect(page.getByTestId('settings.machineSetup.startLocalTask')).toHaveCount(0);
        await expect(page.getByTestId('settings.localRelayRuntime.status')).toHaveCount(0);
        await expect(page.getByTestId('settings.localTailscale.status')).toHaveCount(0);
    });
});
