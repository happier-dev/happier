import { test, expect } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  buildBackendTargetKeyV2,
  buildQualifiedPluginContributionKey,
  QualifiedConnectedAccountCredentialMutationSuccessV4Schema,
  sealQualifiedConnectedAccountContentEnvelope,
} from '@happier-dev/protocol';

import { readCliAccessKey } from '../../src/testkit/cliAccessKey';
import { createTestAuth } from '../../src/testkit/auth';
import { seedCliAuthForTestAccount } from '../../src/testkit/cliAuth';
import { CLAUDE_CODE_E2E_OAUTH_SCOPE, resolveQualifiedConnectedAccountServiceForLegacyServiceId, startConnectedServiceRecoveryTokenServer, type ConnectedServiceRecoveryTokenServer } from '../../src/testkit/connectedServicesRecovery';
import { readFakeCodexAppServerRequestLog, writeFakeCodexAppServerScript } from '../../src/testkit/codexAppServerRemoteHarness';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { fakeClaudeFixturePath, waitForFakeClaudeInvocation } from '../../src/testkit/fakeClaude';
import { fetchJson } from '../../src/testkit/http';
import { repoRootDir } from '../../src/testkit/paths';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { createRunDirs } from '../../src/testkit/runDir';
import { buildAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/buildAuthBootstrapStorageSnapshot';
import { installAuthBootstrapStorageSnapshot } from '../../src/testkit/uiE2e/readLegacyAuthSecretFromLocalStorage';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';
import { setUiFeatureToggle } from '../../src/testkit/uiE2e/setUiFeatureToggle';
import { gotoDomContentLoadedWithPathFallback, normalizeLoopbackBaseUrl, waitForAuthenticatedRouteUi } from '../../src/testkit/uiE2e/pageNavigation';
import { spawnSessionFromDaemon } from '../../src/testkit/uiE2e/spawnSessionFromDaemon';

const run = createRunDirs({ runLabel: 'ui-e2e' });
// The existing composed cross-Agent transition owns this scenario budget.
const scenarioTimeoutMs = 900_000;

test.describe('UI e2e: qualified Account armed composer alignment', () => {
  const suiteDir = run.testDir('qualified-agent-transition-composer-alignment');
  const cliHomeDir = resolve(suiteDir, 'cli-home');
  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let daemon: StartedDaemon | null = null;
  let providerHttp: ConnectedServiceRecoveryTokenServer | null = null;

  test.beforeAll(async () => {
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(process.env));
    await mkdir(cliHomeDir, { recursive: true });
    providerHttp = await startConnectedServiceRecoveryTokenServer({ respond: () => ({
      status: 200,
      body: { five_hour: { utilization: 67, resets_at: new Date(Date.now() + 3_600_000).toISOString() } },
    }) });
    server = await startServerLight({ testDir: suiteDir, dbProvider: 'sqlite', extraEnv: {
      HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
      HAPPIER_FEATURE_CONNECTED_SERVICES__ENABLED: '1',
      HAPPIER_FEATURE_CONNECTED_SERVICES__QUOTAS__ENABLED: '1',
      HAPPIER_E2E_PROVIDER_USE_SERVER_SOURCE_ENTRYPOINT: '1',
    } });
    ui = await startUiWeb({ testDir: suiteDir, env: {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPIER_SERVER_URL: server.baseUrl,
      EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-qualified-composer`,
    } });
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    const cleanup = await Promise.allSettled([daemon?.stop(), ui?.stop(), server?.stop(), providerHttp?.stop()]);
    const failures = cleanup.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, 'Failed to stop owned qualified composer fixtures');
  });

  test('projects the declared Claude subscription Account default and safety intent, then admits Send from Codex', async ({ page }) => {
    test.setTimeout(scenarioTimeoutMs);
    if (!server || !ui || !providerHttp) throw new Error('missing server/UI/provider fixtures');
    const uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
    const diagnostics = collectBrowserDiagnostics({ page });
    const fakeClaudeLogPath = resolve(suiteDir, 'fake-claude.jsonl');
    const requestLogPath = resolve(suiteDir, 'fake-codex.requests.jsonl');
    const workspaceDir = resolve(suiteDir, 'workspace');
    await mkdir(workspaceDir, { recursive: true });
    const codexBin = await writeFakeCodexAppServerScript({ dir: suiteDir, requestLogPath });
    console.info(`[Qualified composer fixture] UI and CLI development source: ${await realpath(repoRootDir())}; Claude purpose=model_upstream; dynamic model probe disabled, published static catalog`);

    try {
      // Reuse the current Settings browser fixture's real Account API/bootstrap boundary.
      // Home onboarding is a separate flow; this case exercises the in-session composer.
      const auth = await createTestAuth(server.baseUrl);
      await seedCliAuthForTestAccount({ cliHome: cliHomeDir, serverUrl: server.baseUrl, auth, mode: 'dataKey' });
      await installAuthBootstrapStorageSnapshot(page, buildAuthBootstrapStorageSnapshot({
        serverUrl: server.baseUrl, auth, mode: 'dataKey', storageScope: `e2e-${run.runId}-qualified-composer`,
      }));
      daemon = await startTestDaemon({
        testDir: suiteDir, happyHomeDir: cliHomeDir, snapshotDir: resolve(suiteDir, 'cli-source'),
        env: {
          ...process.env,
          CI: '1',
          HAPPIER_HOME_DIR: cliHomeDir,
          HAPPIER_SERVER_URL: server.baseUrl,
          HAPPIER_WEBAPP_URL: uiBaseUrl,
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_VARIANT: 'dev',
          HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
          CLAUDE_CONFIG_DIR: resolve(cliHomeDir, '.claude'),
          CODEX_HOME: resolve(cliHomeDir, '.codex'),
          HAPPIER_CLAUDE_PATH: fakeClaudeFixturePath(),
          HAPPIER_E2E_FAKE_CLAUDE_LOG: fakeClaudeLogPath,
          HAPPIER_CONNECTED_SERVICES_ANTHROPIC_USAGE_URL: `${new URL(providerHttp.tokenUrl).origin}/api/oauth/usage`,
          // The canonical opt-out keeps this live case free of external catalog calls.
          HAPPIER_CLAUDE_DYNAMIC_MODEL_PROBE_ENABLED: '0',
          HAPPIER_CODEX_BACKEND_MODE: 'appServer',
          HAPPIER_CODEX_APP_SERVER_BIN: codexBin,
          HAPPIER_CODEX_EXECUTION_RUN_TRANSPORT: 'appServer',
          HAPPIER_E2E_FAKE_CODEX_APP_SERVER_RATE_LIMITS_JSON: JSON.stringify({ rateLimits: {
            planType: 'team', primary: { usedPercent: 3, resetsAt: Math.floor(Date.now() / 1000) + 3_600 },
          } }),
        },
      });
      await gotoDomContentLoadedWithPathFallback(page, uiBaseUrl, '/');
      const access = await readCliAccessKey(cliHomeDir);
      if (!access) throw new Error('missing disposable terminal-connect credentials');
      const service = resolveQualifiedConnectedAccountServiceForLegacyServiceId('claude-subscription');
      const accountId = 'work';
      const workToken = `fixture-qualified-claude-work-${run.runId}`;
      const scopes = CLAUDE_CODE_E2E_OAUTH_SCOPE.split(' ');
      const content = sealQualifiedConnectedAccountContentEnvelope({
        kind: 'credential', accountMode: 'e2ee',
        material: 'secret' in access
          ? { type: 'legacy', secret: Buffer.from(access.secret, 'base64') }
          : { type: 'dataKey', machineKey: Buffer.from(access.encryption.machineKey, 'base64') },
        payload: { v: 1, values: {
          accessToken: workToken, refreshToken: 'fixture-refresh', scopes: JSON.stringify(scopes),
          expiresAtMs: String(Date.now() + 3_600_000),
        } },
        randomBytes: (length) => randomBytes(length),
      });
      const created = await fetchJson<unknown>(`${server.baseUrl}/v4/connect/qualified/credential`, {
        method: 'POST', headers: { Authorization: `Bearer ${access.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: { service, accountId }, authenticationModeId: 'oauth',
          expectedCredentialRevision: null, content,
          metadata: { displayName: 'Work', providerIdentity: { email: 'work@example.test' }, scopes },
        }),
      });
      expect(created.status).toBe(200);
      expect(QualifiedConnectedAccountCredentialMutationSuccessV4Schema.safeParse(created.data).success).toBe(true);
      await setUiFeatureToggle({ page, baseUrl: uiBaseUrl, featureId: 'connectedServices', enabled: true, applyToAllScopes: true });
      await setUiFeatureToggle({ page, baseUrl: uiBaseUrl, featureId: 'connectedServices.quotas', enabled: true, applyToAllScopes: true });

      // The evolved Settings owner writes qualified purpose bindings, consumed by the daemon.
      await gotoDomContentLoadedWithPathFallback(page,
        `${uiBaseUrl}/settings/agents/claude?pluginId=happier.agent.claude&happier_hmr=0`, '/settings/agents/claude');
      await page.getByTestId('settings-connected-services-default-auth-claude').click();
      await page.getByTestId(`new-session.connected-services.selection-list:new-session-connected-services-root:option:connected-service:${encodeURIComponent(buildQualifiedPluginContributionKey(service))}:profile:${accountId}`).click();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('settings-connected-services-default-auth-claude')).toContainText('Work');

      const sessionId = await spawnSessionFromDaemon({ daemon, directory: workspaceDir, agent: 'codex' });
      const sessionPath = `/session/${encodeURIComponent(sessionId)}`;
      const targetUrl = `${uiBaseUrl}${sessionPath}?happier_hmr=0`;
      await gotoDomContentLoadedWithPathFallback(page, targetUrl, sessionPath);
      await waitForAuthenticatedRouteUi({ page, expectedPathname: sessionPath, targetUrl,
        requiredTestIds: ['session-composer-input'], browserDiagnostics: diagnostics });
      const composer = page.locator('textarea[data-testid="session-composer-input"]:visible');
      const sourceText = `CODEX_QUALIFIED_SOURCE_${run.runId}`;
      await composer.fill(sourceText);
      await page.getByTestId('session-composer-send').click();
      await expect.poll(async () => (await readFakeCodexAppServerRequestLog(requestLogPath))
        .some((request) => request.method === 'turn/start'
          && Array.isArray(request.params?.input)
          && request.params.input.some((part: unknown) => typeof part === 'object' && part !== null
            && 'text' in part && typeof part.text === 'string' && part.text.includes(sourceText))),
        { timeout: scenarioTimeoutMs }).toBe(true);
      await expect(page.getByText(new RegExp(`reply:[\\s\\S]*${sourceText}[\\s\\S]*done`))).toBeVisible({ timeout: scenarioTimeoutMs });
      await expect(composer).toHaveValue('', { timeout: scenarioTimeoutMs });
      const authChip = page.getByTestId('session-connected-services-auth-chip');
      await expect(authChip).toHaveAttribute('data-auth-source', 'native');
      const usageBadge = page.getByTestId('agent-input-provider-usage-badge');
      await expect(usageBadge).toBeVisible({ timeout: scenarioTimeoutMs });
      const sourceUsageLabel = await usageBadge.getAttribute('aria-label');
      if (!sourceUsageLabel) throw new Error('missing source quota accessibility label');

      await page.getByTestId('agent-input-agent-chip').click();
      await page.getByTestId(`agent-input-chip-picker.top-selector-option:${buildBackendTargetKeyV2({ kind: 'backend', backendId: 'claude' })}`).click();
      await expect(page.getByTestId('agent-input-chip-picker.top-selector-option:engine:codex')).toHaveAttribute('aria-label', /Codex.*Running this Session/i);
      await page.getByTestId('model-picker-overlay-option:claude-sonnet-4-6').click();
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('agent-input-agent-chip')).toContainText('Sonnet');
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

      const targetText = `CLAUDE_QUALIFIED_TARGET_${run.runId}`;
      await composer.fill(targetText);
      await expect(page.getByTestId('session-composer-send')).toHaveAttribute('aria-label', /Continue with Claude/i);
      await page.getByTestId('session-composer-send').click();
      const invocation = await waitForFakeClaudeInvocation(fakeClaudeLogPath, (event) => event.mode === 'sdk', { timeoutMs: scenarioTimeoutMs });
      expect(invocation.argv).toContain('claude-sonnet-4-6');
      expect(invocation.argv[invocation.argv.indexOf('--permission-mode') + 1]).toBe('auto');
      if (typeof invocation.claudeConfigDir !== 'string') throw new Error('fake provider did not observe target credential home');
      const credential = JSON.parse(await readFile(join(invocation.claudeConfigDir, '.credentials.json'), 'utf8')) as { claudeAiOauth?: { accessToken?: string; refreshToken?: string } };
      expect(credential.claudeAiOauth?.accessToken === workToken).toBe(true);
      expect(credential.claudeAiOauth).not.toHaveProperty('refreshToken');
      await expect(page.getByText('FAKE_CLAUDE_OK_1', { exact: true })).toBeVisible({ timeout: scenarioTimeoutMs });
      await expect(composer).toHaveValue('', { timeout: scenarioTimeoutMs });
      await expect(page.getByText(targetText, { exact: true })).toBeVisible({ timeout: scenarioTimeoutMs });
      expect(new URL(page.url()).pathname).toBe(sessionPath);
    } catch (error) {
      throw appendBrowserDiagnostics(error, diagnostics());
    }
  });
});
