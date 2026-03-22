import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import {
    openNewSessionMachineSelection,
    openNewSessionPathSelection,
} from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
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
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: "thread-started", model: msg.params?.model ?? "gpt-5.4", serviceTier: Object.prototype.hasOwnProperty.call(msg.params ?? {}, "serviceTier") ? msg.params.serviceTier : null } }) + "\\n");',
        '    continue;',
        '  }',
        '  if (msg.method === "thread/resume") {',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: msg.params?.threadId ?? "thread-started", model: msg.params?.model ?? "gpt-5.4", serviceTier: Object.prototype.hasOwnProperty.call(msg.params ?? {}, "serviceTier") ? msg.params.serviceTier : null } }) + "\\n");',
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
        '      { id: "gpt-5.4", displayName: "GPT-5.4", description: "Latest frontier agentic coding model.", isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast responses with lighter reasoning" }, { reasoningEffort: "medium", description: "Balanced reasoning depth" }, { reasoningEffort: "high", description: "Greater reasoning depth for complex problems" }], defaultReasoningEffort: "medium" },',
        '      { id: "gpt-5.4-mini", displayName: "GPT-5.4 mini", description: "Smaller frontier agentic coding model.", supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced reasoning depth" }, { reasoningEffort: "high", description: "Greater reasoning depth for complex problems" }], defaultReasoningEffort: "medium" }',
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
        '    const selectedEffort = typeof msg.params?.effort === "string"',
        '      ? msg.params.effort',
        '      : (typeof collaborationMode?.settings?.reasoning_effort === "string" ? collaborationMode.settings.reasoning_effort : "medium");',
        '    const selectedServiceTier = typeof msg.params?.serviceTier === "string" ? msg.params.serviceTier : "standard";',
        '    process.stdout.write(JSON.stringify({ id: msg.id, result: { turn: { id: turnId }, threadId } }) + "\\n");',
        '    setTimeout(() => {',
        '      process.stdout.write(JSON.stringify({ method: "turn/started", params: { threadId, turn: { id: turnId } } }) + "\\n");',
        '    }, 5);',
        '    setTimeout(() => {',
        '      process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: `msg-${turnCounter}`, type: "agentMessage", text: `FAKE_CODEX_DYNAMIC_OK_${turnCounter}_${selectedMode}_${selectedModel}_${selectedEffort}_${selectedServiceTier}` } } }) + "\\n");',
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

async function fillAndClickComposerSend(params: Readonly<{
    page: Page;
    inputTestId: string;
    sendTestId: string;
    prompt: string;
    timeoutMs?: number;
}>): Promise<void> {
    const timeoutMs = params.timeoutMs ?? 60_000;
    const input = params.page.getByTestId(params.inputTestId);
    await expect(input).toHaveCount(1, { timeout: timeoutMs });
    await input.click();
    await input.pressSequentially(params.prompt);

    const sendButton = params.page.getByTestId(params.sendTestId);
    await expect(sendButton).toHaveCount(1, { timeout: timeoutMs });
    await expect(sendButton).toBeEnabled({ timeout: timeoutMs });
    await sendButton.click();
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

async function enableEnhancedSessionWizard(page: Page, uiBaseUrl: string): Promise<void> {
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/features`);
    const enhancedWizardToggle = page.getByTestId('settings-feature-toggle-useEnhancedSessionWizard');
    await expect(enhancedWizardToggle).toHaveCount(1, { timeout: 60_000 });
    const isChecked = await enhancedWizardToggle.isChecked().catch(() => false);
    if (!isChecked) {
        await enhancedWizardToggle.click();
    }
    await expect(enhancedWizardToggle).toBeChecked({ timeout: 60_000 });
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
    await enableEnhancedSessionWizard(params.page, params.uiBaseUrl);
    await setSessionReplayEnabled(params.page, params.uiBaseUrl, false);
    const machineId = await waitForLatestMachineId({ suiteDir: params.suiteDir, timeoutMs: 120_000 });
    return { daemon, requestLogPath, machineId };
}

async function selectCodexAgentAndMachine(params: Readonly<{ page: Page; uiBaseUrl: string; machineId: string }>): Promise<void> {
    await gotoDomContentLoadedWithRetries(params.page, `${params.uiBaseUrl}/new`);
    await expect(params.page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 60_000 });
    await params.page.getByTestId('agent-input-agent-chip').click();
    await expect(params.page.getByTestId('agent-input-chip-picker-popover')).toHaveCount(1, { timeout: 60_000 });
    const inlineCodexOption = params.page.getByTestId('new-session-agent:codex');
    if ((await inlineCodexOption.count()) > 0) {
        await expect(inlineCodexOption).toBeEnabled({ timeout: 60_000 });
        await inlineCodexOption.click();
    } else {
        const codexPickerOption = params.page.getByTestId('agent-input-chip-picker.option:agent:codex');
        if ((await codexPickerOption.count()) > 0) {
            await expect(codexPickerOption).toBeEnabled({ timeout: 60_000 });
            await codexPickerOption.click();
        } else {
            const codexDropdownOption = params.page.getByTestId('dropdown-option-codex');
            if ((await codexDropdownOption.count()) > 0) {
                await codexDropdownOption.click();
        } else {
            const codexPickerTrigger = params.page.getByTestId('agent-input-chip-picker.top-selector-trigger');
            if ((await codexPickerTrigger.count()) > 0) {
                await codexPickerTrigger.click();
            }

            const dropdownAgentCodexOption = params.page.getByTestId('dropdown-option-agent_codex');
            try {
                await expect(dropdownAgentCodexOption).toHaveCount(1, { timeout: 60_000 });
                await dropdownAgentCodexOption.click();
                const applyButton = params.page.getByTestId('agent-input-chip-picker.apply');
                if ((await applyButton.count()) > 0) {
                    await applyButton.click();
                }
                return;
            } catch {
                const codexPickerOptionFallback = params.page.getByTestId('agent-input-chip-picker.option:codex');
                await expect(codexPickerOptionFallback).toHaveCount(1, { timeout: 60_000 });
                await codexPickerOptionFallback.click();
            }

            const applyButton = params.page.getByTestId('agent-input-chip-picker.apply');
            if ((await applyButton.count()) > 0) {
                await applyButton.click();
            }
            }
        }
    }

    await openNewSessionMachineSelection({ page: params.page, uiBaseUrl: params.uiBaseUrl });
    await expect(params.page.getByTestId(`new-session-machine:${params.machineId}`)).toHaveCount(1, { timeout: 120_000 });
    await params.page.getByTestId(`new-session-machine:${params.machineId}`).click();
    await params.page.waitForURL((url) => url.pathname.endsWith('/new'), { timeout: 60_000 });
    await expect(params.page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 60_000 });
    const pathChip = params.page.getByTestId('agent-input-path-chip');
    await expect(pathChip).toHaveCount(1, { timeout: 60_000 });
    const pathChipText = (await pathChip.textContent()) ?? '';
    const looksLikePath = /^[A-Za-z]:[\\/]/.test(pathChipText) || /[\\/]/.test(pathChipText);
    if (!looksLikePath) {
        await openNewSessionPathSelection({ page: params.page, uiBaseUrl: params.uiBaseUrl });
        await expect(params.page.getByTestId('path-selector-input')).toHaveCount(1, { timeout: 60_000 });
        const selectedPath = '/tmp';
        await params.page.getByTestId('path-selector-input').fill(selectedPath);
        await params.page.getByTestId('path-selector-input').press('Enter');
        await params.page.waitForURL((url) => url.pathname.endsWith('/new'), { timeout: 60_000 });
        await expect(pathChip).toContainText(selectedPath, { timeout: 60_000 });
    }

}

async function openAgentActionMenu(page: Page): Promise<void> {
    const actionMenuButton = page.getByTestId('agent-input-action-menu-button');
    if ((await actionMenuButton.count()) > 0) {
        await actionMenuButton.click();
        await expect(page.getByTestId('agent-input-action-menu-overlay')).toHaveCount(1, { timeout: 60_000 });
        return;
    }

    const modeChip = page.getByTestId('agent-input-session-mode-chip');
    await expect(modeChip).toHaveCount(1, { timeout: 60_000 });
    await modeChip.click();
}

async function readVisibleModelSelectionOptionTestIds(page: Page): Promise<string[]> {
    const selectorPrefixes = ['new-session-model:', 'model-picker-overlay-option:'];
    const ids = await Promise.all(
        selectorPrefixes.map(async (prefix) => {
            return page.locator(`[data-testid^="${prefix}"]`).evaluateAll((nodes) => {
                return nodes
                    .map((node) => node.getAttribute('data-testid'))
                    .filter((value): value is string => typeof value === 'string' && value.length > 0);
            });
        }),
    );
    return ids.flat();
}

async function clickModelSelectionOption(page: Page, optionId: string): Promise<void> {
    const wizardOption = page.getByTestId(`new-session-model:${optionId}`);
    try {
        await expect(wizardOption).toHaveCount(1, { timeout: 120_000 });
        await wizardOption.click();
        return;
    } catch {
        // fall through to the overlay surface
    }

    const overlayOption = page.getByTestId(`model-picker-overlay-option:${optionId}`);
    try {
        await expect(overlayOption).toHaveCount(1, { timeout: 120_000 });
        await overlayOption.click();
    } catch (error) {
        const visibleOptionIds = await readVisibleModelSelectionOptionTestIds(page).catch(() => []);
        throw new Error(
            `Expected model selection option ${optionId}, but visible options were: ${
                visibleOptionIds.length > 0 ? visibleOptionIds.join(', ') : '(none)'
            }`,
            { cause: error as Error },
        );
    }
}

async function clickSelectedModelControlOption(page: Page, controlId: string, valueId: string): Promise<void> {
    const option = page.getByTestId(`model-picker-overlay-selected-option-control-option:${controlId}:${valueId}`);
    await expect(option).toHaveCount(1, { timeout: 120_000 });
    await option.click();
}

async function setSelectedModelControlSwitch(page: Page, controlId: string, checked: boolean): Promise<void> {
    const toggle = page.getByTestId(`model-picker-overlay-selected-option-control-switch:${controlId}`);
    await expect(toggle).toHaveCount(1, { timeout: 120_000 });
    const currentValue = (await toggle.getAttribute('aria-checked').catch(() => null)) === 'true';
    if (currentValue !== checked) {
        await toggle.click();
    }
}

async function readVisibleSessionModeOptionTestIds(page: Page): Promise<string[]> {
    const selectorPrefixes = ['agent-input-session-mode-option:', 'agent-input-simple-option:'];
    const ids = await Promise.all(
        selectorPrefixes.map(async (prefix) => {
            return page.locator(`[data-testid^="${prefix}"]`).evaluateAll((nodes) => {
                return nodes
                    .map((node) => node.getAttribute('data-testid'))
                    .filter((value): value is string => typeof value === 'string' && value.length > 0);
            });
        }),
    );
    return ids.flat();
}

async function clickSessionModeOption(page: Page, optionId: string): Promise<void> {
    const overlayOption = page.getByTestId(`agent-input-session-mode-option:${optionId}`);
    try {
        await expect(overlayOption).toHaveCount(1, { timeout: 120_000 });
        await overlayOption.click();
        return;
    } catch {
        // fall through to the simple surface
    }

    const simpleOption = page.getByTestId(`agent-input-simple-option:${optionId}`);
    try {
        await expect(simpleOption).toHaveCount(1, { timeout: 120_000 });
        await simpleOption.click();
    } catch (error) {
        const visibleOptionIds = await readVisibleSessionModeOptionTestIds(page).catch(() => []);
        throw new Error(
            `Expected session mode option ${optionId}, but visible options were: ${
                visibleOptionIds.length > 0 ? visibleOptionIds.join(', ') : '(none)'
            }`,
            { cause: error as Error },
        );
    }
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
        await clickSessionModeOption(page, 'plan');

        await page.getByTestId('agent-input-agent-chip').click();
        await clickModelSelectionOption(page, 'gpt-5.4-mini');
        await clickSelectedModelControlOption(page, 'reasoning_effort', 'high');
        await expect(page.getByTestId('model-picker-overlay-summary')).toContainText('GPT-5.4 mini', { timeout: 60_000 });

        await page.keyboard.press('Escape');
        await fillAndClickComposerSend({
            page,
            inputTestId: 'new-session-composer-input',
            sendTestId: 'new-session-composer-send',
            prompt: `codex app-server preflight controls ${run.runId}`,
        });

        await expect(page.locator('textarea[data-testid="session-composer-input"]:visible')).toHaveCount(1, { timeout: 180_000 });
        await expect(page.getByText('FAKE_CODEX_DYNAMIC_OK_1_plan_gpt-5.4-mini_high_standard')).toHaveCount(1, { timeout: 180_000 });

        await waitForLoggedRequest({
            requestLogPath: prepared.requestLogPath,
            predicate: (entry) => entry.method === 'turn/start'
                && (entry.params?.collaborationMode as { mode?: string } | undefined)?.mode === 'plan'
                && ((entry.params?.collaborationMode as { settings?: { model?: string; reasoning_effort?: string } } | undefined)?.settings?.model === 'gpt-5.4-mini')
                && ((entry.params?.collaborationMode as { settings?: { model?: string; reasoning_effort?: string } } | undefined)?.settings?.reasoning_effort === 'high')
                && entry.params?.effort === 'high',
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

        await fillAndClickComposerSend({
            page,
            inputTestId: 'new-session-composer-input',
            sendTestId: 'new-session-composer-send',
            prompt: `codex app-server default controls ${run.runId}`,
        });
        await expect(page.locator('textarea[data-testid="session-composer-input"]:visible')).toHaveCount(1, { timeout: 180_000 });
        await expect(page.getByText('FAKE_CODEX_DYNAMIC_OK_1_default_gpt-5.4_medium_standard')).toHaveCount(1, { timeout: 180_000 });

        const sessionId = parseSessionIdFromUrl(page.url());
        await page.goto(`${uiBaseUrl}/session/${sessionId}`, { waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 120_000 });

        await openAgentActionMenu(page);
        await clickSessionModeOption(page, 'plan');

        await page.getByTestId('agent-input-agent-chip').click();
        await clickModelSelectionOption(page, 'gpt-5.4-mini');
        await clickSelectedModelControlOption(page, 'reasoning_effort', 'high');
        await expect(page.getByTestId('model-picker-overlay-summary')).toContainText('GPT-5.4 mini', { timeout: 60_000 });

        await page.keyboard.press('Escape');
        await fillAndClickComposerSend({
            page,
            inputTestId: 'session-composer-input',
            sendTestId: 'session-composer-send',
            prompt: `codex app-server live controls ${run.runId}`,
        });
        await expect(page.getByText('FAKE_CODEX_DYNAMIC_OK_2_plan_gpt-5.4-mini_high_standard')).toHaveCount(1, { timeout: 180_000 });

        await openAgentActionMenu(page);
        await clickSessionModeOption(page, 'default');

        await page.getByTestId('agent-input-agent-chip').click();
        await clickModelSelectionOption(page, 'gpt-5.4');
        await clickSelectedModelControlOption(page, 'reasoning_effort', 'medium');
        await expect(page.getByTestId('model-picker-overlay-summary')).toContainText('GPT-5.4', { timeout: 60_000 });

        await page.keyboard.press('Escape');
        await fillAndClickComposerSend({
            page,
            inputTestId: 'session-composer-input',
            sendTestId: 'session-composer-send',
            prompt: `codex app-server switched back to default ${run.runId}`,
        });
        await expect(page.getByText('FAKE_CODEX_DYNAMIC_OK_3_default_gpt-5.4_medium_standard')).toHaveCount(1, { timeout: 180_000 });

        await waitForLoggedRequest({
            requestLogPath: prepared.requestLogPath,
            predicate: (entry) => entry.method === 'thread/resume' && entry.params?.model === 'gpt-5.4-mini',
            timeoutMs: 60_000,
        });
        await waitForLoggedRequest({
            requestLogPath: prepared.requestLogPath,
            predicate: (entry) => entry.method === 'turn/start'
                && (entry.params?.collaborationMode as { mode?: string } | undefined)?.mode === 'plan'
                && ((entry.params?.collaborationMode as { settings?: { model?: string; reasoning_effort?: string } } | undefined)?.settings?.model === 'gpt-5.4-mini')
                && ((entry.params?.collaborationMode as { settings?: { model?: string; reasoning_effort?: string } } | undefined)?.settings?.reasoning_effort === 'high')
                && entry.params?.effort === 'high',
            timeoutMs: 60_000,
        });
        await waitForLoggedRequest({
            requestLogPath: prepared.requestLogPath,
            predicate: (entry) => entry.method === 'turn/start'
                && ((entry.params?.collaborationMode as { mode?: string } | undefined)?.mode ?? 'default') === 'default'
                && entry.params?.model === 'gpt-5.4'
                && entry.params?.effort === 'medium',
            timeoutMs: 60_000,
        });
    });

    test('shows the eligible Codex app-server Fast toggle inside the selected model card and applies it on the first turn', async ({ page }) => {
        test.setTimeout(540_000);
        if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

        const testDir = resolve(join(suiteDir, 't3-codex-app-server-speed-controls'));
        await mkdir(testDir, { recursive: true });
        await page.setViewportSize({ width: 1440, height: 900 });

        await ensureSignedIn(page, uiBaseUrl);
        const prepared = await connectDaemonWithFakeCodexAppServer({ page, suiteDir, testDir, server, uiBaseUrl });
        daemon = prepared.daemon;

        await selectCodexAgentAndMachine({ page, uiBaseUrl, machineId: prepared.machineId });
        await page.getByTestId('agent-input-agent-chip').click();
        await clickModelSelectionOption(page, 'gpt-5.4-mini');
        await expect(page.getByTestId('model-picker-overlay-selected-option-control:speed')).toHaveCount(0, { timeout: 60_000 });
        await clickModelSelectionOption(page, 'gpt-5.4');
        await expect(page.getByTestId('model-picker-overlay-selected-option-control:speed')).toHaveCount(1, { timeout: 60_000 });
        await setSelectedModelControlSwitch(page, 'speed', true);
        await page.keyboard.press('Escape');

        await fillAndClickComposerSend({
            page,
            inputTestId: 'new-session-composer-input',
            sendTestId: 'new-session-composer-send',
            prompt: `codex app-server fast controls ${run.runId}`,
        });
        await expect(page.locator('textarea[data-testid="session-composer-input"]:visible')).toHaveCount(1, { timeout: 180_000 });
        await expect(page.getByText('FAKE_CODEX_DYNAMIC_OK_1_default_gpt-5.4_medium_fast')).toHaveCount(1, { timeout: 180_000 });

        await waitForLoggedRequest({
            requestLogPath: prepared.requestLogPath,
            predicate: (entry) => entry.method === 'thread/start'
                && entry.params?.model === 'gpt-5.4'
                && entry.params?.serviceTier === 'fast',
            timeoutMs: 60_000,
        });
        await waitForLoggedRequest({
            requestLogPath: prepared.requestLogPath,
            predicate: (entry) => entry.method === 'turn/start'
                && entry.params?.threadId === 'thread-started'
                && entry.params?.model === 'gpt-5.4'
                && entry.params?.serviceTier === 'fast',
            timeoutMs: 60_000,
        });
    });
});
