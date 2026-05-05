import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { installFakeTauriDesktopBridge } from '../../src/testkit/uiE2e/fakeTauriDesktop';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { setSingleAccountUiFeatureToggle } from '../../src/testkit/pets/uiPetsFeatureToggle';

const run = createRunDirs({ runLabel: 'ui-e2e' });

function createDesktopActivityOverlayState() {
  const windowSize = {
    collapsed: { width: 254, height: 38 },
    expanded: { width: 408, height: 118 },
  };
  const policy = {
    enabled: true,
    visibilityMode: 'always_when_enabled',
    showWhenRunning: true,
    showWhenAttentionRequired: true,
    showWhenReady: true,
    alwaysOnTop: true,
    autoHideEnabled: false,
    autoHideDelayMs: 6000,
    hoverExpandDelayMs: 500,
    expandedBehavior: 'click',
    interactiveCollapsed: true,
    presentationMode: 'floating_overlay',
    clickAction: 'expand_overlay',
    density: 'compact',
    compactStyle: 'pill',
    showSessionCount: false,
    showPreviewText: false,
    collapsedCarouselEnabled: false,
    quickReplyPhrases: ['Continue'],
    placementMode: 'anchored',
    anchor: 'top_center',
    offsetX: 0,
    offsetY: 0,
    enableDragReposition: false,
    lockPosition: true,
  };

  return {
    visible: true,
    expanded: false,
    policy,
    window: windowSize,
    placementDiagnostics: null,
    model: {
      visible: true,
      isExpanded: false,
      generatedAt: Date.now(),
      collapsed: {
        title: 'Blink',
        statusText: null,
        defaultTarget: 'sessions',
        sessionCount: null,
        slides: [
          {
            id: 'status',
            title: 'Blink',
            subtitle: null,
            animatedEllipsis: false,
            priority: 'idle',
          },
        ],
        carousel: {
          enabled: false,
          cadenceMs: 0,
          freezeReason: 'disabled',
        },
        urgency: {
          level: 'idle',
          unattendedMs: 0,
          pollMs: 1000,
        },
      },
      expanded: {
        title: 'Sessions',
        rows: [],
        cards: [],
        quickReply: null,
      },
      companion: {
        enabled: true,
        pet: {
          source: { kind: 'builtIn', petId: 'blink' },
          displayName: 'Blink',
        },
        state: 'idle',
        attentionLevel: 'idle',
        interaction: 'none',
        reason: 'idle',
        sessionId: null,
      },
      window: windowSize,
    },
  };
}

test.describe('ui e2e: pets desktop overlay settings', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('pets-desktop-overlay-settings-suite');
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
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-pets-overlay-settings-${run.runId}`,
        HAPPIER_E2E_UI_WEB_MODE: 'export',
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await daemon?.stop().catch(() => {});
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('enables the desktop overlay setting and renders Blink in the Dev activity overlay route', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing fixtures');

    const testDir = resolve(join(suiteDir, 'desktop-overlay-setting'));
    await mkdir(testDir, { recursive: true });

    daemon = await authenticateAndStartDaemon({
      page,
      testDir,
      cliHomeDir,
      serverUrl: server.baseUrl,
      uiBaseUrl,
    });

    await setSingleAccountUiFeatureToggle({
      page,
      baseUrl: uiBaseUrl,
      featureId: 'pets.companion',
      enabled: true,
    });

    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/pets?happier_hmr=0`, 180_000);
    await expect(page.getByTestId('settings-pets-desktop-overlay-enabled')).toHaveCount(0, { timeout: 120_000 });
    await expect(page.getByTestId('settings-pets-desktop-overlay-device-override')).toHaveCount(0);
    await expect(page.getByTestId('settings-pets-desktop-overlay-reset-position')).toHaveCount(0);

    await installFakeTauriDesktopBridge(page);
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/pets?happier_hmr=0`, 180_000);
    await expect(page.getByTestId('settings-pets-desktop-overlay-enabled')).toHaveCount(1, { timeout: 120_000 });
    await page.getByTestId('settings-pets-desktop-overlay-enabled').click();
    await expect(page.getByTestId('settings-pets-desktop-overlay-device-override')).toHaveCount(1, {
      timeout: 60_000,
    });
    await expect(page.getByTestId('settings-pets-desktop-overlay-reset-position')).toHaveCount(1, {
      timeout: 60_000,
    });

    await installFakeTauriDesktopBridge(page, {
      state: {
        currentWindowLabel: 'activity_overlay',
        desktopActivityOverlayState: createDesktopActivityOverlayState(),
      },
    });
    await gotoDomContentLoadedWithRetries(
      page,
      `${uiBaseUrl}/desktop/activity-overlay?desktopOverlayWindow=1&happier_hmr=0`,
      180_000,
    );

    await expect(page.getByTestId('desktop-activity-overlay-companion')).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId('desktop-activity-overlay-collapsed-floating')).toHaveCount(1, {
      timeout: 60_000,
    });
    const companionState = page.getByTestId('pet-companion-state');
    await expect(companionState).toHaveCount(1, { timeout: 60_000 });
    await expect(companionState).toHaveAttribute('data-pet-state', 'idle');
    await expect(page.getByTestId('desktop-activity-overlay-companion-sprite')).toHaveCount(1, {
      timeout: 60_000,
    });

    const backgrounds = await page.evaluate(() => ({
      body: getComputedStyle(document.body).backgroundColor,
      html: getComputedStyle(document.documentElement).backgroundColor,
      root: getComputedStyle(document.getElementById('root') ?? document.body).backgroundColor,
    }));
    expect(backgrounds).toEqual({
      body: 'rgba(0, 0, 0, 0)',
      html: 'rgba(0, 0, 0, 0)',
      root: 'rgba(0, 0, 0, 0)',
    });
  });
});
