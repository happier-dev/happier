import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { registerMachineIdentity } from '../../src/testkit/machineIdentity';
import { gotoCommittedWithRetries, normalizeLoopbackBaseUrl, waitForAuthenticatedHomeUi } from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });
const browserDiagnosticsByPage = new WeakMap<Page, () => string>();

function collectBrowserDiagnostics(page: Page): () => string {
    const pageConsole: string[] = [];
    const pageErrors: string[] = [];
    const requestFailures: string[] = [];
    const responseErrors: string[] = [];

    page.on('console', (message) => pageConsole.push(`[${message.type()}] ${message.text()}`));
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('requestfailed', (request) => {
        const failure = request.failure();
        requestFailures.push(`${request.method()} ${request.url()} ${failure ? `-> ${failure.errorText}` : ''}`.trim());
    });
    page.on('response', (response) => {
        if (response.status() >= 400) {
            responseErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
        }
    });

    return () => [
        '# Browser diagnostics',
        '',
        '## Console',
        '',
        pageConsole.length ? pageConsole.join('\n') : '(none)',
        '',
        '## Page errors',
        '',
        pageErrors.length ? pageErrors.join('\n') : '(none)',
        '',
        '## Request failures',
        '',
        requestFailures.length ? requestFailures.join('\n') : '(none)',
        '',
        '## Response errors',
        '',
        responseErrors.length ? responseErrors.join('\n') : '(none)',
        '',
    ].join('\n');
}

test.describe('ui e2e: web onboarding journey', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    const suiteDir = run.testDir('setup-onboarding-journey-web-suite');

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;

    const uiWebEnv = {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: '',
        EXPO_PUBLIC_HAPPIER_FEATURE_APP_UI_ONBOARDING_TOUR__ENABLED: '1',
        EXPO_PUBLIC_HAPPIER_BUILD_FEATURES_DENY: '',
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-journey`,
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

    test.beforeEach(async ({ page }) => {
        browserDiagnosticsByPage.set(page, collectBrowserDiagnostics(page));
    });

    test.afterEach(async ({ page }, testInfo) => {
        const readDiagnostics = browserDiagnosticsByPage.get(page);
        if (!readDiagnostics) return;
        await testInfo.attach('browser-diagnostics', {
            body: readDiagnostics(),
            contentType: 'text/plain',
        });
        browserDiagnosticsByPage.delete(page);
    });

    function deriveServerProfileIdForE2e(serverUrl: string): string {
        const url = new URL(serverUrl);
        const port = url.port ? `-${url.port}` : '';
        return `${url.hostname.toLowerCase()}${port}`.replace(/[^a-z0-9._-]/g, '_').replace(/_+/g, '_');
    }

    async function openRoot(page: Page) {
        if (!uiBaseUrl) throw new Error('missing ui base url');
        if (!server) throw new Error('missing server');
        const activeServerId = deriveServerProfileIdForE2e(server.baseUrl);
        await page.addInitScript((serverId) => {
            try {
                const marker = '__happier_e2e_journey_storage_cleared__=1';
                const name = typeof window.name === 'string' ? window.name : '';
                if (!name.includes(marker)) {
                    try { localStorage.clear(); } catch {}
                    try { sessionStorage.clear(); } catch {}
                    window.name = name ? `${name};${marker}` : marker;
                }
                try { sessionStorage.setItem('activeServerId', serverId); } catch {}
            } catch {
                // Best-effort only; continue even if storage is unavailable.
            }
        }, activeServerId);
        await page.setViewportSize({ width: 1100, height: 820 });
        await gotoCommittedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0&happier_wizard_step=relay_select`, 240_000);
        await expect(page.getByTestId('onboarding-journey')).toBeVisible({ timeout: 180_000 });
    }

    async function expectBeat(page: Page, beatId: string) {
        await expect(page.getByTestId(`onboarding-journey-desktop-current-beat:${beatId}`)).toHaveCount(1, { timeout: 120_000 });
    }

    async function clickJourneyPrimary(page: Page) {
        const primary = page.getByTestId('onboarding-journey-desktop-config-primary');
        await expect(primary).toBeVisible({ timeout: 120_000 });
        await expect(primary).toBeEnabled({ timeout: 120_000 });
        await primary.click();
    }

    async function clickJourneySkipToSetup(page: Page) {
        const skip = page.getByTestId('onboarding-journey-desktop-config-skip');
        await expect(skip).toBeVisible({ timeout: 120_000 });
        await expect(skip).toBeEnabled({ timeout: 120_000 });
        await skip.click();
    }

    async function advanceThroughActOne(page: Page) {
        const remainingActOneBeatIds = [
            'A2',
            'A4',
            'A6',
            'A7',
        ] as const;

        await expectBeat(page, 'A1');
        for (const beatId of remainingActOneBeatIds) {
            await clickJourneyPrimary(page);
            await expectBeat(page, beatId);
        }
        await clickJourneyPrimary(page);
        await expectBeat(page, 'S1');
    }

    function journeyCreateAccountAction(page: Page) {
        return page.getByTestId('welcome-primary-start')
            .or(page.getByTestId('welcome-create-account'))
            .first();
    }

    async function openS1RelaySelection(page: Page) {
        const relayRoute = page.getByTestId('relay-select-route-content');
        await expect(relayRoute).toBeVisible({ timeout: 120_000 });
    }

    async function advanceS1ToS2UsingE2eRelay(page: Page) {
        if (!server) throw new Error('missing server');
        const serverHost = new URL(server.baseUrl).host;

        await openS1RelaySelection(page);

        const profile = page.locator('[data-testid^="onboarding-wizard-relay:profile:"]')
            .filter({ hasText: serverHost })
            .first();
        if (await profile.count()) {
            await expect(profile).toBeVisible({ timeout: 120_000 });
            await profile.click();
            await clickJourneyPrimary(page);
        } else {
            const manualRelay = page.getByTestId('onboarding-wizard-relay:customUrl');
            await expect(manualRelay).toBeVisible({ timeout: 120_000 });
            await expect(manualRelay).toBeEnabled({ timeout: 120_000 });
            await manualRelay.click();
            await clickJourneyPrimary(page);

            const input = page.getByTestId('onboarding-wizard-relay-url-input');
            await expect(input).toBeVisible({ timeout: 120_000 });
            await input.fill(server.baseUrl);
            await clickJourneyPrimary(page);
        }

        await expectBeat(page, 'S2');
        await expect(journeyCreateAccountAction(page)).toBeVisible({ timeout: 120_000 });
        await expect(journeyCreateAccountAction(page)).toBeEnabled({ timeout: 120_000 });
    }

    async function readAuthTokenFromBrowserStorage(page: Page): Promise<string> {
        const token = await page.evaluate(() => {
            const credentials: Array<Readonly<{ key: string; token: string }>> = [];
            let activeServerId: string | null = window.sessionStorage?.getItem('activeServerId') ?? null;
            for (let index = 0; index < window.localStorage.length; index += 1) {
                const key = window.localStorage.key(index);
                if (!key) continue;
                const raw = window.localStorage.getItem(key);
                if (!raw) continue;
                if (key.includes('server-state-v1') && !activeServerId) {
                    try {
                        const parsed = JSON.parse(raw) as { activeServerId?: unknown };
                        activeServerId = typeof parsed.activeServerId === 'string' ? parsed.activeServerId : null;
                    } catch {
                        // Ignore malformed server state and keep scanning credentials.
                    }
                    continue;
                }
                if (key !== 'auth_credentials' && !key.startsWith('auth_credentials__srv_')) continue;
                try {
                    const parsed = JSON.parse(raw) as { token?: unknown };
                    const candidate = typeof parsed.token === 'string' && parsed.token.trim() ? parsed.token.trim() : '';
                    if (candidate) credentials.push({ key, token: candidate });
                } catch {
                    // Ignore malformed credential entries.
                }
            }
            if (credentials.length === 0) return null;
            if (!activeServerId) return credentials[credentials.length - 1]?.token ?? null;
            const expectedKeyFragment = `auth_credentials__srv_${activeServerId.toLowerCase()}`;
            for (let index = credentials.length - 1; index >= 0; index -= 1) {
                const entry = credentials[index];
                if (entry?.key.toLowerCase().includes(expectedKeyFragment)) return entry.token;
            }
            return credentials.find((entry) => entry.key === 'auth_credentials')?.token
                ?? credentials[credentials.length - 1]?.token
                ?? null;
        });

        if (typeof token === 'string' && token.trim()) return token.trim();
        throw new Error('Failed to read auth token from browser storage');
    }

    async function createAnonymousAccountAtS2(page: Page) {
        const createAccount = journeyCreateAccountAction(page);
        await expect(createAccount).toBeVisible({ timeout: 120_000 });
        await expect(createAccount).toBeEnabled({ timeout: 120_000 });
        await createAccount.click();
        await expect(page.getByTestId('onboarding-journey')).toBeVisible({ timeout: 120_000 });
    }

    async function registerArrivingMachine(page: Page) {
        if (!server) throw new Error('missing server');
        const token = await readAuthTokenFromBrowserStorage(page);
        const result = await registerMachineIdentity({
            baseUrl: server.baseUrl,
            token,
            machineId: `journey-e2e-${run.runId}`,
            daemonState: JSON.stringify({
                startedAt: Date.now(),
                active: true,
            }),
        });
        expect(result.status).toBe(200);
    }

    test('flag-on journey advances through setup, machine arrival, finale, and teardown', async ({ page }) => {
        test.setTimeout(420_000);
        await openRoot(page);

        await advanceThroughActOne(page);

        await advanceS1ToS2UsingE2eRelay(page);
        await createAnonymousAccountAtS2(page);
        await expectBeat(page, 'S3');
        await expect(page.getByTestId('setupWizard-machine-arrival')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('machine-arrival-card-status:variant:neutral')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('onboarding-journey-desktop-config-primary')).toBeDisabled({ timeout: 120_000 });

        await registerArrivingMachine(page);
        await expectBeat(page, 'S4');
        await clickJourneyPrimary(page);
        await expectBeat(page, 'S5');
        await clickJourneyPrimary(page);

        await expect(page.getByTestId('onboarding-journey')).toHaveCount(0, { timeout: 120_000 });
        await waitForAuthenticatedHomeUi({ page, timeoutMs: 120_000 });
        await expect(page.getByTestId('journey-demo-stage')).toHaveCount(0, { timeout: 30_000 });
    });

    test('skip-everything exits to the app and leaves setup re-entry available', async ({ page }) => {
        test.setTimeout(360_000);
        await openRoot(page);

        await expectBeat(page, 'A1');
        await clickJourneySkipToSetup(page);
        await expectBeat(page, 'S1');

        await advanceS1ToS2UsingE2eRelay(page);
        await createAnonymousAccountAtS2(page);
        await expectBeat(page, 'S3');

        const setupSkip = page.getByTestId('onboarding-journey-desktop-config-skip');
        await expect(setupSkip).toBeVisible({ timeout: 120_000 });
        await expect(setupSkip).toBeEnabled({ timeout: 120_000 });
        await setupSkip.click();

        await expect(page.getByTestId('onboarding-journey')).toHaveCount(0, { timeout: 120_000 });
        await waitForAuthenticatedHomeUi({ page, timeoutMs: 120_000 });
        await expect(page.getByTestId('sessions-empty-state-open-setup')).toBeVisible({ timeout: 120_000 });
    });
});
