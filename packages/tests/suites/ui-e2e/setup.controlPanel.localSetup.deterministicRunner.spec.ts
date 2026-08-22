import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { installFakeTauriDesktopBridge, navigateSpa } from '../../src/testkit/uiE2e/fakeTauriDesktop';
import {
    createAccountAndReachSetupWizardState,
    gotoCommittedWithRetries,
    normalizeLoopbackBaseUrl,
} from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: setup control panel flow (deterministic runner)', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('setup-control-panel-deterministic-runner-suite');

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;

    const uiWebEnv = {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: '',
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
        EXPO_PUBLIC_SYSTEM_TASKS_RUNNER_MODE: 'dev',
        HAPPIER_E2E_UI_WEB_MODE: 'metro',
    };

    test.beforeAll(async () => {
        test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
        await mkdir(suiteDir, { recursive: true });

        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                // UI web E2E create-account can be blocked by content-keys binding; keep this suite focused on setup surfaces.
                HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
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

    test('runs local machine setup and shows deterministic progress + success', async ({ page }) => {
        test.setTimeout(420_000);
        if (!uiBaseUrl) throw new Error('missing ui base url');

        await page.setViewportSize({ width: 1440, height: 900 });

        await gotoCommittedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
        await waitForInitialAppUi({ page, timeoutMs: 180_000 });
        // Avoid making the app "desktop" at initial load, which can activate desktop-only runtimes.
        // Instead, load the web app normally first, then switch setup routes into desktop mode
        // by toggling isDesktopHost() for subsequent renders without a full-page reload.
        await installFakeTauriDesktopBridge(page);
        await createAccountAndReachSetupWizardState({ page });

        await expect(page.getByTestId('setupWizard-setup-this-computer')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('setupWizard-setup-this-computer-checklist-row-setup.thisComputer.stage.confirmRelay')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('setupWizard-setup-this-computer-checklist-row-setup.thisComputer.stage.resolveBackgroundService')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('setupWizard-setup-this-computer-checklist-row-setup.thisComputer.stage.registerComputer')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('setupWizard-setup-this-computer-checklist-row-setup.thisComputer.stage.enableBackgroundService')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('setupWizard-setup-this-computer-checklist-row-setup.thisComputer.stage.verifyReady')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('setupWizard.surface-primary')).toBeEnabled({ timeout: 120_000 });
    });

    test('shows the host relay checklist with satisfied rows in desktop mode', async ({ page }) => {
        test.setTimeout(420_000);
        if (!uiBaseUrl) throw new Error('missing ui base url');

        await page.setViewportSize({ width: 1440, height: 900 });

        await page.addInitScript(() => {
            (window as typeof window & {
                __HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__?: Record<string, unknown>;
            }).__HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__ = {
                'relay.runtime.status.v1': 'ready',
            };
        });

        await gotoCommittedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
        await waitForInitialAppUi({ page, timeoutMs: 180_000 });
        await installFakeTauriDesktopBridge(page);
        await createAccountAndReachSetupWizardState({ page });
        await navigateSpa(page, '/setup/wizard?step=setup_chooser');

        await expect(page.getByTestId('setupWizard-branch:relayLocal')).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId('setupWizard-branch:relayLocal').click();
        await expect(page.getByTestId('setupWizard.surface-primary')).toBeEnabled({ timeout: 120_000 });
        await page.getByTestId('setupWizard.surface-primary').click();

        await expect(page.getByTestId('setupWizard-relay-host-local')).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId('setupWizard-relay-host-local-checklist-row-installRelayRuntime')).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId('setupWizard-relay-host-local-checklist-row-startRelayRuntime')).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId('setupWizard-relay-host-local-checklist-row-enableSecureAccess')).toHaveCount(0);
    });
});
