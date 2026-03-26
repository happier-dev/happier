import { test, expect, type Locator, type Page } from '@playwright/test';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { openNewSessionMachineSelection } from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
import { approveTerminalConnect } from '../../src/testkit/uiE2e/approveTerminalConnect';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

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

async function waitForLatestMachineId(params: { suiteDir: string; timeoutMs?: number }): Promise<string> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return readLatestMachineIdFromServerLightDb({ suiteDir: params.suiteDir });
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return readLatestMachineIdFromServerLightDb({ suiteDir: params.suiteDir });
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

async function writeFakeCodexAppServerScript(params: { scriptPath: string; requestLogPath: string }): Promise<void> {
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
    '  await appendFile(requestLogPath, JSON.stringify({ id: msg.id ?? null, method: msg.method ?? null, params: msg.params ?? null }) + "\\n");',
    '  if (msg.method === "initialize") {',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { serverInfo: { name: "fake-codex-app-server", version: "0.0.0" } } }) + "\\n");',
    '    continue;',
    '  }',
    '  if (msg.method === "initialized") continue;',
    '  if (msg.method === "thread/start") {',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: "thread-started", model: "gpt-5.4", serviceTier: null } }) + "\\n");',
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
    '      process.stdout.write(JSON.stringify({ method: "item/completed", params: { item: { id: `msg-${turnCounter}`, type: "agentMessage", text: `FAKE_CODEX_APP_SERVER_OK_${turnCounter}` } } }) + "\\n");',
    '    }, 10);',
    '    setTimeout(() => {',
    '      process.stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId, turn: { id: turnId } } }) + "\\n");',
    '    }, 15);',
    '    continue;',
    '  }',
    '  if (msg.method === "thread/rollback") {',
    '    if (typeof msg.params?.numTurns !== "number" || msg.params.numTurns < 1 || typeof msg.params?.threadId !== "string" || msg.params.threadId.length === 0) {',
    '      process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32602, message: "thread/rollback requires { threadId, numTurns >= 1 }" } }) + "\\n");',
    '      continue;',
    '    }',
    '    process.stdout.write(JSON.stringify({ id: msg.id, result: { threadId: msg.params.threadId } }) + "\\n");',
    '    continue;',
    '  }',
    '  process.stdout.write(JSON.stringify({ id: msg.id, error: { code: -32601, message: "method not found" } }) + "\\n");',
    '}',
  ].join('\n');
  await writeFile(params.scriptPath, script, { encoding: 'utf8', mode: 0o755 });
}

async function writeExecutableStub(params: Readonly<{ targetPath: string; stdoutLine: string }>): Promise<void> {
  const line = params.stdoutLine.replaceAll('"', '\\"');
  const contents = process.platform === 'win32'
    ? `@echo off\r\necho ${line}\r\n`
    : `#!/bin/sh\necho "${line}"\n`;
  await writeFile(params.targetPath, contents, 'utf8');
  if (process.platform !== 'win32') {
    await chmod(params.targetPath, 0o755);
  }
}

async function waitForLoggedRequest(params: {
  requestLogPath: string;
  predicate: (entry: { id?: unknown; method?: unknown; params?: Record<string, unknown> | null }) => boolean;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const raw = await readFile(params.requestLogPath, 'utf8');
      const entries = raw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { id?: unknown; method?: unknown; params?: Record<string, unknown> | null });
      if (entries.some((entry) => params.predicate(entry))) {
        return;
      }
    } catch {
      // allow the poll loop to retry until the log exists and contains the request
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for expected request in ${params.requestLogPath}`);
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
    if (enabled) {
      await replayItem.click();
    }
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

async function maybeDismissDetectedClisModal(page: Page, opts?: Readonly<{ timeoutMs?: number }>): Promise<boolean> {
  const timeoutMs = opts?.timeoutMs ?? 5_000;
  const deadlineMs = Date.now() + timeoutMs;

  const modal = page.locator('[data-testid="detected-clis:modal"]:visible').first();
  while (Date.now() < deadlineMs) {
    if ((await modal.count()) > 0) break;
    await page.waitForTimeout(200);
  }

  if ((await modal.count()) === 0) return false;

  try {
    await page.getByTestId('detected-clis:ok').click({ timeout: 5_000 });
  } catch {
    try {
      await page.getByTestId('detected-clis:close').click({ timeout: 5_000 });
    } catch {
      await page.keyboard.press('Escape');
    }
  }

  await expect(modal).toHaveCount(0, { timeout: 60_000 });
  return true;
}

async function createCodexSessionFromComposer(params: {
  page: Page;
  uiBaseUrl: string;
  machineId: string;
  prompt: string;
}): Promise<string> {
  const { page, uiBaseUrl, machineId, prompt } = params;

  await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/new`);
  await maybeDismissDetectedClisModal(page).catch(() => false);
  await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId('agent-input-machine-chip')).toHaveCount(1, { timeout: 60_000 });
  await openNewSessionMachineSelection({ page, uiBaseUrl });
  await expect(page.getByTestId(`new-session-machine:${machineId}`)).toHaveCount(1, { timeout: 120_000 });
  await page.getByTestId(`new-session-machine:${machineId}`).click();

  await page.waitForURL((url) => url.pathname.endsWith('/new'), { timeout: 60_000 });
  await maybeDismissDetectedClisModal(page, { timeoutMs: 30_000 }).catch(() => false);

  // Agent options can depend on the selected machine (CLI availability), so pick machine first.
  // After the machine is selected, open the agent picker and select Codex.
  await expect(page.getByTestId('agent-input-agent-chip')).toHaveCount(1, { timeout: 60_000 });
  await page.getByTestId('agent-input-agent-chip').click();
  await maybeDismissDetectedClisModal(page, { timeoutMs: 30_000 }).catch(() => false);

  const openDialogs = page.locator('[role="dialog"][data-state="open"]');
  const topDialog = openDialogs.last();
  const dialogOption = topDialog.locator('[data-testid="new-session-agent:codex"]:visible').first();
  const inlineOption = page.locator('[data-testid="new-session-agent:codex"]:visible').first();
  const codexAgentRow = (await dialogOption.count()) > 0 ? dialogOption : inlineOption;
  await expect(codexAgentRow).toBeEnabled({ timeout: 60_000 });
  await codexAgentRow.scrollIntoViewIfNeeded().catch(() => {});
  await codexAgentRow.click();

  const applyButton = page.locator('[data-testid="agent-input-chip-picker.apply"]:visible').first();
  if ((await applyButton.count()) > 0) {
    await expect(applyButton).toBeEnabled({ timeout: 60_000 });
    await applyButton.click();
    await expect(applyButton).toHaveCount(0, { timeout: 60_000 }).catch(async () => {
      await page.keyboard.press('Escape').catch(() => {});
      await expect(page.locator('[data-testid="agent-input-chip-picker.apply"]:visible')).toHaveCount(0, { timeout: 60_000 });
    });
  }

  await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 60_000 });
  await page.getByTestId('new-session-composer-input').fill(prompt);
  await page.getByTestId('new-session-composer-input').press('Enter');
  await expect(page.locator('textarea[data-testid="session-composer-input"]:visible')).toHaveCount(1, { timeout: 180_000 });
  return parseSessionIdFromUrl(page.url());
}

async function readMessageActionHandle(page: Page, text: string): Promise<{ wrapper: Locator; messageId: string }> {
  const wrapper = page.locator('[data-testid^="transcript-message-"]').filter({ hasText: text }).first();
  await expect(wrapper).toHaveCount(1, { timeout: 120_000 });
  const wrapperTestId = await wrapper.getAttribute('data-testid');
  if (!wrapperTestId) throw new Error(`missing wrapper test id for message: ${text}`);
  return { wrapper, messageId: wrapperTestId.replace(/^transcript-message-/, '') };
}

function rollbackButtonForMessage(page: Page, messageId: string): Locator {
  return page.getByTestId(`transcript-message-rollback:${messageId}`);
}

test.describe('ui e2e: Codex app-server fork and rollback', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-codex-app-server-fork-rollback-suite');
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
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-codex-app-server`,
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

  test('shows rollback affordance and forks from the header with replay disabled', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);

    await page.getByTestId('welcome-create-account').click();
    await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

    const testDir = resolve(join(suiteDir, 't1-codex-app-server-fork-rollback'));
    await mkdir(testDir, { recursive: true });

    const fakeBinDir = resolve(join(testDir, 'fake-bin'));
    await mkdir(fakeBinDir, { recursive: true });
    const fakeCodexCliPath = resolve(join(fakeBinDir, process.platform === 'win32' ? 'codex.cmd' : 'codex'));
    await writeExecutableStub({ targetPath: fakeCodexCliPath, stdoutLine: 'codex 0.0.0-e2e' });

    const fakeCodexAppServerPath = resolve(join(testDir, 'fake-codex-app-server.mjs'));
    const fakeCodexRequestLogPath = resolve(join(testDir, 'fake-codex-app-server.requests.jsonl'));
    await writeFakeCodexAppServerScript({ scriptPath: fakeCodexAppServerPath, requestLogPath: fakeCodexRequestLogPath });

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
        PATH: process.platform === 'win32'
          ? `${fakeBinDir};${process.env.PATH ?? ''}`
          : `${fakeBinDir}:${process.env.PATH ?? ''}`,
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
    await setSessionReplayEnabled(page, uiBaseUrl, false);

    const machineId = await waitForLatestMachineId({ suiteDir, timeoutMs: 120_000 });
    const parentPrompt = `codex-app-server-parent-1 ${run.runId}`;
    const parentSessionId = await createCodexSessionFromComposer({
      page,
      uiBaseUrl,
      machineId,
      prompt: parentPrompt,
    });

    await page.goto(`${uiBaseUrl}/session/${parentSessionId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByText('FAKE_CODEX_APP_SERVER_OK_1')).toHaveCount(1, { timeout: 180_000 });

    await page.getByLabel('Open session actions').click();
    await expect(page.getByRole('button', { name: /Fork session/i })).toHaveCount(1, { timeout: 60_000 });
    await page.keyboard.press('Escape');

    const secondPrompt = `codex-app-server-parent-2 ${run.runId}`;
    const composer = page.locator('textarea[data-testid="session-composer-input"]:visible').first();
    await composer.fill(secondPrompt);
    await composer.press('Enter');
    await expect(page.getByText('FAKE_CODEX_APP_SERVER_OK_2')).toHaveCount(1, { timeout: 180_000 });

    const secondPromptMessage = await readMessageActionHandle(page, secondPrompt);

    await secondPromptMessage.wrapper.hover();
    await expect(rollbackButtonForMessage(page, secondPromptMessage.messageId)).toHaveCount(1, { timeout: 60_000 });
    await rollbackButtonForMessage(page, secondPromptMessage.messageId).click();

    await waitForLoggedRequest({
      requestLogPath: fakeCodexRequestLogPath,
      timeoutMs: 60_000,
      predicate: (entry) => entry.method === 'thread/rollback'
        && typeof entry.params?.threadId === 'string'
        && entry.params.threadId.length > 0
        && entry.params?.numTurns === 1,
    });

    await expect(composer).toHaveValue(secondPrompt, { timeout: 60_000 });

    const firstPromptMessage = await readMessageActionHandle(page, parentPrompt);
    await firstPromptMessage.wrapper.hover();
    await expect(rollbackButtonForMessage(page, firstPromptMessage.messageId)).toHaveCount(1, { timeout: 60_000 });

    const thirdPrompt = `codex-app-server-parent-3 ${run.runId}`;
    await composer.fill(thirdPrompt);
    await composer.press('Enter');
    await expect(page.getByText('FAKE_CODEX_APP_SERVER_OK_3')).toHaveCount(1, { timeout: 180_000 });

    await firstPromptMessage.wrapper.hover();
    await expect(rollbackButtonForMessage(page, firstPromptMessage.messageId)).toHaveCount(1, { timeout: 60_000 });
    await rollbackButtonForMessage(page, firstPromptMessage.messageId).click();

    await waitForLoggedRequest({
      requestLogPath: fakeCodexRequestLogPath,
      timeoutMs: 60_000,
      predicate: (entry) => entry.method === 'thread/rollback'
        && typeof entry.params?.threadId === 'string'
        && entry.params.threadId.length > 0
        && entry.params?.numTurns === 2,
    });

    await expect(composer).toHaveValue(parentPrompt, { timeout: 60_000 });

    await page.getByLabel('Open session actions').click();
    await expect(page.getByRole('button', { name: /Fork session/i })).toHaveCount(1, { timeout: 60_000 });
    await page.getByRole('button', { name: /Fork session/i }).click();

    await page.waitForURL(
      (url) => {
        try {
          return parseSessionIdFromUrl(url.toString()) !== parentSessionId;
        } catch {
          return false;
        }
      },
      { timeout: 120_000 },
    );

    const childSessionId = parseSessionIdFromUrl(page.url());
    expect(childSessionId).not.toBe(parentSessionId);

    const transcript = page.locator('[data-testid="transcript-chat-list"]:visible').first();
    await expect(transcript.locator(`[data-testid="transcript-fork-divider:${parentSessionId}:${childSessionId}"]`)).toHaveCount(1, {
      timeout: 120_000,
    });
  });
});
