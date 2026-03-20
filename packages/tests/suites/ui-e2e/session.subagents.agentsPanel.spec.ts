import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { createRunDirs } from '../../src/testkit/runDir';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { acknowledgeTerminalConnectSuccessIfPresent } from '../../src/testkit/uiE2e/acknowledgeTerminalConnectSuccessIfPresent';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';
import { setUiFeatureToggle } from '../../src/testkit/uiE2e/setUiFeatureToggle';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e' });

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
    const status = response.status();
    if (status >= 400) responseErrors.push(`${status} ${response.request().method()} ${response.url()}`);
  });

  return () =>
    `# Browser diagnostics\n\n`
    + `## Console\n\n${pageConsole.length ? pageConsole.join('\n') : '(none)'}\n\n`
    + `## Page errors\n\n${pageErrors.length ? pageErrors.join('\n') : '(none)'}\n\n`
    + `## Request failures\n\n${requestFailures.length ? requestFailures.join('\n') : '(none)'}\n\n`
    + `## Response errors\n\n${responseErrors.length ? responseErrors.join('\n') : '(none)'}\n`;
}

async function waitForAgentsRightPanel(params: Readonly<{ page: Page }>): Promise<void> {
  const surface = params.page.getByTestId('session-rightpanel-surface-agents');
  const lazyLoader = params.page.getByTestId('session-right-pane-module-loading');

  await expect(lazyLoader.or(surface).first()).toBeVisible({ timeout: 180_000 });

  if (await lazyLoader.count()) {
    await expect(lazyLoader).toHaveCount(0, { timeout: 240_000 });
  }

  await expect(surface).toHaveCount(1, { timeout: 180_000 });
}

test.describe('ui e2e: session subagents agents panel', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-subagents-agents-panel-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(resolve(join(cliHomeDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
        HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS ?? '420000',
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('shows the Agents surface on a fresh session and records execution-run rows after quick launch', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const browserDiagnostics = collectBrowserDiagnostics({ page });

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl, 420_000);
    await waitForInitialAppUi({ page, browserDiagnostics });

    const createAccountByTestId = page.getByTestId('welcome-create-account');
    const createAccountByRole = page.getByRole('button', { name: 'Create account' });
    const createAccount =
      (await createAccountByTestId.count()) ? createAccountByTestId
        : (await createAccountByRole.count()) ? createAccountByRole
          : null;
    if (createAccount) {
      await createAccount.click({ timeout: 60_000, force: true });
      await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });
    }

    const testDir = resolve(join(suiteDir, 't1-agents-panel'));
    await mkdir(testDir, { recursive: true });

    const cliLogin: StartedCliTerminalConnect = await startCliAuthLoginForTerminalConnect({
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      webappUrl: uiBaseUrl,
      env: {
        ...process.env,
        HOME: cliHomeDir,
        CI: '1',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
      },
    });

    await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('terminal-connect-approve').click();
    await cliLogin.waitForSuccess();
    await acknowledgeTerminalConnectSuccessIfPresent(page);
    await cliLogin.stop().catch(() => {});
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/`, 180_000);
    await waitForInitialAppUi({ page, browserDiagnostics });
    await setUiFeatureToggle({
      page,
      baseUrl: uiBaseUrl,
      featureId: 'execution.runs',
      enabled: true,
    });
    await waitForInitialAppUi({ page, browserDiagnostics });

    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeClaudeLog = resolve(join(testDir, 'fake-claude.jsonl'));
    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: cliHomeDir,
      env: {
        ...process.env,
        HOME: cliHomeDir,
        CI: '1',
        HAPPIER_HOME_DIR: cliHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: uiBaseUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLog,
        HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'plan-json',
        HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
        HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
      },
    });

    const sessionWorkspaceDir = resolve(join(testDir, 'session-workspace'));
    await mkdir(sessionWorkspaceDir, { recursive: true });
    const sessionId = await spawnSessionFromDaemon({
      daemon,
      directory: sessionWorkspaceDir,
      agent: 'claude',
    });

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sessionId}`, 120_000);
    await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 180_000 });

    await expect(page.getByTestId('session-header-subagents-button')).toHaveCount(1, { timeout: 180_000 });
    await page.getByTestId('session-header-subagents-button').click();
    await waitForAgentsRightPanel({ page });
    await expect(page.getByTestId('session-subagent-launch-execution-run:plan')).toHaveCount(1, { timeout: 60_000 });

    await page.getByTestId('session-subagent-launch-execution-run:plan').click();
    await expect(page.getByTestId('execution-run-new-instructions-input')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('execution-run-new-instructions-input').fill('Generate a concise execution-run plan for the smoke test.');
    await page.getByTestId('execution-run-new-start-button').click();
    await expect(page.getByTestId('execution-run-new-instructions-input')).toHaveCount(0, { timeout: 120_000 });

    const recentExecutionRunRows = page
      .getByTestId('session-agents-section-recent')
      .locator('[data-testid^="session-subagent-row:execution_run:"]');

    await expect(recentExecutionRunRows.first()).toBeVisible({ timeout: 180_000 });
  });
});
