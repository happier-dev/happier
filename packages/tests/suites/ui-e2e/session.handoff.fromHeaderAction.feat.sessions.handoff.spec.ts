import { test, expect, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { fakeClaudeFixturePath, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';
import { readCliAccessKey } from '../../src/testkit/cliAccessKey';
import { fetchJson } from '../../src/testkit/http';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { acknowledgeTerminalConnectSuccessIfPresent } from '../../src/testkit/uiE2e/acknowledgeTerminalConnectSuccessIfPresent';
import { approveTerminalConnect } from '../../src/testkit/uiE2e/approveTerminalConnect';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import {
  createSessionFromNewSessionComposer,
  reloadCreatedSessionFromNewSessionComposer,
} from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
import {
  createAccountAndReachConnectMachineState,
  gotoDomContentLoadedWithRetries,
  normalizeLoopbackBaseUrl,
  waitForAuthenticatedHomeUi,
} from '../../src/testkit/uiE2e/pageNavigation';
import { readLegacyAuthSecretFromLocalStorage } from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';
import { resolveTerminalConnectUrlForBrowser } from '../../src/testkit/uiE2e/resolveTerminalConnectUrlForBrowser';
import { ensurePendingTerminalConnectReadyForApproval } from '../../src/testkit/uiE2e/terminalConnectApprovalFlow';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';

const run = createRunDirs({ runLabel: 'ui-e2e' });
const uiWebExportTimeoutMs = process.env.HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS ?? '900000';

async function readMachineIdsFromServer(params: { cliHomeDir: string; serverBaseUrl: string }): Promise<string[]> {
  const accessKey = await readCliAccessKey(params.cliHomeDir);
  if (!accessKey?.token) return [];
  try {
    const res = await fetchJson<Array<{ id?: unknown }>>(`${params.serverBaseUrl}/v1/machines`, {
      headers: {
        Authorization: `Bearer ${accessKey.token}`,
      },
      timeoutMs: 5_000,
    });
    if (res.status !== 200 || !Array.isArray(res.data)) return [];
    return res.data
      .map((entry) => (typeof entry?.id === 'string' ? entry.id.trim() : ''))
      .filter((value) => value.length > 0);
  } catch {
    return [];
  }
}

async function waitForMachineIds(params: { cliHomeDir: string; serverBaseUrl: string; count: number; timeoutMs?: number }): Promise<string[]> {
  const timeoutMs = params.timeoutMs ?? 120_000;
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const ids = await readMachineIdsFromServer({
      cliHomeDir: params.cliHomeDir,
      serverBaseUrl: params.serverBaseUrl,
    });
    if (ids.length >= params.count) {
      return ids;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  return await readMachineIdsFromServer({
    cliHomeDir: params.cliHomeDir,
    serverBaseUrl: params.serverBaseUrl,
  });
}

async function waitForSessionInfoMachineTarget(params: {
  page: Page;
  uiBaseUrl: string;
  serverBaseUrl: string;
  cliHomeDir: string;
  sessionId: string;
  expectedMachineId: string;
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 180_000;
  const startedAt = Date.now();
  let lastUrl = params.page.url();
  let lastServerMachineId = '';
  let lastServerPath = '';
  let lastServerHomeDir = '';

  await expect(params.page.getByTestId('session-handoff-modal')).toHaveCount(0, { timeout: 60_000 });
  const progressModal = params.page.getByTestId('session-handoff-progress-modal');
  if (await progressModal.count()) {
    await expect(progressModal).toHaveCount(0, { timeout: timeoutMs });
  }

  const accessKey = await readCliAccessKey(params.cliHomeDir);
  if (!accessKey?.token) {
    throw new Error(`Timed out waiting for session ${params.sessionId} to point at machine ${params.expectedMachineId} (missing cli access token)`);
  }

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetchJson<any>(`${params.serverBaseUrl}/v2/sessions/${params.sessionId}`, {
        headers: {
          Authorization: `Bearer ${accessKey.token}`,
        },
        timeoutMs: 5_000,
      });
      const metadata = res.status === 200 && res.data && typeof res.data === 'object' ? (res.data as any).session?.metadata : null;
      lastServerMachineId = typeof metadata?.machineId === 'string' ? metadata.machineId.trim() : '';
      lastServerPath = typeof metadata?.path === 'string' ? metadata.path.trim() : '';
      lastServerHomeDir = typeof metadata?.homeDir === 'string' ? metadata.homeDir.trim() : '';
      const machineOk = lastServerMachineId === params.expectedMachineId;
      const pathOk = lastServerPath.length > 0 && (!lastServerHomeDir || lastServerPath !== lastServerHomeDir);
      if (machineOk && pathOk) {
        await params.page.goto(`${params.uiBaseUrl}/session/${params.sessionId}/info`, { waitUntil: 'domcontentloaded' });
        await expect(params.page.getByTestId('session-info-screen')).toHaveCount(1, { timeout: 60_000 });
        return;
      }
    } catch {
      // ignore and retry
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }

  throw new Error(
    `Timed out waiting for session ${params.sessionId} to point at machine ${params.expectedMachineId} (lastUrl=${lastUrl} serverMachine=${lastServerMachineId || 'unknown'} serverPath=${lastServerPath || 'unknown'} serverHomeDir=${lastServerHomeDir || 'unknown'})`,
  );
}

async function openEnabledSessionHandoffFromHeader(page: Page): Promise<void> {
  const sessionActionsTrigger = page.getByLabel('Open session actions');
  await expect(sessionActionsTrigger).toHaveCount(1, { timeout: 60_000 });
  await sessionActionsTrigger.click();

  const handoffOption = page.getByTestId('dropdown-option-session_handoff');
  await expect(handoffOption).toHaveCount(1, { timeout: 60_000 });
  await expect(handoffOption).toBeEnabled({ timeout: 60_000 });
  await handoffOption.click();
}

async function restoreAccountUsingSecretKeyOnCurrentPage(page: Page, secretKeyFormatted: string): Promise<void> {
  await expect(page.getByTestId('welcome-restore')).toHaveCount(1, { timeout: 60_000 });
  await page.getByTestId('welcome-restore').click();

  await expect(page.getByTestId('restore-open-manual')).toHaveCount(1, { timeout: 60_000 });
  await page.getByTestId('restore-open-manual').click();

  await page.getByTestId('restore-manual-secret-input').fill(secretKeyFormatted);
  const authOk = page.waitForResponse((resp) => resp.url().endsWith('/v1/auth') && resp.status() === 200, { timeout: 60_000 });
  await page.getByTestId('restore-manual-submit').click();
  await authOk;

  await page.waitForURL((url) => !url.pathname.endsWith('/restore/manual'), { timeout: 60_000 });
}

type BrowserStorageSnapshot = Readonly<{
  activeServerId: string;
  activeServerIdIsExplicit: boolean | null;
  localStorage: Record<string, string>;
  machineListByServerIdSummaries: Array<Readonly<{
    storageKey: string;
    activeServerId: string;
    machineCountsByServerId: Record<string, number>;
    activeCountsByServerId: Record<string, number>;
    machineIdsByServerId: Record<string, string[]>;
  }>>;
  parsedSettings: unknown;
  rawSettings: string;
  rawServerState: string;
  serverStateSnapshot: unknown;
  sessionStorageActiveServerId: string;
  sessionStorage: Record<string, string>;
}>;

function toRecord(storage: Storage): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key) continue;
    const value = storage.getItem(key);
    if (value !== null) out[key] = value;
  }
  return out;
}

function parseJsonOrNull(value: string | null | undefined): unknown | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return { parseError: true, raw: value };
  }
}

function summarizeMachineLists(storage: Record<string, string>): BrowserStorageSnapshot['machineListByServerIdSummaries'] {
  const summaries: BrowserStorageSnapshot['machineListByServerIdSummaries'] = [];
  for (const [storageKey, raw] of Object.entries(storage)) {
    const parsed = parseJsonOrNull(raw);
    if (!parsed || typeof parsed !== 'object') continue;
    const maybeMachineListByServerId = (parsed as Record<string, unknown>).machineListByServerId;
    if (!maybeMachineListByServerId || typeof maybeMachineListByServerId !== 'object') continue;

    const machineCountsByServerId: Record<string, number> = {};
    const activeCountsByServerId: Record<string, number> = {};
    const machineIdsByServerId: Record<string, string[]> = {};

    for (const [serverId, value] of Object.entries(maybeMachineListByServerId as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const machineIds: string[] = [];
      let activeCount = 0;
      for (const entry of value) {
        if (!entry || typeof entry !== 'object') continue;
        const entryRecord = entry as Record<string, unknown>;
        const machineId = typeof entryRecord.id === 'string' ? entryRecord.id.trim() : '';
        if (machineId) machineIds.push(machineId);
        if (entryRecord.active === true) activeCount += 1;
      }
      machineCountsByServerId[serverId] = value.length;
      activeCountsByServerId[serverId] = activeCount;
      machineIdsByServerId[serverId] = machineIds;
    }

    summaries.push({
      storageKey,
      activeServerId: typeof (parsed as Record<string, unknown>).activeServerId === 'string'
        ? String((parsed as Record<string, unknown>).activeServerId)
        : '',
      machineCountsByServerId,
      activeCountsByServerId,
      machineIdsByServerId,
    });
  }
  return summaries;
}

async function collectBrowserStateDiagnostics(
  page: Page,
  options: Readonly<{
    pageConsole?: readonly string[];
    pageErrors?: readonly string[];
  }> = {},
): Promise<string> {
  const url = page.url();
  const origin = (() => {
    try {
      return new URL(url).origin;
    } catch {
      return '';
    }
  })();
  const [cookies, storageSnapshot, visibleMachineTestIds] = await Promise.all([
    origin ? page.context().cookies([origin]).catch(() => []) : page.context().cookies().catch(() => []),
    page.evaluate(() => {
      const toObject = (storage: Storage): Record<string, string> => {
        const out: Record<string, string> = {};
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (!key) continue;
          const value = storage.getItem(key);
          if (value !== null) out[key] = value;
        }
        return out;
      };
      const rawSettings = window.localStorage.getItem('mmkv.default\\settings');
      const rawServerState = window.localStorage.getItem('server-state-v1');
      const sessionStorageActiveServerId = window.sessionStorage.getItem('activeServerId') ?? '';
      let activeServerId = sessionStorageActiveServerId;
      let activeServerIdIsExplicit: boolean | null = null;
      let parsedSettings: unknown = null;
      let serverStateSnapshot: unknown = null;
      if (rawSettings) {
        try {
          parsedSettings = JSON.parse(rawSettings);
          const settings = typeof parsedSettings === 'object' && parsedSettings
            ? (parsedSettings as Record<string, unknown>).settings
            : null;
          const candidate = settings && typeof settings === 'object'
            ? (settings as Record<string, unknown>).activeServerId
            : null;
          const explicitCandidate = settings && typeof settings === 'object'
            ? (settings as Record<string, unknown>).activeServerIdIsExplicit
            : null;
          if (typeof candidate === 'string' && candidate.trim().length > 0) activeServerId = candidate.trim();
          if (typeof explicitCandidate === 'boolean') activeServerIdIsExplicit = explicitCandidate;
        } catch {
          parsedSettings = { parseError: true };
        }
      }
      if (rawServerState) {
        try {
          serverStateSnapshot = JSON.parse(rawServerState);
          const state = typeof serverStateSnapshot === 'object' && serverStateSnapshot
            ? (serverStateSnapshot as Record<string, unknown>)
            : null;
          const candidate = state?.activeServerId;
          const explicitCandidate = state?.activeServerIdIsExplicit;
          if ((!activeServerId || activeServerId.length === 0) && typeof candidate === 'string' && candidate.trim().length > 0) {
            activeServerId = candidate.trim();
          }
          if (activeServerIdIsExplicit == null && typeof explicitCandidate === 'boolean') {
            activeServerIdIsExplicit = explicitCandidate;
          }
        } catch {
          serverStateSnapshot = { parseError: true };
        }
      }
      return {
        activeServerId,
        activeServerIdIsExplicit,
        rawServerState,
        rawSettings,
        parsedSettings,
        serverStateSnapshot,
        localStorage: toObject(window.localStorage),
        sessionStorage: toObject(window.sessionStorage),
        sessionStorageActiveServerId,
      };
    }).catch(() => null),
    page.locator('[data-testid^="sessions-empty-state-machine:"]').evaluateAll((nodes) =>
      nodes
        .map((node) => node.getAttribute('data-testid'))
        .filter((value): value is string => typeof value === 'string' && value.length > 0),
    ).catch(() => []),
  ]);
  const pageSnapshot = await page.evaluate(() => {
    const root = document.getElementById('root');
    const main = document.querySelector('main');
    return {
      readyState: document.readyState,
      title: document.title,
      rootHtml: root?.innerHTML?.slice(0, 4_000) ?? '',
      mainHtml: main?.innerHTML?.slice(0, 4_000) ?? '',
      bodyText: (document.body?.innerText ?? '').slice(0, 4_000),
    };
  }).catch(() => null);

  const counts = {
    connectMachine: await page.getByTestId('session-getting-started-kind-connect_machine').count().catch(() => 0),
    createSession: await page.getByTestId('session-getting-started-kind-create_session').count().catch(() => 0),
    selectSession: await page.getByTestId('session-getting-started-kind-select_session').count().catch(() => 0),
    startNewSession: await page.getByTestId('main-header-start-new-session').count().catch(() => 0),
    setupWizard: await page.getByTestId('setupWizard.surface').count().catch(() => 0),
    sessionsEmptyStateList: await page.getByTestId('sessions-empty-state-list').count().catch(() => 0),
  };

  const storageSnapshotOrNull = storageSnapshot as BrowserStorageSnapshot | null;
  const machineListByServerIdSummaries = storageSnapshotOrNull ? summarizeMachineLists(storageSnapshotOrNull.localStorage) : [];

  return [
    '# Browser state',
    `- url: ${url || '(unknown)'}`,
    `- origin: ${origin || '(unknown)'}`,
    '',
    '## Counts',
    '```json',
    JSON.stringify(counts, null, 2),
    '```',
    '',
    '## Cookies',
    '```json',
    JSON.stringify(cookies, null, 2),
    '```',
    '',
    '## Storage',
    '```json',
    JSON.stringify(storageSnapshot, null, 2),
    '```',
    '',
    '## Derived active server state',
    '```json',
    JSON.stringify(
      storageSnapshotOrNull
        ? {
            activeServerId: storageSnapshotOrNull.activeServerId,
            activeServerIdIsExplicit: storageSnapshotOrNull.activeServerIdIsExplicit,
            sessionStorageActiveServerId: storageSnapshotOrNull.sessionStorageActiveServerId,
            rawSettings: storageSnapshotOrNull.rawSettings,
            rawServerState: storageSnapshotOrNull.localStorage['server-state-v1'] ?? null,
            serverStateSnapshot: storageSnapshotOrNull.serverStateSnapshot,
            parsedSettings: storageSnapshotOrNull.parsedSettings,
          }
        : null,
      null,
      2,
    ),
    '```',
    '',
    '## Machine list summaries',
    '```json',
    JSON.stringify(machineListByServerIdSummaries, null, 2),
    '```',
    '',
    '## Visible machine test IDs',
    '```json',
    JSON.stringify(visibleMachineTestIds, null, 2),
    '```',
    '',
    '## DOM snapshot',
    '```json',
    JSON.stringify(pageSnapshot, null, 2),
    '```',
    '',
    '## Page console',
    '```json',
    JSON.stringify(options.pageConsole ?? [], null, 2),
    '```',
    '',
    '## Page errors',
    '```json',
    JSON.stringify(options.pageErrors ?? [], null, 2),
    '```',
  ].join('\n');
}

async function expectTransferredWorkspaceReadmeOnTarget(params: {
  fakeClaudeLogPath: string;
  expectedContents: string;
  timeoutMs?: number;
}): Promise<void> {
  const invocation = await waitForFakeClaudeInvocation(
    params.fakeClaudeLogPath,
    (entry) =>
      typeof entry.cwd === 'string'
      && entry.cwd.length > 0
      && Array.isArray(entry.argv)
      && entry.argv.length > 0
      && entry.argv[0] !== '--version'
      && entry.argv[0] !== 'version',
    {
      timeoutMs: params.timeoutMs ?? 180_000,
      pollMs: 250,
    },
  );

  await expect(readFile(resolve(join(String(invocation.cwd), 'README.md')), 'utf8')).resolves.toBe(params.expectedContents);
}

async function enableWorkspaceTransferForHandoff(page: Page): Promise<void> {
  const transferItem = page.getByTestId('session-handoff-workspace-transfer-enabled');
  await expect(transferItem).toHaveCount(1, { timeout: 60_000 });

  const checkbox = transferItem.locator('input[type="checkbox"]').first();
  if ((await checkbox.count()) > 0) {
    if (!(await checkbox.isChecked().catch(() => false))) {
      await transferItem.click();
      await expect(checkbox).toBeChecked({ timeout: 60_000 });
    }
    return;
  }

  const roleSwitch = transferItem.locator('[role="switch"]').first();
  if ((await roleSwitch.count()) > 0) {
    if ((await roleSwitch.getAttribute('aria-checked').catch(() => null)) !== 'true') {
      await transferItem.click();
      await expect(roleSwitch).toHaveAttribute('aria-checked', 'true', { timeout: 60_000 });
    }
    return;
  }

  throw new Error('workspace transfer toggle control not found in session handoff modal');
}

async function selectMachineForHandoff(page: Page, machineId: string): Promise<void> {
  await page.getByTestId('session-handoff-machine-dropdown-trigger').click();
  const option = page.getByTestId(`session-handoff-machine-option:${machineId}`);
  await expect(option).toHaveCount(1, { timeout: 120_000 });
  await option.click();
}

function buildServerScopedUiUrl(uiBaseUrl: string, serverBaseUrl: string, path: string = '/'): string {
  const url = new URL(path, uiBaseUrl.endsWith('/') ? uiBaseUrl : `${uiBaseUrl}/`);
  url.searchParams.set('server', serverBaseUrl);
  return url.toString();
}

async function connectTerminalForHome(params: {
  page: Page;
  testDir: string;
  cliHomeDir: string;
  serverBaseUrl: string;
  uiBaseUrl: string;
  accountSecretKeyFormatted: string;
}): Promise<void> {
  const cliLogin: StartedCliTerminalConnect = await startCliAuthLoginForTerminalConnect({
    testDir: params.testDir,
    cliHomeDir: params.cliHomeDir,
    serverUrl: params.serverBaseUrl,
    webappUrl: params.uiBaseUrl,
    waitForConnectUrlReady: false,
    env: {
      ...process.env,
      HOME: params.cliHomeDir,
      CI: '1',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    },
  });

  try {
    const connectUrlForBrowser = resolveTerminalConnectUrlForBrowser({
      connectUrl: cliLogin.connectUrl,
      uiBaseUrl: params.uiBaseUrl,
      serverUrl: params.serverBaseUrl,
    });
    await gotoDomContentLoadedWithRetries(params.page, connectUrlForBrowser);
    await ensurePendingTerminalConnectReadyForApproval({
      page: params.page,
      connectUrlForBrowser,
      gotoConnectUrl: async (url) => {
        await gotoDomContentLoadedWithRetries(params.page, url);
      },
      restoreAccount: async () => {
        await restoreAccountUsingSecretKeyOnCurrentPage(params.page, params.accountSecretKeyFormatted);
      },
    });
    await expect(params.page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 120_000 });
    await approveTerminalConnect({ page: params.page });
    await cliLogin.waitForSuccess();
  } finally {
    await cliLogin.stop().catch(() => {});
  }

  await gotoDomContentLoadedWithRetries(
    params.page,
    buildServerScopedUiUrl(params.uiBaseUrl, params.serverBaseUrl),
  );
  await acknowledgeTerminalConnectSuccessIfPresent(params.page);
  await waitForAuthenticatedHomeUi({ page: params.page, timeoutMs: 120_000 });
}

async function spawnClaudeSessionInWorkspace(params: Readonly<{
  page: Page;
  uiBaseUrl: string;
  daemon: StartedDaemon;
  workspaceDir: string;
  prompt: string;
}>): Promise<string> {
  await mkdir(params.workspaceDir, { recursive: true });
  await writeFile(resolve(join(params.workspaceDir, 'README.md')), 'session handoff ui e2e\n', 'utf8');

  const sessionId = await spawnSessionFromDaemon({
    daemon: params.daemon,
    directory: params.workspaceDir,
    agent: 'claude',
  });

  await params.page.goto(`${params.uiBaseUrl}/session/${sessionId}`, { waitUntil: 'domcontentloaded' });
  await expect(params.page.getByTestId('session-composer-input')).toHaveCount(1, { timeout: 180_000 });
  await params.page.getByTestId('session-composer-input').fill(params.prompt);
  await params.page.getByTestId('session-composer-input').press('Enter');
  await expect(params.page.getByText('FAKE_CLAUDE_OK_1')).toHaveCount(1, { timeout: 180_000 });

  return sessionId;
}

test.describe('ui e2e: session handoff from header action menu via direct peer', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-handoff-from-header-direct-peer-suite');
  const sourceCliHomeDir = resolve(join(suiteDir, 'cli-home-source'));
  const targetCliHomeDir = resolve(join(suiteDir, 'cli-home-target'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let sourceDaemon: StartedDaemon | null = null;
  let targetDaemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_SERVER_URL: server?.baseUrl ?? '',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-direct-peer`,
      HAPPIER_E2E_UI_WEB_MODE: 'export',
      HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS: uiWebExportTimeoutMs,
      HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS:
        process.env.HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS ?? '600000',
      HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS ?? '480000',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    };
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
    await mkdir(sourceCliHomeDir, { recursive: true });
    await mkdir(targetCliHomeDir, { recursive: true });
    await writeFile(resolve(join(sourceCliHomeDir, 'AGENTS.md')), '# UI e2e source fixture\n', 'utf8');
    await writeFile(resolve(join(targetCliHomeDir, 'AGENTS.md')), '# UI e2e target fixture\n', 'utf8');

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...uiWebEnv,
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await targetDaemon?.stop().catch(() => {});
    await sourceDaemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('hands off a Claude session to a second online machine and updates the session machine binding', async ({ page }, testInfo) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const fakeClaudePath = fakeClaudeFixturePath();
    const browserStateOutputPath = resolve(join(suiteDir, 'browser-state.md'));
    const pageConsole: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => pageConsole.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', (err) => pageErrors.push(String(err)));

    let thrown: unknown = null;
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoDomContentLoadedWithRetries(page, buildServerScopedUiUrl(uiBaseUrl, server.baseUrl));
      await createAccountAndReachConnectMachineState({ page });
      const accountSecretKeyFormatted = await readLegacyAuthSecretFromLocalStorage(page);

      const sourceDir = resolve(join(suiteDir, 't1-source'));
      const targetDir = resolve(join(suiteDir, 't1-target'));
      const targetFakeClaudeLogPath = resolve(join(targetDir, 'fake-claude-target.jsonl'));
      await mkdir(sourceDir, { recursive: true });
      await mkdir(targetDir, { recursive: true });

      await connectTerminalForHome({
        page,
        testDir: sourceDir,
        cliHomeDir: sourceCliHomeDir,
        serverBaseUrl: server.baseUrl,
        uiBaseUrl,
        accountSecretKeyFormatted,
      });

      sourceDaemon = await startTestDaemon({
        testDir: sourceDir,
        happyHomeDir: sourceCliHomeDir,
        env: {
          ...process.env,
          HOME: sourceCliHomeDir,
          CI: '1',
          HAPPIER_HOME_DIR: sourceCliHomeDir,
          HAPPIER_SERVER_URL: server.baseUrl,
          HAPPIER_WEBAPP_URL: uiBaseUrl,
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_VARIANT: 'dev',
          HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: resolve(join(sourceDir, 'fake-claude-source.jsonl')),
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-source-${run.runId}`,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-source-invocation-${run.runId}`,
          HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS: '127.0.0.1',
          HAPPIER_SESSION_HANDOFF_DIRECT_PEER_BIND_HOST: '127.0.0.1',
        },
      });

      const [sourceMachineId] = await waitForMachineIds({
        cliHomeDir: sourceCliHomeDir,
        serverBaseUrl: server.baseUrl,
        count: 1,
        timeoutMs: 120_000,
      });
      if (!sourceMachineId) throw new Error('missing source machine id');

      const sessionWorkspaceDir = resolve(join(sourceDir, 'workspace'));
      const sessionId = await spawnClaudeSessionInWorkspace({
        page,
        uiBaseUrl,
        daemon: sourceDaemon,
        workspaceDir: sessionWorkspaceDir,
        prompt: `handoff-header-parent-1 ${run.runId}`,
      });

      await connectTerminalForHome({
        page,
        testDir: targetDir,
        cliHomeDir: targetCliHomeDir,
        serverBaseUrl: server.baseUrl,
        uiBaseUrl,
        accountSecretKeyFormatted,
      });

      targetDaemon = await startTestDaemon({
        testDir: targetDir,
        happyHomeDir: targetCliHomeDir,
        env: {
          ...process.env,
          HOME: targetCliHomeDir,
          CI: '1',
          HAPPIER_HOME_DIR: targetCliHomeDir,
          HAPPIER_SERVER_URL: server.baseUrl,
          HAPPIER_WEBAPP_URL: uiBaseUrl,
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_VARIANT: 'dev',
          HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: targetFakeClaudeLogPath,
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-target-${run.runId}`,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-target-invocation-${run.runId}`,
          HAPPIER_MACHINE_TRANSFER_DIRECT_PEER_ADVERTISED_HOSTS: '127.0.0.1',
          HAPPIER_SESSION_HANDOFF_DIRECT_PEER_BIND_HOST: '127.0.0.1',
        },
      });

      const machineIds = await waitForMachineIds({
        cliHomeDir: sourceCliHomeDir,
        serverBaseUrl: server.baseUrl,
        count: 2,
        timeoutMs: 120_000,
      });
      const targetMachineId = machineIds.find((id) => id !== sourceMachineId) ?? null;
      if (!targetMachineId) throw new Error(`failed to resolve target machine id from ${JSON.stringify(machineIds)}`);

      await page.goto(`${uiBaseUrl}/session/${sessionId}`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });

      await openEnabledSessionHandoffFromHeader(page);

      await expect(page.getByTestId('session-handoff-modal')).toHaveCount(1, { timeout: 60_000 });
      await selectMachineForHandoff(page, targetMachineId);
      await enableWorkspaceTransferForHandoff(page);
      await page.getByTestId('session-handoff-workspace-transfer-strategy-trigger').click();
      await expect(page.getByTestId('dropdown-option-sync_changes')).toHaveCount(1, { timeout: 60_000 });
      await page.getByTestId('dropdown-option-sync_changes').click();
      await page.getByTestId('session-handoff-start').click();
      await expect(page.getByTestId('web-modal-confirm')).toHaveCount(1, { timeout: 60_000 });
      await page.getByTestId('web-modal-confirm').click();

      await waitForSessionInfoMachineTarget({
        page,
        uiBaseUrl,
        serverBaseUrl: server.baseUrl,
        cliHomeDir: sourceCliHomeDir,
        sessionId,
        expectedMachineId: targetMachineId,
        timeoutMs: 180_000,
      });
      await expectTransferredWorkspaceReadmeOnTarget({
        fakeClaudeLogPath: targetFakeClaudeLogPath,
        expectedContents: 'session handoff ui e2e\n',
        timeoutMs: 180_000,
      });
    } catch (error) {
      thrown = error;
      const browserStateDiagnostics = await collectBrowserStateDiagnostics(page, {
        pageConsole,
        pageErrors,
      }).catch((collectError) => [
        '# Browser state',
        `- diagnostics collection failed: ${String(collectError)}`,
        `- url: ${page.url() || '(unknown)'}`,
      ].join('\n'));
      await writeFile(browserStateOutputPath, browserStateDiagnostics, 'utf8').catch(() => {});
      await testInfo.attach('browser-state.md', {
        body: browserStateDiagnostics,
        contentType: 'text/markdown',
      }).catch(() => {});
      throw error;
    } finally {
      if (thrown) {
        // Attach a stable marker for the runner log trail while keeping the failure surface in the test artifact.
        await testInfo.attach('failure-marker.txt', {
          body: `direct-peer-recovered-proof-failed:${String((thrown as Error)?.message ?? thrown)}`,
          contentType: 'text/plain',
        }).catch(() => {});
      }
    }
  });
});

test.describe('ui e2e: session handoff from header action menu via forced server-routed transfer', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-handoff-from-header-server-routed-suite');
  const sourceCliHomeDir = resolve(join(suiteDir, 'cli-home-source'));
  const targetCliHomeDir = resolve(join(suiteDir, 'cli-home-target'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let sourceDaemon: StartedDaemon | null = null;
  let targetDaemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_SERVER_URL: server?.baseUrl ?? '',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-server-routed`,
      HAPPIER_E2E_UI_WEB_MODE: 'export',
      HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS: uiWebExportTimeoutMs,
      HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS:
        process.env.HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS ?? '600000',
      HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS ?? '480000',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    };
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
    await mkdir(sourceCliHomeDir, { recursive: true });
    await mkdir(targetCliHomeDir, { recursive: true });
    await writeFile(resolve(join(sourceCliHomeDir, 'AGENTS.md')), '# UI e2e source fixture\n', 'utf8');
    await writeFile(resolve(join(targetCliHomeDir, 'AGENTS.md')), '# UI e2e target fixture\n', 'utf8');

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys,machines.transfer.directPeer',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...uiWebEnv,
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await targetDaemon?.stop().catch(() => {});
    await sourceDaemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('hands off a Claude session to a second online machine and updates the session machine binding', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const fakeClaudePath = fakeClaudeFixturePath();

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, buildServerScopedUiUrl(uiBaseUrl, server.baseUrl));
    await createAccountAndReachConnectMachineState({ page });
    const accountSecretKeyFormatted = await readLegacyAuthSecretFromLocalStorage(page);

    const sourceDir = resolve(join(suiteDir, 't1-source'));
    const targetDir = resolve(join(suiteDir, 't1-target'));
    const targetFakeClaudeLogPath = resolve(join(targetDir, 'fake-claude-target.jsonl'));
    await mkdir(sourceDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });

    await connectTerminalForHome({
      page,
      testDir: sourceDir,
      cliHomeDir: sourceCliHomeDir,
      serverBaseUrl: server.baseUrl,
      uiBaseUrl,
      accountSecretKeyFormatted,
    });

    sourceDaemon = await startTestDaemon({
      testDir: sourceDir,
      happyHomeDir: sourceCliHomeDir,
      env: {
        ...process.env,
        HOME: sourceCliHomeDir,
        CI: '1',
        HAPPIER_HOME_DIR: sourceCliHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: uiBaseUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: resolve(join(sourceDir, 'fake-claude-source.jsonl')),
        HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-source-${run.runId}-server-routed`,
        HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-source-invocation-${run.runId}-server-routed`,
      },
    });

    const [sourceMachineId] = await waitForMachineIds({
      cliHomeDir: sourceCliHomeDir,
      serverBaseUrl: server.baseUrl,
      count: 1,
      timeoutMs: 120_000,
    });
    if (!sourceMachineId) throw new Error('missing source machine id');

    const sessionWorkspaceDir = resolve(join(sourceDir, 'workspace'));
    const sessionId = await spawnClaudeSessionInWorkspace({
      page,
      uiBaseUrl,
      daemon: sourceDaemon,
      workspaceDir: sessionWorkspaceDir,
      prompt: `handoff-header-parent-server-routed ${run.runId}`,
    });

    await connectTerminalForHome({
      page,
      testDir: targetDir,
      cliHomeDir: targetCliHomeDir,
      serverBaseUrl: server.baseUrl,
      uiBaseUrl,
      accountSecretKeyFormatted,
    });

    targetDaemon = await startTestDaemon({
      testDir: targetDir,
      happyHomeDir: targetCliHomeDir,
      env: {
        ...process.env,
        HOME: targetCliHomeDir,
        CI: '1',
        HAPPIER_HOME_DIR: targetCliHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: uiBaseUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: targetFakeClaudeLogPath,
        HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-target-${run.runId}-server-routed`,
        HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-target-invocation-${run.runId}-server-routed`,
      },
    });

    const machineIds = await waitForMachineIds({
      cliHomeDir: sourceCliHomeDir,
      serverBaseUrl: server.baseUrl,
      count: 2,
      timeoutMs: 120_000,
    });
    const targetMachineId = machineIds.find((id) => id !== sourceMachineId) ?? null;
    if (!targetMachineId) throw new Error(`failed to resolve target machine id from ${JSON.stringify(machineIds)}`);

    await page.goto(`${uiBaseUrl}/session/${sessionId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });

    await openEnabledSessionHandoffFromHeader(page);

    await expect(page.getByTestId('session-handoff-modal')).toHaveCount(1, { timeout: 60_000 });
    await selectMachineForHandoff(page, targetMachineId);
    await enableWorkspaceTransferForHandoff(page);
    await page.getByTestId('session-handoff-workspace-transfer-strategy-trigger').click();
    await expect(page.getByTestId('dropdown-option-sync_changes')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('dropdown-option-sync_changes').click();
    await page.getByTestId('session-handoff-start').click();
    await expect(page.getByTestId('web-modal-confirm')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('web-modal-confirm').click();

    await waitForSessionInfoMachineTarget({
      page,
      uiBaseUrl,
      serverBaseUrl: server.baseUrl,
      cliHomeDir: sourceCliHomeDir,
      sessionId,
      expectedMachineId: targetMachineId,
      timeoutMs: 180_000,
    });
    await expectTransferredWorkspaceReadmeOnTarget({
      fakeClaudeLogPath: targetFakeClaudeLogPath,
      expectedContents: 'session handoff ui e2e\n',
      timeoutMs: 180_000,
    });
  });
});

test.describe('ui e2e: session handoff failure recovery from header action menu', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-handoff-from-header-recovery-suite');
  const sourceCliHomeDir = resolve(join(suiteDir, 'cli-home-source'));
  const targetCliHomeDir = resolve(join(suiteDir, 'cli-home-target'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let sourceDaemon: StartedDaemon | null = null;
  let targetDaemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_SERVER_URL: server?.baseUrl ?? '',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-recovery`,
      HAPPIER_E2E_UI_WEB_MODE: 'export',
      HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS: uiWebExportTimeoutMs,
      HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS:
        process.env.HAPPIER_E2E_UI_WEB_EXPORT_STARTUP_STALL_TIMEOUT_MS ?? '600000',
      HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS ?? '480000',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    };
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
    await mkdir(sourceCliHomeDir, { recursive: true });
    await mkdir(targetCliHomeDir, { recursive: true });
    await writeFile(resolve(join(sourceCliHomeDir, 'AGENTS.md')), '# UI e2e source fixture\n', 'utf8');
    await writeFile(resolve(join(targetCliHomeDir, 'AGENTS.md')), '# UI e2e target fixture\n', 'utf8');

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys,machines.transfer.directPeer',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...uiWebEnv,
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await targetDaemon?.stop().catch(() => {});
    await sourceDaemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('lands in recovery state after a forced handoff failure and restarts on the source machine', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const fakeClaudePath = fakeClaudeFixturePath();

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, buildServerScopedUiUrl(uiBaseUrl, server.baseUrl));
    await createAccountAndReachConnectMachineState({ page });
    const accountSecretKeyFormatted = await readLegacyAuthSecretFromLocalStorage(page);

    const sourceDir = resolve(join(suiteDir, 't1-source'));
    const targetDir = resolve(join(suiteDir, 't1-target'));
    await mkdir(sourceDir, { recursive: true });
    await mkdir(targetDir, { recursive: true });

    await connectTerminalForHome({
      page,
      testDir: sourceDir,
      cliHomeDir: sourceCliHomeDir,
      serverBaseUrl: server.baseUrl,
      uiBaseUrl,
      accountSecretKeyFormatted,
    });

    sourceDaemon = await startTestDaemon({
      testDir: sourceDir,
      happyHomeDir: sourceCliHomeDir,
      env: {
        ...process.env,
        HOME: sourceCliHomeDir,
        CI: '1',
        HAPPIER_HOME_DIR: sourceCliHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: uiBaseUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        HAPPIER_CLAUDE_PATH: fakeClaudePath,
        HAPPIER_E2E_FAKE_CLAUDE_LOG: resolve(join(sourceDir, 'fake-claude-source.jsonl')),
        HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-source-${run.runId}-recovery`,
        HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-source-invocation-${run.runId}-recovery`,
      },
    });

    const [sourceMachineId] = await waitForMachineIds({
      cliHomeDir: sourceCliHomeDir,
      serverBaseUrl: server.baseUrl,
      count: 1,
      timeoutMs: 120_000,
    });
    if (!sourceMachineId) throw new Error('missing source machine id');

    const session = await createSessionFromNewSessionComposer({
      page,
      uiBaseUrl,
      machineId: sourceMachineId,
      prompt: `handoff-header-parent-recovery ${run.runId}`,
      readiness: 'first-turn-reload-safe',
    });
    const { sessionId } = session;

    await reloadCreatedSessionFromNewSessionComposer({ page, session });
    await expect(page.getByText('FAKE_CLAUDE_OK_1')).toHaveCount(1, { timeout: 180_000 });

    await connectTerminalForHome({
      page,
      testDir: targetDir,
      cliHomeDir: targetCliHomeDir,
      serverBaseUrl: server.baseUrl,
      uiBaseUrl,
      accountSecretKeyFormatted,
    });

    targetDaemon = await startTestDaemon({
      testDir: targetDir,
      happyHomeDir: targetCliHomeDir,
      env: {
        ...process.env,
        HOME: targetCliHomeDir,
        CI: '1',
        HAPPIER_HOME_DIR: targetCliHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: uiBaseUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_CLAUDE_PATH: resolve(join(targetDir, 'missing-claude-binary')),
      },
    });

    const machineIds = await waitForMachineIds({
      cliHomeDir: sourceCliHomeDir,
      serverBaseUrl: server.baseUrl,
      count: 2,
      timeoutMs: 120_000,
    });
    const targetMachineId = machineIds.find((id) => id !== sourceMachineId) ?? null;
    if (!targetMachineId) throw new Error(`failed to resolve target machine id from ${JSON.stringify(machineIds)}`);

    await reloadCreatedSessionFromNewSessionComposer({ page, session });

    await openEnabledSessionHandoffFromHeader(page);

    await expect(page.getByTestId('session-handoff-modal')).toHaveCount(1, { timeout: 60_000 });
    await selectMachineForHandoff(page, targetMachineId);
    await page.getByTestId('session-handoff-start').click();
    await expect(page.getByTestId('web-modal-confirm')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('web-modal-confirm').click();

    await expect(page.getByTestId('session-handoff-recovery-modal')).toHaveCount(1, { timeout: 180_000 });
    await expect(page.getByTestId('session-handoff-recovery-restart-on-source')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('session-handoff-recovery-keep-stopped')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('session-handoff-recovery-restart-on-source').click();

    const composer = page.locator('textarea[data-testid="session-composer-input"]:visible').first();
    await expect(composer).toHaveCount(1, { timeout: 180_000 });
    await composer.fill(`handoff recovery follow-up ${run.runId}`);
    await composer.press('Enter');
    await expect(page.getByText('FAKE_CLAUDE_OK_1')).toHaveCount(2, { timeout: 180_000 });

    await waitForSessionInfoMachineTarget({
      page,
      uiBaseUrl,
      serverBaseUrl: server.baseUrl,
      cliHomeDir: sourceCliHomeDir,
      sessionId,
      expectedMachineId: sourceMachineId,
      timeoutMs: 180_000,
    });
  });
});
