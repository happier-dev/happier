import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { repoRootDir } from '../../src/testkit/paths';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: permission prompts (composer card)', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('permission-prompts-composer-card-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    test.setTimeout(420_000);
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

  async function spawnSessionRunnerInDaemon(params: {
    daemon: StartedDaemon;
    directory: string;
    env: Record<string, string>;
    timeoutMs: number;
    sessionId?: string;
  }): Promise<string> {
    const controlToken = params.daemon.state.controlToken;
    if (!controlToken) {
      throw new Error('daemon.state.controlToken is missing; cannot call daemon control server');
    }

    const res = await fetch(`http://127.0.0.1:${params.daemon.state.httpPort}/spawn-session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-happier-daemon-token': controlToken,
      },
      body: JSON.stringify({
        directory: params.directory,
        ...(params.sessionId ? { sessionId: params.sessionId } : null),
        agent: 'claude',
        terminal: { mode: 'plain' },
        environmentVariables: params.env,
      }),
      signal: AbortSignal.timeout(params.timeoutMs),
    });

    const bodyText = await res.text().catch(() => '');
    const parsed = (() => {
      try {
        return JSON.parse(bodyText) as any;
      } catch {
        return null;
      }
    })();

    if (res.status === 200 && parsed?.success === true) {
      const createdSessionId = parsed?.sessionId;
      if (typeof createdSessionId !== 'string' || !createdSessionId.trim()) {
        throw new Error(`daemon spawn-session did not return a sessionId: ${bodyText}`);
      }
      return String(createdSessionId);
    }

    const detail = bodyText ? ` ${bodyText}` : '';
    throw new Error(`Failed to spawn session runner in daemon: HTTP ${res.status}.${detail}`);
  }

  test('shows composer permission card and view-tool navigates to the tool in transcript', async ({ page }, testInfo) => {
    test.setTimeout(420_000);
    if (!server || !ui) throw new Error('missing server/ui fixtures');
    if (!uiBaseUrl) throw new Error('missing ui base url');

    const testDir = resolve(join(suiteDir, 't1-composer-card-jump'));
    await mkdir(testDir, { recursive: true });

    let cliLogin: StartedCliTerminalConnect | null = null;
    let thrown: unknown = null;
    try {
      await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
      await page.getByTestId('welcome-create-account').click();
      await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

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
      const sessionId = await spawnSessionRunnerInDaemon({
        daemon,
        directory: repoRootDir(),
        env: {
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
          HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'permission-prompt-write',
        },
        timeoutMs: 60_000,
      });

      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sessionId}`, 120_000);
      await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 120_000 });
      await page.getByTestId('session-composer-input').fill(`trigger permission prompt ${run.runId}`);
      await page.getByTestId('session-composer-input').press('Enter');
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
