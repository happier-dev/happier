import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { setUiFeatureToggle } from '../../src/testkit/uiE2e/setUiFeatureToggle';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { createTestAuthMtls } from '../../src/testkit/auth';
import { registerMachineIdentity } from '../../src/testkit/machineIdentity';
import { startForwardedHeaderProxy } from '../../src/testkit/uiE2e/forwardedHeaderProxy';
import {
  beginSteppedSessionDrag,
  createPlainSession,
  dragSessionToTarget,
  dragSessionWithGeometryProbe,
  dragSessionWithLongTaskProbe,
  expectFolderAssignment,
  expectOrderBefore,
  readVisibleSessionRowOrder,
  resolveCanonicalServerIdForUi,
  setSessionFolderDragSettings,
  type CapturedRect,
  type SessionFoldersSetting,
} from '../../src/testkit/uiE2e/sessionFoldersDrag';

/**
 * UI e2e coverage for the session-list drag GEOMETRY & performance refactor
 * (`.project/plans/session-list-drag-geometry-performance-unification.md`,
 * Phase 7 / sections 5.2, 8).
 *
 * The sibling spec `session.folders.dragAndDrop.feat.sessions.folders.spec.ts`
 * proves the committed *outcome* of folder/session drops. This spec proves the
 * VISUAL contract the refactor was built to fix:
 *
 *  - the single viewport-level drop overlay renders its blue line/outline at
 *    the pointer's target row, not offset by several rows (section 1.4 — the
 *    "wrong blue line" regression), including after the list is scrolled;
 *  - the indicator the user sees matches the position the move actually
 *    commits to;
 *  - autoscroll to an offscreen target still lands the drop on that target;
 *  - the visible drag surface stays frozen while a background reorder lands,
 *    and the latest list renders after the drop (section 1.5 / 3.3);
 *  - a coarse, intentionally forgiving long-task probe catches a catastrophic
 *    main-thread regression without flaking on slow CI.
 *
 * It is a separate file (not an extension of the drop-outcome spec) because the
 * geometry assertions need a held-mid-drag probe harness and a denser seeded
 * fixture; folding them in would make the existing single-test file unwieldy.
 */

const run = createRunDirs({ runLabel: 'ui-e2e-session-folders-drag-geometry' });

const SEEDED_MACHINE_ID = 'seeded-session-drag-geometry-machine';
const IDENTITY_HEADERS = {
  email: `session-drag-geometry-${run.runId}@example.com`,
  issuer: 'happier-ui-e2e-session-drag-geometry',
  fingerprint: `session-drag-geometry-${run.runId}`,
} as const;

const FOLDER_TOP_ID = 'geo_top';
const FOLDER_NEST_PARENT_ID = 'geo_nest_parent';
const FOLDER_NEST_CHILD_ID = 'geo_nest_child';
const FOLDER_BOTTOM_ID = 'geo_bottom';

/** Number of root-level filler sessions so the list scrolls and virtualizes. */
const FILLER_SESSION_COUNT = 28;

function folderSetting(params: Readonly<{
  id: string;
  name: string;
  parentId: string | null;
  sortKey: string;
  workspace: SessionFoldersSetting['folders'][number]['workspace'];
}>): SessionFoldersSetting['folders'][number] {
  return {
    id: params.id,
    workspace: params.workspace,
    parentId: params.parentId,
    name: params.name,
    createdAt: 1,
    updatedAt: 1,
    sortKey: params.sortKey,
  };
}

function buildSessionFolderSettings(params: Readonly<{
  workspace: SessionFoldersSetting['folders'][number]['workspace'];
}>): SessionFoldersSetting {
  const folders = [
    folderSetting({
      id: FOLDER_TOP_ID,
      name: 'Geo Top',
      parentId: null,
      sortKey: 'a0',
      workspace: params.workspace,
    }),
    folderSetting({
      id: FOLDER_NEST_PARENT_ID,
      name: 'Geo Nest Parent',
      parentId: null,
      sortKey: 'b0',
      workspace: params.workspace,
    }),
    folderSetting({
      id: FOLDER_NEST_CHILD_ID,
      name: 'Geo Nest Child',
      parentId: FOLDER_NEST_PARENT_ID,
      sortKey: 'b1',
      workspace: params.workspace,
    }),
    folderSetting({
      id: FOLDER_BOTTOM_ID,
      name: 'Geo Bottom',
      parentId: null,
      sortKey: 'z0',
      workspace: params.workspace,
    }),
  ];
  return { v: 1, folders };
}

/** Vertical centre of a rect. */
function centreY(rect: CapturedRect): number {
  return rect.top + rect.height / 2;
}

test.describe('ui e2e: session list drag geometry', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-drag-geometry-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let proxyStop: (() => Promise<void>) | null = null;
  let token: string | null = null;
  let uiServerUrl: string | null = null;

  test.beforeAll(async () => {
    test.setTimeout(420_000);
    await mkdir(cliHomeDir, { recursive: true });
    await writeFile(resolve(join(cliHomeDir, 'AGENTS.md')), '# UI e2e fixture\n', 'utf8');

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '0',
        HAPPIER_FEATURE_SESSIONS_FOLDERS__ENABLED: '1',

        HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',

        HAPPIER_FEATURE_AUTH_MTLS__ENABLED: '1',
        HAPPIER_FEATURE_AUTH_MTLS__MODE: 'forwarded',
        HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: '1',
        HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: '1',
        HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: 'san_email',
        HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: 'example.com',
        HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: IDENTITY_HEADERS.issuer,
        HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_EMAIL_HEADER: 'x-happier-client-cert-email',
        HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_ISSUER_HEADER: 'x-happier-client-cert-issuer',
        HAPPIER_FEATURE_AUTH_MTLS__FORWARDED_FINGERPRINT_HEADER: 'x-happier-client-cert-sha256',

        HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_ENABLED: '1',
        HAPPIER_FEATURE_AUTH_UI__AUTO_REDIRECT_PROVIDER_ID: 'mtls',
      },
    });

    const proxy = await startForwardedHeaderProxy({
      targetBaseUrl: server.baseUrl,
      identityHeaders: {
        'x-happier-client-cert-email': IDENTITY_HEADERS.email,
        'x-happier-client-cert-issuer': IDENTITY_HEADERS.issuer,
        'x-happier-client-cert-sha256': IDENTITY_HEADERS.fingerprint,
      },
    });
    proxyStop = proxy.stop;
    uiServerUrl = proxy.baseUrl;

    const auth = await createTestAuthMtls(server.baseUrl, {
      email: IDENTITY_HEADERS.email,
      issuer: IDENTITY_HEADERS.issuer,
      fingerprint: IDENTITY_HEADERS.fingerprint,
    });
    token = auth.token;
    await registerMachineIdentity({
      baseUrl: server.baseUrl,
      token,
      machineId: SEEDED_MACHINE_ID,
      metadata: 'session-drag-geometry-machine',
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: proxy.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-session-drag-geometry-${run.runId}`,
        HAPPIER_E2E_UI_WEB_MODE: 'export',
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await ui?.stop().catch(() => {});
    await proxyStop?.().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('drop indicator tracks the pointer, survives scroll, and matches the committed drop', async ({ page }) => {
    test.setTimeout(900_000);
    if (!server || !uiBaseUrl || !token || !uiServerUrl) throw new Error('missing server/ui fixtures');

    const rootPath = repoRootDir();
    const serverId = await resolveCanonicalServerIdForUi(uiServerUrl);
    const workspace = {
      t: 'workspaceScope' as const,
      serverId,
      machineId: SEEDED_MACHINE_ID,
      rootPath,
    };

    // The three sessions exercised directly by the geometry assertions, plus a
    // bank of filler sessions so the list is long enough to scroll/virtualize
    // (the wrong-blue-line bug only reproduced after scrolling).
    // Create filler first so the three rows exercised directly remain mounted
    // in the initial virtualized viewport. Their relative creation order still
    // leaves one row above and one below the dragged row for scenario 3.
    for (let index = 0; index < FILLER_SESSION_COUNT; index += 1) {
      await createPlainSession({
        baseUrl: server.baseUrl,
        token,
        title: `geo filler ${String(index).padStart(2, '0')} ${run.runId}`,
        rootPath,
        machineId: SEEDED_MACHINE_ID,
        tagPrefix: 'session-drag-geometry',
      });
    }
    const extraRootSessionAId = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: `geo extra root a ${run.runId}`,
      rootPath,
      machineId: SEEDED_MACHINE_ID,
      tagPrefix: 'session-drag-geometry',
    });
    const dragSessionId = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: `geo drag ${run.runId}`,
      rootPath,
      machineId: SEEDED_MACHINE_ID,
      tagPrefix: 'session-drag-geometry',
    });
    const extraRootSessionBId = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: `geo extra root b ${run.runId}`,
      rootPath,
      machineId: SEEDED_MACHINE_ID,
      tagPrefix: 'session-drag-geometry',
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });

    await setUiFeatureToggle({
      page,
      baseUrl: uiBaseUrl,
      featureId: 'sessions.folders',
      enabled: true,
    });

    await setSessionFolderDragSettings({
      page,
      baseUrl: uiBaseUrl,
      apiBaseUrl: server.baseUrl,
      token,
      serverId,
      sessionFoldersV1: buildSessionFolderSettings({ workspace }),
    });

    await expect(page.getByTestId(`session-list-item-${dragSessionId}`)).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId(`session-list-item-${extraRootSessionAId}`)).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId(`session-list-item-${extraRootSessionBId}`)).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId(`session-folder-header-${FOLDER_TOP_ID}`)).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId(`session-folder-header-${FOLDER_BOTTOM_ID}`)).toHaveCount(1, { timeout: 120_000 });

    // The single viewport-level overlay exists once for the whole list (it is
    // the replacement for the removed per-row indicators).
    await expect(page.getByTestId('session-list-drop-overlay')).toHaveCount(1, { timeout: 60_000 });

    // ---------------------------------------------------------------------
    // Scenario 1: drag onto a folder header ~near the top of the list.
    // The blue line must be drawn at that header (near the pointer), and the
    // commit must move the session to exactly where the line was shown.
    // ---------------------------------------------------------------------
    const topProbe = await dragSessionWithGeometryProbe(page, {
      sessionId: dragSessionId,
      targetTestId: `session-folder-header-${FOLDER_TOP_ID}`,
      targetEdge: 'top',
    });
    expect(topProbe.ok).toBe(true);
    expect(topProbe.pointer).not.toBeNull();
    expect(topProbe.targetRect).not.toBeNull();
    // An indicator (line or outline) must be visible mid-drag.
    const topIndicator = topProbe.overlayLine ?? topProbe.overlayOutline;
    expect(topIndicator, 'a drop indicator must be visible while dragging').not.toBeNull();
    if (topIndicator && topProbe.pointer && topProbe.targetRect) {
      // The indicator must sit at the pointer's target row, not several rows
      // away. Allow a generous tolerance (~2 row heights) so overlay glide
      // and sub-pixel rounding never flake this.
      const indicatorY = centreY(topIndicator);
      expect(Math.abs(indicatorY - topProbe.pointer.y)).toBeLessThan(96);
      // The indicator must overlap the target row vertically.
      expect(indicatorY).toBeGreaterThan(topProbe.targetRect.top - 96);
      expect(indicatorY).toBeLessThan(topProbe.targetRect.bottom + 96);
    }
    // Committed position agrees with the shown indicator: a top-edge drop on
    // the folder header lands the session immediately above that header.
    await expectFolderAssignment({
      baseUrl: server.baseUrl,
      token,
      sessionId: dragSessionId,
      folderId: null,
    });
    await expectOrderBefore({
      page,
      firstTestId: `session-list-item-${dragSessionId}`,
      secondTestId: `session-folder-header-${FOLDER_TOP_ID}`,
    });

    // ---------------------------------------------------------------------
    // Scenario 2: the wrong-blue-line regression. Scroll the list, THEN drag.
    // Before the content-coordinate geometry fix, stale window bounds put the
    // line several rows off the pointer after a scroll.
    // ---------------------------------------------------------------------
    const scrolledProbe = await dragSessionWithGeometryProbe(page, {
      sessionId: dragSessionId,
      targetTestId: `session-folder-header-${FOLDER_BOTTOM_ID}`,
      targetEdge: 'top',
      preScroll: 'target-into-view',
    });
    expect(scrolledProbe.ok).toBe(true);
    const scrolledIndicator = scrolledProbe.overlayLine ?? scrolledProbe.overlayOutline;
    expect(
      scrolledIndicator,
      'a drop indicator must be visible while dragging after a scroll',
    ).not.toBeNull();
    if (scrolledIndicator && scrolledProbe.pointer && scrolledProbe.targetRect) {
      const indicatorY = centreY(scrolledIndicator);
      // The headline assertion: after scrolling, the line is still at the
      // pointer, NOT offset by multiple rows.
      expect(
        Math.abs(indicatorY - scrolledProbe.pointer.y),
        'drop indicator must stay near the pointer after scrolling (wrong-blue-line regression)',
      ).toBeLessThan(96);
      expect(indicatorY).toBeGreaterThan(scrolledProbe.targetRect.top - 96);
      expect(indicatorY).toBeLessThan(scrolledProbe.targetRect.bottom + 96);
    }
    await expectFolderAssignment({
      baseUrl: server.baseUrl,
      token,
      sessionId: dragSessionId,
      folderId: null,
    });
    await expectOrderBefore({
      page,
      firstTestId: `session-list-item-${dragSessionId}`,
      secondTestId: `session-folder-header-${FOLDER_BOTTOM_ID}`,
    });

    // ---------------------------------------------------------------------
    // Scenario 3: drag a session ~2 rows UP onto another session row, then
    // ~2 rows DOWN. Targets are chosen relative to the dragged session's
    // CURRENT visible position so the move direction is deterministic
    // regardless of the seeded order. Indicator-near-pointer holds in both
    // directions and the committed order matches what the indicator showed.
    // ---------------------------------------------------------------------
    let orderBeforeUp = await readVisibleSessionRowOrder(page);
    let dragIndexBeforeUp = orderBeforeUp.indexOf(dragSessionId);
    expect(dragIndexBeforeUp, 'dragged session must be visible before the up-move').toBeGreaterThanOrEqual(0);
    if (dragIndexBeforeUp < 2) {
      const seedDownIndex = Math.min(orderBeforeUp.length - 1, dragIndexBeforeUp + 2);
      const seedDownRowSessionId = orderBeforeUp[seedDownIndex]!;
      expect(
        seedDownRowSessionId,
        'a seed down-target row must exist so the up-probe has visible room above it',
      ).not.toBe(dragSessionId);
      await page.getByTestId(`session-list-item-${seedDownRowSessionId}`).scrollIntoViewIfNeeded();
      const seedDownMove = await dragSessionToTarget(page, {
        sessionId: dragSessionId,
        targetTestId: `session-list-item-${seedDownRowSessionId}`,
        targetEdge: 'bottom',
      });
      expect(seedDownMove.ok).toBe(true);
      orderBeforeUp = await readVisibleSessionRowOrder(page);
      dragIndexBeforeUp = orderBeforeUp.indexOf(dragSessionId);
      expect(
        dragIndexBeforeUp,
        'dragged session must have visible rows above it after the seed down-move',
      ).toBeGreaterThanOrEqual(2);
    }
    // A row ~2 positions above the dragged session.
    const upTargetIndex = dragIndexBeforeUp - 2;
    const upRowSessionId = orderBeforeUp[upTargetIndex]!;
    expect(upRowSessionId, 'an up-target row must exist above the dragged session').not.toBe(dragSessionId);

    const upProbe = await dragSessionWithGeometryProbe(page, {
      sessionId: dragSessionId,
      targetTestId: `session-list-item-${upRowSessionId}`,
      targetEdge: 'top',
    });
    expect(upProbe.ok).toBe(true);
    const upIndicator = upProbe.overlayLine ?? upProbe.overlayOutline;
    expect(upIndicator, 'a drop indicator must be visible dragging up').not.toBeNull();
    if (upIndicator && upProbe.pointer) {
      expect(
        Math.abs(centreY(upIndicator) - upProbe.pointer.y),
        'drop indicator must track the pointer dragging up',
      ).toBeLessThan(96);
    }
    // A top-edge drop lands the dragged session immediately above the target.
    await expectOrderBefore({
      page,
      firstTestId: `session-list-item-${dragSessionId}`,
      secondTestId: `session-list-item-${upRowSessionId}`,
    });

    const orderBeforeDown = await readVisibleSessionRowOrder(page);
    const dragIndexBeforeDown = orderBeforeDown.indexOf(dragSessionId);
    expect(dragIndexBeforeDown, 'dragged session must be visible before the down-move').toBeGreaterThanOrEqual(0);
    // A row ~2 positions below the dragged session.
    const downTargetIndex = Math.min(orderBeforeDown.length - 1, dragIndexBeforeDown + 2);
    const downRowSessionId = orderBeforeDown[downTargetIndex]!;
    expect(downRowSessionId, 'a down-target row must exist below the dragged session').not.toBe(dragSessionId);

    await page.getByTestId(`session-list-item-${downRowSessionId}`).scrollIntoViewIfNeeded();
    const downProbe = await dragSessionWithGeometryProbe(page, {
      sessionId: dragSessionId,
      targetTestId: `session-list-item-${downRowSessionId}`,
      targetEdge: 'bottom',
    });
    expect(downProbe.ok).toBe(true);
    const downIndicator = downProbe.overlayLine ?? downProbe.overlayOutline;
    expect(downIndicator, 'a drop indicator must be visible dragging down').not.toBeNull();
    if (downIndicator && downProbe.pointer) {
      expect(
        Math.abs(centreY(downIndicator) - downProbe.pointer.y),
        'drop indicator must track the pointer dragging down',
      ).toBeLessThan(96);
    }
    // A bottom-edge drop lands the dragged session immediately below the target.
    await expectOrderBefore({
      page,
      firstTestId: `session-list-item-${downRowSessionId}`,
      secondTestId: `session-list-item-${dragSessionId}`,
    });
  });

  test('autoscroll to an offscreen folder lands the drop on that folder', async ({ page }) => {
    test.setTimeout(900_000);
    if (!server || !uiBaseUrl || !token || !uiServerUrl) throw new Error('missing server/ui fixtures');

    const rootPath = repoRootDir();
    const serverId = await resolveCanonicalServerIdForUi(uiServerUrl);
    const workspace = {
      t: 'workspaceScope' as const,
      serverId,
      machineId: SEEDED_MACHINE_ID,
      rootPath,
    };

    const autoscrollSessionId = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: `geo autoscroll ${run.runId}`,
      rootPath,
      machineId: SEEDED_MACHINE_ID,
      tagPrefix: 'session-drag-geometry-autoscroll',
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });
    await setUiFeatureToggle({ page, baseUrl: uiBaseUrl, featureId: 'sessions.folders', enabled: true });
    await setSessionFolderDragSettings({
      page,
      baseUrl: uiBaseUrl,
      apiBaseUrl: server.baseUrl,
      token,
      serverId,
      sessionFoldersV1: buildSessionFolderSettings({ workspace }),
    });

    await expect(page.getByTestId(`session-list-item-${autoscrollSessionId}`)).toHaveCount(1, { timeout: 120_000 });
    const targetVisibleBeforeDrag = await page.getByTestId(`session-folder-header-${FOLDER_BOTTOM_ID}`).isVisible();

    // The offscreen target is the bottom folder header — a VARIABLE-HEIGHT row
    // that must measure into the content-coordinate registry as autoscroll
    // brings it into view (section 3.6).
    const autoscrollDrag = await dragSessionToTarget(page, {
      sessionId: autoscrollSessionId,
      targetTestId: `session-folder-header-${FOLDER_BOTTOM_ID}`,
      targetEdge: 'middle',
      scrollDuringDrag: 'autoscroll-bottom',
    });
    if (!targetVisibleBeforeDrag) {
      expect(autoscrollDrag.scrollTopAfter ?? 0).toBeGreaterThan(autoscrollDrag.scrollTopBefore ?? -1);
    }
    await expectFolderAssignment({
      baseUrl: server.baseUrl,
      token,
      sessionId: autoscrollSessionId,
      folderId: FOLDER_BOTTOM_ID,
    });
  });

  test('the visible drag surface stays frozen while a background reorder lands', async ({ page }) => {
    test.setTimeout(900_000);
    if (!server || !uiBaseUrl || !token || !uiServerUrl) throw new Error('missing server/ui fixtures');

    const rootPath = repoRootDir();
    const serverId = await resolveCanonicalServerIdForUi(uiServerUrl);
    const workspace = {
      t: 'workspaceScope' as const,
      serverId,
      machineId: SEEDED_MACHINE_ID,
      rootPath,
    };

    // The session we drag. A bank of filler sessions keeps the list dense.
    const frozenDragSessionId = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: `geo frozen drag ${run.runId}`,
      rootPath,
      machineId: SEEDED_MACHINE_ID,
      tagPrefix: 'session-drag-geometry-frozen',
    });
    for (let index = 0; index < 6; index += 1) {
      await createPlainSession({
        baseUrl: server.baseUrl,
        token,
        title: `geo frozen filler ${String(index).padStart(2, '0')} ${run.runId}`,
        rootPath,
        machineId: SEEDED_MACHINE_ID,
        tagPrefix: 'session-drag-geometry-frozen',
      });
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });
    await setUiFeatureToggle({ page, baseUrl: uiBaseUrl, featureId: 'sessions.folders', enabled: true });
    await setSessionFolderDragSettings({
      page,
      baseUrl: uiBaseUrl,
      apiBaseUrl: server.baseUrl,
      token,
      serverId,
      sessionFoldersV1: buildSessionFolderSettings({ workspace }),
    });

    await expect(page.getByTestId(`session-list-item-${frozenDragSessionId}`)).toHaveCount(1, { timeout: 120_000 });

    const rowsBeforeDrag = await readVisibleSessionRowOrder(page);
    expect(rowsBeforeDrag, 'the dragged session is on the list').toContain(frozenDragSessionId);

    // Begin a real, step-controlled drag and hover a stable folder header so
    // the drag stays active across the next steps.
    const steppedDrag = await beginSteppedSessionDrag(page, { sessionId: frozenDragSessionId });
    await steppedDrag.moveOverTarget(`session-folder-header-${FOLDER_TOP_ID}`, 'top');

    // A background list mutation lands WHILE the drag is held: create a brand
    // new session over REST. New sessions push live over the sync socket, so
    // the store/list state genuinely changes mid-drag. The frozen-surface
    // policy (plan section 1.5 / 3.3) requires the VISIBLE surface to ignore
    // it until the drop.
    const backgroundSessionId = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: `geo background new ${run.runId}`,
      rootPath,
      machineId: SEEDED_MACHINE_ID,
      tagPrefix: 'session-drag-geometry-frozen-bg',
    });
    await page.waitForTimeout(1200);

    // The newly created session must NOT appear as a row while the drag is
    // still active: the visible drag surface is frozen.
    await expect(
      page.getByTestId(`session-list-item-${backgroundSessionId}`),
      'a background-created session must not appear in the frozen drag surface',
    ).toHaveCount(0);

    // Drop: the frozen surface is released and the latest live list renders,
    // now including the background-created session.
    await steppedDrag.drop();

    await expect(
      page.getByTestId(`session-list-item-${backgroundSessionId}`),
      'the background-created session must appear after the drop refreshes the list',
    ).toHaveCount(1, { timeout: 120_000 });
    // The dragged session is still present after the drop (the move did not
    // lose it, and the list is live again).
    await expect(page.getByTestId(`session-list-item-${frozenDragSessionId}`)).toHaveCount(1, { timeout: 60_000 });
  });

  test('folder nesting still works and a blocked drop is a no-op', async ({ page }) => {
    test.setTimeout(900_000);
    if (!server || !uiBaseUrl || !token || !uiServerUrl) throw new Error('missing server/ui fixtures');

    const rootPath = repoRootDir();
    const serverId = await resolveCanonicalServerIdForUi(uiServerUrl);
    const workspace = {
      t: 'workspaceScope' as const,
      serverId,
      machineId: SEEDED_MACHINE_ID,
      rootPath,
    };

    const nestSessionId = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: `geo nest session ${run.runId}`,
      rootPath,
      machineId: SEEDED_MACHINE_ID,
      tagPrefix: 'session-drag-geometry-nest',
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });
    await setUiFeatureToggle({ page, baseUrl: uiBaseUrl, featureId: 'sessions.folders', enabled: true });
    await setSessionFolderDragSettings({
      page,
      baseUrl: uiBaseUrl,
      apiBaseUrl: server.baseUrl,
      token,
      serverId,
      sessionFoldersV1: buildSessionFolderSettings({ workspace }),
    });

    await expect(page.getByTestId(`session-list-item-${nestSessionId}`)).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId(`session-folder-header-${FOLDER_NEST_PARENT_ID}`)).toHaveCount(1, { timeout: 120_000 });

    // Nest: a middle-edge drop on a folder header assigns the session into
    // that folder. The indicator for a nest is the outline (not the line).
    const nestProbe = await dragSessionWithGeometryProbe(page, {
      sessionId: nestSessionId,
      targetTestId: `session-folder-header-${FOLDER_NEST_PARENT_ID}`,
      targetEdge: 'middle',
    });
    expect(nestProbe.ok).toBe(true);
    const nestIndicator = nestProbe.overlayOutline ?? nestProbe.overlayLine;
    expect(nestIndicator, 'a nest indicator must be visible mid-drag').not.toBeNull();
    if (nestIndicator && nestProbe.targetRect) {
      // The nest outline frames the folder-header target row.
      expect(centreY(nestIndicator)).toBeGreaterThan(nestProbe.targetRect.top - 96);
      expect(centreY(nestIndicator)).toBeLessThan(nestProbe.targetRect.bottom + 96);
    }
    await expectFolderAssignment({
      baseUrl: server.baseUrl,
      token,
      sessionId: nestSessionId,
      folderId: FOLDER_NEST_PARENT_ID,
    });

    // Blocked drop: a session cannot be dropped onto its own reorder handle —
    // that is a no-op. The folder assignment must be unchanged afterwards.
    const blockedDrag = await dragSessionToTarget(page, {
      sessionId: nestSessionId,
      targetTestId: `session-list-item-${nestSessionId}`,
      targetEdge: 'middle',
    });
    expect(blockedDrag.ok).toBe(true);
    await page.waitForTimeout(350);
    await expectFolderAssignment({
      baseUrl: server.baseUrl,
      token,
      sessionId: nestSessionId,
      folderId: FOLDER_NEST_PARENT_ID,
    });
  });

  test('perf probe: a session drag does not catastrophically block the main thread', async ({ page }) => {
    test.setTimeout(900_000);
    if (!server || !uiBaseUrl || !token || !uiServerUrl) throw new Error('missing server/ui fixtures');

    const rootPath = repoRootDir();
    const serverId = await resolveCanonicalServerIdForUi(uiServerUrl);
    const workspace = {
      t: 'workspaceScope' as const,
      serverId,
      machineId: SEEDED_MACHINE_ID,
      rootPath,
    };

    const perfSessionId = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: `geo perf ${run.runId}`,
      rootPath,
      machineId: SEEDED_MACHINE_ID,
      tagPrefix: 'session-drag-geometry-perf',
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });
    await setUiFeatureToggle({ page, baseUrl: uiBaseUrl, featureId: 'sessions.folders', enabled: true });
    await setSessionFolderDragSettings({
      page,
      baseUrl: uiBaseUrl,
      apiBaseUrl: server.baseUrl,
      token,
      serverId,
      sessionFoldersV1: buildSessionFolderSettings({ workspace }),
    });

    await expect(page.getByTestId(`session-list-item-${perfSessionId}`)).toHaveCount(1, { timeout: 120_000 });

    const { drag, longTasks } = await dragSessionWithLongTaskProbe(page, {
      sessionId: perfSessionId,
      targetTestId: `session-folder-header-${FOLDER_TOP_ID}`,
      targetEdge: 'top',
    });
    expect(drag.ok).toBe(true);

    // Intentionally forgiving thresholds. The pre-fix drag measured ~1742 ms
    // of main-thread blocking across 14 long tasks (plan section 1.2); the
    // post-fix drag should be a small fraction of that. These bounds only
    // catch a *catastrophic* regression and stay generous so the probe never
    // flakes on slow/shared CI runners. Precise FPS work is for manual QA.
    expect(
      longTasks.totalMs,
      'total main-thread blocking during a drag must not regress to the pre-fix ~1742ms baseline',
    ).toBeLessThan(1200);
  });
});
