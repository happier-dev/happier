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
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { createSessionFromNewSessionComposer } from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';

const run = createRunDirs({ runLabel: 'ui-e2e' });

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

async function connectTerminalForHome(params: {
  page: Page;
  testDir: string;
  cliHomeDir: string;
  serverBaseUrl: string;
  uiBaseUrl: string;
}): Promise<void> {
  function resolveConnectUrlForBrowser(paramsInner: { connectUrl: string; uiBaseUrl: string }): string {
    try {
      const connectUrl = new URL(paramsInner.connectUrl);
      const uiUrl = new URL(paramsInner.uiBaseUrl);
      const loopbackHosts = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
      if (loopbackHosts.has(connectUrl.hostname) && loopbackHosts.has(uiUrl.hostname) && connectUrl.host !== uiUrl.host) {
        connectUrl.protocol = uiUrl.protocol;
        connectUrl.hostname = uiUrl.hostname;
        connectUrl.port = uiUrl.port;
      }
      return connectUrl.toString();
    } catch {
      return paramsInner.connectUrl;
    }
  }

  const cliLogin: StartedCliTerminalConnect = await startCliAuthLoginForTerminalConnect({
    testDir: params.testDir,
    cliHomeDir: params.cliHomeDir,
    serverUrl: params.serverBaseUrl,
    webappUrl: params.uiBaseUrl,
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
    const connectUrlForBrowser = resolveConnectUrlForBrowser({
      connectUrl: cliLogin.connectUrl,
      uiBaseUrl: params.uiBaseUrl,
    });
    await gotoDomContentLoadedWithRetries(params.page, connectUrlForBrowser);
    const approveButton = params.page.getByTestId('terminal-connect-approve');
    await expect(approveButton).toHaveCount(1, { timeout: 60_000 });
    await expect(approveButton).toBeEnabled({ timeout: 60_000 });
    await approveButton.click({ noWaitAfter: true });
    await cliLogin.waitForSuccess();
  } finally {
    await cliLogin.stop().catch(() => {});
  }

  await gotoDomContentLoadedWithRetries(params.page, `${params.uiBaseUrl}/`);
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
      HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS ?? '15000',
      HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_ATTEMPT_TIMEOUT_MS:
        process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_ATTEMPT_TIMEOUT_MS ?? '15000',
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

  test('hands off a Claude session to a second online machine and updates the session machine binding', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const fakeClaudePath = fakeClaudeFixturePath();

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
    await page.getByTestId('welcome-create-account').click();
    await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

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

    const sessionActionsTrigger = page.getByLabel('Open session actions');
    await expect(sessionActionsTrigger).toHaveCount(1, { timeout: 60_000 });
    await sessionActionsTrigger.click();
    await expect(page.getByTestId('dropdown-option-session_handoff')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('dropdown-option-session_handoff').click();

    await expect(page.getByTestId('session-handoff-modal')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId(`session-handoff-machine:${targetMachineId}`)).toHaveCount(1, { timeout: 120_000 });
    await page.getByTestId(`session-handoff-machine:${targetMachineId}`).click();
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
      HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS ?? '15000',
      HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_ATTEMPT_TIMEOUT_MS:
        process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_ATTEMPT_TIMEOUT_MS ?? '15000',
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
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
    await page.getByTestId('welcome-create-account').click();
    await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

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

    const sessionActionsTrigger = page.getByLabel('Open session actions');
    await expect(sessionActionsTrigger).toHaveCount(1, { timeout: 60_000 });
    await sessionActionsTrigger.click();
    await expect(page.getByTestId('dropdown-option-session_handoff')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('dropdown-option-session_handoff').click();

    await expect(page.getByTestId('session-handoff-modal')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId(`session-handoff-machine:${targetMachineId}`)).toHaveCount(1, { timeout: 120_000 });
    await page.getByTestId(`session-handoff-machine:${targetMachineId}`).click();
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
      HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_EXPORT_TIMEOUT_MS ?? '15000',
      HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_ATTEMPT_TIMEOUT_MS:
        process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_ATTEMPT_TIMEOUT_MS ?? '15000',
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
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
    await page.getByTestId('welcome-create-account').click();
    await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

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

    const sessionId = await createSessionFromNewSessionComposer({
      page,
      uiBaseUrl,
      machineId: sourceMachineId,
      prompt: `handoff-header-parent-recovery ${run.runId}`,
    });

    await page.goto(`${uiBaseUrl}/session/${sessionId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByText('FAKE_CLAUDE_OK_1')).toHaveCount(1, { timeout: 180_000 });

    await connectTerminalForHome({
      page,
      testDir: targetDir,
      cliHomeDir: targetCliHomeDir,
      serverBaseUrl: server.baseUrl,
      uiBaseUrl,
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

    await page.goto(`${uiBaseUrl}/session/${sessionId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('transcript-chat-list')).toHaveCount(1, { timeout: 120_000 });

    const sessionActionsTrigger = page.getByLabel('Open session actions');
    await expect(sessionActionsTrigger).toHaveCount(1, { timeout: 60_000 });
    await sessionActionsTrigger.click();
    await expect(page.getByTestId('dropdown-option-session_handoff')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('dropdown-option-session_handoff').click();

    await expect(page.getByTestId('session-handoff-modal')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId(`session-handoff-machine:${targetMachineId}`)).toHaveCount(1, { timeout: 120_000 });
    await page.getByTestId(`session-handoff-machine:${targetMachineId}`).click();
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
