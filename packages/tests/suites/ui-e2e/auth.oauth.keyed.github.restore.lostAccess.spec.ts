import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { reserveAvailablePort } from '../../src/testkit/network/reserveAvailablePort';
import { startFakeGitHubOAuthServer, type StopFn } from '../../src/testkit/oauth/fakeGithubOAuthServer';

const run = createRunDirs({ runLabel: 'ui-e2e' });

type GithubOAuthHarness = Readonly<{
  baseUrl: string;
  stop: StopFn;
  getCounts: () => Readonly<Record<string, number>>;
}>;

function resolveServerLightSqliteDbPath(params: { server: StartedServer }): string {
  return resolve(join(params.server.dataDir, 'happier-server-light.sqlite'));
}

function querySqliteJson(dbPath: string, sql: string): unknown {
  const raw = execFileSync('sqlite3', ['-json', dbPath, sql], { encoding: 'utf8' });
  return JSON.parse(raw) as unknown;
}

async function readKeyedSecretFromLocalStorage(page: { evaluate: <T>(fn: () => T | Promise<T>) => Promise<T> }): Promise<string> {
  const secrets = await page.evaluate(() => {
    const safeParse = (raw: string) => {
      try {
        return JSON.parse(raw);
      } catch {
        return null;
      }
    };

    const found: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (!key.startsWith('auth_credentials__srv_')) continue;
      const value = localStorage.getItem(key);
      if (typeof value !== 'string' || !value) continue;
      const parsed: any = safeParse(value);
      if (!parsed || typeof parsed !== 'object') continue;
      if (typeof parsed.secret === 'string' && parsed.secret.trim().length > 0) {
        found.push(parsed.secret.trim());
      }
    }
    return found;
  });

  if (!Array.isArray(secrets) || secrets.length === 0) {
    throw new Error('missing keyed secret in localStorage');
  }
  // Most-recent is last-write wins; in practice only one should exist.
  return secrets[secrets.length - 1]!;
}

test.describe('ui e2e: keyed GitHub OAuth restore + lost access', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('auth-oauth-keyed-github-restore-lost-access-suite');

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let oauth: GithubOAuthHarness | null = null;

  test.beforeAll(async () => {
    test.setTimeout(600_000);
    await mkdir(suiteDir, { recursive: true });

    oauth = await startFakeGitHubOAuthServer();

    const uiPort = await reserveAvailablePort();
    const uiReturnBaseUrl = `http://127.0.0.1:${uiPort}`;

    const serverPort = await reserveAvailablePort();
    const serverBaseUrl = `http://127.0.0.1:${serverPort}`;

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      __portAllocator: async () => serverPort,
      extraEnv: {
        AUTH_ANONYMOUS_SIGNUP_ENABLED: '0',
        AUTH_SIGNUP_PROVIDERS: 'github',

        HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '0',
        HAPPIER_FEATURE_AUTH_OAUTH__KEYLESS_ENABLED: '0',
        HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_ENABLED: '0',

        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'required_e2ee',
        HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'e2ee',

        HAPPIER_FEATURE_AUTH_RECOVERY__PROVIDER_RESET_ENABLED: '1',

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
    await oauth?.stop().catch(() => {});
  });

  test('signs up with keyed GitHub OAuth and requires restore on another browser', async ({ page, browser }) => {
    test.setTimeout(300_000);
    if (!uiBaseUrl) throw new Error('missing ui base url');
    if (!server) throw new Error('missing server');
    if (!oauth) throw new Error('missing oauth');

    const finalizedFirst = page.waitForResponse(
      (resp) => resp.url().startsWith(`${server.baseUrl}/v1/auth/external/github/finalize`) && resp.status() === 200,
      { timeout: 120_000 },
    );

    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
    await page.getByTestId('welcome-signup-provider').click();

      await finalizedFirst;
      await expect.poll(() => new URL(page.url()).pathname, { timeout: 120_000 }).toBe('/');
      await expect
        .poll(async () => await page.getByTestId('session-getting-started-kind-connect_machine').count(), { timeout: 120_000 })
        .toBeGreaterThan(0);

    const secret = await readKeyedSecretFromLocalStorage(page);

    const dbPath = resolveServerLightSqliteDbPath({ server });
    const identityRows = querySqliteJson(
      dbPath,
      "select count(1) as n from AccountIdentity where provider = 'github';",
    ) as Array<{ n?: unknown }>;
    expect(identityRows?.[0]?.n === 1 || identityRows?.[0]?.n === '1').toBe(true);

    const keyedAccountRows = querySqliteJson(
      dbPath,
      "select count(1) as n from Account where publicKey is not null;",
    ) as Array<{ n?: unknown }>;
    expect(keyedAccountRows?.[0]?.n === 1 || keyedAccountRows?.[0]?.n === '1').toBe(true);

    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    try {
      const finalizedSecond = page2.waitForResponse(
        (resp) => resp.url().startsWith(`${server.baseUrl}/v1/auth/external/github/finalize`) && resp.status() === 409,
        { timeout: 120_000 },
      );

      await gotoDomContentLoadedWithRetries(page2, uiBaseUrl);
      await page2.getByTestId('welcome-signup-provider').click();

      await finalizedSecond;
      await expect.poll(() => new URL(page2.url()).pathname, { timeout: 120_000 }).toBe('/restore');

      await page2.getByTestId('restore-open-manual').click();
      await page2.getByTestId('restore-manual-secret-input').fill(secret);
      const authOk = page2.waitForResponse((resp) => resp.url().endsWith('/v1/auth') && resp.status() === 200, { timeout: 120_000 });
      await page2.getByTestId('restore-manual-submit').click();
      await authOk;

      await expect(page2.getByTestId('restore-manual-secret-input')).toHaveCount(0, { timeout: 120_000 });
      await expect
        .poll(async () => await page2.getByTestId('main-header-start-new-session').count(), { timeout: 120_000 })
        .toBeGreaterThan(0);
    } finally {
      await ctx2.close();
    }

    const counts = oauth.getCounts();
    expect((counts.authorize ?? 0) > 0).toBe(true);
    expect((counts.token ?? 0) > 0).toBe(true);
    expect((counts.user ?? 0) > 0).toBe(true);
  });

  test('supports provider reset (lost access) via GitHub OAuth', async ({ browser }) => {
    test.setTimeout(300_000);
    if (!uiBaseUrl) throw new Error('missing ui base url');
    if (!server) throw new Error('missing server');

    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    try {
      const initialFinalize = p.waitForResponse(
        (resp) => resp.url().startsWith(`${server.baseUrl}/v1/auth/external/github/finalize`) && resp.status() === 409,
        { timeout: 120_000 },
      );

      await gotoDomContentLoadedWithRetries(p, uiBaseUrl);
      await p.getByTestId('welcome-signup-provider').click();
      await initialFinalize;

      await expect.poll(() => new URL(p.url()).pathname, { timeout: 120_000 }).toBe('/restore');

      await expect(p.getByTestId('restore-open-lost-access')).toHaveCount(1, { timeout: 120_000 });
      await p.getByTestId('restore-open-lost-access').click();

      await expect.poll(() => new URL(p.url()).pathname, { timeout: 120_000 }).toBe('/restore/lost-access');
      await expect(p.getByTestId('lost-access-provider-github')).toHaveCount(1, { timeout: 120_000 });
      await p.getByTestId('lost-access-provider-github').click();

      const resetFinalize = p.waitForResponse(
        (resp) => resp.url().startsWith(`${server.baseUrl}/v1/auth/external/github/finalize`) && resp.status() === 200,
        { timeout: 120_000 },
      );
      await expect(p.getByTestId('web-modal-confirm')).toHaveCount(1, { timeout: 120_000 });
      await p.getByTestId('web-modal-confirm').click({ timeout: 120_000 });
      await resetFinalize;

      await expect
        .poll(async () => await p.getByTestId('main-header-start-new-session').count(), { timeout: 120_000 })
        .toBeGreaterThan(0);
    } finally {
      await ctx.close();
    }

    const dbPath = resolveServerLightSqliteDbPath({ server });
    const accountRows = querySqliteJson(dbPath, 'select count(1) as n from Account;') as Array<{ n?: unknown }>;
    expect((accountRows?.[0]?.n as any) === 2 || (accountRows?.[0]?.n as any) === '2').toBe(true);
  });
});
