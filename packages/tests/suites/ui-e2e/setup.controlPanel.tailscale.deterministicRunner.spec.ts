import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });

async function setFakeTauriInternalsInExistingDocument(page: Page) {
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

test.describe('ui e2e: tailscale secure access (deterministic runner)', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('setup-control-panel-tailscale-deterministic-runner-suite');

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

    async function openAuthedSetupWizard(page: Page) {
        if (!uiBaseUrl) throw new Error('missing ui base url');
        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
        await setFakeTauriInternalsInExistingDocument(page);

        await expect(page.getByTestId('onboarding-wizard')).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId('onboarding-wizard-skip')).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId('onboarding-wizard-skip').click();

        await expect(page.getByTestId('welcome-create-account')).toHaveCount(1, { timeout: 180_000 });
        await page.getByTestId('welcome-create-account').click();

        await expect(page.getByTestId('session-getting-started-setup-primary-card')).toHaveCount(1, { timeout: 180_000 });

        await navigateSpa(page, '/setup/wizard?happier_hmr=0');
        await expect(page.getByTestId('setupWizard.surface-skip')).toHaveCount(1, { timeout: 120_000 });
    }

    test('shows a shareable https url when secure access completes', async ({ page }) => {
        test.setTimeout(420_000);

        await openAuthedSetupWizard(page);

        await expect(page.getByTestId('setupWizard.surface-branch:tailscale')).toHaveCount(1, { timeout: 180_000 });
        await page.getByTestId('setupWizard.surface-branch:tailscale').click();
        await page.getByTestId('setupWizard.surface-primary').click();

        await expect(page.getByTestId('settings.localTailscale.enable')).toHaveCount(1, { timeout: 180_000 });
        await page.getByTestId('settings.localTailscale.enable').click();

        await expect(page.getByTestId('settings.localTailscale.shareableUrl')).toHaveCount(1, { timeout: 180_000 });
    });

    test('surfaces a tailnet approval url when serve needs approval', async ({ page }) => {
        test.setTimeout(420_000);

        await openAuthedSetupWizard(page);

        await page.evaluate(() => {
            (window as any).__HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__ = {
                'secureAccess.tailscale.v1': 'approval',
            };
        });

        await page.getByTestId('setupWizard.surface-branch:tailscale').click();
        await page.getByTestId('setupWizard.surface-primary').click();

        await page.getByTestId('settings.localTailscale.enable').click();
        await expect(page.getByTestId('settings.localTailscale.openApproval')).toHaveCount(1, { timeout: 180_000 });
    });
});
