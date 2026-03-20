import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });

type LoggedRequest = Readonly<{
    method?: string | null;
    params?: Record<string, unknown> | null;
}>;

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
        if (typeof id === 'string' && id.trim()) return id.trim();
    } catch {
        // allow retry loop to handle startup races
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

function parseSessionIdFromUrl(url: string): string {
    const pathname = new URL(url).pathname;
    const parts = pathname.split('/').filter(Boolean);
    const sessionId = parts[0] === 'session' ? parts[1] : null;
    if (!sessionId) throw new Error(`failed to parse session id from url: ${url}`);
    return sessionId;
}

async function writeFakeCodexAppServerScript(params: Readonly<{ scriptPath: string; requestLogPath: string }>): Promise<void> {
    const script = [
        '#!/usr/bin/env node',
        'import { appendFile } from "node:fs/promises";',
        'import readline from "node:readline";',
        `const requestLogPath = ${JSON.stringify(params.requestLogPath)};`,
        'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
        'let turnCounter = 0;',
        'for await (const line of rl) {',
        '  if (!line.trim()) continue;',
        '  const msg = JSON.parse(line);',
        '  await appendFile(requestLogPath, JSON.stringify({ method: msg.method ?? null, params: msg.params ?? null }) + "\\n");',
        '  if (msg.method === "initialize") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake-codex-app-server", version: "0.0.0" } } }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "initialized") continue;',
        '  if (msg.method === "thread/start") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: "thread-started", model: "gpt-5.4", serviceTier: null } }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "thread/resume") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: msg.params?.threadId ?? "thread-started", model: msg.params?.model ?? "gpt-5.4", serviceTier: msg.params?.serviceTier ?? null } }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "collaborationMode/list") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: [',
        '      { id: "default", name: "Default", mode: "default", model: "gpt-5.4", reasoning_effort: null, isDefault: true },',
        '      { id: "plan", name: "Plan", mode: "plan", model: "gpt-5.4-mini", reasoning_effort: "medium" }',
        '    ] }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "model/list") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: [',
        '      { id: "gpt-5.4", displayName: "GPT-5.4", isDefault: true },',
        '      { id: "gpt-5.4-mini", displayName: "GPT-5.4 mini" }',
        '    ] }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "turn/start") {',
        '    turnCounter += 1;',
        '    const turnId = `turn-${turnCounter}`;',
        '    const threadId = msg.params?.threadId ?? "thread-started";',
        '    const collaborationMode = msg.params?.collaborationMode ?? null;',
        '    const selectedMode = typeof collaborationMode?.mode === "string" ? collaborationMode.mode : "default";',
        '    const selectedModel = typeof collaborationMode?.settings?.model === "string"',
        '      ? collaborationMode.settings.model',
        '      : (typeof msg.params?.model === "string" ? msg.params.model : "gpt-5.4");',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: turnId }, threadId } }) + "\\n");',
        '    setTimeout(() => {',
        '      process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId, turn: { id: turnId } } }) + "\\n");',
        '    }, 5);',
        '    setTimeout(() => {',
        '      process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: `msg-${turnCounter}`, type: "agentMessage", text: `FAKE_CODEX_DYNAMIC_OK_${turnCounter}_${selectedMode}_${selectedModel}` } } }) + "\\n");',
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

async function readLoggedRequests(requestLogPath: string): Promise<LoggedRequest[]> {
    const raw = await readFile(requestLogPath, 'utf8').catch(() => '');
    return raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
            try {
                return [JSON.parse(line) as LoggedRequest];
            } catch {
                return [];
            }
        });
}

async function waitForLoggedRequest(params: Readonly<{
    requestLogPath: string;
    predicate: (entry: LoggedRequest) => boolean;
    timeoutMs?: number;
}>): Promise<LoggedRequest> {
    const timeoutMs = params.timeoutMs ?? 60_000;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
        const entries = await readLoggedRequests(params.requestLogPath);
        const match = entries.find(params.predicate) ?? null;
        if (match) return match;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
    }
    throw new Error(`Timed out waiting for matching request in ${params.requestLogPath}`);
}

async function ensureSignedIn(page: Page, uiBaseUrl: string): Promise<void> {
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 120_000) {
        if ((await page.getByTestId('session-getting-started-kind-connect_machine').count()) > 0) {
            return;
        }
        const createAccount = page.getByTestId('welcome-create-account');
        if ((await createAccount.count()) > 0) {
            await createAccount.click().catch(() => {});
        }
        await page.waitForTimeout(500);
    }
    await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 1_000 });
}

async function setCodexBackendModeToAppServer(page: Page, uiBaseUrl: string): Promise<void> {
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/providers/codex`);
    const backendModeRow = page.getByTestId('settings-provider-field-codexBackendMode');
    await expect(backendModeRow).toHaveCount(1, { timeout: 60_000 });
    if ((await backendModeRow.getByText('App Server').count()) > 0) return;
    await backendModeRow.click();
    await page.getByRole('menuitemradio', { name: /App Server/i }).click();
    await expect(backendModeRow).toContainText('App Server', { timeout: 60_000 });
}

async function setSessionReplayEnabled(page: Page, uiBaseUrl: string, enabled: boolean): Promise<void> {
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/session`);
    const replayItem = page.getByTestId('settings-session-replay-enabled-item');
    await expect(replayItem).toHaveCount(1, { timeout: 60_000 });
    const replaySwitch = replayItem.locator('input[type="checkbox"]').first();
    if ((await replaySwitch.count()) === 0) {
        if (enabled) await replayItem.click();
        return;
    }
    const checked = await replaySwitch.isChecked().catch(() => false);
    if (checked !== enabled) {
        await replayItem.click();
    }
    if (enabled) {
        await expect(replaySwitch).toBeChecked({ timeout: 60_000 });
    } else {
        await expect(replaySwitch).not.toBeChecked({ timeout: 60_000 });
    }
}

async function connectDaemonWithFakeCodexAppServer(params: Readonly<{
    page: Page;
    suiteDir: string;
    testDir: string;
    server: StartedServer;
    uiBaseUrl: string;
}>): Promise<Readonly<{ daemon: StartedDaemon; requestLogPath: string; machineId: string }>> {
    await mkdir(resolve(join(params.testDir, 'cli-home')), { recursive: true });
    await writeFile(resolve(join(params.testDir, 'cli-home', 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');

    const fakeCodexAppServerPath = resolve(join(params.testDir, 'fake-codex-app-server.mjs'));
    const requestLogPath = resolve(join(params.testDir, 'fake-codex-app-server.requests.jsonl'));
    await writeFakeCodexAppServerScript({ scriptPath: fakeCodexAppServerPath, requestLogPath });

    const cliLogin: StartedCliTerminalConnect = await startCliAuthLoginForTerminalConnect({
        testDir: params.testDir,
        cliHomeDir: resolve(join(params.testDir, 'cli-home')),
        serverUrl: params.server.baseUrl,
        webappUrl: params.uiBaseUrl,
        env: {
            ...process.env,
            HOME: resolve(join(params.testDir, 'cli-home')),
            CI: '1',
            HAPPIER_DISABLE_CAFFEINATE: '1',
            HAPPIER_VARIANT: 'dev',
        },
    });

    await params.page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
    await expect(params.page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
    await params.page.getByTestId('terminal-connect-approve').click();
    await cliLogin.waitForSuccess();
    await cliLogin.stop().catch(() => {});

    const daemon = await startTestDaemon({
        testDir: params.testDir,
        happyHomeDir: resolve(join(params.testDir, 'cli-home')),
        env: {
            ...process.env,
            HOME: resolve(join(params.testDir, 'cli-home')),
            CI: '1',
            HAPPIER_HOME_DIR: resolve(join(params.testDir, 'cli-home')),
            HAPPIER_SERVER_URL: params.server.baseUrl,
            HAPPIER_WEBAPP_URL: params.uiBaseUrl,
            HAPPIER_DISABLE_CAFFEINATE: '1',
            HAPPIER_VARIANT: 'dev',
            HAPPIER_CODEX_APP_SERVER_BIN: fakeCodexAppServerPath,
            HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '10000',
        },
    });

    await setCodexBackendModeToAppServer(params.page, params.uiBaseUrl);
    await setSessionReplayEnabled(params.page, params.uiBaseUrl, false);
    const machineId = await waitForLatestMachineId({ suiteDir: params.suiteDir, timeoutMs: 120_000 });
    return { daemon, requestLogPath, machineId };
}

async function selectCodexAgentAndMachine(params: Readonly<{ page: Page; uiBaseUrl: string; machineId: string }>): Promise<void> {
    await gotoDomContentLoadedWithRetries(params.page, `${params.uiBaseUrl}/new`);
    await expect(params.page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 60_000 });
    await params.page.getByTestId('agent-input-agent-chip').click();
    const inlineCodexOption = params.page.getByTestId('new-session-agent:codex');
    if ((await inlineCodexOption.count()) > 0) {
        await inlineCodexOption.click();
    } else {
        const pickerDialog = params.page.getByRole('dialog').last();
        await expect(pickerDialog).toContainText('Select AI Backend', { timeout: 60_000 });
        await pickerDialog.getByText('Codex', { exact: true }).click();
    }

    await params.page.getByTestId('agent-input-machine-chip').click();
    await params.page.waitForURL((url) => url.pathname.endsWith('/new/pick/machine'), { timeout: 60_000 });
    await expect(params.page.getByTestId(`new-session-machine:${params.machineId}`)).toHaveCount(1, { timeout: 120_000 });
    await params.page.getByTestId(`new-session-machine:${params.machineId}`).click();
    await params.page.waitForURL((url) => url.pathname.endsWith('/new'), { timeout: 60_000 });
    await expect(params.page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 60_000 });
}

async function openAgentActionMenu(page: Page): Promise<void> {
    await expect(page.getByTestId('agent-input-action-menu-button')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('agent-input-action-menu-button').click();
    await expect(page.getByTestId('agent-input-action-menu-overlay')).toHaveCount(1, { timeout: 60_000 });
}

test.describe('ui e2e: Codex app-server dynamic controls', () => {
    test.describe.configure({ mode: 'serial' });

    const suiteDir = run.testDir('session-codex-app-server-dynamic-controls-suite');

    let server: StartedServer | null = null;
    let ui: StartedUiWeb | null = null;
    let uiBaseUrl: string | null = null;
    let daemon: StartedDaemon | null = null;

    test.beforeAll(async () => {
        test.setTimeout(420_000);
        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
            },
        });

        ui = await startUiWeb({
            testDir: suiteDir,
            env: {
                ...process.env,
                EXPO_PUBLIC_DEBUG: '1',
                EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
                EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-codex-app-server-dynamic-controls`,
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

    test('uses preflight Codex app-server controls on /new before the first prompt', async ({ page }) => {
        test.setTimeout(540_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        const testDir = resolve(join(suiteDir, 't1-codex-app-server-preflight-controls'));
        await mkdir(testDir, { recursive: true });
        await page.setViewportSize({ width: 1440, height: 900 });

        await ensureSignedIn(page, uiBaseUrl);
        const prepared = await connectDaemonWithFakeCodexAppServer({ page, suiteDir, testDir, server, uiBaseUrl });
        daemon = prepared.daemon;

        await selectCodexAgentAndMachine({ page, uiBaseUrl, machineId: prepared.machineId });
        await openAgentActionMenu(page);

        await expect(page.getByTestId('agent-input-session-mode-option:plan')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('model-picker-overlay-option:gpt-5.4-mini')).toHaveCount(1, { timeout: 120_000 });

        await page.getByTestId('agent-input-session-mode-option:plan').click();
        await expect(page.getByTestId('agent-input-session-mode-summary')).toContainText('Plan', { timeout: 60_000 });

        await page.getByTestId('model-picker-overlay-option:gpt-5.4-mini').click();
        await expect(page.getByTestId('model-picker-overlay-summary')).toContainText('GPT-5.4 mini', { timeout: 60_000 });

        await page.keyboard.press('Escape');
        await page.getByTestId('new-session-composer-input').fill(`codex app-server preflight controls ${run.runId}`);
        await page.getByTestId('new-session-composer-input').press('Enter');

        await expect(page.locator('textarea[data-testid="session-composer-input"]:visible')).toHaveCount(1, { timeout: 180_000 });
        await expect(page.getByText('FAKE_CODEX_DYNAMIC_OK_1_plan_gpt-5.4-mini')).toHaveCount(1, { timeout: 180_000 });

        await waitForLoggedRequest({
            requestLogPath: prepared.requestLogPath,
            predicate: (entry) => entry.method === 'turn/start'
                && (entry.params?.collaborationMode as { mode?: string } | undefined)?.mode === 'plan'
                && ((entry.params?.collaborationMode as { settings?: { model?: string } } | undefined)?.settings?.model === 'gpt-5.4-mini'),
            timeoutMs: 60_000,
        });
    });

    test('applies live Codex app-server mode and model changes to the next session turn', async ({ page }) => {
        test.setTimeout(540_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        const testDir = resolve(join(suiteDir, 't2-codex-app-server-live-controls'));
        await mkdir(testDir, { recursive: true });
        await page.setViewportSize({ width: 1440, height: 900 });

        await ensureSignedIn(page, uiBaseUrl);
        const prepared = await connectDaemonWithFakeCodexAppServer({ page, suiteDir, testDir, server, uiBaseUrl });
        daemon = prepared.daemon;

        await selectCodexAgentAndMachine({ page, uiBaseUrl, machineId: prepared.machineId });
        await page.getByTestId('new-session-composer-input').fill(`codex app-server default controls ${run.runId}`);
        await page.getByTestId('new-session-composer-input').press('Enter');
        await expect(page.locator('textarea[data-testid="session-composer-input"]:visible')).toHaveCount(1, { timeout: 180_000 });
        await expect(page.getByText('FAKE_CODEX_DYNAMIC_OK_1_default_gpt-5.4')).toHaveCount(1, { timeout: 180_000 });

        const sessionId = parseSessionIdFromUrl(page.url());
        await page.goto(`${uiBaseUrl}/session/${sessionId}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 120_000 });

        await openAgentActionMenu(page);
        await expect(page.getByTestId('agent-input-session-mode-option:plan')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('model-picker-overlay-option:gpt-5.4-mini')).toHaveCount(1, { timeout: 120_000 });

        await page.getByTestId('agent-input-session-mode-option:plan').click();
        await expect(page.getByTestId('agent-input-session-mode-summary')).toContainText('Plan', { timeout: 60_000 });

        await page.getByTestId('model-picker-overlay-option:gpt-5.4-mini').click();
        await expect(page.getByTestId('model-picker-overlay-summary')).toContainText('GPT-5.4 mini', { timeout: 60_000 });

        await page.keyboard.press('Escape');
        await page.getByTestId('session-composer-input').fill(`codex app-server live controls ${run.runId}`);
        await page.getByTestId('session-composer-input').press('Enter');
        await expect(page.getByText('FAKE_CODEX_DYNAMIC_OK_2_plan_gpt-5.4-mini')).toHaveCount(1, { timeout: 180_000 });

        await waitForLoggedRequest({
            requestLogPath: prepared.requestLogPath,
            predicate: (entry) => entry.method === 'thread/resume' && entry.params?.model === 'gpt-5.4-mini',
            timeoutMs: 60_000,
        });
        await waitForLoggedRequest({
            requestLogPath: prepared.requestLogPath,
            predicate: (entry) => entry.method === 'turn/start'
                && (entry.params?.collaborationMode as { mode?: string } | undefined)?.mode === 'plan'
                && ((entry.params?.collaborationMode as { settings?: { model?: string } } | undefined)?.settings?.model === 'gpt-5.4-mini'),
            timeoutMs: 60_000,
        });
    });

    test('shows the eligible Codex app-server Speed control and applies it to the next turn session config', async ({ page }) => {
        test.setTimeout(540_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        const testDir = resolve(join(suiteDir, 't3-codex-app-server-speed-controls'));
        await mkdir(testDir, { recursive: true });
        await page.setViewportSize({ width: 1440, height: 900 });

        await ensureSignedIn(page, uiBaseUrl);
        const prepared = await connectDaemonWithFakeCodexAppServer({ page, suiteDir, testDir, server, uiBaseUrl });
        daemon = prepared.daemon;

        await selectCodexAgentAndMachine({ page, uiBaseUrl, machineId: prepared.machineId });
        await page.getByTestId('new-session-composer-input').fill(`codex app-server speed controls default ${run.runId}`);
        await page.getByTestId('new-session-composer-input').press('Enter');
        await expect(page.locator('textarea[data-testid="session-composer-input"]:visible')).toHaveCount(1, { timeout: 180_000 });
        await expect(page.getByText('FAKE_CODEX_DYNAMIC_OK_1_default_gpt-5.4')).toHaveCount(1, { timeout: 180_000 });

        await openAgentActionMenu(page);
        await expect(page.getByTestId('agent-input-config-option:speed')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('agent-input-config-option-option:speed:standard')).toHaveCount(1, { timeout: 120_000 });
        await expect(page.getByTestId('agent-input-config-option-option:speed:fast')).toHaveCount(1, { timeout: 120_000 });

        await page.getByTestId('agent-input-config-option-option:speed:fast').click();
        await expect(page.getByTestId('agent-input-config-option-summary:speed')).toContainText('Fast', { timeout: 60_000 });

        await page.keyboard.press('Escape');
        await page.getByTestId('session-composer-input').fill(`codex app-server speed controls fast ${run.runId}`);
        await page.getByTestId('session-composer-input').press('Enter');
        await expect(page.getByText('FAKE_CODEX_DYNAMIC_OK_2_default_gpt-5.4')).toHaveCount(1, { timeout: 180_000 });

        await waitForLoggedRequest({
            requestLogPath: prepared.requestLogPath,
            predicate: (entry) => entry.method === 'thread/resume'
                && entry.params?.threadId === 'thread-started'
                && entry.params?.serviceTier === 'fast',
            timeoutMs: 60_000,
        });
    });
});
