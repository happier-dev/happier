import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: auth + terminal connect', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('auth-terminal-connect-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;
  let accountSecretKeyFormatted: string | null = null;
  let fakeClaudeLogPath: string | null = null;
  let createdSessionId: string | null = null;
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
    await page.getByTestId('welcome-restore').click();

    await expect(page.getByTestId('restore-open-manual')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('restore-open-manual').click();

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

  function resolveServerLightSqliteDbPath(params: { suiteDir: string }): string {
    return resolve(join(params.suiteDir, 'server-light-data', 'happier-server-light.sqlite'));
  }

  function readLatestMachineIdFromServerLightDb(params: { suiteDir: string }): string {
    const dbPath = resolveServerLightSqliteDbPath({ suiteDir: params.suiteDir });
    try {
      const raw = execFileSync('sqlite3', ['-json', dbPath, 'select id from Machine order by createdAt desc limit 1;'], {
        encoding: 'utf8',
      });
      const parsed = JSON.parse(raw) as Array<{ id?: unknown }>;
      const id = parsed?.[0]?.id;
      if (typeof id === 'string' && id.trim()) return id.trim();
    } catch {
      // ignore - pollers can retry
    }
    throw new Error(`Failed to read machine id from server light sqlite db: ${dbPath}`);
  }

  function readMachineActiveFromServerLightDb(params: { suiteDir: string; machineId: string }): boolean | null {
    const dbPath = resolveServerLightSqliteDbPath({ suiteDir: params.suiteDir });
    try {
      const query = `select active from Machine where id = '${params.machineId.replaceAll("'", "''")}' limit 1;`;
      const raw = execFileSync('sqlite3', ['-json', dbPath, query], { encoding: 'utf8' });
      const parsed = JSON.parse(raw) as Array<{ active?: unknown }>;
      const active = parsed?.[0]?.active;
      if (active === 1 || active === true) return true;
      if (active === 0 || active === false) return false;
      return null;
    } catch {
      return null;
    }
  }

  test.beforeAll(async () => {
    test.setTimeout(420_000);
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
          // Make presence timeouts fast enough for UI E2E reconnect flows.
          // NOTE: DB lastActiveAt updates are throttled, so the timeout needs to be comfortably above that threshold.
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

    const pageConsole: string[] = [];
    const pageErrors: string[] = [];
    const requestFailures: string[] = [];
    const responseErrors: string[] = [];

    page.on('console', (msg) => pageConsole.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('requestfailed', (request) => {
      const failure = request.failure();
      requestFailures.push(`${request.method()} ${request.url()} ${failure ? `-> ${failure.errorText}` : ''}`.trim());
    });
    page.on('response', (response) => {
      const status = response.status();
      if (status >= 400) responseErrors.push(`${status} ${response.request().method()} ${response.url()}`);
    });

    const testDir = resolve(join(suiteDir, 't1-create-connect-daemon'));
    await mkdir(testDir, { recursive: true });

    let cliLogin: StartedCliTerminalConnect | null = null;
    let thrown: unknown = null;
    try {
      await page.goto(uiBaseUrl, { waitUntil: 'domcontentloaded' });

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
        const diagnostic =
          `# Browser diagnostics\n\n` +
          `## Console\n\n${pageConsole.length ? pageConsole.join('\n') : '(none)'}\n\n` +
          `## Page errors\n\n${pageErrors.length ? pageErrors.join('\n') : '(none)'}\n\n` +
          `## Request failures\n\n${requestFailures.length ? requestFailures.join('\n') : '(none)'}\n\n` +
          `## Response errors\n\n${responseErrors.length ? responseErrors.join('\n') : '(none)'}\n`;
        await testInfo.attach('browser-diagnostics.md', { body: diagnostic, contentType: 'text/markdown' });
      }
    }
  });

  test('restores the same account using secret key', async ({ page }, testInfo) => {
    test.setTimeout(300_000);
    if (!ui) throw new Error('missing ui fixture');
    if (!uiBaseUrl) throw new Error('missing ui base url');
    if (!accountSecretKeyFormatted) throw new Error('missing account secret key from prior test');

    const pageConsole: string[] = [];
    const pageErrors: string[] = [];
    const requestFailures: string[] = [];
    const responseErrors: string[] = [];

    page.on('console', (msg) => pageConsole.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('requestfailed', (request) => {
      const failure = request.failure();
      requestFailures.push(`${request.method()} ${request.url()} ${failure ? `-> ${failure.errorText}` : ''}`.trim());
    });
    page.on('response', (response) => {
      const status = response.status();
      if (status >= 400) responseErrors.push(`${status} ${response.request().method()} ${response.url()}`);
    });

    let thrown: unknown = null;
    try {
      await restoreAccountUsingSecretKey(page, uiBaseUrl, accountSecretKeyFormatted, { postRestorePath: '/new' });

      await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 60_000 });
      const prompt = `UI_E2E_MESSAGE_${run.runId}`;
      await page.getByTestId('new-session-composer-input').fill(prompt);
      await page.getByTestId('new-session-composer-input').press('Enter');

      await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 180_000 });
      await expect(page.getByText('FAKE_CLAUDE_OK_1')).toHaveCount(1, { timeout: 180_000 });

      const currentUrl = page.url();
      const { pathname } = new URL(currentUrl);
      const parts = pathname.split('/').filter(Boolean);
      const sessionIndex = parts.indexOf('session');
      createdSessionId = sessionIndex >= 0 ? (parts[sessionIndex + 1] ?? null) : null;
      if (!createdSessionId) {
        throw new Error(`Failed to infer session id from url: ${currentUrl}`);
      }
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      if (thrown) {
        const diagnostic =
          `# Browser diagnostics\n\n` +
          `## Console\n\n${pageConsole.length ? pageConsole.join('\n') : '(none)'}\n\n` +
          `## Page errors\n\n${pageErrors.length ? pageErrors.join('\n') : '(none)'}\n\n` +
          `## Request failures\n\n${requestFailures.length ? requestFailures.join('\n') : '(none)'}\n\n` +
          `## Response errors\n\n${responseErrors.length ? responseErrors.join('\n') : '(none)'}\n`;
        await testInfo.attach('browser-diagnostics.md', { body: diagnostic, contentType: 'text/markdown' });

        if (fakeClaudeLogPath) {
          await testInfo
            .attach('fake-claude.jsonl', { path: fakeClaudeLogPath, contentType: 'text/plain' })
            .catch(() => {});
        }
      }
    }
  });

  test('daemon can reconnect and UI reflects offline → online', async ({ page }, testInfo) => {
    test.setTimeout(420_000);
    if (!ui) throw new Error('missing ui fixture');
    if (!server) throw new Error('missing server fixture');
    if (!uiBaseUrl) throw new Error('missing ui base url');
    if (!accountSecretKeyFormatted) throw new Error('missing account secret key from prior test');
    if (!createdSessionId) throw new Error('missing session id from prior test');
    if (!daemon) throw new Error('missing daemon from prior test');
    if (!fakeClaudePath) throw new Error('missing fake Claude path from prior test');

    const pageConsole: string[] = [];
    const pageErrors: string[] = [];
    const requestFailures: string[] = [];
    const responseErrors: string[] = [];

    page.on('console', (msg) => pageConsole.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('requestfailed', (request) => {
      const failure = request.failure();
      requestFailures.push(`${request.method()} ${request.url()} ${failure ? `-> ${failure.errorText}` : ''}`.trim());
    });
    page.on('response', (response) => {
      const status = response.status();
      if (status >= 400) responseErrors.push(`${status} ${response.request().method()} ${response.url()}`);
    });

    const testDir = resolve(join(suiteDir, 't3-daemon-reconnect'));
    await mkdir(testDir, { recursive: true });

    let thrown: unknown = null;
    try {
      await restoreAccountUsingSecretKey(page, uiBaseUrl, accountSecretKeyFormatted);
      await page.goto(`${uiBaseUrl}/session/${createdSessionId}`, { waitUntil: 'domcontentloaded' });

      const ok1 = page.getByText('FAKE_CLAUDE_OK_1');
      const ok1Before = await ok1.count();

      const machineId = readLatestMachineIdFromServerLightDb({ suiteDir });
      await daemon.stop();
      daemon = null;

      await expect
        .poll(async () => {
          return readMachineActiveFromServerLightDb({ suiteDir, machineId });
        }, { timeout: 180_000 })
        .toBe(false);

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
          HAPPIER_VARIANT: 'dev',
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
        },
      });

      await expect
        .poll(async () => {
          return readMachineActiveFromServerLightDb({ suiteDir, machineId });
        }, { timeout: 180_000 })
        .toBe(true);

      await page.goto(`${uiBaseUrl}/session/${createdSessionId}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 120_000 });

      const followup = `UI_E2E_MESSAGE_RECONNECT_${run.runId}`;
      await page.getByTestId('session-composer-input').fill(followup);
      await page.getByTestId('session-composer-input').press('Enter');
      await expect(ok1).toHaveCount(ok1Before + 1, { timeout: 180_000 });
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      if (thrown) {
        const diagnostic =
          `# Browser diagnostics\n\n` +
          `## Console\n\n${pageConsole.length ? pageConsole.join('\n') : '(none)'}\n\n` +
          `## Page errors\n\n${pageErrors.length ? pageErrors.join('\n') : '(none)'}\n\n` +
          `## Request failures\n\n${requestFailures.length ? requestFailures.join('\n') : '(none)'}\n\n` +
          `## Response errors\n\n${responseErrors.length ? responseErrors.join('\n') : '(none)'}\n`;
        await testInfo.attach('browser-diagnostics.md', { body: diagnostic, contentType: 'text/markdown' });
      }
    }
  });

  test('queues messages while daemon is offline and delivers them after reconnect', async ({ page }, testInfo) => {
    test.setTimeout(420_000);
    if (!ui) throw new Error('missing ui fixture');
    if (!server) throw new Error('missing server fixture');
    if (!uiBaseUrl) throw new Error('missing ui base url');
    if (!accountSecretKeyFormatted) throw new Error('missing account secret key from prior test');
    if (!createdSessionId) throw new Error('missing session id from prior test');
    if (!daemon) throw new Error('missing daemon from prior test');
    if (!fakeClaudePath) throw new Error('missing fake Claude path from prior test');

    const pageConsole: string[] = [];
    const pageErrors: string[] = [];
    const requestFailures: string[] = [];
    const responseErrors: string[] = [];

    page.on('console', (msg) => pageConsole.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('requestfailed', (request) => {
      const failure = request.failure();
      requestFailures.push(`${request.method()} ${request.url()} ${failure ? `-> ${failure.errorText}` : ''}`.trim());
    });
    page.on('response', (response) => {
      const status = response.status();
      if (status >= 400) responseErrors.push(`${status} ${response.request().method()} ${response.url()}`);
    });

    const testDir = resolve(join(suiteDir, 't4-offline-queue'));
    await mkdir(testDir, { recursive: true });

    let thrown: unknown = null;
    try {
      await restoreAccountUsingSecretKey(page, uiBaseUrl, accountSecretKeyFormatted);
      await page.goto(`${uiBaseUrl}/session/${createdSessionId}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 120_000 });

      // Ensure prior transcript content is loaded before we snapshot `okBefore`, otherwise
      // late-arriving history can be mistaken for an offline daemon response.
      await expect(page.getByText('FAKE_CLAUDE_OK_1')).toHaveCount(1, { timeout: 120_000 });

      const ok = page.getByText(/FAKE_CLAUDE_OK_/);
      const okBefore = await ok.count();

      const machineId = readLatestMachineIdFromServerLightDb({ suiteDir });
      await daemon.stop();
      daemon = null;

      await expect
        .poll(async () => {
          return readMachineActiveFromServerLightDb({ suiteDir, machineId });
        }, { timeout: 180_000 })
        .toBe(false);

      const prompt = `UI_E2E_MESSAGE_OFFLINE_${run.runId}`;
      await page.getByTestId('session-composer-input').fill(prompt);
      await page.getByTestId('session-composer-input').press('Enter');
      await expect(page.getByText(prompt)).toHaveCount(1, { timeout: 60_000 });

      // While the daemon is offline, we should not receive a provider response.
      await expect
        .poll(async () => {
          return await ok.count();
        }, { timeout: 15_000 })
        .toBe(okBefore);

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
          HAPPIER_VARIANT: 'dev',
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
        },
      });

      await expect
        .poll(async () => {
          return readMachineActiveFromServerLightDb({ suiteDir, machineId });
        }, { timeout: 180_000 })
        .toBe(true);

      await expect(ok).toHaveCount(okBefore + 1, { timeout: 180_000 });
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      if (thrown) {
        const diagnostic =
          `# Browser diagnostics\n\n` +
          `## Console\n\n${pageConsole.length ? pageConsole.join('\n') : '(none)'}\n\n` +
          `## Page errors\n\n${pageErrors.length ? pageErrors.join('\n') : '(none)'}\n\n` +
          `## Request failures\n\n${requestFailures.length ? requestFailures.join('\n') : '(none)'}\n\n` +
          `## Response errors\n\n${responseErrors.length ? responseErrors.join('\n') : '(none)'}\n`;
        await testInfo.attach('browser-diagnostics.md', { body: diagnostic, contentType: 'text/markdown' });
      }
    }
  });

  test('selects the existing session from the list', async ({ page }, testInfo) => {
    test.setTimeout(420_000);
    if (!ui) throw new Error('missing ui fixture');
    if (!uiBaseUrl) throw new Error('missing ui base url');
    if (!accountSecretKeyFormatted) throw new Error('missing account secret key from prior test');
    if (!createdSessionId) throw new Error('missing session id from prior test');

    const pageConsole: string[] = [];
    const pageErrors: string[] = [];
    const requestFailures: string[] = [];
    const responseErrors: string[] = [];

    page.on('console', (msg) => pageConsole.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('requestfailed', (request) => {
      const failure = request.failure();
      requestFailures.push(`${request.method()} ${request.url()} ${failure ? `-> ${failure.errorText}` : ''}`.trim());
    });
    page.on('response', (response) => {
      const status = response.status();
      if (status >= 400) responseErrors.push(`${status} ${response.request().method()} ${response.url()}`);
    });

    let thrown: unknown = null;
    try {
      await restoreAccountUsingSecretKey(page, uiBaseUrl, accountSecretKeyFormatted);
      await page.goto(`${uiBaseUrl}/`, { waitUntil: 'domcontentloaded' });

      const sessionItem = page.getByTestId(`session-list-item-${createdSessionId}`);
      await expect(sessionItem).toHaveCount(1, { timeout: 120_000 });
      await sessionItem.click();

      await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 120_000 });
      await expect(page).toHaveURL(`${uiBaseUrl}/session/${createdSessionId}`, { timeout: 60_000 });
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      if (thrown) {
        const diagnostic =
          `# Browser diagnostics\n\n` +
          `## Console\n\n${pageConsole.length ? pageConsole.join('\n') : '(none)'}\n\n` +
          `## Page errors\n\n${pageErrors.length ? pageErrors.join('\n') : '(none)'}\n\n` +
          `## Request failures\n\n${requestFailures.length ? requestFailures.join('\n') : '(none)'}\n\n` +
          `## Response errors\n\n${responseErrors.length ? responseErrors.join('\n') : '(none)'}\n`;
        await testInfo.attach('browser-diagnostics.md', { body: diagnostic, contentType: 'text/markdown' });

        if (fakeClaudeLogPath) {
          await testInfo
            .attach('fake-claude.jsonl', { path: fakeClaudeLogPath, contentType: 'text/plain' })
            .catch(() => {});
        }
      }
    }
  });

  test('terminal-connect link redirects to welcome when logged out, then can be approved after restore', async ({ page }, testInfo) => {
    test.setTimeout(420_000);
    if (!server || !ui) throw new Error('missing server/ui fixtures');
    if (!uiBaseUrl) throw new Error('missing ui base url');
    if (!accountSecretKeyFormatted) throw new Error('missing account secret key from prior test');

    const pageConsole: string[] = [];
    const pageErrors: string[] = [];
    const requestFailures: string[] = [];
    const responseErrors: string[] = [];

    page.on('console', (msg) => pageConsole.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => pageErrors.push(String(err)));
    page.on('requestfailed', (request) => {
      const failure = request.failure();
      requestFailures.push(`${request.method()} ${request.url()} ${failure ? `-> ${failure.errorText}` : ''}`.trim());
    });
    page.on('response', (response) => {
      const status = response.status();
      if (status >= 400) responseErrors.push(`${status} ${response.request().method()} ${response.url()}`);
    });

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

      await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
      await expect(page.locator('[data-testid="welcome-terminal-connect-intent"]:visible')).toHaveCount(1, { timeout: 60_000 });
      await expect(page.locator('[data-testid="welcome-restore"]:visible')).toHaveCount(1, { timeout: 60_000 });

      // Restore account. The app should automatically open the pending terminal connect approval screen.
      await restoreAccountUsingSecretKey(page, uiBaseUrl, accountSecretKeyFormatted, { postRestorePath: null });

      await page.waitForURL((url) => url.pathname.startsWith('/terminal'), { timeout: 120_000 });
      const approve = page.getByTestId('terminal-connect-approve');
      await expect(approve).toHaveCount(1, { timeout: 120_000 });

      await page.getByTestId('terminal-connect-approve').click();
      await cliLogin.waitForSuccess();
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      await cliLogin?.stop().catch(() => {});
      if (thrown) {
        const diagnostic =
          `# Browser diagnostics\n\n` +
          `## Console\n\n${pageConsole.length ? pageConsole.join('\n') : '(none)'}\n\n` +
          `## Page errors\n\n${pageErrors.length ? pageErrors.join('\n') : '(none)'}\n\n` +
          `## Request failures\n\n${requestFailures.length ? requestFailures.join('\n') : '(none)'}\n\n` +
          `## Response errors\n\n${responseErrors.length ? responseErrors.join('\n') : '(none)'}\n`;
        await testInfo.attach('browser-diagnostics.md', { body: diagnostic, contentType: 'text/markdown' });
      }
    }
  });
});
