import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { approveTerminalConnect } from '../../src/testkit/uiE2e/approveTerminalConnect';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';
import { setUiFeatureToggle } from '../../src/testkit/uiE2e/setUiFeatureToggle';
import {
    captureAuthBootstrapStorageSnapshot,
    installAuthBootstrapStorageSnapshot,
} from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';
import {
    createAccountAndReachConnectMachineState,
    gotoDomContentLoadedWithRetries,
    normalizeLoopbackBaseUrl,
} from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e' });

async function openHeaderActionMenuItem(page: Page, itemTestId: string): Promise<void> {
    const trigger = page.getByTestId('session-header-action-menu-trigger');
    await expect(trigger).toHaveCount(1, { timeout: 60_000 });
    await trigger.click({ force: true });
    const item = page.getByTestId(itemTestId);
    await expect(item).toHaveCount(1, { timeout: 60_000 });
    await item.click({ force: true });
}

async function expectSessionCockpitSurface(
    page: Page,
    sessionId: string,
    surface: 'chat' | 'browse' | 'git' | 'tabs' | 'terminal',
): Promise<void> {
    const surfaceExpectations: Record<typeof surface, readonly string[]> = {
        chat: ['session-composer-input', `session-cockpit-tabbar-${sessionId}`],
        browse: ['session-files-screen', 'repository-tree-toolbar', `session-cockpit-tabbar-${sessionId}`],
        git: ['session-git-screen', `session-cockpit-tabbar-${sessionId}`],
        tabs: ['session-details-screen', 'session-details-panel-root', `session-cockpit-tabbar-${sessionId}`],
        terminal: ['session-terminal-screen', `session-cockpit-tabbar-${sessionId}`],
    };

    for (const testId of surfaceExpectations[surface]) {
        await expect(page.getByTestId(testId).first()).toBeVisible({ timeout: 60_000 });
    }
}

test.describe('ui e2e: session mobile cockpit', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('session-mobile-cockpit-suite');
    const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let daemon: StartedDaemon | null = null;

    test.beforeAll(async () => {
        const uiWebEnv = {
            ...process.env,
            EXPO_PUBLIC_DEBUG: '1',
            EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
            HAPPIER_E2E_UI_WEB_MODE: 'export',
            HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS ?? '900000',
            HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS:
                process.env.HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS ?? '600000',
            HAPPIER_E2E_UI_WEB_EXPORT_FALLBACK_TO_METRO: '0',
            HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS:
                process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS ?? '480000',
        };
        test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
        await mkdir(cliHomeDir, { recursive: true });
        await writeFile(resolve(join(cliHomeDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');

        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
                HAPPIER_FEATURE_TERMINAL_EMBEDDED_PTY__ENABLED: '1',
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

    test.afterEach(async () => {
        await daemon?.stop().catch(() => {});
        daemon = null;
    });

    test.afterAll(async () => {
        test.setTimeout(120_000);
        await daemon?.stop().catch(() => {});
        await ui?.stop().catch(() => {});
        await server?.stop().catch(() => {});
    });

    test.afterEach(async () => {
        await daemon?.stop().catch(() => {});
        daemon = null;
    });

    test('enters cockpit from a classic session, switches surfaces, restores persisted cockpit state, and returns to classic', async ({ page }) => {
        test.setTimeout(540_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        await page.setViewportSize({ width: 390, height: 844 });
        await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
        await waitForInitialAppUi({ page, timeoutMs: 120_000 });
        await createAccountAndReachConnectMachineState({ page });
        const authBootstrapSnapshot = await captureAuthBootstrapStorageSnapshot(page);

        const testDir = resolve(join(suiteDir, 't1-mobile-cockpit'));
        await mkdir(testDir, { recursive: true });

        const cliLogin: StartedCliTerminalConnect = await startCliAuthLoginForTerminalConnect({
            testDir,
            cliHomeDir,
            serverUrl: server.baseUrl,
            webappUrl: uiBaseUrl,
            env: {
                ...process.env,
                CI: '1',
                HAPPIER_DISABLE_CAFFEINATE: '1',
                HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
                HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
                HAPPIER_VARIANT: 'dev',
            },
        });
        await installAuthBootstrapStorageSnapshot(page, authBootstrapSnapshot);
        await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
        await approveTerminalConnect({ page });
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
                HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: testDir,
                HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
                HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
                HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
                HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
                HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
            },
        });

        await setUiFeatureToggle({
            page,
            baseUrl: uiBaseUrl,
            featureId: 'terminal.embeddedPty',
            enabled: true,
        });

        const sessionId = await spawnSessionFromDaemon({ daemon, directory: testDir });

        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto(`${uiBaseUrl}/session/${sessionId}`, { waitUntil: 'domcontentloaded' });
        await expect(page).toHaveURL(new RegExp(`/session/${sessionId}$`), { timeout: 60_000 });
        await expect(page.getByTestId('session-header-action-menu-trigger')).toHaveCount(1, { timeout: 60_000 });

        await openHeaderActionMenuItem(page, 'dropdown-option-header_openMobileWorkspaceCockpit');
        await expectSessionCockpitSurface(page, sessionId, 'chat');

        await page.getByTestId('session-cockpit-tab-browse').click({ force: true });
        await expectSessionCockpitSurface(page, sessionId, 'browse');

        await page.getByTestId('session-cockpit-tab-git').click({ force: true });
        await expectSessionCockpitSurface(page, sessionId, 'git');

        await page.getByTestId('session-cockpit-tab-tabs').click({ force: true });
        await expectSessionCockpitSurface(page, sessionId, 'tabs');

        await page.getByTestId('session-cockpit-tab-terminal').click({ force: true });
        await expectSessionCockpitSurface(page, sessionId, 'terminal');

        await page.getByTestId('session-cockpit-tab-browse').click({ force: true });
        await expectSessionCockpitSurface(page, sessionId, 'browse');

        await page.goto(`${uiBaseUrl}/session/${sessionId}`, { waitUntil: 'domcontentloaded' });
        await expect(page).toHaveURL(new RegExp(`/session/${sessionId}$`), { timeout: 60_000 });
        await expect(page.getByTestId(`session-cockpit-tabbar-${sessionId}`)).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByTestId('repository-tree-toolbar')).toHaveCount(1, { timeout: 60_000 });

        await page.goto(`${uiBaseUrl}/session/${sessionId}/details`, { waitUntil: 'domcontentloaded' });
        await expectSessionCockpitSurface(page, sessionId, 'tabs');

        await page.goto(`${uiBaseUrl}/session/${sessionId}/git`, { waitUntil: 'domcontentloaded' });
        await expectSessionCockpitSurface(page, sessionId, 'git');

        await page.goto(`${uiBaseUrl}/session/${sessionId}/terminal`, { waitUntil: 'domcontentloaded' });
        await expectSessionCockpitSurface(page, sessionId, 'terminal');

        await page.getByTestId('session-cockpit-tab-chat').click({ force: true });
        await expectSessionCockpitSurface(page, sessionId, 'chat');

        await openHeaderActionMenuItem(page, 'dropdown-option-header_openMobileWorkspaceClassic');
        await expect(page).toHaveURL(new RegExp(`/session/${sessionId}$`), { timeout: 60_000 });
        await expect(page.getByTestId(`session-cockpit-tabbar-${sessionId}`)).toHaveCount(0, { timeout: 60_000 });
    });

    test('persists the last session cockpit surface and keeps legacy subroutes compatible', async ({ page }) => {
        test.setTimeout(540_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        await page.setViewportSize({ width: 390, height: 844 });
        await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
        await waitForInitialAppUi({ page, timeoutMs: 120_000 });
        await createAccountAndReachConnectMachineState({ page });
        const authBootstrapSnapshot = await captureAuthBootstrapStorageSnapshot(page);

        const testDir = resolve(join(suiteDir, 't2-mobile-cockpit-persistence'));
        await mkdir(testDir, { recursive: true });

        const cliLogin: StartedCliTerminalConnect = await startCliAuthLoginForTerminalConnect({
            testDir,
            cliHomeDir,
            serverUrl: server.baseUrl,
            webappUrl: uiBaseUrl,
            env: {
                ...process.env,
                CI: '1',
                HAPPIER_DISABLE_CAFFEINATE: '1',
                HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
                HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
                HAPPIER_VARIANT: 'dev',
            },
        });
        await installAuthBootstrapStorageSnapshot(page, authBootstrapSnapshot);
        await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
        await approveTerminalConnect({ page });
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
                HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: testDir,
                HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
                HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}-persist`,
                HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}-persist`,
                HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
                HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
            },
        });

        await setUiFeatureToggle({
            page,
            baseUrl: uiBaseUrl,
            featureId: 'terminal.embeddedPty',
            enabled: true,
        });

        const sessionId = await spawnSessionFromDaemon({ daemon, directory: testDir });

        await page.goto(`${uiBaseUrl}/session/${sessionId}`, { waitUntil: 'domcontentloaded' });
        await openHeaderActionMenuItem(page, 'dropdown-option-header_openMobileWorkspaceCockpit');
        await expectSessionCockpitSurface(page, sessionId, 'chat');

        await page.getByTestId('session-cockpit-tab-terminal').click({ force: true });
        await expectSessionCockpitSurface(page, sessionId, 'terminal');

        await page.goto(`${uiBaseUrl}/session/${sessionId}`, { waitUntil: 'domcontentloaded' });
        await expect(page).toHaveURL(new RegExp(`/session/${sessionId}$`), { timeout: 60_000 });
        await expect(page.getByTestId(`session-cockpit-tabbar-${sessionId}`)).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByTestId('session-rightpanel-terminal-xterm')).toHaveCount(1, { timeout: 60_000 });

        await page.goto(`${uiBaseUrl}/session/${sessionId}/files`, { waitUntil: 'domcontentloaded' });
        await expect(page).toHaveURL(new RegExp(`/session/${sessionId}/files$`), { timeout: 60_000 });
        await expectSessionCockpitSurface(page, sessionId, 'browse');

        await page.goto(`${uiBaseUrl}/session/${sessionId}/git`, { waitUntil: 'domcontentloaded' });
        await expect(page).toHaveURL(new RegExp(`/session/${sessionId}/git$`), { timeout: 60_000 });
        await expectSessionCockpitSurface(page, sessionId, 'git');

        await page.goto(`${uiBaseUrl}/session/${sessionId}/terminal`, { waitUntil: 'domcontentloaded' });
        await expect(page).toHaveURL(new RegExp(`/session/${sessionId}/terminal$`), { timeout: 60_000 });
        await expectSessionCockpitSurface(page, sessionId, 'terminal');
    });
});
