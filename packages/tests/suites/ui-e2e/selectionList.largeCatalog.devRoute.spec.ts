import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import {
  resolveUiWebBeforeAllTimeoutMs,
  startUiWeb,
  type StartedUiWeb,
} from '../../src/testkit/process/uiWeb';
import {
  createAccountAndReachConnectMachineState,
  gotoDomContentLoadedWithPathFallback,
  normalizeLoopbackBaseUrl,
} from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });

test.describe('ui e2e: large catalog SelectionList', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('selection-list-large-catalog-suite');
  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;

  test.beforeAll(async () => {
    const uiWebEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-selection-list-large-catalog-${run.runId}`,
      HAPPIER_E2E_UI_WEB_MODE: 'metro',
    };

    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiWebEnv));
    await mkdir(suiteDir, { recursive: true });
    server = await startServerLight({ testDir: suiteDir, dbProvider: 'sqlite' });
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

  test('bounds, recycles, and keyboard-scrolls a neighboring 100-model section in the exact chip-picker composition', async ({ page }) => {
    test.setTimeout(360_000);
    if (!server || !uiBaseUrl) throw new Error('missing UI fixture');

    await page.setViewportSize({ width: 1280, height: 720 });
    await gotoDomContentLoadedWithPathFallback(page, `${uiBaseUrl}/?happier_hmr=0`, '/', 120_000);
    await createAccountAndReachConnectMachineState({ page });
    await gotoDomContentLoadedWithPathFallback(
      page,
      `${uiBaseUrl}/dev/selection-list-large-catalog?happier_hmr=0`,
      '/dev/selection-list-large-catalog',
      120_000,
    );

    const fixture = page.getByTestId('selection-list-large-catalog-fixture');
    const listbox = fixture.getByRole('listbox');
    const scrollOwner = fixture.getByTestId('model-picker-overlay-selection-list:bodyVirtualizedList');
    const search = fixture.getByTestId('model-picker-overlay-search');

    await expect(fixture).toBeVisible();
    await expect(listbox).toBeVisible();
    await expect.poll(() => fixture.getByRole('option').count()).toBeLessThan(108);
    await expect.poll(() => fixture.getByRole('option').count()).toBeGreaterThan(0);

    const metrics = await scrollOwner.evaluate((node) => ({
      clientHeight: node.clientHeight,
      scrollHeight: node.scrollHeight,
    }));
    expect(metrics.clientHeight).toBeGreaterThan(0);
    expect(metrics.clientHeight).toBeLessThanOrEqual(520);
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);

    await search.focus();
    for (let index = 0; index < 90; index += 1) {
      await page.keyboard.press('ArrowDown');
    }

    const activeDescendantId = await search.getAttribute('aria-activedescendant');
    if (!activeDescendantId) throw new Error('missing active descendant after keyboard navigation');
    const activeProviderOrdinal = activeDescendantId.match(/q24-model-(\d{5})/)?.[1];
    expect(activeProviderOrdinal).toBeDefined();
    expect(Number(activeProviderOrdinal)).toBeGreaterThanOrEqual(80);
    const activeRow = page.locator(`[id=${JSON.stringify(activeDescendantId)}]`);
    await expect(activeRow).toBeVisible();
    await expect.poll(() => scrollOwner.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);

    const [viewportBox, activeBox] = await Promise.all([
      scrollOwner.boundingBox(),
      activeRow.boundingBox(),
    ]);
    expect(viewportBox).not.toBeNull();
    expect(activeBox).not.toBeNull();
    expect(activeBox!.y).toBeGreaterThanOrEqual(viewportBox!.y);
    expect(activeBox!.y + activeBox!.height).toBeLessThanOrEqual(
      viewportBox!.y + viewportBox!.height,
    );
    expect(activeBox!.y).toBeGreaterThanOrEqual(0);
    expect(activeBox!.y + activeBox!.height).toBeLessThanOrEqual(720);
  });
});
