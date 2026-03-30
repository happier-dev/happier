import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { gotoDomContentLoadedWithPathFallback, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: server override reachability', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('server-override-reachability-suite');

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;

  const uiWebEnv = {
    ...process.env,
    EXPO_PUBLIC_DEBUG: '1',
    // Start with an unreachable default so `?server=` must switch servers during the initial load.
    EXPO_PUBLIC_HAPPY_SERVER_URL: 'http://127.0.0.1:1',
    EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-server-override`,
  };

  test.beforeAll(async () => {
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
    await mkdir(suiteDir, { recursive: true });

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: uiWebEnv,
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(60_000);
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('connects without requiring a manual Retry click on first load', async ({ page }) => {
    test.setTimeout(240_000);
    if (!uiBaseUrl) throw new Error('missing ui base url');
    if (!server) throw new Error('missing server');

    await page.setViewportSize({ width: 1440, height: 900 });

    const url = `${uiBaseUrl}/?server=${encodeURIComponent(server.baseUrl)}`;
    await gotoDomContentLoadedWithPathFallback(page, url, '/');

    await expect(page.getByTestId('welcome-create-account')).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId('welcome-retry-server')).toHaveCount(0);
  });
});
