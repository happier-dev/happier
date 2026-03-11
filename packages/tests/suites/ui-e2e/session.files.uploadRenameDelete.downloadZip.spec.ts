import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
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
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';
import { toTestIdSafeValue } from '../../src/testkit/uiE2e/testIdSafeValue';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.use({ acceptDownloads: true });

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

function rightPaneLocator(page: Page) {
  return page.getByTestId('multi-pane-right-docked').or(page.getByTestId('multi-pane-right-overlay'));
}

async function capturePageDiagnostics(params: Readonly<{
  page: Page;
  outputPath: string;
  browserDiagnostics: () => string;
  response?: Awaited<ReturnType<Page['goto']>>;
}>): Promise<void> {
  const debugState = await params.page
    .evaluate(() => ({
      href: window.location.href,
      readyState: document.readyState,
      title: document.title,
      bodyText: (document.body?.innerText ?? '').slice(0, 4000),
    }))
    .catch(() => null);
  const debugContent = await params.page.content().catch(() => '');
  const responseSummary = params.response
    ? {
        url: params.response.url(),
        status: params.response.status(),
        headers: params.response.headers(),
      }
    : null;

  await writeFile(
    params.outputPath,
    `${params.browserDiagnostics()}\n\n## Navigation response\n\n${JSON.stringify(responseSummary, null, 2)}\n\n## Location\n\n${JSON.stringify(debugState, null, 2)}\n\n## HTML (truncated)\n\n${debugContent.slice(0, 20_000)}\n`,
    'utf8',
  ).catch(() => {});
}

async function readUploadInputState(page: Page) {
  return await page.locator('[data-testid="repository-tree-upload-input-files"]').evaluateAll((nodes) =>
    nodes.map((node) => {
      const input = node as HTMLInputElement;
      return {
        isConnected: input.isConnected,
        disabled: input.disabled,
        multiple: input.multiple,
        value: input.value,
        fileCount: input.files?.length ?? 0,
        fileNames: Array.from(input.files ?? []).map((file) => file.name),
      };
    }),
  );
}

async function clickDropdownOptionByItemId(page: Page, itemId: string): Promise<void> {
  const dropdownOption = page.getByTestId(`dropdown-option-${toTestIdSafeValue(itemId)}`);
  if ((await dropdownOption.count()) > 0) {
    await dropdownOption.click();
    return;
  }
  await page.getByTestId(itemId).click();
}

async function expectFilesToolbarPrimaryOrOverflowAction(rightPane: Locator, actionTestId: string, timeoutMs: number) {
  await expect
    .poll(
      async () => {
        const directCount = await rightPane.getByTestId(actionTestId).count();
        const overflowCount = await rightPane.getByTestId('repository-tree-toolbar-overflow').count();
        return directCount > 0 || overflowCount > 0;
      },
      { timeout: timeoutMs },
    )
    .toBe(true);
}

async function waitForUploadToComplete(params: Readonly<{
  rightPane: Locator;
  uploadedPath: string;
}>): Promise<void> {
  const uploadStatus = params.rightPane.getByTestId('repository-tree-upload-status');
  const uploadedRow = params.rightPane.getByTestId(`repository-tree-row-${toTestIdSafeValue(params.uploadedPath)}`);

  await expect
    .poll(
      async () => (await uploadStatus.count()) > 0 || (await uploadedRow.count()) > 0,
      { timeout: 60_000 },
    )
    .toBe(true);

  if ((await uploadStatus.count()) > 0) {
    await expect(uploadStatus).toHaveCount(0, { timeout: 180_000 });
  }

  await expect(uploadedRow).toHaveCount(1, { timeout: 120_000 });
}

test.describe('ui e2e: Files upload + rename/delete + download (+ zip)', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-files-filemanager-suite');
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

  test('uploads file, renames, downloads, deletes, and downloads folder zip', async ({ page }) => {
    test.setTimeout(420_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const browserDiagnostics = collectBrowserDiagnostics({ page });
    const testDir = resolve(join(suiteDir, 't1-filemanager'));

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
          HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: testDir,
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
        },
      });
      daemon = runDaemon;

      const workspaceDir = resolve(join(testDir, 'workspace'));
      const downloadFolder = resolve(join(workspaceDir, 'download-me'));
      await mkdir(resolve(join(downloadFolder, 'nested')), { recursive: true });
      await writeFile(resolve(join(downloadFolder, 'nested', 'hello.txt')), 'hello zip\n', 'utf8');

      const uploadSourcePath = resolve(join(testDir, 'upload-source.txt'));
      await writeFile(uploadSourcePath, 'hello upload\n', 'utf8');

      const sessionId = await spawnSessionFromDaemon({ daemon: runDaemon, directory: workspaceDir });
      const sessionResponse = await page.goto(`${uiBaseUrl}/session/${sessionId}?right=files`, { waitUntil: 'domcontentloaded' });
      try {
        await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 180_000 });
      } catch (error) {
        await capturePageDiagnostics({
          page,
          outputPath: resolve(join(testDir, 'browser-diagnostics.session-route.md')),
          browserDiagnostics,
          response: sessionResponse,
        });
        throw error;
      }

      // Ensure right pane is open and the Files tab has fully lazy-mounted before looking for tree controls.
      await expect(rightPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });

      const rightPane = rightPaneLocator(page);
      await clickScopedButtonByTestIdOrRole({
        scope: rightPane,
        testId: 'session-rightpanel-tab-files',
        roleName: 'Files',
        timeoutMs: 180_000,
      });

      await expect(rightPane.getByTestId('session-rightpanel-surface-files')).toHaveCount(1, { timeout: 120_000 });
      try {
        await expectFilesToolbarPrimaryOrOverflowAction(rightPane, 'repository-tree-upload', 180_000);
      } catch (error) {
        await capturePageDiagnostics({
          page,
          outputPath: resolve(join(testDir, 'browser-diagnostics.files-pane.md')),
          browserDiagnostics,
        });
        throw error;
      }

      // Use the dedicated hidden web input directly here. The toolbar menu wiring is covered
      // separately at the component level, and the raw input path is the stable contract this
      // isolated browser lane exposes for exercising real uploads end-to-end.
      try {
        const uploadInput = page.getByTestId('repository-tree-upload-input-files');
        await expect(uploadInput).toHaveCount(1, { timeout: 60_000 });
        await uploadInput.setInputFiles(uploadSourcePath);
        await writeFile(
          resolve(join(testDir, 'upload-input-state.after-set.json')),
          JSON.stringify(await readUploadInputState(page), null, 2),
          'utf8',
        ).catch(() => {});
      } catch (error) {
        await capturePageDiagnostics({
          page,
          outputPath: resolve(join(testDir, 'browser-diagnostics.upload-chooser.md')),
          browserDiagnostics,
        });
        throw error;
      }

      const uploadedPath = 'upload-source.txt';
      try {
        await waitForUploadToComplete({ rightPane, uploadedPath });
      } catch (error) {
        await writeFile(
          resolve(join(testDir, 'upload-input-state.json')),
          JSON.stringify(await readUploadInputState(page), null, 2),
          'utf8',
        ).catch(() => {});
        await capturePageDiagnostics({
          page,
          outputPath: resolve(join(testDir, 'browser-diagnostics.upload-status.md')),
          browserDiagnostics,
        });
        throw error;
      }

      // Rename uploaded file.
      await rightPane.getByTestId(`repository-tree-row-menu-${toTestIdSafeValue(uploadedPath)}`).click();
      await clickDropdownOptionByItemId(page, 'repository-tree-menuitem-rename');
      const prompt = page.getByPlaceholder(uploadedPath);
      await expect(prompt).toHaveCount(1, { timeout: 60_000 });
      const renamedPath = 'renamed.txt';
      await prompt.fill(renamedPath);
      await prompt.press('Enter');

      await expect(rightPane.getByTestId(`repository-tree-row-${toTestIdSafeValue(uploadedPath)}`)).toHaveCount(0, { timeout: 120_000 });
      await expect(rightPane.getByTestId(`repository-tree-row-${toTestIdSafeValue(renamedPath)}`)).toHaveCount(1, { timeout: 120_000 });

      // Download renamed file.
      await rightPane.getByTestId(`repository-tree-row-menu-${toTestIdSafeValue(renamedPath)}`).click();
      const [fileDownload] = await Promise.all([
        page.waitForEvent('download'),
        clickDropdownOptionByItemId(page, 'repository-tree-menuitem-download'),
      ]);
      const fileDownloadPath = await fileDownload.path();
      expect(fileDownloadPath).not.toBeNull();
      if (fileDownloadPath) {
        const fileStats = await stat(fileDownloadPath);
        expect(fileStats.size).toBeGreaterThan(0);
      }

      // Delete renamed file.
      await rightPane.getByTestId(`repository-tree-row-menu-${toTestIdSafeValue(renamedPath)}`).click();
      await clickDropdownOptionByItemId(page, 'repository-tree-menuitem-delete');
      await expect(page.getByTestId('web-modal-confirm')).toHaveCount(1, { timeout: 60_000 });
      await page.getByTestId('web-modal-confirm').click();
      await expect(rightPane.getByTestId(`repository-tree-row-${toTestIdSafeValue(renamedPath)}`)).toHaveCount(0, { timeout: 120_000 });

      // Upload a conflicting file and keep both versions.
      const conflictPath = 'upload-conflict.txt';
      const keepBothPath = 'upload-conflict (1).txt';
      await writeFile(resolve(join(workspaceDir, conflictPath)), 'existing target\n', 'utf8');

      const conflictingUploadSourcePath = resolve(join(testDir, conflictPath));
      await writeFile(conflictingUploadSourcePath, 'conflicting upload\n', 'utf8');

      const conflictUploadInput = page.getByTestId('repository-tree-upload-input-files');
      await expect(conflictUploadInput).toHaveCount(1, { timeout: 60_000 });
      await conflictUploadInput.setInputFiles(conflictingUploadSourcePath);

      await expect(page.getByTestId('upload-conflicts-keep-both')).toHaveCount(1, { timeout: 120_000 });
      await page.getByTestId('upload-conflicts-keep-both').click();

      await expect(rightPane.getByTestId(`repository-tree-row-${toTestIdSafeValue(conflictPath)}`)).toHaveCount(1, { timeout: 120_000 });
      await waitForUploadToComplete({ rightPane, uploadedPath: keepBothPath });

      await expect.poll(async () => await readFile(resolve(join(workspaceDir, conflictPath)), 'utf8')).toBe('existing target\n');
      await expect.poll(async () => await readFile(resolve(join(workspaceDir, keepBothPath)), 'utf8')).toBe('conflicting upload\n');

      // Download folder as zip.
      const folderPath = 'download-me';
      await expect(rightPane.getByTestId(`repository-tree-row-${toTestIdSafeValue(folderPath)}`)).toHaveCount(1, { timeout: 120_000 });
      await rightPane.getByTestId(`repository-tree-row-menu-${toTestIdSafeValue(folderPath)}`).click();
      const [zipDownload] = await Promise.all([
        page.waitForEvent('download'),
        clickDropdownOptionByItemId(page, 'repository-tree-menuitem-zip'),
      ]);
      expect(zipDownload.suggestedFilename()).toMatch(/\.zip$/);
      const zipPath = await zipDownload.path();
      expect(zipPath).not.toBeNull();
      if (zipPath) {
        const zipStats = await stat(zipPath);
        expect(zipStats.size).toBeGreaterThan(0);
      }
    } catch (error) {
      throw new Error(`${String(error)}\n\n${browserDiagnostics()}`);
    } finally {
      await runDaemon?.stop().catch(() => {});
    }
  });
});
