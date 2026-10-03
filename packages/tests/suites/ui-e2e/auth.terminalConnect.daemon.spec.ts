import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';
import { waitForDaemonMachineIdFromCliSettings } from '../../src/testkit/uiE2e/daemonMachineId';
import {
  createSessionFromNewSessionComposer,
  reloadCreatedSessionFromNewSessionComposer,
  type CreatedSessionFromNewSessionComposer,
} from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: auth + terminal connect', () => {
  test.describe.configure({ mode: 'serial', timeout: 420_000 });

  const suiteDir = run.testDir('auth-terminal-connect-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;
  let accountSecretKeyFormatted: string | null = null;
  let fakeClaudeLogPath: string | null = null;
  let createdSessionId: string | null = null;
  let createdSession: CreatedSessionFromNewSessionComposer | null = null;
  let fakeClaudePath: string | null = null;

  async function readAccountSecretKeyFromSettings(page: Page, baseUrl: string): Promise<string> {
    await page.goto(`${baseUrl}/settings/account`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-account-secret-key-item')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('settings-account-secret-key-item').click();
    await expect(page.getByTestId('settings-account-secret-key-value')).toHaveCount(1, { timeout: 60_000 });
    const value = (await page.getByTestId('settings-account-secret-key-value').innerText()).trim();
    if (!value) throw new Error('settings-account-secret-key-value is empty');
    return value.replace(/\s+/g, ' ');
  }

  async function restoreAccountUsingSecretKey(
    page: Page,
    baseUrl: string,
    secretKeyFormatted: string,
    options?: { postRestorePath?: string | null },
  ): Promise<void> {
    await gotoDomContentLoadedWithRetries(page, baseUrl);
    const welcomeRestore = page.getByTestId('welcome-restore');
    if ((await welcomeRestore.count()) > 0) {
      await welcomeRestore.click();
    } else {
      // New welcome variants may omit a dedicated restore CTA; manual restore route remains the stable contract.
      await gotoDomContentLoadedWithRetries(page, `${baseUrl}/restore/manual`);
    }

    const openManual = page.getByTestId('restore-open-manual');
    if ((await openManual.count()) > 0) {
      await openManual.click();
    }

    await page.getByTestId('restore-manual-secret-input').fill(secretKeyFormatted);
    const authOk = page.waitForResponse((resp) => resp.url().endsWith('/v1/auth') && resp.status() === 200, { timeout: 60_000 });
    await page.getByTestId('restore-manual-submit').click();
    await authOk;

    // Restore screen calls router.back() after auth; wait for that navigation to complete before forcing our post-restore path.
    await page.waitForURL((url) => !url.pathname.endsWith('/restore/manual'), { timeout: 60_000 });

    const postRestorePath = options?.postRestorePath;
    if (postRestorePath === null) return;

    const path = postRestorePath ?? '/';
    await gotoDomContentLoadedWithRetries(page, `${baseUrl}${path}`);
  }

  async function ensureAuthenticatedAccount(page: Page, baseUrl: string): Promise<void> {
    if (accountSecretKeyFormatted) {
      await restoreAccountUsingSecretKey(page, baseUrl, accountSecretKeyFormatted, { postRestorePath: null });
      return;
    }

    await gotoDomContentLoadedWithRetries(page, baseUrl);
    await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });
    accountSecretKeyFormatted = await readAccountSecretKeyFromSettings(page, baseUrl);
  }

  function getVisibleSessionComposer(page: Page) {
    return page.locator('[data-testid="session-composer-input"]:visible');
  }

  async function waitForLoggedOutTerminalConnectEntry(page: Page): Promise<void> {
    await expect.poll(
      async () => {
        const counts = await Promise.all([
          page.locator('[data-testid="welcome-terminal-connect-intent"]:visible').count(),
          page.locator('[data-testid="welcome-primary-start"]:visible').count(),
          page.locator('[data-testid="welcome-create-account"]:visible').count(),
          page.locator('[data-testid="welcome-signup-provider"]:visible').count(),
          page.getByRole('button', { name: 'Create account' }).count(),
          page.getByRole('button', { name: 'Get started' }).count(),
          page.getByTestId('restore-manual-secret-input').count(),
        ]);
        return counts.some((count) => count > 0);
      },
      { timeout: 60_000 },
    ).toBe(true);
  }

  test.beforeAll(async () => {
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_SERVER_URL: server?.baseUrl ?? '',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
      HAPPIER_E2E_UI_WEB_MODE: 'export',
      HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS ?? '900000',
      HAPPIER_E2E_UI_WEB_EXPORT_FALLBACK_TO_METRO: '0',
      HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS ?? '480000',
    };
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
    await mkdir(cliHomeDir, { recursive: true });

    try {
      server = await startServerLight({
        testDir: suiteDir,
        dbProvider: 'sqlite',
        extraEnv: {
          // UI web E2E currently relies on anonymous create-account, which is blocked when
          // content-keys binding is enabled but web crypto can't produce the binding signature reliably.
          // Keep this test focused on the auth + terminal-connect + daemon flow first.
          HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
          HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
          // This scenario explicitly waits for machine expiry before daemon reconnect.
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
    } catch (error) {
      throw error;
    }
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('creates an account, approves terminal connect, then daemon becomes online', async ({ page }, testInfo) => {
    test.setTimeout(420_000);
    if (!server || !ui) throw new Error('missing server/ui fixtures');
    if (!uiBaseUrl) throw new Error('missing ui base url');

    const browserDiagnostics = collectBrowserDiagnostics({ page });

    const testDir = resolve(join(suiteDir, 't1-create-connect-daemon'));
    await mkdir(testDir, { recursive: true });

    let cliLogin: StartedCliTerminalConnect | null = null;
    let thrown: unknown = null;
    try {
      await page.goto(uiBaseUrl, { waitUntil: 'domcontentloaded' });
      await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });

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
      await expect(page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
      await page.getByTestId('terminal-connect-approve').click();
      await cliLogin.waitForSuccess();

      await page.goto(`${uiBaseUrl}/`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('session-getting-started-kind-start_daemon')).toHaveCount(0, { timeout: 120_000 });

      fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
      fakeClaudePath = fakeClaudeFixturePath();

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
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
        },
      });

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

      accountSecretKeyFormatted = await readAccountSecretKeyFromSettings(page, uiBaseUrl);
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      await cliLogin?.stop().catch(() => {});
      if (thrown) {
        await testInfo.attach('browser-diagnostics.md', { body: browserDiagnostics(), contentType: 'text/markdown' });
      }
    }
  });

  test('restores the same account using secret key', async ({ page }, testInfo) => {
    test.setTimeout(300_000);
    if (!ui) throw new Error('missing ui fixture');
    if (!uiBaseUrl) throw new Error('missing ui base url');
    if (!accountSecretKeyFormatted) throw new Error('missing account secret key from prior test');

    const browserDiagnostics = collectBrowserDiagnostics({ page });

    let thrown: unknown = null;
    try {
      await restoreAccountUsingSecretKey(page, uiBaseUrl, accountSecretKeyFormatted, { postRestorePath: '/new' });

      const prompt = `UI_E2E_MESSAGE_${run.runId}`;
      const machineId = await waitForDaemonMachineIdFromCliSettings({ cliHomeDir, timeoutMs: 120_000 });
      createdSession = await createSessionFromNewSessionComposer({
        page,
        uiBaseUrl,
        machineId,
        prompt,
        readiness: 'first-turn-reload-safe',
      });
      createdSessionId = createdSession.sessionId;

      await expect(getVisibleSessionComposer(page)).toHaveCount(1, { timeout: 180_000 });
      await expect(page).toHaveURL(new RegExp(`/session/${createdSessionId}(?:[/?#]|$)`), { timeout: 60_000 });
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      if (thrown) {
        await testInfo.attach('browser-diagnostics.md', { body: browserDiagnostics(), contentType: 'text/markdown' });

        if (fakeClaudeLogPath) {
          await testInfo
            .attach('fake-claude.jsonl', { path: fakeClaudeLogPath, contentType: 'text/plain' })
            .catch(() => {});
        }
      }
    }
  });

  test('defaults codex backend mode to ACP in account settings', async ({ page }) => {
    test.setTimeout(240_000);
    if (!server) throw new Error('missing server fixture');
    if (!uiBaseUrl) throw new Error('missing ui base url');

    await ensureAuthenticatedAccount(page, uiBaseUrl);
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/providers/codex`);
    const backendModeRow = page.getByTestId('settings-provider-field-codexBackendMode');
    await expect(backendModeRow).toHaveCount(1, { timeout: 60_000 });
    await expect(backendModeRow).toContainText('ACP', { timeout: 60_000 });
  });

  test('daemon can reconnect without losing a follow-up', async ({ page }, testInfo) => {
    test.setTimeout(420_000);
    if (!ui) throw new Error('missing ui fixture');
    if (!server) throw new Error('missing server fixture');
    if (!uiBaseUrl) throw new Error('missing ui base url');
    if (!accountSecretKeyFormatted) throw new Error('missing account secret key from prior test');
    if (!createdSessionId) throw new Error('missing session id from prior test');
    if (!createdSession) throw new Error('missing created session from prior test');
    if (!daemon) throw new Error('missing daemon from prior test');
    if (!fakeClaudePath) throw new Error('missing fake Claude path from prior test');

    const browserDiagnostics = collectBrowserDiagnostics({ page });

    const testDir = resolve(join(suiteDir, 't3-daemon-reconnect'));
    await mkdir(testDir, { recursive: true });

    let thrown: unknown = null;
    try {
      await restoreAccountUsingSecretKey(page, uiBaseUrl, accountSecretKeyFormatted);
      await reloadCreatedSessionFromNewSessionComposer({ page, session: createdSession });

      await waitForDaemonMachineIdFromCliSettings({ cliHomeDir, timeoutMs: 120_000 });
      await daemon.stop();
      daemon = null;

      fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
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
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
        },
      });

      await reloadCreatedSessionFromNewSessionComposer({ page, session: createdSession });
      await expect(getVisibleSessionComposer(page)).toHaveCount(1, { timeout: 120_000 });

      const followup = `UI_E2E_MESSAGE_RECONNECT_${run.runId}`;
      const composer = getVisibleSessionComposer(page);
      await expect(composer).toHaveCount(1, { timeout: 120_000 });
      await composer.fill(followup);
      await page.getByTestId('session-composer-send').click();
      // Depending on whether the restart restores the existing agent process before
      // this send, the follow-up is either delivered or safely remains queued. Both
      // are valid outcomes; the invariant is that the user-visible follow-up is not lost.
      const pending = page.locator('[data-testid^="pendingMessages.message:"]', { hasText: followup })
        .and(page.getByRole('button', { name: 'Pending messages · Queued', exact: true }));
      const delivered = page.locator('[data-testid^="transcript-message-"]:not([data-testid*=":"])', { hasText: followup });
      // Observe either valid visible state in the same retrying assertion. The
      // queue may drain immediately after observation as the daemon reconnects.
      await expect.poll(async () => {
        return await pending.first().isVisible() || await delivered.first().isVisible();
      }, { timeout: 180_000 }).toBe(true);
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      if (thrown) {
        await testInfo.attach('browser-diagnostics.md', { body: browserDiagnostics(), contentType: 'text/markdown' });
      }
    }
  });

  test('selects the existing session from the list', async ({ page }, testInfo) => {
    test.setTimeout(420_000);
    if (!ui) throw new Error('missing ui fixture');
    if (!uiBaseUrl) throw new Error('missing ui base url');
    if (!accountSecretKeyFormatted) throw new Error('missing account secret key from prior test');
    if (!createdSessionId) throw new Error('missing session id from prior test');

    const browserDiagnostics = collectBrowserDiagnostics({ page });

    let thrown: unknown = null;
    try {
      await restoreAccountUsingSecretKey(page, uiBaseUrl, accountSecretKeyFormatted);

      await page.goto(`${uiBaseUrl}/`, { waitUntil: 'domcontentloaded' });
      const sessionItemSelector = `[data-testid="session-list-item-${createdSessionId}"]:visible`;
      await expect(page.locator(sessionItemSelector)).toHaveCount(1, { timeout: 120_000 });
      await page.locator(sessionItemSelector).click();
      await expect(getVisibleSessionComposer(page)).toHaveCount(1, { timeout: 120_000 });
      await expect
        .poll(async () => {
          const url = new URL(page.url());
          return `${url.pathname}${url.search}`;
        }, { timeout: 60_000 })
        .toMatch(new RegExp(`^/session/${createdSessionId}(?:\\?.*)?$`));
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      if (thrown) {
        await testInfo.attach('browser-diagnostics.md', { body: browserDiagnostics(), contentType: 'text/markdown' });

        if (fakeClaudeLogPath) {
          await testInfo
            .attach('fake-claude.jsonl', { path: fakeClaudeLogPath, contentType: 'text/plain' })
            .catch(() => {});
        }
      }
    }
  });

  test('terminal-connect link redirects to welcome when logged out, then can be approved after restore', async ({ page, browser }, testInfo) => {
    test.setTimeout(420_000);
    if (!server || !ui) throw new Error('missing server/ui fixtures');
    if (!uiBaseUrl) throw new Error('missing ui base url');
    if (!accountSecretKeyFormatted) {
      await ensureAuthenticatedAccount(page, uiBaseUrl);
      if (!accountSecretKeyFormatted) {
        throw new Error('missing account secret key after ensureAuthenticatedAccount');
      }
    }

    const ctx = await browser.newContext();
    const loggedOutPage = await ctx.newPage();
    const browserDiagnostics = collectBrowserDiagnostics({ page: loggedOutPage });

    const testDir = resolve(join(suiteDir, 't5-terminal-connect-unauth'));
    await mkdir(testDir, { recursive: true });

    let cliLogin: StartedCliTerminalConnect | null = null;
    let thrown: unknown = null;
    try {
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

      const connectUrl = cliLogin.connectUrl;
      await loggedOutPage.goto(connectUrl, { waitUntil: 'domcontentloaded' });
      await waitForLoggedOutTerminalConnectEntry(loggedOutPage);

      // Restore account. The app should automatically open the pending terminal connect approval screen.
      await restoreAccountUsingSecretKey(loggedOutPage, uiBaseUrl, accountSecretKeyFormatted, { postRestorePath: null });

      // Some welcome variants return to account settings after restore; revisiting the connect URL is the stable contract.
      await gotoDomContentLoadedWithRetries(loggedOutPage, connectUrl, 120_000);
      const approve = loggedOutPage.getByTestId('terminal-connect-approve');
      await expect(approve).toHaveCount(1, { timeout: 120_000 });

      await loggedOutPage.getByTestId('terminal-connect-approve').click();
      await cliLogin.waitForSuccess();
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      await cliLogin?.stop().catch(() => {});
      await ctx.close().catch(() => {});
      if (thrown) {
        await testInfo.attach('browser-diagnostics.md', { body: browserDiagnostics(), contentType: 'text/markdown' });
      }
    }
  });
});
