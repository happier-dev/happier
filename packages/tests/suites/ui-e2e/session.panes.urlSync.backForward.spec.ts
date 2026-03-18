import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: session multi-pane URL sync', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-panes-url-sync-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;

  function detailsPaneLocator(page: Page) {
    return page
      .getByTestId('multi-pane-details-docked')
      .or(page.getByTestId('multi-pane-details-overlay'));
  }

  function rightPaneLocator(page: Page) {
    return page
      .getByTestId('multi-pane-right-docked')
      .or(page.getByTestId('multi-pane-right-overlay'));
  }

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

  test('reconciles right/details panes from URL and supports back/forward', async ({ page }) => {
    test.setTimeout(420_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);

    await page.getByTestId('welcome-create-account').click();
    await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

    const testDir = resolve(join(suiteDir, 't1-url-sync'));
    await mkdir(testDir, { recursive: true });
    await writeFile(resolve(join(testDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');

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
        // Machine-scoped RPC must be allowed to read within the e2e fixture directory so the machine
        // is considered fully online/usable by the UI (required for /new wizard flows).
        HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: testDir,
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
        HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
        HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
      },
    });

    const sessionId = await spawnSessionFromDaemon({ daemon, directory: testDir });
    const sessionUrl = `${uiBaseUrl}/session/${sessionId}`;

    await page.goto(sessionUrl, { waitUntil: 'domcontentloaded' });
    await expect(rightPaneLocator(page)).toHaveCount(0, { timeout: 60_000 });
    await expect(detailsPaneLocator(page)).toHaveCount(0, { timeout: 60_000 });

    await page.goto(`${sessionUrl}?right=files`, { waitUntil: 'domcontentloaded' });
    await expect(rightPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });
    await expect(detailsPaneLocator(page)).toHaveCount(0, { timeout: 60_000 });

    await page.goto(`${sessionUrl}?right=files&details=file&path=${encodeURIComponent('AGENTS.md')}`, { waitUntil: 'domcontentloaded' });
    await expect(rightPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });
    await expect(detailsPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });

    await page.goBack();
    await expect(rightPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });
    await expect(detailsPaneLocator(page)).toHaveCount(0, { timeout: 60_000 });

    await page.goBack();
    await expect(rightPaneLocator(page)).toHaveCount(0, { timeout: 60_000 });
    await expect(detailsPaneLocator(page)).toHaveCount(0, { timeout: 60_000 });

    await page.goForward();
    await expect(rightPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });
    await expect(detailsPaneLocator(page)).toHaveCount(0, { timeout: 60_000 });

    await page.goForward();
    await expect(rightPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });
    await expect(detailsPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });

    // Reset to a no-details baseline so the user can interact with the transcript before
    // validating state -> URL sync.
    await page.goto(`${sessionUrl}?right=files`, { waitUntil: 'domcontentloaded' });
    await expect(rightPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });
    await expect(detailsPaneLocator(page)).toHaveCount(0, { timeout: 60_000 });

    // State -> URL: opening a linked file mention updates search params (details + path).
    await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('session-composer-input').fill('open @AGENTS.md');
    await page.getByTestId('session-composer-input').press('Enter');

    await expect(page.getByTestId('linked-workspace-file:AGENTS.md')).toHaveCount(1, { timeout: 120_000 });
    await page.getByTestId('linked-workspace-file:AGENTS.md').click();

    await expect(detailsPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });
    await expect.poll(async () => page.url(), { timeout: 60_000 }).toContain('details=file');
    await expect.poll(async () => page.url(), { timeout: 60_000 }).toContain('path=AGENTS.md');
  });
});
