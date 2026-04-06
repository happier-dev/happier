import { test, expect, type Page } from '@playwright/test';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { resolveUiWebExportSuiteTimeoutMs } from '../../src/testkit/process/uiWebEnv';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { enableDirectSessionsFeature } from '../../src/testkit/uiE2e/enableDirectSessionsFeature';
import { createAccountAndReachConnectMachineState, gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e' });

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function responseItemLine(params: { timestamp: string; payload: Record<string, unknown> }): string {
  return jsonlLine({ type: 'response_item', timestamp: params.timestamp, payload: params.payload });
}

function collectBrowserDiagnostics(params: Readonly<{ page: Page }>): () => string {
  const pageConsole: string[] = [];
  const pageErrors: string[] = [];
  const requestFailures: string[] = [];
  const responseErrors: string[] = [];

  params.page.on('console', (msg) => pageConsole.push(`[${msg.type()}] ${msg.text()}`));
  params.page.on('pageerror', (err) => pageErrors.push(String(err)));
  params.page.on('requestfailed', (request) => {
    const failure = request.failure();
    requestFailures.push(`${request.method()} ${request.url()} ${failure ? `-> ${failure.errorText}` : ''}`.trim());
  });
  params.page.on('response', (response) => {
    if (response.status() >= 400) {
      responseErrors.push(`${response.status()} ${response.request().method()} ${response.url()}`);
    }
  });

  return () =>
    `# Browser diagnostics\n\n`
    + `## Console\n\n${pageConsole.length ? pageConsole.join('\n') : '(none)'}\n\n`
    + `## Page errors\n\n${pageErrors.length ? pageErrors.join('\n') : '(none)'}\n\n`
    + `## Request failures\n\n${requestFailures.length ? requestFailures.join('\n') : '(none)'}\n\n`
    + `## Response errors\n\n${responseErrors.length ? responseErrors.join('\n') : '(none)'}\n`;
}

test.describe('ui e2e: direct Codex sessions browse/open/tail', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-direct-codex-browse-open-tail-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));
  const codexHomeDir = resolve(join(suiteDir, '.codex'));
  const remoteSessionId = '11111111-1111-1111-1111-111111111111';
  const rolloutFile = resolve(join(codexHomeDir, 'sessions', '2026', '03', '06', `rollout-2026-03-06T00-00-00-${remoteSessionId}.jsonl`));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    const uiWebExportSuiteTimeoutMs = String(resolveUiWebExportSuiteTimeoutMs(process.env));
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_HAPPY_SERVER_URL: server?.baseUrl ?? '',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-codex`,
      HAPPIER_E2E_UI_WEB_MODE: process.env.HAPPIER_E2E_UI_WEB_MODE ?? 'export',
      HAPPIER_E2E_UI_WEB_EXPORT_FALLBACK_TO_METRO:
        process.env.HAPPIER_E2E_UI_WEB_EXPORT_FALLBACK_TO_METRO ?? '0',
      HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS:
        process.env.HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS ?? '600000',
      HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS:
        process.env.HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS ?? uiWebExportSuiteTimeoutMs,
      HAPPIER_E2E_UI_WEB_EXPORT_HARD_TIMEOUT_MS:
        process.env.HAPPIER_E2E_UI_WEB_EXPORT_HARD_TIMEOUT_MS ?? uiWebExportSuiteTimeoutMs,
      HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS:
        process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS ?? '480000',
    };
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
    await mkdir(cliHomeDir, { recursive: true });
    await mkdir(resolve(join(codexHomeDir, 'sessions', '2026', '03', '06')), { recursive: true });
    await writeFile(
      rolloutFile,
      [
        jsonlLine({
          type: 'session_meta',
          payload: {
            id: remoteSessionId,
            timestamp: '2026-03-06T00:00:00.000Z',
            cwd: '/tmp/direct-codex-ui-project',
          },
        }),
        responseItemLine({
          timestamp: '2026-03-06T00:00:01.000Z',
          payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'older direct codex ui message' }] },
        }),
        responseItemLine({
          timestamp: '2026-03-06T00:00:02.000Z',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'latest direct codex ui reply' }] },
        }),
      ].join(''),
      'utf8',
    );

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '1000',
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
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

  test('links a provider-backed Codex direct session and follows appended rollout lines', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');
    const browserDiagnostics = collectBrowserDiagnostics({ page });

    const testDir = resolve(join(suiteDir, 't1-direct-codex-browse-open-tail'));
    await mkdir(testDir, { recursive: true });

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
    await waitForInitialAppUi({ page, timeoutMs: 180_000, browserDiagnostics });
    await createAccountAndReachConnectMachineState({ page });

    const cliLogin: StartedCliTerminalConnect = await startCliAuthLoginForTerminalConnect({
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      webappUrl: uiBaseUrl,
      env: {
        HOME: cliHomeDir,
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
        HOME: cliHomeDir,
        CI: '1',
        HAPPIER_HOME_DIR: cliHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: uiBaseUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        CODEX_HOME: codexHomeDir,
        HAPPIER_DIRECT_SESSIONS_PAGE_MAX_ITEMS: '2',
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

    const searchInput = page.getByTestId('direct-session-candidates-search-input');
    await expect(searchInput).toHaveCount(1, { timeout: 60_000 });
    await searchInput.fill('older direct codex');

    const candidate = page.getByTestId(`direct-session-candidate:${remoteSessionId}`);
    await expect(candidate).toHaveCount(1, { timeout: 120_000 });
    await expect(candidate).toContainText('older direct codex ui message', { timeout: 120_000 });
    await page.getByTestId(`direct-session-candidate:${remoteSessionId}`).click();

    const transcript = page.getByTestId('transcript-chat-list');
    await expect(transcript).toHaveCount(1, { timeout: 120_000 });
    await expect(transcript.getByText('older direct codex ui message')).toHaveCount(1, { timeout: 60_000 });
    await expect(transcript.getByText('latest direct codex ui reply')).toHaveCount(1, { timeout: 60_000 });

    await appendFile(
      rolloutFile,
      responseItemLine({
        timestamp: '2026-03-06T00:00:03.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'tail appended direct codex ui message' }] },
      }),
      'utf8',
    );

    await expect(transcript.getByText('tail appended direct codex ui message')).toHaveCount(1, { timeout: 60_000 });
  });

  test('toggles background follow from the session actions menu and preserves it after reload', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const testDir = resolve(join(suiteDir, 't2-direct-codex-background-follow'));
    const backgroundFollowRemoteSessionId = '22222222-2222-2222-2222-222222222222';
    const backgroundFollowRolloutFile = resolve(
      join(codexHomeDir, 'sessions', '2026', '03', '06', `rollout-2026-03-06T00-00-00-${backgroundFollowRemoteSessionId}.jsonl`),
    );

    await mkdir(resolve(join(codexHomeDir, 'sessions', '2026', '03', '06')), { recursive: true });
    await mkdir(testDir, { recursive: true });
    await writeFile(
      backgroundFollowRolloutFile,
      [
        jsonlLine({
          type: 'session_meta',
          payload: {
            id: backgroundFollowRemoteSessionId,
            timestamp: '2026-03-06T01:00:00.000Z',
            cwd: '/tmp/direct-codex-background-follow-project',
          },
        }),
        responseItemLine({
          timestamp: '2026-03-06T01:00:01.000Z',
          payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'background follow seed message' }] },
        }),
        responseItemLine({
          timestamp: '2026-03-06T01:00:02.000Z',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'background follow seed reply' }] },
        }),
      ].join(''),
      'utf8',
    );

    const browserDiagnostics = collectBrowserDiagnostics({ page });

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
    await waitForInitialAppUi({ page, timeoutMs: 180_000, browserDiagnostics });
    await createAccountAndReachConnectMachineState({ page });

    const cliLogin: StartedCliTerminalConnect = await startCliAuthLoginForTerminalConnect({
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      webappUrl: uiBaseUrl,
      env: {
        HOME: cliHomeDir,
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
        HOME: cliHomeDir,
        CI: '1',
        HAPPIER_HOME_DIR: cliHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: uiBaseUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        CODEX_HOME: codexHomeDir,
        HAPPIER_DIRECT_SESSIONS_PAGE_MAX_ITEMS: '2',
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

    const searchInput = page.getByTestId('direct-session-candidates-search-input');
    await expect(searchInput).toHaveCount(1, { timeout: 60_000 });
    await searchInput.fill('background follow');

    const candidate = page.getByTestId(`direct-session-candidate:${backgroundFollowRemoteSessionId}`);
    await expect(candidate).toHaveCount(1, { timeout: 120_000 });
    await expect(candidate).toContainText('background follow seed message', { timeout: 120_000 });
    await candidate.click();

    const sessionActionsTrigger = page.getByLabel('Open session actions');
    await expect(sessionActionsTrigger).toHaveCount(1, { timeout: 120_000 });
    await sessionActionsTrigger.click();

    const backgroundFollowItem = page.getByTestId('dropdown-option-session_directSession_backgroundFollow');
    await expect(backgroundFollowItem).toHaveCount(1, { timeout: 60_000 });
    await expect(backgroundFollowItem).toContainText('Disabled', { timeout: 60_000 });
    await backgroundFollowItem.click();

    await expect(sessionActionsTrigger).toHaveCount(1, { timeout: 60_000 });
    await sessionActionsTrigger.click();
    await expect(page.getByTestId('dropdown-option-session_directSession_backgroundFollow')).toContainText('Enabled', {
      timeout: 60_000,
    });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByLabel('Open session actions')).toHaveCount(1, { timeout: 60_000 });
    await page.getByLabel('Open session actions').click();
    await expect(page.getByTestId('dropdown-option-session_directSession_backgroundFollow')).toContainText('Enabled', {
      timeout: 60_000,
    });
  });
});
