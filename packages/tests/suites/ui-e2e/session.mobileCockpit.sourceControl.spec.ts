import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { createGitRepoWithChanges } from '../../src/testkit/uiE2e/gitRepoFixtures';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';
import { toTestIdSafeValue } from '../../src/testkit/uiE2e/testIdSafeValue';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: mobile session cockpit source control', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-mobile-cockpit-source-control-suite');
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
        HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '1000',
        HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
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

  test('routes Files, Git, Review, details, and Chat through the default phone cockpit', async ({ page }) => {
    test.setTimeout(900_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    await page.setViewportSize({ width: 390, height: 844 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);

    const testDir = resolve(join(suiteDir, 't1-mobile-cockpit-source-control'));
    await mkdir(testDir, { recursive: true });

    daemon = await authenticateAndStartDaemon({
      page,
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      uiBaseUrl,
      extraEnv: {
        ...process.env,
        HOME: cliHomeDir,
        HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: testDir,
        HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
        HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
        HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
      },
    });

    const repoDir = resolve(join(testDir, 'repo'));
    await createGitRepoWithChanges({ repoDir, fileCount: 8 });
    const sessionId = await spawnSessionFromDaemon({ daemon, directory: repoDir });

    await page.goto(`${uiBaseUrl}/session/${sessionId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId(`session-cockpit-tabbar-${sessionId}`)).toHaveCount(1, { timeout: 180_000 });
    await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 180_000 });

    await page.getByTestId('session-cockpit-tab-git').click();
    await expect(page).toHaveURL(new RegExp(`/session/${sessionId}/git(?:\\?|$)`), { timeout: 60_000 });
    await expect(page.getByTestId('session-git-screen')).toHaveCount(1, { timeout: 120_000 });

    const changedPath = 'src/file-00.txt';
    const changedRow = page.getByTestId(`scm-change-row-${toTestIdSafeValue(changedPath)}`);
    await expect(changedRow).toHaveCount(1, { timeout: 180_000 });
    await changedRow.click();
    await expect(page).toHaveURL(new RegExp(`/session/${sessionId}/details\\?.*details=file.*path=${encodeURIComponent(changedPath)}`), { timeout: 60_000 });
    await expect(page.getByTestId('session-details-screen')).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId(`session-details-tab-${toTestIdSafeValue(`file:${changedPath}`)}`)).toHaveCount(1, { timeout: 120_000 });

    await page.getByTestId('session-cockpit-tab-git').click();
    await expect(page).toHaveURL(new RegExp(`/session/${sessionId}/git(?:\\?|$)`), { timeout: 60_000 });
    await page.locator('[data-testid="session-rightpanel-git-open-review"]:visible').click();
    await expect(page).toHaveURL(new RegExp(`/session/${sessionId}/details\\?.*details=scmReview`), { timeout: 60_000 });
    await expect(page.getByTestId('scm-review-list')).toHaveCount(1, { timeout: 180_000 });

    await page.getByTestId('session-cockpit-tab-browse').click();
    await expect(page).toHaveURL(new RegExp(`/session/${sessionId}/files(?:\\?|$)`), { timeout: 60_000 });
    await expect(page.getByTestId('session-files-screen')).toHaveCount(1, { timeout: 120_000 });
    const readmeRow = page.getByTestId(`repository-tree-row-${toTestIdSafeValue('README.md')}`);
    await expect(readmeRow).toHaveCount(1, { timeout: 180_000 });
    await readmeRow.click();
    await expect(page).toHaveURL(new RegExp(`/session/${sessionId}/details\\?.*details=file.*path=README\\.md`), { timeout: 60_000 });
    await expect(page.getByTestId(`session-details-tab-${toTestIdSafeValue('file:README.md')}`)).toHaveCount(1, { timeout: 120_000 });

    await page.getByTestId('session-cockpit-tab-chat').click();
    await expect(page).toHaveURL(new RegExp(`/session/${sessionId}\\?.*mobileSurface=chat`), { timeout: 60_000 });
    await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 120_000 });
  });
});
