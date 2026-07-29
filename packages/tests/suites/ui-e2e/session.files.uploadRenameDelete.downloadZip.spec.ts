import { test, expect, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { inspectOwnedProcess } from '../../src/testkit/process/processOwnershipLease';
import { collectDescendantPids } from '../../src/testkit/process/processTree';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { resolveUiWebMetroOwnershipLeasesDir } from '../../src/testkit/process/uiWebMetro';
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
import { createDirectTransferCancellationChunkGate } from '../../src/testkit/uiE2e/directTransferCancellationChunkGate';
import { evaluateBrowserTransferMemoryContract } from '../../src/testkit/uiE2e/browserTransferMemoryContract';

const run = createRunDirs({ runLabel: 'ui-e2e' });

const LARGE_BROWSER_DOWNLOAD_BYTES = 40 * 1024 * 1024;
const LARGE_BROWSER_DOWNLOAD_CHUNK_BYTES = 1024 * 1024;
const MAX_BROWSER_JS_HEAP_GROWTH_BYTES = LARGE_BROWSER_DOWNLOAD_BYTES / 2;
const MAX_BROWSER_PROCESS_TREE_RSS_GROWTH_BYTES = 128 * 1024 * 1024;
const MAX_DAEMON_RSS_GROWTH_BYTES = 128 * 1024 * 1024;

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

function activeFilesSurfaceLocator(page: Page) {
  return rightPaneLocator(page).locator('[data-testid="session-rightpanel-surface-files"]:visible');
}

async function activateFilesSurface(page: Page, timeoutMs: number): Promise<Locator> {
  const rightPane = rightPaneLocator(page);
  await expect(rightPane).toHaveCount(1, { timeout: timeoutMs });
  await clickScopedButtonByTestIdOrRole({
    scope: rightPane,
    testId: 'session-rightpanel-tab:files',
    roleName: 'Files',
    role: 'tab',
    expectedAriaSelected: true,
    timeoutMs,
  });
  const filesSurface = activeFilesSurfaceLocator(page);
  await expect(filesSurface).toHaveCount(1, { timeout: timeoutMs });
  await expect(filesSurface).toBeVisible({ timeout: timeoutMs });
  return filesSurface;
}

async function createDeterministicLargeFile(path: string, sizeBytes: number): Promise<string> {
  const chunk = Buffer.allocUnsafe(LARGE_BROWSER_DOWNLOAD_CHUNK_BYTES);
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

async function hashFileSha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest('hex');
}

type OpfsPartialDownload = Readonly<{ name: string; sizeBytes: number }>;

async function readOpfsPartialDownloads(page: Page): Promise<OpfsPartialDownload[]> {
  return await page.evaluate(async () => {
    const storage = navigator.storage as StorageManager & {
      getDirectory?: () => Promise<unknown>;
    };
    if (typeof storage.getDirectory !== 'function') return [];
    const root = await storage.getDirectory();
    const directory = root as Readonly<{
      entries: () => AsyncIterableIterator<readonly [string, Readonly<{
        kind: string;
        getFile?: () => Promise<File>;
      }>]>;
    }>;
    const partials: OpfsPartialDownload[] = [];
    for await (const [name, handle] of directory.entries()) {
      if (!name.startsWith('.happier-download-') || !name.endsWith('.partial')) continue;
      const file = handle.kind === 'file' && handle.getFile ? await handle.getFile() : null;
      partials.push({ name, sizeBytes: file?.size ?? 0 });
    }
    return partials;
  });
}

async function readProcessTreeRssBytes(processIds: readonly number[]): Promise<number | null> {
  if (processIds.length === 0 || process.platform === 'win32') return null;
  return await new Promise<number | null>((resolveResult) => {
    execFile('ps', ['-o', 'rss=', '-p', processIds.join(',')], { encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        resolveResult(null);
        return;
      }
      const totalKiB = String(stdout)
        .split(/\s+/)
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isFinite(value))
        .reduce((sum, value) => sum + value, 0);
      resolveResult(totalKiB > 0 ? totalKiB * 1024 : null);
    });
  });
}

type BrowserMemorySample = Readonly<{
  atMs: number;
  jsHeapUsedBytes: number;
  browserProcessTreeRssBytes: number | null;
  daemonRssBytes: number | null;
}>;

type UiWebExitObservation = Readonly<{
  atMs: number;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}>;

async function readListenerPids(port: number): Promise<readonly number[] | null> {
  if (process.platform === 'win32') return null;
  return await new Promise((resolveResult) => {
    execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }, (error, stdout) => {
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        resolveResult(null);
        return;
      }
      const processIds = String(stdout)
        .split(/\s+/u)
        .map((value) => Number.parseInt(value, 10))
        .filter((value) => Number.isInteger(value) && value > 0);
      resolveResult([...new Set(processIds)]);
    });
  });
}

async function collectUiWebProcessDiagnostic(params: Readonly<{
  context: string;
  ui: StartedUiWeb;
  baseUrl: string;
  exitObservation: UiWebExitObservation | null;
}>): Promise<Readonly<Record<string, unknown>>> {
  const wrapperPid = params.ui.proc?.child.pid ?? null;
  const port = Number.parseInt(new URL(params.baseUrl).port, 10);
  const leasePath = wrapperPid === null
    ? null
    : join(resolveUiWebMetroOwnershipLeasesDir(), `pid-${wrapperPid}.json`);
  const leaseRaw = leasePath === null ? null : await readFile(leasePath, 'utf8').catch(() => null);
  let statusProbe: Readonly<Record<string, unknown>>;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(new URL('/status', params.baseUrl), { signal: controller.signal });
    statusProbe = {
      ok: response.ok,
      status: response.status,
      body: (await response.text()).slice(0, 200),
    };
  } catch (error) {
    statusProbe = { ok: false, error: String(error) };
  } finally {
    clearTimeout(timeout);
  }

  return {
    atMs: Date.now(),
    context: params.context,
    baseUrl: params.baseUrl,
    wrapperPid,
    wrapperExitCode: params.ui.proc?.child.exitCode ?? null,
    wrapperSignalCode: params.ui.proc?.child.signalCode ?? null,
    wrapperInspection: wrapperPid === null ? null : inspectOwnedProcess(wrapperPid),
    exitObservation: params.exitObservation,
    descendantPids: wrapperPid === null ? [] : collectDescendantPids(wrapperPid),
    listenerPids: Number.isInteger(port) && port > 0 ? await readListenerPids(port) : null,
    leasePath,
    leaseRaw,
    statusProbe,
  };
}

async function startBrowserMemorySampler(page: Page, daemonPid: number): Promise<Readonly<{
  browserVersion: string;
  baseline: BrowserMemorySample;
  stop: () => Promise<Readonly<{
    samples: readonly BrowserMemorySample[];
    maxJsHeapUsedBytes: number;
    maxBrowserProcessTreeRssBytes: number | null;
    maxDaemonRssBytes: number | null;
    settledAfterGc: BrowserMemorySample;
  }>>;
}>> {
  const browser = page.context().browser();
  if (!browser) throw new Error('Browser process unavailable for transfer memory measurement');
  const rendererSession = await page.context().newCDPSession(page);
  const browserSession = await browser.newBrowserCDPSession();
  await rendererSession.send('Performance.enable');
  await rendererSession.send('HeapProfiler.collectGarbage');
  const version = await browserSession.send('Browser.getVersion');

  const samples: BrowserMemorySample[] = [];
  const capture = async (): Promise<BrowserMemorySample> => {
    const [metrics, processInfo] = await Promise.all([
      rendererSession.send('Performance.getMetrics'),
      browserSession.send('SystemInfo.getProcessInfo'),
    ]);
    const jsHeapUsedBytes = metrics.metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value;
    if (typeof jsHeapUsedBytes !== 'number') {
      throw new Error('Chromium did not expose JSHeapUsedSize');
    }
    const processIds = processInfo.processInfo
      .map((entry) => Number(entry.id))
      .filter((id) => Number.isInteger(id) && id > 0);
    const [browserProcessTreeRssBytes, daemonRssBytes] = await Promise.all([
      readProcessTreeRssBytes(processIds),
      readProcessTreeRssBytes([daemonPid]),
    ]);
    const sample = {
      atMs: Date.now(),
      jsHeapUsedBytes,
      browserProcessTreeRssBytes,
      daemonRssBytes,
    };
    samples.push(sample);
    return sample;
  };

  const baseline = await capture();
  let captureInFlight = false;
  const timer = setInterval(() => {
    if (captureInFlight) return;
    captureInFlight = true;
    void capture()
      .catch(() => undefined)
      .finally(() => {
        captureInFlight = false;
      });
  }, 100);

  return {
    browserVersion: version.product,
    baseline,
    stop: async () => {
      clearInterval(timer);
      while (captureInFlight) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      await capture();
      await rendererSession.send('HeapProfiler.collectGarbage');
      const settledAfterGc = await capture();
      await rendererSession.detach();
      await browserSession.detach();
      const rssSamples = samples
        .map((sample) => sample.browserProcessTreeRssBytes)
        .filter((value): value is number => typeof value === 'number');
      const daemonRssSamples = samples
        .map((sample) => sample.daemonRssBytes)
        .filter((value): value is number => typeof value === 'number');
      return {
        samples,
        maxJsHeapUsedBytes: Math.max(...samples.map((sample) => sample.jsHeapUsedBytes)),
        maxBrowserProcessTreeRssBytes: rssSamples.length > 0 ? Math.max(...rssSamples) : null,
        maxDaemonRssBytes: daemonRssSamples.length > 0 ? Math.max(...daemonRssSamples) : null,
        settledAfterGc,
      };
    },
  };
}

type DirectPeerOpenRequest = Readonly<{
  url: string;
  authorizationHeader: string | null;
}>;

function hashAuthorizationHeader(value: string | null): string | null {
  return value ? createHash('sha256').update(value).digest('hex') : null;
}

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
        NODE_ENV: process.env.NODE_ENV ?? 'test',
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

  test('uploads file, renames, downloads, deletes, and downloads folder zip', async ({ page }, testInfo) => {
    test.setTimeout(720_000);
    if (!server || !ui || !uiBaseUrl) throw new Error('missing server/ui fixtures');
    const resolvedServer = server;
    const resolvedUi = ui;
    const resolvedUiBaseUrl = uiBaseUrl;
    const sameMachineNavigationTimeoutMs = 300_000;

    const browserDiagnostics = collectBrowserDiagnostics({ page });
    const directPeerOpenRequests = collectDirectPeerOpenRequests(page);
    const testDir = resolve(join(suiteDir, 't1-filemanager'));
    const testStartedAtMs = Date.now();

    let runDaemon: StartedDaemon | null = null;
    let largeExpectedSha256: string | null = null;
    let preRestartDaemonPid: number | null = null;
    let postRestartDaemonPid: number | null = null;
    let postRestartDownloadObservation: Readonly<Record<string, unknown>> = {
      stage: 'not_started',
    };
    const transferPhaseTimeline: Array<Readonly<Record<string, unknown>>> = [];
    let restartReached = false;
    const recordTransferPhase = (
      stage: string,
      details?: Readonly<Record<string, unknown>>,
    ): void => {
      const atMs = Date.now();
      transferPhaseTimeline.push({
        stage,
        atMs,
        elapsedMs: atMs - testStartedAtMs,
        preRestartDaemonPid,
        postRestartDaemonPid,
        directPeerOpenRequestCount: directPeerOpenRequests.length,
        ...details,
      });
    };
    recordTransferPhase('transfer_test_initialized', {
      configuredTestTimeoutMs: testInfo.timeout,
    });
    const uiWebProcessDiagnostics: Readonly<Record<string, unknown>>[] = [];
    let uiWebExitObservation: UiWebExitObservation | null = resolvedUi.proc
      && (resolvedUi.proc.child.exitCode !== null || resolvedUi.proc.child.signalCode !== null)
      ? {
          atMs: Date.now(),
          exitCode: resolvedUi.proc.child.exitCode,
          signal: resolvedUi.proc.child.signalCode as NodeJS.Signals | null,
        }
      : null;
    resolvedUi.proc?.child.once('exit', (exitCode, signal) => {
      uiWebExitObservation = { atMs: Date.now(), exitCode, signal };
    });
    const recordUiWebProcessDiagnostic = async (context: string): Promise<void> => {
      uiWebProcessDiagnostics.push(await collectUiWebProcessDiagnostic({
        context,
        ui: resolvedUi,
        baseUrl: resolvedUiBaseUrl,
        exitObservation: uiWebExitObservation,
      }));
    };
    try {
      await test.step('reach authenticated home UI', async () => {
        await page.setViewportSize({ width: 1440, height: 900 });
        await recordUiWebProcessDiagnostic('before-initial-navigation');
        await gotoDomContentLoadedWithRetries(page, resolvedUiBaseUrl, sameMachineNavigationTimeoutMs);

        await waitForInitialAppUi({ page, browserDiagnostics });
        await maybeDismissDetectedClisModal(page, 1_000).catch(() => {});
        await maybeDismissAgentPickerPopover(page).catch(() => {});
        await createAccountAndReachConnectMachineState({
          page,
          useFirstCreateButton: true,
          // The terminal-connect flow below is the authoritative auth check for this scenario.
          requirePersistedAuthCredentials: false,
        });
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
        await recordUiWebProcessDiagnostic('before-terminal-connect-navigation');
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
        preRestartDaemonPid = runDaemon.state.pid;

        const workspaceDir = resolve(join(testDir, 'workspace'));
        const downloadFolder = resolve(join(workspaceDir, 'download-me'));
        await mkdir(resolve(join(downloadFolder, 'nested')), { recursive: true });
        await writeFile(resolve(join(downloadFolder, 'nested', 'hello.txt')), 'hello zip\n', 'utf8');

        const uploadSourcePath = resolve(join(testDir, 'upload-source.txt'));
        await writeFile(uploadSourcePath, 'hello upload\n', 'utf8');
        largeExpectedSha256 = await createDeterministicLargeFile(
          resolve(join(workspaceDir, 'large-opfs.bin')),
          LARGE_BROWSER_DOWNLOAD_BYTES,
        );

        sessionId = await spawnSessionFromDaemon({ daemon: runDaemon, directory: workspaceDir });
        await recordUiWebProcessDiagnostic('before-initial-session-navigation');
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
        const filesSurface = await activateFilesSurface(page, 180_000);
        try {
          await expectFilesToolbarPrimaryOrOverflowAction(filesSurface, 'repository-tree-upload', 180_000);
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
          const uploadInput = filesSurface.getByTestId('repository-tree-upload-input-files');
          await expect(uploadInput).toHaveCount(1, { timeout: 60_000 });
          recordTransferPhase('upload_input_set_pending');
          await uploadInput.setInputFiles(uploadSourcePath);
          recordTransferPhase('upload_input_set');
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
          recordTransferPhase('pre_restart_uploaded_file_poll_pending');
          await expect
            .poll(async () => await readFile(workspaceUploadedPath, 'utf8').catch(() => null), { timeout: 120_000 })
            .toBe('hello upload\n');
          recordTransferPhase('pre_restart_uploaded_file_observed');

          const preRestartOpenRequestIndex = directPeerOpenRequests.length;
          const preRestartFilesSurface = await activateFilesSurface(page, 120_000);
          recordTransferPhase('pre_restart_menu_and_download_pending', { preRestartOpenRequestIndex });
          const [preRestartDownload] = await Promise.all([
            page.waitForEvent('download', { timeout: 60_000 }).then((download) => {
              recordTransferPhase('pre_restart_browser_download_event');
              return download;
            }),
            openRepositoryTreeRowMenuAndSelectItem({
              page,
              scope: preRestartFilesSurface,
              path: uploadedPath,
              itemId: 'repository-tree-menuitem-download',
            }).then(() => {
              recordTransferPhase('pre_restart_menu_selection_resolved');
            }),
          ]);
          recordTransferPhase('pre_restart_menu_and_download_resolved');
          const preRestartDownloadPath = await preRestartDownload.path();
          recordTransferPhase('pre_restart_download_path_resolved', {
            downloadPathPresent: preRestartDownloadPath !== null,
          });
          expect(preRestartDownloadPath).not.toBeNull();
          if (preRestartDownloadPath) {
            recordTransferPhase('pre_restart_download_content_poll_pending');
            await expect
              .poll(async () => await readFile(preRestartDownloadPath, 'utf8').catch(() => null), { timeout: 120_000 })
              .toBe('hello upload\n');
            recordTransferPhase('pre_restart_download_content_verified');
          }
          recordTransferPhase('pre_restart_direct_peer_request_count_pending');
          await expect
            .poll(() => directPeerOpenRequests.length, { timeout: 60_000 })
            .toBeGreaterThanOrEqual(1);
          recordTransferPhase('pre_restart_direct_peer_request_count_observed');
          preRestartDirectPeerOpenRequest = await waitForDirectPeerOpenRequest({
            requests: directPeerOpenRequests,
            requestIndex: preRestartOpenRequestIndex,
            timeoutMs: 120_000,
          });
          recordTransferPhase('pre_restart_direct_peer_request_captured', {
            requestCaptured: preRestartDirectPeerOpenRequest !== null,
          });

          const currentRunDaemon: StartedDaemon | null = runDaemon;
          if (!currentRunDaemon) {
            throw new Error('missing daemon before restart');
          }
          restartReached = true;
          recordTransferPhase('daemon_restart_reached');
          recordTransferPhase('pre_restart_daemon_stop_pending');
          await currentRunDaemon.stop();
          daemon = null;
          recordTransferPhase('pre_restart_daemon_stopped');

          recordTransferPhase('post_restart_daemon_start_pending');
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
          postRestartDaemonPid = runDaemon.state.pid;
          recordTransferPhase('post_restart_daemon_started');

          if (!sessionId) {
            throw new Error('session id missing before post-restart reload');
          }
          const sessionUrl = `${resolvedUiBaseUrl}/session/${sessionId}?right=files`;
          await recordUiWebProcessDiagnostic('before-post-restart-session-navigation');
          await gotoDomContentLoadedWithRetries(page, sessionUrl);
          const refreshedFilesSurface = await activateFilesSurface(page, 180_000);
          await expect(repositoryTreeRowLocator(refreshedFilesSurface, uploadedPath)).toHaveCount(1, { timeout: 120_000 });
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

        const filesSurface = activeFilesSurfaceLocator(page);

        const postRestartOpenRequestIndex = directPeerOpenRequests.length;
        postRestartDownloadObservation = {
          stage: 'menu_selection_pending',
          atMs: Date.now(),
          directPeerOpenRequestCount: directPeerOpenRequests.length,
        };
        const [postRestartDownload] = await Promise.all([
          page.waitForEvent('download', { timeout: 60_000 }),
          openRepositoryTreeRowMenuAndSelectItem({
            page,
            scope: filesSurface,
            path: uploadedPath,
            itemId: 'repository-tree-menuitem-download',
          }).then(async () => {
            postRestartDownloadObservation = {
              stage: 'menu_selection_resolved',
              atMs: Date.now(),
              directPeerOpenRequestCount: directPeerOpenRequests.length,
              transferStatusVisible: await filesSurface.getByTestId('repository-tree-transfer-status').count(),
              downloadStatusVisible: await filesSurface.getByTestId('repository-tree-download-status').count(),
            };
          }),
        ]);
        postRestartDownloadObservation = {
          ...postRestartDownloadObservation,
          stage: 'browser_download_event',
          downloadEventAtMs: Date.now(),
          directPeerOpenRequestCount: directPeerOpenRequests.length,
        };
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
        expect(preRestartDaemonPid).not.toBeNull();
        expect(postRestartDaemonPid).not.toBeNull();
        expect(postRestartDaemonPid).not.toBe(preRestartDaemonPid);
        expect(postRestartDirectPeerOpenRequest.url).not.toBe(preRestartDirectPeerOpenRequest.url);
        expect(postRestartDirectPeerOpenRequest.authorizationHeader).not.toBe(preRestartDirectPeerOpenRequest.authorizationHeader);

        const staleEndpointResult = await page.evaluate(async (request) => {
          try {
            const response = await fetch(request.url, {
              method: 'POST',
              headers: request.authorizationHeader
                ? {
                    authorization: request.authorizationHeader,
                    'x-happier-transfer-recipient-public-key': request.recipientPublicKeyBase64,
                  }
                : { 'x-happier-transfer-recipient-public-key': request.recipientPublicKeyBase64 },
            });
            return { reachable: true, ok: response.ok, status: response.status };
          } catch (error) {
            return { reachable: false, ok: false, status: null, error: String(error) };
          }
        }, {
          ...preRestartDirectPeerOpenRequest!,
          // Same schema-valid 32-byte public-key shape used by the transfer crypto owner tests.
          recipientPublicKeyBase64: Buffer.alloc(32, 7).toString('base64'),
        });
        expect(staleEndpointResult.ok).toBe(false);

        const largePath = 'large-opfs.bin';
        await expect(repositoryTreeRowLocator(filesSurface, largePath)).toHaveCount(1, { timeout: 120_000 });
        if (postRestartDaemonPid === null) {
          throw new Error('Missing post-restart daemon pid for transfer memory measurement');
        }

        const noTransferWarmupSampler = await startBrowserMemorySampler(page, postRestartDaemonPid);
        await page.waitForTimeout(10_000);
        const noTransferWarmupMemoryResult = await noTransferWarmupSampler.stop();

        let observedSuccessfulOpfsBytes = 0;
        await page.route('**/machine-transfers/direct/**/chunks/**', async (route) => {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
          await route.continue();
        });
        const firstDownloadMemorySampler = await startBrowserMemorySampler(page, postRestartDaemonPid);
        let firstDownloadMemoryResult: Awaited<ReturnType<typeof firstDownloadMemorySampler.stop>> | null = null;
        let largeDownloadPath: string | null = null;
        try {
          const largeDownloadEvent = page.waitForEvent('download', { timeout: 180_000 });
          await openRepositoryTreeRowMenuAndSelectItem({
            page,
            scope: filesSurface,
            path: largePath,
            itemId: 'repository-tree-menuitem-download',
            timeoutMs: 120_000,
          });
          await expect(filesSurface.getByTestId('repository-tree-download-status')).toHaveCount(1, { timeout: 60_000 });
          await expect
            .poll(async () => {
              const partials = await readOpfsPartialDownloads(page);
              observedSuccessfulOpfsBytes = Math.max(
                observedSuccessfulOpfsBytes,
                ...partials.map((partial) => partial.sizeBytes),
              );
              return observedSuccessfulOpfsBytes;
            }, { timeout: 120_000 })
            .toBeGreaterThan(0);
          const largeDownload = await largeDownloadEvent;
          largeDownloadPath = await largeDownload.path();
          expect(largeDownloadPath).not.toBeNull();
        } finally {
          firstDownloadMemoryResult = await firstDownloadMemorySampler.stop();
          await page.unroute('**/machine-transfers/direct/**/chunks/**');
        }

        if (!largeDownloadPath || !largeExpectedSha256 || !firstDownloadMemoryResult) {
          throw new Error('Missing large browser download evidence');
        }
        expect((await stat(largeDownloadPath)).size).toBe(LARGE_BROWSER_DOWNLOAD_BYTES);
        expect(await hashFileSha256(largeDownloadPath)).toBe(largeExpectedSha256);
        expect(observedSuccessfulOpfsBytes).toBeGreaterThan(0);
        await expect.poll(async () => (await readOpfsPartialDownloads(page)).length, { timeout: 30_000 }).toBe(0);

        const firstDownloadJsHeapGrowthBytes = firstDownloadMemoryResult.maxJsHeapUsedBytes
          - firstDownloadMemorySampler.baseline.jsHeapUsedBytes;
        const firstDownloadBrowserProcessTreeRssGrowthBytes = firstDownloadMemorySampler.baseline.browserProcessTreeRssBytes !== null
          && firstDownloadMemoryResult.maxBrowserProcessTreeRssBytes !== null
          ? firstDownloadMemoryResult.maxBrowserProcessTreeRssBytes
            - firstDownloadMemorySampler.baseline.browserProcessTreeRssBytes
          : null;
        const firstDownloadDaemonRssGrowthBytes = firstDownloadMemorySampler.baseline.daemonRssBytes !== null
          && firstDownloadMemoryResult.maxDaemonRssBytes !== null
          ? firstDownloadMemoryResult.maxDaemonRssBytes - firstDownloadMemorySampler.baseline.daemonRssBytes
          : null;

        let canceledDownloadEvents = 0;
        const onCanceledDownload = () => {
          canceledDownloadEvents += 1;
        };
        page.on('download', onCanceledDownload);
        const canceledDownloadChunkGate = createDirectTransferCancellationChunkGate();
        await page.route('**/machine-transfers/direct/**/chunks/**', async (route) => {
          await canceledDownloadChunkGate.handleRoute(route);
        });
        let observedCanceledOpfsPartialCount = 0;
        try {
          recordTransferPhase('cancellation_download_pending');
          await openRepositoryTreeRowMenuAndSelectItem({
            page,
            scope: filesSurface,
            path: largePath,
            itemId: 'repository-tree-menuitem-download',
            timeoutMs: 120_000,
          });
          await expect(filesSurface.getByTestId('repository-tree-download-cancel')).toHaveCount(1, { timeout: 60_000 });
          // Direct downloads consume chunks sequentially. Seeing the second chunk request held
          // proves that the first response was decrypted and written to the destination. OPFS
          // writable streams do not expose the committed File.size until close, so polling for
          // non-zero bytes here would wait through the direct-request timeout and exercise relay
          // fallback instead of the live cancellation path.
          await canceledDownloadChunkGate.waitForLaterChunkHeld();
          const canceledOpfsPartials = await readOpfsPartialDownloads(page);
          observedCanceledOpfsPartialCount = canceledOpfsPartials.length;
          expect(observedCanceledOpfsPartialCount).toBeGreaterThan(0);
          recordTransferPhase('cancellation_partial_observed', {
            observedCanceledOpfsPartialCount,
            canceledDownloadChunkRequestCount: canceledDownloadChunkGate.requestCount,
          });
          await filesSurface.getByTestId('repository-tree-download-cancel').click();
          recordTransferPhase('cancellation_clicked', {
            canceledDownloadChunkRequestCount: canceledDownloadChunkGate.requestCount,
          });
          canceledDownloadChunkGate.releaseAfterCancellation();
          await expect(filesSurface.getByTestId('repository-tree-download-status')).toHaveCount(0, { timeout: 60_000 });
          await expect.poll(async () => (await readOpfsPartialDownloads(page)).length, { timeout: 30_000 }).toBe(0);
          await page.waitForTimeout(1_500);
          expect(canceledDownloadEvents).toBe(0);
          recordTransferPhase('cancellation_verified', {
            observedCanceledOpfsPartialCount,
            canceledDownloadEvents,
          });
        } finally {
          canceledDownloadChunkGate.releaseAfterCancellation();
          page.off('download', onCanceledDownload);
          await page.unroute('**/machine-transfers/direct/**/chunks/**');
        }

        let observedSecondSuccessfulOpfsBytes = 0;
        await page.route('**/machine-transfers/direct/**/chunks/**', async (route) => {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
          await route.continue();
        });
        const secondDownloadMemorySampler = await startBrowserMemorySampler(page, postRestartDaemonPid);
        let secondDownloadMemoryResult: Awaited<ReturnType<typeof secondDownloadMemorySampler.stop>> | null = null;
        let secondLargeDownloadPath: string | null = null;
        try {
          const secondLargeDownloadEvent = page.waitForEvent('download', { timeout: 180_000 });
          await openRepositoryTreeRowMenuAndSelectItem({
            page,
            scope: filesSurface,
            path: largePath,
            itemId: 'repository-tree-menuitem-download',
            timeoutMs: 120_000,
          });
          await expect(filesSurface.getByTestId('repository-tree-download-status')).toHaveCount(1, { timeout: 60_000 });
          await expect
            .poll(async () => {
              const partials = await readOpfsPartialDownloads(page);
              observedSecondSuccessfulOpfsBytes = Math.max(
                observedSecondSuccessfulOpfsBytes,
                ...partials.map((partial) => partial.sizeBytes),
              );
              return observedSecondSuccessfulOpfsBytes;
            }, { timeout: 120_000 })
            .toBeGreaterThan(0);
          const secondLargeDownload = await secondLargeDownloadEvent;
          secondLargeDownloadPath = await secondLargeDownload.path();
          expect(secondLargeDownloadPath).not.toBeNull();
        } finally {
          secondDownloadMemoryResult = await secondDownloadMemorySampler.stop();
          await page.unroute('**/machine-transfers/direct/**/chunks/**');
        }

        if (!secondLargeDownloadPath || !secondDownloadMemoryResult) {
          throw new Error('Missing second large browser download evidence');
        }
        expect((await stat(secondLargeDownloadPath)).size).toBe(LARGE_BROWSER_DOWNLOAD_BYTES);
        expect(await hashFileSha256(secondLargeDownloadPath)).toBe(largeExpectedSha256);
        expect(observedSecondSuccessfulOpfsBytes).toBeGreaterThan(0);
        await expect.poll(async () => (await readOpfsPartialDownloads(page)).length, { timeout: 30_000 }).toBe(0);

        const secondDownloadJsHeapGrowthBytes = secondDownloadMemoryResult.maxJsHeapUsedBytes
          - secondDownloadMemorySampler.baseline.jsHeapUsedBytes;
        const secondDownloadBrowserProcessTreeRssGrowthBytes = secondDownloadMemorySampler.baseline.browserProcessTreeRssBytes !== null
          && secondDownloadMemoryResult.maxBrowserProcessTreeRssBytes !== null
          ? secondDownloadMemoryResult.maxBrowserProcessTreeRssBytes
            - secondDownloadMemorySampler.baseline.browserProcessTreeRssBytes
          : null;
        const secondDownloadDaemonRssGrowthBytes = secondDownloadMemorySampler.baseline.daemonRssBytes !== null
          && secondDownloadMemoryResult.maxDaemonRssBytes !== null
          ? secondDownloadMemoryResult.maxDaemonRssBytes - secondDownloadMemorySampler.baseline.daemonRssBytes
          : null;
        const noTransferWarmupJsHeapGrowthBytes = noTransferWarmupMemoryResult.maxJsHeapUsedBytes
          - noTransferWarmupSampler.baseline.jsHeapUsedBytes;
        const noTransferWarmupBrowserProcessTreeRssGrowthBytes = noTransferWarmupSampler.baseline.browserProcessTreeRssBytes !== null
          && noTransferWarmupMemoryResult.maxBrowserProcessTreeRssBytes !== null
          ? noTransferWarmupMemoryResult.maxBrowserProcessTreeRssBytes
            - noTransferWarmupSampler.baseline.browserProcessTreeRssBytes
          : null;
        const noTransferWarmupDaemonRssGrowthBytes = noTransferWarmupSampler.baseline.daemonRssBytes !== null
          && noTransferWarmupMemoryResult.maxDaemonRssBytes !== null
          ? noTransferWarmupMemoryResult.maxDaemonRssBytes - noTransferWarmupSampler.baseline.daemonRssBytes
          : null;
        const memoryContractViolations = evaluateBrowserTransferMemoryContract({
          control: {
            baseline: noTransferWarmupSampler.baseline,
            ...noTransferWarmupMemoryResult,
          },
          firstDownload: {
            baseline: firstDownloadMemorySampler.baseline,
            ...firstDownloadMemoryResult,
          },
          secondDownload: {
            baseline: secondDownloadMemorySampler.baseline,
            ...secondDownloadMemoryResult,
          },
          maxRetainedJsHeapGrowthBytes: MAX_BROWSER_JS_HEAP_GROWTH_BYTES,
          maxBrowserProcessTreeRssGrowthBytes: MAX_BROWSER_PROCESS_TREE_RSS_GROWTH_BYTES,
          maxDaemonRssGrowthBytes: MAX_DAEMON_RSS_GROWTH_BYTES,
        });

        postRestartDownloadObservation = {
          ...postRestartDownloadObservation,
          memorySummary: {
            noTransferWarmup: {
              baseline: noTransferWarmupSampler.baseline,
              maxJsHeapUsedBytes: noTransferWarmupMemoryResult.maxJsHeapUsedBytes,
              jsHeapGrowthBytes: noTransferWarmupJsHeapGrowthBytes,
              maxBrowserProcessTreeRssBytes: noTransferWarmupMemoryResult.maxBrowserProcessTreeRssBytes,
              browserProcessTreeRssGrowthBytes: noTransferWarmupBrowserProcessTreeRssGrowthBytes,
              maxDaemonRssBytes: noTransferWarmupMemoryResult.maxDaemonRssBytes,
              daemonRssGrowthBytes: noTransferWarmupDaemonRssGrowthBytes,
              settledAfterGc: noTransferWarmupMemoryResult.settledAfterGc,
            },
            firstDownload: {
              baseline: firstDownloadMemorySampler.baseline,
              maxJsHeapUsedBytes: firstDownloadMemoryResult.maxJsHeapUsedBytes,
              jsHeapGrowthBytes: firstDownloadJsHeapGrowthBytes,
              maxBrowserProcessTreeRssBytes: firstDownloadMemoryResult.maxBrowserProcessTreeRssBytes,
              browserProcessTreeRssGrowthBytes: firstDownloadBrowserProcessTreeRssGrowthBytes,
              maxDaemonRssBytes: firstDownloadMemoryResult.maxDaemonRssBytes,
              daemonRssGrowthBytes: firstDownloadDaemonRssGrowthBytes,
              settledAfterGc: firstDownloadMemoryResult.settledAfterGc,
            },
            secondDownload: {
              baseline: secondDownloadMemorySampler.baseline,
              maxJsHeapUsedBytes: secondDownloadMemoryResult.maxJsHeapUsedBytes,
              jsHeapGrowthBytes: secondDownloadJsHeapGrowthBytes,
              maxBrowserProcessTreeRssBytes: secondDownloadMemoryResult.maxBrowserProcessTreeRssBytes,
              browserProcessTreeRssGrowthBytes: secondDownloadBrowserProcessTreeRssGrowthBytes,
              maxDaemonRssBytes: secondDownloadMemoryResult.maxDaemonRssBytes,
              daemonRssGrowthBytes: secondDownloadDaemonRssGrowthBytes,
              settledAfterGc: secondDownloadMemoryResult.settledAfterGc,
            },
            contractViolations: memoryContractViolations,
          },
        };

        await testInfo.attach('browser-transfer-live-evidence.json', {
          contentType: 'application/json',
          body: Buffer.from(JSON.stringify({
            runtime: {
              browserVersion: firstDownloadMemorySampler.browserVersion,
              serverPid: resolvedServer.proc.child.pid ?? null,
              uiPid: ui?.proc?.child.pid ?? null,
              preRestartDaemonPid,
              postRestartDaemonPid,
              uiBaseUrl: resolvedUiBaseUrl,
              serverBaseUrl: resolvedServer.baseUrl,
            },
            download: {
              fileName: largePath,
              sizeBytes: LARGE_BROWSER_DOWNLOAD_BYTES,
              sha256: largeExpectedSha256,
              firstOpfsPartialBytesObserved: observedSuccessfulOpfsBytes,
              secondOpfsPartialBytesObserved: observedSecondSuccessfulOpfsBytes,
            },
            memory: {
              methodology: 'A 10-second no-transfer control and two 40 MiB downloads are measured independently. Chromium CDP Performance.getMetrics JSHeapUsedSize is sampled every 100ms; Chromium SystemInfo process ids and the exact post-restart daemon pid are sampled with ps RSS. Raw JS peaks remain diagnostic because V8 collector timing makes them non-portable. The hard contract keeps the unchanged 20 MiB post-GC retained-JS budget, requires the repeated-download settled JS frontier not to accumulate, and applies the unchanged 128 MiB process-RSS budgets against the no-transfer control and repeated-download frontiers.',
              jsHeapGrowthBoundBytes: MAX_BROWSER_JS_HEAP_GROWTH_BYTES,
              browserProcessTreeRssGrowthBoundBytes: MAX_BROWSER_PROCESS_TREE_RSS_GROWTH_BYTES,
              daemonRssGrowthBoundBytes: MAX_DAEMON_RSS_GROWTH_BYTES,
              contractViolations: memoryContractViolations,
              noTransferWarmup: {
                baseline: noTransferWarmupSampler.baseline,
                maxJsHeapUsedBytes: noTransferWarmupMemoryResult.maxJsHeapUsedBytes,
                jsHeapGrowthBytes: noTransferWarmupJsHeapGrowthBytes,
                maxBrowserProcessTreeRssBytes: noTransferWarmupMemoryResult.maxBrowserProcessTreeRssBytes,
                browserProcessTreeRssGrowthBytes: noTransferWarmupBrowserProcessTreeRssGrowthBytes,
                maxDaemonRssBytes: noTransferWarmupMemoryResult.maxDaemonRssBytes,
                daemonRssGrowthBytes: noTransferWarmupDaemonRssGrowthBytes,
                settledAfterGc: noTransferWarmupMemoryResult.settledAfterGc,
                samples: noTransferWarmupMemoryResult.samples,
              },
              firstDownload: {
                baseline: firstDownloadMemorySampler.baseline,
                maxJsHeapUsedBytes: firstDownloadMemoryResult.maxJsHeapUsedBytes,
                jsHeapGrowthBytes: firstDownloadJsHeapGrowthBytes,
                maxBrowserProcessTreeRssBytes: firstDownloadMemoryResult.maxBrowserProcessTreeRssBytes,
                browserProcessTreeRssGrowthBytes: firstDownloadBrowserProcessTreeRssGrowthBytes,
                maxDaemonRssBytes: firstDownloadMemoryResult.maxDaemonRssBytes,
                daemonRssGrowthBytes: firstDownloadDaemonRssGrowthBytes,
                settledAfterGc: firstDownloadMemoryResult.settledAfterGc,
                samples: firstDownloadMemoryResult.samples,
              },
              secondDownload: {
                baseline: secondDownloadMemorySampler.baseline,
                maxJsHeapUsedBytes: secondDownloadMemoryResult.maxJsHeapUsedBytes,
                jsHeapGrowthBytes: secondDownloadJsHeapGrowthBytes,
                maxBrowserProcessTreeRssBytes: secondDownloadMemoryResult.maxBrowserProcessTreeRssBytes,
                browserProcessTreeRssGrowthBytes: secondDownloadBrowserProcessTreeRssGrowthBytes,
                maxDaemonRssBytes: secondDownloadMemoryResult.maxDaemonRssBytes,
                daemonRssGrowthBytes: secondDownloadDaemonRssGrowthBytes,
                settledAfterGc: secondDownloadMemoryResult.settledAfterGc,
                samples: secondDownloadMemoryResult.samples,
              },
            },
            cancellation: {
              opfsPartialEntryCountObserved: observedCanceledOpfsPartialCount,
              completedChunkCountBeforeCancellation: 1,
              remainingOpfsPartialCount: (await readOpfsPartialDownloads(page)).length,
              browserDownloadEvents: canceledDownloadEvents,
            },
            restart: {
              staleEndpointResult,
              preRestart: {
                url: preRestartDirectPeerOpenRequest!.url,
                authorizationSha256: hashAuthorizationHeader(preRestartDirectPeerOpenRequest!.authorizationHeader),
              },
              postRestart: {
                url: postRestartDirectPeerOpenRequest.url,
                authorizationSha256: hashAuthorizationHeader(postRestartDirectPeerOpenRequest.authorizationHeader),
              },
            },
          }, null, 2)),
        });

        expect(memoryContractViolations).toEqual([]);

        // Rename uploaded file.
        await openRepositoryTreeRowMenuAndSelectItem({
          page,
          scope: filesSurface,
          path: uploadedPath,
          itemId: 'repository-tree-menuitem-rename',
        });
        const prompt = page.getByPlaceholder(uploadedPath);
        await expect(prompt).toHaveCount(1, { timeout: 60_000 });
        const renamedPath = 'renamed.txt';
        await prompt.fill(renamedPath);
        await prompt.press('Enter');

        await expect(repositoryTreeRowLocator(filesSurface, uploadedPath)).toHaveCount(0, { timeout: 120_000 });
        await expect(repositoryTreeRowLocator(filesSurface, renamedPath)).toHaveCount(1, { timeout: 120_000 });

        // Download renamed file.
        const [fileDownload] = await Promise.all([
          page.waitForEvent('download', { timeout: 60_000 }),
          openRepositoryTreeRowMenuAndSelectItem({
            page,
            scope: filesSurface,
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
          scope: filesSurface,
          path: renamedPath,
          itemId: 'repository-tree-menuitem-delete',
        });
        await expect(page.getByTestId('web-modal-confirm')).toHaveCount(1, { timeout: 60_000 });
        await page.getByTestId('web-modal-confirm').click({ force: true, timeout: 60_000 });
        await expect(repositoryTreeRowLocator(filesSurface, renamedPath)).toHaveCount(0, { timeout: 120_000 });

        // Download folder as zip.
        const folderPath = 'download-me';
        await expect(repositoryTreeRowLocator(filesSurface, folderPath)).toHaveCount(1, { timeout: 120_000 });
        const [zipDownload] = await Promise.all([
          page.waitForEvent('download', { timeout: 120_000 }),
          openRepositoryTreeRowMenuAndSelectItem({
            page,
            scope: filesSurface,
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
      await recordUiWebProcessDiagnostic('failure-catch').catch(() => {});
      const failureDomObservation = await page.evaluate(() => ({
        atMs: Date.now(),
        href: window.location.href,
        readyState: document.readyState,
        bodyText: (document.body?.innerText ?? '').slice(0, 8_000),
        visibleDownloadMenuItems: Array.from(document.querySelectorAll(
          '[data-testid="repository-tree-menuitem-download"], [data-testid="dropdown-option-repository-tree-menuitem-download"]',
        )).filter((element) => {
          const style = window.getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
        }).length,
        transferStatusCount: document.querySelectorAll('[data-testid="repository-tree-transfer-status"]').length,
        downloadStatusCount: document.querySelectorAll('[data-testid="repository-tree-download-status"]').length,
      })).catch(() => null);
      const persistedDiagnosticsPath = resolve(join(testDir, 'g7-transfer-failure-diagnostics.json'));
      await mkdir(testDir, { recursive: true }).catch(() => {});
      await writeFile(
        persistedDiagnosticsPath,
        JSON.stringify({
          error: String(error),
          timing: {
            testStartedAtMs,
            failedAtMs: Date.now(),
            elapsedMs: Date.now() - testStartedAtMs,
            configuredTestTimeoutMs: testInfo.timeout,
          },
          restartReached,
          preRestartDaemonPid,
          postRestartDaemonPid,
          transferPhaseTimeline,
          postRestartDownloadObservation,
          failureDomObservation,
          directPeerOpenRequests: directPeerOpenRequests.map((request) => ({
            url: request.url,
            authorizationSha256: hashAuthorizationHeader(request.authorizationHeader),
          })),
          uiWebProcessDiagnostics,
        }, null, 2),
        'utf8',
      ).catch(() => {});
      await writeFile(
        resolve(join(testDir, 'g7-browser-failure-diagnostics.md')),
        browserDiagnostics(),
        'utf8',
      ).catch(() => {});
      await testInfo.attach('g7-transfer-failure-diagnostics.json', {
        contentType: 'application/json',
        path: persistedDiagnosticsPath,
      }).catch(() => {});
      throw new Error(`${String(error)}\n\n${browserDiagnostics()}`);
    } finally {
      const activeRunDaemon: StartedDaemon | null = runDaemon;
      if (activeRunDaemon) {
        await (activeRunDaemon as StartedDaemon).stop().catch(() => {});
      }
    }
  });
});
