import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { createAccountAndReachConnectMachineState, gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { acknowledgeTerminalConnectSuccessIfPresent } from '../../src/testkit/uiE2e/acknowledgeTerminalConnectSuccessIfPresent';
import { clickScopedButtonByTestIdOrRole } from '../../src/testkit/uiE2e/clickScopedButtonByTestIdOrRole';
import {
  openRepositoryTreeRowMenuAndSelectItem,
  repositoryTreeRowLocator,
} from '../../src/testkit/uiE2e/repositoryTree';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';
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

type DirectPeerOpenRequest = Readonly<{
  url: string;
  authorizationHeader: string | null;
}>;

function collectDirectPeerOpenRequests(page: Page): DirectPeerOpenRequest[] {
  const requests: DirectPeerOpenRequest[] = [];
  page.context().on('request', (request) => {
    const url = request.url();
    if (!url.includes('/machine-transfers/direct/') || !new URL(url).pathname.endsWith('/open')) {
      return;
    }
    requests.push({
      url,
      authorizationHeader: request.headers().authorization ?? null,
    });
  });
  return requests;
}

async function waitForDirectPeerOpenRequest(params: Readonly<{
  requests: readonly DirectPeerOpenRequest[];
  requestIndex: number;
  timeoutMs?: number;
}>): Promise<DirectPeerOpenRequest> {
  const timeoutMs = params.timeoutMs ?? 120_000;
  await expect.poll(() => params.requests.length, { timeout: timeoutMs }).toBeGreaterThan(params.requestIndex);
  const request = params.requests[params.requestIndex];
  if (!request) {
    throw new Error(`Missing direct-peer open request at index ${params.requestIndex}`);
  }
  return request;
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

function buildFileManagerDaemonEnv(params: Readonly<{
  cliHomeDir: string;
  serverBaseUrl: string;
  uiBaseUrl: string;
  testDir: string;
  fakeClaudePath: string;
  fakeClaudeLogPath: string;
  runId: string;
}>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: params.cliHomeDir,
    CI: '1',
    HAPPIER_HOME_DIR: params.cliHomeDir,
    HAPPIER_SERVER_URL: params.serverBaseUrl,
    HAPPIER_WEBAPP_URL: params.uiBaseUrl,
    HAPPIER_DISABLE_CAFFEINATE: '1',
    HAPPIER_VARIANT: 'dev',
    HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    HAPPIER_CLAUDE_PATH: params.fakeClaudePath,
    HAPPIER_E2E_FAKE_CLAUDE_LOG: params.fakeClaudeLogPath,
    HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${params.runId}`,
    HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${params.runId}`,
  };
}

test.describe('ui e2e: Files upload + rename/delete + download (+ zip)', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-files-filemanager-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;
  let sessionId: string | null = null;

  test.beforeAll(async () => {
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_SERVER_URL: '',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
      HAPPIER_E2E_UI_WEB_MODE: 'metro',
      HAPPIER_E2E_UI_WEB_BASE_URL_TIMEOUT_MS: '300000',
      HAPPIER_E2E_UI_WEB_METRO_STATUS_TIMEOUT_MS: '600000',
      HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS:
        process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS
        ?? '480000',
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
    const resolvedServer = server;
    const resolvedUiBaseUrl = uiBaseUrl;
    const sameMachineNavigationTimeoutMs = 300_000;

    const browserDiagnostics = collectBrowserDiagnostics({ page });
    const directPeerOpenRequests = collectDirectPeerOpenRequests(page);
    const testDir = resolve(join(suiteDir, 't1-filemanager'));

    let runDaemon: StartedDaemon | null = null;
    try {
      await test.step('reach authenticated home UI', async () => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await gotoDomContentLoadedWithRetries(page, resolvedUiBaseUrl, sameMachineNavigationTimeoutMs);

        await waitForInitialAppUi({ page, browserDiagnostics });
        await maybeDismissDetectedClisModal(page, 1_000).catch(() => {});
        await maybeDismissAgentPickerPopover(page).catch(() => {});
        await createAccountAndReachConnectMachineState({ page, useFirstCreateButton: true });
      });

      await mkdir(testDir, { recursive: true });

      const cliLogin: StartedCliTerminalConnect = await startCliAuthLoginForTerminalConnect({
        testDir,
        cliHomeDir,
        serverUrl: resolvedServer.baseUrl,
        webappUrl: resolvedUiBaseUrl,
        waitForConnectUrlReady: false,
        env: {
          ...process.env,
          HOME: cliHomeDir,
          CI: '1',
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_VARIANT: 'dev',
          HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        },
      });
      await test.step('complete terminal connect login', async () => {
        await gotoDomContentLoadedWithRetries(page, cliLogin.connectUrl, sameMachineNavigationTimeoutMs);
        await expect(page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
        await page.getByTestId('terminal-connect-approve').click();
        await cliLogin.waitForSuccess();
        await acknowledgeTerminalConnectSuccessIfPresent(page);
      });

      const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
      const fakeClaudePath = fakeClaudeFixturePath();

      await test.step('spawn daemon and load session files pane', async () => {
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
            HAPPIER_SERVER_URL: resolvedServer.baseUrl,
            HAPPIER_WEBAPP_URL: resolvedUiBaseUrl,
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

        sessionId = await spawnSessionFromDaemon({ daemon: runDaemon, directory: workspaceDir });
        await gotoDomContentLoadedWithRetries(
          page,
          `${resolvedUiBaseUrl}/session/${sessionId}?right=files`,
          sameMachineNavigationTimeoutMs,
        );
        try {
          await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 180_000 });
        } catch (error) {
          await capturePageDiagnostics({
            page,
            outputPath: resolve(join(testDir, 'browser-diagnostics.session-route.md')),
            browserDiagnostics,
          });
          throw error;
        }

        // Ensure right pane is open and the Files tab has fully lazy-mounted before looking for tree controls.
        await expect(rightPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });

        const rightPane = rightPaneLocator(page);
        await clickScopedButtonByTestIdOrRole({
          scope: rightPane,
          testId: 'session-rightpanel-tab:files',
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
      });

      await test.step('prove post-restart file handling', async () => {
        const workspaceDir = resolve(join(testDir, 'workspace'));
        const uploadedPath = 'upload-source.txt';
        const workspaceUploadedPath = resolve(join(workspaceDir, uploadedPath));
        let preRestartDirectPeerOpenRequest: Awaited<ReturnType<typeof waitForDirectPeerOpenRequest>> | null = null;
        try {
          await expect
            .poll(async () => await readFile(workspaceUploadedPath, 'utf8').catch(() => null), { timeout: 120_000 })
            .toBe('hello upload\n');

          const preRestartOpenRequestIndex = directPeerOpenRequests.length;
          const [preRestartDownload] = await Promise.all([
            page.waitForEvent('download', { timeout: 60_000 }),
            openRepositoryTreeRowMenuAndSelectItem({
              page,
              scope: rightPaneLocator(page),
              path: uploadedPath,
              itemId: 'repository-tree-menuitem-download',
            }),
          ]);
          const preRestartDownloadPath = await preRestartDownload.path();
          expect(preRestartDownloadPath).not.toBeNull();
          if (preRestartDownloadPath) {
            await expect
              .poll(async () => await readFile(preRestartDownloadPath, 'utf8').catch(() => null), { timeout: 120_000 })
              .toBe('hello upload\n');
          }
          await expect
            .poll(() => directPeerOpenRequests.length, { timeout: 60_000 })
            .toBeGreaterThanOrEqual(1);
          preRestartDirectPeerOpenRequest = await waitForDirectPeerOpenRequest({
            requests: directPeerOpenRequests,
            requestIndex: preRestartOpenRequestIndex,
            timeoutMs: 120_000,
          });

          const currentRunDaemon: StartedDaemon | null = runDaemon;
          if (!currentRunDaemon) {
            throw new Error('missing daemon before restart');
          }
          await currentRunDaemon.stop();
          daemon = null;

          runDaemon = await startTestDaemon({
            testDir,
            happyHomeDir: cliHomeDir,
            startupTimeoutMs: 120_000,
            env: buildFileManagerDaemonEnv({
              cliHomeDir,
              serverBaseUrl: resolvedServer.baseUrl,
              uiBaseUrl: resolvedUiBaseUrl,
              testDir,
              fakeClaudePath,
              fakeClaudeLogPath,
              runId: run.runId,
            }),
          });
          daemon = runDaemon;

          if (!sessionId) {
            throw new Error('session id missing before post-restart reload');
          }
          const sessionUrl = `${resolvedUiBaseUrl}/session/${sessionId}?right=files`;
          await gotoDomContentLoadedWithRetries(page, sessionUrl);
          await expect(page.getByTestId('session-rightpanel-surface-files')).toHaveCount(1, { timeout: 180_000 });
          await expect(rightPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });
          const refreshedRightPane = rightPaneLocator(page);
          await clickScopedButtonByTestIdOrRole({
            scope: refreshedRightPane,
            testId: 'session-rightpanel-tab:files',
            roleName: 'Files',
            timeoutMs: 180_000,
          });
          await expect(refreshedRightPane.getByTestId('session-rightpanel-surface-files')).toHaveCount(1, {
            timeout: 120_000,
          });
          await expect(repositoryTreeRowLocator(refreshedRightPane, uploadedPath)).toHaveCount(1, { timeout: 120_000 });
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

        const rightPane = rightPaneLocator(page);

        const postRestartOpenRequestIndex = directPeerOpenRequests.length;
        const [postRestartDownload] = await Promise.all([
          page.waitForEvent('download', { timeout: 60_000 }),
          openRepositoryTreeRowMenuAndSelectItem({
            page,
            scope: rightPane,
            path: uploadedPath,
            itemId: 'repository-tree-menuitem-download',
          }),
        ]);
        const postRestartDownloadPath = await postRestartDownload.path();
        expect(postRestartDownloadPath).not.toBeNull();
        if (postRestartDownloadPath) {
          await expect
            .poll(async () => await readFile(postRestartDownloadPath, 'utf8').catch(() => null), { timeout: 120_000 })
            .toBe('hello upload\n');
        }
        const postRestartDirectPeerOpenRequest = await waitForDirectPeerOpenRequest({
          requests: directPeerOpenRequests,
          requestIndex: postRestartOpenRequestIndex,
          timeoutMs: 120_000,
        });
        expect(preRestartDirectPeerOpenRequest).not.toBeNull();
        expect(postRestartDirectPeerOpenRequest.url).not.toBe(preRestartDirectPeerOpenRequest.url);
        expect(postRestartDirectPeerOpenRequest.authorizationHeader).not.toBe(preRestartDirectPeerOpenRequest.authorizationHeader);

        // Rename uploaded file.
        await openRepositoryTreeRowMenuAndSelectItem({
          page,
          scope: rightPane,
          path: uploadedPath,
          itemId: 'repository-tree-menuitem-rename',
        });
        const prompt = page.getByPlaceholder(uploadedPath);
        await expect(prompt).toHaveCount(1, { timeout: 60_000 });
        const renamedPath = 'renamed.txt';
        await prompt.fill(renamedPath);
        await prompt.press('Enter');

        await expect(repositoryTreeRowLocator(rightPane, uploadedPath)).toHaveCount(0, { timeout: 120_000 });
        await expect(repositoryTreeRowLocator(rightPane, renamedPath)).toHaveCount(1, { timeout: 120_000 });

        // Download renamed file.
        const [fileDownload] = await Promise.all([
          page.waitForEvent('download', { timeout: 60_000 }),
          openRepositoryTreeRowMenuAndSelectItem({
            page,
            scope: rightPane,
            path: renamedPath,
            itemId: 'repository-tree-menuitem-download',
          }),
        ]);
        const fileDownloadPath = await fileDownload.path();
        expect(fileDownloadPath).not.toBeNull();
        if (fileDownloadPath) {
          await expect
            .poll(async () => await readFile(fileDownloadPath, 'utf8').catch(() => null), { timeout: 120_000 })
            .toBe('hello upload\n');
        }

        // Delete renamed file.
        await openRepositoryTreeRowMenuAndSelectItem({
          page,
          scope: rightPane,
          path: renamedPath,
          itemId: 'repository-tree-menuitem-delete',
        });
        await expect(page.getByTestId('web-modal-confirm')).toHaveCount(1, { timeout: 60_000 });
        await page.getByTestId('web-modal-confirm').click({ force: true, timeout: 60_000 });
        await expect(repositoryTreeRowLocator(rightPane, renamedPath)).toHaveCount(0, { timeout: 120_000 });

        // Download folder as zip.
        const folderPath = 'download-me';
        await expect(repositoryTreeRowLocator(rightPane, folderPath)).toHaveCount(1, { timeout: 120_000 });
        const [zipDownload] = await Promise.all([
          page.waitForEvent('download', { timeout: 120_000 }),
          openRepositoryTreeRowMenuAndSelectItem({
            page,
            scope: rightPane,
            path: folderPath,
            itemId: 'repository-tree-menuitem-zip',
            timeoutMs: 120_000,
          }),
        ]);
        const zipPath = await zipDownload.path();
        expect(zipPath).not.toBeNull();
        if (zipPath) {
          await expect
            .poll(async () => (await stat(zipPath)).size, { timeout: 120_000 })
            .toBeGreaterThan(0);
        }
      });
    } catch (error) {
      throw new Error(`${String(error)}\n\n${browserDiagnostics()}`);
    } finally {
      const activeRunDaemon: StartedDaemon | null = runDaemon;
      if (activeRunDaemon) {
        await (activeRunDaemon as StartedDaemon).stop().catch(() => {});
      }
    }
  });
});
