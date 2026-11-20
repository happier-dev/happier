import { test, expect, type Page } from '@playwright/test';
import { buildBackendTargetKeyV2 } from '@happier-dev/protocol/backends/targets/backendTargetRefV2';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { runLoggedCommand } from '../../src/testkit/process/spawnProcess';
import { startDatabaseWorkbenchPostgres } from '../../src/testkit/process/databaseWorkbenchPostgres';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { openNewSessionMachineSelection } from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });
const ACP_STUB_PROVIDER_PATH = resolve(repoRootDir(), 'packages/tests/fixtures/acp-stub-provider/acp-stub-provider.mjs');

async function createConfiguredAcpBackend(params: Readonly<{
  page: Page;
  uiBaseUrl: string;
  backendId: string;
}>): Promise<void> {
  await gotoDomContentLoadedWithRetries(params.page, `${params.uiBaseUrl}/settings/agents?happier_hmr=0`);
  await params.page.getByTestId('settings-agents-collection.addCustomAcp').click();
  await params.page.getByTestId('dropdown-option-acp').click();

  await expect(params.page.getByTestId('settings.acpCatalog.backendEditor.title')).toBeVisible();
  await params.page.getByTestId('settings.acpCatalog.backendEditor.title').fill('UI ACP Stub Backend');
  await params.page.getByTestId('settings.acpCatalog.backendEditor.editId').click();
  await params.page.getByTestId('settings.acpCatalog.backendEditor.id').fill(params.backendId);
  await params.page.getByTestId('settings.acpCatalog.backendEditor.name').fill(params.backendId);
  await params.page.getByTestId('settings.acpCatalog.backendEditor.command').fill(process.execPath);
  await params.page.getByTestId('settings.acpCatalog.backendEditor.args.add').click();
  await params.page.getByTestId('settings.acpCatalog.backendEditor.args.item.0').fill(ACP_STUB_PROVIDER_PATH);
  await params.page.getByTestId('settings.acpCatalog.backendEditor.supportsLoadSession').click();
  await expect(params.page.getByTestId('settings.acpCatalog.backendEditor.save')).toBeEnabled();
  await params.page.getByTestId('settings.acpCatalog.backendEditor.save').click();

  await expect(params.page).toHaveURL(new RegExp(`/settings/agents/custom/${params.backendId}`));
  await gotoDomContentLoadedWithRetries(params.page, `${params.uiBaseUrl}/settings/agents?happier_hmr=0`);
  await expect(params.page.locator(
    `[data-testid="settings-agents-collection.definition.${params.backendId}"], [data-testid="settings-agents-collection.custom.${params.backendId}"]`,
  )).toHaveCount(1, { timeout: 60_000 });
}

async function selectMachineForNewSession(params: Readonly<{
  page: Page;
  uiBaseUrl: string;
  backendTargetKey?: string;
}>): Promise<void> {
  const backendTargetKeyQuery = typeof params.backendTargetKey === 'string' && params.backendTargetKey.trim().length > 0
    ? `?backendTargetKey=${encodeURIComponent(params.backendTargetKey.trim())}`
    : '';

  await gotoDomContentLoadedWithRetries(params.page, `${params.uiBaseUrl}/new${backendTargetKeyQuery}`);
  await expect(params.page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 120_000 });
  await openNewSessionMachineSelection({ page: params.page, uiBaseUrl: params.uiBaseUrl });
  const anyMachine = params.page.locator('[data-testid^="new-session-machine:"], [data-testid^="new-session-machine-option:"]').first();
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
  let postgres: Awaited<ReturnType<typeof startDatabaseWorkbenchPostgres>> | null = null;
  let uiBaseUrl: string | null = null;

  test.beforeAll(async () => {
    test.setTimeout(900_000);
    await mkdir(cliHomeDir, { recursive: true });

    const patchVerifierUrl = pathToFileURL(resolve(repoRootDir(),
      'apps/ui/tools/postinstall/verifyReactNativeEnrichedMarkdownWebStreamingPatch.mjs')).href;
    await runLoggedCommand({
      command: process.execPath,
      args: ['--input-type=module', '--eval',
        `const { verifyUiPatchedDependencies } = await import(${JSON.stringify(patchVerifierUrl)}); verifyUiPatchedDependencies();`],
      cwd: repoRootDir(),
      stdoutPath: join(suiteDir, 'ui.patch-preflight.stdout.log'),
      stderrPath: join(suiteDir, 'ui.patch-preflight.stderr.log'),
    });

    const databaseUrl = process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL?.trim()
      || (postgres = await startDatabaseWorkbenchPostgres()).homeDatabaseUrl;
    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'postgres',
      extraEnv: {
        DATABASE_URL: databaseUrl,
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
      },
    });

    const uiEnv = {
      ...process.env,
      // Moving source assets use Metro's existing watcher and publication owner.
      CI: '0',
      HAPPIER_WORKSPACE_BUILD_MODE: 'source-dev',
      HAPPIER_UI_PLUGIN_ARTIFACT_INVENTORY: resolve(repoRootDir(), 'apps/ui/.expo/hstack/plugin-ui-inputs', run.runId, 'inventory.js'),
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-acp-catalog-${run.runId}`,
      HAPPIER_E2E_UI_WEB_MODE: 'metro',
      HAPPIER_E2E_UI_WEB_NO_DEV: '0',
    };
    const sourcePreparationUrl = pathToFileURL(resolve(repoRootDir(),
      'apps/ui/scripts/ensureWorkspacePackagesBuilt.mjs')).href;
    await runLoggedCommand({
      command: process.execPath,
      args: ['--input-type=module', '--eval',
        `const { prepareUiSourcePluginInventory } = await import(${JSON.stringify(sourcePreparationUrl)}); await prepareUiSourcePluginInventory();`],
      cwd: repoRootDir(),
      env: uiEnv,
      timeoutMs: null,
      stdoutPath: join(suiteDir, 'ui.source-preparation.stdout.log'),
      stderrPath: join(suiteDir, 'ui.source-preparation.stderr.log'),
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      skipWorkspacePrebuild: true,
      env: uiEnv,
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
    await postgres?.stop().catch(() => {});
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

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/agents?happier_hmr=0`);
    await expect(page.getByTestId('settings-agents-collection.addCustomAcp')).toHaveCount(1, { timeout: 60_000 });
  });

  test('adds a custom ACP agent, replies twice, resumes, stops, and removes its fixtures in one journey', async ({ page }, testInfo) => {
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
    const diagnostics = collectBrowserDiagnostics({ page });
    const backendTargetKey = buildBackendTargetKeyV2({ kind: 'agent',
      identity: CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1, definitionId: backendId });

    try {
      await createConfiguredAcpBackend({
        page,
        uiBaseUrl,
        backendId,
      });

      await selectMachineForNewSession({
        page,
        uiBaseUrl,
        backendTargetKey,
      });

      await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 60_000 });
      await page.getByTestId('new-session-composer-input').fill(`ACP_STUB_USAGE_UPDATE=${sentinel}-first`);
      await expect(page.getByTestId('new-session-composer-send')).toBeEnabled();
      await page.getByTestId('new-session-composer-send').click();

      const transcript = page.getByTestId('transcript-chat-list');
      await expect(page.locator('textarea[data-testid="session-composer-input"]:visible')).toHaveCount(1, { timeout: 180_000 });
      await expect(transcript.getByText(`ACP_STUB_USAGE_UPDATE_DONE ${sentinel}-first`, { exact: true })).toHaveCount(1, { timeout: 120_000 });
      const sessionPath = new URL(page.url()).pathname;
      expect(sessionPath).toMatch(/^\/session\/[^/]+$/);
      await testInfo.attach('loaded-custom-acp-runtime', { contentType: 'application/json', body: JSON.stringify({
        serverUrl: server.baseUrl, daemonPid: daemon.state.pid, uiMode: ui?.mode,
        uiPid: ui?.proc?.child.pid, sessionPath, backendTargetKey,
      }) });

      const sendReply = async (marker: string) => {
        await page.getByTestId('session-composer-input').fill(`ACP_STUB_USAGE_UPDATE=${marker}`);
        await expect(page.getByTestId('session-composer-send')).toBeEnabled();
        await page.getByTestId('session-composer-send').click();
        await expect(transcript.getByText(`ACP_STUB_USAGE_UPDATE_DONE ${marker}`, { exact: true })).toHaveCount(1, { timeout: 120_000 });
        expect(new URL(page.url()).pathname).toBe(sessionPath);
      };
      const stopSession = async () => {
        await page.getByTestId('session-header-action-menu-trigger').click();
        await page.getByTestId('dropdown-option-ui_session_stop').click();
        await page.getByTestId('session-header-action-menu-trigger').click();
        await expect(page.getByTestId('dropdown-option-ui_session_resume')).toBeVisible({ timeout: 120_000 });
      };

      await test.step('second reply remains in the original Session', () => sendReply(`${sentinel}-second`));
      await test.step('Stop and Resume retain the conversation', async () => {
        await stopSession();
        await page.getByTestId('dropdown-option-ui_session_resume').click();
        await sendReply(`${sentinel}-resumed`);
        await expect(transcript.getByText(`ACP_STUB_USAGE_UPDATE_DONE ${sentinel}-first`, { exact: true })).toHaveCount(1);
        await expect(transcript.getByText(`ACP_STUB_USAGE_UPDATE_DONE ${sentinel}-second`, { exact: true })).toHaveCount(1);
      });
      await test.step('final Stop and explicit Session deletion clean up the runner', async () => {
        await stopSession();
        await page.getByTestId('dropdown-option-ui_session_delete').click();
        await expect(page.getByTestId('web-modal-confirm')).toBeEnabled();
        await page.getByTestId('web-modal-confirm').click();
        await expect.poll(() => new URL(page.url()).pathname).not.toBe(sessionPath);
      });
      await test.step('remove the custom ACP definition and verify the mounted collection', async () => {
        await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/agents/custom/${backendId}?happier_hmr=0`);
        await page.getByTestId('settings.acpCatalog.backendEditor.menu.trigger').click();
        await page.getByTestId('dropdown-option-delete').click();
        await expect.poll(() => new URL(page.url()).pathname).toBe('/settings/agents');
        const definitionRow = page.locator(
          `[data-testid="settings-agents-collection.definition.${backendId}"], [data-testid="settings-agents-collection.custom.${backendId}"]`,
        );
        await expect(definitionRow).toHaveCount(0);
        await page.reload({ waitUntil: 'domcontentloaded' });
        await expect(page.getByTestId('settings-agents-collection.addCustomAcp')).toBeVisible();
        await expect(definitionRow).toHaveCount(0);
      });
    } catch (error) {
      throw appendBrowserDiagnostics(error, diagnostics());
    }
  });
});
