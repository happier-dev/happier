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
import { createSessionFromNewSessionComposer } from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
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
  return createSessionFromNewSessionComposer(params);
}

async function ensureReplayForkEnabled(params: { page: Page; uiBaseUrl: string; sessionId: string }): Promise<void> {
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

async function forkFromFirstMessageMatching(params: { page: Page; containsText: string; currentSessionId: string }): Promise<string> {
  const wrapper = params.page.locator('[data-testid^="transcript-message-"]').filter({ hasText: params.containsText }).first();
  await expect(wrapper).toHaveCount(1, { timeout: 60_000 });
  await wrapper.hover();
  const wrapperTestId = await wrapper.getAttribute('data-testid');
  if (!wrapperTestId) throw new Error('missing wrapper test id');
  const messageId = wrapperTestId.replace(/^transcript-message-/, '');
  await expect(params.page.getByTestId(`transcript-message-fork:${messageId}`)).toHaveCount(1, { timeout: 120_000 });
  await params.page.getByTestId(`transcript-message-fork:${messageId}`).click();
  const deadlineMs = Date.now() + 180_000;
  while (Date.now() < deadlineMs) {
    try {
      const next = parseSessionIdFromUrl(params.page.url());
      if (next !== params.currentSessionId) return next;
    } catch {
      // ignore - router may briefly navigate through non-session routes
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for fork navigation (url=${params.page.url()})`);
}

async function sendPromptAndWaitForOk(params: { page: Page; prompt: string; okNumber: number; timeoutMs?: number }): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 180_000;
  await params.page.locator('textarea[data-testid="session-composer-input"]:visible').fill(params.prompt);
  await params.page.locator('textarea[data-testid="session-composer-input"]:visible').press('Enter');
  await expect(params.page.getByText(params.prompt).first()).toHaveCount(1, { timeout: 60_000 });
  await expect(params.page.getByText(`FAKE_CLAUDE_OK_${params.okNumber}`).first()).toBeVisible({ timeout: timeoutMs });
}

async function nudgeTranscriptScrollToTop(page: Page): Promise<void> {
  const transcript = page.getByTestId('transcript-chat-list');
  await transcript.hover({ timeout: 60_000 });
  // Ensure the web transcript marks a trusted user scroll intent; otherwise the auto-repin logic can
  // fight synthetic scroll events in CI.
  await transcript.click({ timeout: 60_000 });

  // Prefer real user-ish scroll input: FlashList relies on native scroll events, and directly
  // writing `scrollTop` doesn't always trigger `onStartReached` on RNW.
  await page.mouse.wheel(0, -100_000);

  // Wiggle the scroll position so `onStartReached` can fire again after the list grows.
  await page.mouse.wheel(0, 300);
  await page.mouse.wheel(0, -300);
}

test.describe('ui e2e: fork ancestor paging across segments', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-fork-ancestor-paging-suite');
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

  test('loads older ancestor messages when scrolling past fork cutoff', async ({ page }) => {
    test.setTimeout(900_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);

    await page.getByTestId('welcome-create-account').click();
    await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

    const testDir = resolve(join(suiteDir, 't1-ancestor-paging'));
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

    const marker0 = `PARENT_MARKER_0 ${run.runId}`;
    const parentSessionId = await createSessionFromComposer({ page, uiBaseUrl, machineId, prompt: marker0 });

    await page.goto(`${uiBaseUrl}/session/${parentSessionId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByText('FAKE_CLAUDE_OK_1').first()).toBeVisible({ timeout: 180_000 });

    // Create enough turns to exceed a single transcript page (SESSION_MESSAGES_PAGE_SIZE=150).
    // Each turn yields a user + assistant message, so 80 turns ensures >150 total rows.
    for (let i = 1; i <= 80; i += 1) {
      await sendPromptAndWaitForOk({ page, prompt: `PARENT_MARKER_${i} ${run.runId}`, okNumber: i + 1 });
    }

    await ensureReplayForkEnabled({ page, uiBaseUrl, sessionId: parentSessionId });

    const forkTarget = `PARENT_MARKER_80 ${run.runId}`;
    await expect(page.getByText(forkTarget).first()).toBeVisible({ timeout: 60_000 });
    const childSessionId = await forkFromFirstMessageMatching({
      page,
      containsText: forkTarget,
      currentSessionId: parentSessionId,
    });

    {
      const transcript = page.locator('[data-testid="transcript-chat-list"]:visible').first();
      await expect(transcript.locator(`[data-testid="transcript-fork-divider:${parentSessionId}:${childSessionId}"]`)).toHaveCount(1, { timeout: 120_000 });
    }

    // Reload so ancestor context is sourced from paginated fetches, not in-memory state from the parent view.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });

    // Ensure the oldest marker isn't immediately visible (requires paging).
    await expect(page.getByText(marker0).first()).toHaveCount(0, { timeout: 10_000 });

    // Scroll upward repeatedly until the oldest marker appears (paging across the ancestor segment).
    const deadlineMs = Date.now() + 120_000;
    while (Date.now() < deadlineMs) {
      await nudgeTranscriptScrollToTop(page);
      const count = await page.getByText(marker0).count();
      if (count > 0) break;
      await new Promise((r) => setTimeout(r, 1_000));
    }

    await expect(page.getByText(marker0).first()).toBeVisible({ timeout: 120_000 });
  });
});
