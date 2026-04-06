import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import {
    createAccountAndReachSetupWizardState,
    gotoCommittedWithRetries,
    normalizeLoopbackBaseUrl,
} from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

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

async function setDevSystemTaskScenarios(page: Page, scenarios: Record<string, unknown>) {
    await page.addInitScript((nextScenarios) => {
        (window as typeof window & {
            __HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__?: Record<string, unknown>;
        }).__HAPPIER_DEV_SYSTEM_TASK_SCENARIOS__ = nextScenarios;
    }, scenarios);
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

    async function openRelaySetupChooser(page: Page) {
        if (!uiBaseUrl) throw new Error('missing ui base url');
        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoCommittedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
        await waitForInitialAppUi({ page, timeoutMs: 180_000 });
        await setFakeTauriInternalsInExistingDocument(page);
        await createAccountAndReachSetupWizardState({ page });
        await navigateSpa(page, '/setup/wizard?step=setup_chooser');
        await expect(page.getByTestId('setupWizard.surface')).toBeVisible({ timeout: 120_000 });
    }

    async function openRelayLocalSetup(page: Page) {
        await expect(page.getByTestId('setupWizard-branch:relayLocal')).toHaveCount(1, { timeout: 180_000 });
        await page.getByTestId('setupWizard-branch:relayLocal').click();
        await page.getByTestId('setupWizard.surface-primary').click();
    }

    async function continueLocalRelayChecklistUntil(page: Page, nextStepTestId: string) {
        await expect(page.getByTestId('setupWizard-relay-host-local')).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId('setupWizard-relay-host-local-checklist-row-installRelayRuntime')).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId('setupWizard-relay-host-local-checklist-row-startRelayRuntime')).toBeVisible({ timeout: 120_000 });
        const primary = page.getByTestId('setupWizard.surface-primary');
        const nextStep = page.getByTestId(nextStepTestId);

        for (let attempt = 0; attempt < 3; attempt += 1) {
            await expect(primary).toBeEnabled({ timeout: 120_000 });
            await primary.click();
            if (await nextStep.count() > 0) {
                return;
            }
            await expect(page.getByTestId('setupWizard-relay-host-local')).toBeVisible({ timeout: 120_000 });
        }

        await expect(nextStep).toHaveCount(1, { timeout: 120_000 });
    }

    async function continueWizardUntil(page: Page, currentStepTestId: string, nextStepTestId: string) {
        const primary = page.getByTestId('setupWizard.surface-primary');
        const currentStep = page.getByTestId(currentStepTestId);
        const nextStep = page.getByTestId(nextStepTestId);

        for (let attempt = 0; attempt < 3; attempt += 1) {
            await expect(primary).toBeEnabled({ timeout: 120_000 });
            await primary.click();
            if (await nextStep.count() > 0) {
                return;
            }
            await expect(currentStep).toHaveCount(1, { timeout: 120_000 });
        }

        await expect(nextStep).toHaveCount(1, { timeout: 120_000 });
    }

    test('keeps the local relay host step visible even when it is already satisfied', async ({ page }) => {
        test.setTimeout(420_000);

        await setDevSystemTaskScenarios(page, {
            'relay.runtime.status.v1': 'ready',
        });

        await openRelaySetupChooser(page);
        await openRelayLocalSetup(page);

        await expect(page.getByTestId('setupWizard-relay-host-local')).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId('setupWizard-relay-host-local-checklist-row-installRelayRuntime')).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId('setupWizard-relay-host-local-checklist-row-startRelayRuntime')).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId('setupWizard-relay-host-local-checklist-row-enableSecureAccess')).toHaveCount(0);

        await expect(page.getByTestId('setupWizard.surface-primary')).toBeEnabled({ timeout: 120_000 });
        await page.getByTestId('setupWizard.surface-primary').click();
        await expect(page.getByTestId('settings.server.relayAccess.choice:tailscaleServe')).toHaveCount(1, { timeout: 120_000 });
    });

    test('routes LAN relay access through the prerequisites step before finishing', async ({ page }) => {
        test.setTimeout(420_000);

        await openRelaySetupChooser(page);
        await openRelayLocalSetup(page);
        await continueLocalRelayChecklistUntil(page, 'settings.server.relayAccess.choice:lan');
        await page.getByTestId('settings.server.relayAccess.choice:lan').click();
        await page.getByTestId('setupWizard.surface-primary').click();

        await expect(page.getByTestId('setupWizard-relay-access-prereqs')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('setupWizard-relay-access-prereqs-url')).toHaveCount(1, { timeout: 120_000 });

        await page.getByTestId('setupWizard-relay-access-prereqs-url').fill('https://relay.example.test');
        await page.getByTestId('setupWizard.surface-primary').click();

        await expect(page.getByTestId('setupWizard-confirmSwitchRelay')).toHaveCount(1, { timeout: 120_000 });
    });

    test('starts deterministic Tailscale secure access from the relay-access step and advances on success', async ({ page }) => {
        test.setTimeout(420_000);

        await setDevSystemTaskScenarios(page, {
            'secureAccess.tailscale.v1': 'visibleSuccess',
        });

        await openRelaySetupChooser(page);
        await openRelayLocalSetup(page);
        await continueLocalRelayChecklistUntil(page, 'settings.server.relayAccess.choice:tailscaleServe');
        await page.getByTestId('settings.server.relayAccess.choice:tailscaleServe').click();
        await page.getByTestId('setupWizard.surface-primary').click();

        await expect(page.getByTestId('setupWizard-relay-access-prereqs')).toHaveCount(1, { timeout: 120_000 });
        await continueWizardUntil(page, 'setupWizard-relay-access-prereqs', 'system-task-progress-card');
        await expect(page.getByTestId('system-task-progress-card')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('system-task-progress-checklist-step-done-tailscale-detect')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('setupWizard-confirmSwitchRelay')).toHaveCount(1, { timeout: 120_000 });
    });

    test('routes remote relay hosting through the shared relay-access Tailscale flow before switch confirmation', async ({ page }) => {
        test.setTimeout(420_000);

        await setDevSystemTaskScenarios(page, {
            'remote.ssh.bootstrapMachine.v1': 'relayHostReady',
            'secureAccess.tailscale.v1': 'visibleSuccess',
        });

        await openRelaySetupChooser(page);

        await expect(page.getByTestId('setupWizard-branch:remoteRelay')).toHaveCount(1, { timeout: 180_000 });
        await page.getByTestId('setupWizard-branch:remoteRelay').click();
        await page.getByTestId('setupWizard.surface-primary').click();

        await expect(page.getByTestId('setupWizard-remote-ssh')).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId('setupWizard-remote-ssh-ssh-sshUsernameInput').fill('dev');
        await page.getByTestId('setupWizard-remote-ssh-ssh-sshHostInput').fill('remote.example.test');

        await page.getByTestId('setupWizard.surface-primary').click();
        await expect(page.getByTestId('setupWizard-remote-ssh-plan')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('setupWizard-remote-ssh-plan-row-install_relay_runtime')).toHaveCount(1, { timeout: 120_000 });

        await page.getByTestId('setupWizard.surface-primary').click();
        await expect(page.getByTestId('setupWizard-remote-ssh-complete-checklist')).toHaveCount(1, { timeout: 120_000 });

        await page.getByTestId('setupWizard.surface-primary').click();
        await expect(page.getByTestId('settings.server.relayAccess.choice:tailscaleServe')).toHaveCount(1, { timeout: 120_000 });

        await page.getByTestId('settings.server.relayAccess.choice:tailscaleServe').click();
        await page.getByTestId('setupWizard.surface-primary').click();

        await expect(page.getByTestId('setupWizard-relay-access-prereqs')).toHaveCount(1, { timeout: 120_000 });
        await continueWizardUntil(page, 'setupWizard-relay-access-prereqs', 'system-task-progress-card');
        await expect(page.getByTestId('system-task-progress-card')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('system-task-progress-checklist-step-done-tailscale-detect')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('setupWizard-confirmSwitchRelay')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('setupWizard-confirmSwitchRelay')).toContainText('https://relay.tailnet.ts.net', { timeout: 120_000 });
    });
});
