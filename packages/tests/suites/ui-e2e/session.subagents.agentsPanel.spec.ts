import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { createRunDirs } from '../../src/testkit/runDir';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { fakeClaudeFixturePath, waitForFakeClaudeUserText } from '../../src/testkit/fakeClaude';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';
import { mutateUiE2eScopedAccountSettings } from '../../src/testkit/uiE2e/scopedAccountSettingsStorage';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';

const run = createRunDirs({ runLabel: 'ui-e2e' });

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
        // Exercise real browser chunk fetching through the source development server.
        HAPPIER_E2E_UI_WEB_MODE: 'metro',
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
    test.setTimeout(180_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const browserDiagnostics = collectBrowserDiagnostics({ page });

    // Install before navigation so all application timers use the browser clock.
    await page.clock.install();
    const subagentDetailsRequests: string[] = [];
    page.on('request', (request) => {
      if (request.resourceType() === 'script' && new URL(request.url()).pathname.includes('SessionSubagentDetailsView')) {
        subagentDetailsRequests.push(request.url());
      }
    });
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
    await mutateUiE2eScopedAccountSettings({
      page,
      // This isolated browser owns both its bootstrap and authenticated scopes.
      applyToAllScopes: true,
      experiments: true,
      featureToggles: { 'execution.runs': true },
    });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/`, 180_000);
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

    // The regression prefetched closed details after 3 seconds. Advance that
    // actual failure window without adding a wall-clock sleep to this flow.
    await page.clock.runFor(3_001);
    expect(subagentDetailsRequests, 'closed subagent details must not fetch their chunk').toEqual([]);

    const agentsAction = page.getByTestId('session-action-rail:agents');
    await expect(agentsAction).toHaveCount(1, { timeout: 60_000 });
    await agentsAction.click();
    await waitForAgentsRightPanel({ page });
    await expect(page.getByTestId('session-subagent-launch-execution-run:plan')).toHaveCount(1, { timeout: 60_000 });

    await page.getByTestId('session-subagent-launch-execution-run:plan').click();
    await expect(page.getByTestId('execution-run-new-instructions-input')).toHaveCount(1, { timeout: 60_000 });
    const executionRunInstructions = `Generate a concise execution-run plan for the smoke test ${run.runId}.`;
    await page.getByTestId('execution-run-new-instructions-input').fill(executionRunInstructions);
    await page.getByTestId('execution-run-new-start-button').click();
    await waitForFakeClaudeUserText(
      fakeClaudeLog,
      (text) => text.includes(executionRunInstructions),
      { timeoutMs: 180_000, pollMs: 100 },
    );
    await expect(page.getByTestId('execution-run-new-instructions-input')).toHaveCount(0, { timeout: 120_000 });

    const executionRunRows = page.locator('[data-testid^="session-agents-roster:row:execution_run:"]');

    const executionRunRow = executionRunRows.first();
    await expect(executionRunRow).toBeVisible({ timeout: 180_000 });
    expect(subagentDetailsRequests).toEqual([]);
    const rowTestId = await executionRunRow.getAttribute('data-testid');
    if (!rowTestId) throw new Error('Missing execution-run row identity');
    const subagentId = rowTestId.slice('session-agents-roster:row:'.length);
    await executionRunRow.click();
    await expect(page.getByTestId(`session-subagent-overview:${subagentId}`)).toBeVisible({ timeout: 180_000 });
    await expect(page.getByTestId('session-subagent-details-loading')).toHaveCount(0);
    expect(subagentDetailsRequests.length, 'opening details must reach the real demand-loaded chunk').toBeGreaterThan(0);
  });
});
