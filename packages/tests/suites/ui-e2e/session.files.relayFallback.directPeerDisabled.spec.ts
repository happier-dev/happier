import { test, expect, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
const CANCELED_UPLOAD_BYTES = 40 * 1024 * 1024;
const LARGE_FILE_CHUNK_BYTES = 1024 * 1024;

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

function collectTransferNetworkDiagnostics(page: Page): ReadonlyArray<string> {
  const records: string[] = [];
  page.context().on('request', (request) => {
    const url = request.url();
    if (
      url.includes('/socket.io/')
      || url.includes('/v1/updates/')
      || url.includes('/machine-transfers/')
      || url.includes('/rpc')
      || url.includes('/transfer')
    ) {
      pushLimited(records, `${request.method()} ${url}`, 300);
    }
  });
  return records;
}

function pushLimited(list: string[], value: string, maxEntries = 200): void {
  list.push(value);
  if (list.length > maxEntries) {
    list.shift();
  }
}

async function createDeterministicLargeFile(path: string, sizeBytes: number): Promise<string> {
  const chunk = Buffer.allocUnsafe(LARGE_FILE_CHUNK_BYTES);
  for (let index = 0; index < chunk.byteLength; index += 1) {
    chunk[index] = (index * 31 + 17) & 0xff;
  }

  const hash = createHash('sha256');
  const handle = await open(path, 'w');
  try {
    let writtenBytes = 0;
    while (writtenBytes < sizeBytes) {
      const bytes = chunk.subarray(0, Math.min(chunk.byteLength, sizeBytes - writtenBytes));
      await handle.write(bytes);
      hash.update(bytes);
      writtenBytes += bytes.byteLength;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

type DaemonUploadPartial = Readonly<{ path: string; sizeBytes: number }>;

async function readDaemonUploadPartials(daemonPid: number): Promise<DaemonUploadPartial[]> {
  const baseRoot = join(tmpdir(), 'happier', 'file-transfers');
  const roots = await readdir(baseRoot, { withFileTypes: true }).catch(() => []);
  const partials: DaemonUploadPartial[] = [];

  for (const root of roots) {
    if (!root.isDirectory() || !root.name.startsWith(`${daemonPid}-`)) continue;
    const rootPath = join(baseRoot, root.name);
    const entries = await readdir(rootPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.upload')) continue;
      const path = join(rootPath, entry.name);
      const fileStats = await stat(path).catch(() => null);
      if (!fileStats) continue;
      partials.push({ path, sizeBytes: fileStats.size });
    }
  }

  return partials;
}

async function readDaemonLog(daemon: StartedDaemon): Promise<string> {
  const logPath = daemon.state.daemonLogPath;
  if (!logPath) return '';
  return await readFile(logPath, 'utf8').catch(() => '');
}

test.describe('ui e2e: relay fallback when direct peer is disabled', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-files-relay-fallback-suite');
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
      HAPPIER_E2E_UI_WEB_EXPORT_NAMESPACE: `session-files-relay-fallback-${run.runId}`,
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

  test('downloads and uploads via server-mediated fallback, including admitted upload cancellation', async ({ page }, testInfo) => {
    test.setTimeout(420_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const directPeerRequests = collectDirectPeerRequests(page);
    const networkDiagnostics = collectTransferNetworkDiagnostics(page);
    const relayTraffic = collectTransferRelayV2Traffic(page, { captureBulkTransfer: true });

    const testDir = resolve(join(suiteDir, 't1-relay-fallback'));
    await mkdir(testDir, { recursive: true });

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);

    await waitForInitialAppUi({ page, browserDiagnostics: () => '' });
    await maybeDismissDetectedClisModal(page, 1_000).catch(() => {});
    await maybeDismissAgentPickerPopover(page).catch(() => {});
    await createAccountAndReachConnectMachineState({
      page,
      useFirstCreateButton: true,
      // The terminal-connect flow below is the authoritative auth check for this scenario.
      requirePersistedAuthCredentials: false,
    });

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

    const fileName = 'relay-target.txt';
    await writeFile(resolve(join(workspaceDir, fileName)), 'hello relay\n', 'utf8');

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

    // Download the file (forces a machine->user transfer with direct peer disabled).
    const [fileDownload] = await Promise.all([
      page.waitForEvent('download', { timeout: 120_000 }),
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
      await expect.poll(async () => await readFile(fileDownloadPath, 'utf8')).toBe('hello relay\n');
    }

    // Gate: direct-peer HTTP stays disabled and download uses relay-v2, never the
    // legacy bulk download fallback.
    expect(directPeerRequests.length).toBe(0);
    try {
      await expect.poll(async () => relayTraffic.sawRelayV2EventName(), { timeout: 60_000 }).toBe(true);
      await expect.poll(async () => relayTraffic.sawChunkEnvelope(), { timeout: 60_000 }).toBe(true);
      const relayEvidence = [...relayTraffic.frames, ...relayTraffic.updateBodies].join('\n\n---\n\n');
      expect(relayEvidence.includes('daemon.transfer.download.chunk')).toBe(false);
    } catch (error) {
      await testInfo.attach('relay-v2-ws-frames', {
        body: relayTraffic.frames.join('\n\n---\n\n'),
        contentType: 'text/plain',
      });
      await testInfo.attach('relay-v2-update-bodies', {
        body: relayTraffic.updateBodies.join('\n\n---\n\n'),
        contentType: 'text/plain',
      });
      await testInfo.attach('transfer-network-diagnostics', {
        body: networkDiagnostics.join('\n'),
        contentType: 'text/plain',
      });
      await writeFile(
        resolve(join(testDir, 'relay-v2-ws-frames.txt')),
        relayTraffic.frames.join('\n\n---\n\n'),
        'utf8',
      ).catch(() => {});
      await writeFile(
        resolve(join(testDir, 'relay-v2-update-bodies.txt')),
        relayTraffic.updateBodies.join('\n\n---\n\n'),
        'utf8',
      ).catch(() => {});
      await writeFile(
        resolve(join(testDir, 'relay-v2-network-diagnostics.txt')),
        networkDiagnostics.join('\n'),
        'utf8',
      ).catch(() => {});
      throw error;
    }

    // Upload a complete workspace file with the same direct-disabled daemon. The daemon log is
    // the authoritative composed-boundary record for the relay RPC lifecycle; browser requests
    // independently prove that no direct import endpoint was used.
    const uploadInput = rightPane.getByTestId('repository-tree-upload-input-files');
    await expect(uploadInput).toHaveCount(1, { timeout: 60_000 });
    const uploadedFileName = 'relay-upload.txt';
    const uploadedContent = 'hello upload fallback\n';
    const uploadedSourcePath = resolve(join(testDir, uploadedFileName));
    const uploadedDestinationPath = resolve(join(workspaceDir, uploadedFileName));
    const uploadedSha256 = createHash('sha256').update(uploadedContent).digest('hex');
    await writeFile(uploadedSourcePath, uploadedContent, 'utf8');
    const completedUploadLogOffset = (await readDaemonLog(runDaemon)).length;
    await uploadInput.setInputFiles(uploadedSourcePath);
    await expect
      .poll(async () => await readFile(uploadedDestinationPath, 'utf8').catch(() => null), { timeout: 120_000 })
      .toBe(uploadedContent);
    await expect(rightPane.getByTestId('repository-tree-upload-status')).toHaveCount(0, { timeout: 60_000 });
    await expect.poll(async () => {
      const phaseLog = (await readDaemonLog(runDaemon)).slice(completedUploadLogOffset);
      return [
        'daemon.bulkTransfer.upload.init',
        'daemon.bulkTransfer.upload.chunk',
        'daemon.bulkTransfer.upload.finalize',
      ].every((marker) => phaseLog.includes(marker));
    }, { timeout: 60_000 }).toBe(true);
    expect(directPeerRequests.length).toBe(0);
    expect(createHash('sha256').update(await readFile(uploadedDestinationPath)).digest('hex')).toBe(uploadedSha256);

    // Cancel only after the daemon has admitted and persisted at least one encrypted relay chunk.
    // This distinguishes cleanup from a preflight-only cancellation.
    const canceledFileName = 'relay-upload-canceled.bin';
    const canceledSourcePath = resolve(join(testDir, canceledFileName));
    const canceledDestinationPath = resolve(join(workspaceDir, canceledFileName));
    const canceledSourceSha256 = await createDeterministicLargeFile(canceledSourcePath, CANCELED_UPLOAD_BYTES);
    const cancellationLogOffset = (await readDaemonLog(runDaemon)).length;
    await uploadInput.setInputFiles(canceledSourcePath);
    let admittedPartials: DaemonUploadPartial[] = [];
    await expect.poll(async () => {
      admittedPartials = (await readDaemonUploadPartials(runDaemon.state.pid))
        .filter((partial) => partial.sizeBytes > 0);
      return admittedPartials.length;
    }, { timeout: 120_000, intervals: [10, 20, 50, 100] }).toBeGreaterThan(0);
    await expect(rightPane.getByTestId('repository-tree-upload-cancel')).toHaveCount(1, { timeout: 60_000 });
    await rightPane.getByTestId('repository-tree-upload-cancel').click();
    await expect(rightPane.getByTestId('repository-tree-upload-status')).toHaveCount(0, { timeout: 60_000 });
    await expect.poll(async () => await stat(canceledDestinationPath).then(() => true).catch(() => false), {
      timeout: 60_000,
    }).toBe(false);
    await expect.poll(async () => (await readDaemonUploadPartials(runDaemon.state.pid)).length, {
      timeout: 60_000,
    }).toBe(0);
    await expect.poll(async () => {
      const phaseLog = (await readDaemonLog(runDaemon)).slice(cancellationLogOffset);
      return [
        'daemon.bulkTransfer.upload.init',
        'daemon.bulkTransfer.upload.chunk',
        'daemon.bulkTransfer.upload.abort',
      ].every((marker) => phaseLog.includes(marker));
    }, { timeout: 60_000 }).toBe(true);
    expect(directPeerRequests.length).toBe(0);

    await testInfo.attach('upload-fallback-live-evidence', {
      body: JSON.stringify({
        daemonPid: runDaemon.state.pid,
        route: 'server-mediated bulkTransfer upload fallback',
        directPeerRequestCount: directPeerRequests.length,
        completedUpload: {
          name: uploadedFileName,
          sizeBytes: Buffer.byteLength(uploadedContent),
          sha256: uploadedSha256,
        },
        canceledUpload: {
          name: canceledFileName,
          sourceSizeBytes: CANCELED_UPLOAD_BYTES,
          sourceSha256: canceledSourceSha256,
          admittedPartialSizesBytes: admittedPartials.map((partial) => partial.sizeBytes),
          destinationExistsAfterCancel: false,
          remainingDaemonUploadPartials: 0,
        },
      }, null, 2),
      contentType: 'application/json',
    });
  });
});
