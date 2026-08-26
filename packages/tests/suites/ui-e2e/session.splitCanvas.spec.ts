import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { createAccountAndReachConnectMachineState, gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { openSessionListRowMenuAndSelectItem } from '../../src/testkit/uiE2e/sessionListRowMenu';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e' });

function sessionSurface(page: Page, sessionId: string) {
    return page.getByTestId(`session-canvas-surface-${sessionId}`);
}

function sessionLeafFrame(page: Page, sessionId: string) {
    return page.getByTestId(`split-canvas-leaf-frame-session-leaf:${sessionId}`);
}

function sessionBottomTerminal(page: Page, sessionId: string) {
    return sessionSurface(page, sessionId).getByTestId('session-bottompanel-surface-terminal');
}

function sessionHeaderTerminalButton(page: Page, sessionId: string) {
    return sessionSurface(page, sessionId).getByTestId('session-header-terminal-button');
}

function sessionSourceControlButton(page: Page, sessionId: string) {
    return sessionSurface(page, sessionId).getByTestId('session-open-source-control');
}

function sessionComposerInput(page: Page, sessionId: string) {
    return sessionSurface(page, sessionId).getByTestId('session-composer-input');
}

function sessionRightPanelRoot(page: Page, sessionId: string) {
    return sessionSurface(page, sessionId).getByTestId('session-right-panel-root');
}

function sessionDetailsPanelRoot(page: Page, sessionId: string) {
    return sessionSurface(page, sessionId).getByTestId('session-details-panel-root');
}

function sessionFocusRing(page: Page, sessionId: string) {
    return page.getByTestId(`split-canvas-focus-ring-session-leaf:${sessionId}`);
}

async function warmSessionComposerReady(page: Page, params: Readonly<{
    baseUrl: string;
    sessionId: string;
}>) {
    await page.goto(`${params.baseUrl}/session/${params.sessionId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId(`session-list-item-${params.sessionId}`)).toHaveCount(1, { timeout: 120_000 });
    await expect(page.locator('textarea[data-testid="session-composer-input"]:visible')).toHaveCount(1, { timeout: 180_000 });
}

async function expectEmbeddedTerminalEnabledInSettings(page: Page, baseUrl: string) {
    await page.goto(`${baseUrl}/settings/features`, { waitUntil: 'domcontentloaded' });
    const terminalToggle = page.getByTestId('settings-feature-toggle-terminal.embeddedPty');
    await expect(terminalToggle).toHaveCount(1, { timeout: 60_000 });
    await expect(terminalToggle).toBeChecked();
}

async function dragSessionIntoLeafCenter(page: Page, params: Readonly<{
    sourceSessionId: string;
    targetSessionId: string;
}>) {
    await page.getByTestId(`session-item-split-drag-handle-${params.sourceSessionId}`)
        .dragTo(sessionLeafFrame(page, params.targetSessionId));
}

async function readLeafFrameWidth(page: Page, sessionId: string): Promise<number> {
    const box = await sessionLeafFrame(page, sessionId).boundingBox();
    if (!box) {
        throw new Error(`missing leaf frame box for ${sessionId}`);
    }
    return box.width;
}

async function dragPrimaryDividerHorizontally(page: Page, deltaX: number) {
    const divider = page.locator('[data-testid^="split-canvas-divider-handle-"]').first();
    const box = await divider.boundingBox();
    if (!box) {
        throw new Error('missing split canvas divider handle');
    }

    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    await page.mouse.move(centerX, centerY);
    await page.mouse.down();
    await page.mouse.move(centerX + deltaX, centerY, { steps: 12 });
    await page.mouse.up();
}

test.describe('ui e2e: session split canvas', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('session-split-canvas-suite');
    const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let daemon: StartedDaemon | null = null;

    test.beforeAll(async () => {
        const uiWebEnv = {
            ...process.env,
            EXPO_PUBLIC_DEBUG: '1',
            EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-session-split`,
            HAPPIER_E2E_EXPO_CLEAR: '1',
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
                HAPPIER_FEATURE_TERMINAL_EMBEDDED_PTY__ENABLED: '1',
                HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
                HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE: '1',
                HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
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

    test('opens a second session in split, switches focus, closes a leaf, and restores on reload', async ({ page }) => {
        test.setTimeout(420_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
        await waitForInitialAppUi({ page, timeoutMs: 180_000 });
        await createAccountAndReachConnectMachineState({
            page,
            requirePersistedAuthCredentials: false,
        });

        const testDir = resolve(join(suiteDir, 't1-session-split'));
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

        await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
        await page.getByTestId('terminal-connect-approve').click();
        await cliLogin.waitForSuccess();

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
                HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
                HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
            },
        });

        const sessionOneId = await spawnSessionFromDaemon({ daemon, directory: testDir });
        const sessionTwoId = await spawnSessionFromDaemon({ daemon, directory: testDir });
        const sessionOneUrl = `${uiBaseUrl}/session/${sessionOneId}`;

        await warmSessionComposerReady(page, { baseUrl: uiBaseUrl, sessionId: sessionOneId });
        await warmSessionComposerReady(page, { baseUrl: uiBaseUrl, sessionId: sessionTwoId });
        await page.goto(sessionOneUrl, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId(`session-list-item-${sessionOneId}`)).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId(`session-list-item-${sessionTwoId}`)).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('split-canvas-host')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId(`split-canvas-leaf-frame-session-leaf:${sessionOneId}`)).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId(`split-canvas-leaf-maximize-session-leaf:${sessionOneId}`)).toHaveCount(0);
        await expect(page.getByTestId(`split-canvas-leaf-close-session-leaf:${sessionOneId}`)).toHaveCount(0);
        await expect(sessionFocusRing(page, sessionOneId)).toHaveCount(0);

        await openSessionListRowMenuAndSelectItem({
            page,
            sessionId: sessionTwoId,
            itemId: 'openInSplitRight',
        });

        await expect(page).toHaveURL(new RegExp(`/session/${sessionOneId}(?:[?#]|$)`), { timeout: 120_000 });
        await expect(page.getByTestId(`split-canvas-leaf-frame-session-leaf:${sessionOneId}`)).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId(`split-canvas-leaf-frame-session-leaf:${sessionTwoId}`)).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId(`session-canvas-surface-${sessionOneId}`)).toHaveAttribute('aria-selected', 'false');
        await expect(page.getByTestId(`session-canvas-surface-${sessionTwoId}`)).toHaveAttribute('aria-selected', 'true');

        await sessionComposerInput(page, sessionOneId).click();
        await expect(page.getByTestId(`session-canvas-surface-${sessionOneId}`)).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByTestId(`session-canvas-surface-${sessionTwoId}`)).toHaveAttribute('aria-selected', 'false');

        await expect(sessionSourceControlButton(page, sessionOneId)).toHaveCount(1, { timeout: 60_000 });
        await sessionSourceControlButton(page, sessionOneId).click();
        await expect(sessionRightPanelRoot(page, sessionOneId)).toHaveCount(1, { timeout: 60_000 });
        await expect(sessionRightPanelRoot(page, sessionTwoId)).toHaveCount(0);

        const sessionOneRepositoryTreeAgentsFile = sessionRightPanelRoot(page, sessionOneId)
            .getByTestId('repository-tree-row-AGENTS.md')
            .first();
        await expect(sessionOneRepositoryTreeAgentsFile).toHaveCount(1, { timeout: 120_000 });
        await sessionOneRepositoryTreeAgentsFile.click();
        await expect(sessionDetailsPanelRoot(page, sessionOneId)).toHaveCount(1, { timeout: 60_000 });
        await expect(sessionDetailsPanelRoot(page, sessionTwoId)).toHaveCount(0);

        await openSessionListRowMenuAndSelectItem({
            page,
            sessionId: sessionTwoId,
            itemId: 'revealInCurrentSplit',
        });

        await expect(page).toHaveURL(new RegExp(`/session/${sessionOneId}(?:[?#]|$)`), { timeout: 120_000 });
        await expect(page.getByTestId(`session-canvas-surface-${sessionOneId}`)).toHaveAttribute('aria-selected', 'false');
        await expect(page.getByTestId(`session-canvas-surface-${sessionTwoId}`)).toHaveAttribute('aria-selected', 'true');

        await sessionDetailsPanelRoot(page, sessionOneId).click();
        await expect(page.getByTestId(`split-canvas-leaf-maximize-session-leaf:${sessionOneId}`)).toHaveCount(1, { timeout: 60_000 });
        await page.getByTestId(`split-canvas-leaf-maximize-session-leaf:${sessionOneId}`).click();
        await expect(page.getByTestId(`split-canvas-leaf-frame-session-leaf:${sessionTwoId}`)).toBeHidden({ timeout: 60_000 });
        await page.getByTestId(`split-canvas-leaf-maximize-session-leaf:${sessionOneId}`).click();
        await expect(page.getByTestId(`split-canvas-leaf-frame-session-leaf:${sessionTwoId}`)).toHaveCount(1, { timeout: 60_000 });

        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId(`split-canvas-leaf-frame-session-leaf:${sessionOneId}`)).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId(`split-canvas-leaf-frame-session-leaf:${sessionTwoId}`)).toHaveCount(1, { timeout: 120_000 });
        await expect(sessionRightPanelRoot(page, sessionOneId)).toHaveCount(1, { timeout: 120_000 });
        await expect(sessionDetailsPanelRoot(page, sessionOneId)).toHaveCount(1, { timeout: 120_000 });

        await sessionDetailsPanelRoot(page, sessionOneId).click();
        await page.getByTestId(`split-canvas-leaf-close-session-leaf:${sessionOneId}`).click();
        await expect(page.getByTestId(`split-canvas-leaf-frame-session-leaf:${sessionOneId}`)).toHaveCount(0, { timeout: 60_000 });
        await expect(page.getByTestId(`split-canvas-leaf-frame-session-leaf:${sessionTwoId}`)).toHaveCount(1, { timeout: 60_000 });
    });

    test('opens a second session in split down and keeps the active route in sync', async ({ page }) => {
        test.setTimeout(420_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
        await waitForInitialAppUi({ page, timeoutMs: 180_000 });
        await createAccountAndReachConnectMachineState({
            page,
            requirePersistedAuthCredentials: false,
        });

        const testDir = resolve(join(suiteDir, 't2-session-split-down'));
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

        await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
        await page.getByTestId('terminal-connect-approve').click();
        await cliLogin.waitForSuccess();

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
                HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}-down`,
                HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}-down`,
            },
        });

        const sessionOneId = await spawnSessionFromDaemon({ daemon, directory: testDir });
        const sessionTwoId = await spawnSessionFromDaemon({ daemon, directory: testDir });
        const sessionOneUrl = `${uiBaseUrl}/session/${sessionOneId}`;

        await warmSessionComposerReady(page, { baseUrl: uiBaseUrl, sessionId: sessionOneId });
        await warmSessionComposerReady(page, { baseUrl: uiBaseUrl, sessionId: sessionTwoId });
        await page.goto(sessionOneUrl, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId(`session-list-item-${sessionTwoId}`)).toHaveCount(1, { timeout: 120_000 });

        await openSessionListRowMenuAndSelectItem({
            page,
            sessionId: sessionTwoId,
            itemId: 'openInSplitDown',
        });

        await expect(page).toHaveURL(new RegExp(`/session/${sessionOneId}(?:[?#]|$)`), { timeout: 120_000 });
        await expect(page.getByTestId(`split-canvas-leaf-frame-session-leaf:${sessionOneId}`)).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId(`split-canvas-leaf-frame-session-leaf:${sessionTwoId}`)).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId(`session-canvas-surface-${sessionOneId}`)).toHaveAttribute('aria-selected', 'false');
        await expect(page.getByTestId(`session-canvas-surface-${sessionTwoId}`)).toHaveAttribute('aria-selected', 'true');
    });

    test('supports nested splits, center drag replacement, divider resize, and per-leaf bottom terminal isolation', async ({ page }) => {
        test.setTimeout(420_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
        await waitForInitialAppUi({ page, timeoutMs: 180_000 });
        await createAccountAndReachConnectMachineState({
            page,
            requirePersistedAuthCredentials: false,
        });

        const testDir = resolve(join(suiteDir, 't3-session-split-drag-and-isolation'));
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

        await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
        await page.getByTestId('terminal-connect-approve').click();
        await cliLogin.waitForSuccess();

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
                HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}-nested`,
                HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}-nested`,
            },
        });

        await expectEmbeddedTerminalEnabledInSettings(page, uiBaseUrl);

        const sessionOneId = await spawnSessionFromDaemon({ daemon, directory: testDir });
        const sessionTwoId = await spawnSessionFromDaemon({ daemon, directory: testDir });
        const sessionThreeId = await spawnSessionFromDaemon({ daemon, directory: testDir });
        const sessionFourId = await spawnSessionFromDaemon({ daemon, directory: testDir });
        const sessionFiveId = await spawnSessionFromDaemon({ daemon, directory: testDir });
        const sessionOneUrl = `${uiBaseUrl}/session/${sessionOneId}`;

        await warmSessionComposerReady(page, { baseUrl: uiBaseUrl, sessionId: sessionOneId });
        await warmSessionComposerReady(page, { baseUrl: uiBaseUrl, sessionId: sessionTwoId });
        await warmSessionComposerReady(page, { baseUrl: uiBaseUrl, sessionId: sessionThreeId });
        await warmSessionComposerReady(page, { baseUrl: uiBaseUrl, sessionId: sessionFourId });
        await warmSessionComposerReady(page, { baseUrl: uiBaseUrl, sessionId: sessionFiveId });
        await page.goto(sessionOneUrl, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId(`session-list-item-${sessionFiveId}`)).toHaveCount(1, { timeout: 120_000 });

        await openSessionListRowMenuAndSelectItem({
            page,
            sessionId: sessionTwoId,
            itemId: 'openInSplitRight',
        });

        const initialRouteLeafWidth = await readLeafFrameWidth(page, sessionOneId);
        const initialSecondaryLeafWidth = await readLeafFrameWidth(page, sessionTwoId);
        await dragPrimaryDividerHorizontally(page, 120);
        await expect.poll(async () => await readLeafFrameWidth(page, sessionOneId), { timeout: 60_000 })
            .toBeGreaterThan(initialRouteLeafWidth + 40);
        await expect.poll(async () => await readLeafFrameWidth(page, sessionTwoId), { timeout: 60_000 })
            .toBeLessThan(initialSecondaryLeafWidth - 40);

        await openSessionListRowMenuAndSelectItem({
            page,
            sessionId: sessionThreeId,
            itemId: 'openInSplitDown',
        });

        await expect(sessionLeafFrame(page, sessionOneId)).toHaveCount(1, { timeout: 120_000 });
        await expect(sessionLeafFrame(page, sessionTwoId)).toHaveCount(1, { timeout: 120_000 });
        await expect(sessionLeafFrame(page, sessionThreeId)).toHaveCount(1, { timeout: 120_000 });
        await expect(page.locator('[data-testid^="split-canvas-split-"]')).toHaveCount(2, { timeout: 120_000 });

        await sessionSurface(page, sessionOneId).click();
        await sessionHeaderTerminalButton(page, sessionOneId).click();
        await expect(sessionBottomTerminal(page, sessionOneId)).toHaveCount(1, { timeout: 120_000 });
        await expect(sessionBottomTerminal(page, sessionTwoId)).toHaveCount(0);
        await expect(sessionBottomTerminal(page, sessionThreeId)).toHaveCount(0);

        await sessionSurface(page, sessionThreeId).click();
        await sessionHeaderTerminalButton(page, sessionThreeId).click();
        await expect(sessionBottomTerminal(page, sessionOneId)).toHaveCount(1, { timeout: 120_000 });
        await expect(sessionBottomTerminal(page, sessionTwoId)).toHaveCount(0);
        await expect(sessionBottomTerminal(page, sessionThreeId)).toHaveCount(1, { timeout: 120_000 });

        await dragSessionIntoLeafCenter(page, {
            sourceSessionId: sessionFourId,
            targetSessionId: sessionThreeId,
        });

        await expect(page).toHaveURL(new RegExp(`/session/${sessionOneId}(?:[?#]|$)`), { timeout: 120_000 });
        await expect(sessionLeafFrame(page, sessionOneId)).toHaveCount(1, { timeout: 120_000 });
        await expect(sessionLeafFrame(page, sessionTwoId)).toHaveCount(1, { timeout: 120_000 });
        await expect(sessionLeafFrame(page, sessionThreeId)).toHaveCount(0, { timeout: 120_000 });
        await expect(sessionLeafFrame(page, sessionFourId)).toHaveCount(1, { timeout: 120_000 });

        await dragSessionIntoLeafCenter(page, {
            sourceSessionId: sessionFiveId,
            targetSessionId: sessionOneId,
        });

        await expect(page).toHaveURL(new RegExp(`/session/${sessionOneId}(?:[?#]|$)`), { timeout: 120_000 });
        await expect(sessionLeafFrame(page, sessionOneId)).toHaveCount(1, { timeout: 120_000 });
        await expect(sessionLeafFrame(page, sessionTwoId)).toHaveCount(1, { timeout: 120_000 });
        await expect(sessionLeafFrame(page, sessionFourId)).toHaveCount(1, { timeout: 120_000 });
        await expect(sessionLeafFrame(page, sessionFiveId)).toHaveCount(0, { timeout: 120_000 });
    });
});
