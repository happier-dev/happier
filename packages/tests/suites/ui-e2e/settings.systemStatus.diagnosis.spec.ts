import { execFileSync } from 'node:child_process';
import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { approveTerminalConnect } from '../../src/testkit/uiE2e/approveTerminalConnect';
import { acknowledgeTerminalConnectSuccessIfPresent } from '../../src/testkit/uiE2e/acknowledgeTerminalConnectSuccessIfPresent';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import {
  createAccountAndReachConnectMachineState,
  gotoDomContentLoadedWithRetries,
  normalizeLoopbackBaseUrl,
  waitForAuthenticatedHomeUi,
} from '../../src/testkit/uiE2e/pageNavigation';

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
  if (typeof id === 'string' && id.trim().length > 0) {
    return id.trim();
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
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
    }
  }
  return readLatestMachineIdFromServerLightDb({ suiteDir: params.suiteDir });
}

function readMachineActiveFromServerLightDb(params: { suiteDir: string; machineId: string }): boolean | null {
  const dbPath = resolveServerLightSqliteDbPath({ suiteDir: params.suiteDir });
  try {
    const query = `select active from Machine where id = '${params.machineId.replaceAll("'", "''")}' limit 1;`;
    const raw = execFileSync('sqlite3', ['-json', dbPath, query], { encoding: 'utf8' });
    const parsed = JSON.parse(raw) as Array<{ active?: unknown }>;
    const active = parsed?.[0]?.active;
    if (active === 1 || active === true) return true;
    if (active === 0 || active === false) return false;
    return null;
  } catch {
    return null;
  }
}

test.describe('ui e2e: System Status + Diagnosis screens', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('system-status-diagnosis-suite');

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;

  test.beforeAll(async () => {
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(process.env));
    await mkdir(suiteDir, { recursive: true });

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
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
    test.setTimeout(60_000);
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('navigates to System Status and runs Diagnosis without a daemon', async ({ page }) => {
    test.setTimeout(240_000);
    if (!uiBaseUrl) throw new Error('missing ui base url');

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);

    await createAccountAndReachConnectMachineState({ page });

    await page.goto(`${uiBaseUrl}/settings/system-status`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('system-status-screen')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('system-status-run-diagnosis').click();

    await expect(page.getByTestId('diagnosis-screen')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('diagnosis-run-button').click();

    await expect(page.getByTestId('diagnosis-finding-machine_none_online')).toHaveCount(1, { timeout: 60_000 });
  });

  test('shows runtime inventory in System Status and Machine Details for a connected daemon machine', async ({ page }) => {
    test.setTimeout(420_000);
    if (!uiBaseUrl) throw new Error('missing ui base url');
    if (!server) throw new Error('missing server fixture');

    const testDir = resolve(join(suiteDir, 't2-runtime-inventory'));
    await mkdir(testDir, { recursive: true });
    const cliHomeDir = resolve(join(testDir, 'cli-home'));

    let cliLogin: StartedCliTerminalConnect | null = null;
    let daemon: StartedDaemon | null = null;

    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
      await createAccountAndReachConnectMachineState({ page });

      cliLogin = await startCliAuthLoginForTerminalConnect({
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        webappUrl: uiBaseUrl,
        env: {
          ...process.env,
          CI: '1',
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
          HAPPIER_VARIANT: 'dev',
        },
      });

      await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
      await approveTerminalConnect({ page });
      await cliLogin.waitForSuccess();
      await acknowledgeTerminalConnectSuccessIfPresent(page);

      daemon = await startTestDaemon({
        testDir,
        happyHomeDir: cliHomeDir,
        env: {
          ...process.env,
          CI: '1',
          HAPPIER_HOME_DIR: cliHomeDir,
          HAPPIER_SERVER_URL: server.baseUrl,
          HAPPIER_WEBAPP_URL: uiBaseUrl,
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
          HAPPIER_VARIANT: 'dev',
          HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
          HAPPIER_E2E_FAKE_CLAUDE_LOG: resolve(join(testDir, 'fake-claude.jsonl')),
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `system-status-diagnosis-fake-claude-session-${run.runId}`,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `system-status-diagnosis-fake-claude-invocation-${run.runId}`,
        },
      });

      const machineId = await waitForLatestMachineId({ suiteDir, timeoutMs: 120_000 });
      await expect.poll(
        async () => readMachineActiveFromServerLightDb({ suiteDir, machineId }),
        { timeout: 180_000 },
      ).toBe(true);

      await page.goto(`${uiBaseUrl}/`, { waitUntil: 'domcontentloaded' });
      await waitForAuthenticatedHomeUi({ page, timeoutMs: 180_000 });

      await page.goto(`${uiBaseUrl}/settings/system-status`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('system-status-screen')).toHaveCount(1, { timeout: 60_000 });
      await expect(page.getByTestId('machine-runtime-inventory-summary')).toHaveCount(1, { timeout: 120_000 });

      await page.goto(`${uiBaseUrl}/machine/${encodeURIComponent(machineId)}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('machine-runtime-inventory-summary')).toHaveCount(1, { timeout: 120_000 });
      await expect(page.getByTestId('machine-runtime-inventory-cli')).toHaveCount(1, { timeout: 120_000 });
      await expect(page.getByTestId('machine-runtime-inventory-daemon')).toHaveCount(1, { timeout: 120_000 });
    } finally {
      await daemon?.stop().catch(() => {});
      await cliLogin?.stop().catch(() => {});
    }
  });
});
