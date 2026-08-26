import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { createSessionFromNewSessionComposer, openNewSessionMachineSelection } from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { enableEnhancedSessionWizard } from '../../src/testkit/uiE2e/enableEnhancedSessionWizard';

const run = createRunDirs({ runLabel: 'ui-e2e' });

function getVisibleSessionComposer(page: Page) {
    return page.locator('[data-testid="session-composer-input"]:visible');
}

async function clickLocatorWithFallback(locator: Locator): Promise<void> {
    try {
        await locator.click({ timeout: 15_000 });
    } catch {
        await locator.click({ timeout: 15_000, force: true });
    }
}

async function ensureSwitchEnabled(toggle: Locator) {
    await expect(toggle).toHaveCount(1, { timeout: 60_000 });
    if ((await toggle.getAttribute('aria-checked')) !== 'true') {
        await toggle.click();
    }
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
}

async function enableAutomationsInSettings(params: Readonly<{ baseUrl: string; page: Page }>) {
    await enableEnhancedSessionWizard({ page: params.page, baseUrl: params.baseUrl, timeoutMs: 180_000 });
    await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/settings/features?happier_hmr=0`, 180_000);
    await ensureSwitchEnabled(params.page.getByTestId('settings-feature-experiments-toggle'));
    await ensureSwitchEnabled(params.page.getByTestId('settings-feature-toggle-automations'));
}

async function selectMachineForNewSession(params: Readonly<{
    page: Page;
    uiBaseUrl: string;
    machineId: string;
}>) {
    const selectionResult = await openNewSessionMachineSelection({ page: params.page, uiBaseUrl: params.uiBaseUrl });

    if (selectionResult === 'picker_open') {
        const exact = params.page.locator(
            `[data-testid="new-session-machine:${params.machineId}"], [data-testid="new-session-machine-option:${params.machineId}"]`,
        );
        const anyOption = params.page.locator(
            '[data-testid^="new-session-machine:"], [data-testid^="new-session-machine-option:"]',
        );

        await expect.poll(async () => await anyOption.count(), { timeout: 120_000 }).toBeGreaterThan(0);
        if (await exact.count()) {
            await clickLocatorWithFallback(exact.first());
        } else {
            await clickLocatorWithFallback(anyOption.first());
        }
    }

    await params.page.waitForURL((url: URL) => url.pathname.endsWith('/new'), { timeout: 60_000 });
    await expect(params.page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 180_000 });
}

async function readAuthTokenFromBrowserStorage(page: Page): Promise<string> {
    const token = await page.evaluate(() => {
        for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (!key?.startsWith('auth_credentials')) continue;
            const raw = localStorage.getItem(key);
            if (!raw) continue;
            try {
                const parsed = JSON.parse(raw) as { token?: unknown };
                if (typeof parsed.token === 'string' && parsed.token.trim()) {
                    return parsed.token.trim();
                }
            } catch {
                // ignore malformed storage entries and keep scanning
            }
        }
        return null;
    });

    if (typeof token === 'string' && token.trim()) {
        return token.trim();
    }
    throw new Error('Failed to read auth token from browser storage');
}

async function readMachineIdFromCliAuthLoginStdout(stdoutPath: string): Promise<string> {
    const stdout = (await readFile(stdoutPath, 'utf8')).replaceAll(/\u001b\[[0-9;]*m/g, '');
    const match = stdout.match(/Machine ID:\s*([^\s]+)/);
    if (match?.[1]) {
        return match[1].trim();
    }
    throw new Error(`Failed to read machine id from CLI auth login stdout: ${stdoutPath}`);
}

async function getJson<T>(params: Readonly<{
    baseUrl: string;
    token: string;
    path: string;
}>): Promise<T> {
    const response = await fetch(`${params.baseUrl}${params.path}`, {
        headers: {
            Authorization: `Bearer ${params.token}`,
        },
    });

    const payload = await response.json().catch(() => null);
    if (!response.ok) {
        throw new Error(`Request failed (${response.status}) ${params.path}: ${JSON.stringify(payload)}`);
    }
    return payload as T;
}

async function expectPersistedAutomation(params: Readonly<{
    baseUrl: string;
    token: string;
    name: string;
    targetType: 'new_session' | 'existing_session';
}>) {
    await expect.poll(async () => {
        const automations = await getJson<ReadonlyArray<Readonly<{
            name: string;
            targetType: string;
        }>>>({
            baseUrl: params.baseUrl,
            token: params.token,
            path: '/v2/automations',
        });
        return automations.find((automation) => automation.name === params.name) ?? null;
    }, { timeout: 60_000 }).toMatchObject({
        name: params.name,
        targetType: params.targetType,
    });
}

async function submitAutomationViaComposer(params: Readonly<{
    page: Page;
    testId: 'new-session-composer-send' | 'session-composer-send';
    expectedPathname: string;
}>) {
    const submit = params.page.getByTestId(params.testId);
    await expect(submit).toBeEnabled({ timeout: 60_000 });

    const [response] = await Promise.all([
        params.page.waitForResponse((candidate) => {
            try {
                return candidate.request().method() === 'POST'
                    && new URL(candidate.url()).pathname === '/v2/automations';
            } catch {
                return false;
            }
        }, { timeout: 60_000 }),
        params.page.waitForURL((url) => url.pathname === params.expectedPathname, { timeout: 60_000 }),
        submit.click(),
    ]);

    expect(response.ok()).toBe(true);
}

test.describe('ui e2e: automations authoring', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('automations-authoring-suite');
    const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let daemon: StartedDaemon | null = null;

    test.beforeAll(async () => {
        test.setTimeout(900_000);
        await mkdir(cliHomeDir, { recursive: true });
        await writeFile(resolve(join(cliHomeDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');

        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
                HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '900000',
                HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '900000',
                HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '1000',
            },
        });

        const uiWebEnv = {
            ...process.env,
            EXPO_PUBLIC_DEBUG: '1',
            EXPO_PUBLIC_HAPPY_SERVER_URL: '',
            EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
            HAPPIER_E2E_UI_WEB_MODE: 'metro',
            HAPPIER_E2E_UI_WEB_NO_DEV: '0',
            HAPPIER_E2E_UI_WEB_BASE_URL_TIMEOUT_MS: '600000',
            HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: '900000',
        };

        test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
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
        await daemon?.stop().catch(() => {});
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    });

    test('creates automations from the inline /new flow and the existing-session authoring flow', async ({ page }) => {
        test.setTimeout(900_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
        await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });

        const testDir = resolve(join(suiteDir, 't1-automations-authoring'));
        await mkdir(testDir, { recursive: true });

        daemon = await authenticateAndStartDaemon({
            page,
            testDir,
            cliHomeDir,
            serverUrl: server.baseUrl,
            uiBaseUrl,
            createAccount: false,
            extraEnv: {
                HOME: cliHomeDir,
            },
        });

        await page.goto(uiBaseUrl, { waitUntil: 'domcontentloaded' });
        const authToken = await readAuthTokenFromBrowserStorage(page);
        const machineId = await readMachineIdFromCliAuthLoginStdout(resolve(join(testDir, 'cli.auth.login.stdout.log')));

        await enableAutomationsInSettings({ page, baseUrl: uiBaseUrl });

        const inlineAutomationName = `Inline automation ${run.runId}`;
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/new?automation=1&happier_hmr=0`, 180_000);
        await selectMachineForNewSession({ page, uiBaseUrl, machineId });
        await expect(page.getByTestId('new-session-automation-chip')).toHaveCount(1, { timeout: 60_000 });
        await page.getByTestId('new-session-automation-chip').click();
        await expect(page.getByTestId('session-authoring-automation-toggle-label')).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByRole('switch')).toBeChecked({ timeout: 60_000 });
        await page.getByTestId('automation-sentence-name-input').first().fill(inlineAutomationName);
        await page.getByTestId('new-session-composer-input').fill(`inline automation prompt ${run.runId}`);

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/new?happier_hmr=0`, 180_000);
        await expect(page.getByTestId('automation-sentence-name-input')).toHaveCount(0, { timeout: 60_000 });
        await expect(page.getByTestId('new-session-automation-chip')).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByTestId('session-authoring-automation-toggle-label')).toHaveCount(0, { timeout: 60_000 });

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/new?automation=1&happier_hmr=0`, 180_000);
        await selectMachineForNewSession({ page, uiBaseUrl, machineId });
        await expect(page.getByTestId('new-session-automation-chip')).toHaveCount(1, { timeout: 60_000 });
        await page.getByTestId('new-session-automation-chip').click();
        await expect(page.getByTestId('session-authoring-automation-toggle-label')).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByRole('switch')).toBeChecked({ timeout: 60_000 });
        await page.getByTestId('automation-sentence-name-input').first().fill(inlineAutomationName);
        await page.getByTestId('new-session-composer-input').fill(`inline automation prompt ${run.runId}`);
        await submitAutomationViaComposer({
            page,
            testId: 'new-session-composer-send',
            expectedPathname: '/automations',
        });
        await expectPersistedAutomation({
            baseUrl: server.baseUrl,
            token: authToken,
            name: inlineAutomationName,
            targetType: 'new_session',
        });

        const session = await createSessionFromNewSessionComposer({
            page,
            uiBaseUrl,
            machineId,
            prompt: `session for automation ${run.runId}`,
        });
        const { sessionId } = session;

        const existingSessionAutomationName = `Existing automation ${run.runId}`;
        const automationAuthoringUrl = new URL(session.sessionHref);
        automationAuthoringUrl.pathname = `${automationAuthoringUrl.pathname}/automations/new`;
        automationAuthoringUrl.searchParams.set('happier_hmr', '0');
        await gotoDomContentLoadedWithRetries(page, automationAuthoringUrl.toString(), 180_000);
        await expect(getVisibleSessionComposer(page)).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByTestId('automation-sentence-name-input')).toHaveCount(0, { timeout: 60_000 });
        await page.getByTestId('new-session-automation-chip').click();
        await expect(page.getByTestId('automation-sentence-name-input')).toHaveCount(1, { timeout: 60_000 });
        await page.getByTestId('automation-sentence-name-input').fill(existingSessionAutomationName);
        await getVisibleSessionComposer(page).fill(`existing-session automation prompt ${run.runId}`);
        await submitAutomationViaComposer({
            page,
            testId: 'session-composer-send',
            expectedPathname: `/session/${sessionId}/automations`,
        });
        await expectPersistedAutomation({
            baseUrl: server.baseUrl,
            token: authToken,
            name: existingSessionAutomationName,
            targetType: 'existing_session',
        });
    });
});
