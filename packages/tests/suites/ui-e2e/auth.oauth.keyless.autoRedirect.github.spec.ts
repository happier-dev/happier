import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { reserveAvailablePort } from '../../src/testkit/network/reserveAvailablePort';
import { startFakeGitHubOAuthServer, type StopFn } from '../../src/testkit/oauth/fakeGithubOAuthServer';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: keyless OAuth auto-redirect (GitHub)', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('auth-oauth-keyless-auto-redirect-github-suite');

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let oauthBaseUrl: string | null = null;
  let oauthStop: StopFn | null = null;
  let oauthCounts: (() => Readonly<Record<string, number>>) | null = null;

  function resolveServerLightSqliteDbPath(params: { server: StartedServer }): string {
    return resolve(join(params.server.dataDir, 'happier-server-light.sqlite'));
  }

  test.beforeAll(async () => {
    test.setTimeout(600_000);
    await mkdir(suiteDir, { recursive: true });

    const oauth = await startFakeGitHubOAuthServer();
    oauthBaseUrl = oauth.baseUrl;
    oauthStop = oauth.stop;
    oauthCounts = oauth.getCounts;

    const uiPort = await reserveAvailablePort();
    const uiReturnBaseUrl = `http://127.0.0.1:${uiPort}`;

    const serverPort = await reserveAvailablePort();
    const serverBaseUrl = `http://127.0.0.1:${serverPort}`;

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      __portAllocator: async () => serverPort,
      extraEnv: {
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '0',
        AUTH_ANONYMOUS_SIGNUP_ENABLED: '0',
        AUTH_SIGNUP_PROVIDERS: '',

        HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',

        HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED: '1',
        HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_PROVIDERS: 'github',
        HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_AUTO_PROVISION: '1',

        HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_ENABLED: '1',
        HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_PROVIDER_ID: 'github',

        GITHUB_CLIENT_ID: 'gh_client',
        GITHUB_CLIENT_SECRET: 'gh_secret',
        GITHUB_REDIRECT_URL: `${serverBaseUrl}/v1/oauth/github/callback`,
        HAPPIER_WEBAPP_URL: uiReturnBaseUrl,

        GITHUB_OAUTH_AUTHORIZE_URL: `${oauth.baseUrl}/login/oauth/authorize`,
        GITHUB_OAUTH_TOKEN_URL: `${oauth.baseUrl}/login/oauth/access_token`,
        GITHUB_API_USER_URL: `${oauth.baseUrl}/user`,
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      port: uiPort,
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
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
    await oauthStop?.().catch(() => {});
  });

  test('auto-redirects into keyless GitHub login and lands in the app authenticated', async ({ page }) => {
    test.setTimeout(300_000);
    if (!uiBaseUrl) throw new Error('missing ui base url');
    if (!server) throw new Error('missing server');
    if (!oauthBaseUrl) throw new Error('missing oauth base url');
    if (!oauthCounts) throw new Error('missing oauth counts');

    const finalized = page.waitForResponse(
      (resp) => resp.url().startsWith(`${server.baseUrl}/v1/auth/external/github/finalize-keyless`) && resp.status() === 200,
      { timeout: 120_000 },
    );

    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);

    // Auto-redirect should run without the user tapping buttons.
    await expect(page.getByTestId('welcome-create-account')).toHaveCount(0, { timeout: 120_000 });

    await finalized;
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 120_000 })
      .toBe('/');
    await expect
      .poll(async () => await page.getByTestId('session-getting-started-kind-connect_machine').count(), { timeout: 120_000 })
      .toBeGreaterThan(0);

    const counts = oauthCounts();
    expect((counts.authorize ?? 0) > 0).toBe(true);
    expect((counts.token ?? 0) > 0).toBe(true);
    expect((counts.user ?? 0) > 0).toBe(true);

    const dbPath = resolveServerLightSqliteDbPath({ server });
    const raw = execFileSync(
      'sqlite3',
      [
        '-json',
        dbPath,
        "select count(1) as n from AccountIdentity where provider = 'github';",
      ],
      { encoding: 'utf8' },
    );
    const parsed = JSON.parse(raw) as Array<{ n?: unknown }>;
    const n = parsed?.[0]?.n;
    expect(n === 1 || n === '1').toBe(true);
  });
});
