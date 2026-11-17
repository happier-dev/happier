import { test, expect, type Page } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { resolveTestDbProvider, startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebScriptFetchTotalTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { fakeClaudeFixturePath } from '../../src/testkit/fakeClaude';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { mutateUiE2eLocalSettings } from '../../src/testkit/uiE2e/localSettingsStorage';
import { mutateUiE2eScopedAccountSettings } from '../../src/testkit/uiE2e/scopedAccountSettingsStorage';
import { createGitRepoWithChanges } from '../../src/testkit/uiE2e/gitRepoFixtures';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';
import { toTestIdSafeValue } from '../../src/testkit/uiE2e/testIdSafeValue';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';

import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';
import { bindHomeDomainActionHttpRequestV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { attachRelayRpcResponses } from '../../src/testkit/uiE2e/relayRpcResponses';
import { waitForDaemonMachineIdFromCliSettings } from '../../src/testkit/uiE2e/daemonMachineId';
import { resolveCanonicalServerIdForUi } from '../../src/testkit/uiE2e/sessionFoldersDrag';
import { sessionListRowTestId } from '../../src/testkit/uiE2e/sessionListRowTestId';
import { openSessionListRowMenu, selectSessionListRowMenuItem } from '../../src/testkit/uiE2e/sessionListRowMenu';
import { accountScopedCryptoMaterialFromCliAccessKey, readCliAccessKey } from '../../src/testkit/cliAccessKey';
import { daemonControlPostJson } from '../../src/testkit/daemon/controlServerClient';
import { fetchJson } from '../../src/testkit/http';
import { fetchSessionV2, patchSessionMetadataEnvelopeTupleV1 } from '../../src/testkit/sessions';
import {
  buildAccountStoredContentCompatibilityHttpHeadersV1, CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION,
  openSessionOwnerMetadataEnvelopeV1, sealSessionOwnerMetadataEnvelopeV1, SessionOwnerMetadataEnvelopeV1Schema,
} from '@happier-dev/protocol';
import { AccountEncryptionModeResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { buildSystemSessionMetadataV1 } from '@happier-dev/protocol/sessions/metadata/systemSessionV1';
import { VOICE_CONVERSATION_SYSTEM_SESSION_KEY } from '@happier-dev/protocol/voice/sessionBinding';

const run = createRunDirs({ runLabel: 'ui-e2e' });

function detailsPaneLocator(page: Page) {
  return page
    .getByTestId('multi-pane-details-docked')
    .or(page.getByTestId('multi-pane-details-overlay'));
}

function rightPaneLocator(page: Page) {
  return page
    .getByTestId('multi-pane-right-docked')
    .or(page.getByTestId('multi-pane-right-overlay'));
}

test.describe('ui e2e: session action rail', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-action-rail-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));
  const dbProvider = resolveTestDbProvider(process.env, { fallbackProvider: 'sqlite' });

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    // Expo web bundling + first-run Metro startup can exceed 7 minutes on cold caches.
    // Keep this generous to avoid flaking the suite before we even reach UI assertions.
    test.setTimeout(900_000);
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(resolve(join(cliHomeDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider,
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        HAPPIER_FEATURE_TERMINAL_EMBEDDED_PTY__ENABLED: '1',
        HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPIER_SOCKET_FORCE_WEBSOCKET: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
        // On cold caches, the initial Metro web bundle can take >2 minutes; avoid aborting the request
        // before it has a chance to complete (which can cause repeated restarts and flakiness).
        HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS ?? '420000',
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('confirms running session deletion, preserves failures, and keeps Archive independent', async ({ page }, testInfo) => {
    test.setTimeout(900_000);
    if (!server || !ui || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const serverUrl = server.baseUrl;
    const browserDiagnostics = collectBrowserDiagnostics({ page });
    const rpc = await attachRelayRpcResponses(page);
    const mutations: Array<Readonly<{ method: string; pathname: string }>> = [];
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname;
      if ((request.method() === 'DELETE' && /^\/v1\/sessions\/[^/]+$/.test(pathname))
        || /^\/v2\/sessions\/[^/]+\/archive$/.test(pathname)) {
        mutations.push({ method: request.method(), pathname });
      }
    });
    let runDaemon: StartedDaemon | null = null;
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      const testDir = resolve(join(suiteDir, 'running-session-delete'));
      const actionCliHome = resolve(join(testDir, 'cli-home'));
      await mkdir(actionCliHome, { recursive: true });
      await writeFile(resolve(join(actionCliHome, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');
      runDaemon = await authenticateAndStartDaemon({
        page, testDir, cliHomeDir: actionCliHome, serverUrl: serverUrl, uiBaseUrl,
        extraEnv: {
          HOME: actionCliHome,
          HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: testDir,
          HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
          HAPPIER_E2E_FAKE_CLAUDE_LOG: resolve(join(testDir, 'fake-claude.jsonl')),
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-delete-session-${run.runId}`,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-delete-invocation-${run.runId}`,
        },
      });
      daemon = runDaemon;
      const activeDaemon = runDaemon;
      const machineId = await waitForDaemonMachineIdFromCliSettings({ cliHomeDir: actionCliHome });
      const serverId = await resolveCanonicalServerIdForUi(serverUrl);
      const repoDir = resolve(join(testDir, 'repo'));
      await createGitRepoWithChanges({ repoDir, fileCount: 1 });
      const sessionId = await spawnSessionFromDaemon({
        daemon: activeDaemon, directory: repoDir, browserAccess: { page, serverUrl: serverUrl },
      });
      const deleteTransport = bindHomeDomainActionHttpRequestV1('session.delete', { sessionId });
      const row = page.getByTestId(sessionListRowTestId(serverId, sessionId));
      await page.goto(`${uiBaseUrl}/session/${sessionId}?happier_hmr=0`, { waitUntil: 'domcontentloaded' });
      const menu = page.getByTestId('session-header-action-menu-trigger');
      await expect(menu).toBeVisible({ timeout: 120_000 });
      await page.getByTestId('session-composer-input').fill(`running delete ${run.runId}`);
      const send = page.getByTestId('session-composer-send');
      await expect(send).toBeEnabled();
      await send.click();
      await expect(page.getByText('FAKE_CLAUDE_OK_1').first()).toBeVisible({ timeout: 120_000 });
      await menu.click();
      for (const action of ['stop', 'archive', 'delete']) {
        await expect(page.getByTestId(`dropdown-option-ui_session_${action}`)).toBeVisible();
      }
      await expect(page.getByTestId('session-header-info-button')).toBeVisible();
      const runtimePath = testInfo.outputPath('loaded-session-runtime.json');
      await writeFile(runtimePath, JSON.stringify({
        mode: ui.mode, uiUrl: page.url(), serverUrl: serverUrl,
        servingProcess: ui.proc ? { pid: ui.proc.child.pid, argv: ui.proc.child.spawnargs } : { pid: process.pid, argv: process.argv },
        scripts: await page.locator('script[src]').evaluateAll((scripts) => scripts.map((script) => script.getAttribute('src'))),
      }));
      await testInfo.attach('loaded-session-runtime', { path: runtimePath, contentType: 'application/json' });
      await page.screenshot({ path: testInfo.outputPath('running-session-delete-menu.png') });

      const stopCalls = () => rpc.calls().filter((call) => call.method === `${machineId}:${RPC_METHODS.STOP_SESSION}`
        || call.method === `${sessionId}:killSession`);
      const confirm = page.getByTestId('web-modal-confirm');
      await test.step('cancelling the single header confirmation leaves the running Session intact', async () => {
        const stopsBefore = stopCalls().length;
        await page.getByTestId('dropdown-option-ui_session_delete').click();
        await expect(confirm).toHaveCount(1);
        await page.screenshot({ path: testInfo.outputPath('running-session-delete-confirmation.png') });
        await page.getByTestId('web-modal-cancel').click();
        await expect(confirm).toHaveCount(0);
        await expect(row).toBeVisible();
        expect(stopCalls()).toHaveLength(stopsBefore);
        expect(mutations).toEqual([]);
        await expect.poll(() => new URL(page.url()).pathname).toBe(`/session/${sessionId}`);
      });

      await test.step('a Stop refusal through the row menu preserves the Session and never deletes it', async () => {
        // A real relay authorization refusal must settle without invoking runner fallback.
        rpc.setMethodResponse({ method: `${machineId}:${RPC_METHODS.STOP_SESSION}`,
          ack: { ok: false, error: 'Forbidden', errorCode: RPC_ERROR_CODES.FORBIDDEN } });
        await openSessionListRowMenu(page, { serverId, sessionId });
        await selectSessionListRowMenuItem(page, 'ui_session_delete');
        await expect(confirm).toHaveCount(1);
        await expect(confirm).toBeEnabled();
        await confirm.click();
        const dismiss = page.getByTestId('web-modal-button-0');
        await expect(dismiss).toBeVisible();
        expect(stopCalls().some((call) => call.injected)).toBe(true);
        expect(mutations).toEqual([]);
        await expect(row).toBeVisible();
        await expect.poll(() => new URL(page.url()).pathname).toBe(`/session/${sessionId}`);
        await page.screenshot({ path: testInfo.outputPath('stop-failure-preserves-running-session.png') });
        await dismiss.click();
        rpc.setMethodResponse(null);
      });

      await test.step('the real lifecycle retires the runner, deletes once, and leaves the deleted view', async () => {
        await menu.click();
        await expect(page.getByTestId('dropdown-option-ui_session_stop')).toBeVisible();
        await page.getByTestId('dropdown-option-ui_session_delete').click();
        await expect(confirm).toHaveCount(1);
        await expect(confirm).toBeEnabled();
        const deleted = page.waitForResponse((response) => response.request().method() === deleteTransport.method
          && new URL(response.url()).pathname === deleteTransport.path);
        await confirm.click();
        expect((await deleted).ok()).toBe(true);
        await expect.poll(() => new URL(page.url()).pathname).not.toBe(`/session/${sessionId}`);
        await expect(row).toHaveCount(0);
        await expect(menu).toHaveCount(0);
        expect(stopCalls().some((call) => !call.injected)).toBe(true);
        expect(mutations).toEqual([{ method: deleteTransport.method, pathname: deleteTransport.path }]);
        await page.screenshot({ path: testInfo.outputPath('stop-delete-leaves-session-view.png') });
      });

      await test.step('Archive remains an independent operation for another running Session', async () => {
        const archiveSessionId = await spawnSessionFromDaemon({
          daemon: activeDaemon, directory: repoDir, browserAccess: { page, serverUrl: serverUrl },
        });
        await page.goto(`${uiBaseUrl}/session/${archiveSessionId}?happier_hmr=0`, { waitUntil: 'domcontentloaded' });
        await expect(menu).toBeVisible({ timeout: 120_000 });
        await menu.click();
        await expect(page.getByTestId('dropdown-option-ui_session_stop')).toBeVisible();
        await expect(page.getByTestId('dropdown-option-ui_session_delete')).toBeVisible();
        const archived = page.waitForResponse((response) => response.request().method() === 'POST'
          && new URL(response.url()).pathname === `/v2/sessions/${archiveSessionId}/archive` && response.ok());
        await page.getByTestId('dropdown-option-ui_session_archive').click();
        await expect(confirm).toHaveCount(1);
        await expect(confirm).toBeEnabled();
        await confirm.click();
        expect((await archived).ok()).toBe(true);
        await expect(page.getByTestId(sessionListRowTestId(serverId, archiveSessionId))).toHaveCount(0);
        expect(mutations.filter((mutation) => mutation.method === 'DELETE'))
          .toEqual([{ method: deleteTransport.method, pathname: deleteTransport.path }]);
      });
    } catch (error) {
      throw appendBrowserDiagnostics(error, browserDiagnostics());
    } finally {
      const diagnostics = browserDiagnostics();
      await runDaemon?.stop().catch(() => {});
      if (daemon === runDaemon) daemon = null;
      const diagnosticsPath = testInfo.outputPath('browser-diagnostics.txt');
      await writeFile(diagnosticsPath, diagnostics);
      await testInfo.attach('browser-diagnostics', { path: diagnosticsPath, contentType: 'text/plain' });
    }
  });

  test('History Clear stops and deletes a running native Voice conversation', async ({ page }, testInfo) => {
    test.setTimeout(900_000);
    if (!server || !ui || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const serverUrl = server.baseUrl;
    const browserDiagnostics = collectBrowserDiagnostics({ page });
    const testDir = resolve(join(suiteDir, 'voice-history-clear'));
    const actionCliHome = resolve(join(testDir, 'cli-home'));
    const controlText = `History Clear native control ${run.runId}`;
    const progress = { controlCompleted: false, carrierSeeded: false, historyVisible: false, clearSubmitted: false };
    let runDaemon: StartedDaemon | null = null;
    let sessionId: string | null = null;
    let accountMode: string | null = null;
    let terminalServerStatus: number | null = null;
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await mkdir(actionCliHome, { recursive: true });
      await writeFile(join(actionCliHome, 'AGENTS.md'), '# UI e2e fixture\n', 'utf8');
      runDaemon = await authenticateAndStartDaemon({
        page, testDir, cliHomeDir: actionCliHome, serverUrl, uiBaseUrl,
        extraEnv: {
          HOME: actionCliHome,
          HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: testDir,
          HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
          HAPPIER_E2E_FAKE_CLAUDE_LOG: join(testDir, 'fake-claude.jsonl'),
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-history-clear-${run.runId}`,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-history-clear-invocation-${run.runId}`,
        },
      });
      daemon = runDaemon;
      const activeDaemon = runDaemon;
      const trackedSessions = async () => {
        const response = await daemonControlPostJson<{ children: readonly { happySessionId?: string }[] }>({
          port: activeDaemon.state.httpPort, path: '/list', controlToken: activeDaemon.state.controlToken,
        });
        expect(response.status).toBe(200);
        return response.data.children;
      };
      const repoDir = join(testDir, 'repo');
      await createGitRepoWithChanges({ repoDir, fileCount: 1 });
      sessionId = await spawnSessionFromDaemon({ daemon: activeDaemon, directory: repoDir, browserAccess: { page, serverUrl } });
      await page.goto(`${uiBaseUrl}/session/${sessionId}?happier_hmr=0`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('session-composer-input')).toBeVisible({ timeout: 120_000 });
      await page.getByTestId('session-composer-input').fill(controlText);
      await expect(page.getByTestId('session-composer-send')).toBeEnabled();
      await page.getByTestId('session-composer-send').click();
      await expect(page.getByText('FAKE_CLAUDE_OK_1').first()).toBeVisible({ timeout: 120_000 });
      expect((await trackedSessions()).some(child => child.happySessionId === sessionId)).toBe(true);
      progress.controlCompleted = true;

      // Seed only the Voice owner marker through the real metadata API. The native
      // runner, workspace, shared ciphertext and the real control turn stay intact.
      const accessKey = await readCliAccessKey(actionCliHome);
      if (!accessKey) throw new Error('missing paired fixture credentials');
      const headers = { Authorization: `Bearer ${accessKey.token}`,
        ...buildAccountStoredContentCompatibilityHttpHeadersV1(CURRENT_ACCOUNT_STORED_CONTENT_COMPATIBILITY_DECLARATION) };
      const modeResponse = await fetchJson<unknown>(`${serverUrl}/v1/account/encryption`, { headers });
      expect(modeResponse.status).toBe(200);
      const accountEncryption = AccountEncryptionModeResponseSchema.parse(modeResponse.data);
      accountMode = accountEncryption.mode;
      expect(accountMode).toBe('e2ee');
      const session = await fetchSessionV2(serverUrl, accessKey.token, sessionId);
      expect(session.active).toBe(true);
      expect(session.metadataLayoutVersion).toBe(1);
      const expectedOwnerMetadata = SessionOwnerMetadataEnvelopeV1Schema.parse(session.ownerMetadata);
      const material = accountScopedCryptoMaterialFromCliAccessKey(accessKey);
      const opened = openSessionOwnerMetadataEnvelopeV1({ accountMode: accountEncryption.mode, envelope: expectedOwnerMetadata, material });
      if (!opened.ok) throw new Error(`cannot open native Voice fixture owner metadata: ${opened.reason}`);
      await patchSessionMetadataEnvelopeTupleV1({ baseUrl: serverUrl, token: accessKey.token, sessionId, patch: {
        mode: 'owner', metadataLayoutVersion: 1, expectedOwnerMetadata,
        sharedMetadata: { ciphertext: session.metadata, expectedVersion: session.metadataVersion },
        ownerMetadata: sealSessionOwnerMetadataEnvelopeV1({ material, randomBytes, ownerMetadata: {
          ...opened.ownerMetadata,
          system: { ...opened.ownerMetadata.system,
            ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }),
          },
        } }),
        agentState: { ciphertext: session.agentState, expectedVersion: session.agentStateVersion },
      } });
      progress.carrierSeeded = true;

      await page.goto(`${uiBaseUrl}/settings/voice?happier_hmr=0`, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('settings.voice.intent.history')).toBeVisible({ timeout: 120_000 });
      await page.getByTestId('settings.voice.intent.history').click();
      const history = page.getByTestId('voice-history-screen');
      await expect(history).toBeVisible({ timeout: 120_000 });
      const conversation = page.getByTestId(`voice-history-conversation-${sessionId}`);
      await expect(conversation).toBeVisible({ timeout: 120_000 });
      // History opens native conversations in their real Session transcript.
      await conversation.click();
      await expect(page.getByText(controlText, { exact: true })).toBeVisible({ timeout: 120_000 });
      await expect(page.getByText('FAKE_CLAUDE_OK_1', { exact: true }).first()).toBeVisible({ timeout: 120_000 });
      await page.goBack({ waitUntil: 'domcontentloaded' });
      await expect(history).toBeVisible({ timeout: 120_000 });
      await expect(conversation).toBeVisible({ timeout: 120_000 });
      progress.historyVisible = true;
      await page.screenshot({ path: testInfo.outputPath('voice-history-before-clear.png') });

      await expect(page.getByTestId('voice-history-clear')).toBeEnabled();
      await page.getByTestId('voice-history-clear').click();
      const confirm = page.getByTestId('web-modal-confirm');
      await expect(confirm).toHaveCount(1);
      await expect(confirm).toBeEnabled();
      await confirm.click();
      progress.clearSubmitted = true;
      await expect(conversation).toHaveCount(0, { timeout: 120_000 });
      await expect.poll(async () => (await trackedSessions()).some(child => child.happySessionId === sessionId),
        { timeout: 120_000 }).toBe(false);
      const deleted = await fetchJson<unknown>(`${serverUrl}/v2/sessions/${sessionId}`, {
        headers,
      });
      terminalServerStatus = deleted.status;
      expect(terminalServerStatus).toBe(404);
      await page.screenshot({ path: testInfo.outputPath('voice-history-after-clear.png') });
    } catch (error) {
      throw appendBrowserDiagnostics(error, browserDiagnostics());
    } finally {
      const evidencePath = testInfo.outputPath('voice-history-clear-runtime.json');
      await writeFile(evidencePath, JSON.stringify({
        dbProvider, accountMode, sessionId, progress, terminalServerStatus, serverUrl, uiMode: ui.mode,
        uiUrl: page.url(), daemonPid: runDaemon?.state.pid ?? null,
        actionMessage: await page.getByTestId('voice-history-action-message').allTextContents().catch(() => []),
        servingProcess: ui.proc ? { pid: ui.proc.child.pid, argv: ui.proc.child.spawnargs } : null,
      }, null, 2));
      await testInfo.attach('voice-history-clear-runtime', { path: evidencePath, contentType: 'application/json' });
      const diagnosticsPath = testInfo.outputPath('browser-diagnostics.txt');
      await writeFile(diagnosticsPath, browserDiagnostics());
      await testInfo.attach('browser-diagnostics', { path: diagnosticsPath, contentType: 'text/plain' });
      await runDaemon?.stop().catch(() => {});
      if (daemon === runDaemon) daemon = null;
    }
  });

  test('opens independent panes and preserves access across responsive layouts', async ({ page }, testInfo) => {
    test.setTimeout(900_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const browserDiagnostics = collectBrowserDiagnostics({ page });

    let runDaemon: StartedDaemon | null = null;
    try {
      await page.setViewportSize({ width: 1920, height: 900 });
      await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
      await waitForInitialAppUi({ page, browserDiagnostics });

      await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });

      const testDir = resolve(join(suiteDir, 't1-review-scroll'));
      await mkdir(testDir, { recursive: true });

      const fakeClaudeLogPath = resolve(join(testDir, 'fake-claude.jsonl'));
      const fakeClaudePath = fakeClaudeFixturePath();

      runDaemon = await authenticateAndStartDaemon({
        page,
        testDir,
        cliHomeDir,
        serverUrl: server.baseUrl,
        uiBaseUrl,
        extraEnv: {
          HOME: cliHomeDir,
          // Machine-scoped RPC (used as a fallback when a newly-spawned session has no encryption context yet)
          // must be allowed to read the repo fixture directory.
          HAPPIER_MACHINE_RPC_WORKING_DIRECTORY: testDir,
          HAPPIER_CLAUDE_PATH: fakeClaudePath,
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
          HAPPIER_E2E_FAKE_CLAUDE_SESSION_ID: `fake-claude-session-${run.runId}`,
          HAPPIER_E2E_FAKE_CLAUDE_INVOCATION_ID: `fake-claude-invocation-${run.runId}`,
        },
      });
      daemon = runDaemon;

      const repoDir = resolve(join(testDir, 'repo'));
      await createGitRepoWithChanges({ repoDir, fileCount: 2 });

      const sessionId = await spawnSessionFromDaemon({ daemon: runDaemon, directory: repoDir });
      const sessionUrl = `${uiBaseUrl}/session/${sessionId}`;

      await mutateUiE2eScopedAccountSettings({ page, experiments: true, featureToggles: { 'terminal.embeddedPty': true } });
      await mutateUiE2eLocalSettings({ page, settingsPatch: { themePreference: 'light', embeddedTerminalDockLocation: 'bottom' } });
      await page.goto(sessionUrl, { waitUntil: 'domcontentloaded' });
      await test.step('copies session references without developer mode', async () => {
        const menu = page.getByTestId('session-header-action-menu-trigger');
        await expect(menu).toBeVisible({ timeout: 180_000 });
        await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
        await menu.click();
        await page.getByTestId('dropdown-option-session_copy').click();
        await page.getByTestId('dropdown-option-session_copyDebugInformation').click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toContain(`Happier session ID: ${sessionId}`);
        await menu.click();
        await page.getByTestId('dropdown-option-session_copy').click();
        await page.getByTestId('dropdown-option-session_copySessionId').click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(sessionId);
        await page.getByTestId('session-composer-input').fill('Check this session reference');
        const send = page.getByTestId('session-composer-send');
        await expect(send).toBeEnabled({ timeout: 60_000 });
        await send.click();
        await expect(page.getByText('FAKE_CLAUDE_OK_1').first()).toBeVisible({ timeout: 180_000 });
        await menu.click();
        await page.getByTestId('dropdown-option-session_copy').click();
        await page.screenshot({ path: testInfo.outputPath('session-copy-submenu.png') });
        await page.getByTestId('dropdown-option-session_copyProviderSessionId').click();
        await expect.poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toBe(`fake-claude-session-${run.runId}`);
      });

      const rail = page.getByTestId('session-action-rail');
      const review = page.getByTestId('session-action-rail:review');
      const files = page.getByTestId('session-action-rail:files');
      await expect(rail).toBeVisible({ timeout: 180_000 });
      await expect(rail).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      for (const edge of ['top', 'right', 'bottom', 'left']) {
        await expect(rail).toHaveCSS(`border-${edge}-width`, '0px');
      }
      await expect(page.getByTestId('session-header-right-sidebar-button')).toHaveCount(0);
      // These live dimensions prove the current rail bundle is loaded and its targets remain compact.
      expect((await rail.boundingBox())?.width).toBe(44);
      expect((await review.boundingBox())?.width).toBe(36);
      expect((await review.boundingBox())?.height).toBe(36);
      expect((await review.locator('svg').boundingBox())?.width).toBe(18);
      await expect(rightPaneLocator(page)).toHaveCount(0);
      await expect(detailsPaneLocator(page)).toHaveCount(0);
      await review.click();
      await expect(detailsPaneLocator(page)).toBeVisible();
      await expect(rightPaneLocator(page)).toHaveCount(0);
      const reviewTab = page.getByTestId(`session-details-tab-${toTestIdSafeValue('scmReview:working')}`);
      await expect(reviewTab).toBeVisible();
      await review.click();
      await expect(detailsPaneLocator(page)).toHaveCount(0);
      await review.click();
      await expect(reviewTab).toBeVisible();
      await test.step('Review content loads without opening the sidebar', async () => {
        await expect(page.getByTestId('scm-review-list')).toBeVisible({ timeout: resolveUiWebScriptFetchTotalTimeoutMs(process.env) });
        await expect(rightPaneLocator(page)).toHaveCount(0);
      });
      await files.click();
      await expect(rightPaneLocator(page)).toBeVisible();
      await expect(detailsPaneLocator(page)).toBeVisible();
      await expect(page.getByTestId('session-rightpanel-close')).toHaveCount(0);
      // The shared mobile badge counts the two modified small files and big.txt, excluding the untracked image.
      await expect(page.getByTestId('session-action-rail:git:badge')).toHaveText('3', { timeout: 60_000 });
      await page.mouse.move(0, 0);
      await review.blur();
      await expect(review).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      const activeMarker = review.locator('div').filter({ hasNot: page.locator('svg') });
      expect(await activeMarker.evaluateAll((nodes) => nodes.some((node) => {
        const style = getComputedStyle(node);
        return style.position === 'absolute' && style.width === '2px' && style.backgroundColor !== 'rgba(0, 0, 0, 0)';
      }))).toBe(true);
      await page.screenshot({ path: testInfo.outputPath('rail-light-wide.png') });
      await review.hover();
      await expect(review).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      const tooltip = page.getByRole('tooltip');
      await expect(tooltip).toBeVisible();
      const tooltipBox = await tooltip.boundingBox();
      const reviewBox = await review.boundingBox();
      expect(tooltipBox!.x + tooltipBox!.width).toBeLessThanOrEqual(reviewBox!.x);
      expect(reviewBox!.x - tooltipBox!.x - tooltipBox!.width).toBeLessThanOrEqual(12);
      await page.screenshot({ path: testInfo.outputPath('rail-tooltip.png') });
      await review.focus();
      await expect(review).toBeFocused();
      await page.keyboard.press('Tab');
      await expect(files).toBeFocused();
      await page.screenshot({ path: testInfo.outputPath('rail-keyboard-focus.png') });
      const terminal = page.getByTestId('session-action-rail:terminal');
      await expect(terminal).toBeVisible();
      await terminal.click();
      await expect(page.getByTestId('multi-pane-bottom-dock')).toBeVisible();
      await terminal.click();
      await expect(page.getByTestId('multi-pane-bottom-dock')).toHaveCount(0);
      await mutateUiE2eLocalSettings({ page, settingsPatch: { themePreference: 'dark' } });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(rail).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('scm-review-list')).toBeVisible({ timeout: resolveUiWebScriptFetchTotalTimeoutMs(process.env) });
      await expect(page.getByTestId('repository-tree-row-src')).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('rail-dark-wide.png') });
      await review.click();
      await expect(detailsPaneLocator(page)).toHaveCount(0);
      await page.setViewportSize({ width: 900, height: 900 });
      await expect(rail).toBeVisible();
      await page.getByTestId('session-action-rail:git').click();
      await review.click();
      await expect(page.getByTestId('multi-pane-details-overlay')).toBeVisible();
      // The host parks the right pane mounted to preserve its state while Review occludes it.
      await expect(page.getByTestId('multi-pane-right-overlay').locator('..')).toHaveCSS('opacity', '0');
      await files.click();
      await expect(detailsPaneLocator(page)).toHaveCount(0);
      await expect(rightPaneLocator(page)).toBeVisible();
      await expect(page.getByTestId('repository-tree-row-src')).toBeVisible({ timeout: 60_000 });
      await page.screenshot({ path: testInfo.outputPath('rail-narrow-files.png') });
      await mutateUiE2eLocalSettings({ page, settingsPatch: { embeddedTerminalDockLocation: 'sidebar' } });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(terminal).toBeVisible({ timeout: 60_000 });
      await terminal.click();
      await expect(rightPaneLocator(page)).toBeVisible();
      await review.click();
      await expect(page.getByTestId('multi-pane-details-overlay')).toBeVisible();
      // The host parks the right pane mounted to preserve its state while Review occludes it.
      await expect(page.getByTestId('multi-pane-right-overlay').locator('..')).toHaveCSS('opacity', '0');
      await terminal.click();
      await expect(detailsPaneLocator(page)).toHaveCount(0);
      await expect(rightPaneLocator(page)).toBeVisible();
      await review.click();
      await expect(reviewTab).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath('rail-narrow-review.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(sessionUrl, { waitUntil: 'domcontentloaded' });
      const mobileBar = page.getByTestId(`session-cockpit-tabbar-${sessionId}`);
      await expect(mobileBar).toBeVisible({ timeout: 60_000 });
      const mobileTabs = mobileBar.getByRole('tab');
      expect(await mobileTabs.count()).toBeGreaterThanOrEqual(5);
      const mobileBoxes = await mobileTabs.evaluateAll((tabs) => tabs.map((tab) => {
        const rect = tab.getBoundingClientRect();
        return { x: rect.x, width: rect.width };
      }));
      for (const [index, box] of mobileBoxes.entries()) {
        expect(box.width).toBeGreaterThanOrEqual(44);
        if (index > 0) {
          const previous = mobileBoxes[index - 1]!;
          expect(Math.abs(box.x - previous.x - previous.width)).toBeLessThanOrEqual(1);
        }
      }
      await page.screenshot({ path: testInfo.outputPath('mobile-cockpit-spacing.png') });
    } catch (error) {
      throw appendBrowserDiagnostics(error, browserDiagnostics());
    } finally {
      await runDaemon?.stop().catch(() => {});
      if (daemon === runDaemon) daemon = null;
    }
  });
});
