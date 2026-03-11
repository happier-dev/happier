import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { acknowledgeTerminalConnectSuccessIfPresent } from '../../src/testkit/uiE2e/acknowledgeTerminalConnectSuccessIfPresent';
import { clickScopedButtonByTestIdOrRole } from '../../src/testkit/uiE2e/clickScopedButtonByTestIdOrRole';
import { createGitRepoForBranchPublishAndStashFixture, execGit } from '../../src/testkit/uiE2e/gitRepoFixtures';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';
import { toTestIdSafeValue } from '../../src/testkit/uiE2e/testIdSafeValue';
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
    `# Browser diagnostics\n\n` +
    `## Console\n\n${pageConsole.length ? pageConsole.join('\n') : '(none)'}\n\n` +
    `## Page errors\n\n${pageErrors.length ? pageErrors.join('\n') : '(none)'}\n\n` +
    `## Request failures\n\n${requestFailures.length ? requestFailures.join('\n') : '(none)'}\n\n` +
    `## Response errors\n\n${responseErrors.length ? responseErrors.join('\n') : '(none)'}\n`;
}

function detailsPaneLocator(page: Page) {
  return page.getByTestId('multi-pane-details-docked').or(page.getByTestId('multi-pane-details-overlay'));
}

function rightPaneLocator(page: Page) {
  return page.getByTestId('multi-pane-right-docked').or(page.getByTestId('multi-pane-right-overlay'));
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

test.describe('ui e2e: SCM branch publish + switch-with-changes + stash restore', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-scm-branches-stash-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_SERVER_URL: '',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
      HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS:
        process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS
        ?? process.env.HAPPIER_E2E_UI_WEB_BEFORE_ALL_MIN_TIMEOUT_MS
        ?? '900000',
    };
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
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
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE: '1',
        HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
      },
    });

    uiWebEnv.EXPO_PUBLIC_HAPPY_SERVER_URL = server.baseUrl;
    ui = await startUiWeb({ testDir: suiteDir, env: uiWebEnv });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('creates + publishes branch, stashes on switch, restores stash, and brings changes to target branch', async ({ page }) => {
    test.setTimeout(420_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const browserDiagnostics = collectBrowserDiagnostics({ page });
    const testDir = resolve(join(suiteDir, 't1-branch-publish-stash'));

    let runDaemon: StartedDaemon | null = null;
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoDomContentLoadedWithRetries(page, uiBaseUrl);

      await waitForInitialAppUi({ page, browserDiagnostics });
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
          HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        },
      });

      await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
      await page.getByTestId('terminal-connect-approve').click();
      await cliLogin.waitForSuccess();
      await acknowledgeTerminalConnectSuccessIfPresent(page);

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
          HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
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
      const remoteDir = resolve(join(testDir, 'remote.git'));
      await createGitRepoForBranchPublishAndStashFixture({ repoDir, remoteDir });
      await writeFile(resolve(join(repoDir, 'src', 'app.txt')), 'base-1\nbase-2\nbase-3\n', 'utf8');
      execGit(repoDir, ['add', 'src/app.txt']);
      execGit(repoDir, ['commit', '-m', 'chore: prepare bring-changes baseline']);

      await enableScmWriteOperationsInSettings(page, uiBaseUrl);

      const sessionId = await spawnSessionFromDaemon({ daemon: runDaemon, directory: repoDir });
      await page.goto(`${uiBaseUrl}/session/${sessionId}?right=git`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 180_000 });

      await expect(rightPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });
      let rightPane = rightPaneLocator(page);

      // Ensure right pane is on Source control.
      await clickScopedButtonByTestIdOrRole({
        scope: rightPane,
        testId: 'session-rightpanel-tab-git',
        roleName: 'Source control',
        timeoutMs: 180_000,
      });

      // Create + checkout a new branch via the branch dropdown search/create affordance.
      await expect(rightPane.getByTestId('scm-branch-menu-trigger')).toHaveCount(1, { timeout: 120_000 });
      await rightPane.getByTestId('scm-branch-menu-trigger').click();
      await expect(page.getByPlaceholder('Search branches...')).toHaveCount(1, { timeout: 60_000 });
      const newBranch = 'feature/ui-e2e';
      await page.getByPlaceholder('Search branches...').fill(newBranch);
      await page.keyboard.press('Enter');

      await expect(rightPane.getByTestId('scm-branch-menu-trigger')).toContainText(newBranch, { timeout: 120_000 });

      // Publish branch (set upstream + push).
      await expect(rightPane.getByTestId('scm-publish-branch')).toHaveCount(1, { timeout: 120_000 });
      await rightPane.getByTestId('scm-publish-branch').click();
      await expect(rightPane.getByTestId('scm-publish-branch')).toHaveCount(0, { timeout: 180_000 });

      const targetBranch = 'bring-target';
      execGit(repoDir, ['checkout', '-b', targetBranch]);
      await writeFile(resolve(join(repoDir, 'src', 'app.txt')), 'base-1\nbase-2\nother-3\n', 'utf8');
      execGit(repoDir, ['add', 'src/app.txt']);
      execGit(repoDir, ['commit', '-m', 'feat: target branch baseline']);
      execGit(repoDir, ['checkout', newBranch]);

      // Introduce an uncommitted change outside the app, then remount the session view to force
      // a fresh SCM snapshot instead of waiting on the default 5-minute auto-refresh interval.
      await writeFile(resolve(join(repoDir, 'src', 'app.txt')), 'local-1\nbase-2\nbase-3\n', 'utf8');
      await page.goto(`${uiBaseUrl}/session/${sessionId}?right=git`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 180_000 });
      await expect(rightPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });
      rightPane = rightPaneLocator(page);
      const changedPath = 'src/app.txt';
      await expect(rightPane.getByTestId(`scm-change-row-${toTestIdSafeValue(changedPath)}`)).toHaveCount(1, { timeout: 180_000 });

      // Switch back to main -> choose "leave changes" (stash) prompt.
      await rightPane.getByTestId('scm-branch-menu-trigger').click();
      await page.getByPlaceholder('Search branches...').fill('main');
      await page.getByText('main', { exact: true }).first().click();

      await expect(page.getByTestId('switch-branch-leave-changes')).toHaveCount(1, { timeout: 120_000 });
      await page.getByTestId('switch-branch-leave-changes').click();

      await expect(rightPane.getByTestId('scm-branch-menu-trigger')).toContainText('main', { timeout: 120_000 });
      await expect(rightPane.getByTestId(`scm-change-row-${toTestIdSafeValue(changedPath)}`)).toHaveCount(0, { timeout: 180_000 });

      // Stash summary row should appear; open details and restore.
      await rightPane.getByTestId('session-rightpanel-git-subtab:commit').click();
      await expect(rightPane.getByTestId('scm-stash-summary-row')).toHaveCount(1, { timeout: 180_000 });
      await rightPane.getByTestId('scm-stash-summary-row').click();

      await expect(detailsPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });
      await expect(detailsPaneLocator(page).getByTestId('scm-stash-details-root')).toHaveCount(1, { timeout: 120_000 });

      await detailsPaneLocator(page).getByTestId('scm-stash-restore-button').click();
      await expect(page.getByTestId('web-modal-confirm')).toHaveCount(1, { timeout: 60_000 });
      await page.getByTestId('web-modal-confirm').click();

      await expect(rightPane.getByTestId(`scm-change-row-${toTestIdSafeValue(changedPath)}`)).toHaveCount(1, { timeout: 180_000 });

      // Switching to a target branch with its own README commit should require the bring-changes path.
      await rightPane.getByTestId('scm-branch-menu-trigger').click();
      await page.getByPlaceholder('Search branches...').fill(targetBranch);
      await page.getByText(targetBranch, { exact: true }).first().click();

      await expect(page.getByTestId('switch-branch-bring-changes')).toHaveCount(1, { timeout: 120_000 });
      await page.getByTestId('switch-branch-bring-changes').click();

      await expect(rightPane.getByTestId('scm-branch-menu-trigger')).toContainText(targetBranch, { timeout: 120_000 });
      await expect(rightPane.getByTestId(`scm-change-row-${toTestIdSafeValue(changedPath)}`)).toHaveCount(1, { timeout: 180_000 });
      await expect(rightPane.getByTestId('scm-stash-summary-row')).toHaveCount(0, { timeout: 30_000 });

      await expect.poll(async () => await readFile(resolve(join(repoDir, changedPath)), 'utf8')).toContain('local-1');
      await expect.poll(async () => await readFile(resolve(join(repoDir, changedPath)), 'utf8')).toContain('other-3');

      // Recreate a managed stash on the target branch, then discard it from the stash details view.
      await writeFile(resolve(join(repoDir, changedPath)), 'discard-me\nbase-2\nother-3\n', 'utf8');
      await page.goto(`${uiBaseUrl}/session/${sessionId}?right=git`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 180_000 });
      await expect(rightPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });
      rightPane = rightPaneLocator(page);
      await expect(rightPane.getByTestId(`scm-change-row-${toTestIdSafeValue(changedPath)}`)).toHaveCount(1, { timeout: 180_000 });

      await rightPane.getByTestId('scm-branch-menu-trigger').click();
      await page.getByPlaceholder('Search branches...').fill('main');
      await page.getByText('main', { exact: true }).first().click();

      await expect(page.getByTestId('switch-branch-leave-changes')).toHaveCount(1, { timeout: 120_000 });
      await page.getByTestId('switch-branch-leave-changes').click();

      await expect(rightPane.getByTestId('scm-branch-menu-trigger')).toContainText('main', { timeout: 120_000 });
      await rightPane.getByTestId('session-rightpanel-git-subtab:commit').click();
      await expect(rightPane.getByTestId('scm-stash-summary-row')).toHaveCount(1, { timeout: 180_000 });
      await rightPane.getByTestId('scm-stash-summary-row').click();

      await expect(detailsPaneLocator(page).getByTestId('scm-stash-details-root')).toHaveCount(1, { timeout: 120_000 });
      await detailsPaneLocator(page).getByTestId('scm-stash-discard-button').click();
      await expect(page.getByTestId('web-modal-confirm')).toHaveCount(1, { timeout: 60_000 });
      await page.getByTestId('web-modal-confirm').click();

      await expect(rightPane.getByTestId('scm-stash-summary-row')).toHaveCount(0, { timeout: 180_000 });
      await rightPane.getByTestId('scm-branch-menu-trigger').click();
      await page.getByPlaceholder('Search branches...').fill(targetBranch);
      await page.getByText(targetBranch, { exact: true }).first().click();
      await expect(rightPane.getByTestId('scm-branch-menu-trigger')).toContainText(targetBranch, { timeout: 120_000 });
      await expect(rightPane.getByTestId(`scm-change-row-${toTestIdSafeValue(changedPath)}`)).toHaveCount(0, { timeout: 180_000 });
      await expect.poll(async () => await readFile(resolve(join(repoDir, changedPath)), 'utf8')).not.toContain('discard-me');
      await expect.poll(async () => await readFile(resolve(join(repoDir, changedPath)), 'utf8')).toContain('other-3');
    } catch (error) {
      throw new Error(`${String(error)}\n\n${browserDiagnostics()}`);
    } finally {
      await runDaemon?.stop().catch(() => {});
    }
  });
});
