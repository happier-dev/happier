import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { approveTerminalConnect } from '../../src/testkit/uiE2e/approveTerminalConnect';
import { openNewSessionMachineSelection } from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
import {
    gotoCommittedWithRetries,
    gotoDomContentLoadedWithPathFallback,
    gotoDomContentLoadedWithRetries,
    normalizeLoopbackBaseUrl,
} from '../../src/testkit/uiE2e/pageNavigation';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { selectNewSessionAgent } from '../../src/testkit/uiE2e/selectNewSessionAgent';

const run = createRunDirs({ runLabel: 'ui-e2e' });

function resolveServerLightSqliteDbPath(params: { suiteDir: string }): string {
    return resolve(join(params.suiteDir, 'server-light-data', 'happier-server-light.sqlite'));
}

function readLatestMachineIdFromServerLightDb(params: { suiteDir: string }): string {
    const dbPath = resolveServerLightSqliteDbPath({ suiteDir: params.suiteDir });
    try {
        const raw = execFileSync('sqlite3', ['-json', dbPath, 'select id from Machine order by createdAt desc limit 1;'], {
            encoding: 'utf8',
        });
        const parsed = JSON.parse(raw) as Array<{ id?: unknown }>;
        const id = parsed?.[0]?.id;
        if (typeof id === 'string' && id.trim()) return id.trim();
    } catch {
        // ignore - pollers can retry
    }
    throw new Error(`Failed to read machine id from server light sqlite db: ${dbPath}`);
}

function readLatestChildSessionIdFromServerLightDb(params: { suiteDir: string; parentSessionId: string }): string {
    const dbPath = resolveServerLightSqliteDbPath({ suiteDir: params.suiteDir });
    try {
        const raw = execFileSync('sqlite3', ['-json', dbPath, 'select id from Session order by createdAt desc limit 25;'], {
            encoding: 'utf8',
        });
        const parsed = JSON.parse(raw) as Array<{ id?: unknown }>;
        const id = parsed
            .map((entry) => (typeof entry?.id === 'string' ? entry.id.trim() : ''))
            .find((candidate) => candidate.length > 0 && candidate !== params.parentSessionId);
        if (typeof id === 'string' && id.trim()) return id.trim();
    } catch {
        // ignore - pollers can retry
    }
    throw new Error(`Failed to read child session id from server light sqlite db: ${dbPath}`);
}

async function waitForLatestMachineId(params: { suiteDir: string; timeoutMs?: number }): Promise<string> {
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

async function waitForForkedChildSessionId(params: {
    suiteDir: string;
    parentSessionId: string;
    timeoutMs?: number;
}): Promise<string> {
    const timeoutMs = params.timeoutMs ?? 120_000;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        try {
            const id = readLatestChildSessionIdFromServerLightDb({
                suiteDir: params.suiteDir,
                parentSessionId: params.parentSessionId,
            });
            if (id && id !== params.parentSessionId) return id;
        } catch {
            // retry
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    return readLatestChildSessionIdFromServerLightDb({
        suiteDir: params.suiteDir,
        parentSessionId: params.parentSessionId,
    });
}

function parseSessionIdFromUrl(url: string): string {
    const pathname = new URL(url).pathname;
    const parts = pathname.split('/').filter(Boolean);
    const sessionId = parts[0] === 'session' ? parts[1] : null;
    if (!sessionId) {
        throw new Error(`failed to parse session id from url: ${url}`);
    }
    return sessionId;
}

async function writeFakeCodexAppServerScript(params: { scriptPath: string }): Promise<void> {
    const script = [
        '#!/usr/bin/env node',
        'import readline from "node:readline";',
        'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
        'let turnCounter = 0;',
        'for await (const line of rl) {',
        '  if (!line.trim()) continue;',
        '  const msg = JSON.parse(line);',
        '  if (msg.method === "initialize") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake-codex-app-server", version: "0.0.0" } } }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "initialized") continue;',
        '  if (msg.method === "thread/start") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: "thread-started", model: "gpt-5.4", serviceTier: null } }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "thread/fork") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: "thread-forked", model: "gpt-5.4", serviceTier: null } }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "collaborationMode/list") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: [{ name: "Default", mode: "default", reasoning_effort: null }] }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "model/list") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: [{ id: "gpt-5.4", displayName: "GPT-5.4", isDefault: true }] }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "turn/start") {',
        '    turnCounter += 1;',
        '    const turnId = `turn-${turnCounter}`;',
        '    const threadId = msg.params?.threadId ?? "thread-started";',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: turnId }, threadId } }) + "\\n");',
        '    setTimeout(() => {',
        '      process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId, turn: { id: turnId } } }) + "\\n");',
        '    }, 5);',
        '    setTimeout(() => {',
        '      process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: `msg-${turnCounter}`, type: "agentMessage", text: `FAKE_CODEX_INFO_FORK_OK_${turnCounter}` } } }) + "\\n");',
        '    }, 10);',
        '    setTimeout(() => {',
        '      process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: turnId } } }) + "\\n");',
        '    }, 15);',
        '    continue;',
        '  }',
        '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
        '}',
    ].join('\n');
    await writeFile(params.scriptPath, script, { encoding: 'utf8', mode: 0o755 });
}

async function setCodexBackendModeToAppServer(page: Page, uiBaseUrl: string): Promise<void> {
    await gotoDomContentLoadedWithPathFallback(page, `${uiBaseUrl}/settings/providers/codex`, '/settings/providers/codex');
    const backendModeRow = page.getByTestId('settings-provider-field-codexBackendMode');
    await expect(backendModeRow).toHaveCount(1, { timeout: 60_000 });
    if ((await backendModeRow.getByText('App Server').count()) > 0) return;
    await backendModeRow.click();
    await page.getByRole('menuitemradio', { name: /App Server/i }).click();
    await expect(backendModeRow).toContainText('App Server', { timeout: 60_000 });
}

async function createCodexSessionFromComposer(params: {
    page: Page;
    uiBaseUrl: string;
    machineId: string;
    prompt: string;
}): Promise<string> {
    const { page, uiBaseUrl, machineId, prompt } = params;

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/new`);
    await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 60_000 });
    await selectNewSessionAgent({ page, agentId: 'codex' });

    await expect(page.getByTestId('agent-input-machine-chip')).toHaveCount(1, { timeout: 60_000 });
    await openNewSessionMachineSelection({ page, uiBaseUrl });
    const machineOption = page.locator(
        `[data-testid="new-session-machine:${machineId}"], [data-testid="new-session-machine-option:${machineId}"]`,
    ).first();
    await expect(machineOption).toHaveCount(1, { timeout: 120_000 });
    await machineOption.click();

    await page.waitForURL((url) => url.pathname.endsWith('/new'), { timeout: 60_000 });
    await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('new-session-composer-input').fill(prompt);
    await expect(page.getByTestId('new-session-composer-send')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('new-session-composer-send').click();
    const startedAt = Date.now();
    while (Date.now() - startedAt < 120_000) {
        try {
            const currentUrl = page.url();
            if (currentUrl.includes('/session/') && !currentUrl.endsWith('/info')) {
                return parseSessionIdFromUrl(currentUrl);
            }
        } catch {
            // retry until URL settles on a concrete session route
        }
        await page.waitForTimeout(250);
    }
    throw new Error(`Timed out waiting for session route after submit (url=${page.url()})`);
}

test.describe('ui e2e: Codex app-server fork from session info', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('session-codex-app-server-fork-from-info-suite');
    const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let daemon: StartedDaemon | null = null;

    test.beforeAll(async () => {
        test.setTimeout(420_000);
        await mkdir(cliHomeDir, { recursive: true });
        await writeFile(resolve(join(cliHomeDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');

        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
                HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '300000',
                HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '300000',
                HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '1000',
            },
        });

        ui = await startUiWeb({
            testDir: suiteDir,
            env: {
                ...process.env,
                EXPO_PUBLIC_DEBUG: '1',
                EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS: '300000',
                EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
                EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-codex-app-server-fork-info`,
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

    test('forks a Codex app-server session from the session info surface with replay disabled', async ({ page }) => {
        test.setTimeout(540_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoCommittedWithRetries(page, uiBaseUrl, 180_000);

        await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });

        const testDir = resolve(join(suiteDir, 't1-codex-app-server-fork-from-info'));
        await mkdir(testDir, { recursive: true });

        const fakeCodexAppServerPath = resolve(join(testDir, 'fake-codex-app-server.mjs'));
        await writeFakeCodexAppServerScript({ scriptPath: fakeCodexAppServerPath });

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

        await gotoDomContentLoadedWithPathFallback(page, cliLogin.connectUrl, '/terminal/connect', 180_000);
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
                HAPPIER_CODEX_APP_SERVER_BIN: fakeCodexAppServerPath,
                HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '10000',
            },
        });

        await setCodexBackendModeToAppServer(page, uiBaseUrl);

        const machineId = await waitForLatestMachineId({ suiteDir, timeoutMs: 120_000 });
        const parentSessionId = await createCodexSessionFromComposer({
            page,
            uiBaseUrl,
            machineId,
            prompt: `codex-app-server-info-parent ${run.runId}`,
        });

        await gotoDomContentLoadedWithPathFallback(page, `${uiBaseUrl}/session/${parentSessionId}`, `/session/${parentSessionId}`, 180_000);
        await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByText('FAKE_CODEX_INFO_FORK_OK_1')).toHaveCount(1, { timeout: 180_000 });

        await page.getByTestId('session-header-avatar').click();
        await page.waitForURL((url) => url.pathname.endsWith(`/session/${parentSessionId}/info`), { timeout: 60_000 });
        await expect(page.getByTestId('session-info-screen')).toHaveCount(1, { timeout: 60_000 });
        await expect(page.getByTestId('session-info-fork-session')).toHaveCount(1, { timeout: 60_000 });

        await page.getByTestId('session-info-fork-session').click();

        const childSessionId = await waitForForkedChildSessionId({
            suiteDir,
            parentSessionId,
            timeoutMs: 120_000,
        });
        await gotoDomContentLoadedWithPathFallback(page, `${uiBaseUrl}/session/${childSessionId}`, `/session/${childSessionId}`, 180_000);
        await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });

        const transcript = page.locator('[data-testid="transcript-chat-list"]:visible').first();
        await expect(transcript.locator(`[data-testid="transcript-fork-divider:${parentSessionId}:${childSessionId}"]`)).toHaveCount(1, {
            timeout: 120_000,
        });
    });
});
