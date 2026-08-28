import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';
import { acknowledgeTerminalConnectSuccessIfPresent } from '../../src/testkit/uiE2e/acknowledgeTerminalConnectSuccessIfPresent';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import {
    expectEmbeddedTerminalConnected,
    expectEmbeddedTerminalExited,
    expectEmbeddedTerminalTranscript,
    expectEmbeddedTerminalUrlBanner,
    getEmbeddedTerminalInput,
    readEmbeddedTerminalShellSize,
} from '../../src/testkit/uiE2e/embeddedTerminalSmoke';

const run = createRunDirs({ runLabel: 'ui-e2e' });

function collectBrowserDiagnostics(params: Readonly<{ page: Page }>): () => string {
    const pageConsole: string[] = [];
    const pageErrors: string[] = [];
    const requestFailures: string[] = [];
    const responseErrors: string[] = [];

    params.page.on('console', (msg) => pageConsole.push(`[${msg.type()}] ${msg.text()}`));
    params.page.on('pageerror', (err) => pageErrors.push(String(err)));
    params.page.on('requestfailed', (request) => {
        const failure = request.failure();
        requestFailures.push(`${request.method()} ${request.url()} ${failure ? `-> ${failure.errorText}` : ''}`.trim());
    });
    params.page.on('response', (response) => {
        const status = response.status();
        if (status >= 400) responseErrors.push(`${status} ${response.request().method()} ${response.url()}`);
    });

    return () =>
        `# Browser diagnostics\n\n` +
        `## Console\n\n${pageConsole.length ? pageConsole.join('\n') : '(none)'}\n\n` +
        `## Page errors\n\n${pageErrors.length ? pageErrors.join('\n') : '(none)'}\n\n` +
        `## Request failures\n\n${requestFailures.length ? requestFailures.join('\n') : '(none)'}\n\n` +
        `## Response errors\n\n${responseErrors.length ? responseErrors.join('\n') : '(none)'}\n`;
}

async function expectEmbeddedTerminalEnabledInSettings(page: Page, baseUrl: string) {
    await page.goto(`${baseUrl}/settings/features`, { waitUntil: 'domcontentloaded' });
    const terminalToggle = page.getByTestId('settings-feature-toggle-terminal.embeddedPty');
    await expect(terminalToggle).toHaveCount(1, { timeout: 60_000 });
    await expect(terminalToggle).toBeChecked();
}

function getVisibleSessionComposer(page: Page) {
    return page.locator('[data-testid="session-composer-input"]:visible');
}

async function pasteIntoTerminal(page: Page, params: Readonly<{ testId: string; baseUrl: string; text: string }>) {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], {
        origin: new URL(params.baseUrl).origin,
    });
    await page.evaluate(async (value) => {
        if (!navigator.clipboard?.writeText) {
            throw new Error('clipboard writeText is unavailable');
        }
        await navigator.clipboard.writeText(value);
    }, params.text);

    const terminal = page.getByTestId(params.testId);
    await terminal.click();
    await page.keyboard.press('ControlOrMeta+V');
}

async function submitTerminalCommand(page: Page, params: Readonly<{
    testIdPrefix: string;
    baseUrl: string;
    command: string;
}>): Promise<void> {
    const terminalInput = getEmbeddedTerminalInput(page, params.testIdPrefix);
    await expect(terminalInput).toHaveCount(1, { timeout: 60_000 });
    await terminalInput.focus();
    await pasteIntoTerminal(page, {
        testId: `${params.testIdPrefix}-terminal-xterm`,
        baseUrl: params.baseUrl,
        text: params.command,
    });
    await page.keyboard.press('Enter');
}

async function runTerminalCommand(page: Page, params: Readonly<{
    testIdPrefix: string;
    baseUrl: string;
    command: string;
    expectedText: string;
}>): Promise<void> {
    await submitTerminalCommand(page, params);
    await expectEmbeddedTerminalTranscript(page, params.testIdPrefix, params.expectedText);
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'\\''`)}'`;
}

test.describe('ui e2e: embedded terminal (PTY)', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('session-terminal-embedded-pty-suite');
    const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let daemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(process.env));
        await mkdir(cliHomeDir, { recursive: true });
        await writeFile(resolve(join(cliHomeDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');

        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
                HAPPIER_FEATURE_TERMINAL_EMBEDDED_PTY__ENABLED: '1',
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

    test('runs a command and shows output', async ({ page }) => {
        test.setTimeout(420_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        const browserDiagnostics = collectBrowserDiagnostics({ page });
        const testDir = resolve(join(suiteDir, 't1-terminal'));

        try {
            await page.setViewportSize({ width: 1440, height: 900 });
            await gotoDomContentLoadedWithRetries(page, uiBaseUrl);

            await waitForInitialAppUi({ page, browserDiagnostics, timeoutMs: 120_000 });

            // If we landed on the welcome screen, click through to getting started
            const welcomeButton = page.getByTestId('welcome-create-account');
            if ((await welcomeButton.count()) > 0) {
                await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });
            }

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
                    HAPPIER_DISABLE_CAFFEINATE: '1',
                    HAPPIER_VARIANT: 'dev',
                },
            });

            await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
            await expect(page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
            await page.getByTestId('terminal-connect-approve').click();
            await cliLogin.waitForSuccess();
            await acknowledgeTerminalConnectSuccessIfPresent(page);

            const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
            const fakeClaudePath = fakeClaudeFixturePath();
            const daemonEnv = {
                ...process.env,
                HOME: cliHomeDir,
                CI: '1',
                HAPPIER_HOME_DIR: cliHomeDir,
                HAPPIER_SERVER_URL: server.baseUrl,
                HAPPIER_WEBAPP_URL: uiBaseUrl,
                HAPPIER_DISABLE_CAFFEINATE: '1',
                HAPPIER_VARIANT: 'dev',
                // Machine-scoped RPC must be allowed to operate inside the e2e fixture directory.
                HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: testDir,
                HAPPIER_CLAUDE_PATH: fakeClaudePath,
                HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
                HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
                HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
                HAPPIER_DAEMON_TERMINAL_BUFFER_MAX_BYTES: '64000',
                HAPPIER_DAEMON_TERMINAL_BUFFER_RETENTION_MS: '1000',
            };

            daemon = await startTestDaemon({
                testDir,
                happyHomeDir: cliHomeDir,
                env: daemonEnv,
            });

            await expectEmbeddedTerminalEnabledInSettings(page, uiBaseUrl);

            const sessionId = await spawnSessionFromDaemon({ daemon, directory: testDir });
            await page.goto(`${uiBaseUrl}/session/${sessionId}`, { waitUntil: 'domcontentloaded' });

            await expect(getVisibleSessionComposer(page)).toHaveCount(1, { timeout: 180_000 });

            await page.getByTestId('session-header-terminal-button').click();

            await expect(page.getByTestId('session-bottompanel-surface-terminal')).toHaveCount(1, { timeout: 180_000 });

            const xterm = page.getByTestId('session-bottompanel-terminal-xterm');
            await expect(xterm).toHaveCount(1, { timeout: 180_000 });

            await runTerminalCommand(page, {
                testIdPrefix: 'session-bottompanel',
                baseUrl: uiBaseUrl,
                command: 'echo happier-terminal-e2e',
                expectedText: 'happier-terminal-e2e',
            });
            await expect(page).toHaveURL(new RegExp(`/session/${sessionId}.*(?:\\?|&)bottom=terminal(?:&|$)`), { timeout: 60_000 });

            const initialSize = await readEmbeddedTerminalShellSize(page, 'session-bottompanel');
            await page.setViewportSize({ width: 1180, height: 760 });
            await expect.poll(async () => await readEmbeddedTerminalShellSize(page, 'session-bottompanel'), { timeout: 60_000 })
                .not.toEqual(initialSize);
            await runTerminalCommand(page, {
                testIdPrefix: 'session-bottompanel',
                baseUrl: uiBaseUrl,
                command: 'printf "terminal-size:%sx%s\\n" "$(tput cols)" "$(tput lines)"',
                expectedText: 'terminal-size:',
            });

            const detectedUrl = 'https://example.com/happier-terminal-e2e';
            await runTerminalCommand(page, {
                testIdPrefix: 'session-bottompanel',
                baseUrl: uiBaseUrl,
                command: `echo ${detectedUrl}`,
                expectedText: detectedUrl,
            });
            await expectEmbeddedTerminalUrlBanner(page, 'session-bottompanel', detectedUrl);
            await page.getByTestId('session-bottompanel-url-dismiss').click();
            await expect(page.getByTestId('session-bottompanel-url-banner')).toHaveCount(0);

            await page.reload({ waitUntil: 'domcontentloaded' });
            await expect(getVisibleSessionComposer(page)).toHaveCount(1, { timeout: 180_000 });
            await expect(page.getByTestId('session-bottompanel-surface-terminal')).toHaveCount(1, { timeout: 180_000 });
            await expectEmbeddedTerminalTranscript(page, 'session-bottompanel', 'happier-terminal-e2e');

            const overflowCompletePath = resolve(join(testDir, 'terminal-overflow.complete'));
            await submitTerminalCommand(page, {
                testIdPrefix: 'session-bottompanel',
                baseUrl: uiBaseUrl,
                command: `(sleep 1; yes 0123456789 | head -c 96000; sleep 2; printf '\\n%s%s\\n' 'happier-terminal-overflow-' 'tail'; : > ${shellQuote(overflowCompletePath)}) &`,
            });
            await page.goto(`${uiBaseUrl}/settings/features`, { waitUntil: 'domcontentloaded' });
            await expect.poll(
                async () => await readFile(overflowCompletePath, 'utf8').then(() => true, () => false),
                { timeout: 30_000 },
            ).toBe(true);
            await page.goto(`${uiBaseUrl}/session/${sessionId}?bottom=terminal`, { waitUntil: 'domcontentloaded' });
            await expect(page.getByTestId('session-bottompanel-surface-terminal')).toHaveCount(1, { timeout: 180_000 });
            await expectEmbeddedTerminalTranscript(page, 'session-bottompanel', '[Output truncated]');
            await expectEmbeddedTerminalTranscript(page, 'session-bottompanel', 'happier-terminal-overflow-tail');

            await page.getByTestId('session-bottompanel-restart').click();
            await expectEmbeddedTerminalConnected(page, 'session-bottompanel');
            await runTerminalCommand(page, {
                testIdPrefix: 'session-bottompanel',
                baseUrl: uiBaseUrl,
                command: 'echo happier-terminal-after-restart',
                expectedText: 'happier-terminal-after-restart',
            });

            await runTerminalCommand(page, {
                testIdPrefix: 'session-bottompanel',
                baseUrl: uiBaseUrl,
                command: 'exit 17',
                expectedText: 'exit 17',
            });
            await expectEmbeddedTerminalExited(page, 'session-bottompanel');
            await page.getByTestId('session-bottompanel-restart').click();
            await expectEmbeddedTerminalConnected(page, 'session-bottompanel');
            await runTerminalCommand(page, {
                testIdPrefix: 'session-bottompanel',
                baseUrl: uiBaseUrl,
                command: 'echo happier-terminal-after-exit',
                expectedText: 'happier-terminal-after-exit',
            });

            const originalDaemon = daemon;
            const originalDaemonPid = originalDaemon.state.pid;
            daemon = null;
            await originalDaemon.stop();
            await expectEmbeddedTerminalExited(page, 'session-bottompanel', 120_000);

            const restartedDaemonTestDir = resolve(join(suiteDir, 't1-terminal-daemon-restart'));
            daemon = await startTestDaemon({
                testDir: restartedDaemonTestDir,
                happyHomeDir: cliHomeDir,
                startupTimeoutMs: 120_000,
                env: daemonEnv,
            });
            expect(daemon.state.pid).not.toBe(originalDaemonPid);
            await expectEmbeddedTerminalConnected(page, 'session-bottompanel', 180_000);
            await runTerminalCommand(page, {
                testIdPrefix: 'session-bottompanel',
                baseUrl: uiBaseUrl,
                command: 'echo happier-terminal-after-daemon-restart',
                expectedText: 'happier-terminal-after-daemon-restart',
            });

            const secondSessionId = await spawnSessionFromDaemon({ daemon, directory: testDir });

            const secondSessionItem = page.getByTestId(`session-list-item-${secondSessionId}`);
            await expect(secondSessionItem).toHaveCount(1, { timeout: 120_000 });
            await secondSessionItem.click();

            await expect(page).toHaveURL(new RegExp(`/session/${secondSessionId}(?:\\?.*)?$`), { timeout: 60_000 });
            await expect(getVisibleSessionComposer(page)).toHaveCount(1, { timeout: 180_000 });
            await expect(page.getByTestId('session-bottompanel-surface-terminal')).toHaveCount(0, { timeout: 60_000 });

            const firstSessionItem = page.getByTestId(`session-list-item-${sessionId}`);
            await expect(firstSessionItem).toHaveCount(1, { timeout: 120_000 });
            await firstSessionItem.click();

            await expect(page).toHaveURL(new RegExp(`/session/${sessionId}.*(?:\\?|&)bottom=terminal(?:&|$)`), { timeout: 60_000 });
            await expect(getVisibleSessionComposer(page)).toHaveCount(1, { timeout: 180_000 });
            await expect(page.getByTestId('session-bottompanel-surface-terminal')).toHaveCount(1, { timeout: 180_000 });
            await expectEmbeddedTerminalTranscript(page, 'session-bottompanel', 'happier-terminal-after-daemon-restart');

            // Switch dock location to sidebar and verify we keep the same underlying PTY session.
            await page.getByTestId('session-bottompanel-terminal-dock').click();
            await page.getByTestId('dropdown-option-sidebar').click();

            await expect(page.getByTestId('session-bottompanel-surface-terminal')).toHaveCount(0, { timeout: 180_000 });
            await expect(page.getByTestId('session-rightpanel-surface-terminal')).toHaveCount(1, { timeout: 180_000 });
            await expectEmbeddedTerminalTranscript(page, 'session-rightpanel', 'happier-terminal-after-daemon-restart');
        } catch (err) {
            await test.info().attach('browser-diagnostics', {
                body: browserDiagnostics(),
                contentType: 'text/markdown',
            });
            throw err;
        }
    });
});
