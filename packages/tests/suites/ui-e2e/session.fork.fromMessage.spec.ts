import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { createSessionFromNewSessionComposer } from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
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
  return createSessionFromNewSessionComposer(params);
}

test.describe('ui e2e: session fork from message', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-fork-from-message-suite');
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

  test('forks from an assistant message and does not show replay seed as a transcript message', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);

    await page.getByTestId('welcome-create-account').click();
    await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

    const testDir = resolve(join(suiteDir, 't1-fork-message'));
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
    const parentPrompt = `fork-parent-1 ${run.runId}`;
    const parentSessionId = await createSessionFromComposer({ page, uiBaseUrl, machineId, prompt: parentPrompt });

    await page.goto(`${uiBaseUrl}/session/${parentSessionId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByText('FAKE_CLAUDE_OK_1')).toHaveCount(1, { timeout: 180_000 });

    const parentPrompt2 = `fork-parent-2 ${run.runId}`;
    await page.locator('textarea[data-testid="session-composer-input"]:visible').fill(parentPrompt2);
    await page.locator('textarea[data-testid="session-composer-input"]:visible').press('Enter');
    await expect(page.getByText('FAKE_CLAUDE_OK_2')).toHaveCount(1, { timeout: 180_000 });

    // Ensure replay-fork is enabled (server sync can overwrite early settings changes).
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const targetWrapper = page.locator('[data-testid^="transcript-message-"]').filter({ hasText: 'FAKE_CLAUDE_OK_1' }).first();
      await expect(targetWrapper).toHaveCount(1, { timeout: 60_000 });
      await targetWrapper.hover();
      const wrapperTestId = await targetWrapper.getAttribute('data-testid');
      if (!wrapperTestId) throw new Error('missing wrapper test id');
      const messageId = wrapperTestId.replace(/^transcript-message-/, '');
      const forkButton = page.getByTestId(`transcript-message-fork:${messageId}`);
      if (await forkButton.count()) break;

      await page.goto(`${uiBaseUrl}/settings/session`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('settings-session-replay-enabled-item')).toHaveCount(1, { timeout: 60_000 });
      const replayItem = page.getByTestId('settings-session-replay-enabled-item');
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
      await page.goto(`${uiBaseUrl}/session/${parentSessionId}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });
    }

    const targetWrapper = page.locator('[data-testid^="transcript-message-"]').filter({ hasText: 'FAKE_CLAUDE_OK_1' }).first();
    await expect(targetWrapper).toHaveCount(1, { timeout: 60_000 });
    await targetWrapper.hover();
    const wrapperTestId = await targetWrapper.getAttribute('data-testid');
    if (!wrapperTestId) throw new Error('missing wrapper test id');
    const messageId = wrapperTestId.replace(/^transcript-message-/, '');

    await expect(page.getByTestId(`transcript-message-fork:${messageId}`)).toHaveCount(1, { timeout: 120_000 });
    await page.getByTestId(`transcript-message-fork:${messageId}`).click();

    await page.waitForURL(
      (url) => {
        try {
          const nextSessionId = parseSessionIdFromUrl(url.toString());
          return nextSessionId !== parentSessionId;
        } catch {
          return false;
        }
      },
      { timeout: 60_000 },
    );
    const childSessionId = parseSessionIdFromUrl(page.url());
    expect(childSessionId).not.toBe(parentSessionId);

    {
      const transcript = page.locator('[data-testid="transcript-chat-list"]:visible').first();
      await expect(transcript.locator(`[data-testid="transcript-fork-divider:${parentSessionId}:${childSessionId}"]`)).toHaveCount(1, { timeout: 120_000 });
    }

    // Hard refresh: fork context should still render without relying on in-memory caches.
    // This matches deep-link scenarios where the child session is opened directly.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });
    {
      const transcript = page.locator('[data-testid="transcript-chat-list"]:visible').first();
      await expect(transcript.locator(`[data-testid="transcript-fork-divider:${parentSessionId}:${childSessionId}"]`)).toHaveCount(1, { timeout: 120_000 });
    }

    await page.waitForFunction(
      (prompt) =>
        Array.from(document.querySelectorAll('[data-testid^="transcript-message-"]')).some((n) =>
          (n.textContent ?? '').includes(String(prompt)),
        ),
      parentPrompt,
      { timeout: 60_000 },
    );

    const transcriptMessageNodes = await page.locator('[data-testid^="transcript-message-"]').evaluateAll((nodes) =>
      nodes.map((n) => {
        const style = window.getComputedStyle(n);
        const rect = n.getBoundingClientRect();
        const visible =
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0;
        return {
          testId: n.getAttribute('data-testid') ?? '',
          text: (n.textContent ?? '').slice(0, 400),
          visible,
        };
      }),
    );
    const visibleTranscriptMessages = transcriptMessageNodes.filter((n) => n.visible);
    expect(visibleTranscriptMessages.some((n) => n.text.includes(parentPrompt))).toBe(true);
    expect(visibleTranscriptMessages.some((n) => n.text.includes(parentPrompt2))).toBe(false);

    const childPrompt = `fork-child-1 ${run.runId}`;
    await page.locator('textarea[data-testid="session-composer-input"]:visible').fill(childPrompt);
    await page.locator('textarea[data-testid="session-composer-input"]:visible').press('Enter');

    await page.waitForFunction(
      (prompt) =>
        Array.from(document.querySelectorAll('[data-testid^="transcript-message-"]')).some((n) =>
          (n.textContent ?? '').includes(String(prompt)),
        ),
      childPrompt,
      { timeout: 60_000 },
    );

    let childPromptEntry: any | null = null;
    const logDeadlineMs = Date.now() + 30_000;
    while (Date.now() < logDeadlineMs) {
      const fakeClaudeRaw = await readFile(fakeClaudeLogPath, 'utf8').catch(() => '');
      const fakeClaudeLines = fakeClaudeRaw
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as any;
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      const userPromptEntries = fakeClaudeLines.filter((entry) => entry?.type === 'sdk_stdin' && entry?.hasUserText === true);
      childPromptEntry = null;
      for (let index = userPromptEntries.length - 1; index >= 0; index -= 1) {
        const entry = userPromptEntries[index];
        if (typeof entry?.userTextPreview === 'string' && entry.userTextPreview.includes(childPrompt)) {
          childPromptEntry = entry;
          break;
        }
      }
      if (childPromptEntry) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(childPromptEntry).toBeTruthy();
    expect(String(childPromptEntry?.userTextPreview ?? '')).toContain(parentPrompt);
    expect(String(childPromptEntry?.userTextPreview ?? '')).toContain('FAKE_CLAUDE_OK_1');
    expect(String(childPromptEntry?.userTextPreview ?? '')).not.toContain(parentPrompt2);

    // Child session is expected to generate a new FAKE_CLAUDE_OK_1 response (new vendor session),
    // while also showing the read-only ancestor FAKE_CLAUDE_OK_1 message from the parent.
    await page.waitForFunction(
      ({ okText }) => {
        const wrappers = Array.from(document.querySelectorAll('[data-testid^="transcript-message-"]')).filter((n) => {
          const tid = n.getAttribute('data-testid') ?? '';
          // Only consider committed message wrappers, not fork/copy action buttons.
          if (!tid.startsWith('transcript-message-')) return false;
          if (tid.includes(':')) return false;
          return String(n.textContent ?? '').includes(String(okText));
        });
        const unique = new Set(wrappers.map((n) => n.getAttribute('data-testid') ?? ''));
        return unique.size >= 2;
      },
      { okText: 'FAKE_CLAUDE_OK_1' },
      { timeout: 180_000 },
    );

    await expect(
      page.getByText('This session is continuing from a previous Happy session that could not be vendor-resumed.'),
    ).toHaveCount(0, { timeout: 5_000 });

    // Fork-from-user-message semantics: fork before the committed user prompt and restore it as a draft.
    await page.goto(`${uiBaseUrl}/session/${parentSessionId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });

    const userWrapper = page.locator('[data-testid^="transcript-message-"]').filter({ hasText: parentPrompt2 }).first();
    await expect(userWrapper).toHaveCount(1, { timeout: 60_000 });
    await userWrapper.hover();
    const userWrapperTestId = await userWrapper.getAttribute('data-testid');
    if (!userWrapperTestId) throw new Error('missing user wrapper test id');
    const userMessageId = userWrapperTestId.replace(/^transcript-message-/, '');

    await expect(page.getByTestId(`transcript-message-fork:${userMessageId}`)).toHaveCount(1, { timeout: 120_000 });
    await page.getByTestId(`transcript-message-fork:${userMessageId}`).click();

    await page.waitForURL(
      (url) => {
        try {
          const nextSessionId = parseSessionIdFromUrl(url.toString());
          return nextSessionId !== parentSessionId && nextSessionId !== childSessionId;
        } catch {
          return false;
        }
      },
      { timeout: 60_000 },
    );
    const child2SessionId = parseSessionIdFromUrl(page.url());

    await expect(page.locator('textarea[data-testid="session-composer-input"]:visible')).toHaveValue(parentPrompt2, { timeout: 120_000 });
    {
      const transcript = page.locator('[data-testid="transcript-chat-list"]:visible').first();
      await expect(transcript.locator(`[data-testid="transcript-fork-divider:${parentSessionId}:${child2SessionId}"]`)).toHaveCount(1, { timeout: 120_000 });
      await expect(transcript.getByText(parentPrompt2)).toHaveCount(0, { timeout: 60_000 });
    }
  });
});
