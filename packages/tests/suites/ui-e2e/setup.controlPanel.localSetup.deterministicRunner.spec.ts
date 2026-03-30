import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });

async function setFakeTauriInternalsInExistingDocument(page: Page) {
    // Avoid making the app "desktop" at initial load, which can activate desktop-only runtimes.
    // Instead, load the web app normally first, then switch setup routes into desktop mode by
    // toggling isTauriDesktop() for subsequent renders (without a full-page reload).
    await page.evaluate(() => {
        (window as any).__TAURI_INTERNALS__ = {
            invoke: async (command: string, args?: Record<string, unknown>) => {
                switch (command) {
                    case 'desktop_fetch_update':
                        return null;
                    case 'desktop_install_update':
                        return false;
                    case 'desktop_set_tray_state':
                        return null;
                    case 'desktop_get_autostart_enabled':
                        return false;
                    case 'desktop_set_autostart_enabled': {
                        const enabled = Boolean(args && (args as any).enabled);
                        return enabled;
                    }
                    default:
                        return null;
                }
            },
        };
    });
}

async function navigateSpa(page: Page, path: string) {
    await page.evaluate((nextPath) => {
        window.history.pushState({}, '', nextPath);
        window.dispatchEvent(new PopStateEvent('popstate'));
    }, path);
}

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

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
        await setFakeTauriInternalsInExistingDocument(page);
        await navigateSpa(page, '/setup?happier_hmr=0');

        // Pre-auth setup route continues into the auth flow.
        await expect(page.getByTestId('setup.continueToAuth')).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId('setup.continueToAuth').click();

        await expect(page.getByTestId('welcome-create-account')).toHaveCount(1, { timeout: 180_000 });
        await page.getByTestId('welcome-create-account').click();

        // Completing auth should redirect back into setup with a pending setup intent.
        // The post-auth setup route auto-starts local setup; avoid clicking the start action to prevent spawning a second task.
        await expect(page.getByTestId('setup.postAuth')).toHaveCount(1, { timeout: 180_000 });
        await expect(page.getByTestId('settings.machineSetup.startLocalTask')).toHaveCount(1, { timeout: 180_000 });

        // If auto-start is disabled for any reason, fall back to starting the task explicitly.
        const progressCard = page.getByTestId('system-task-progress-card');
        try {
            await expect(progressCard).toHaveCount(1, { timeout: 30_000 });
        } catch {
            await page.getByTestId('settings.machineSetup.startLocalTask').click();
            await expect(progressCard).toHaveCount(1, { timeout: 180_000 });
        }

        await expect(page.getByTestId('system-task-progress-card')).toHaveCount(1, { timeout: 120_000 });

        // Deterministic bridge finishes quickly; assert on stable status ids instead of copy.
        await expect(page.getByTestId('system-task-progress-status-succeeded')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('system-task-step-label')).toHaveCount(1, { timeout: 120_000 });
    });
});
