import { test, expect } from '@playwright/test';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

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

test.describe('ui e2e: provider settings auth terminal', () => {
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

  test('opens provider login terminal and refreshes auth state', async ({ page }) => {
    test.setTimeout(420_000);
    if (!server || !uiBaseUrl) throw new Error('missing fixtures');

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
      await page.getByTestId('welcome-create-account').click();
      await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

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
      await expect(page.getByTestId('settings-provider-auth-check-now')).toHaveCount(1, { timeout: 60_000 });
      await expect
        .poll(async () => (await authStatus.textContent()) ?? '', { timeout: 120_000 })
        .toMatch(/Unknown|Logged out/);
      await expect(page.getByTestId('settings-provider-auth-login')).toHaveCount(1, { timeout: 60_000 });

      await page.getByTestId('settings-provider-auth-login').click();
      await expect(page.getByTestId('provider-auth-terminal-root')).toHaveCount(1, { timeout: 60_000 });
      await expect
        .poll(
          async () => ((await authStatus.textContent()) ?? '').includes('Logged in'),
          { timeout: 120_000 },
        )
        .toBe(true);
      await expect(page.getByTestId('provider-auth-terminal-root')).toHaveCount(0, { timeout: 120_000 });

      await expect(authStatus).toContainText('Logged in', { timeout: 120_000 });
      await expect(page.getByTestId('settings-provider-auth-login')).toContainText('Reauthenticate', { timeout: 60_000 });
      const accountRow = page.getByTestId('settings-provider-auth-account');
      if (await accountRow.count()) {
        await expect(accountRow).toContainText('fake-codex@example.test', { timeout: 60_000 });
      }
    } finally {
      await cliLogin?.stop().catch(() => {});
    }
  });
});
