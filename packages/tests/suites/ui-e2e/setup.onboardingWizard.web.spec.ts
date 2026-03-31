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
        HAPPIER_E2E_UI_WEB_MODE: 'export',
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

    async function openRoot(page: Page, viewport: 'mobile' | 'desktop' = 'mobile') {
        if (!uiBaseUrl) throw new Error('missing ui base url');

        await page.addInitScript(() => {
            try {
                localStorage.clear();
                sessionStorage.clear();
            } catch {
                // Ignore storage cleanup failures; the test still benefits from the init-script hook.
            }
        });

        if (viewport === 'mobile') {
            // Keep the viewport in the phone-sized range so Expo web renders a single primary navigation stack.
            await page.setViewportSize({ width: 390, height: 844 });
        } else {
            await page.setViewportSize({ width: 1100, height: 820 });
        }
        await gotoCommittedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 240_000);
        try {
            await expect(page.getByTestId('onboarding-wizard')).toBeVisible({ timeout: 180_000 });
            const viewport = page.viewportSize();
            if (viewport) {
                // The wizard renders as a full-screen sheet on phone-sized viewports (no backdrop scrim).
                // On larger desktop viewports, it renders as a centered card with a full-viewport scrim.
                if (viewport.width > 430) {
                    const scrim = page.getByTestId('onboarding-wizard-scrim');
                    await expect(scrim).toBeVisible({ timeout: 120_000 });
                    const box = await scrim.boundingBox();
                    expect(box, 'expected onboarding wizard scrim to cover the viewport').toBeTruthy();
                    if (box) {
                        expect(box.x).toBeLessThanOrEqual(1);
                        expect(box.y).toBeLessThanOrEqual(1);
                        expect(box.width).toBeGreaterThanOrEqual(viewport.width - 2);
                        expect(box.height).toBeGreaterThanOrEqual(viewport.height - 2);
                    }
                } else {
                    await expect(page.getByTestId('onboarding-wizard-scrim')).toHaveCount(0);
                }
            }
        } catch (error) {
            const debugPath = `${suiteDir}/debug-openRoot-failure.png`;
            await page.screenshot({ path: debugPath, fullPage: true }).catch(() => {});
            const testIds = await page.evaluate(() => {
                return Array.from(document.querySelectorAll('[data-testid]'))
                    .map((node) => node.getAttribute('data-testid'))
                    .filter((value): value is string => Boolean(value))
                    .slice(0, 40);
            }).catch(() => []);
            // eslint-disable-next-line no-console
            console.error('[ui-e2e] openRoot failure', { url: page.url(), debugPath, testIds });
            throw error;
        }
    }

    async function advanceWizardToAuthEntry(page: Page, mode: 'guided' | 'skip', viewport: 'mobile' | 'desktop' = 'mobile') {
        await openRoot(page, viewport);

        if (await page.getByTestId('welcome-create-account').count()) {
            return;
        }

        if (mode === 'skip') {
            await expect(page.getByTestId('onboarding-wizard-skip')).toHaveCount(1, { timeout: 120_000 });
            return;
        }

        // First-launch may start on the welcome intro (no auth actions). Move forward to the auth entry.
        if (await page.getByTestId('onboarding-wizard-primary').count()) {
            await page.getByTestId('onboarding-wizard-primary').click();
            await expect(page.getByTestId('onboarding-wizard-relay-diagram')).toHaveCount(1, { timeout: 120_000 });
            await page.getByTestId('onboarding-wizard-primary').click();
        }

        await expect(page.getByTestId('welcome-create-account')).toHaveCount(1, { timeout: 120_000 });
    }

    async function openRootAndCreateAccount(
        page: Page,
        mode: 'guided' | 'skip' = 'guided',
        viewport: 'mobile' | 'desktop' = 'mobile',
        advanceIntoLocalSetup = true,
    ) {
        await advanceWizardToAuthEntry(page, mode, viewport);

        await page.getByTestId('welcome-create-account').click();

        await expect(page.getByTestId('setupWizard.surface')).toBeVisible({ timeout: 120_000 });

        if (advanceIntoLocalSetup && await page.getByTestId('setupWizard-branch:local').count()) {
            await page.getByTestId('setupWizard-branch:local').click();
            await page.getByTestId('setupWizard.surface-primary').click();
        }

        await expect(page.getByTestId('setupWizard-web-machine-setup-handoff')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('setupWizard-web-machine-setup-handoff-terminal')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('setupWizard-web-machine-setup-handoff-download-desktop')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('setupWizard-web-machine-setup-handoff-optional')).toHaveCount(1, { timeout: 120_000 });
    }

    async function openRootAndGoToRelaySelect(page: Page, viewport: 'mobile' | 'desktop' = 'mobile') {
        await openRoot(page, viewport);

        if (await page.getByTestId('onboarding-wizard-change-relay').count()) {
            await page.getByTestId('onboarding-wizard-change-relay').click();
        } else {
            await page.getByTestId('onboarding-wizard-primary').click();
        }

        await expect(page.getByTestId('onboarding-wizard-relay-diagram')).toHaveCount(1, { timeout: 120_000 });
    }

    test('web onboarding supports auth entry relay changes and back navigation', async ({ page }) => {
        test.setTimeout(300_000);
        await advanceWizardToAuthEntry(page, 'guided', 'mobile');
        await expect(page.getByTestId('onboarding-wizard-change-relay')).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId('onboarding-wizard-change-relay').click();
        await expect(page.getByTestId('onboarding-wizard-relay-diagram')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('onboarding-wizard-back')).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId('onboarding-wizard-back').click();

        await expect(page.getByTestId('welcome-create-account')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('onboarding-wizard-change-relay')).toHaveCount(1, { timeout: 120_000 });
    });

    test('web onboarding supports "On this computer" guided handoff', async ({ page }) => {
        test.setTimeout(300_000);
        await openRootAndGoToRelaySelect(page, 'mobile');
        await expect(page.getByTestId('onboarding-wizard-relay:thisComputer')).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId('onboarding-wizard-relay:thisComputer').click();
        await page.getByTestId('onboarding-wizard-primary').click();

        await expect(page.getByTestId('onboarding-wizard-desktop-handoff')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('onboarding-wizard-desktop-handoff-download-desktop')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('onboarding-wizard-desktop-handoff-terminal')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('onboarding-wizard-desktop-handoff-terminal-step-cli-install')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('onboarding-wizard-desktop-handoff-terminal-step-relay-install')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('onboarding-wizard-desktop-handoff-terminal-step-relay-status')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('onboarding-wizard-desktop-handoff-optional')).toHaveCount(1, { timeout: 120_000 });

        await page.getByTestId('onboarding-wizard-primary').click();
        await expect(page.getByTestId('onboarding-wizard-relay-url-input')).toHaveCount(1, { timeout: 120_000 });
    });

    test('web onboarding renders a full-viewport scrim on desktop viewports', async ({ page }) => {
        test.setTimeout(300_000);
        await openRoot(page, 'desktop');
        await expect(page.getByTestId('onboarding-wizard-scrim')).toBeVisible({ timeout: 120_000 });
        const viewport = page.viewportSize();
        const scrim = page.getByTestId('onboarding-wizard-scrim');
        const box = await scrim.boundingBox();
        expect(viewport).toBeTruthy();
        expect(box, 'expected onboarding wizard scrim to cover the viewport').toBeTruthy();
        if (viewport && box) {
            expect(box.x).toBeLessThanOrEqual(1);
            expect(box.y).toBeLessThanOrEqual(1);
            expect(box.width).toBeGreaterThanOrEqual(viewport.width - 2);
            expect(box.height).toBeGreaterThanOrEqual(viewport.height - 2);
        }
    });

    test('web onboarding remote relay-host handoff serializes split SSH fields and keeps code blocks scrollable', async ({ page }) => {
        test.setTimeout(300_000);
        await openRootAndCreateAccount(page, 'guided', 'desktop', false);

        if (!uiBaseUrl) throw new Error('missing ui base url');
        await gotoCommittedWithRetries(page, `${uiBaseUrl}/setup/wizard?step=setup_chooser`, 120_000);
        await expect(page.getByTestId('setupWizard.surface')).toBeVisible({ timeout: 120_000 });

        await expect(page.getByTestId('setupWizard-branch:remoteRelay')).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId('setupWizard-branch:remoteRelay').click();
        await page.getByTestId('setupWizard.surface-primary').click();

        await expect(page.getByTestId('setupWizard-web-remote-ssh-handoff')).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId('setupWizard-web-remote-ssh-sshUsernameInput').fill('very-long-admin-username');
        await page.getByTestId('setupWizard-web-remote-ssh-sshHostInput').fill('very-long-relay-host-name.example.internal');
        await page.getByTestId('setupWizard-web-remote-ssh-sshPortInput').fill('2200');
        await page.getByTestId('setupWizard-web-remote-ssh-sshAuthPassword').click();
        await page.getByTestId('setupWizard-web-remote-ssh-sshPasswordInput').fill('correct horse battery staple');

        const relayInstallCode = page.getByTestId('setupWizard-terminal-handoff-remote-ssh-setup');
        await expect(relayInstallCode).toBeVisible({ timeout: 120_000 });

        const commandText = await relayInstallCode.evaluate((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim());
        expect(commandText).toContain('happier machine setup --ssh');
        expect(commandText).toContain('--ssh-user very-long-admin-username');
        expect(commandText).toContain('--ssh-host very-long-relay-host-name.example.internal');
        expect(commandText).toContain('--ssh-auth password');
        expect(commandText).toContain('--ssh-port 2200');
        expect(commandText).toContain('--install-relay-runtime');

        const hasHorizontalOverflow = await relayInstallCode.evaluate((node) => {
            const element = node as HTMLElement;
            return element.scrollWidth > element.clientWidth;
        });
        expect(hasHorizontalOverflow).toBe(true);
    });

    test('web onboarding reaches the post-auth setup wizard after authentication', async ({ page }) => {
        test.setTimeout(300_000);
        await openRootAndCreateAccount(page, 'guided', 'mobile');
    });

    test('web onboarding renders the post-auth setup commands as scrollable code blocks', async ({ page }) => {
        test.setTimeout(300_000);
        await openRootAndCreateAccount(page, 'guided', 'mobile');

        const setupCode = page.getByTestId('setupWizard-web-machine-setup-handoff-terminal-setup');
        const overflowX = await setupCode.evaluate((node) => getComputedStyle(node as HTMLElement).overflowX);
        expect(['auto', 'scroll']).toContain(overflowX);
    });
});
