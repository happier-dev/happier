import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { createGitRepoForPartialStagingFixture } from '../../src/testkit/uiE2e/gitRepoFixtures';
import { toTestIdSafeValue } from '../../src/testkit/uiE2e/testIdSafeValue';

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
    `# Browser diagnostics\n\n` +
    `## Console\n\n${pageConsole.length ? pageConsole.join('\n') : '(none)'}\n\n` +
    `## Page errors\n\n${pageErrors.length ? pageErrors.join('\n') : '(none)'}\n\n` +
    `## Request failures\n\n${requestFailures.length ? requestFailures.join('\n') : '(none)'}\n\n` +
    `## Response errors\n\n${responseErrors.length ? responseErrors.join('\n') : '(none)'}\n`;
}

function detailsPaneLocator(page: Page) {
  return page
    .getByTestId('multi-pane-details-docked')
    .or(page.getByTestId('multi-pane-details-overlay'));
}

function rightPaneLocator(page: Page) {
  return page
    .getByTestId('multi-pane-right-docked')
    .or(page.getByTestId('multi-pane-right-overlay'));
}

async function spawnSessionFromDaemon(params: {
  daemon: StartedDaemon;
  directory: string;
}): Promise<string> {
  const token = params.daemon.state.controlToken;
  if (!token) throw new Error('daemon control token missing');

  const res = await fetch(`http://127.0.0.1:${params.daemon.state.httpPort}/spawn-session`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-happier-daemon-token': token,
    },
    body: JSON.stringify({
      directory: params.directory,
      agent: 'claude',
    }),
  });
  const json = (await res.json().catch(() => null)) as any;
  if (!res.ok || !json || json.success !== true || typeof json.sessionId !== 'string') {
    throw new Error(`Failed to spawn session (status=${res.status}): ${JSON.stringify(json)}`);
  }
  return json.sessionId as string;
}

async function enableScmWriteOperationsInSettings(page: Page, baseUrl: string) {
  await page.goto(`${baseUrl}/settings/features`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByTestId('settings-feature-experiments-toggle')).toHaveCount(1, { timeout: 60_000 });

  const experimentsToggle = page.getByTestId('settings-feature-experiments-toggle');
  await experimentsToggle.click();

  const scmToggle = page.getByTestId('settings-feature-toggle-scm.writeOperations');
  await expect(scmToggle).toHaveCount(1, { timeout: 60_000 });
  await scmToggle.click();
}

test.describe('ui e2e: SCM partial staging + commit + discard', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-scm-partial-staging-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    test.setTimeout(420_000);
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(resolve(join(cliHomeDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
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
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('stages selected lines, commits, keeps remaining changes, and supports discard/revert UI', async ({ page }) => {
    test.setTimeout(420_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const browserDiagnostics = collectBrowserDiagnostics({ page });
    const testDir = resolve(join(suiteDir, 't1-partial-staging'));

    let runDaemon: StartedDaemon | null = null;
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoDomContentLoadedWithRetries(page, uiBaseUrl);

      await page.getByTestId('welcome-create-account').click();
      await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

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

      const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
      const fakeClaudePath = fakeClaudeFixturePath();

      runDaemon = await startTestDaemon({
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
          // Machine-scoped RPC must be allowed to read the repo fixture directory.
          HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: testDir,
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
        },
      });
      daemon = runDaemon;

      const repoDir = resolve(join(testDir, 'repo'));
      await createGitRepoForPartialStagingFixture({ repoDir });

      await enableScmWriteOperationsInSettings(page, uiBaseUrl);

      const sessionId = await spawnSessionFromDaemon({ daemon: runDaemon, directory: repoDir });
      await page.goto(`${uiBaseUrl}/session/${sessionId}?right=git`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 180_000 });

      // Ensure right pane is open and on Source control.
      if ((await rightPaneLocator(page).count()) === 0) {
        await page.getByTestId('session-open-source-control').click();
      }
      await expect(rightPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });

      const rightPane = rightPaneLocator(page);
      const gitTabByTestId = rightPane.getByTestId('session-rightpanel-tab-git');
      if (await gitTabByTestId.count()) {
        await gitTabByTestId.click();
      } else {
        await rightPane.getByRole('button', { name: 'Source control' }).click();
      }

      const twoHunksPath = 'src/two-hunks.txt';
      const wholeFilePath = 'src/whole-file.txt';
      const untrackedPath = 'src/untracked.txt';

      const twoHunksRow = rightPane.getByTestId(`scm-change-row-${toTestIdSafeValue(twoHunksPath)}`);
      await expect(twoHunksRow).toHaveCount(1, { timeout: 120_000 });

      // Select both files for commit (atomic strategy uses a virtual selection model).
      const twoHunksToggle = rightPane.getByTestId(`scm-commit-selection-toggle-${toTestIdSafeValue(twoHunksPath)}`);
      await expect(twoHunksToggle).toHaveCount(1, { timeout: 60_000 });
      await twoHunksToggle.click({ force: true });

      const wholeFileToggle = rightPane.getByTestId(`scm-commit-selection-toggle-${toTestIdSafeValue(wholeFilePath)}`);
      await expect(wholeFileToggle).toHaveCount(1, { timeout: 60_000 });
      await wholeFileToggle.click({ force: true });

      // Open file details tab (pinned) and select a line from the first hunk.
      await twoHunksRow.focus();
      await page.keyboard.press('Shift+Enter');
      await expect(page.getByTestId(`session-details-tab-${toTestIdSafeValue(`file:${twoHunksPath}`)}`)).toHaveCount(1, { timeout: 60_000 });

      const fileDetailsScroll = detailsPaneLocator(page).getByTestId('file-details-scroll');
      await expect(fileDetailsScroll).toHaveCount(1, { timeout: 120_000 });

      // Select a single line from the first hunk (line-selection UI should appear).
      const firstHunkLine = detailsPaneLocator(page).getByText('ADDED_HUNK1_A', { exact: true }).first();
      await expect(firstHunkLine).toHaveCount(1, { timeout: 120_000 });
      await firstHunkLine.click({ force: true });

      await expect(detailsPaneLocator(page).getByTestId('file-details-apply-selected-lines')).toHaveCount(1, { timeout: 60_000 });
      await detailsPaneLocator(page).getByTestId('file-details-apply-selected-lines').click();

      // Commit selected changes.
      const commitMessage = page.getByTestId('scm-commit-message');
      await expect(commitMessage).toHaveCount(1, { timeout: 60_000 });
      await commitMessage.fill('test: partial staging ui-e2e');
      const commitSubmit = page.getByTestId('scm-commit-submit');
      await expect(commitSubmit).toHaveCount(1, { timeout: 60_000 });
      await commitSubmit.click();

      // After commit, remaining changes should persist (second hunk) and untracked file should remain.
      await expect(rightPane.getByTestId(`scm-change-row-${toTestIdSafeValue(twoHunksPath)}`)).toHaveCount(1, { timeout: 120_000 });
      await expect(rightPane.getByTestId(`scm-change-row-${toTestIdSafeValue(wholeFilePath)}`)).toHaveCount(0, { timeout: 120_000 });
      await expect(rightPane.getByTestId(`scm-change-row-${toTestIdSafeValue(untrackedPath)}`)).toHaveCount(1, { timeout: 120_000 });

      // Open remaining diff and verify the first hunk content is gone but the second hunk remains.
      await twoHunksRow.focus();
      await page.keyboard.press('Shift+Enter');
      await expect(fileDetailsScroll).toHaveCount(1, { timeout: 120_000 });
      await expect(detailsPaneLocator(page).getByText('ADDED_HUNK2_A')).toHaveCount(1, { timeout: 120_000 });
      await expect(detailsPaneLocator(page).getByText('ADDED_HUNK1_A')).toHaveCount(0, { timeout: 120_000 });

      // Discard remaining changes for the file.
      const discardTwoHunks = rightPane.getByTestId(`scm-discard-${toTestIdSafeValue(twoHunksPath)}`);
      await discardTwoHunks.click();
      await expect(page.getByTestId('web-modal-confirm')).toHaveCount(1, { timeout: 60_000 });
      await page.getByTestId('web-modal-confirm').click();
      await expect(rightPane.getByTestId(`scm-change-row-${toTestIdSafeValue(twoHunksPath)}`)).toHaveCount(0, { timeout: 120_000 });

      // Open History and ensure we can open the latest commit diff and see the revert affordance.
      await rightPane.getByTestId('session-rightpanel-git-subtab:history').click();
      const firstCommit = page.locator('[data-testid^="scm-commit-entry-"]').first();
      await expect(firstCommit).toHaveCount(1, { timeout: 120_000 });
      await firstCommit.click();
      await expect(detailsPaneLocator(page).getByTestId('scm-commit-details-revert')).toHaveCount(1, { timeout: 120_000 });
    } catch (err) {
      await test.info().attach('browser-diagnostics', {
        body: browserDiagnostics(),
        contentType: 'text/markdown',
      });
      throw err;
    }
  });
});
