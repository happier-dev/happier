import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { type StartedDaemon } from '../../src/testkit/daemon/daemon';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import {
  installDesktopPetOverlayBridgeProbe,
  readDesktopPetOverlayBridgeInvocations,
  type DesktopPetOverlayBridgeInvocation,
} from '../../src/testkit/pets/desktopPetOverlayBridgeProbe';
import { authenticateAndStartDaemon } from '../../src/testkit/uiE2e/authenticateAndStartDaemon';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { setSingleAccountPetsEnabled, setSingleAccountUiFeatureToggle } from '../../src/testkit/pets/uiPetsFeatureToggle';

type DragProbeResult = Readonly<{
  hasMascotMarker: boolean;
  captureCalls: readonly string[];
  error?: string;
}>;

const run = createRunDirs({ runLabel: 'ui-e2e' });

async function dispatchDesktopOverlayDrag(page: Page): Promise<DragProbeResult> {
  return page.evaluate(async () => {
    const hitbox = document.querySelector<HTMLElement>('[data-testid="desktop-pet-overlay-hitbox"]');
    if (!hitbox) {
      return { hasMascotMarker: false, captureCalls: [], error: 'missing desktop-pet-overlay-hitbox' };
    }

    const captureCalls: string[] = [];
    hitbox.setPointerCapture = (pointerId) => {
      captureCalls.push(`set:${String(pointerId)}`);
    };
    hitbox.releasePointerCapture = (pointerId) => {
      captureCalls.push(`release:${String(pointerId)}`);
    };

    const mascotSelector = '[data-pet-mascot="true"], [data-avatar-mascot="true"]';
    const target = hitbox.querySelector<HTMLElement>(mascotSelector) ?? hitbox;
    const hasMascotMarker = Boolean(target.closest(mascotSelector));
    const pointerId = 77;

    target.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      clientX: 20,
      clientY: 20,
      screenX: 420,
      screenY: 620,
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    window.dispatchEvent(new PointerEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      clientX: 50,
      clientY: 44,
      screenX: 450,
      screenY: 644,
    }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    window.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      pointerId,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      clientX: 78,
      clientY: 62,
      screenX: 478,
      screenY: 662,
    }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    return { hasMascotMarker, captureCalls };
  });
}

function collectDesktopOverlayDragIssues(params: Readonly<{
  drag: DragProbeResult;
  invocations: readonly DesktopPetOverlayBridgeInvocation[];
}>): string[] {
  const issues: string[] = [];
  if (params.drag.error) issues.push(params.drag.error);
  if (!params.drag.hasMascotMarker) issues.push('drag target is missing data-pet-mascot/data-avatar-mascot marker');
  for (const captureCall of ['set:77', 'release:77']) {
    if (!params.drag.captureCalls.includes(captureCall)) {
      issues.push(`missing pointer capture call ${captureCall}`);
    }
  }

  const commands = params.invocations.map((invocation) => invocation.command);
  for (const command of [
    'desktop_pet_overlay_start_drag_session',
    'desktop_pet_overlay_apply_drag_delta',
    'desktop_pet_overlay_release_drag_velocity',
    'desktop_pet_overlay_end_drag_session',
  ]) {
    if (!commands.includes(command)) {
      issues.push(`missing bridge command ${command}`);
    }
  }

  const deltaPayload = params.invocations.find(
    (invocation) => invocation.command === 'desktop_pet_overlay_apply_drag_delta',
  )?.args?.payload;
  if (
    typeof deltaPayload !== 'object'
    || deltaPayload === null
    || Array.isArray(deltaPayload)
    || (deltaPayload as Record<string, unknown>).coordinateSpace !== 'screen'
    || (deltaPayload as Record<string, unknown>).pointerId !== '77'
  ) {
    issues.push('drag delta bridge payload does not preserve screen coordinate space and pointer id');
  }

  return issues;
}

test.describe('ui e2e: pets desktop overlay drag bridge', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('pets-desktop-overlay-drag-suite');
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
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-pets-overlay-drag-${run.runId}`,
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

  test('drags the mascot through the desktop bridge with pointer capture and release velocity', async ({ page }) => {
    test.setTimeout(540_000);
    if (!server || !uiBaseUrl) throw new Error('missing fixtures');

    const testDir = resolve(join(suiteDir, 'desktop-overlay-drag'));
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
    await setSingleAccountPetsEnabled({
      page,
      baseUrl: uiBaseUrl,
      enabled: true,
    });

    await installDesktopPetOverlayBridgeProbe(page);
    await gotoDomContentLoadedWithRetries(
      page,
      `${uiBaseUrl}/desktop/pet-overlay?happier_hmr=0&desktopPetOverlayWindow=1`,
      180_000,
    );
    await expect(page.getByTestId('desktop-pet-overlay-root')).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId('desktop-pet-overlay-hitbox')).toHaveCount(1, { timeout: 60_000 });

    const drag = await dispatchDesktopOverlayDrag(page);
    const invocations = await readDesktopPetOverlayBridgeInvocations(page);

    expect(collectDesktopOverlayDragIssues({ drag, invocations })).toEqual([]);
  });
});
