import { test, expect } from '@playwright/test';
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
import { createSessionFromNewSessionComposer } from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';

const run = createRunDirs({ runLabel: 'ui-e2e' });

function resolveServerLightSqliteDbPath(params: { suiteDir: string }): string {
  return resolve(join(params.suiteDir, 'server-light-data', 'happier-server-light.sqlite'));
}

function readLatestMachineIdFromServerLightDb(params: { suiteDir: string }): string {
  const dbPath = resolveServerLightSqliteDbPath({ suiteDir: params.suiteDir });
  const raw = execFileSync('sqlite3', ['-json', dbPath, 'select id from Machine order by createdAt desc limit 1;'], {
    encoding: 'utf8',
  });
  const parsed = JSON.parse(raw) as Array<{ id?: unknown }>;
  const id = parsed?.[0]?.id;
  if (typeof id === 'string' && id.trim()) return id.trim();
  throw new Error(`Failed to read machine id from server light sqlite db: ${dbPath}`);
}

async function waitForLatestMachineId(params: { suiteDir: string; timeoutMs?: number }): Promise<string> {
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

test.describe('ui e2e: server retention visibility', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('server-retention-visibility-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let secondaryServer: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    test.setTimeout(420_000);
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(resolve(join(cliHomeDir, 'AGENTS.md')), '# UI retention fixture\n', 'utf8');

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        HAPPIER_SERVER_RETENTION__ENABLED: '1',
        HAPPIER_SERVER_RETENTION__INTERVAL_MS: '200',
        HAPPIER_SERVER_RETENTION__SESSIONS__MODE: 'delete_inactive',
        HAPPIER_SERVER_RETENTION__SESSIONS__INACTIVITY_DAYS: '30',
        HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__MODE: 'delete_older_than',
        HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__DAYS: '45',
      },
    });

    secondaryServer = await startServerLight({
      testDir: resolve(join(suiteDir, 'secondary-server')),
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        HAPPIER_SERVER_RETENTION__ENABLED: '1',
        HAPPIER_SERVER_RETENTION__INTERVAL_MS: '200',
        HAPPIER_SERVER_RETENTION__SESSIONS__MODE: 'delete_inactive',
        HAPPIER_SERVER_RETENTION__SESSIONS__INACTIVITY_DAYS: '60',
        HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__MODE: 'delete_older_than',
        HAPPIER_SERVER_RETENTION__ACCOUNT_CHANGES__DAYS: '90',
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
    await secondaryServer?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('shows server retention in server settings and session info for the active server', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !secondaryServer || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
    await expect(page.getByTestId('welcome-create-account')).toHaveCount(1, { timeout: 120_000 });
    await page.getByTestId('welcome-create-account').click();
    await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

    const testDir = resolve(join(suiteDir, 't1-retention-visibility'));
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
        HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
        HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
        HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
      },
    });

    const machineId = await waitForLatestMachineId({ suiteDir, timeoutMs: 120_000 });
    const sessionId = await createSessionFromNewSessionComposer({
      page,
      uiBaseUrl,
      machineId,
      prompt: `retention visibility ${run.runId}`,
    });

    await page.goto(`${uiBaseUrl}/server`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('server-retention-summary')).toContainText('30', { timeout: 120_000 });
    await expect(page.getByTestId('server-retention-row-accountChanges')).toContainText('45', { timeout: 60_000 });

    await page.goto(`${uiBaseUrl}/session/${sessionId}/info`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('session-info-screen')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('session-retention-notice')).toContainText('30', { timeout: 60_000 });

    await page.goto(`${uiBaseUrl}/server`, { waitUntil: 'domcontentloaded' });
    await page.getByText('Add server', { exact: true }).click();
    await page.getByPlaceholder('https://example.com').fill(secondaryServer.baseUrl);
    await page.getByPlaceholder('Server name').fill('Retention B');
    await page.getByRole('button', { name: 'Add and use' }).click();

    await expect(page.getByTestId('server-retention-summary')).toContainText('60', { timeout: 120_000 });
    await expect(page.getByTestId('server-retention-row-accountChanges')).toContainText('90', { timeout: 60_000 });
    await expect(page.getByText('Deletes inactive sessions after 60 days.')).toBeVisible({ timeout: 60_000 });
  });
});
