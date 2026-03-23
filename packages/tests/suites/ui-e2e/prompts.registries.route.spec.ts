import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: prompts registries route', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('prompts-registries-route-suite');

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;

  test.beforeAll(async () => {
    test.setTimeout(240_000);
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
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(60_000);
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('renders the prompt registries settings screen', async ({ page }) => {
    test.setTimeout(240_000);
    if (!uiBaseUrl) throw new Error('missing ui base url');

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, uiBaseUrl);

    await page.getByTestId('welcome-create-account').click();
    await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });

    await page.goto(`${uiBaseUrl}/settings/prompts/registries`, { waitUntil: 'domcontentloaded' });

    await expect(page.getByTestId('promptRegistries.addGitSource')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('promptRegistries.addGitSource').click();
    await expect(page.getByTestId('promptRegistries.sourceTitle')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('promptRegistries.sourceUrl')).toHaveCount(1, { timeout: 60_000 });
  });
});
