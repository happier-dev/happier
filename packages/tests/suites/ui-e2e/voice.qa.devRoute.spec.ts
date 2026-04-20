import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import {
  createAccountAndReachConnectMachineState,
  gotoDomContentLoadedWithPathFallback,
  normalizeLoopbackBaseUrl,
  waitForAuthenticatedRouteUi,
} from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: voice QA dev route', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('voice-qa-dev-route-suite');

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;

  test.beforeAll(async () => {
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-voice-qa-route-${run.runId}`,
      // This QA smoke only needs the live authenticated route; using Metro avoids the
      // multi-minute export build path and keeps the validation lane responsive.
      HAPPIER_E2E_UI_WEB_MODE: 'metro',
    };

    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
    await mkdir(suiteDir, { recursive: true });

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
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
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('renders the authenticated voice QA route with its stable controls', async ({ page }) => {
    test.setTimeout(360_000);
    if (!uiBaseUrl) throw new Error('missing ui fixture');

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithPathFallback(page, `${uiBaseUrl}/?happier_hmr=0`, '/', 120_000);
    await createAccountAndReachConnectMachineState({ page });

    await gotoDomContentLoadedWithPathFallback(
      page,
      `${uiBaseUrl}/dev/voice-qa?happier_hmr=0`,
      '/dev/voice-qa',
      120_000,
    );

    await waitForAuthenticatedRouteUi({
      page,
      expectedPathname: '/dev/voice-qa',
      requiredTestIds: [
        'voiceQa.sessionIdInput',
        'voiceQa.initialContextInput',
        'voiceQa.promptInput',
        'voiceQa.contextUpdateInput',
        'voiceQa.start',
        'voiceQa.stop',
        'voiceQa.clear',
        'voiceQa.send',
        'voiceQa.sendContext',
      ],
      blockedTestIds: ['welcome-create-account'],
      timeoutMs: 180_000,
    });

    await expect(page.getByTestId('voiceQa.openConversation')).toHaveCount(0);

    const sessionInput = page.getByTestId('voiceQa.sessionIdInput');
    const initialContextInput = page.getByTestId('voiceQa.initialContextInput');
    const promptInput = page.getByTestId('voiceQa.promptInput');
    const contextInput = page.getByTestId('voiceQa.contextUpdateInput');

    await sessionInput.fill('session-e2e-voice-qa');
    await initialContextInput.fill('initial context from ui e2e');
    await promptInput.fill('say hello from ui e2e');
    await contextInput.fill('follow-up context from ui e2e');

    await expect(sessionInput).toHaveValue('session-e2e-voice-qa');
    await expect(initialContextInput).toHaveValue('initial context from ui e2e');
    await expect(promptInput).toHaveValue('say hello from ui e2e');
    await expect(contextInput).toHaveValue('follow-up context from ui e2e');
  });
});
