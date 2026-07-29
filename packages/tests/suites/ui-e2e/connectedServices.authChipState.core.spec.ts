import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { createRunDirs } from '../../src/testkit/runDir';
import { acknowledgeTerminalConnectSuccessIfPresent } from '../../src/testkit/uiE2e/acknowledgeTerminalConnectSuccessIfPresent';
import { approveTerminalConnect } from '../../src/testkit/uiE2e/approveTerminalConnect';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { enableEnhancedSessionWizard } from '../../src/testkit/uiE2e/enableEnhancedSessionWizard';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import {
  gotoDomContentLoadedWithPathFallback,
  gotoDomContentLoadedWithRetries,
  normalizeLoopbackBaseUrl,
} from '../../src/testkit/uiE2e/pageNavigation';
import { setUiFeatureToggle } from '../../src/testkit/uiE2e/setUiFeatureToggle';
import { ensurePendingTerminalConnectReadyForApproval } from '../../src/testkit/uiE2e/terminalConnectApprovalFlow';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: connected-services auth chip state', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('connected-services-auth-chip-state-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    await mkdir(cliHomeDir, { recursive: true });

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
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

  test('exposes the effective native auth source as stable chip state', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl, 420_000);
    await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });

    const testDir = resolve(join(suiteDir, 'terminal-connect-daemon'));
    await mkdir(testDir, { recursive: true });

    const cliLogin: StartedCliTerminalConnect = await startCliAuthLoginForTerminalConnect({
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      webappUrl: uiBaseUrl,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
      },
    });

    const gotoConnectUrl = async (url: string, timeoutMs: number): Promise<void> => {
      await gotoDomContentLoadedWithPathFallback(page, url, '/terminal/connect', timeoutMs);
    };
    await gotoConnectUrl(cliLogin.connectUrl, 180_000);
    await ensurePendingTerminalConnectReadyForApproval({
      page,
      connectUrlForBrowser: cliLogin.connectUrl,
      gotoConnectUrl,
      restoreAccount: async () => {
        await ensureAccountReadyForConnect({
          page,
          timeoutMs: 120_000,
        });
      },
      timeoutMs: 180_000,
    });
    await approveTerminalConnect({ page });
    await cliLogin.waitForSuccess();

    await acknowledgeTerminalConnectSuccessIfPresent(page);

    daemon = await startTestDaemon({
      testDir,
      happyHomeDir: cliHomeDir,
      env: {
        ...process.env,
        CI: '1',
        HAPPIER_HOME_DIR: cliHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: uiBaseUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        HAPPIER_E2E_PROVIDER_SKIP_CLI_SHARED_DEPS_BUILD: '1',
      },
    });

    await enableEnhancedSessionWizard({ page, baseUrl: uiBaseUrl });
    await setUiFeatureToggle({
      page,
      baseUrl: uiBaseUrl,
      featureId: 'connectedServices',
      enabled: true,
      applyToAllScopes: true,
      reloadUrl: `${uiBaseUrl}/new?happier_hmr=0`,
    });
    await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 180_000 });

    const authChip = page.getByTestId('new-session-connected-services-auth-chip');
    await expect(authChip).toHaveCount(1, { timeout: 120_000 });
    await expect(authChip).toHaveAttribute('data-auth-source', 'native', { timeout: 10_000 });
  });
});
