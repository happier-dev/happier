import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });

async function enableEnhancedSessionWizardInSettings(page: Page, baseUrl: string) {
  await page.goto(`${baseUrl}/settings/features`, { waitUntil: 'domcontentloaded' });
  const enhancedWizardToggle = page.getByTestId('settings-feature-toggle-useEnhancedSessionWizard');
  await expect(enhancedWizardToggle).toHaveCount(1, { timeout: 60_000 });
  await enhancedWizardToggle.click();
}

test.describe('ui e2e: new-session agent picker testIDs', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-new-agentpicker-testids-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    // Expo web cold starts can take several minutes on developer machines (initial Metro + bundling).
    // Keep this generous so we fail on real errors, not just slow bundle readiness.
    test.setTimeout(900_000);
    await mkdir(cliHomeDir, { recursive: true });

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '1000',
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

  test('renders stable agent picker testIDs on /new', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto(uiBaseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('welcome-create-account').click();
    await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

    const testDir = resolve(join(suiteDir, 't1-connect-daemon'));
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
      },
    });

    await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('terminal-connect-approve').click();
    await cliLogin.waitForSuccess();

    try {
      const okButton = page.getByRole('button', { name: 'OK' });
      await expect(okButton).toBeVisible({ timeout: 5_000 });
      await okButton.click();
      await expect(okButton).toBeHidden({ timeout: 30_000 });
    } catch {
      // ignore missing/changed success dialog
    }

    await page.goto(`${uiBaseUrl}/`, { waitUntil: 'domcontentloaded' });

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
      },
    });

    await expect
      .poll(
        async () => {
          const createCount = await page.getByTestId('session-getting-started-kind-create_session').count();
          const selectCount = await page.getByTestId('session-getting-started-kind-select_session').count();
          return createCount > 0 || selectCount > 0;
        },
        { timeout: 180_000 },
      )
      .toBe(true);

    await enableEnhancedSessionWizardInSettings(page, uiBaseUrl);

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/new`);
    await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 180_000 });

    // The /new screen defaults to showing the compact AgentInput chips; click the agent chip to
    // scroll/reveal the full agent picker list where the row testIDs are attached.
    await expect(page.getByTestId('agent-input-agent-chip')).toHaveCount(1, { timeout: 120_000 });
    await page.getByTestId('agent-input-agent-chip').click();

    // Agent picker rows should expose stable testIDs.
    await expect(page.getByTestId('new-session-agent:codex')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('new-session-agent:claude')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('new-session-agent:opencode')).toHaveCount(1, { timeout: 60_000 });
  });
});
