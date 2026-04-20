import { expect, type Page } from '@playwright/test';

import { startTestDaemon, type StartedDaemon } from '../daemon/daemon';
import { startCliAuthLoginForTerminalConnect } from './cliTerminalConnect';
import { acknowledgeTerminalConnectSuccessIfPresent } from './acknowledgeTerminalConnectSuccessIfPresent';
import { gotoDomContentLoadedWithRetries } from './pageNavigation';

export async function authenticateAndStartDaemon(params: Readonly<{
  page: Page;
  testDir: string;
  cliHomeDir: string;
  serverUrl: string;
  uiBaseUrl: string;
  createAccount?: boolean;
  extraEnv?: NodeJS.ProcessEnv;
}>): Promise<StartedDaemon> {
  await gotoDomContentLoadedWithRetries(params.page, params.uiBaseUrl);

  if (params.createAccount !== false) {
    await params.page.getByTestId('welcome-create-account').click();
  }

  await expect(params.page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

  const cliLogin = await startCliAuthLoginForTerminalConnect({
    testDir: params.testDir,
    cliHomeDir: params.cliHomeDir,
    serverUrl: params.serverUrl,
    webappUrl: params.uiBaseUrl,
    env: {
      ...process.env,
      ...(params.extraEnv ?? {}),
      CI: '1',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    },
  });

  try {
    await params.page.goto(cliLogin.connectUrl, { waitUntil: 'domcontentloaded' });
    const approveCount = await params.page.getByTestId('terminal-connect-approve').count();
    if (approveCount > 0) {
      await params.page.getByTestId('terminal-connect-approve').click();
    }
    await cliLogin.waitForSuccess();
    await acknowledgeTerminalConnectSuccessIfPresent(params.page);
  } finally {
    await cliLogin.stop().catch(() => {});
  }

  return await startTestDaemon({
    testDir: params.testDir,
    happyHomeDir: params.cliHomeDir,
    env: {
      ...process.env,
      ...(params.extraEnv ?? {}),
      CI: '1',
      HAPPIER_HOME_DIR: params.cliHomeDir,
      HAPPIER_SERVER_URL: params.serverUrl,
      HAPPIER_WEBAPP_URL: params.uiBaseUrl,
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_VARIANT: 'dev',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    },
  });
}
