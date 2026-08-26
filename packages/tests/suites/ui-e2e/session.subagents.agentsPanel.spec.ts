import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { createRunDirs } from '../../src/testkit/runDir';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { fakeClaudeFixturePath, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';
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
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys,providers.claude.unifiedTerminal',
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
    const testDir = resolve(join(suiteDir, 't1-agents-panel'));
    await mkdir(testDir, { recursive: true });
    const fakeClaudePath = fakeClaudeFixturePath();
    const fakeClaudeLog = resolve(join(testDir, 'fake-claude.jsonl'));
    daemon = await authenticateAndStartDaemon({
      page,
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      uiBaseUrl,
      initialUiGotoTimeoutMs: 420_000,
      initialUiReadyTimeoutMs: 420_000,
      daemonStartupTimeoutMs: 180_000,
      extraEnv: {
        ...process.env,
        HOME: cliHomeDir,
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLog,
        HAPPIER_E2E_FAKE_CLAUDE_SCENARIO: 'plan-json',
        HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
        HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
      },
    });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/`, 180_000);
    await waitForInitialAppUi({ page, browserDiagnostics });
    await setUiFeatureToggle({
      page,
      baseUrl: uiBaseUrl,
      featureId: 'execution.runs',
      enabled: true,
    });
    await waitForInitialAppUi({ page, browserDiagnostics });

    const sessionWorkspaceDir = resolve(join(testDir, 'session-workspace'));
    await mkdir(sessionWorkspaceDir, { recursive: true });
    const sessionId = await spawnSessionFromDaemon({
      daemon,
      directory: sessionWorkspaceDir,
      agent: 'claude',
    });

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sessionId}`, 120_000);
    await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 180_000 });

    const rightSidebarToggle = page.getByTestId('session-header-right-sidebar-button');
    await expect(rightSidebarToggle).toHaveCount(1, { timeout: 60_000 });
    await rightSidebarToggle.click();

    const agentsTab = page.getByTestId('session-rightpanel-tab:agents');
    await expect(agentsTab).toHaveCount(1, { timeout: 60_000 });
    await agentsTab.click();
    await waitForAgentsRightPanel({ page });
    await expect(page.getByTestId('session-subagent-launch-execution-run:plan')).toHaveCount(1, { timeout: 60_000 });

    await page.getByTestId('session-subagent-launch-execution-run:plan').click();
    await expect(page.getByTestId('execution-run-new-instructions-input')).toHaveCount(1, { timeout: 60_000 });
    const executionRunInstructions = `Generate a concise execution-run plan for the smoke test ${run.runId}.`;
    await page.getByTestId('execution-run-new-instructions-input').fill(executionRunInstructions);
    await page.getByTestId('execution-run-new-start-button').click();
    await waitForFakeClaudeInvocation(
      fakeClaudeLog,
      (invocation) => invocation.argv.some((arg) => arg.includes(executionRunInstructions)),
      { timeoutMs: 180_000, pollMs: 100 },
    );
    await expect(page.getByTestId('execution-run-new-instructions-input')).toHaveCount(0, { timeout: 120_000 });

    const executionRunRows = page.locator('[data-testid^="session-agents-roster:row:execution_run:"]');

    await expect(executionRunRows.first()).toBeVisible({ timeout: 180_000 });
  });
});
