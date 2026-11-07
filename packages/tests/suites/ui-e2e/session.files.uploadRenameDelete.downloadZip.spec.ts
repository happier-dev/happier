import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { acknowledgeTerminalConnectSuccessIfPresent } from '../../src/testkit/uiE2e/acknowledgeTerminalConnectSuccessIfPresent';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';
import { toTestIdSafeValue } from '../../src/testkit/uiE2e/testIdSafeValue';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';
import { selectRepositoryAllFiles } from '../../src/testkit/uiE2e/repositoryTreeVisibility';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.use({ acceptDownloads: true });

function rightPaneLocator(page: Page) {
  return page.getByTestId('multi-pane-right-docked').or(page.getByTestId('multi-pane-right-overlay'));
}

function repositoryTreePathVariants(path: string): readonly [string, string] {
  const trimmed = path.trim();
  if (!trimmed) return [trimmed, trimmed];
  return trimmed.endsWith('/') ? [trimmed, trimmed.slice(0, -1)] : [trimmed, `${trimmed}/`];
}

function repositoryTreeRowLocator(scope: Locator, path: string): Locator {
  const [primary, alternate] = repositoryTreePathVariants(path);
  return scope
    .locator(`[data-testid="repository-tree-row-${toTestIdSafeValue(primary)}"]:visible`)
    .or(scope.locator(`[data-testid="repository-tree-row-${toTestIdSafeValue(alternate)}"]:visible`));
}

function repositoryTreeRowMenuLocator(scope: Locator, path: string): Locator {
  const [primary, alternate] = repositoryTreePathVariants(path);
  return scope
    .locator(`[data-testid="repository-tree-row-menu-${toTestIdSafeValue(primary)}"]:visible`)
    .or(scope.locator(`[data-testid="repository-tree-row-menu-${toTestIdSafeValue(alternate)}"]:visible`));
}

async function maybeDismissDetectedClisModal(page: Page, timeoutMs = 5_000): Promise<void> {
  const modal = page.locator('[data-testid="detected-clis:modal"]:visible').first();

  if (timeoutMs > 0) {
    const deadlineMs = Date.now() + timeoutMs;
    while (Date.now() < deadlineMs) {
      if ((await modal.count()) > 0) break;
      await page.waitForTimeout(200);
    }
  }

  if ((await modal.count()) === 0) return;

  const okButton = page.locator('[data-testid="detected-clis:ok"]:visible').first();
  if ((await okButton.count()) > 0) {
    await okButton.click();
    await expect(modal).toHaveCount(0, { timeout: 60_000 });
    return;
  }

  const closeButton = page.locator('[data-testid="detected-clis:close"]:visible').first();
  if ((await closeButton.count()) > 0) {
    await closeButton.click();
    await expect(modal).toHaveCount(0, { timeout: 60_000 });
    return;
  }

  await page.keyboard.press('Escape').catch(() => {});
  await expect(modal).toHaveCount(0, { timeout: 60_000 });
}

async function maybeDismissAgentPickerPopover(page: Page): Promise<void> {
  const popover = page.locator('[data-testid="agent-input-chip-picker-popover"]:visible').first();
  if ((await popover.count()) === 0) return;
  await page.keyboard.press('Escape').catch(() => {});
  await expect(popover).toHaveCount(0, { timeout: 60_000 });
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
  const dropdownOption = page.locator(`[data-testid="dropdown-option-${toTestIdSafeValue(itemId)}"]:visible`).first();
  if ((await dropdownOption.count()) > 0) {
    await dropdownOption.click();
    return;
  }

  await page.locator(`[data-testid="${itemId}"]:visible`).first().click();
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
  phase: string;
}>): Promise<void> {
  const uploadStatus = params.rightPane.getByTestId('repository-tree-upload-status');
  const uploadedRow = params.rightPane.getByTestId(`repository-tree-row-${toTestIdSafeValue(params.uploadedPath)}`);

  await expect
    .poll(
      async () => (await uploadStatus.count()) > 0 || (await uploadedRow.count()) > 0,
      { message: `wait for ${params.phase} upload to start or appear in the repository tree`, timeout: 60_000 },
    )
    .toBe(true);

  if ((await uploadStatus.count()) > 0) {
    await expect(uploadStatus, `${params.phase} upload status should finish`).toHaveCount(0, { timeout: 180_000 });
  }

  await expect(uploadedRow, `${params.phase} upload should appear at ${params.uploadedPath}`).toHaveCount(1, { timeout: 120_000 });
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

  test('uploads file, renames, downloads, deletes, and downloads folder zip', { tag: "@smoke" }, async ({ page }) => {
    test.setTimeout(180_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const browserDiagnostics = collectBrowserDiagnostics({ page });
    const testDir = resolve(join(suiteDir, 't1-filemanager'));

      let runDaemon: StartedDaemon | null = null;
      try {
        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoDomContentLoadedWithRetries(page, uiBaseUrl);

        await waitForInitialAppUi({ page, browserDiagnostics });
        await maybeDismissDetectedClisModal(page, 1_000).catch(() => {});
        await maybeDismissAgentPickerPopover(page).catch(() => {});
        await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });

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

      // Keep HAPPIER_MACHINE_RPC_WORKING_DIRECTORY unset: workspaceDir is outside cliHomeDir,
      // so this exercises the default OS-user filesystem access policy end to end.
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
      const filesSurface = rightPane.getByTestId('session-rightpanel-surface-files');
      if (!(await filesSurface.isVisible())) {
        await page.getByTestId('session-action-rail:files').click();
      }
      await expect(filesSurface).toBeVisible({ timeout: 120_000 });
      await selectRepositoryAllFiles({ rightPane, timeoutMs: 120_000 });
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
        await waitForUploadToComplete({ rightPane, uploadedPath, phase: 'initial file' });
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
        page.waitForEvent('download', { timeout: 60_000 }),
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

      // A second expanded directory must refresh too, without switching sessions.
      await repositoryTreeRowLocator(rightPane, 'download-me').click();
      await repositoryTreeRowLocator(rightPane, 'download-me/nested').click();
      const nestedPath = 'download-me/nested/hello.txt';
      const nestedRenamedPath = 'download-me/nested/renamed.txt';
      await expect(repositoryTreeRowLocator(rightPane, nestedPath)).toHaveCount(1);
      await repositoryTreeRowMenuLocator(rightPane, nestedPath).click();
      await clickDropdownOptionByItemId(page, 'repository-tree-menuitem-rename');
      await page.getByPlaceholder(nestedPath).fill(nestedRenamedPath);
      await expect(page.getByTestId('web-prompt-confirm')).toBeEnabled();
      await page.getByTestId('web-prompt-confirm').click();
      await expect(repositoryTreeRowLocator(rightPane, nestedPath)).toHaveCount(0);
      await expect(repositoryTreeRowLocator(rightPane, nestedRenamedPath)).toHaveCount(1);

      // The toolbar refresh must also pick up a subsequent rename made on disk.
      const refreshedPath = 'download-me/nested/refreshed.txt';
      await rename(resolve(workspaceDir, nestedRenamedPath), resolve(workspaceDir, refreshedPath));
      const refreshButton = rightPane.getByTestId('repository-tree-refresh');
      if (await refreshButton.isVisible()) {
        await refreshButton.click();
      } else {
        await rightPane.getByTestId('repository-tree-toolbar-overflow').click();
        await clickDropdownOptionByItemId(page, 'repository-tree-refresh');
      }
      await expect(repositoryTreeRowLocator(rightPane, nestedRenamedPath)).toHaveCount(0);
      await expect(repositoryTreeRowLocator(rightPane, refreshedPath)).toHaveCount(1);
      await repositoryTreeRowMenuLocator(rightPane, refreshedPath).click();
      const [nestedDownload] = await Promise.all([
        page.waitForEvent('download', { timeout: 60_000 }),
        clickDropdownOptionByItemId(page, 'repository-tree-menuitem-download'),
      ]);
      expect(nestedDownload.suggestedFilename()).toBe('refreshed.txt');
      const nestedDownloadPath = await nestedDownload.path();
      expect(nestedDownloadPath).not.toBeNull();
      if (nestedDownloadPath) expect(await readFile(nestedDownloadPath, 'utf8')).toBe('hello zip\n');

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
      await waitForUploadToComplete({ rightPane, uploadedPath: keepBothPath, phase: 'keep-both conflict' });

      await expect.poll(async () => await readFile(resolve(join(workspaceDir, conflictPath)), 'utf8')).toBe('existing target\n');
      await expect.poll(async () => await readFile(resolve(join(workspaceDir, keepBothPath)), 'utf8')).toBe('conflicting upload\n');

      // Download folder as zip.
      const folderPath = 'download-me';
      await expect(repositoryTreeRowLocator(rightPane, folderPath)).toHaveCount(1, { timeout: 120_000 });
      await repositoryTreeRowMenuLocator(rightPane, folderPath).click();
      const [zipDownload] = await Promise.all([
        page.waitForEvent('download', { timeout: 120_000 }),
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
      throw appendBrowserDiagnostics(error, browserDiagnostics());
    } finally {
      await runDaemon?.stop().catch(() => {});
    }
  });
});
