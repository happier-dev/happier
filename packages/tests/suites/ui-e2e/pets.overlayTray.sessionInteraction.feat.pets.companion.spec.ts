import { test, expect } from '@playwright/test';

import { createRunDirs } from '../../src/testkit/runDir';
import {
  installDesktopPetOverlayBridgeProbe,
  readDesktopPetOverlayBridgeInvocations,
  createDesktopPetOverlayWindowState,
  type DesktopPetOverlayBridgeInvocation,
} from '../../src/testkit/pets/desktopPetOverlayBridgeProbe';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { setSingleAccountPetsEnabled, setSingleAccountUiFeatureToggle } from '../../src/testkit/pets/uiPetsFeatureToggle';

const run = createRunDirs({ runLabel: 'ui-e2e' });

function collectTrayInteractionIssues(params: Readonly<{
  sessionId: string;
  noDragValue: string | null;
  invocations: readonly DesktopPetOverlayBridgeInvocation[];
}>): string[] {
  const issues: string[] = [];
  if (params.noDragValue !== 'true') {
    issues.push('desktop overlay tray item is not marked data-pet-no-drag="true"');
  }

  const showMainWindow = params.invocations.find(
    (invocation) => invocation.command === 'desktop_pet_overlay_show_main_window',
  );
  if (!showMainWindow) {
    issues.push('missing desktop_pet_overlay_show_main_window bridge command after tray click');
    return issues;
  }

  const payload = showMainWindow.args?.payload;
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    issues.push('tray bridge command is missing object payload');
    return issues;
  }
  const fields = payload as Record<string, unknown>;
  if (fields.reason !== 'tray-action') {
    issues.push('tray bridge command does not use reason="tray-action"');
  }
  if (fields.targetSessionId !== params.sessionId) {
    issues.push('tray bridge command does not include the clicked session id');
  }

  return issues;
}

test.describe('ui e2e: pets desktop overlay tray session interaction', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('pets-overlay-tray-session-suite');
  const syntheticSessionId = 'pets-overlay-tray-session-e2e';

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;

  test.beforeAll(async () => {
    test.setTimeout(900_000);

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys,providers.claude.unifiedTerminal',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-pets-overlay-tray-${run.runId}`,
        HAPPIER_E2E_UI_WEB_MODE: 'export',
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('opens the active session from a no-drag desktop overlay tray item', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing fixtures');

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 180_000);
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });
    await ensureAccountReadyForConnect({ page, timeoutMs: 120_000 });

    await setSingleAccountUiFeatureToggle({
      page,
      baseUrl: uiBaseUrl,
      featureId: 'pets.companion',
      enabled: true,
    });
    await setSingleAccountPetsEnabled({
      page,
      baseUrl: uiBaseUrl,
      enabled: true,
    });

    await installDesktopPetOverlayBridgeProbe(page, {
      windowState: createDesktopPetOverlayWindowState({
        sessionId: syntheticSessionId,
        title: 'pets overlay tray e2e',
      }),
    });
    await gotoDomContentLoadedWithRetries(
      page,
      `${uiBaseUrl}/desktop/pet-overlay?happier_hmr=0&desktopPetOverlayWindow=1`,
      180_000,
    );
    await expect(page.getByTestId('desktop-pet-overlay-root')).toHaveCount(1, { timeout: 120_000 });
    await expect.poll(
      async () => (await readDesktopPetOverlayBridgeInvocations(page)).some(
        (invocation) => invocation.command === 'desktop_pet_overlay_read_window_state',
      ),
      { timeout: 120_000 },
    ).toBe(true);
    const tray = page.getByTestId('desktop-pet-overlay-tray');
    await expect(tray).toHaveCount(1, { timeout: 120_000 });
    const sessionTrayItem = page.locator(`[data-testid^="desktop-pet-overlay-tray-item-${syntheticSessionId}"]`).first();
    await expect(sessionTrayItem).toHaveCount(1, { timeout: 120_000 });
    const noDragValue = await sessionTrayItem.getAttribute('data-pet-no-drag');

    await sessionTrayItem.dispatchEvent('click');
    await expect.poll(
      async () => (await readDesktopPetOverlayBridgeInvocations(page)).some(
        (invocation) => invocation.command === 'desktop_pet_overlay_show_main_window',
      ),
      { timeout: 120_000 },
    ).toBe(true);
    const invocations = await readDesktopPetOverlayBridgeInvocations(page);

    expect(collectTrayInteractionIssues({ sessionId: syntheticSessionId, noDragValue, invocations })).toEqual([]);
  });
});
