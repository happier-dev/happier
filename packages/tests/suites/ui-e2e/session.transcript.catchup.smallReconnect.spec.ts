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
import { runCliJson } from '../../src/testkit/uiE2e/cliJson';

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

  await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 180_000 });
  return parseSessionIdFromUrl(page.url());
}

test.describe('ui e2e: transcript small reconnect catch-up', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-transcript-catchup-small-suite');
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
        HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '1000',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
        // Large gap threshold set high so reconnect uses incremental catch-up (`afterSeq=`) instead of a tail reset snapshot.
        EXPO_PUBLIC_HAPPIER_SYNC_TUNING_JSON: JSON.stringify({
          messageLargeGapSeq: 100,
          messageMaxIncrementalPagesOnResume: 3,
          transcriptForwardPrefetchThresholdPx: 800,
          messageCatchUpConcurrencyLimit: 1,
          resumeConcurrencyLimit: 2,
          bootstrapConcurrencyLimit: 3,
          changesPageLimit: 200,
        }),
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

  test('uses incremental afterSeq catch-up on reconnect when gap is small', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);

    await page.getByTestId('welcome-create-account').click();
    await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

    const testDir = resolve(join(suiteDir, 't1-reconnect-small'));
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
    const sessionId = await createSessionFromComposer({ page, uiBaseUrl, machineId, prompt: 'hello small gap' });

    await page.goto(`${uiBaseUrl}/session/${sessionId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });

    const requests: Array<{ url: string; ts: number }> = [];
    page.on('request', (req) => requests.push({ url: req.url(), ts: Date.now() }));

    await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 120_000 });
    await page.context().setOffline(true);
    await page.waitForTimeout(500);

    for (let i = 0; i < 5; i += 1) {
      const message = `missed small gap ${i} ${run.runId}`;
      const sendEnvelope = await runCliJson({
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        webappUrl: uiBaseUrl,
        env: { ...process.env, HOME: cliHomeDir },
        label: `session-send-missed-${i}`,
        args: ['session', 'send', sessionId, message, '--json'],
        timeoutMs: 120_000,
      });
      expect(sendEnvelope.ok).toBe(true);
      expect(sendEnvelope.kind).toBe('session_send');
    }

    const reconnectStart = Date.now();
    await page.context().setOffline(false);

    await expect
      .poll(
        async () => {
          const after = requests.filter((r) => r.ts >= reconnectStart).map((r) => r.url);
          const hasChanges = after.some((u) => u.includes('/v2/changes'));
          const hasAfterSeq = after.some(
            (u) => u.includes(`/v1/sessions/${sessionId}/messages?`) && u.includes('afterSeq='),
          );
          const hasSnapshot = after.some(
            (u) => u.includes(`/v1/sessions/${sessionId}/messages`) && !u.includes('afterSeq='),
          );
          return { hasChanges, hasAfterSeq, hasSnapshot, after };
        },
        { timeout: 60_000 },
      )
      .toMatchObject({ hasChanges: true, hasAfterSeq: true, hasSnapshot: false });
  });
});
