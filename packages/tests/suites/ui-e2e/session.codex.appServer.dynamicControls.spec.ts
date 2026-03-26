import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
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

async function readDaemonMachineIdFromHappyHomeDir(params: Readonly<{ happyHomeDir: string }>): Promise<string> {
    const serversDir = resolve(join(params.happyHomeDir, 'servers'));
    const entries = await readdir(serversDir, { withFileTypes: true }).catch(() => []);
    const candidates: Array<{ path: string; mtimeMs: number }> = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const statePath = resolve(join(serversDir, entry.name, 'daemon.state.json'));
        const stateStat = await stat(statePath).catch(() => null);
        if (!stateStat) continue;
        candidates.push({ path: statePath, mtimeMs: stateStat.mtimeMs });
    }
    candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const newest = candidates[0]?.path;
    if (!newest) throw new Error(`Failed to locate daemon.state.json under ${serversDir}`);

    const raw = await readFile(newest, 'utf8');
    const parsed = JSON.parse(raw) as { machineId?: unknown } | null;
    const machineId = parsed?.machineId;
    if (typeof machineId !== 'string' || !machineId.trim()) {
        throw new Error(`Missing machineId in daemon state file: ${newest}`);
    }
    return machineId.trim();
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

    const machineId = await readDaemonMachineIdFromHappyHomeDir({ happyHomeDir: resolve(join(params.testDir, 'cli-home')) });
    return { daemon, requestLogPath, machineId };
}

async function maybeSelectAiBackendFromDialog(page: Page, backendLabel: string): Promise<boolean> {
    const pickerDialog = page.getByRole('dialog').filter({ hasText: 'Select AI Backend' }).first();
    if ((await pickerDialog.count()) === 0) return false;

    await expect(pickerDialog).toContainText('Select AI Backend', { timeout: 60_000 });
    await pickerDialog.getByText(backendLabel, { exact: true }).click();

    await expect(pickerDialog).toHaveCount(0, { timeout: 60_000 }).catch(async () => {
        await page.keyboard.press('Escape').catch(() => {});
        await expect(pickerDialog).toHaveCount(0, { timeout: 10_000 });
    });
    return true;
}

async function selectCodexAgentAndMachine(params: Readonly<{ page: Page; uiBaseUrl: string; machineId: string }>): Promise<void> {
    await gotoDomContentLoadedWithRetries(params.page, `${params.uiBaseUrl}/new`);

    await expect(params.page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 180_000 });
    await expect(params.page.getByTestId('new-session-composer-input')).toBeVisible({ timeout: 180_000 });

    await expect(params.page.getByTestId('agent-input-machine-chip')).toHaveCount(1, { timeout: 120_000 });
    const machineSelectionResult = await openNewSessionMachineSelection({ page: params.page, uiBaseUrl: params.uiBaseUrl });
    const pickDeadlineMs = Date.now() + 120_000;
    while (true) {
        const machineOption = params.page.locator(`[data-testid="new-session-machine:${params.machineId}"]:visible`).first();

        if ((await machineOption.count()) > 0) {
            await expect(machineOption).toBeEnabled({ timeout: 120_000 });
            await machineOption.click();
            break;
        }

        if (machineSelectionResult === 'returned_to_new') {
            break;
        }

        if (Date.now() > pickDeadlineMs) {
            await expect(machineOption).toHaveCount(1, { timeout: 1_000 });
        }

        await params.page.waitForTimeout(250);
    }
    await params.page.waitForURL((url) => url.pathname.endsWith('/new'), { timeout: 60_000 });

    // Prefer the New Session Wizard's inline backend list (no overlays) over the agent-input chip pickers.
    const codexOption = params.page.getByTestId('new-session-agent:codex');
    if ((await codexOption.count()) > 0) {
        await codexOption.scrollIntoViewIfNeeded().catch(() => {});
        await expect(codexOption).toBeEnabled({ timeout: 120_000 });
        await codexOption.click();
    } else {
        await maybeSelectAiBackendFromDialog(params.page, 'Codex').catch(() => false);
    }

    const pathChip = params.page.getByTestId('agent-input-path-chip');
    if ((await pathChip.count()) > 0) {
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
        return;
    }

    const pathSelectorInput = params.page.getByTestId('path-selector-input');
    await expect(pathSelectorInput).toHaveCount(1, { timeout: 60_000 });
    const pathValue = (await pathSelectorInput.inputValue().catch(() => '')) ?? '';
    const looksLikePath = /^[A-Za-z]:[\\/]/.test(pathValue) || /[\\/]/.test(pathValue);
    if (!looksLikePath) {
        const selectedPath = '/tmp';
        await pathSelectorInput.fill(selectedPath);
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
    try {
        await expect(option).toHaveCount(1, { timeout: 120_000 });
        await option.click();
    } catch (error) {
        const visibleOptionIds = await page.locator('[data-testid^="model-picker-overlay-selected-option-control-option:"]').evaluateAll((nodes) => {
            return nodes
                .map((node) => node.getAttribute('data-testid'))
                .filter((value): value is string => typeof value === 'string' && value.length > 0);
        }).catch(() => []);

        throw new Error(
            `Expected model control option ${controlId}:${valueId}, but visible options were: ${
                visibleOptionIds.length > 0 ? visibleOptionIds.join(', ') : '(none)'
            }`,
            { cause: error as Error },
        );
    }
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
        const uiWebEnv = process.env;
        test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
        server = await startServerLight({
            testDir: suiteDir,
            dbProvider: 'sqlite',
            extraEnv: {
                HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
                // Presence updates are throttled in the DB; keep the presence timeout comfortably above
                // that threshold so the UI doesn't briefly classify the daemon machine as "offline".
                HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '300000',
                HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '300000',
                HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '1000',
                // UI e2e runs after workspace typechecks/builds in the pipeline runner; avoid
                // expensive shared-deps/provider-generation work here to reduce beforeAll flake.
                HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
                HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE: '1',
                HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
            },
        });

        ui = await startUiWeb({
            testDir: suiteDir,
            env: {
                ...uiWebEnv,
                HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS: uiWebEnv.HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS ?? '900000',
                EXPO_PUBLIC_DEBUG: '1',
                EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS: uiWebEnv.EXPO_PUBLIC_HAPPIER_MACHINE_ONLINE_GRACE_MS ?? '300000',
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
        await page.setViewportSize({ width: 390, height: 844 });

        await ensureSignedIn(page, uiBaseUrl);
        const prepared = await connectDaemonWithFakeCodexAppServer({ page, suiteDir, testDir, server, uiBaseUrl });
        daemon = prepared.daemon;

        await selectCodexAgentAndMachine({ page, uiBaseUrl, machineId: prepared.machineId });
        await openAgentActionMenu(page);
        await clickSessionModeOption(page, 'plan');

        // Ensure no picker overlays remain open before re-opening the agent/model selector.
        const actionMenuOverlay = page.getByTestId('agent-input-action-menu-overlay');
        if ((await actionMenuOverlay.count()) > 0) {
            await page.keyboard.press('Escape');
            await expect(actionMenuOverlay).toHaveCount(0, { timeout: 60_000 });
        }

        const wizardModelMini = page.getByTestId('new-session-model:gpt-5.4-mini');
        if ((await wizardModelMini.count()) === 0) {
            await page.getByTestId('agent-input-agent-chip').click();
        }
        await clickModelSelectionOption(page, 'gpt-5.4-mini');
        await clickSelectedModelControlOption(page, 'reasoning_effort', 'high');

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
        await page.setViewportSize({ width: 390, height: 844 });

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

        const wizardModelMini = page.getByTestId('new-session-model:gpt-5.4-mini');
        if ((await wizardModelMini.count()) === 0) {
            await page.getByTestId('agent-input-agent-chip').click();
        }
        await clickModelSelectionOption(page, 'gpt-5.4-mini');
        await clickSelectedModelControlOption(page, 'reasoning_effort', 'high');

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

        const wizardModelFrontier = page.getByTestId('new-session-model:gpt-5.4');
        if ((await wizardModelFrontier.count()) === 0) {
            await page.getByTestId('agent-input-agent-chip').click();
        }
        await clickModelSelectionOption(page, 'gpt-5.4');
        await clickSelectedModelControlOption(page, 'reasoning_effort', 'medium');

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
        await page.setViewportSize({ width: 390, height: 844 });

        await ensureSignedIn(page, uiBaseUrl);
        const prepared = await connectDaemonWithFakeCodexAppServer({ page, suiteDir, testDir, server, uiBaseUrl });
        daemon = prepared.daemon;

        await selectCodexAgentAndMachine({ page, uiBaseUrl, machineId: prepared.machineId });
        const wizardModelMini = page.getByTestId('new-session-model:gpt-5.4-mini');
        if ((await wizardModelMini.count()) === 0) {
            await page.getByTestId('agent-input-agent-chip').click();
        }
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
