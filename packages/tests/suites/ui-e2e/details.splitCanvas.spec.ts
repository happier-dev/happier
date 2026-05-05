import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { createGitRepoWithChanges } from '../../src/testkit/uiE2e/gitRepoFixtures';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { createAccountAndReachConnectMachineState, gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { approveTerminalConnect } from '../../src/testkit/uiE2e/approveTerminalConnect';
import { ensurePendingTerminalConnectReadyForApproval } from '../../src/testkit/uiE2e/terminalConnectApprovalFlow';
import { resolveTerminalConnectUrlForBrowser } from '../../src/testkit/uiE2e/resolveTerminalConnectUrlForBrowser';

const run = createRunDirs({ runLabel: 'ui-e2e' });

async function selectWorkspacePathFromPathBrowserModal(page: Page, absolutePath: string): Promise<void> {
    const modal = page.getByTestId('path-browser-modal');
    await expect(modal).toHaveCount(1, { timeout: 120_000 });

    const normalizedPath = absolutePath.replace(/\\/g, '/').replace(/\/+$/g, '');
    if (normalizedPath.startsWith('/')) {
        const segments = normalizedPath.split('/').filter(Boolean);
        let current = '';
        for (const segment of segments.slice(0, Math.max(0, segments.length - 1))) {
            current += `/${segment}`;
            const toggle = page.getByTestId(`path-browser-toggle:${current}`);
            if (await toggle.count()) {
                await toggle.first().click({ force: true });
            }
        }
    }

    const targetRow = page.getByTestId(`path-browser-row:${absolutePath}`).first();
    await expect(targetRow).toHaveCount(1, { timeout: 60_000 });
    await targetRow.click({ force: true });

    const confirmButton = page.getByTestId('path-browser-confirm').first();
    await expect(confirmButton).toBeEnabled({ timeout: 30_000 });
    await confirmButton.click({ force: true });

    await expect(page.getByTestId('path-browser-modal')).toHaveCount(0, { timeout: 60_000 });
}

function parseWorkspaceRefIdFromProjectsUrl(url: string): string | null {
    try {
        const pathname = new URL(url).pathname;
        const parts = pathname.split('/').filter(Boolean);
        const idx = parts.indexOf('projects');
        const candidate = idx >= 0 ? parts[idx + 1] : null;
        const decoded = candidate ? decodeURIComponent(candidate) : '';
        return decoded && decoded.length > 0 ? decoded : null;
    } catch {
        return null;
    }
}

function splitCanvasLeafFrames(scope: Page | ReturnType<Page['getByTestId']>) {
    return scope.locator('[data-testid^="split-canvas-leaf-frame-"]');
}

function splitCanvasLeafCloseButtons(scope: Page | ReturnType<Page['getByTestId']>) {
    return scope.locator('[data-testid^="split-canvas-leaf-close-"]');
}

function splitCanvasLeafMaximizeButtons(scope: Page | ReturnType<Page['getByTestId']>) {
    return scope.locator('[data-testid^="split-canvas-leaf-maximize-"]');
}

function splitCanvasFocusRings(scope: Page | ReturnType<Page['getByTestId']>) {
    return scope.locator('[data-testid^="split-canvas-focus-ring-"]');
}

async function approveCliTerminalConnect(params: Readonly<{
    page: Page;
    cliLogin: Awaited<ReturnType<typeof startCliAuthLoginForTerminalConnect>>;
    uiBaseUrl: string;
    serverUrl: string;
}>) {
    const connectUrlForBrowser = resolveTerminalConnectUrlForBrowser({
        connectUrl: params.cliLogin.connectUrl,
        uiBaseUrl: params.uiBaseUrl,
        serverUrl: params.serverUrl,
    });
    await gotoDomContentLoadedWithRetries(params.page, connectUrlForBrowser, 180_000);
    await ensurePendingTerminalConnectReadyForApproval({
        page: params.page,
        connectUrlForBrowser,
        gotoConnectUrl: async (url) => {
            await gotoDomContentLoadedWithRetries(params.page, url, 180_000);
        },
        restoreAccount: async () => {
            await createAccountAndReachConnectMachineState({ page: params.page });
        },
        timeoutMs: 180_000,
    });
    await approveTerminalConnect({ page: params.page });
    await params.cliLogin.waitForSuccess();
}

async function splitFocusedDetailsLeafToTheRight(scope: ReturnType<Page['getByTestId']>, page: Page): Promise<void> {
    await scope.locator('[data-testid^="split-canvas-leaf-interaction-surface-"]').first().click({ force: true });
    await page.keyboard.press('Alt+Shift+Enter');
}

async function closeDetailsGroup2(scope: ReturnType<Page['getByTestId']>): Promise<void> {
    await scope.getByTestId('split-canvas-leaf-close-group:2').click();
}

test.describe('ui e2e: details split canvas', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('details-split-canvas-suite');
    const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let daemon: StartedDaemon | null = null;

    test.beforeAll(async () => {
        const uiWebEnv = {
            ...process.env,
            EXPO_PUBLIC_DEBUG: '1',
            EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-details-split`,
            HAPPIER_E2E_UI_WEB_MODE: 'metro',
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
                HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
                HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
                HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',
                HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '60000',
                HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '60000',
                HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '1000',
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

    test('splits the session details workspace from the session details route', async ({ page }) => {
        test.setTimeout(420_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
        await waitForInitialAppUi({ page, timeoutMs: 180_000 });
        await createAccountAndReachConnectMachineState({
            page,
            requirePersistedAuthCredentials: false,
        });

        const testDir = resolve(join(suiteDir, 't1-details-session'));
        await mkdir(testDir, { recursive: true });
        await writeFile(resolve(join(testDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');

        const cliLogin: StartedCliTerminalConnect = await startCliAuthLoginForTerminalConnect({
            testDir,
            cliHomeDir,
            serverUrl: server.baseUrl,
            webappUrl: uiBaseUrl,
            env: {
                ...process.env,
                HOME: cliHomeDir,
                CI: '1',
                HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
                HAPPIER_DISABLE_CAFFEINATE: '1',
                HAPPIER_VARIANT: 'dev',
            },
        });

        await approveCliTerminalConnect({
            page,
            cliLogin,
            uiBaseUrl,
            serverUrl: server.baseUrl,
        });

        const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
        const fakeClaudePath = fakeClaudeFixturePath();

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
                HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
                HAPPIER_DISABLE_CAFFEINATE: '1',
                HAPPIER_VARIANT: 'dev',
                HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: testDir,
                HAPPIER_CLAUDE_PATH: fakeClaudePath,
                HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
                HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}-details`,
                HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}-details`,
            },
        });

        const sessionId = await spawnSessionFromDaemon({ daemon, directory: testDir });
        const sessionUrl = `${uiBaseUrl}/session/${sessionId}?right=files&details=file&path=${encodeURIComponent('AGENTS.md')}`;

        await gotoDomContentLoadedWithRetries(page, sessionUrl, 180_000);
        const sessionDetailsPanel = page.getByTestId('session-details-panel-root');
        await expect(sessionDetailsPanel).toHaveCount(1, { timeout: 120_000 });
        await expect(sessionDetailsPanel.getByTestId('split-canvas-host')).toHaveCount(1, { timeout: 120_000 });
        await expect(splitCanvasLeafFrames(sessionDetailsPanel)).toHaveCount(1, { timeout: 120_000 });
        await expect(splitCanvasLeafMaximizeButtons(sessionDetailsPanel)).toHaveCount(0);
        await expect(splitCanvasLeafCloseButtons(sessionDetailsPanel)).toHaveCount(0);
        await expect(splitCanvasFocusRings(sessionDetailsPanel)).toHaveCount(0);

        await splitFocusedDetailsLeafToTheRight(sessionDetailsPanel, page);
        await expect(splitCanvasLeafFrames(sessionDetailsPanel)).toHaveCount(2, { timeout: 120_000 });
        await expect(splitCanvasLeafMaximizeButtons(sessionDetailsPanel)).toHaveCount(1, { timeout: 120_000 });
        await expect(splitCanvasLeafCloseButtons(sessionDetailsPanel)).toHaveCount(1, { timeout: 120_000 });
        await expect(page).toHaveURL(new RegExp(`/session/${sessionId}`), { timeout: 120_000 });

        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(sessionDetailsPanel).toHaveCount(1, { timeout: 120_000 });
        await expect(splitCanvasLeafFrames(sessionDetailsPanel)).toHaveCount(2, { timeout: 120_000 });
        await expect(splitCanvasLeafMaximizeButtons(sessionDetailsPanel)).toHaveCount(1, { timeout: 120_000 });
        await expect(splitCanvasLeafCloseButtons(sessionDetailsPanel)).toHaveCount(1, { timeout: 120_000 });

        await closeDetailsGroup2(sessionDetailsPanel);
        await expect(splitCanvasLeafFrames(sessionDetailsPanel)).toHaveCount(1, { timeout: 120_000 });
        await expect(sessionDetailsPanel.locator('[data-testid^="split-canvas-split-"]')).toHaveCount(0, { timeout: 120_000 });
    });

    test('splits the workspace details panel from the project details route', async ({ page }) => {
        test.setTimeout(420_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
        await waitForInitialAppUi({ page, timeoutMs: 180_000 });
        await createAccountAndReachConnectMachineState({
            page,
            requirePersistedAuthCredentials: false,
        });

        const testDir = resolve(join(suiteDir, 't2-details-project'));
        await mkdir(testDir, { recursive: true });
        await writeFile(resolve(join(testDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');

        const cliLogin: StartedCliTerminalConnect = await startCliAuthLoginForTerminalConnect({
            testDir,
            cliHomeDir,
            serverUrl: server.baseUrl,
            webappUrl: uiBaseUrl,
            env: {
                ...process.env,
                HOME: cliHomeDir,
                CI: '1',
                HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
                HAPPIER_DISABLE_CAFFEINATE: '1',
                HAPPIER_VARIANT: 'dev',
            },
        });

        await approveCliTerminalConnect({
            page,
            cliLogin,
            uiBaseUrl,
            serverUrl: server.baseUrl,
        });

        const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
        const fakeClaudePath = fakeClaudeFixturePath();

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
                HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
                HAPPIER_DISABLE_CAFFEINATE: '1',
                HAPPIER_VARIANT: 'dev',
                HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: testDir,
                HAPPIER_CLAUDE_PATH: fakeClaudePath,
                HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
                HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}-projects`,
                HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}-projects`,
            },
        });

        const repoDir = resolve(join(process.env.HOME ? process.env.HOME : suiteDir, 'happier-ui-e2e-projects', `happier-ui-e2e-project-${randomUUID()}`));
        await mkdir(repoDir, { recursive: true });
        await createGitRepoWithChanges({ repoDir, fileCount: 4 });

        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/projects`, 180_000);
        await expect(page.getByTestId('projects-list')).toHaveCount(1, { timeout: 120_000 });
        await page.locator('[data-testid^="projects-add-first-machine:"]').first().click();
        await selectWorkspacePathFromPathBrowserModal(page, repoDir);

        const projectUrl = page.url();
        if (!parseWorkspaceRefIdFromProjectsUrl(projectUrl)) {
            throw new Error(`Failed to parse workspace ref id from url: ${projectUrl}`);
        }

        const workspaceDetailsPanel = page.getByTestId('workspace-details-panel-root');
        await expect(workspaceDetailsPanel).toHaveCount(1, { timeout: 120_000 });
        await expect(workspaceDetailsPanel.getByTestId('split-canvas-host')).toHaveCount(1, { timeout: 120_000 });

        await splitFocusedDetailsLeafToTheRight(workspaceDetailsPanel, page);
        await expect(splitCanvasLeafFrames(workspaceDetailsPanel)).toHaveCount(2, { timeout: 120_000 });
        await expect(splitCanvasLeafCloseButtons(workspaceDetailsPanel)).toHaveCount(1, { timeout: 120_000 });
        await expect(page).toHaveURL(/\/projects\/[^/?]+/, { timeout: 120_000 });

        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(workspaceDetailsPanel).toHaveCount(1, { timeout: 120_000 });
        await expect(splitCanvasLeafFrames(workspaceDetailsPanel)).toHaveCount(2, { timeout: 120_000 });
        await expect(splitCanvasLeafCloseButtons(workspaceDetailsPanel)).toHaveCount(1, { timeout: 120_000 });

        await closeDetailsGroup2(workspaceDetailsPanel);
        await expect(splitCanvasLeafFrames(workspaceDetailsPanel)).toHaveCount(1, { timeout: 120_000 });
        await expect(workspaceDetailsPanel.locator('[data-testid^="split-canvas-split-"]')).toHaveCount(0, { timeout: 120_000 });
        await expect(page).toHaveURL(/\/projects\/[^/?]+/, { timeout: 120_000 });
    });
});
