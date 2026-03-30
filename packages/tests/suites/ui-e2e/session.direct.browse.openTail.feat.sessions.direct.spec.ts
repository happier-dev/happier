import { test, expect } from '@playwright/test';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { enableDirectSessionsFeature } from '../../src/testkit/uiE2e/enableDirectSessionsFeature';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { fakeClaudeFixturePath, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';

const run = createRunDirs({ runLabel: 'ui-e2e' });

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

test.describe('ui e2e: direct sessions browse/open/tail', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-direct-browse-open-tail-suite');
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
    await writeFile(
      claudeSessionFile,
      [
        jsonlLine({ type: 'user', uuid: 'direct-u1', cwd: '/tmp/direct-ui-project', message: { content: 'older direct fixture message' } }),
        jsonlLine({ type: 'assistant', uuid: 'direct-a1', cwd: '/tmp/direct-ui-project', message: { model: 'claude-test', content: [{ type: 'text', text: 'older direct fixture reply' }] } }),
        jsonlLine({ type: 'user', uuid: 'direct-u2', cwd: '/tmp/direct-ui-project', message: { content: 'latest direct fixture message' } }),
        jsonlLine({ type: 'assistant', uuid: 'direct-a2', cwd: '/tmp/direct-ui-project', message: { model: 'claude-test', content: [{ type: 'text', text: 'latest direct fixture reply' }] } }),
      ].join(''),
      'utf8',
    );

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
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
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
    await server?.stop().catch(() => {});
  });

  test('links a provider-backed direct session and follows appended provider log lines', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const testDir = resolve(join(suiteDir, 't1-direct-browse-open-tail'));
    await mkdir(testDir, { recursive: true });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(uiBaseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('welcome-create-account').click();
    await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

    const cliLogin: StartedCliTerminalConnect = await startCliAuthLoginForTerminalConnect({
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
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
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: uiBaseUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_CLAUDE_CONFIG_DIR: claudeConfigDir,
        HAPPIER_DIRECT_SESSIONS_PAGE_MAX_ITEMS: '2',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
        HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
        HAPPIER_E2E_FAKE_CLAUDE_LOG: resolve(join(testDir, 'fake-claude.jsonl')),
        HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}-browse`,
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      },
    });

    await enableDirectSessionsFeature(page, uiBaseUrl);

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/`);
    await expect(page.getByTestId('sessions-list-storage-tab:direct')).toHaveCount(1, { timeout: 120_000 });
    await page.getByTestId('sessions-list-storage-tab:direct').click();

    await expect(page.getByTestId('direct-sessions-browse-button')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('direct-sessions-browse-button').click();
    await expect(page.getByTestId('direct-sessions-browse-modal')).toHaveCount(1, { timeout: 60_000 });

    await expect(page.getByTestId('direct-session-provider-picker-trigger')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('direct-session-provider-picker-trigger').focus();
    await page.getByTestId('direct-session-provider-picker-trigger').press('Enter');
    await expect(page.getByTestId('dropdown-option-claude')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('dropdown-option-claude').click();

    await expect(page.getByText('older direct fixture message')).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId('direct-session-candidate:sess-ui-direct')).toHaveCount(1, { timeout: 120_000 });
    await page.getByTestId('direct-session-candidate:sess-ui-direct').click();

    await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByText('latest direct fixture message')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByText('latest direct fixture reply')).toHaveCount(1, { timeout: 60_000 });

    await appendFile(
      claudeSessionFile,
      jsonlLine({
        type: 'user',
        uuid: 'direct-u3',
        cwd: '/tmp/direct-ui-project',
        message: { content: 'tail appended direct fixture message' },
      }),
      'utf8',
    );

    await expect(page.getByText('tail appended direct fixture message')).toHaveCount(1, { timeout: 60_000 });
  });

  test('takes over + persists a linked direct session from the send intercept and moves it to the persisted tab', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const testDir = resolve(join(suiteDir, 't2-direct-browse-takeover-persist'));
    const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
    await mkdir(testDir, { recursive: true });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(uiBaseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('welcome-create-account').click();
    await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

    const cliLogin: StartedCliTerminalConnect = await startCliAuthLoginForTerminalConnect({
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
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
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: uiBaseUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_CLAUDE_CONFIG_DIR: claudeConfigDir,
        HAPPIER_DIRECT_SESSIONS_PAGE_MAX_ITEMS: '2',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
        HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
        HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
        HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}-persist`,
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      },
    });

    await enableDirectSessionsFeature(page, uiBaseUrl);

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/`);
    await expect(page.getByTestId('sessions-list-storage-tab:direct')).toHaveCount(1, { timeout: 120_000 });
    await page.getByTestId('sessions-list-storage-tab:direct').click();
    await page.getByTestId('direct-sessions-browse-button').click();
    await expect(page.getByTestId('direct-sessions-browse-modal')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('direct-session-provider-picker-trigger')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('direct-session-provider-picker-trigger').focus();
    await page.getByTestId('direct-session-provider-picker-trigger').press('Enter');
    await expect(page.getByTestId('dropdown-option-claude')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('dropdown-option-claude').click();
    await expect(page.getByTestId('direct-session-candidate:sess-ui-direct')).toHaveCount(1, { timeout: 120_000 });
    await page.getByTestId('direct-session-candidate:sess-ui-direct').click();

    await expect(page.locator('textarea[data-testid="session-composer-input"]:visible')).toHaveCount(1, { timeout: 120_000 });
    const sessionUrl = new URL(page.url());
    const sessionIdMatch = sessionUrl.pathname.match(/\/session\/([^/]+)/);
    if (!sessionIdMatch?.[1]) {
      throw new Error(`expected session route after linking direct session, got ${page.url()}`);
    }
    const sessionId = decodeURIComponent(sessionIdMatch[1]);

    await page.locator('textarea[data-testid="session-composer-input"]:visible').fill('persist this direct session from ui');
    await page.locator('textarea[data-testid="session-composer-input"]:visible').press('Enter');

    await expect(page.getByTestId('direct-session-takeover-dialog-persist')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('direct-session-takeover-dialog-persist').click();

    await expect(page.getByTestId('direct-session-takeover-dialog-persist')).toHaveCount(0, { timeout: 120_000 });
    await expect(page.getByTestId('session-chatFooter-takeOverPersist')).toHaveCount(0, { timeout: 120_000 });

    await waitForFakeClaudeInvocation(
      fakeClaudeLogPath,
      (invocation) => invocation.argv.includes('--resume') && invocation.argv.includes('sess-ui-direct'),
      { timeoutMs: 120_000, pollMs: 100 },
    );

    await page.getByTestId('sessions-list-storage-tab:direct').click();
    await expect(page.getByTestId(`session-list-item-${sessionId}`)).toHaveCount(0, { timeout: 120_000 });

    await page.getByTestId('sessions-list-storage-tab:persisted').click();
    await expect(page.getByTestId(`session-list-item-${sessionId}`)).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByText('persist this direct session from ui')).toHaveCount(1, { timeout: 120_000 });
  });
});
