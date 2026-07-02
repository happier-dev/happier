import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { acknowledgeTerminalConnectSuccessIfPresent } from '../../src/testkit/uiE2e/acknowledgeTerminalConnectSuccessIfPresent';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';
import { createAccountAndReachConnectMachineState, gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { repoRootDir } from '../../src/testkit/paths';

const run = createRunDirs({ runLabel: 'ui-e2e' });
const initialUiNavigationTimeoutMs = 240_000;

test.describe('ui e2e: permission prompts (composer card)', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('permission-prompts-composer-card-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_SERVER_URL: '',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
      HAPPIER_E2E_UI_WEB_MODE: 'metro',
      HAPPIER_E2E_UI_WEB_NO_DEV: '0',
      HAPPIER_E2E_UI_WEB_BASE_URL_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_BASE_URL_TIMEOUT_MS ?? '480000',
      HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS ?? '480000',
    };
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
    await mkdir(cliHomeDir, { recursive: true });

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        // Keep web create-account stable (binding signature is not reliably available on web).
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        // Make presence timeouts fast enough for UI E2E reconnect flows.
        HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '1000',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...uiWebEnv,
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
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

  test('shows composer permission card and view-tool navigates to the tool in transcript', async ({ page }, testInfo) => {
    test.setTimeout(420_000);
    if (!server || !ui) throw new Error('missing server/ui fixtures');
    if (!uiBaseUrl) throw new Error('missing ui base url');

    const testDir = resolve(join(suiteDir, 't1-composer-card-jump'));
    await mkdir(testDir, { recursive: true });

    let cliLogin: StartedCliTerminalConnect | null = null;
    let thrown: unknown = null;
    try {
      await gotoDomContentLoadedWithRetries(page, uiBaseUrl, initialUiNavigationTimeoutMs);
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
          HAPPIER_VARIANT: 'dev',
        },
      });

      await gotoDomContentLoadedWithRetries(page, cliLogin.connectUrl, 90_000);
      await expect(page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
      await page.getByTestId('terminal-connect-approve').click();
      await cliLogin.waitForSuccess();
      await acknowledgeTerminalConnectSuccessIfPresent(page);

      const fakeClaudePath = fakeClaudeFixturePath();
      const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));

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
          HAPPIER_VARIANT: 'dev',
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
          HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'permission-prompt-write',
        },
      });

      await page.goto(`${uiBaseUrl}/`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('session-getting-started-kind-start_daemon')).toHaveCount(0, { timeout: 120_000 });

      if (!daemon) throw new Error('missing daemon fixture');
      const sessionId = await spawnSessionFromDaemon({
        daemon,
        directory: repoRootDir(),
        request: {
          terminal: { mode: 'plain' },
          environmentVariables: {
            HAPPIER_CLAUDE_PATH: fakeClaudePath,
            HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
            HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
            HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
            HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'permission-prompt-write',
          },
        },
      });

      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sessionId}`, 120_000);
      await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 120_000 });
      await page.getByTestId('session-composer-input').fill(`trigger permission prompt ${run.runId}`);
      await expect(page.getByTestId('session-composer-send')).toBeEnabled({ timeout: 60_000 });
      await page.getByTestId('session-composer-send').click();
      await expect(page.getByTestId('permission-prompt-card')).toHaveCount(1, { timeout: 180_000 });

      await page.getByTestId('permission-prompt-view-tool').click();

      await page.waitForURL((url) => {
        const sid = `/session/${sessionId}`;
        const pathname = url.pathname;
        if (!pathname.startsWith(sid)) return false;
        if (pathname.includes('/message/')) return true;
        if (pathname === sid && url.searchParams.has('jumpSeq')) return true;
        return false;
      }, { timeout: 120_000 });

      expect(page.url()).toContain(`/session/${sessionId}`);
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      await cliLogin?.stop().catch(() => {});
      if (thrown) {
        await testInfo.attach('note.txt', { body: 'permission prompt composer card e2e failed', contentType: 'text/plain' });
      }
    }
  });
});
