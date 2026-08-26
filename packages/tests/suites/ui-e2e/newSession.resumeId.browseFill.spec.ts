import { test, expect } from '@playwright/test';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { startTestDaemon, type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startCliAuthLoginForTerminalConnect, type StartedCliTerminalConnect } from '../../src/testkit/uiE2e/cliTerminalConnect';
import { enableDirectSessionsFeature } from '../../src/testkit/uiE2e/enableDirectSessionsFeature';
import { createAccountAndReachConnectMachineState, gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { openNewSessionMachineSelection } from '../../src/testkit/uiE2e/createSessionFromNewSessionComposer';
import { selectNewSessionAgent } from '../../src/testkit/uiE2e/selectNewSessionAgent';
import { enableEnhancedSessionWizard } from '../../src/testkit/uiE2e/enableEnhancedSessionWizard';

const run = createRunDirs({ runLabel: 'ui-e2e' });

function jsonlLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function responseItemLine(params: { timestamp: string; payload: Record<string, unknown> }): string {
  return jsonlLine({ type: 'response_item', timestamp: params.timestamp, payload: params.payload });
}

test.describe('ui e2e: /new resume id browse fills from direct sessions', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('new-session-resume-id-browse-fill-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));
  const codexHomeDir = resolve(join(suiteDir, '.codex'));
  const remoteSessionId = '11111111-1111-1111-1111-111111111111';
  const rolloutFile = resolve(join(codexHomeDir, 'sessions', '2026', '03', '06', `rollout-2026-03-06T00-00-00-${remoteSessionId}.jsonl`));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let daemon: StartedDaemon | null = null;

  test.beforeAll(async () => {
    test.setTimeout(540_000);
    await mkdir(cliHomeDir, { recursive: true });
    await mkdir(resolve(join(codexHomeDir, 'sessions', '2026', '03', '06')), { recursive: true });
    await writeFile(
      rolloutFile,
      [
        jsonlLine({
          type: 'session_meta',
          payload: {
            id: remoteSessionId,
            timestamp: '2026-03-06T00:00:00.000Z',
            cwd: '/tmp/direct-codex-ui-project',
          },
        }),
        responseItemLine({
          timestamp: '2026-03-06T00:00:01.000Z',
          payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'older direct codex ui message' }] },
        }),
        responseItemLine({
          timestamp: '2026-03-06T00:00:02.000Z',
          payload: { type: 'message', role: 'assistant', content: [{ type: 'text', text: 'latest direct codex ui reply' }] },
        }),
      ].join(''),
      'utf8',
    );

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
        HAPPIER_PRESENCE_SESSION_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_MACHINE_TIMEOUT_MS: '60000',
        HAPPIER_PRESENCE_TIMEOUT_TICK_MS: '1000',
        HAPPIER_E2E_PROVIDER_SKIP_SERVER_SHARED_DEPS_BUILD: '1',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-resume-browse`,
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

  test('picks a provider session to fill the resume id in /new', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing server/ui fixtures');

    const testDir = resolve(join(suiteDir, 't1-new-session-resume-id-browse-fill'));
    await mkdir(testDir, { recursive: true });

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl, 180_000);
    await createAccountAndReachConnectMachineState({ page });

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
        HAPPIER_HOME_DIR: cliHomeDir,
        HAPPIER_SERVER_URL: server.baseUrl,
        HAPPIER_WEBAPP_URL: uiBaseUrl,
        HAPPIER_DISABLE_CAFFEINATE: '1',
        HAPPIER_VARIANT: 'dev',
        CODEX_HOME: codexHomeDir,
        HAPPIER_DIRECT_SESSIONS_PAGE_MAX_ITEMS: '50',
        HAPPIER_E2E_PROVIDER_USE_CLI_SOURCE_ENTRYPOINT: '1',
      },
    });

    await enableEnhancedSessionWizard({ page, baseUrl: uiBaseUrl, timeoutMs: 180_000 });
    await enableDirectSessionsFeature(page, uiBaseUrl);

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/new?happier_hmr=0`, 180_000);
    await expect(page.getByTestId('new-session-composer-input')).toHaveCount(1, { timeout: 180_000 });

    // Pick the first machine (if not already selected) so the browse modal is scoped. Agent availability can be
    // machine-scoped, so select the machine before choosing Codex.
    await expect(page.getByTestId('agent-input-machine-chip')).toHaveCount(1, { timeout: 60_000 });
    await openNewSessionMachineSelection({ page, uiBaseUrl });
    const activeMachinePopover = page.getByTestId('agent-input-content-popover');
    const machinePopoverOpened = await expect(activeMachinePopover)
      .toHaveCount(1, { timeout: 5_000 })
      .then(() => true, () => false);
    const machineOptionSelector = '[data-testid^="new-session-machine:"]:visible';
    const machineOption = machinePopoverOpened
      ? activeMachinePopover.locator(machineOptionSelector)
      : page.locator(machineOptionSelector);
    await expect(machineOption.first()).toBeVisible({ timeout: 120_000 });
    await machineOption.first().click();
    await page.waitForURL((url: URL) => url.pathname.endsWith('/new'), { timeout: 60_000 });

    // Select the Codex engine so the resume browse can find seeded Codex sessions.
    await selectNewSessionAgent({ page, agentId: 'codex' });

    // Open the resume chip popover and browse sessions.
    await expect(page.getByTestId('agent-input-resume-chip')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('agent-input-resume-chip').click();

    await expect(page.getByTestId('resume-id-browse-trigger')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('resume-id-browse-trigger').click();

    await expect(page.getByTestId('resume-id-browse-modal')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId(`direct-session-candidate:${remoteSessionId}`)).toHaveCount(1, { timeout: 120_000 });
    await page.getByTestId(`direct-session-candidate:${remoteSessionId}`).click();

    await expect(page.getByTestId('resume-id-browse-modal')).toHaveCount(0, { timeout: 60_000 });

    // Re-open the resume popover and ensure the input is filled with the selected remote session id.
    await page.getByTestId('agent-input-resume-chip').click();
    const resumeInput = page.getByTestId('resume-id-input');
    await expect(resumeInput).toHaveCount(1, { timeout: 60_000 });
    await expect(resumeInput).toHaveValue(remoteSessionId, { timeout: 60_000 });

    // Sanity check: appended file should not be required for browsing; but ensure the file can still change without breaking.
    await appendFile(
      rolloutFile,
      responseItemLine({
        timestamp: '2026-03-06T00:00:03.000Z',
        payload: { type: 'message', role: 'user', content: [{ type: 'text', text: 'tail appended direct codex ui message' }] },
      }),
      'utf8',
    );
  });
});
