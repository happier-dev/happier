import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { navigateSpa } from '../../src/testkit/uiE2e/fakeTauriDesktop';
import { gotoCommittedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: web onboarding wizard', () => {
    test.describe.configure({ mode: 'serial' });
    // Ensure this suite always starts unauthenticated and never wipes auth mid-test via ad-hoc storage clears.
    test.use({ storageState: { cookies: [], origins: [] } });

    const suiteDir = run.testDir('setup-onboarding-wizard-web-suite');

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;

    const uiWebEnv = {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: '',
        EXPO_PUBLIC_HAPPIER_FEATURE_APP_UI_ONBOARDING_TOUR__ENABLED: '0',
        EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY: 'app.ui.onboardingTour',
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
                NODE_ENV: process.env.NODE_ENV ?? 'test',
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

        // Clear per-tab browser storage once (per test page) so first-launch wizard state is deterministic,
        // without risking auth/session data being wiped on later navigations inside the same test.
        await page.addInitScript(() => {
            try {
                const marker = '__happier_e2e_storage_cleared__=1';
                const name = typeof window.name === 'string' ? window.name : '';
                if (!name.includes(marker)) {
                    try { localStorage.clear(); } catch {}
                    try { sessionStorage.clear(); } catch {}
                    window.name = name ? `${name};${marker}` : marker;
                }
            } catch {
                // Best-effort only; continue even if storage is unavailable.
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
            const brandGetStarted = page.locator('[data-testid="brand-hero-get-started"]:visible').first();
            const wizard = page.getByTestId('onboarding-wizard');
            await expect(wizard.or(brandGetStarted)).toBeVisible({ timeout: 180_000 });
            if (await brandGetStarted.isVisible().catch(() => false)) {
                await expect(brandGetStarted).toBeEnabled({ timeout: 120_000 });
                await brandGetStarted.click();
            }
            await expect(wizard).toBeVisible({ timeout: 180_000 });
            const size = page.viewportSize();
            if (size) {
                // Desktop viewports: wizard renders as a centered card within a modal (backdrop handled by BaseModal).
                // Phone-sized viewports may vary (safe areas, scroll host, embedded chrome), so avoid brittle geometry asserts.
                const box = await wizard.boundingBox();
                expect(box, 'expected onboarding wizard to have a bounding box').toBeTruthy();
                if (box) {
                    if (size.width > 430) {
                        expect(box.width).toBeLessThan(size.width - 40);
                        expect(box.height).toBeLessThanOrEqual(size.height);
                        expect(box.x).toBeGreaterThan(10);
                    }
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

        void mode;
        await expect(page.getByTestId('welcome-primary-start')).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId('welcome-secondary-login')).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId('welcome-footer-relay-action')).toBeVisible({ timeout: 120_000 });
    }

    async function openRootAndCreateAccount(
        page: Page,
        mode: 'guided' | 'skip' = 'guided',
        viewport: 'mobile' | 'desktop' = 'mobile',
        advanceIntoLocalSetup = true,
    ) {
        await advanceWizardToAuthEntry(page, mode, viewport);

        const createAccount = page.getByTestId('welcome-primary-start');
        await expect(createAccount).toBeVisible({ timeout: 120_000 });
        await expect(createAccount).toBeEnabled({ timeout: 120_000 });
        await createAccount.click();

        await expect(page.getByTestId('setupWizard.surface')).toBeVisible({ timeout: 120_000 });

        if (advanceIntoLocalSetup) {
            const localBranch = page.getByTestId('setupWizard-branch:local');
            const handoff = page.getByTestId('setupWizard-machine-arrival-stack');
            await expect(localBranch.or(handoff)).toBeVisible({ timeout: 120_000 });
            if (await handoff.isVisible()) {
                // Already on the local handoff surface.
            } else {
                await localBranch.click();
                const primary = page.getByTestId('setupWizard.surface-primary');
                await expect(primary).toBeEnabled({ timeout: 120_000 });
                await primary.click();
            }
        }

        await expect(page.getByTestId('setupWizard-machine-arrival-stack')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('setupWizard-machine-arrival')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('machine-arrival-card-status:variant:neutral')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('setupWizard-machine-arrival-desktop-app-download-cta')).toHaveCount(1, { timeout: 120_000 });
    }

    async function openRootAndGoToRelaySelect(page: Page, viewport: 'mobile' | 'desktop' = 'mobile') {
        await openRoot(page, viewport);

        const changeRelay = page.getByTestId('welcome-footer-relay-action');
        await expect(changeRelay).toBeVisible({ timeout: 120_000 });
        await expect(changeRelay).toBeEnabled({ timeout: 120_000 });
        await changeRelay.click();

        await expect(page.getByTestId('onboarding-wizard-relay:thisComputer')).toHaveCount(1, { timeout: 120_000 });
    }

    test('web onboarding supports auth entry relay changes and back navigation', async ({ page }) => {
        test.setTimeout(300_000);
        await advanceWizardToAuthEntry(page, 'guided', 'mobile');
        await expect(page.getByTestId('welcome-footer-relay-action')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('welcome-footer-relay-action')).toBeEnabled({ timeout: 120_000 });
        await page.getByTestId('welcome-footer-relay-action').click();
        await expect(page.getByTestId('onboarding-wizard-relay:thisComputer')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('unauth-shell-back-chevron')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('unauth-shell-back-chevron')).toBeEnabled({ timeout: 120_000 });
        await page.getByTestId('unauth-shell-back-chevron').click();

        await expect(page.getByTestId('welcome-primary-start')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('welcome-footer-relay-action')).toHaveCount(1, { timeout: 120_000 });
    });

    test('web onboarding supports "On this computer" guided handoff', async ({ page }) => {
        test.setTimeout(300_000);
        await openRootAndGoToRelaySelect(page, 'mobile');
        await expect(page.getByTestId('onboarding-wizard-relay:thisComputer')).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId('onboarding-wizard-relay:thisComputer').click();
        await expect(page.getByTestId('onboarding-wizard-primary')).toBeEnabled({ timeout: 120_000 });
        await page.getByTestId('onboarding-wizard-primary').click();

        await expect(page.getByTestId('onboarding-wizard-desktop-handoff')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('onboarding-wizard-desktop-handoff-terminal')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('onboarding-wizard-desktop-handoff-terminal-step-relay-setup')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('onboarding-wizard-desktop-handoff-download-desktop')).toHaveCount(1, { timeout: 120_000 });

        await expect(page.getByTestId('onboarding-wizard-primary')).toBeEnabled({ timeout: 120_000 });
        await page.getByTestId('onboarding-wizard-primary').click();
        await expect(page.getByTestId('onboarding-wizard-relay-url-input')).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId('onboarding-wizard-relay-url-input').fill(server?.baseUrl ?? '');
        await expect(page.getByTestId('onboarding-wizard-primary')).toBeEnabled({ timeout: 120_000 });
        await page.getByTestId('onboarding-wizard-primary').click();
        await expect(page.getByTestId('onboarding-wizard-background-service-handoff')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('onboarding-wizard-background-service-arrival')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('onboarding-wizard-background-service-desktop-app-download-cta')).toHaveCount(1, { timeout: 120_000 });
    });

    test('web onboarding renders a centered modal card on desktop viewports', async ({ page }) => {
        test.setTimeout(300_000);
        await openRoot(page, 'desktop');
        const wizard = page.getByTestId('onboarding-wizard');
        const viewport = page.viewportSize();
        const box = await wizard.boundingBox();
        expect(viewport).toBeTruthy();
        expect(box, 'expected onboarding wizard to render as a centered card on desktop').toBeTruthy();
        if (viewport && box) {
            expect(box.width).toBeLessThan(viewport.width - 40);
            expect(box.x).toBeGreaterThan(10);
        }
    });

    test('web onboarding surfaces unreachable relay state and returns to relay selection to reconfigure', async ({ page }) => {
        test.setTimeout(300_000);
        await openRootAndGoToRelaySelect(page, 'mobile');

        await expect(page.getByTestId('onboarding-wizard-relay:customUrl')).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId('onboarding-wizard-relay:customUrl').click();
        await expect(page.getByTestId('onboarding-wizard-primary')).toBeEnabled({ timeout: 120_000 });
        await page.getByTestId('onboarding-wizard-primary').click();

        const urlInput = page.getByTestId('onboarding-wizard-relay-url-input');
        await expect(urlInput).toBeVisible({ timeout: 120_000 });
        await urlInput.fill('http://127.0.0.1:59999');

        await expect(page.getByTestId('onboarding-wizard-primary')).toBeEnabled({ timeout: 120_000 });
        await page.getByTestId('onboarding-wizard-primary').click();

        await expect(page.getByTestId('welcome-server-unavailable')).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId('welcome-configure-server')).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId('welcome-retry-server')).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId('onboarding-wizard-relay-hint-line')).toContainText('127.0.0.1:59999', { timeout: 120_000 });

        await page.getByTestId('welcome-configure-server').click();
        await expect(page.getByTestId('onboarding-wizard-relay:thisComputer')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('onboarding-wizard-primary')).toBeDisabled({ timeout: 120_000 });
    });

    test('web onboarding login with secret key instead navigates within the wizard', async ({ page }) => {
        test.setTimeout(300_000);
        await advanceWizardToAuthEntry(page, 'guided', 'mobile');

        const loginWithMobile = page.getByTestId('welcome-secondary-login');
        await expect(loginWithMobile).toBeVisible({ timeout: 120_000 });
        await expect(loginWithMobile).toBeEnabled({ timeout: 120_000 });
        await loginWithMobile.click();

        const openManual = page.getByTestId('restore-open-manual');
        await expect(openManual).toBeVisible({ timeout: 120_000 });
        await expect(openManual).toBeEnabled({ timeout: 120_000 });
        await openManual.click();

        await expect(page.getByTestId('restore-manual-secret-input')).toBeVisible({ timeout: 120_000 });
        await expect(page.getByTestId('restore-open-manual')).toHaveCount(0, { timeout: 120_000 });
    });

    test('web onboarding remote relay-host handoff serializes split SSH fields and keeps code blocks scrollable', async ({ page }) => {
        test.setTimeout(300_000);
        await openRootAndCreateAccount(page, 'guided', 'desktop', false);

        await navigateSpa(page, '/setup/wizard?step=setup_chooser');
        await expect(page.getByTestId('setupWizard.surface')).toBeVisible({ timeout: 120_000 });

        await expect(page.getByTestId('setupWizard-branch:remoteRelay')).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId('setupWizard-branch:remoteRelay').click();
        await expect(page.getByTestId('setupWizard.surface-primary')).toBeEnabled({ timeout: 120_000 });
        await page.getByTestId('setupWizard.surface-primary').click();

        await expect(page.getByTestId('setupWizard-web-remote-ssh')).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId('setupWizard-web-remote-ssh-sshUsernameInput').fill('very-long-admin-username');
        await page.getByTestId('setupWizard-web-remote-ssh-sshHostInput').fill('very-long-relay-host-name.example.internal');
        await page.getByTestId('setupWizard-web-remote-ssh-sshPortInput').fill('2200');
        await page.getByTestId('setupWizard-web-remote-ssh-sshAuthMethod:password').click();
        await page.getByTestId('setupWizard-web-remote-ssh-sshPasswordInput').fill('correct horse battery staple');

        await expect(page.getByTestId('setupWizard-terminal-handoff-step-remote-ssh-setup')).toBeVisible({ timeout: 120_000 });
        const relayInstallCode = page.getByTestId('setupWizard-terminal-handoff-remote-ssh-setup');
        await expect(relayInstallCode).toBeVisible({ timeout: 120_000 });

        const commandText = await relayInstallCode.evaluate((node) => (node.textContent ?? '').replace(/\s+/g, ' ').trim());
        expect(commandText).toContain('machine setup');
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

        const setupCode = page.getByTestId('machine-arrival-card-command-setup');
        const overflowX = await setupCode.evaluate((node) => getComputedStyle(node as HTMLElement).overflowX);
        expect(['auto', 'scroll']).toContain(overflowX);
    });
});
