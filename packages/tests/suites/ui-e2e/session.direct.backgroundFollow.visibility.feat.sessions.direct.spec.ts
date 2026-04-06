import { test, expect, type Page } from '@playwright/test';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { enableDirectSessionsFeature } from '../../src/testkit/uiE2e/enableDirectSessionsFeature';
import { createAccountAndReachConnectMachineState, gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';

const run = createRunDirs({ runLabel: 'ui-e2e' });

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function createFixtureSessionLines(): string {
  return [
    jsonlLine({ type: 'user', uuid: 'direct-u1', cwd: '/tmp/direct-ui-project', message: { content: 'older direct fixture message' } }),
    jsonlLine({ type: 'assistant', uuid: 'direct-a1', cwd: '/tmp/direct-ui-project', message: { model: 'claude-test', content: [{ type: 'text', text: 'older direct fixture reply' }] } }),
    jsonlLine({ type: 'user', uuid: 'direct-u2', cwd: '/tmp/direct-ui-project', message: { content: 'latest direct fixture message' } }),
    jsonlLine({ type: 'assistant', uuid: 'direct-a2', cwd: '/tmp/direct-ui-project', message: { model: 'claude-test', content: [{ type: 'text', text: 'latest direct fixture reply' }] } }),
  ].join('');
}

async function chooseClaudeDirectCandidate(page: Page): Promise<void> {
  await expect(page.getByTestId('direct-sessions-browse-button')).toHaveCount(1, { timeout: 60_000 });
  await page.getByTestId('direct-sessions-browse-button').click();
  await expect(page.getByTestId('direct-sessions-browse-modal')).toHaveCount(1, { timeout: 60_000 });

  await expect(page.getByTestId('direct-session-provider-picker-trigger')).toHaveCount(1, { timeout: 60_000 });
  await page.getByTestId('direct-session-provider-picker-trigger').focus();
  await page.getByTestId('direct-session-provider-picker-trigger').press('Enter');
  await expect(page.getByTestId('dropdown-option-claude')).toHaveCount(1, { timeout: 60_000 });
  await page.getByTestId('dropdown-option-claude').click();

  await expect(page.getByTestId('direct-session-candidate:sess-ui-direct')).toHaveCount(1, { timeout: 120_000 });
  await page.getByTestId('direct-session-candidate:sess-ui-direct').click();
}

async function openDirectSessionFromList(page: Page, uiBaseUrl: string): Promise<string> {
  await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/`);
  await expect(page.getByTestId('sessions-list-storage-tab:direct')).toHaveCount(1, { timeout: 120_000 });
  await page.getByTestId('sessions-list-storage-tab:direct').click();
  await chooseClaudeDirectCandidate(page);
  await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });

  const sessionUrl = new URL(page.url());
  const sessionIdMatch = sessionUrl.pathname.match(/\/session\/([^/]+)/);
  if (!sessionIdMatch?.[1]) {
    throw new Error(`expected session route after linking direct session, got ${page.url()}`);
  }
  return decodeURIComponent(sessionIdMatch[1]);
}

async function enableBackgroundFollow(page: Page): Promise<void> {
  await expect(page.getByTestId('session-header-action-menu-trigger')).toHaveCount(1, { timeout: 60_000 });
  await page.getByTestId('session-header-action-menu-trigger').click();
  await expect(page.getByTestId('dropdown-option-session_directSession_backgroundFollow')).toHaveCount(1, { timeout: 60_000 });
  await page.getByTestId('dropdown-option-session_directSession_backgroundFollow').click();
}

async function authenticateAndStartDaemon(params: Readonly<{
  page: Page;
  testDir: string;
  cliHomeDir: string;
  server: StartedServer;
  uiBaseUrl: string;
  claudeConfigDir: string;
}>): Promise<StartedDaemon> {
  await params.page.setViewportSize({ width: 1440, height: 900 });
  await gotoDomContentLoadedWithRetries(params.page, params.uiBaseUrl);
  await createAccountAndReachConnectMachineState({ page: params.page });

  const cliLogin: StartedCliTerminalConnect = await startCliAuthLoginForTerminalConnect({
    testDir: params.testDir,
    cliHomeDir: params.cliHomeDir,
    serverUrl: params.server.baseUrl,
    webappUrl: params.uiBaseUrl,
    env: {
      ...process.env,
      HOME: params.cliHomeDir,
      CI: '1',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    },
  });

  await params.page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
  await expect(params.page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
  await params.page.getByTestId('terminal-connect-approve').click();
  await cliLogin.waitForSuccess();
  await cliLogin.stop().catch(() => {});

  return await startTestDaemon({
    testDir: params.testDir,
    happyHomeDir: params.cliHomeDir,
    env: {
      ...process.env,
      HOME: params.cliHomeDir,
      CI: '1',
      HAPPIER_HOME_DIR: params.cliHomeDir,
      HAPPIER_SERVER_URL: params.server.baseUrl,
      HAPPIER_WEBAPP_URL: params.uiBaseUrl,
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_CLAUDE_CONFIG_DIR: params.claudeConfigDir,
      HAPPIER_DIRECT_SESSIONS_PAGE_MAX_ITEMS: '2',
      HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
      HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
      HAPPIER_E2E_FAKE_CLAUDE_LOG: resolve(join(params.testDir, 'fake-claude.jsonl')),
      HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}-${params.testDir.split('/').pop()}`,
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    },
  });
}

test.describe('ui e2e: direct-session background follow + visibility catch-up', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-direct-background-follow-visibility-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));
  const directFixturesDir = resolve(join(suiteDir, 'direct-fixtures'));
  const claudeConfigDir = resolve(join(directFixturesDir, '.claude'));
  const claudeSessionFile = resolve(join(claudeConfigDir, 'projects', 'proj-direct-ui', 'sess-ui-direct.jsonl'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    test.setTimeout(540_000);
    await mkdir(cliHomeDir, { recursive: true });
    await mkdir(join(claudeConfigDir, 'projects', 'proj-direct-ui'), { recursive: true });
    await writeFile(claudeSessionFile, createFixtureSessionLines(), 'utf8');

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
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
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-direct-follow`,
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = null;
    await writeFile(claudeSessionFile, createFixtureSessionLines(), 'utf8');
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('marks a linked direct session unread after background-follow activity while detached and clears it after reopen', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const testDir = resolve(join(suiteDir, 't1-direct-background-follow-unread'));
    await mkdir(testDir, { recursive: true });

    daemon = await authenticateAndStartDaemon({
      page,
      testDir,
      cliHomeDir,
      server,
      uiBaseUrl,
      claudeConfigDir,
    });

    await enableDirectSessionsFeature(page, uiBaseUrl);
    const sessionId = await openDirectSessionFromList(page, uiBaseUrl);
    await enableBackgroundFollow(page);

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/`);
    await page.getByTestId('sessions-list-storage-tab:direct').click();
    await expect(page.getByTestId(`session-list-item-${sessionId}`)).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId(`session-list-item-unread-indicator-${sessionId}`)).toHaveCount(0);

    await appendFile(
      claudeSessionFile,
      jsonlLine({
        type: 'assistant',
        uuid: 'direct-a3',
        cwd: '/tmp/direct-ui-project',
        message: { model: 'claude-test', content: [{ type: 'text', text: 'detached background follow ui delta' }] },
      }),
      'utf8',
    );

    await expect(page.getByTestId(`session-list-item-unread-indicator-${sessionId}`)).toHaveCount(1, { timeout: 60_000 });

    await page.getByTestId(`session-list-item-${sessionId}`).click();
    await expect(page.getByText('detached background follow ui delta')).toHaveCount(1, { timeout: 120_000 });

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/`);
    await page.getByTestId('sessions-list-storage-tab:direct').click();
    await expect(page.getByTestId(`session-list-item-unread-indicator-${sessionId}`)).toHaveCount(0, { timeout: 60_000 });
  });

  test('catches up direct-session transcript appends after visibility restore', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    await page.addInitScript(() => {
      const key = '__HAPPIER_E2E_VIS_STATE__';
      const getState = () => {
        const raw = (globalThis as any)[key];
        return raw === 'hidden' ? 'hidden' : 'visible';
      };
      const defineGetter = (prop: string, getter: () => unknown) => {
        try {
          Object.defineProperty(Document.prototype, prop, { configurable: true, get: getter });
        } catch {
          // ignore
        }
      };
      defineGetter('visibilityState', () => getState());
      defineGetter('hidden', () => getState() !== 'visible');
      defineGetter('webkitHidden', () => getState() !== 'visible');
    });

    const testDir = resolve(join(suiteDir, 't2-direct-visibility-catchup'));
    await mkdir(testDir, { recursive: true });

    daemon = await authenticateAndStartDaemon({
      page,
      testDir,
      cliHomeDir,
      server,
      uiBaseUrl,
      claudeConfigDir,
    });

    await enableDirectSessionsFeature(page, uiBaseUrl);
    await openDirectSessionFromList(page, uiBaseUrl);

    await page.evaluate(() => {
      (globalThis as any).__HAPPIER_E2E_VIS_STATE__ = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => page.evaluate(() => document.visibilityState), { timeout: 10_000 }).toBe('hidden');

    await appendFile(
      claudeSessionFile,
      jsonlLine({
        type: 'assistant',
        uuid: 'direct-a4',
        cwd: '/tmp/direct-ui-project',
        message: { model: 'claude-test', content: [{ type: 'text', text: 'visibility resumed direct delta' }] },
      }),
      'utf8',
    );

    await page.evaluate(() => {
      (globalThis as any).__HAPPIER_E2E_VIS_STATE__ = 'visible';
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => page.evaluate(() => document.visibilityState), { timeout: 10_000 }).toBe('visible');
    await expect(page.getByText('visibility resumed direct delta')).toHaveCount(1, { timeout: 120_000 });
  });
});
