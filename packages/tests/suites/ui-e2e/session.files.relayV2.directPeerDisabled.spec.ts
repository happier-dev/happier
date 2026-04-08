import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb } from '../../src/testkit/process/uiWeb';
import type { StartedUiWeb } from '../../src/testkit/process/uiWebTypes';
import { startTestDaemon, type StartedDaemon, waitForDaemonState } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import {
  createAccountAndReachConnectMachineState,
  gotoDomContentLoadedWithRetries,
  normalizeLoopbackBaseUrl,
  waitForAuthenticatedHomeUi,
} from '../../src/testkit/uiE2e/pageNavigation';
import { acknowledgeTerminalConnectSuccessIfPresent } from '../../src/testkit/uiE2e/acknowledgeTerminalConnectSuccessIfPresent';
import { clickScopedButtonByTestIdOrRole } from '../../src/testkit/uiE2e/clickScopedButtonByTestIdOrRole';
import { openRepositoryTreeRowMenuAndSelectItem } from '../../src/testkit/uiE2e/repositoryTree';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { collectTransferRelayV2Traffic } from '../../src/testkit/uiE2e/transferRelayV2TrafficCapture';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.use({ acceptDownloads: true });

function rightPaneLocator(page: Page) {
  return page.getByTestId('multi-pane-right-docked').or(page.getByTestId('multi-pane-right-overlay'));
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

function collectDirectPeerRequests(page: Page): ReadonlyArray<string> {
  const directPeerRequests: string[] = [];
  page.context().on('request', (request) => {
    const url = request.url();
    if (url.includes('/machine-transfers/direct/')) {
      directPeerRequests.push(`${request.method()} ${url}`);
    }
  });
  return directPeerRequests;
}

async function startRelayV2DirectPeerDisabledDaemon(params: Readonly<{
  testDir: string;
  cliHomeDir: string;
  serverUrl: string;
  webappUrl: string;
  fakeClaudePath: string;
  fakeClaudeLogPath: string;
  sessionSeed: string;
  invocationSeed: string;
}>): Promise<StartedDaemon> {
  return await startTestDaemon({
    testDir: params.testDir,
    happyHomeDir: params.cliHomeDir,
    env: {
      ...process.env,
      HOME: params.cliHomeDir,
      CI: '1',
      HAPPIER_HOME_DIR: params.cliHomeDir,
      HAPPIER_SERVER_URL: params.serverUrl,
      HAPPIER_WEBAPP_URL: params.webappUrl,
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: params.testDir,
      HAPPIER_CLAUDE_PATH: params.fakeClaudePath,
      HAPPIER_E2E_FAKE_CLAUDE_LOG: params.fakeClaudeLogPath,
      HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: params.sessionSeed,
      HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: params.invocationSeed,
      HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED: '0',
    },
  });
}

test.describe('ui e2e: relay-v2 workspace download works when direct peer is disabled', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-files-relay-v2-suite');
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
	      HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: `session-files-relay-v2-${run.runId}`,
	      HAPPIER_E2E_UI_WEB_MODE: 'export',
	      HAPPIER_E2E_UI_WEB_EXPORT_FALLBACK_TO_METRO: '0',
	      HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS: '600000',
	      HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS: '900000',
	      HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS:
	        process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS
	        ?? '480000',
	    };
	    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
	    await mkdir(cliHomeDir, { recursive: true });
	    await writeFile(resolve(join(cliHomeDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');
	    let startedServer: StartedServer | null = null;
	    let startedUi: StartedUiWeb | null = null;
	    try {
	      startedServer = await startServerLight({
	        testDir: suiteDir,
	        dbProvider: 'sqlite',
	        extraEnv: {
	          HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
	          HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__ENABLED: '1',
	          HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
	          HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '60000',
	          HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '60000',
	          HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '1000',
	          HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
	          HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE: '1',
	          HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
	        },
	      });

	      uiWebEnv.EXPO_PUBLIC_HAPPY_SERVER_URL = startedServer.baseUrl;
	      startedUi = await startUiWeb({ testDir: suiteDir, env: uiWebEnv });

	      server = startedServer;
	      ui = startedUi;
	      uiBaseUrl = normalizeLoopbackBaseUrl(startedUi.baseUrl);
	    } catch (error) {
	      await startedUi?.stop().catch(() => {});
	      await startedServer?.stop().catch(() => {});
	      throw error;
	    }
	  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('downloads a file via relay-v2 (no legacy bulk chunk RPC)', async ({ page }, testInfo) => {
    test.setTimeout(420_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const directPeerRequests = collectDirectPeerRequests(page);
    const relayTraffic = collectTransferRelayV2Traffic(page, { captureBulkTransfer: true });

    const testDir = resolve(join(suiteDir, 't1-relay-v2'));
    await mkdir(testDir, { recursive: true });

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);

    await waitForInitialAppUi({ page, browserDiagnostics: () => '' });
    await maybeDismissDetectedClisModal(page, 1_000).catch(() => {});
    await maybeDismissAgentPickerPopover(page).catch(() => {});
    await createAccountAndReachConnectMachineState({ page, useFirstCreateButton: true });

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
    await page.goto(`${uiBaseUrl}/`, { waitUntil: 'domcontentloaded' });
    await waitForAuthenticatedHomeUi({ page, timeoutMs: 120_000 });

    const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
    const fakeClaudePath = fakeClaudeFixturePath();

    const runDaemon = await startTestDaemon({
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
        HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_SERVER_ENABLED: '0',
      },
    });
    daemon = runDaemon;

    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(workspaceDir, { recursive: true });

    const fileName = 'relay-v2-target.txt';
    await writeFile(resolve(join(workspaceDir, fileName)), 'hello relay-v2\n', 'utf8');

    const sessionId = await spawnSessionFromDaemon({ daemon: runDaemon, directory: workspaceDir });
    await page.goto(`${uiBaseUrl}/session/${sessionId}?right=files`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 180_000 });

    await expect(rightPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });
    const rightPane = rightPaneLocator(page);
    await clickScopedButtonByTestIdOrRole({
      scope: rightPane,
      testId: 'session-rightpanel-tab:files',
      roleName: 'Files',
      timeoutMs: 180_000,
    });
    await expect(rightPane.getByTestId('session-rightpanel-surface-files')).toHaveCount(1, { timeout: 120_000 });

    const downloadPromise = page.waitForEvent('download', { timeout: 180_000 });
    await openRepositoryTreeRowMenuAndSelectItem({
      page,
      scope: rightPane,
      path: fileName,
      itemId: 'repository-tree-menuitem-download',
      timeoutMs: 120_000,
    });
    const fileDownload = await downloadPromise;

    const fileDownloadPath = await fileDownload.path();
    expect(fileDownloadPath).not.toBeNull();
    if (fileDownloadPath) {
      const fileStats = await stat(fileDownloadPath);
      expect(fileStats.size).toBeGreaterThan(0);
      await expect.poll(async () => await readFile(fileDownloadPath, 'utf8')).toBe('hello relay-v2\n');
    }

    expect(directPeerRequests.length).toBe(0);

    try {
      await expect.poll(async () => relayTraffic.sawRelayV2EventName(), { timeout: 60_000 }).toBe(true);
      const evidence = [...relayTraffic.frames, ...relayTraffic.updateBodies].join('\n\n---\n\n');
      expect(evidence.includes('daemon.transfer.download.chunk')).toBe(false);
    } catch (error) {
      await testInfo.attach('relay-v2-frames', {
        body: relayTraffic.frames.join('\n\n---\n\n'),
        contentType: 'text/plain',
      });
      await testInfo.attach('relay-v2-update-bodies', {
        body: relayTraffic.updateBodies.join('\n\n---\n\n'),
        contentType: 'text/plain',
      });
      await writeFile(
        resolve(join(testDir, 'relay-v2-frames.txt')),
        relayTraffic.frames.join('\n\n---\n\n'),
        'utf8',
      ).catch(() => {});
      await writeFile(
        resolve(join(testDir, 'relay-v2-update-bodies.txt')),
        relayTraffic.updateBodies.join('\n\n---\n\n'),
        'utf8',
      ).catch(() => {});
      throw error;
    }
  });

  test('survives a daemon restart without reusing stale direct-peer candidates', async ({ page }, testInfo) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const directPeerRequests = collectDirectPeerRequests(page);
    const relayTraffic = collectTransferRelayV2Traffic(page, { captureBulkTransfer: true });

    const testDir = resolve(join(suiteDir, 't2-relay-v2-reconnect'));
    await mkdir(testDir, { recursive: true });

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);

    await waitForInitialAppUi({ page, browserDiagnostics: () => '' });
    await maybeDismissDetectedClisModal(page, 1_000).catch(() => {});
    await maybeDismissAgentPickerPopover(page).catch(() => {});
    await createAccountAndReachConnectMachineState({ page, useFirstCreateButton: true });

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
    await page.goto(`${uiBaseUrl}/`, { waitUntil: 'domcontentloaded' });

    const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
    const fakeClaudePath = fakeClaudeFixturePath();

    const daemonEnv = {
      serverUrl: server.baseUrl,
      webappUrl: uiBaseUrl,
      fakeClaudePath,
      fakeClaudeLogPath,
      sessionSeed: `fake-claude-session-${run.runId}`,
      invocationSeed: `fake-claude-invocation-${run.runId}`,
    } as const;

    daemon = await startRelayV2DirectPeerDisabledDaemon({
      testDir,
      cliHomeDir,
      ...daemonEnv,
    });

    const workspaceDir = resolve(join(testDir, 'workspace'));
    await mkdir(workspaceDir, { recursive: true });

    const fileName = 'relay-v2-reconnect-target.txt';
    await writeFile(resolve(join(workspaceDir, fileName)), 'hello relay-v2 reconnect\n', 'utf8');

    const sessionId = await spawnSessionFromDaemon({ daemon, directory: workspaceDir });
    await page.goto(`${uiBaseUrl}/session/${sessionId}?right=files`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 180_000 });

    await expect(rightPaneLocator(page)).toHaveCount(1, { timeout: 60_000 });
    const rightPane = rightPaneLocator(page);
    await clickScopedButtonByTestIdOrRole({
      scope: rightPane,
      testId: 'session-rightpanel-tab:files',
      roleName: 'Files',
      timeoutMs: 180_000,
    });
    await expect(rightPane.getByTestId('session-rightpanel-surface-files')).toHaveCount(1, { timeout: 120_000 });

    const downloadOnce = async (expectedText: string): Promise<void> => {
      const [fileDownload] = await Promise.all([
        page.waitForEvent('download', { timeout: 180_000 }),
        openRepositoryTreeRowMenuAndSelectItem({
          page,
          scope: rightPane,
          path: fileName,
          itemId: 'repository-tree-menuitem-download',
          timeoutMs: 120_000,
        }),
      ]);

      const fileDownloadPath = await fileDownload.path();
      expect(fileDownloadPath).not.toBeNull();
      if (fileDownloadPath) {
        const fileStats = await stat(fileDownloadPath);
        expect(fileStats.size).toBeGreaterThan(0);
        await expect.poll(async () => await readFile(fileDownloadPath, 'utf8')).toBe(expectedText);
      }
    };

    await downloadOnce('hello relay-v2 reconnect\n');
    const requestsBeforeRestart = directPeerRequests.length;

    await daemon.stop();
    daemon = await startRelayV2DirectPeerDisabledDaemon({
      testDir,
      cliHomeDir,
      ...daemonEnv,
    });

    await waitForDaemonState(cliHomeDir, { timeoutMs: 60_000 });
    await downloadOnce('hello relay-v2 reconnect\n');

    expect(directPeerRequests.length).toBe(requestsBeforeRestart);
    expect(directPeerRequests.length).toBe(0);
    expect(relayTraffic.sawRelayV2EventName()).toBe(true);

    if (relayTraffic.frames.length > 0 || relayTraffic.updateBodies.length > 0) {
      const evidence = [...relayTraffic.frames, ...relayTraffic.updateBodies].join('\n\n---\n\n');
      expect(evidence.includes('daemon.transfer.download.chunk')).toBe(false);
    }
  });
});
