import { test, expect } from '@playwright/test';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildBackendTargetKey } from '@happier-dev/protocol';

import { readCliAccessKey } from '../../src/testkit/cliAccessKey';
import { CLAUDE_CODE_E2E_OAUTH_SCOPE, createConnectedServiceProfile, startConnectedServiceRecoveryTokenServer, type ConnectedServiceRecoveryTokenServer } from '../../src/testkit/connectedServicesRecovery';
import { readFakeCodexAppServerRequestLog, writeFakeCodexAppServerScript } from '../../src/testkit/codexAppServerRemoteHarness';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { fakeClaudeFixturePath, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';
import { repoRootDir } from '../../src/testkit/paths';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { createRunDirs } from '../../src/testkit/runDir';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';
import { ensureUiFeatureEnabled } from '../../src/testkit/uiE2e/ensureUiFeatureEnabled';
import { gotoDomContentLoadedWithPathFallback, normalizeLoopbackBaseUrl, waitForAuthenticatedRouteUi } from '../../src/testkit/uiE2e/pageNavigation';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';

const run = createRunDirs({ runLabel: 'ui-e2e' });
// Reuse the composed cross-Agent transition contract's scenario budget.
const scenarioTimeoutMs = 900_000;

test.describe('UI e2e: armed Agent composer alignment', () => {
  const suiteDir = run.testDir('agent-transition-composer-alignment');
  const cliHomeDir = resolve(suiteDir, 'cli-home');
  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let daemon: StartedDaemon | null = null;
  let providerHttp: ConnectedServiceRecoveryTokenServer | null = null;

  test.beforeAll(async () => {
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(process.env));
    await mkdir(cliHomeDir, { recursive: true });
    // Reuse the existing fake HTTP provider owner for passive models/usage reads.
    providerHttp = await startConnectedServiceRecoveryTokenServer({ respond: (request) => ({
      status: 200,
      body: request.path.startsWith('/v1/models')
        ? { data: [{ id: 'claude-fixture-work', display_name: 'Fixture Claude Work', created_at: '2026-01-01T00:00:00Z' }], has_more: false }
        : { five_hour: { utilization: 67, resets_at: new Date(Date.now() + 3_600_000).toISOString() } },
    }) });
    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: '1',
        HAPPIER_FEATURE_CONNECTED_SERVICES__QUOTAS__ENABLED: '1',
        HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
      },
    });
    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPIER_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-composer-alignment`,
      },
    });
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    const cleanup = await Promise.allSettled([daemon?.stop(), ui?.stop(), server?.stop(), providerHttp?.stop()]);
    const failures = cleanup.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, 'Failed to stop owned composer-alignment fixtures');
  });

  test('projects Claude defaults and safety intent while Codex remains the running Session, then admits Send', async ({ page }) => {
    test.setTimeout(scenarioTimeoutMs);
    if (!server || !ui || !providerHttp) throw new Error('missing server/UI/provider fixtures');
    const uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    const diagnostics = collectBrowserDiagnostics({ page });
    const fakeClaudeLogPath = resolve(suiteDir, 'fake-claude.jsonl');
    const requestLogPath = resolve(suiteDir, 'fake-codex.requests.jsonl');
    const workspaceDir = resolve(suiteDir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });
    const codexBin = await writeFakeCodexAppServerScript({ dir: suiteDir, requestLogPath, emitRateLimitsOnTurnStart: true });
    console.info(`[Composer alignment fixture] UI and CLI development source: ${await realpath(repoRootDir())}`);

    try {
      daemon = await authenticateAndStartDaemon({
        page, testDir: suiteDir, cliHomeDir, serverUrl: server.baseUrl, uiBaseUrl,
        extraEnv: {
          CLAUDE_CONFIG_DIR: resolve(cliHomeDir, '.claude'),
          CODEX_HOME: resolve(cliHomeDir, '.codex'),
          HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
          ANTHROPIC_BASE_URL: new URL(providerHttp.tokenUrl).origin,
          HAPPIER_CONNECTED_SERVICES_ANTHROPIC_USAGE_URL: `${new URL(providerHttp.tokenUrl).origin}/api/oauth/usage`,
          HAPPIER_CODEX_BACKEND_MODE: 'appServer',
          HAPPIER_CODEX_APP_SERVER_BIN: codexBin,
          HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT: 'appServer',
        },
      });
      const access = await readCliAccessKey(cliHomeDir);
      if (!access) throw new Error('missing disposable terminal-connect credentials');
      const profileId = 'work';
      const workToken = `fixture-claude-work-${run.runId}`;
      await createConnectedServiceProfile({
        fixture: {
          serverBaseUrl: server.baseUrl,
          // The credential API helper consumes the bearer token only.
          auth: { token: access.token, publicKeyBase64: 'secret' in access ? '' : access.encryption.publicKey },
          accountSecret: 'secret' in access ? Buffer.from(access.secret, 'base64') : new Uint8Array(),
          machineKey: 'encryption' in access ? Buffer.from(access.encryption.machineKey, 'base64') : null,
        },
        serviceId: 'claude-subscription', profileId, providerEmail: 'work@example.test',
        accessToken: workToken, idToken: null, scope: CLAUDE_CODE_E2E_OAUTH_SCOPE, tokenType: 'Bearer',
      });
      await ensureUiFeatureEnabled({ page, baseUrl: uiBaseUrl, featureId: 'connectedServices' });
      await ensureUiFeatureEnabled({ page, baseUrl: uiBaseUrl, featureId: 'connectedServices.quotas' });

      // Configure the target's account default through the actual Settings UI.
      await gotoDomContentLoadedWithPathFallback(page,
        `${uiBaseUrl}/settings/connected-services/profile?serviceId=claude-subscription&profileId=${profileId}&happier_hmr=0`,
        '/settings/connected-services/profile');
      await page.getByTestId('connected-service-profile-action:edit-label').click();
      await page.getByTestId('web-prompt-input').fill('Work');
      await page.getByTestId('web-prompt-confirm').click();
      await gotoDomContentLoadedWithPathFallback(page,
        `${uiBaseUrl}/settings/providers/claude?happier_hmr=0`, '/settings/providers/claude');
      await page.getByTestId('settings-connected-services-default-auth-claude').click();
      await page.getByTestId('new-session.connected-services.selection-list:new-session-connected-services-root:option:connected-service:claude-subscription:profile:work').click();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('settings-connected-services-default-auth-claude')).toContainText('Work');

      const sessionId = await spawnSessionFromDaemon({ daemon, directory: workspaceDir, agent: 'codex' });
      const sessionPath = `/session/${encodeURIComponent(sessionId)}`;
      const targetUrl = `${uiBaseUrl}${sessionPath}?happier_hmr=0`;
      await gotoDomContentLoadedWithPathFallback(page, targetUrl, sessionPath);
      await waitForAuthenticatedRouteUi({ page, expectedPathname: sessionPath, targetUrl,
        requiredTestIds: ['session-composer-input'], browserDiagnostics: diagnostics });
      const composer = page.locator('textarea[data-testid="session-composer-input"]:visible');
      const sourceText = `CODEX_SOURCE_HISTORY_${run.runId}`;
      await composer.fill(sourceText);
      await page.getByTestId('session-composer-send').click();
      await expect.poll(async () => (await readFakeCodexAppServerRequestLog(requestLogPath))
        .some((request) => request.method === 'happier/test/turn/completed'
          && typeof request.params?.promptText === 'string'
          && request.params.promptText.includes(sourceText)), { timeout: scenarioTimeoutMs }).toBe(true);
      await expect(composer).toHaveValue('', { timeout: scenarioTimeoutMs });
      const authChip = page.getByTestId('session-connected-services-auth-chip');
      await expect(authChip).toHaveAttribute('data-auth-source', 'native');
      const usageBadge = page.getByTestId('agent-input-provider-usage-badge');
      await expect(usageBadge).toBeVisible({ timeout: scenarioTimeoutMs });
      const engineBadge = page.getByTestId('agent-input-agent-chip');
      await expect(engineBadge).toHaveText(/^gpt-5\.4$/i);
      const sourceUsageLabel = await usageBadge.getAttribute('aria-label');
      if (!sourceUsageLabel) throw new Error('missing source provider usage accessibility label');

      await page.getByTestId('agent-input-agent-chip').click();
      await page.getByTestId(`agent-input-chip-picker.top-selector-option:${buildBackendTargetKey({ kind: 'builtInAgent', agentId: 'claude' })}`).click();
      const runningCodex = page.getByTestId('agent-input-chip-picker.top-selector-option:engine:codex');
      await expect(runningCodex).toHaveAttribute('aria-label', /Codex.*Running this Session/i);
      await expect(page.getByTestId('model-picker-overlay-option:claude-fixture-work')).toContainText('Fixture Claude Work', { timeout: scenarioTimeoutMs });
      expect(providerHttp.requests().some((request) => request.path.startsWith('/v1/models'))).toBe(true);
      await page.getByTestId('model-picker-overlay-option:claude-fixture-work').click();
      await page.keyboard.press('Escape');
      await expect(engineBadge).toHaveText(/^gpt-5\.4$/i);
      await expect(authChip).toHaveAttribute('data-auth-source', 'connected');
      await expect(authChip).toContainText('Work');
      await authChip.click();
      await expect(page.getByTestId('agent-input-content-popover').locator('[aria-disabled="true"]').filter({ hasText: 'Work' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(usageBadge).toHaveAttribute('aria-label', sourceUsageLabel);
      await usageBadge.click();
      await expect(page.getByTestId('agent-input-provider-usage-popover')).toContainText('Codex');
      await page.keyboard.press('Escape');
      await expect(page.locator('[data-testid^="agent-input-session-mode-chip-label:"]')).toHaveCount(0);
      await expect(page.locator('[data-testid^="agent-input-config-option:"]')).toHaveCount(0);
      await page.getByTestId('agent-input-permission-chip').click();
      await page.getByTestId('permission-mode-safe-yolo').click();
      await page.keyboard.press('Escape');

      const targetText = `CLAUDE_TARGET_SEND_${run.runId}`;
      await composer.fill(targetText);
      await expect(page.getByTestId('session-composer-send')).toHaveAttribute('aria-label', /Continue with Claude/i);
      await page.getByTestId('session-composer-send').click();
      const invocation = await waitForFakeClaudeInvocation(fakeClaudeLogPath,
        (event) => event.mode === 'sdk', { timeoutMs: scenarioTimeoutMs });
      expect(invocation.argv).toContain('claude-fixture-work');
      expect(invocation.argv[invocation.argv.indexOf('--permission-mode') + 1]).toBe('auto');
      if (!invocation.claudeConfigDir) throw new Error('fake provider did not observe the target credential home');
      const credentials = JSON.parse(await readFile(join(invocation.claudeConfigDir, '.credentials.json'), 'utf8')) as { claudeAiOauth?: { accessToken?: string; refreshToken?: string } };
      expect(credentials.claudeAiOauth?.accessToken === workToken).toBe(true);
      // The daemon owns refresh credentials; the provider receives the native access-token file.
      expect(credentials.claudeAiOauth).not.toHaveProperty('refreshToken');
      await expect(page.getByText('FAKE_CLAUDE_OK_1', { exact: true })).toBeVisible({ timeout: scenarioTimeoutMs });
      await expect(composer).toHaveValue('', { timeout: scenarioTimeoutMs });
      await expect(engineBadge).toHaveText(/^(?:Fixture Claude Work|claude-fixture-work)$/, { timeout: scenarioTimeoutMs });
      await expect(page.getByText(targetText, { exact: true })).toBeVisible({ timeout: scenarioTimeoutMs });
      expect(new URL(page.url()).pathname).toBe(sessionPath);
    } catch (error) {
      throw appendBrowserDiagnostics(error, diagnostics());
    }
  });
});
