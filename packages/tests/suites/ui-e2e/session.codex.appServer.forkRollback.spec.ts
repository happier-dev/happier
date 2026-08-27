import { test, expect, type Locator, type Page } from '@playwright/test';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import {
  readFakeCodexAppServerRequestLog,
  writeFakeCodexAppServerScript,
  type FakeCodexAppServerRequest,
} from '../../src/testkit/codexAppServerRemoteHarness';
import { readCliAccessKey } from '../../src/testkit/cliAccessKey';
import { fetchJson } from '../../src/testkit/http';
import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { openNewSessionMachineSelection } from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { selectNewSessionAgent } from '../../src/testkit/uiE2e/selectNewSessionAgent';
import { selectSessionForkStrategy } from '../../src/testkit/uiE2e/selectSessionForkStrategy';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { waitFor } from '../../src/testkit/timing';

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
  predicate: (entry: FakeCodexAppServerRequest) => boolean;
  timeoutMs?: number;
}): Promise<void> {
  await waitFor(async () => {
    const entries = await readFakeCodexAppServerRequestLog(params.requestLogPath);
    return entries.some(params.predicate);
  }, {
    timeoutMs: params.timeoutMs ?? 60_000,
    intervalMs: 250,
    context: `expected request in ${params.requestLogPath}`,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function waitForEligibleServerTurn(params: Readonly<{
  baseUrl: string;
  token: string;
  sessionId: string;
  providerTurnId: string;
}>): Promise<void> {
  await waitFor(async () => {
    const response = await fetchJson<Record<string, unknown>>(
      `${params.baseUrl}/v1/sessions/${encodeURIComponent(params.sessionId)}/turns`,
      {
        headers: { Authorization: `Bearer ${params.token}` },
        timeoutMs: 15_000,
      },
    );
    if (response.status !== 200) return false;
    const turns = Array.isArray(response.data.turns) ? response.data.turns.filter(isRecord) : [];
    return turns.some((turn) => {
      const rollback = isRecord(turn.rollback) ? turn.rollback : null;
      const transcriptAnchors = isRecord(turn.transcriptAnchors) ? turn.transcriptAnchors : null;
      return turn.providerTurnId === params.providerTurnId
        && response.data.latestTurnId === turn.turnId
        && turn.status === 'completed'
        && rollback?.state === 'eligible'
        && typeof transcriptAnchors?.startUserMessageSeq === 'number';
    });
  }, {
    timeoutMs: 60_000,
    intervalMs: 250,
    context: `server rollback eligibility for provider turn ${params.providerTurnId}`,
  });
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
  await expect(page.getByTestId('new-session-composer-input')).toBeVisible({ timeout: 60_000 });
  await expect(page.getByTestId('agent-input-machine-chip')).toHaveCount(1, { timeout: 60_000 });

  await selectNewSessionAgent({ page, agentId: 'codex' });

  await openNewSessionMachineSelection({ page, uiBaseUrl });
  const machineOption = page.locator(
    `[data-testid="new-session-machine:${machineId}"], [data-testid="new-session-machine-option:${machineId}"]`,
  ).first();
  await expect(machineOption).toHaveCount(1, { timeout: 120_000 });
  await machineOption.click();

  await page.waitForURL((url) => url.pathname.endsWith('/new'), { timeout: 60_000 });
  await maybeDismissDetectedClisModal(page, { timeoutMs: 30_000 }).catch(() => false);
  await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId('new-session-composer-input')).toBeVisible({ timeout: 60_000 });

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
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(process.env));
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

    await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });

    const testDir = resolve(join(suiteDir, 't1-codex-app-server-fork-rollback'));
    await mkdir(testDir, { recursive: true });

    const fakeBinDir = resolve(join(testDir, 'fake-bin'));
    await mkdir(fakeBinDir, { recursive: true });
    const fakeCodexCliPath = resolve(join(fakeBinDir, process.platform === 'win32' ? 'codex.cmd' : 'codex'));
    await writeExecutableStub({ targetPath: fakeCodexCliPath, stdoutLine: 'codex 0.0.0-e2e' });

    const fakeCodexRequestLogPath = resolve(join(testDir, 'fake-codex-app-server.requests.jsonl'));
    const fakeCodexAppServerPath = await writeFakeCodexAppServerScript({
      dir: testDir,
      requestLogPath: fakeCodexRequestLogPath,
    });

    daemon = await authenticateAndStartDaemon({
      page,
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      uiBaseUrl,
      extraEnv: {
        ...process.env,
        HOME: cliHomeDir,
        CI: '1',
        PATH: process.platform === 'win32'
          ? `${fakeBinDir};${process.env.PATH ?? ''}`
          : `${fakeBinDir}:${process.env.PATH ?? ''}`,
        HAPPIER_CODEX_APP_SERVER_BIN: fakeCodexAppServerPath,
        HAPPIER_CODEX_APP_SERVER_RPC_TIMEOUT_MS: '10000',
      },
    });

    await setCodexBackendModeToAppServer(page, uiBaseUrl);

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
    // The first app-server turn includes runtime-owned session instructions before the
    // user prompt. Assert the unique user-prompt suffix rather than pretending the
    // fake server received the bare composer value as its complete input.
    await expect(page.getByText(`${parentPrompt}:done`, { exact: false })).toHaveCount(1, { timeout: 180_000 });

    await page.getByLabel('Open session actions').click();
    await expect(page.getByRole('button', { name: /Fork session/i })).toHaveCount(1, { timeout: 60_000 });
    await page.keyboard.press('Escape');

    const secondPrompt = `codex-app-server-parent-2 ${run.runId}`;
    const composer = page.locator('textarea[data-testid="session-composer-input"]:visible').first();
    await composer.fill(secondPrompt);
    await composer.press('Enter');
    await expect(page.getByText(`reply:${secondPrompt}:done`)).toHaveCount(1, { timeout: 180_000 });

    const accessKey = await readCliAccessKey(cliHomeDir);
    if (!accessKey) throw new Error('missing authenticated CLI access key for server turn discriminator');
    await waitForEligibleServerTurn({
      baseUrl: server.baseUrl,
      token: accessKey.token,
      sessionId: parentSessionId,
      providerTurnId: 'turn-2',
    });

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
    await expect(page.getByText(`reply:${thirdPrompt}:done`)).toHaveCount(1, { timeout: 180_000 });

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
    await selectSessionForkStrategy(page, 'native');

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
