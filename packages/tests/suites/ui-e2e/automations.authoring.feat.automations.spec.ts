import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { createSessionFromNewSessionComposer } from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
import { openNewSessionMachineSelection } from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });

function resolveServerLightSqliteDbPath(params: Readonly<{ suiteDir: string }>): string {
    return resolve(join(params.suiteDir, 'server-light-data', 'happier-server-light.sqlite'));
}

function readLatestMachineIdFromServerLightDb(params: Readonly<{ suiteDir: string }>): string {
    const dbPath = resolveServerLightSqliteDbPath({ suiteDir: params.suiteDir });
    try {
        const raw = execFileSync('sqlite3', ['-json', dbPath, 'select id from Machine order by createdAt desc limit 1;'], {
            encoding: 'utf8',
        });
        const parsed = JSON.parse(raw) as Array<{ id?: unknown }>;
        const id = parsed?.[0]?.id;
        if (typeof id === 'string' && id.trim().length > 0) {
            return id.trim();
        }
    } catch {
        // pollers retry until the daemon has registered a machine
    }
    throw new Error(`Failed to read machine id from server light sqlite db: ${dbPath}`);
}

async function waitForLatestMachineId(params: Readonly<{ suiteDir: string; timeoutMs?: number }>): Promise<string> {
    const timeoutMs = params.timeoutMs ?? 60_000;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        try {
            return readLatestMachineIdFromServerLightDb({ suiteDir: params.suiteDir });
        } catch {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
        }
    }
    return readLatestMachineIdFromServerLightDb({ suiteDir: params.suiteDir });
}

async function ensureSwitchEnabled(toggle: Locator) {
    await expect(toggle).toHaveCount(1, { timeout: 60_000 });
    if ((await toggle.getAttribute('aria-checked')) !== 'true') {
        await toggle.click();
    }
    await expect(toggle).toHaveAttribute('aria-checked', 'true', { timeout: 30_000 });
}

async function enableAutomationsInSettings(params: Readonly<{ baseUrl: string; page: Page }>) {
    await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/settings/features?happier_hmr=0`, 180_000);
    await ensureSwitchEnabled(params.page.getByTestId('settings-feature-experiments-toggle'));
    await ensureSwitchEnabled(params.page.getByTestId('settings-feature-toggle-automations'));
}

async function selectMachineForNewSession(params: Readonly<{
    page: Page;
    uiBaseUrl: string;
    machineId: string;
}>) {
    await expect(params.page.getByTestId('agent-input-machine-chip')).toHaveCount(1, { timeout: 120_000 });
    await openNewSessionMachineSelection({ page: params.page, uiBaseUrl: params.uiBaseUrl });

    const exact = params.page.getByTestId(`new-session-machine:${params.machineId}`);
    if (await exact.count()) {
        await exact.click();
    } else {
        await params.page.locator('[data-testid^="new-session-machine:"]').first().click();
    }

    await params.page.waitForURL((url: URL) => url.pathname.endsWith('/new'), { timeout: 60_000 });
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
                HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '60000',
                HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '60000',
                HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '1000',
            },
        });

        ui = await startUiWeb({
            testDir: suiteDir,
            env: {
                ...process.env,
                EXPO_PUBLIC_DEBUG: '1',
                EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
                EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
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

        await page.getByTestId('welcome-create-account').click();
        await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

        const testDir = resolve(join(suiteDir, 't1-automations-authoring'));
        await mkdir(testDir, { recursive: true });

        const cliLogin: StartedCliTerminalConnect = await startCliAuthLoginForTerminalConnect({
            testDir,
            cliHomeDir,
            serverUrl: server.baseUrl,
            webappUrl: uiBaseUrl,
            env: {
                ...process.env,
                HOME: cliHomeDir,
                CI: '1',
                HAPPIER_DISABLE_CAFFEINATE: '1',
                HAPPIER_VARIANT: 'dev',
            },
        });

        await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
        await page.getByTestId('terminal-connect-approve').click();
        await cliLogin.waitForSuccess();
        await cliLogin.stop().catch(() => {});

        daemon = await startTestDaemon({
            testDir,
            happyHomeDir: cliHomeDir,
            env: {
                ...process.env,
                HOME: cliHomeDir,
                CI: '1',
                HAPPIER_HOME_DIR: cliHomeDir,
                HAPPIER_SERVER_URL: server.baseUrl,
                HAPPIER_WEBAPP_URL: uiBaseUrl,
                HAPPIER_DISABLE_CAFFEINATE: '1',
                HAPPIER_VARIANT: 'dev',
                HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
                HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
                HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
            },
        });

        const machineId = await waitForLatestMachineId({ suiteDir, timeoutMs: 120_000 });

        await enableAutomationsInSettings({ page, baseUrl: uiBaseUrl });

        const inlineAutomationName = `Inline automation ${run.runId}`;
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/new?automation=1&happier_hmr=0`, 180_000);
        await expect(page.getByTestId('session-authoring-automation-toggle-label')).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByRole('switch')).toBeChecked({ timeout: 60_000 });
        await selectMachineForNewSession({ page, uiBaseUrl, machineId });
        await page.locator('input[autocapitalize="words"]:visible').first().fill(inlineAutomationName);
        await page.getByTestId('new-session-composer-input').fill(`inline automation prompt ${run.runId}`);

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/new?happier_hmr=0`, 180_000);
        await expect(page.locator('input[autocapitalize="words"]:visible')).toHaveCount(0, { timeout: 60_000 });
        await expect(page.getByRole('switch')).not.toBeChecked({ timeout: 60_000 });

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/new?automation=1&happier_hmr=0`, 180_000);
        await expect(page.getByRole('switch')).toBeChecked({ timeout: 60_000 });
        await selectMachineForNewSession({ page, uiBaseUrl, machineId });
        await page.locator('input[autocapitalize="words"]:visible').first().fill(inlineAutomationName);
        await page.getByTestId('new-session-composer-input').fill(`inline automation prompt ${run.runId}`);
        await page.getByTestId('new-session-composer-input').press('Enter');
        await page.waitForURL((url) => url.pathname === '/automations', { timeout: 180_000 });
        await expect(page.getByText(inlineAutomationName)).toBeVisible({ timeout: 120_000 });

        const sessionId = await createSessionFromNewSessionComposer({
            page,
            uiBaseUrl,
            machineId,
            prompt: `session for automation ${run.runId}`,
        });
        await expect(page.getByText('FAKE_CLAUDE_OK_1')).toHaveCount(1, { timeout: 180_000 });

        const existingSessionAutomationName = `Existing automation ${run.runId}`;
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sessionId}/automations/new?happier_hmr=0`, 180_000);
        await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 60_000 });
        await page.locator('input[autocapitalize="words"]:visible').first().fill(existingSessionAutomationName);
        await page.getByTestId('session-composer-input').fill(`existing-session automation prompt ${run.runId}`);

        await page.getByTestId('agent-input-agent-chip').click();
        await expect(page.getByTestId('model-picker-overlay-option:claude-sonnet-4-6')).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId('model-picker-overlay-option:claude-sonnet-4-6').click();
        await page.getByTestId('agent-input-chip-picker.apply').click();

        await page.getByTestId('agent-input-permission-chip').click();
        await expect(page.getByTestId('agent-input-content-popover')).toHaveCount(1, { timeout: 60_000 });
        await page.getByTestId('agent-input-content-popover').getByText('YOLO', { exact: true }).last().click();
        await expect(page.getByTestId('agent-input-permission-chip')).toContainText('YOLO', { timeout: 60_000 });

        await page.getByTestId('session-composer-input').press('Enter');
        await page.waitForURL((url) => url.pathname === `/session/${sessionId}/automations`, { timeout: 180_000 });
        const createdExistingSessionAutomation = page.getByText(existingSessionAutomationName);
        await expect(createdExistingSessionAutomation).toBeVisible({ timeout: 120_000 });

        await createdExistingSessionAutomation.click();
        await page.waitForURL((url) => url.pathname.startsWith('/automations/'), { timeout: 180_000 });
        await page.getByRole('button', { name: 'Edit automation' }).click();
        await page.waitForURL((url) => url.pathname === '/automations/edit', { timeout: 180_000 });

        await expect(page.getByTestId('agent-input-permission-chip')).toContainText('YOLO', { timeout: 60_000 });
        await page.getByTestId('agent-input-agent-chip').click();
        await expect(page.getByText('Effective: claude-sonnet-4-6')).toBeVisible({ timeout: 60_000 });
    });
});
