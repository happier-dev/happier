import { test, expect, type Locator, type Page } from '@playwright/test';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { createAccountAndReachConnectMachineState, gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl, waitForAuthenticatedHomeUi } from '../../src/testkit/uiE2e/pageNavigation';
import { acknowledgeTerminalConnectSuccessIfPresent } from '../../src/testkit/uiE2e/acknowledgeTerminalConnectSuccessIfPresent';
import { clickScopedButtonByTestIdOrRole } from '../../src/testkit/uiE2e/clickScopedButtonByTestIdOrRole';
import { openRepositoryTreeRowMenuAndSelectItem } from '../../src/testkit/uiE2e/repositoryTree';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';
import { toTestIdSafeValue } from '../../src/testkit/uiE2e/testIdSafeValue';
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

test.describe('ui e2e: relay max-bytes abort falls back safely', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-files-relay-max-bytes-suite');
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
      HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: `session-files-relay-max-bytes-${run.runId}`,
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

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__ENABLED: '1',
        HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '1000',
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_GENERATE: '1',
        HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
        // Force the relay-v2 max-bytes abort path.
        HAPPIER_FEATURE_MACHINES_TRANSFER_SERVER_ROUTED__MAX_BYTES: '512',
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

  test('downloads still succeed (legacy fallback) and relay max-bytes abort is observable', async ({ page }) => {
    test.setTimeout(420_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const directPeerRequests = collectDirectPeerRequests(page);
    const relayTraffic = collectTransferRelayV2Traffic(page, { captureBulkTransfer: true });

    const testDir = resolve(join(suiteDir, 't1-relay-max-bytes'));
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

    const fileName = 'relay-max-bytes.txt';
    await writeFile(resolve(join(workspaceDir, fileName)), 'x'.repeat(4096), 'utf8');

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
      await expect.poll(async () => (await readFile(fileDownloadPath, 'utf8')).length).toBeGreaterThan(0);
    }

    expect(directPeerRequests.length).toBe(0);
    const relayEvidence = [...relayTraffic.frames, ...relayTraffic.updateBodies].join('\n\n---\n\n');
    expect(relayTraffic.sawAbort()).toBe(true);
    expect(relayEvidence).toContain('Server-relayed transfer exceeds the configured max-bytes limit');
    // After relay-v2 abort, bridge-state must fall back to legacy bulk transfer chunk RPCs.
    expect(relayEvidence.includes('daemon.bulkTransfer.download.chunk')).toBe(true);
  });
});
