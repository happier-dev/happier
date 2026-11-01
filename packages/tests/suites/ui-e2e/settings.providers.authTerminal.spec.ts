import { test, expect } from '@playwright/test';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';

const run = createRunDirs({ runLabel: 'ui-e2e' });
const fakeCodexPath = resolve(new URL('../../src/fixtures/fake-codex-auth-cli.js', import.meta.url).pathname);

async function writeExecutableCodexWrapper(params: Readonly<{
  targetPath: string;
  scriptPath: string;
}>): Promise<void> {
  const runtimePath = process.execPath.replaceAll('"', '\\"');
  const wrappedScriptPath = params.scriptPath.replaceAll('"', '\\"');
  const contents = process.platform === 'win32'
    ? `@echo off\r\n"${runtimePath}" "${wrappedScriptPath}" %*\r\n`
    : `#!/bin/sh\nexec "${runtimePath}" "${wrappedScriptPath}" "$@"\n`;
  await writeFile(params.targetPath, contents, 'utf8');
  if (process.platform !== 'win32') {
    await chmod(params.targetPath, 0o755);
  }
}

test.describe('ui e2e: provider settings auth status', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('settings-providers-auth-terminal-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let daemon: StartedDaemon | null = null;
  let uiBaseUrl: string | null = null;

  test.beforeAll(async () => {
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_SERVER_URL: server?.baseUrl ?? '',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-provider-auth-${run.runId}`,
      HAPPIER_E2E_UI_WEB_MODE: 'metro',
      HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS: process.env.HAPPIER_E2E_UI_WEB_SCRIPT_FETCH_TIMEOUT_MS ?? '480000',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    };
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
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
          ...uiWebEnv,
          EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
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

  test('persists positive integer Claude settings without step alignment errors', async ({ page }) => {
    test.setTimeout(180_000);
    if (!uiBaseUrl) throw new Error('missing ui base url');
    const browserDiagnostics = collectBrowserDiagnostics({ page });
    const settingsUrl = `${uiBaseUrl}/settings/providers/claude?happier_hmr=0`;
    try {
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`);
      await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });
      await gotoDomContentLoadedWithRetries(page, settingsUrl);
      const timeoutField = page.getByTestId('settings-provider-field-claudeLocalPermissionBridgeTimeoutSeconds');
      const thinkingField = page.getByTestId('settings-provider-field-claudeRemoteMaxThinkingTokens');
      await expect(timeoutField.locator('input')).toHaveValue('600');
      await expect(timeoutField).not.toContainText('Invalid number');
      for (const value of ['300', '900']) {
        await timeoutField.locator('input').fill(value);
        await expect(timeoutField).not.toContainText('Invalid number');
      }
      await thinkingField.locator('input').fill('1024');
      await expect(thinkingField).not.toContainText('Invalid number');
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings?happier_hmr=0`);
      await gotoDomContentLoadedWithRetries(page, settingsUrl);
      await expect(timeoutField.locator('input')).toHaveValue('900');
      await expect(thinkingField.locator('input')).toHaveValue('1024');
    } catch (error) {
      throw appendBrowserDiagnostics(error, browserDiagnostics());
    }
  });

  test('persists Codex reasoning summary generation independently of thinking display', async ({ page }) => {
    test.setTimeout(180_000);
    if (!uiBaseUrl) throw new Error('missing ui base url');
    const browserDiagnostics = collectBrowserDiagnostics({ page });
    const codexSettingsUrl = `${uiBaseUrl}/settings/providers/codex?happier_hmr=0`;
    const transcriptSettingsUrl = `${uiBaseUrl}/settings/session/transcript?happier_hmr=0`;
    const summaryField = page.getByTestId('settings-provider-field-codexReasoningSummaries');
    const thinkingField = page.getByTestId('settings-session-thinking-display-mode');

    try {
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`);
      await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });
      await gotoDomContentLoadedWithRetries(page, codexSettingsUrl);
      await expect(summaryField).toContainText('Default');

      await gotoDomContentLoadedWithRetries(page, transcriptSettingsUrl);
      await thinkingField.click();
      await page.getByTestId('dropdown-option-hidden').click();
      await expect(thinkingField).toContainText('Hidden');

      await gotoDomContentLoadedWithRetries(page, codexSettingsUrl);
      await summaryField.click();
      await page.getByTestId('dropdown-option-enabled').click();
      await expect(summaryField).toContainText('Enabled');

      await gotoDomContentLoadedWithRetries(page, transcriptSettingsUrl);
      await expect(thinkingField).toContainText('Hidden');
      await thinkingField.click();
      await page.getByTestId('dropdown-option-inline_full').click();
      await expect(thinkingField).toContainText('Inline');

      await gotoDomContentLoadedWithRetries(page, codexSettingsUrl);
      await expect(summaryField).toContainText('Enabled');

      for (const [optionId, selectedLabel] of [['disabled', 'Disabled'], ['default', 'Default']] as const) {
        await summaryField.click();
        await page.getByTestId(`dropdown-option-${optionId}`).click();
        await expect(summaryField).toContainText(selectedLabel);
        await gotoDomContentLoadedWithRetries(page, transcriptSettingsUrl);
        await expect(thinkingField).toContainText('Inline');
        await gotoDomContentLoadedWithRetries(page, codexSettingsUrl);
        await expect(summaryField).toContainText(selectedLabel);
      }
    } catch (error) {
      throw appendBrowserDiagnostics(error, browserDiagnostics());
    }
  });

  test('shows provider auth status in web settings and refreshes auth state', async ({ page }) => {
    test.setTimeout(180_000);
    if (!server || !uiBaseUrl) throw new Error('missing fixtures');
    await page.setViewportSize({ width: 1440, height: 900 });

    const testDir = resolve(join(suiteDir, 't1-provider-auth-terminal'));
    await mkdir(testDir, { recursive: true });
    const fakeCodexExecutablePath = resolve(join(
      testDir,
      process.platform === 'win32' ? 'fake-codex-auth.cmd' : 'fake-codex-auth',
    ));
    await writeExecutableCodexWrapper({
      targetPath: fakeCodexExecutablePath,
      scriptPath: fakeCodexPath,
    });

    let cliLogin: StartedCliTerminalConnect | null = null;
    try {
      await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
      await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });

      cliLogin = await startCliAuthLoginForTerminalConnect({
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
        },
      });

      await page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
      await expect(page.getByTestId('terminal-connect-approve')).toHaveCount(1, { timeout: 60_000 });
      await page.getByTestId('terminal-connect-approve').click();
      await cliLogin.waitForSuccess();

      daemon = await startTestDaemon({
        testDir,
        happyHomeDir: cliHomeDir,
        env: {
          ...process.env,
          CI: '1',
          HOME: cliHomeDir,
          HAPPIER_HOME_DIR: cliHomeDir,
          HAPPIER_SERVER_URL: server.baseUrl,
          HAPPIER_WEBAPP_URL: uiBaseUrl,
          HAPPIER_DISABLE_CAFFEINATE: '1',
          HAPPIER_VARIANT: 'dev',
          HAPPIER_CODEX_PATH: fakeCodexExecutablePath,
          HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
        },
      });

      await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
      await expect(page.getByTestId('session-getting-started-kind-start_daemon')).toHaveCount(0, { timeout: 120_000 });
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

      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/providers/codex`);
      await expect(page.getByTestId('settings-provider-detected-cli')).not.toContainText('Unknown', { timeout: 120_000 });
      const authStatus = page.getByTestId('settings-provider-auth-status');
      await expect(authStatus).toHaveCount(1, { timeout: 60_000 });
      await expect
        .poll(async () => (await authStatus.textContent()) ?? '', { timeout: 120_000 })
        .toMatch(/Unknown|Logged out/);
      await expect(page.getByTestId('settings-provider-auth-check-now')).toHaveCount(0, { timeout: 60_000 });
      await expect(page.getByTestId('settings-provider-auth-login')).toHaveCount(0, { timeout: 60_000 });
      await expect(page.getByTestId('provider-auth-terminal-root')).toHaveCount(0, { timeout: 30_000 });
      await expect(page.getByTestId('settings-provider-auth-reason')).toContainText('Missing credentials', { timeout: 60_000 });
    } finally {
      await cliLogin?.stop().catch(() => {});
    }
  });
});
