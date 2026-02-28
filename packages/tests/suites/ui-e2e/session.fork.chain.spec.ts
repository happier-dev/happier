import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
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

async function createSessionFromComposer(params: {
  page: Page;
  uiBaseUrl: string;
  machineId: string;
  prompt: string;
}): Promise<string> {
  const { page, uiBaseUrl, machineId, prompt } = params;
  await page.goto(`${uiBaseUrl}/new`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 60_000 });
  await expect(page.getByTestId('agent-input-machine-chip')).toHaveCount(1, { timeout: 120_000 });
  await page.getByTestId('agent-input-machine-chip').click();
  await expect(page.getByTestId(`new-session-machine:${machineId}`)).toHaveCount(1, { timeout: 120_000 });
  await page.getByTestId(`new-session-machine:${machineId}`).click();
  await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 60_000 });

  await page.getByTestId('new-session-composer-input').fill(prompt);
  await page.getByTestId('new-session-composer-input').press('Enter');

  await expect(page.locator('textarea[data-testid="session-composer-input"]:visible')).toHaveCount(1, { timeout: 180_000 });
  return parseSessionIdFromUrl(page.url());
}

async function ensureReplayForkEnabled(params: { page: Page; uiBaseUrl: string; sessionId: string }): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const targetWrapper = params.page.locator('[data-testid^="transcript-message-"]').filter({ hasText: 'FAKE_CLAUDE_OK_1' }).first();
    await expect(targetWrapper).toHaveCount(1, { timeout: 60_000 });
    await targetWrapper.hover();
    const wrapperTestId = await targetWrapper.getAttribute('data-testid');
    if (!wrapperTestId) throw new Error('missing wrapper test id');
    const messageId = wrapperTestId.replace(/^transcript-message-/, '');
    const forkButton = params.page.getByTestId(`transcript-message-fork:${messageId}`);
    if (await forkButton.count()) return;

    await params.page.goto(`${params.uiBaseUrl}/settings/session`, { waitUntil: 'domcontentloaded' });
    await expect(params.page.getByTestId('settings-session-replay-enabled-item')).toHaveCount(1, { timeout: 60_000 });
    const replayItem = params.page.getByTestId('settings-session-replay-enabled-item');
    const replaySwitch = replayItem.locator('input[type="checkbox"]').first();
    const hasSwitch = (await replaySwitch.count()) > 0;
    if (hasSwitch) {
      const checked = await replaySwitch.isChecked().catch(() => false);
      if (!checked) {
        await replayItem.click();
        await expect(replaySwitch).toBeChecked({ timeout: 60_000 });
      }
    } else {
      await replayItem.click();
    }

    await params.page.goto(`${params.uiBaseUrl}/session/${params.sessionId}`, { waitUntil: 'domcontentloaded' });
    await expect(params.page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });
  }
}

async function forkFromFirstMessageMatching(params: { page: Page; containsText: string; currentSessionId: string }): Promise<string> {
  const wrapper = params.page.locator('[data-testid^="transcript-message-"]').filter({ hasText: params.containsText }).first();
  await expect(wrapper).toHaveCount(1, { timeout: 60_000 });
  await wrapper.hover();
  const wrapperTestId = await wrapper.getAttribute('data-testid');
  if (!wrapperTestId) throw new Error('missing wrapper test id');
  const messageId = wrapperTestId.replace(/^transcript-message-/, '');
  await expect(params.page.getByTestId(`transcript-message-fork:${messageId}`)).toHaveCount(1, { timeout: 120_000 });
  await params.page.getByTestId(`transcript-message-fork:${messageId}`).click();
  await params.page.waitForURL((url) => {
    try {
      const nextSessionId = parseSessionIdFromUrl(url.toString());
      return nextSessionId !== params.currentSessionId;
    } catch {
      return false;
    }
  }, { timeout: 180_000 });
  return parseSessionIdFromUrl(params.page.url());
}

test.describe('ui e2e: multi-level session fork chain', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-fork-chain-suite');
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

  test('renders fork chain dividers and ancestor context after reload', async ({ page }) => {
    test.setTimeout(600_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);

    await page.getByTestId('welcome-create-account').click();
    await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

    const testDir = resolve(join(suiteDir, 't1-fork-chain'));
    await mkdir(testDir, { recursive: true });

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
    await cliLogin.stop().catch(() => {});

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
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
        HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
        HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
      },
    });

    const machineId = await waitForLatestMachineId({ suiteDir, timeoutMs: 120_000 });

    const parentPrompt = `fork-chain-parent-1 ${run.runId}`;
    const parentSessionId = await createSessionFromComposer({ page, uiBaseUrl, machineId, prompt: parentPrompt });

    await page.goto(`${uiBaseUrl}/session/${parentSessionId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByText('FAKE_CLAUDE_OK_1').first()).toBeVisible({ timeout: 180_000 });

    const parentPrompt2 = `fork-chain-parent-2 ${run.runId}`;
    await page.locator('textarea[data-testid="session-composer-input"]:visible').fill(parentPrompt2);
    await page.locator('textarea[data-testid="session-composer-input"]:visible').press('Enter');
    await expect(page.getByText('FAKE_CLAUDE_OK_2').first()).toBeVisible({ timeout: 180_000 });

    await ensureReplayForkEnabled({ page, uiBaseUrl, sessionId: parentSessionId });

    const sessionBId = await forkFromFirstMessageMatching({ page, containsText: 'FAKE_CLAUDE_OK_1', currentSessionId: parentSessionId });
    await expect(page.getByTestId(`transcript-fork-divider:${sessionBId}`)).toHaveCount(1, { timeout: 120_000 });

    await expect(page.getByText('FAKE_CLAUDE_OK_1').first()).toBeVisible({ timeout: 120_000 });

    const childPrompt = `fork-chain-child-1 ${run.runId}`;
    await page.locator('textarea[data-testid="session-composer-input"]:visible').fill(childPrompt);
    await page.locator('textarea[data-testid="session-composer-input"]:visible').press('Enter');
    await expect(page.getByText('FAKE_CLAUDE_OK_3').first()).toBeVisible({ timeout: 180_000 });

    const sessionCId = await forkFromFirstMessageMatching({ page, containsText: 'FAKE_CLAUDE_OK_3', currentSessionId: sessionBId });
    await expect(page.getByTestId(`transcript-fork-divider:${sessionBId}`)).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId(`transcript-fork-divider:${sessionCId}`)).toHaveCount(1, { timeout: 120_000 });

    await expect(page.getByText('FAKE_CLAUDE_OK_1').first()).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText('FAKE_CLAUDE_OK_3').first()).toBeVisible({ timeout: 120_000 });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });

    await expect(page.getByTestId(`transcript-fork-divider:${sessionBId}`)).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId(`transcript-fork-divider:${sessionCId}`)).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByText('FAKE_CLAUDE_OK_1').first()).toBeVisible({ timeout: 120_000 });
    await expect(page.getByText('FAKE_CLAUDE_OK_3').first()).toBeVisible({ timeout: 120_000 });
  });
});
