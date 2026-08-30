import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import {
  fakeClaudeFixturePath,
  waitForFakeClaudeInvocation,
  waitForFakeClaudeLocalStdinText,
} from '../../src/testkit/fakeClaude';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { createSessionFromNewSessionComposer } from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
import { enableClaudeUnifiedTerminal } from '../../src/testkit/uiE2e/enableClaudeUnifiedTerminal';
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
    // Pollers retry while daemon registration reaches the server-light db.
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

async function countVisibleCommittedTranscriptMessagesWithText(page: Page, text: string): Promise<number> {
  return page.locator('[data-testid^="transcript-message-"]').evaluateAll((nodes, expectedText) => {
    return nodes.filter((node) => {
      const testId = node.getAttribute('data-testid') ?? '';
      if (!testId.startsWith('transcript-message-')) return false;
      if (testId.includes(':')) return false;
      if (!String(node.textContent ?? '').includes(String(expectedText))) return false;

      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    }).length;
  }, text);
}

async function expectVisibleCommittedTranscriptMessageCount(
  page: Page,
  text: string,
  expectedCount: number,
  timeoutMs = 120_000,
): Promise<void> {
  await page.waitForFunction(
    ({ expectedText, expected }) => {
      const nodes = Array.from(document.querySelectorAll('[data-testid^="transcript-message-"]'));
      const count = nodes.filter((node) => {
        const testId = node.getAttribute('data-testid') ?? '';
        if (!testId.startsWith('transcript-message-')) return false;
        if (testId.includes(':')) return false;
        if (!String(node.textContent ?? '').includes(String(expectedText))) return false;

        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      }).length;
      return count === expected;
    },
    { expectedText: text, expected: expectedCount },
    { timeout: timeoutMs },
  );

  expect(await countVisibleCommittedTranscriptMessagesWithText(page, text)).toBe(expectedCount);
}

test.describe('ui e2e: Claude unified create/send/hydrate', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('claude-unified-create-send-hydrate-suite');
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
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
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

  test('creates a unified Claude session and streams UI-submitted turns live without duplicate user rows', async ({ page }) => {
    test.setTimeout(600_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);

    const testDir = resolve(join(suiteDir, 't1-create-send-hydrate'));
    const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
    const fakeClaudePath = fakeClaudeFixturePath();
    await mkdir(testDir, { recursive: true });

    daemon = await authenticateAndStartDaemon({
      page,
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      uiBaseUrl,
      extraEnv: {
        ...process.env,
        HOME: cliHomeDir,
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
        HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-unified-session-${run.runId}`,
        HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-unified-invocation-${run.runId}`,
      },
    });

    await enableClaudeUnifiedTerminal({ page, uiBaseUrl });

    const machineId = await waitForLatestMachineId({ suiteDir, timeoutMs: 120_000 });
    const firstPrompt = `claude unified first prompt ${run.runId}`;
    const { sessionId } = await createSessionFromNewSessionComposer({ page, uiBaseUrl, machineId, prompt: firstPrompt });

    const invocation = await waitForFakeClaudeInvocation(
      fakeClaudeLogPath,
      (event) => event.mode === 'local' && event.argv.includes('--settings') && event.argv.includes('--plugin-dir'),
      { timeoutMs: 120_000, pollMs: 100 },
    );
    expect(invocation.mode).toBe('local');
    expect(invocation.argv).not.toContain('--output-format');
    expect(invocation.argv).not.toContain('stream-json');

    await waitForFakeClaudeLocalStdinText(
      fakeClaudeLogPath,
      (text) => text.includes(firstPrompt),
      { timeoutMs: 120_000, pollMs: 100 },
    );

    await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });
    await expectVisibleCommittedTranscriptMessageCount(page, firstPrompt, 1);
    await expectVisibleCommittedTranscriptMessageCount(page, 'FAKE_CLAUDE_LOCAL_OK_1', 1, 180_000);

    const secondPrompt = `claude unified second prompt ${run.runId}`;
    const composer = page.locator('textarea[data-testid="session-composer-input"]:visible').first();
    await expect(composer).toHaveCount(1, { timeout: 120_000 });
    await composer.fill(secondPrompt);
    await page.getByTestId('session-composer-send').click();

    await expect(page).toHaveURL(new RegExp(`/session/${sessionId}(?:\\?.*)?$`), { timeout: 60_000 });
    await expectVisibleCommittedTranscriptMessageCount(page, secondPrompt, 1);
    await expectVisibleCommittedTranscriptMessageCount(page, 'FAKE_CLAUDE_LOCAL_OK_2', 1, 180_000);
  });
});
