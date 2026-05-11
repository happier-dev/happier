import { type Page } from '@playwright/test';

import { startTestDaemon, type StartedDaemon } from '../daemon/daemon';
import { approveTerminalConnect } from './approveTerminalConnect';
import { startCliAuthLoginForTerminalConnect } from './cliTerminalConnect';
import { acknowledgeTerminalConnectSuccessIfPresent } from './acknowledgeTerminalConnectSuccessIfPresent';
import { gotoDomContentLoadedWithPathFallback, gotoDomContentLoadedWithRetries } from './pageNavigation';
import { ensureAccountReadyForConnect } from './ensureAccountReadyForConnect';

export async function authenticateAndStartDaemon(params: Readonly<{
  page: Page;
  testDir: string;
  cliHomeDir: string;
  serverUrl: string;
  uiBaseUrl: string;
  createAccount?: boolean;
  terminalConnectUrlTimeoutMs?: number;
  daemonStartupTimeoutMs?: number;
  extraEnv?: NodeJS.ProcessEnv;
}>): Promise<StartedDaemon> {
  await gotoDomContentLoadedWithRetries(params.page, params.uiBaseUrl);
  await ensureAccountReadyForConnect({
    page: params.page,
    timeoutMs: 120_000,
    clickCreateAccount: params.createAccount !== false,
  });

  const cliLogin = await startCliAuthLoginForTerminalConnect({
    testDir: params.testDir,
    cliHomeDir: params.cliHomeDir,
    serverUrl: params.serverUrl,
    webappUrl: params.uiBaseUrl,
    connectUrlTimeoutMs: params.terminalConnectUrlTimeoutMs,
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
    await gotoDomContentLoadedWithPathFallback(params.page, cliLogin.connectUrl, '/terminal/connect', 90_000);
    await approveTerminalConnect({ page: params.page });
    await cliLogin.waitForSuccess();
    await acknowledgeTerminalConnectSuccessIfPresent(params.page);
  } finally {
    await cliLogin.stop().catch(() => {});
  }

  return await startTestDaemon({
    testDir: params.testDir,
    happyHomeDir: params.cliHomeDir,
    startupTimeoutMs: params.daemonStartupTimeoutMs,
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
