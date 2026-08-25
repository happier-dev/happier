import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import {
  replaceTestDaemonWithoutStoppingSessions,
  startTestDaemon,
  type StartedDaemon,
} from '../../src/testkit/daemon/daemon';
import {
  applyTrustedLocalPluginFixture,
  buildPreAttestedExternalSessionLiveEnv,
  reloadTrustedLocalPluginFixture,
  uninstallTrustedLocalPluginFixture,
  writeInstrumentedExternalSessionLivePlugin,
} from '../../src/testkit/externalSessionLiveLifecycleFixture';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import {
  resolveUiWebBeforeAllTimeoutMs,
  startUiWeb,
  type StartedUiWeb,
} from '../../src/testkit/process/uiWeb';
import { createRunDirs } from '../../src/testkit/runDir';
import {
  approveTerminalConnect,
} from '../../src/testkit/uiE2e/approveTerminalConnect';
import {
  startCliAuthLoginForTerminalConnect,
  type StartedCliTerminalConnect,
} from '../../src/testkit/uiE2e/cliTerminalConnect';
import { enableDirectSessionsFeature } from '../../src/testkit/uiE2e/enableDirectSessionsFeature';
import {
  createAccountAndReachConnectMachineState,
  gotoDomContentLoadedWithRetries,
  normalizeLoopbackBaseUrl,
} from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });
const PLUGIN_ID = 'acme.nonbundled-public-external-sessions';
const AGENT_ID = 'fixture-agent';
const ROUTING_AGENT_ID = `${PLUGIN_ID}/${AGENT_ID}`;
const PUBLIC_ACTION_ID = `${PLUGIN_ID}/public-external-sessions`;
const PUBLIC_ACTION_LOCAL_ID = 'public-external-sessions';
const PUBLIC_G = Object.freeze({
  candidateTitle: 'Mounted public source candidate G',
  transcriptText: 'Mounted public source transcript G',
});
const PUBLIC_H = Object.freeze({
  candidateTitle: 'Mounted public source candidate H',
  transcriptText: 'Mounted public source transcript H',
});
const PUBLIC_AGENT_OPTION_TEST_ID = `dropdown-option-${ROUTING_AGENT_ID
  .replace(/[^a-zA-Z0-9_-]/g, '_')}`;

type JsonRecord = Readonly<Record<string, unknown>>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

async function executePublicExternalSessionsAction(
  daemon: StartedDaemon,
  input: JsonRecord = {},
): Promise<JsonRecord> {
  const response = await daemonControlPostJson({
    port: daemon.state.httpPort,
    path: '/plugins/actions/execute',
    controlToken: daemon.state.controlToken,
    body: {
      actionId: PUBLIC_ACTION_ID,
      input,
      surface: 'cli',
    },
    timeoutMs: 30_000,
  });
  const data = asRecord(response.data);
  const result = asRecord(data?.result);
  const actionResult = asRecord(result?.result);
  if (
    response.status !== 200
    || data?.matched !== true
    || result?.ok !== true
    || actionResult === null
  ) {
    throw new Error(
      `Source-loaded public External Sessions action failed (${JSON.stringify(response.data)})`,
    );
  }
  return actionResult;
}

async function browseFixtureCandidate(
  page: Page,
  expectedTitle: string,
): Promise<Locator> {
  await page.getByTestId('sessions-list-storage-tab:direct').click();
  await expect(page.getByTestId('direct-sessions-browse-button')).toHaveCount(1, {
    timeout: 60_000,
  });
  await page.getByTestId('direct-sessions-browse-button').click();
  await expect(page.getByTestId('direct-sessions-browse-modal')).toHaveCount(1, {
    timeout: 60_000,
  });
  const agentPicker = page.getByTestId('direct-session-provider-picker-trigger');
  await expect(agentPicker).toHaveCount(1, { timeout: 60_000 });
  await agentPicker.focus();
  await agentPicker.press('Enter');
  const agentOption = page.getByTestId(PUBLIC_AGENT_OPTION_TEST_ID);
  await expect(agentOption).toHaveCount(1, { timeout: 60_000 });
  await agentOption.click();
  const candidate = page.getByTestId('direct-session-candidate:fixture-live-remote');
  await expect(candidate).toHaveCount(1, { timeout: 120_000 });
  await expect(candidate).toContainText(expectedTitle, { timeout: 60_000 });
  return candidate;
}

async function closeBrowse(page: Page): Promise<void> {
  const close = page.getByTestId('external-session-browse-cancel');
  await expect(close).toHaveCount(1, { timeout: 60_000 });
  await close.click();
  await expect(page.getByTestId('direct-sessions-browse-modal')).toHaveCount(0, {
    timeout: 60_000,
  });
}

function requireStringField(record: JsonRecord, field: string): string {
  const value = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Expected a non-empty '${field}' in ${JSON.stringify(record)}`);
  }
  return value;
}

test.describe('ui e2e: source-loaded non-bundled public External Sessions lifecycle', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-external-nonbundled-public-source-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));
  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;
  let cliLogin: StartedCliTerminalConnect | null = null;

  test.beforeAll(async () => {
    const preAttestedEnv = buildPreAttestedExternalSessionLiveEnv();
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-nonbundled-public-source-${run.runId}`,
      HAPPIER_E2E_UI_WEB_MODE: 'metro',
    };
    test.setTimeout(Math.max(resolveUiWebBeforeAllTimeoutMs(uiWebEnv), 720_000));
    await mkdir(cliHomeDir, { recursive: true });
    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        ...preAttestedEnv,
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
      skipWorkspacePrebuild: true,
    });
    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await cliLogin?.stop().catch(() => undefined);
    cliLogin = null;
    await daemon?.stop().catch(() => undefined);
    daemon = null;
    await ui?.stop().catch(() => undefined);
    ui = null;
    await server?.stop().catch(() => undefined);
    server = null;
  });

  test('routes a source-loaded public action to the mounted External Sessions Agent', async ({ page }) => {
    test.setTimeout(900_000);
    if (!server || !uiBaseUrl) throw new Error('nonbundled_public_source_suite_not_ready');

    const testDir = resolve(join(suiteDir, 'mounted-public-source-lifecycle'));
    const pluginRoot = resolve(join(testDir, 'plugin'));
    const markerPath = resolve(join(testDir, 'lifecycle.jsonl'));
    const preAttestedEnv = buildPreAttestedExternalSessionLiveEnv();
    await mkdir(testDir, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl, 180_000);
    await createAccountAndReachConnectMachineState({ page });

    cliLogin = await startCliAuthLoginForTerminalConnect({
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      webappUrl: uiBaseUrl,
      waitForConnectUrlReady: false,
      env: {
        ...process.env,
        ...preAttestedEnv,
        HOME: cliHomeDir,
        CI: '1',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
      },
    });
    await gotoDomContentLoadedWithRetries(page, cliLogin.connectUrl, 180_000);
    await approveTerminalConnect({ page });
    await cliLogin.waitForSuccess();
    await cliLogin.stop().catch(() => undefined);
    cliLogin = null;

    const daemonEnv = {
      ...process.env,
      ...preAttestedEnv,
      HOME: cliHomeDir,
      CI: '1',
      HAPPIER_HOME_DIR: cliHomeDir,
      HAPPIER_SERVER_URL: server.baseUrl,
      HAPPIER_WEBAPP_URL: uiBaseUrl,
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'plaintext_only',
    };
    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: cliHomeDir,
      snapshotDir: resolve(join(testDir, 'cli-dist')),
      startupTimeoutMs: 120_000,
      env: daemonEnv,
    });
    await enableDirectSessionsFeature(page, uiBaseUrl);
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/`, 180_000);
    await expect(page.getByTestId('session-getting-started-kind-start_daemon')).toHaveCount(0, {
      timeout: 120_000,
    });
    await expect(page.getByTestId('sessions-list-storage-tab:direct')).toHaveCount(1, {
      timeout: 120_000,
    });

    await writeInstrumentedExternalSessionLivePlugin({
      pluginRoot,
      pluginId: PLUGIN_ID,
      agentId: AGENT_ID,
      generation: 'G',
      observationStatus: 'waiting',
      markerPath,
      publicExternalSessionsAction: {
        actionId: PUBLIC_ACTION_LOCAL_ID,
        ...PUBLIC_G,
      },
    });
    await applyTrustedLocalPluginFixture({
      daemonPort: daemon.state.httpPort,
      controlToken: daemon.state.controlToken,
      pluginRoot,
      pluginId: PLUGIN_ID,
      interactionId: 'nonbundled-public-source-install',
    });

    const publicResult = await executePublicExternalSessionsAction(daemon);
    expect(publicResult).toMatchObject({
      outcome: 'read',
      generation: 'G',
      candidate: {
        agentId: ROUTING_AGENT_ID,
        remoteSessionId: 'fixture-live-remote',
        title: PUBLIC_G.candidateTitle,
      },
      transcript: {
        mode: 'page',
        itemCount: 1,
      },
    });
    const publicTranscript = asRecord(publicResult.transcript);
    if (!publicTranscript) throw new Error('public_source_transcript_missing');
    const gTailCursor = requireStringField(publicTranscript, 'tailCursor');

    const gCandidate = await browseFixtureCandidate(page, PUBLIC_G.candidateTitle);
    await gCandidate.focus();
    await gCandidate.press('Enter');
    const transcript = page.getByTestId('transcript-chat-list');
    await expect(transcript).toHaveCount(1, { timeout: 120_000 });
    await expect(transcript.getByText(PUBLIC_G.transcriptText)).toHaveCount(1, {
      timeout: 60_000,
    });

    await writeInstrumentedExternalSessionLivePlugin({
      pluginRoot,
      pluginId: PLUGIN_ID,
      agentId: AGENT_ID,
      generation: 'H',
      observationStatus: 'working',
      markerPath,
      publicExternalSessionsAction: {
        actionId: PUBLIC_ACTION_LOCAL_ID,
        ...PUBLIC_H,
      },
    });
    await reloadTrustedLocalPluginFixture({
      daemonPort: daemon.state.httpPort,
      controlToken: daemon.state.controlToken,
      pluginRoot,
      pluginId: PLUGIN_ID,
      changedPaths: ['daemon.mjs'],
    });

    const publicH = await executePublicExternalSessionsAction(daemon);
    expect(publicH).toMatchObject({
      outcome: 'read',
      generation: 'H',
      candidate: {
        agentId: ROUTING_AGENT_ID,
        remoteSessionId: 'fixture-live-remote',
        title: PUBLIC_H.candidateTitle,
      },
      transcript: {
        mode: 'page',
        itemCount: 1,
      },
    });
    const staleGRead = await executePublicExternalSessionsAction(daemon, {
      readAfterCursor: gTailCursor,
    });
    expect(staleGRead).toMatchObject({
      outcome: 'read',
      generation: 'H',
      transcript: {
        mode: 'readAfter',
        outcome: 'gap_or_cursor_expired',
      },
    });
    const staleGFollow = await executePublicExternalSessionsAction(daemon, {
      followCursor: gTailCursor,
    });
    expect(staleGFollow).toMatchObject({
      outcome: 'follow',
      generation: 'H',
      follow: {
        status: 'unavailable',
        code: 'plugin_external_cursor_invalid',
      },
    });
    // The linked G session remains mounted while new public work sees H.
    await expect(transcript.getByText(PUBLIC_G.transcriptText)).toHaveCount(1, {
      timeout: 60_000,
    });

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/`, 180_000);
    await browseFixtureCandidate(page, PUBLIC_H.candidateTitle);
    await closeBrowse(page);

    daemon = await replaceTestDaemonWithoutStoppingSessions({
      testDir,
      happyHomeDir: cliHomeDir,
      snapshotDir: resolve(join(testDir, 'cli-dist')),
      env: daemonEnv,
      originalDaemon: daemon,
    });
    const afterRestart = await executePublicExternalSessionsAction(daemon);
    expect(afterRestart).toMatchObject({
      outcome: 'read',
      generation: 'H',
      candidate: { title: PUBLIC_H.candidateTitle },
    });

    await uninstallTrustedLocalPluginFixture({
      daemonPort: daemon.state.httpPort,
      controlToken: daemon.state.controlToken,
      pluginId: PLUGIN_ID,
    });
    const unavailable = await daemonControlPostJson({
      port: daemon.state.httpPort,
      path: '/plugins/actions/execute',
      controlToken: daemon.state.controlToken,
      body: { actionId: PUBLIC_ACTION_ID, input: {}, surface: 'cli' },
      timeoutMs: 30_000,
    });
    expect(unavailable.status).toBe(200);
    expect(asRecord(unavailable.data)).toMatchObject({ matched: false });

    await applyTrustedLocalPluginFixture({
      daemonPort: daemon.state.httpPort,
      controlToken: daemon.state.controlToken,
      pluginRoot,
      pluginId: PLUGIN_ID,
      interactionId: 'nonbundled-public-source-reinstall',
    });
    await reloadTrustedLocalPluginFixture({
      daemonPort: daemon.state.httpPort,
      controlToken: daemon.state.controlToken,
      pluginRoot,
      pluginId: PLUGIN_ID,
      changedPaths: ['daemon.mjs'],
    });
    const afterReinstall = await executePublicExternalSessionsAction(daemon);
    expect(afterReinstall).toMatchObject({
      outcome: 'read',
      generation: 'H',
      candidate: { title: PUBLIC_H.candidateTitle },
    });
  });
});
