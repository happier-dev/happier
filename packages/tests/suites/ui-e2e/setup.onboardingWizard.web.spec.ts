import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { gotoCommittedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: web onboarding wizard', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('setup-onboarding-wizard-web-suite');

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
                AUTH_ANONYMOUS_SIGNUP_ENABLED: '1',
                AUTH_SIGNUP_PROVIDERS: 'github',
                HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_ENABLED: '0',
                HAPPIER_FEATURE_AUTH_RECOVERY__PROVIDER_RESET_ENABLED: '1',
                GITHUB_CLIENT_ID: 'gh_client',
                GITHUB_CLIENT_SECRET: 'gh_secret',
                GITHUB_REDIRECT_URL: 'http://127.0.0.1:1/v1/oauth/github/callback',
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

    async function openRoot(page: Page) {
        if (!uiBaseUrl) throw new Error('missing ui base url');

        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoCommittedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
        await expect(page.getByTestId('onboarding-wizard')).toBeVisible({ timeout: 120_000 });
    }

    async function advanceWizardToAuthEntry(page: Page, mode: 'guided' | 'skip') {
        await openRoot(page);

        if (mode === 'skip') {
            await expect(page.getByTestId('onboarding-wizard-skip')).toHaveCount(1, { timeout: 120_000 });
            await page.getByTestId('onboarding-wizard-skip').click();
            await expect(page.getByTestId('welcome-create-account')).toHaveCount(1, { timeout: 120_000 });
            return;
        }

        await expect(page.locator('[data-testid^="onboarding-wizard-welcome-provider:"]').first()).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId('onboarding-wizard-primary')).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId('onboarding-wizard-primary').click();

        await expect(page.getByTestId('onboarding-wizard-relay-diagram')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('onboarding-wizard-relay:cloud')).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId('onboarding-wizard-relay:cloud').click();
        await page.getByTestId('onboarding-wizard-primary').click();

        await expect(page.getByTestId('welcome-create-account')).toHaveCount(1, { timeout: 120_000 });
    }

    async function openRootAndCreateAccount(page: Page, mode: 'guided' | 'skip' = 'guided') {
        await advanceWizardToAuthEntry(page, mode);

        await page.getByTestId('welcome-create-account').click();

        await expect(page.getByTestId('session-getting-started-cli-follow-up')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('session-getting-started-step-install_cli')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('session-getting-started-step-auth_login')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('session-getting-started-step-daemon_install')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('session-getting-started-step-create_session')).toHaveCount(1, { timeout: 120_000 });
    }

    test('web onboarding reaches the getting started guidance after authentication', async ({ page }) => {
        test.setTimeout(300_000);
        await openRootAndCreateAccount(page, 'guided');
    });

    test('web onboarding keeps the install and auth copy buttons stable', async ({ page }) => {
        test.setTimeout(300_000);
        await openRootAndCreateAccount(page, 'guided');

        await expect(page.getByTestId('session-getting-started-copy-install_cli')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('session-getting-started-copy-server_setup')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('session-getting-started-copy-auth_login')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('session-getting-started-copy-daemon_install')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('session-getting-started-copy-create_session')).toHaveCount(1, { timeout: 120_000 });
    });

    test('web onboarding skip jumps to auth entry', async ({ page }) => {
        test.setTimeout(300_000);
        await openRootAndCreateAccount(page, 'skip');
    });

    test('web onboarding supports providers showcase and back navigation', async ({ page }) => {
        test.setTimeout(300_000);
        await openRoot(page);

        await expect(page.locator('[data-testid^="onboarding-wizard-welcome-provider:"]').first()).toBeVisible({ timeout: 120_000 });

        await page.getByTestId('onboarding-wizard-primary').click();

        await expect(page.getByTestId('onboarding-wizard-back')).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId('onboarding-wizard-back').click();

        await expect(page.locator('[data-testid^="onboarding-wizard-welcome-provider:"]').first()).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId('onboarding-wizard-primary')).toHaveCount(1, { timeout: 120_000 });

        await page.getByTestId('onboarding-wizard-primary').click();
        await expect(page.getByTestId('onboarding-wizard-relay-diagram')).toHaveCount(1, { timeout: 120_000 });
    });
});
