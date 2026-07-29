import { type Page } from '@playwright/test';

import { startTestDaemon, type StartedDaemon } from '../daemon/daemon';
import { approveTerminalConnect } from './approveTerminalConnect';
import { startCliAuthLoginForTerminalConnect } from './cliTerminalConnect';
import { acknowledgeTerminalConnectSuccessIfPresent } from './acknowledgeTerminalConnectSuccessIfPresent';
import { gotoCommittedWithRetries, gotoDomContentLoadedWithPathFallback } from './pageNavigation';
import { ensureAccountReadyForConnect } from './ensureAccountReadyForConnect';
import { ensurePendingTerminalConnectReadyForApproval } from './terminalConnectApprovalFlow';
import { waitForInitialAppUi } from './waitForInitialAppUi';
import { createAccountAndReachConnectMachineState } from './createAccountAndReachConnectMachineState';
import type { CliTestLaunchSpec } from '../process/cliLaunchSpec';

export async function authenticateAndStartDaemon(params: Readonly<{
  page: Page;
  testDir: string;
  cliHomeDir: string;
  serverUrl: string;
  uiBaseUrl: string;
  createAccount?: boolean;
  initialUiGotoTimeoutMs?: number;
  initialUiReadyTimeoutMs?: number;
  terminalConnectUrlTimeoutMs?: number;
  daemonStartupTimeoutMs?: number;
  extraEnv?: NodeJS.ProcessEnv;
  cliLaunchSpec?: CliTestLaunchSpec;
  variant?: 'dev' | 'stable';
}>): Promise<StartedDaemon> {
  await gotoCommittedWithRetries(params.page, params.uiBaseUrl, params.initialUiGotoTimeoutMs);
  await waitForInitialAppUi({
    page: params.page,
    timeoutMs: params.initialUiReadyTimeoutMs,
    reloadOnFailure: false,
  });
  if (params.createAccount === false) {
    await ensureAccountReadyForConnect({
      page: params.page,
      timeoutMs: 120_000,
      clickCreateAccount: false,
    });
  } else {
    await createAccountAndReachConnectMachineState({
      page: params.page,
      requirePersistedAuthCredentials: false,
    });
  }

  const cliLogin = await startCliAuthLoginForTerminalConnect({
    testDir: params.testDir,
    cliHomeDir: params.cliHomeDir,
    serverUrl: params.serverUrl,
    webappUrl: params.uiBaseUrl,
    cliLaunchSpec: params.cliLaunchSpec,
    connectUrlTimeoutMs: params.terminalConnectUrlTimeoutMs,
    env: {
      ...process.env,
      ...(params.extraEnv ?? {}),
      CI: '1',
      HAPPIER_DISABLE_CAFFEINATE: '1',
      HAPPIER_VARIANT: params.variant ?? 'dev',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    },
  });

  try {
    const gotoConnectUrl = async (url: string, timeoutMs: number): Promise<void> => {
      await gotoDomContentLoadedWithPathFallback(params.page, url, '/terminal/connect', timeoutMs);
    };
    await gotoConnectUrl(cliLogin.connectUrl, params.terminalConnectUrlTimeoutMs ?? 120_000);
    await ensurePendingTerminalConnectReadyForApproval({
      page: params.page,
      connectUrlForBrowser: cliLogin.connectUrl,
      gotoConnectUrl,
      restoreAccount: async () => {
        await ensureAccountReadyForConnect({
          page: params.page,
          timeoutMs: 120_000,
          clickCreateAccount: false,
        });
      },
      timeoutMs: params.terminalConnectUrlTimeoutMs,
    });
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
      HAPPIER_VARIANT: params.variant ?? 'dev',
      HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
    },
    cliLaunchSpec: params.cliLaunchSpec,
  });
}
