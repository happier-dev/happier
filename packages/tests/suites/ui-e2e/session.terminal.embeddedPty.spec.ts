import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';

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

async function enableEmbeddedTerminalInSettings(page: Page, baseUrl: string) {
    await page.goto(`${baseUrl}/settings/features`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-feature-experiments-toggle')).toHaveCount(1, { timeout: 60_000 });

    const experimentsToggle = page.getByTestId('settings-feature-experiments-toggle');
    await experimentsToggle.click();

    const terminalToggle = page.getByTestId('settings-feature-toggle-terminal.embeddedPty');
    await expect(terminalToggle).toHaveCount(1, { timeout: 60_000 });
    await terminalToggle.click();
}

async function expectTerminalTranscriptToContain(page: Page, testId: string, needle: string) {
    const terminal = page.getByTestId(testId);
    await expect(terminal).toHaveCount(1, { timeout: 180_000 });
    await expect.poll(async () => await terminal.getAttribute('data-happier-terminal-text'), { timeout: 60_000 }).toContain(needle);
}

function getVisibleSessionComposer(page: Page) {
    return page.locator('[data-testid="session-composer-input"]:visible');
}

function getTerminalInput(page: Page, testId: string) {
    return page.getByTestId(testId).locator('textarea').first();
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
                HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys,providers.claude.unifiedTerminal',
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
            await mkdir(testDir, { recursive: true });
            await writeFile(resolve(join(testDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');
            const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
            const fakeClaudePath = fakeClaudeFixturePath();
            daemon = await authenticateAndStartDaemon({
                page,
                testDir,
                cliHomeDir,
                serverUrl: server.baseUrl,
                uiBaseUrl,
                daemonStartupTimeoutMs: 180_000,
                extraEnv: {
                    ...process.env,
                    HOME: cliHomeDir,
                    HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: testDir,
                    HAPPIER_CLAUDE_PATH: fakeClaudePath,
                    HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
                    HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
                    HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
                },
            });

            await enableEmbeddedTerminalInSettings(page, uiBaseUrl);

            const sessionId = await spawnSessionFromDaemon({ daemon, directory: testDir });
            await page.goto(`${uiBaseUrl}/session/${sessionId}`, { waitUntil: 'domcontentloaded' });

            await expect(getVisibleSessionComposer(page)).toHaveCount(1, { timeout: 180_000 });

            await page.getByTestId('session-header-terminal-button').click();

            await expect(page.getByTestId('session-bottompanel-surface-terminal')).toHaveCount(1, { timeout: 180_000 });

            const xterm = page.getByTestId('session-bottompanel-terminal-xterm');
            await expect(xterm).toHaveCount(1, { timeout: 180_000 });

            const terminalInput = getTerminalInput(page, 'session-bottompanel-terminal-xterm');
            await expect(terminalInput).toHaveCount(1, { timeout: 60_000 });
            await terminalInput.focus();
            await pasteIntoTerminal(page, {
                testId: 'session-bottompanel-terminal-xterm',
                baseUrl: uiBaseUrl,
                text: 'echo happier-terminal-e2e',
            });
            await page.keyboard.press('Enter');

            await expectTerminalTranscriptToContain(page, 'session-bottompanel-terminal-xterm', 'happier-terminal-e2e');
            await expect(page).toHaveURL(new RegExp(`/session/${sessionId}.*(?:\\?|&)bottom=terminal(?:&|$)`), { timeout: 60_000 });

            await page.reload({ waitUntil: 'domcontentloaded' });
            await expect(getVisibleSessionComposer(page)).toHaveCount(1, { timeout: 180_000 });
            await expect(page.getByTestId('session-bottompanel-surface-terminal')).toHaveCount(1, { timeout: 180_000 });
            await expectTerminalTranscriptToContain(page, 'session-bottompanel-terminal-xterm', 'happier-terminal-e2e');

            const secondSessionId = await spawnSessionFromDaemon({ daemon, directory: testDir });

            const secondSessionItem = page.getByTestId(`session-list-item-${secondSessionId}`);
            await expect(secondSessionItem).toHaveCount(1, { timeout: 120_000 });
            await secondSessionItem.click();

            await expect(page).toHaveURL(`${uiBaseUrl}/session/${secondSessionId}`, { timeout: 60_000 });
            await expect(getVisibleSessionComposer(page)).toHaveCount(1, { timeout: 180_000 });
            await expect(page.getByTestId('session-bottompanel-surface-terminal')).toHaveCount(0, { timeout: 60_000 });

            const firstSessionItem = page.getByTestId(`session-list-item-${sessionId}`);
            await expect(firstSessionItem).toHaveCount(1, { timeout: 120_000 });
            await firstSessionItem.click();

            await expect(page).toHaveURL(new RegExp(`/session/${sessionId}.*(?:\\?|&)bottom=terminal(?:&|$)`), { timeout: 60_000 });
            await expect(getVisibleSessionComposer(page)).toHaveCount(1, { timeout: 180_000 });
            await expect(page.getByTestId('session-bottompanel-surface-terminal')).toHaveCount(1, { timeout: 180_000 });
            await expectTerminalTranscriptToContain(page, 'session-bottompanel-terminal-xterm', 'happier-terminal-e2e');

            // Switch dock location to sidebar and verify we keep the same underlying PTY session.
            await page.getByTestId('session-bottompanel-terminal-dock').click();
            await page.getByTestId('dropdown-option-sidebar').click();

            await expect(page.getByTestId('session-bottompanel-surface-terminal')).toHaveCount(0, { timeout: 180_000 });
            await expect(page.getByTestId('session-rightpanel-surface-terminal')).toHaveCount(1, { timeout: 180_000 });
            await expectTerminalTranscriptToContain(page, 'session-rightpanel-terminal-xterm', 'happier-terminal-e2e');
        } catch (err) {
            await test.info().attach('browser-diagnostics', {
                body: browserDiagnostics(),
                contentType: 'text/markdown',
            });
            throw err;
        }
    });
});
