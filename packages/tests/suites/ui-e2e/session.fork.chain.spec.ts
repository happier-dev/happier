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

async function fillAndClickSessionComposerSend(params: Readonly<{ page: Page; prompt: string; timeoutMs?: number }>): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 60_000;
  const input = params.page.getByTestId('session-composer-input');
  await expect(input).toHaveCount(1, { timeout: timeoutMs });
  await input.click({ timeout: timeoutMs });
  await input.fill(params.prompt);

  const sendButton = params.page.getByTestId('session-composer-send');
  await expect(sendButton).toHaveCount(1, { timeout: timeoutMs });
  await expect(sendButton).toBeEnabled({ timeout: timeoutMs });
  await sendButton.click({ timeout: timeoutMs });
}

async function createSessionFromComposer(params: {
  page: Page;
  uiBaseUrl: string;
  machineId: string;
  prompt: string;
}): Promise<string> {
  return createSessionFromNewSessionComposer(params);
}

type TranscriptMessageMatch = Readonly<{
  testId: string;
  messageId: string;
}>;

async function collectCommittedTranscriptMessageMatches(params: {
  page: Page;
  text: string;
}): Promise<TranscriptMessageMatch[]> {
  return await params.page.locator('[data-testid^="transcript-message-"]').evaluateAll((nodes, text) => {
    const targetText = String(text);
    return nodes.flatMap((node) => {
      const testId = node.getAttribute('data-testid') ?? '';
      if (!testId.startsWith('transcript-message-')) return [];
      if (testId.includes(':')) return [];
      if (!(node.textContent ?? '').includes(targetText)) return [];
      return [{
        testId,
        messageId: testId.replace(/^transcript-message-/, ''),
      }];
    });
  }, params.text);
}

async function waitForCommittedTranscriptMessageMatches(params: {
  page: Page;
  text: string;
  expectedCount: number;
  timeoutMs?: number;
}): Promise<TranscriptMessageMatch[]> {
  const timeoutMs = params.timeoutMs ?? 120_000;
  let matches: TranscriptMessageMatch[] = [];
  await expect.poll(async () => {
    matches = await collectCommittedTranscriptMessageMatches({ page: params.page, text: params.text });
    return matches.length;
  }, { timeout: timeoutMs }).toBe(params.expectedCount);
  return matches;
}

async function waitForCommittedTranscriptMessageMatch(params: {
  page: Page;
  text: string;
  timeoutMs?: number;
}): Promise<TranscriptMessageMatch> {
  const matches = await waitForCommittedTranscriptMessageMatches({
    page: params.page,
    text: params.text,
    expectedCount: 1,
    timeoutMs: params.timeoutMs,
  });
  const match = matches[0];
  if (!match) {
    throw new Error(`failed to locate committed transcript message matching text: ${params.text}`);
  }
  return match;
}

async function waitForCommittedTranscriptMessageMatchAfterTestId(params: {
  page: Page;
  text: string;
  afterTestId: string;
  timeoutMs?: number;
}): Promise<TranscriptMessageMatch> {
  const timeoutMs = params.timeoutMs ?? 120_000;
  let match: TranscriptMessageMatch | null = null;
  await expect.poll(async () => {
    match = await params.page.locator('[data-testid="transcript-chat-list"]').evaluateAll((roots, args) => {
      const targetText = String(args.text);
      const afterTestId = String(args.afterTestId);
      const root = roots[0];
      if (!root) return null;

      const nodes = Array.from(root.querySelectorAll('[data-testid]'));
      let afterIndex = -1;
      for (let index = 0; index < nodes.length; index += 1) {
        const testId = nodes[index]?.getAttribute('data-testid') ?? '';
        if (testId === afterTestId) {
          afterIndex = index;
          break;
        }
      }
      if (afterIndex < 0) return null;
      for (let index = afterIndex + 1; index < nodes.length; index += 1) {
        const node = nodes[index];
        const testId = node?.getAttribute('data-testid') ?? '';
        if (!testId.startsWith('transcript-message-')) continue;
        if (testId.includes(':')) continue;
        if (!(node.textContent ?? '').includes(targetText)) continue;
        return {
          testId,
          messageId: testId.replace(/^transcript-message-/, ''),
        };
      }
      return null;
    }, { text: params.text, afterTestId: params.afterTestId });
    return match !== null;
  }, { timeout: timeoutMs }).toBe(true);
  if (!match) {
    throw new Error(`failed to locate committed transcript message after ${params.afterTestId} matching text: ${params.text}`);
  }
  return match;
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

async function forkFromTranscriptMessage(params: {
  page: Page;
  messageId: string;
  currentSessionId: string;
}): Promise<string> {
  const message = params.page.getByTestId(`transcript-message-${params.messageId}`);
  await expect(message).toHaveCount(1, { timeout: 120_000 });
  await message.hover({ timeout: 120_000 });
  const forkButton = params.page.getByTestId(`transcript-message-fork:${params.messageId}`);
  await expect(forkButton).toHaveCount(1, { timeout: 120_000 });
  await forkButton.click();
  await params.page.waitForURL(
    (url) => {
      try {
        return parseSessionIdFromUrl(url.toString()) !== params.currentSessionId;
      } catch {
        return false;
      }
    },
    { timeout: 180_000 },
  );
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
    const parentOk1Match = await waitForCommittedTranscriptMessageMatch({
      page,
      text: 'FAKE_CLAUDE_OK_1',
      timeoutMs: 180_000,
    });
    await expect(page.getByTestId(parentOk1Match.testId)).toBeVisible({ timeout: 180_000 });

    const parentPrompt2 = `fork-chain-parent-2 ${run.runId}`;
    await fillAndClickSessionComposerSend({ page, prompt: parentPrompt2 });
    const parentOk2Match = await waitForCommittedTranscriptMessageMatch({
      page,
      text: 'FAKE_CLAUDE_OK_2',
      timeoutMs: 180_000,
    });
    await expect(page.getByTestId(parentOk2Match.testId)).toBeVisible({ timeout: 180_000 });

    await ensureReplayForkEnabled({ page, uiBaseUrl, sessionId: parentSessionId });

    const sessionBId = await forkFromTranscriptMessage({
      page,
      messageId: parentOk1Match.messageId,
      currentSessionId: parentSessionId,
    });
    {
      const transcript = page.locator('[data-testid="transcript-chat-list"]:visible').first();
      await expect(transcript.locator(`[data-testid="transcript-fork-divider:${parentSessionId}:${sessionBId}"]`)).toHaveCount(1, { timeout: 120_000 });
    }

    const childPrompt = `fork-chain-child-1 ${run.runId}`;
    await fillAndClickSessionComposerSend({ page, prompt: childPrompt });
    // Child session B starts a new vendor session; expect a new FAKE_CLAUDE_OK_1 while also showing
    // the read-only ancestor FAKE_CLAUDE_OK_1 from session A.
    const childViewOk1Matches = await waitForCommittedTranscriptMessageMatches({
      page,
      text: 'FAKE_CLAUDE_OK_1',
      expectedCount: 2,
      timeoutMs: 180_000,
    });
    expect(childViewOk1Matches.map((match) => match.testId)).toHaveLength(2);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });

    await waitForCommittedTranscriptMessageMatches({
      page,
      text: 'FAKE_CLAUDE_OK_1',
      expectedCount: 2,
      timeoutMs: 180_000,
    });

    const childPromptMatch = await waitForCommittedTranscriptMessageMatch({
      page,
      text: childPrompt,
      timeoutMs: 120_000,
    });

    const reloadedChildOk1Match = await waitForCommittedTranscriptMessageMatchAfterTestId({
      page,
      text: 'FAKE_CLAUDE_OK_1',
      afterTestId: `transcript-fork-divider:${parentSessionId}:${sessionBId}`,
      timeoutMs: 180_000,
    });

    // Fork from the committed child-session response after a reload so the nested fork chain stays stable.
    await expect(page.getByTestId(reloadedChildOk1Match.testId)).toBeVisible({ timeout: 120_000 });
    const sessionCId = await forkFromTranscriptMessage({
      page,
      messageId: reloadedChildOk1Match.messageId,
      currentSessionId: sessionBId,
    });
    {
      const transcript = page.locator('[data-testid="transcript-chat-list"]:visible').first();
      await expect(transcript.locator(`[data-testid="transcript-fork-divider:${parentSessionId}:${sessionBId}"]`)).toHaveCount(1, { timeout: 120_000 });
      await expect(transcript.locator(`[data-testid="transcript-fork-divider:${sessionBId}:${sessionCId}"]`)).toHaveCount(1, { timeout: 120_000 });
    }
    for (const match of childViewOk1Matches) {
      await expect(page.getByTestId(match.testId)).toBeVisible({ timeout: 120_000 });
    }
    await expect(page.getByTestId(`transcript-message-${childPromptMatch.messageId}`)).toBeVisible({ timeout: 120_000 });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });

    {
      const transcript = page.locator('[data-testid="transcript-chat-list"]:visible').first();
      await expect(transcript.locator(`[data-testid="transcript-fork-divider:${parentSessionId}:${sessionBId}"]`)).toHaveCount(1, { timeout: 120_000 });
      await expect(transcript.locator(`[data-testid="transcript-fork-divider:${sessionBId}:${sessionCId}"]`)).toHaveCount(1, { timeout: 120_000 });
    }
    const reloadedOk1Matches = await waitForCommittedTranscriptMessageMatches({
      page,
      text: 'FAKE_CLAUDE_OK_1',
      expectedCount: 2,
      timeoutMs: 120_000,
    });
    expect(reloadedOk1Matches.map((match) => match.testId)).toHaveLength(2);
    expect(reloadedOk1Matches.map((match) => match.testId).sort()).toEqual(childViewOk1Matches.map((match) => match.testId).sort());
    for (const match of reloadedOk1Matches) {
      await expect(page.getByTestId(match.testId)).toBeVisible({ timeout: 120_000 });
    }
    await expect(page.getByTestId(`transcript-message-${childPromptMatch.messageId}`)).toBeVisible({ timeout: 120_000 });

    const transcript = page.getByTestId('transcript-chat-list');
    await transcript.hover({ timeout: 60_000 });
    await transcript.click({ timeout: 60_000 });
    await page.mouse.wheel(0, -100_000);
    await page.mouse.wheel(0, 300);
    await page.mouse.wheel(0, -300);
    await expect(page.getByTestId(reloadedOk1Matches[0]!.testId)).toBeVisible({ timeout: 120_000 });
  });
});
