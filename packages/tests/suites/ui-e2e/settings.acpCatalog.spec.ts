import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { acknowledgeTerminalConnectSuccessIfPresent } from '../../src/testkit/uiE2e/acknowledgeTerminalConnectSuccessIfPresent';
import { openNewSessionMachineSelection } from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });
const ACP_STUB_PROVIDER_PATH = resolve(repoRootDir(), 'packages/tests/fixtures/acp-stub-provider/acp-stub-provider.mjs');

async function authenticateAndStartDaemon(params: Readonly<{
  page: Page;
  testDir: string;
  cliHomeDir: string;
  serverUrl: string;
  uiBaseUrl: string;
}>): Promise<StartedDaemon> {
  await gotoDomContentLoadedWithRetries(params.page, params.uiBaseUrl);
  await params.page.getByTestId('welcome-create-account').click();
  await expect(params.page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

  const cliLogin = await startCliAuthLoginForTerminalConnect({
    testDir: params.testDir,
    cliHomeDir: params.cliHomeDir,
    serverUrl: params.serverUrl,
    webappUrl: params.uiBaseUrl,
    env: {
      ...process.env,
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

async function createConfiguredAcpBackend(params: Readonly<{
  page: Page;
  uiBaseUrl: string;
  backendId: string;
}>): Promise<void> {
  await gotoDomContentLoadedWithRetries(params.page, `${params.uiBaseUrl}/settings/acp`);
  await expect(params.page.getByTestId('settings.acpCatalog.addBackend')).toHaveCount(1, { timeout: 60_000 });
  await params.page.getByTestId('settings.acpCatalog.addBackend').click();

  await expect(params.page.getByTestId('settings.acpCatalog.backendEditor.id')).toHaveCount(1, { timeout: 60_000 });
  await params.page.getByTestId('settings.acpCatalog.backendEditor.id').fill(params.backendId);
  await params.page.getByTestId('settings.acpCatalog.backendEditor.name').fill(params.backendId);
  await params.page.getByTestId('settings.acpCatalog.backendEditor.title').fill('UI ACP Stub Backend');
  await params.page.getByTestId('settings.acpCatalog.backendEditor.command').fill('node');
  await params.page.getByTestId('settings.acpCatalog.backendEditor.args').fill(ACP_STUB_PROVIDER_PATH);
  await params.page.getByTestId('settings.acpCatalog.backendEditor.save').click();

  await expect(params.page.getByTestId(`settings.acpCatalog.backend.${params.backendId}`)).toHaveCount(1, { timeout: 60_000 });
}

async function selectMachineForNewSession(params: Readonly<{
  page: Page;
  uiBaseUrl: string;
}>): Promise<void> {
  await gotoDomContentLoadedWithRetries(params.page, `${params.uiBaseUrl}/new`);
  await expect(params.page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 120_000 });
  await openNewSessionMachineSelection({ page: params.page, uiBaseUrl: params.uiBaseUrl });
  const anyMachine = params.page.locator('[data-testid^="new-session-machine:"]').first();
  await expect(anyMachine).toHaveCount(1, { timeout: 120_000 });
  await anyMachine.click();

  await params.page.waitForURL((url: URL) => url.pathname.endsWith('/new'), { timeout: 60_000 });
  await expect(params.page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 60_000 });
}

test.describe('ui e2e: ACP catalog settings', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('settings-acp-catalog-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let daemon: StartedDaemon | null = null;
  let uiBaseUrl: string | null = null;

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
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-acp-catalog-${run.runId}`,
        HAPPIER_E2E_UI_WEB_MODE: 'export',
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterEach(async () => {
    await daemon?.stop().catch(() => {});
    daemon = null;
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('renders the ACP catalog settings screen after auth and daemon startup', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing fixtures');

    const testDir = resolve(join(suiteDir, 't1-acp-catalog'));
    await mkdir(testDir, { recursive: true });
    daemon = await authenticateAndStartDaemon({
      page,
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      uiBaseUrl,
    });

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/acp`);
    await expect(page.getByTestId('settings.acpCatalog.builtIn.kiro')).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId('settings.acpCatalog.addBackend')).toHaveCount(1, { timeout: 60_000 });
  });

  test('creates and launches a configured ACP backend from the new-session flow', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing fixtures');

    const testDir = resolve(join(suiteDir, 't2-acp-catalog-new-session'));
    await mkdir(testDir, { recursive: true });

    daemon = await authenticateAndStartDaemon({
      page,
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      uiBaseUrl,
    });

    const backendId = 'ui-acp-stub-backend';
    const sentinel = `ui-e2e-${run.runId}`;

    await createConfiguredAcpBackend({
      page,
      uiBaseUrl,
      backendId,
    });

    await selectMachineForNewSession({ page, uiBaseUrl });
    await expect(page.getByTestId('agent-input-agent-chip')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('agent-input-agent-chip').click();
    await expect(page.getByTestId('chip-option-picker')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId(`chip-option-picker.option:acpBackend:${backendId}`)).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId(`chip-option-picker.option:acpBackend:${backendId}`).click();

    await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('new-session-composer-input').fill(`ACP_STUB_USAGE_UPDATE=${sentinel}`);
    await page.getByTestId('new-session-composer-input').press('Enter');

    const transcript = page.getByTestId('transcript-chat-list');
    await expect(page.locator('textarea[data-testid="session-composer-input"]:visible')).toHaveCount(1, { timeout: 180_000 });
    await expect(transcript.getByText(`ACP_STUB_USAGE_UPDATE_DONE ${sentinel}`)).toHaveCount(1, { timeout: 120_000 });
  });
});
