import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { startForwardedHeaderProxy } from '../../src/testkit/uiE2e/forwardedHeaderProxy';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: mTLS login + terminal connect', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('auth-mtls-terminal-connect-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let proxyBaseUrl: string | null = null;
  let proxyStop: (() => Promise<void>) | null = null;
  let daemon: StartedDaemon | null = null;

  async function waitForWelcomeAuthenticated(page: Page, baseUrl: string): Promise<void> {
    await gotoDomContentLoadedWithRetries(page, baseUrl);
    await expect(page.getByTestId('welcome-create-account')).toHaveCount(0, { timeout: 120_000 });
    await expect(page.getByTestId('session-getting-started-kind-connect_machine')).toHaveCount(1, { timeout: 120_000 });
  }

  test.beforeAll(async () => {
    test.setTimeout(600_000);
    await mkdir(cliHomeDir, { recursive: true });

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',

        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '0',
        AUTH_ANONYMOUS_SIGNUP_ENABLED: '0',
        AUTH_SIGNUP_PROVIDERS: '',

        HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',

        HAPPIER_FEATURE_AUTH_MTLS__ENABLED: '1',
        HAPPIER_FEATURE_AUTH_MTLS__MODE: 'forwarded',
        HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: '1',
        HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: '1',
        HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: 'san_email',
        HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: 'example.com',
        HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: 'CN=Example Root CA',

        HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_ENABLED: '1',
        HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_PROVIDER_ID: 'mtls',

        HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '1000',
      },
    });

    const proxy = await startForwardedHeaderProxy({
      targetBaseUrl: server.baseUrl,
      identityHeaders: {
        'x-happier-client-cert-email': 'alice@example.com',
        'x-happier-client-cert-issuer': 'CN=Example Root CA',
        'x-happier-client-cert-sha256': 'sha256:abc123',
      },
    });
    proxyBaseUrl = proxy.baseUrl;
    proxyStop = proxy.stop;

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: proxy.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
      },
    });
    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await proxyStop?.().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('logs in via mTLS, approves terminal connect, and daemon becomes online', async ({ page }) => {
    test.setTimeout(600_000);
    if (!server) throw new Error('missing server fixture');
    if (!uiBaseUrl) throw new Error('missing ui base url');
    if (!proxyBaseUrl) throw new Error('missing proxy base url');

    const mtlsOk = page.waitForResponse(
      (resp) => resp.url().startsWith(`${proxyBaseUrl}/v1/auth/mtls`) && resp.request().method() === 'POST' && resp.status() === 200,
      { timeout: 120_000 },
    );

    await waitForWelcomeAuthenticated(page, uiBaseUrl);
    await mtlsOk;

    const testDir = resolve(join(suiteDir, 't1-mtls-terminal-connect'));
    await mkdir(testDir, { recursive: true });

    let cliLogin: StartedCliTerminalConnect | null = null;
    try {
      cliLogin = await startCliAuthLoginForTerminalConnect({
        testDir,
        cliHomeDir,
        // Keep the CLI terminal-connect "server" param aligned with the UI's active server URL
        // (which is the forwarded-header proxy) so the web app doesn't switch servers mid-flow.
        serverUrl: proxyBaseUrl,
        webappUrl: uiBaseUrl,
        env: {
          ...process.env,
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
          CI: '1',
          HAPPIER_HOME_DIR: cliHomeDir,
          // Use the same server URL the CLI authenticated against so the daemon can find credentials.
          // This is the forwarded-header proxy; it forwards to the real server.
          HAPPIER_SERVER_URL: proxyBaseUrl,
          HAPPIER_WEBAPP_URL: uiBaseUrl,
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_VARIANT: 'dev',
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
        },
      });

      await page.goto(`${uiBaseUrl}/`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('session-getting-started-kind-start_daemon')).toHaveCount(0, { timeout: 180_000 });

      await expect
        .poll(
          async () => {
            const createCount = await page.getByTestId('session-getting-started-kind-create_session').count();
            const selectCount = await page.getByTestId('session-getting-started-kind-select_session').count();
            return createCount > 0 || selectCount > 0;
          },
          { timeout: 180_000 },
        )
        .toBe(true);
    } finally {
      await cliLogin?.stop().catch(() => {});
    }
  });
});
