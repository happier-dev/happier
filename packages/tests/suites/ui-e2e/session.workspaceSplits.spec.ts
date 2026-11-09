import { resolveCanonicalServerIdForUi } from '../../src/testkit/uiE2e/sessionFoldersDrag';
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
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';

import { sessionListRowTestId } from '../../src/testkit/uiE2e/sessionListRowTestId';

let rowServerId: string;
const rowTestId = (sessionId: string) => sessionListRowTestId(rowServerId, sessionId);

const run = createRunDirs({ runLabel: 'ui-e2e' });

function sessionSurface(page: Page, sessionId: string) {
    return page.getByTestId(`session-view-retained-surface:${sessionId}`);
}

function sessionComposer(page: Page, sessionId: string) {
    return sessionSurface(page, sessionId).locator('textarea[data-testid="session-composer-input"]');
}

async function sessionTabId(page: Page, sessionId: string): Promise<string> {
    const retained = sessionSurface(page, sessionId).locator('xpath=ancestor::*[starts-with(@data-testid, "workspace-retained-")][1]');
    await expect(retained).toHaveCount(1);
    const id = await retained.getAttribute('data-testid');
    if (!id) throw new Error('Missing workspace retained tab identity');
    return id.slice('workspace-retained-'.length);
}

async function selectTabMenu(page: Page, tabId: string, item: 'maximize' | 'close' | 'split-right' | 'split-down') {
    await page.getByTestId(`workspace-tab-${tabId}`).click({ button: 'right' });
    await page.getByTestId(`workspace-tab-menu-${item}`).click();
}

async function resizeWorkspaceDivider(page: Page, direction: 'right' | 'down') {
    const divider = page.locator('[data-testid^="split-canvas-divider-handle-"]').first();
    const bounds = await divider.boundingBox();
    if (!bounds) throw new Error('Missing workspace divider geometry');
    const x = bounds.x + bounds.width / 2;
    const y = bounds.y + bounds.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + (direction === 'right' ? 120 : 0), y + (direction === 'down' ? 120 : 0), { steps: 12 });
    await page.mouse.up();
}

test.describe('ui e2e: workspace Session splits', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('workspace-session-splits-suite');
    const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let daemon: StartedDaemon | null = null;

    test.beforeAll(async () => {
        const uiWebEnv = {
            ...process.env,
            EXPO_PUBLIC_DEBUG: '1',
            EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-workspace-session-splits`,
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
            },
        });

        rowServerId = await resolveCanonicalServerIdForUi(server.baseUrl);

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

    for (const direction of ['right', 'down'] as const) {
        test(`splits Sessions ${direction} through the workspace and retains drafts across focus, nesting and reload`, async ({ page }) => {
            const diagnostics = collectBrowserDiagnostics({ page });
            try {
                test.setTimeout(420_000);
                if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

                await page.setViewportSize({ width: 1600, height: 1100 });
                await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
                await waitForInitialAppUi({ page, timeoutMs: 180_000 });
                await createAccountAndReachConnectMachineState({
                    page,
                    requirePersistedAuthCredentials: false,
                });

                const testDir = resolve(join(suiteDir, `sessions-split-${direction}`));
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
                const sessionThreeId = await spawnSessionFromDaemon({ daemon, directory: testDir });
                await page.goto(`${uiBaseUrl}/session/${sessionOneId}`, { waitUntil: 'domcontentloaded' });
                await expect(sessionComposer(page, sessionOneId)).toBeVisible({ timeout: 180_000 });
                await sessionComposer(page, sessionOneId).fill('Keep this draft while splitting');
                const firstTab = await sessionTabId(page, sessionOneId);
                const panes = page.locator('[data-testid^="workspace-group-"]');
                await expect(panes).toHaveCount(1);

                // The row uses the workspace owner; there is no nested Session layout or rail.
                await openSessionListRowMenuAndSelectItem({ page, serverId: rowServerId, sessionId: sessionTwoId,
                    itemId: direction === 'right' ? 'workspace.open.right' : 'workspace.open.below' });
                await expect(panes).toHaveCount(2, { timeout: 120_000 });
                await expect(sessionComposer(page, sessionTwoId)).toBeVisible({ timeout: 180_000 });
                await expect(sessionSurface(page, sessionOneId).getByRole('tablist')).toHaveCount(0);
                await expect(sessionSurface(page, sessionTwoId).getByTestId('split-canvas-host')).toHaveCount(0);
                const secondTab = await sessionTabId(page, sessionTwoId);
                await sessionComposer(page, sessionOneId).click();
                await expect(sessionComposer(page, sessionOneId)).toBeFocused();
                await sessionComposer(page, sessionTwoId).fill('A separate draft in the second pane');
                await expect(sessionComposer(page, sessionTwoId)).toBeFocused();
                await expect(sessionComposer(page, sessionOneId)).toHaveValue('Keep this draft while splitting');

                const firstBounds = await sessionSurface(page, sessionOneId).boundingBox();
                const secondBounds = await sessionSurface(page, sessionTwoId).boundingBox();
                if (!firstBounds || !secondBounds) throw new Error('Missing visible workspace Session geometry');
                if (direction === 'right') expect(secondBounds.x).toBeGreaterThanOrEqual(firstBounds.x + firstBounds.width);
                else expect(secondBounds.y).toBeGreaterThanOrEqual(firstBounds.y + firstBounds.height);

                await resizeWorkspaceDivider(page, direction);
                await expect.poll(async () => {
                    const bounds = await sessionSurface(page, sessionOneId).boundingBox();
                    return direction === 'right' ? bounds?.width : bounds?.height;
                }, { timeout: 60_000 }).toBeGreaterThan(direction === 'right' ? firstBounds.width : firstBounds.height);

                // Repository, file and terminal presentation stays local to each Session.
                const firstSurface = sessionSurface(page, sessionOneId);
                const secondSurface = sessionSurface(page, sessionTwoId);
                await firstSurface.getByTestId('session-open-source-control').click();
                const firstRepository = firstSurface.getByTestId('session-right-panel-root');
                await expect(firstRepository).toBeVisible({ timeout: 60_000 });
                await expect(secondSurface.getByTestId('session-right-panel-root')).toHaveCount(0);
                await firstRepository.getByTestId('repository-tree-row-AGENTS.md').first().click();
                await expect(firstSurface.getByTestId('session-details-panel-root')).toBeVisible({ timeout: 60_000 });
                await expect(secondSurface.getByTestId('session-details-panel-root')).toHaveCount(0);
                await firstSurface.getByTestId('session-header-terminal-button').click();
                await expect(firstSurface.getByTestId('session-bottompanel-surface-terminal')).toBeVisible({ timeout: 120_000 });
                await expect(secondSurface.getByTestId('session-bottompanel-surface-terminal')).toHaveCount(0);
                await secondSurface.getByTestId('session-header-terminal-button').click();
                await expect(secondSurface.getByTestId('session-bottompanel-surface-terminal')).toBeVisible({ timeout: 120_000 });
                await expect(firstSurface.getByTestId('session-bottompanel-surface-terminal')).toBeVisible();

                // Center adds a kept workspace tab, preserving the previous Session and its draft.
                await page.getByTestId(rowTestId(sessionThreeId)).dragTo(sessionSurface(page, sessionTwoId));
                await expect(sessionComposer(page, sessionThreeId)).toBeVisible({ timeout: 180_000 });
                await expect(panes).toHaveCount(2);
                await expect(page.getByTestId(`workspace-tab-${secondTab}`)).toBeVisible();
                await page.getByTestId(`workspace-tab-${secondTab}`).click();
                await expect(sessionComposer(page, sessionTwoId)).toHaveValue('A separate draft in the second pane');

                // The title-bar menu uses workspace.split for the nested split.
                const thirdTab = await sessionTabId(page, sessionThreeId);
                await selectTabMenu(page, thirdTab, direction === 'right' ? 'split-down' : 'split-right');
                await expect(panes).toHaveCount(3, { timeout: 120_000 });
                await expect(sessionComposer(page, sessionThreeId)).toBeVisible({ timeout: 180_000 });
                await expect(sessionComposer(page, sessionOneId)).toHaveValue('Keep this draft while splitting');
                await expect(sessionComposer(page, sessionTwoId)).toHaveValue('A separate draft in the second pane');
                await selectTabMenu(page, thirdTab, 'close');
                await expect(panes).toHaveCount(2, { timeout: 60_000 });

                // Maximize/restore and close come from the pane's title-bar tab menu.
                await selectTabMenu(page, firstTab, 'maximize');
                await expect(sessionSurface(page, sessionTwoId)).toHaveAttribute('aria-hidden', 'true');
                await selectTabMenu(page, firstTab, 'maximize');
                await expect(sessionSurface(page, sessionTwoId)).toHaveAttribute('aria-hidden', 'false');
                await page.reload({ waitUntil: 'domcontentloaded' });
                await expect(panes).toHaveCount(2, { timeout: 120_000 });
                await expect(sessionComposer(page, sessionOneId)).toHaveValue('Keep this draft while splitting', { timeout: 180_000 });
                await expect(sessionComposer(page, sessionTwoId)).toHaveValue('A separate draft in the second pane', { timeout: 180_000 });
                await selectTabMenu(page, secondTab, 'close');
                await expect(panes).toHaveCount(1, { timeout: 60_000 });
                await expect(sessionComposer(page, sessionOneId)).toHaveValue('Keep this draft while splitting');
            } catch (error) {
                throw appendBrowserDiagnostics(error, diagnostics());
            }
        });
    }
});
