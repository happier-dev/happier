import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { enableDirectSessionsFeature } from '../../src/testkit/uiE2e/enableDirectSessionsFeature';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: direct OpenCode sessions browse/open/tail', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-direct-opencode-browse-open-tail-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let appServer: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;
  let fakeOpenCodeServer: Server | null = null;
  let fakeOpenCodeBaseUrl = '';

  const openCodeMessages: Array<Record<string, unknown>> = [];
  const openCodeSessions: Array<Record<string, unknown>> = [];
  let openCodeStatuses: Record<string, { type?: string }> = {};

  test.beforeAll(async () => {
    test.setTimeout(540_000);
    await mkdir(cliHomeDir, { recursive: true });

    openCodeSessions.push({
      id: 'sess-opencode-direct-ui',
      title: 'OpenCode direct UI session',
      directory: '/tmp/opencode-direct-ui-project',
      createdAt: '2026-03-05T10:00:00.000Z',
      updatedAt: '2026-03-05T10:05:00.000Z',
    });
    openCodeMessages.push(
      {
        id: 'oc-ui-user-1',
        role: 'user',
        content: 'older opencode ui message',
        createdAt: '2026-03-05T10:00:01.000Z',
      },
      {
        id: 'oc-ui-agent-1',
        role: 'assistant',
        content: 'older opencode ui reply',
        createdAt: '2026-03-05T10:00:02.000Z',
      },
      {
        id: 'oc-ui-user-2',
        role: 'user',
        content: 'latest opencode ui message',
        createdAt: '2026-03-05T10:00:03.000Z',
      },
      {
        id: 'oc-ui-agent-2',
        role: 'assistant',
        content: 'latest opencode ui reply',
        createdAt: '2026-03-05T10:00:04.000Z',
      },
    );
    openCodeStatuses = {
      'sess-opencode-direct-ui': { type: 'running' },
    };

    fakeOpenCodeServer = createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
      if (req.method === 'GET' && url.pathname === '/global/health') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ healthy: true, version: 'fake-opencode-ui-1' }));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/session') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(openCodeSessions));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/session/status') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(openCodeStatuses));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/session/sess-opencode-direct-ui/message') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(openCodeMessages));
        return;
      }
      res.statusCode = 404;
      res.end();
    });

    await new Promise<void>((resolveListen) => {
      fakeOpenCodeServer!.listen(0, '127.0.0.1', () => resolveListen());
    });
    const fakeAddress = fakeOpenCodeServer.address();
    if (!fakeAddress || typeof fakeAddress === 'string') {
      throw new Error('Failed to resolve fake OpenCode UI server address');
    }
    fakeOpenCodeBaseUrl = `http://127.0.0.1:${fakeAddress.port}`;

    appServer = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
        HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '1000',
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: appServer.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
        HAPPIER_E2E_UI_WEB_MODE: 'metro',
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = null;
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await appServer?.stop().catch(() => {});
    if (fakeOpenCodeServer) {
      await new Promise<void>((resolveClose) => {
        fakeOpenCodeServer?.close(() => resolveClose());
      }).catch(() => {});
    }
  });

  test('links a provider-backed OpenCode direct session and follows appended server messages', async ({ page }) => {
    test.setTimeout(540_000);
    if (!appServer || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const testDir = resolve(join(suiteDir, 't1-direct-opencode-browse-open-tail'));
    await mkdir(testDir, { recursive: true });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(uiBaseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('welcome-create-account').click();
    await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

    const cliLogin: StartedCliTerminalConnect = await startCliAuthLoginForTerminalConnect({
      testDir,
      cliHomeDir,
      serverUrl: appServer.baseUrl,
      webappUrl: uiBaseUrl,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      },
    });

    await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('terminal-connect-approve').click();
    await cliLogin.waitForSuccess();

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: cliHomeDir,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_HOME_DIR: cliHomeDir,
        HAPPIER_SERVER_URL: appServer.baseUrl,
        HAPPIER_WEBAPP_URL: uiBaseUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_DIRECT_SESSIONS_PAGE_MAX_ITEMS: '2',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
        HAPPIER_OPENCODE_SERVER_URL: fakeOpenCodeBaseUrl,
        HAPPIER_OPENCODE_SERVER_URL_EXPLICIT: '1',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      },
    });

    await enableDirectSessionsFeature(page, uiBaseUrl);

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/`);
    await expect(page.getByTestId('session-getting-started-kind-start_daemon')).toHaveCount(0, { timeout: 120_000 });
    await expect(page.getByTestId('sessions-list-storage-tab:direct')).toHaveCount(1, { timeout: 120_000 });
    await page.getByTestId('sessions-list-storage-tab:direct').click();

    await expect(page.getByTestId('direct-sessions-browse-button')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('direct-sessions-browse-button').click();
    await expect(page.getByTestId('direct-sessions-browse-modal')).toHaveCount(1, { timeout: 60_000 });

    await expect(page.getByTestId('direct-session-provider-picker-trigger')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('direct-session-provider-picker-trigger').focus();
    await page.getByTestId('direct-session-provider-picker-trigger').press('Enter');
    await expect(page.getByTestId('dropdown-option-opencode')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('dropdown-option-opencode').click();

    const candidate = page.getByTestId('direct-session-candidate:sess-opencode-direct-ui');
    await expect(candidate).toHaveCount(1, { timeout: 120_000 });
    await expect(candidate).toContainText('OpenCode direct UI session', { timeout: 60_000 });
    await candidate.focus();
    await candidate.press('Enter');

    const transcript = page.getByTestId('transcript-chat-list');
    await expect(transcript).toHaveCount(1, { timeout: 120_000 });
    await expect(transcript.getByText('latest opencode ui message')).toHaveCount(1, { timeout: 60_000 });
    await expect(transcript.getByText('latest opencode ui reply')).toHaveCount(1, { timeout: 60_000 });

    openCodeMessages.push({
      id: 'oc-ui-user-3',
      role: 'user',
      content: 'tail appended opencode ui message',
      createdAt: '2026-03-05T10:00:05.000Z',
    });

    await expect(transcript.getByText('tail appended opencode ui message')).toHaveCount(1, { timeout: 60_000 });
  });
});
