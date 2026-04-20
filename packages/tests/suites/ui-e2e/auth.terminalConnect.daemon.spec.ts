import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import {
  createAccountAndReachConnectMachineState,
  gotoDomContentLoadedWithRetries,
  normalizeLoopbackBaseUrl,
  dismissSetupWizardIfVisible,
  waitForAuthenticatedHomeUi,
  waitForAuthenticatedRouteUi,
} from '../../src/testkit/uiE2e/pageNavigation';
import { approveTerminalConnect } from '../../src/testkit/uiE2e/approveTerminalConnect';
import { ensurePendingTerminalConnectReadyForApproval } from '../../src/testkit/uiE2e/terminalConnectApprovalFlow';
import {
  captureAuthBootstrapStorageSnapshot,
  installAuthBootstrapStorageSnapshot,
  type AuthBootstrapStorageSnapshot,
} from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: auth + terminal connect', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('auth-terminal-connect-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;
  let authBootstrapSnapshot: AuthBootstrapStorageSnapshot | null = null;
  let fakeClaudeLogPath: string | null = null;
  let createdSessionId: string | null = null;
  let fakeClaudePath: string | null = null;

  function buildServerScopedUiUrl(uiBaseUrl: string, serverBaseUrl: string, path: string = '/'): string {
    const url = new URL(path, uiBaseUrl.endsWith('/') ? uiBaseUrl : `${uiBaseUrl}/`);
    url.searchParams.set('server', serverBaseUrl);
    return url.toString();
  }

  async function restoreAuthenticatedAccount(
    page: Page,
    baseUrl: string,
    serverBaseUrl: string,
    path: string = '/',
  ): Promise<void> {
    if (!authBootstrapSnapshot) {
      throw new Error('missing auth bootstrap snapshot from prior test');
    }
    await installAuthBootstrapStorageSnapshot(page, authBootstrapSnapshot);
    await gotoDomContentLoadedWithRetries(page, buildServerScopedUiUrl(baseUrl, serverBaseUrl, path));
    if (path === '/' || path === '') {
      await waitForAuthenticatedHomeUi({ page, timeoutMs: 120_000 });
      return;
    }

    if (path.startsWith('/new')) {
      await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 120_000 });
      return;
    }
  }

  async function ensureAuthenticatedAccount(page: Page, baseUrl: string, serverBaseUrl: string): Promise<void> {
    if (authBootstrapSnapshot) {
      await restoreAuthenticatedAccount(page, baseUrl, serverBaseUrl);
      return;
    }

    await gotoDomContentLoadedWithRetries(page, buildServerScopedUiUrl(baseUrl, serverBaseUrl));
    await createAccountAndReachConnectMachineState({ page });
    authBootstrapSnapshot = await captureAuthBootstrapStorageSnapshot(page);
  }

  function transcriptMessageLocator(page: Page) {
    return page.locator('[data-testid^="transcript-message-"]');
  }

  function getVisibleSessionComposer(page: Page) {
    return page.locator('[data-testid="session-composer-input"]:visible');
  }

  async function collectBrowserStateDiagnostics(
    page: Page,
    options: Readonly<{
      pageConsole?: readonly string[];
      pageErrors?: readonly string[];
      requestFailures?: readonly string[];
      responseErrors?: readonly string[];
    }> = {},
  ): Promise<string> {
    const url = page.url();
    const origin = (() => {
      try {
        return new URL(url).origin;
      } catch {
        return '';
      }
    })();
    const [cookies, storageSnapshot] = await Promise.all([
      origin ? page.context().cookies([origin]).catch(() => []) : page.context().cookies().catch(() => []),
      page.evaluate(() => {
        const toObject = (storage: Storage): Record<string, string> => {
          const out: Record<string, string> = {};
          for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (!key) continue;
            const value = storage.getItem(key);
            if (value !== null) out[key] = value;
          }
          return out;
        };

        return {
          localStorage: toObject(window.localStorage),
          sessionStorage: toObject(window.sessionStorage),
          activeServerId: window.sessionStorage.getItem('activeServerId') ?? '',
          rawServerState: window.localStorage.getItem('server-state-v1'),
          rawSettings: window.localStorage.getItem('mmkv.default\\settings'),
        };
      }).catch(() => null),
    ]);
    const pageSnapshot = await page.evaluate(() => {
      const root = document.getElementById('root');
      const main = document.querySelector('main');
      return {
        readyState: document.readyState,
        title: document.title,
        rootHtml: root?.innerHTML?.slice(0, 4_000) ?? '',
        mainHtml: main?.innerHTML?.slice(0, 4_000) ?? '',
        bodyText: (document.body?.innerText ?? '').slice(0, 4_000),
      };
    }).catch(() => null);

    const counts = {
      welcomeCreateAccount: await page.getByTestId('welcome-create-account').count().catch(() => 0),
      connectMachine: await page.getByTestId('session-getting-started-kind-connect_machine').count().catch(() => 0),
      createSession: await page.getByTestId('session-getting-started-kind-create_session').count().catch(() => 0),
      selectSession: await page.getByTestId('session-getting-started-kind-select_session').count().catch(() => 0),
      startNewSession: await page.getByTestId('main-header-start-new-session').count().catch(() => 0),
      settingsSidebar: await page.getByTestId('settings-sidebar').count().catch(() => 0),
      codexBackendModeRow: await page.getByTestId('settings-provider-field-codexBackendMode').count().catch(() => 0),
    };

    return [
      '# Browser state',
      `- url: ${url || '(unknown)'}`,
      `- origin: ${origin || '(unknown)'}`,
      '',
      '## Counts',
      '```json',
      JSON.stringify(counts, null, 2),
      '```',
      '',
      '## Cookies',
      '```json',
      JSON.stringify(cookies, null, 2),
      '```',
      '',
      '## Storage',
      '```json',
      JSON.stringify(storageSnapshot, null, 2),
      '```',
      '',
      '## DOM snapshot',
      '```json',
      JSON.stringify(pageSnapshot, null, 2),
      '```',
      '',
      '## Page console',
      '```json',
      JSON.stringify(options.pageConsole ?? [], null, 2),
      '```',
      '',
      '## Page errors',
      '```json',
      JSON.stringify(options.pageErrors ?? [], null, 2),
      '```',
      '',
      '## Request failures',
      '```json',
      JSON.stringify(options.requestFailures ?? [], null, 2),
      '```',
      '',
      '## Response errors',
      '```json',
      JSON.stringify(options.responseErrors ?? [], null, 2),
      '```',
      '',
    ].join('\n');
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

  async function waitForLatestMachineId(params: { suiteDir: string; timeoutMs?: number }): Promise<string> {
    const timeoutMs = params.timeoutMs ?? 60_000;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      try {
        return readLatestMachineIdFromServerLightDb({ suiteDir: params.suiteDir });
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    return readLatestMachineIdFromServerLightDb({ suiteDir: params.suiteDir });
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
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_SERVER_URL: server?.baseUrl ?? '',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
      HAPPIER_E2E_UI_WEB_MODE: 'export',
      HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS ?? '900000',
      HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS:
        process.env.HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS ?? '600000',
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
          HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
          HAPPIER_VARIANT: 'dev',
        },
      });

      await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
      await approveTerminalConnect({ page });
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

      authBootstrapSnapshot = await captureAuthBootstrapStorageSnapshot(page);
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
    if (!server) throw new Error('missing server fixture');
    if (!ui) throw new Error('missing ui fixture');
    if (!uiBaseUrl) throw new Error('missing ui base url');
    if (!authBootstrapSnapshot) throw new Error('missing auth bootstrap snapshot from prior test');

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
      await restoreAuthenticatedAccount(page, uiBaseUrl, server.baseUrl, '/new');

      await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 60_000 });
      const machineId = await waitForLatestMachineId({ suiteDir, timeoutMs: 120_000 });
      await expect(page.getByTestId('agent-input-machine-chip')).toHaveCount(1, { timeout: 120_000 });
      await page.getByTestId('agent-input-machine-chip').click();
      await expect(page.getByTestId(`new-session-machine:${machineId}`)).toHaveCount(1, { timeout: 120_000 });
      await page.getByTestId(`new-session-machine:${machineId}`).click();

      const prompt = `UI_E2E_MESSAGE_${run.runId}`;
      await page.getByTestId('new-session-composer-input').fill(prompt);
      await expect(page.getByTestId('new-session-composer-send')).toHaveCount(1, { timeout: 60_000 });
      await page.getByTestId('new-session-composer-send').click();

      await expect(getVisibleSessionComposer(page)).toHaveCount(1, { timeout: 180_000 });
      await expect.poll(async () => transcriptMessageLocator(page).count(), { timeout: 180_000 }).toBeGreaterThan(1);

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

  test('defaults codex backend mode to ACP in account settings', async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    if (!server) throw new Error('missing server fixture');
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

    let thrown: unknown = null;
    try {
      await ensureAuthenticatedAccount(page, uiBaseUrl, server.baseUrl);
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/providers/codex`);
      await waitForAuthenticatedRouteUi({
        page,
        expectedPathname: '/settings/providers/codex',
        requiredTestIds: ['settings-provider-field-codexBackendMode'],
      });
      const backendModeRow = page.getByTestId('settings-provider-field-codexBackendMode');
      await expect(backendModeRow).toHaveCount(1, { timeout: 60_000 });
      await expect(backendModeRow).toContainText('ACP', { timeout: 60_000 });
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

        const browserState = await collectBrowserStateDiagnostics(page, {
          pageConsole,
          pageErrors,
          requestFailures,
          responseErrors,
        }).catch((collectError) => [
          '# Browser state',
          `- diagnostics collection failed: ${String(collectError)}`,
          `- url: ${page.url() || '(unknown)'}`,
        ].join('\n'));
        await testInfo.attach('browser-state.md', {
          body: browserState,
          contentType: 'text/markdown',
        }).catch(() => {});
      }
    }
  });

  test('daemon can reconnect and UI reflects offline → online', async ({ page }, testInfo) => {
    test.setTimeout(420_000);
    if (!ui) throw new Error('missing ui fixture');
    if (!server) throw new Error('missing server fixture');
    if (!uiBaseUrl) throw new Error('missing ui base url');
    if (!authBootstrapSnapshot) throw new Error('missing auth bootstrap snapshot from prior test');
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
      await restoreAuthenticatedAccount(page, uiBaseUrl, server.baseUrl);
      await page.goto(`${uiBaseUrl}/session/${createdSessionId}`, { waitUntil: 'domcontentloaded' });

      const transcriptMessages = transcriptMessageLocator(page);
      const messageCountBefore = await transcriptMessages.count();

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
          HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
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
      await expect(getVisibleSessionComposer(page)).toHaveCount(1, { timeout: 120_000 });

      const followup = `UI_E2E_MESSAGE_RECONNECT_${run.runId}`;
      const composer = getVisibleSessionComposer(page);
      await expect(composer).toHaveCount(1, { timeout: 120_000 });
      await composer.fill(followup);
      await composer.press('Enter');
      await expect.poll(async () => transcriptMessages.count(), { timeout: 180_000 }).toBeGreaterThan(messageCountBefore);
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
    if (!server) throw new Error('missing server fixture');
    if (!ui) throw new Error('missing ui fixture');
    if (!uiBaseUrl) throw new Error('missing ui base url');
    if (!authBootstrapSnapshot) throw new Error('missing auth bootstrap snapshot from prior test');
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
      await restoreAuthenticatedAccount(page, uiBaseUrl, server.baseUrl);

      await page.goto(`${uiBaseUrl}/`, { waitUntil: 'domcontentloaded' });
      await dismissSetupWizardIfVisible({ page });
      const machineId = await waitForLatestMachineId({ suiteDir, timeoutMs: 120_000 });
      await waitForAuthenticatedHomeUi({ page, timeoutMs: 180_000 });
      const startNewSessionButton = page.getByTestId('main-header-start-new-session');
      const directMachineAction = page.getByTestId(`sessions-empty-state-machine:${machineId}`);
      const createSessionState = page.getByTestId('session-getting-started-kind-create_session');
      const selectSessionState = page.getByTestId('session-getting-started-kind-select_session');

      await expect
        .poll(
          async () => {
            const startNewCount = await startNewSessionButton.count();
            const directCount = await directMachineAction.count();
            const createCount = await createSessionState.count();
            const selectCount = await selectSessionState.count();
            return startNewCount > 0 || directCount > 0 || createCount > 0 || selectCount > 0;
          },
          { timeout: 120_000 },
        )
        .toBe(true);

      if ((await startNewSessionButton.count()) > 0) {
        await startNewSessionButton.click();
      } else if ((await directMachineAction.count()) > 0) {
        await directMachineAction.click();
      } else {
        await gotoDomContentLoadedWithRetries(page, buildServerScopedUiUrl(uiBaseUrl, server.baseUrl, '/new'));
      }

      await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 120_000 });
      await expect(page.getByTestId('agent-input-machine-chip')).toHaveCount(1, { timeout: 120_000 });
      await page.getByTestId('agent-input-machine-chip').click();
      await expect(page.getByTestId(`new-session-machine:${machineId}`)).toHaveCount(1, { timeout: 120_000 });
      await page.getByTestId(`new-session-machine:${machineId}`).click();

      const prompt = `UI_E2E_SELECT_FROM_LIST_${run.runId}`;
      await page.getByTestId('new-session-composer-input').fill(prompt);
      await expect(page.getByTestId('new-session-composer-send')).toHaveCount(1, { timeout: 60_000 });
      await page.getByTestId('new-session-composer-send').click();

      await expect(getVisibleSessionComposer(page)).toHaveCount(1, { timeout: 180_000 });

      const currentUrl = page.url();
      const currentRoute = new URL(currentUrl);
      const { pathname } = currentRoute;
      const parts = pathname.split('/').filter(Boolean);
      const sessionIndex = parts.indexOf('session');
      const freshSessionId = sessionIndex >= 0 ? (parts[sessionIndex + 1] ?? null) : null;
      if (!freshSessionId) {
        throw new Error(`Failed to infer session id from url: ${currentUrl}`);
      }
      await expect(page.getByTestId('session-header-back')).toHaveCount(1, { timeout: 120_000 });
      await page.getByTestId('session-header-back').click();

      if (new URL(page.url()).pathname !== '/') {
        await gotoDomContentLoadedWithRetries(page, buildServerScopedUiUrl(uiBaseUrl, server.baseUrl));
      }
      await waitForAuthenticatedHomeUi({ page, timeoutMs: 120_000 });
      const persistedTab = page.getByTestId('sessions-list-storage-tab:persisted');
      if ((await persistedTab.count()) > 0) {
        await persistedTab.click();
      }

      const sessionItem = page.getByTestId(`session-list-item-${freshSessionId}`);
      await expect(sessionItem).toHaveCount(1, { timeout: 120_000 });
      await sessionItem.click();

      await expect(getVisibleSessionComposer(page)).toHaveCount(1, { timeout: 120_000 });
      await expect
        .poll(
          async () => {
            const selectedUrl = new URL(page.url());
            return selectedUrl.pathname;
          },
          { timeout: 60_000 },
        )
        .toBe(`/session/${freshSessionId}`);
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

  test('terminal-connect link redirects to welcome when logged out, then can be approved after restore', async ({ page, browser }, testInfo) => {
    test.setTimeout(420_000);
    if (!server || !ui) throw new Error('missing server/ui fixtures');
    if (!uiBaseUrl) throw new Error('missing ui base url');
    if (!authBootstrapSnapshot) {
      await ensureAuthenticatedAccount(page, uiBaseUrl, server.baseUrl);
      if (!authBootstrapSnapshot) {
        throw new Error('missing auth bootstrap snapshot after ensureAuthenticatedAccount');
      }
    }
    const restoredAuthBootstrapSnapshot = authBootstrapSnapshot;

    const pageConsole: string[] = [];
    const pageErrors: string[] = [];
    const requestFailures: string[] = [];
    const responseErrors: string[] = [];

    const ctx = await browser.newContext({
      storageState: {
        cookies: [],
        origins: [],
      },
    });
    const loggedOutPage = await ctx.newPage();

    loggedOutPage.on('console', (msg) => pageConsole.push(`[${msg.type()}] ${msg.text()}`));
    loggedOutPage.on('pageerror', (err) => pageErrors.push(String(err)));
    loggedOutPage.on('requestfailed', (request) => {
      const failure = request.failure();
      requestFailures.push(`${request.method()} ${request.url()} ${failure ? `-> ${failure.errorText}` : ''}`.trim());
    });
    loggedOutPage.on('response', (response) => {
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
          HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
          HAPPIER_VARIANT: 'dev',
        },
      });

      await gotoDomContentLoadedWithRetries(loggedOutPage, cliLogin.connectUrl);
      await ensurePendingTerminalConnectReadyForApproval({
        page: loggedOutPage,
        connectUrlForBrowser: cliLogin.connectUrl,
        gotoConnectUrl: async (url) => {
          await gotoDomContentLoadedWithRetries(loggedOutPage, url);
        },
        restoreAccount: async () => {
          await installAuthBootstrapStorageSnapshot(loggedOutPage, restoredAuthBootstrapSnapshot);
        },
      });

      await approveTerminalConnect({ page: loggedOutPage });
      await cliLogin.waitForSuccess();
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      await cliLogin?.stop().catch(() => {});
      await ctx.close().catch(() => {});
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

  test('open session converges to restore account after server auth secret rotation', async ({ page }, testInfo) => {
    test.setTimeout(480_000);
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

    const testDir = resolve(join(suiteDir, 't6-stale-auth-rotation'));
    await mkdir(testDir, { recursive: true });

    const collectSessionAuthSurfaceState = async () => ({
      url: page.url(),
      pathname: new URL(page.url()).pathname,
      restoreCount: await page.getByTestId('session-auth-sync-error-restore').count().catch(() => 0),
      syncErrorCount: await page.getByTestId('session-auth-sync-error').count().catch(() => 0),
      fallbackCount: await page.getByTestId('session-auth-required-fallback').count().catch(() => 0),
      composerCount: await getVisibleSessionComposer(page).count().catch(() => 0),
      bodyText: (await page.locator('body').innerText().catch(() => '')).slice(0, 4_000),
    });

    let cliLogin: StartedCliTerminalConnect | null = null;
    let thrown: unknown = null;
    try {
      await ensureAuthenticatedAccount(page, uiBaseUrl, server.baseUrl);

      if (!daemon) {
        cliLogin = await startCliAuthLoginForTerminalConnect({
          testDir: resolve(join(testDir, 'cli-login')),
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

        await gotoDomContentLoadedWithRetries(page, cliLogin.connectUrl);
        await approveTerminalConnect({ page });
        await cliLogin.waitForSuccess();

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
            HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}-stale-auth`,
            HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}-stale-auth`,
          },
        });
      }

      if (!createdSessionId) {
        await restoreAuthenticatedAccount(page, uiBaseUrl, server.baseUrl, '/new');
        await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 60_000 });
        const machineId = await waitForLatestMachineId({ suiteDir, timeoutMs: 120_000 });
        await expect(page.getByTestId('agent-input-machine-chip')).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId('agent-input-machine-chip').click();
        await expect(page.getByTestId(`new-session-machine:${machineId}`)).toHaveCount(1, { timeout: 120_000 });
        await page.getByTestId(`new-session-machine:${machineId}`).click();

        const prompt = `UI_E2E_STALE_AUTH_${run.runId}`;
        await page.getByTestId('new-session-composer-input').fill(prompt);
        await page.getByTestId('new-session-composer-send').click();
        await expect(getVisibleSessionComposer(page)).toHaveCount(1, { timeout: 180_000 });
        await expect.poll(async () => transcriptMessageLocator(page).count(), { timeout: 180_000 }).toBeGreaterThan(1);

        const currentUrl = page.url();
        const { pathname } = new URL(currentUrl);
        const parts = pathname.split('/').filter(Boolean);
        const sessionIndex = parts.indexOf('session');
        createdSessionId = sessionIndex >= 0 ? (parts[sessionIndex + 1] ?? null) : null;
        if (!createdSessionId) {
          throw new Error(`Failed to infer session id from url: ${currentUrl}`);
        }
      } else {
        await restoreAuthenticatedAccount(page, uiBaseUrl, server.baseUrl, `/session/${createdSessionId}`);
        await expect(getVisibleSessionComposer(page)).toHaveCount(1, { timeout: 120_000 });
      }

      const beforeRotationState = await collectSessionAuthSurfaceState();
      await testInfo.attach('before-rotation.json', {
        body: JSON.stringify(beforeRotationState, null, 2),
        contentType: 'application/json',
      });
      await testInfo.attach('before-rotation.png', {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });

      const secretPath = resolve(join(suiteDir, 'server-light-data', 'handy-master-secret.txt'));
      await writeFile(secretPath, `${randomBytes(32).toString('hex')}\n`, 'utf8');
      const originalPort = server.port;
      await server.stop();
      server = await startServerLight({
        testDir: suiteDir,
        dbProvider: 'sqlite',
        dataDirMode: 'reuse-existing',
        extraEnv: {
          HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
          HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
          HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '60000',
          HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '60000',
          HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '1000',
        },
        __portAllocator: async () => originalPort,
      });

      let convergedState: Awaited<ReturnType<typeof collectSessionAuthSurfaceState>> | null = null;
      const pollStartedAt = Date.now();
      while (Date.now() - pollStartedAt < 30_000) {
        const current = await collectSessionAuthSurfaceState();
        if (current.restoreCount > 0 || current.fallbackCount > 0 || current.syncErrorCount > 0) {
          convergedState = current;
          break;
        }
        await page.waitForTimeout(1_000);
      }

      if (!convergedState) {
        const finalState = await collectSessionAuthSurfaceState();
        throw new Error(
          `stale-auth session route did not converge to restore surface within 30s: ${JSON.stringify(finalState)}`,
        );
      }

      await testInfo.attach('after-rotation.json', {
        body: JSON.stringify(convergedState, null, 2),
        contentType: 'application/json',
      });
      await testInfo.attach('after-rotation.png', {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });

      await expect(page.getByTestId('session-auth-sync-error-restore')).toHaveCount(1, { timeout: 120_000 });
      await page.getByTestId('session-auth-sync-error-restore').click();
      await expect.poll(() => new URL(page.url()).pathname, { timeout: 120_000 }).toBe('/restore');
    } catch (error) {
      thrown = error;
      throw error;
    } finally {
      await cliLogin?.stop().catch(() => {});
      if (thrown) {
        const diagnostic = await collectBrowserStateDiagnostics(page, {
          pageConsole,
          pageErrors,
          requestFailures,
          responseErrors,
        });
        await testInfo.attach('browser-diagnostics.md', { body: diagnostic, contentType: 'text/markdown' });
      }
    }
  });
});
