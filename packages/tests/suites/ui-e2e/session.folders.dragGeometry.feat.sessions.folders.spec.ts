import { test, expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { setUiFeatureToggle } from '../../src/testkit/uiE2e/setUiFeatureToggle';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { createTestAuthMtls } from '../../src/testkit/auth';
import { registerMachineIdentity } from '../../src/testkit/machineIdentity';
import { startForwardedHeaderProxy } from '../../src/testkit/uiE2e/forwardedHeaderProxy';
import {
  createPlainSession,
  dragSessionWithGeometryProbe,
  dragSessionWithLongTaskProbe,
  expectFolderAssignment,
  expectOrderMapContainsBefore,
  folderOrderKey,
  resolveCanonicalServerIdForUi,
  sessionOrderKey,
  setSessionFolderDragSettings,
  type CapturedRect,
  type SessionFoldersSetting,
} from '../../src/testkit/uiE2e/sessionFoldersDrag';

/**
 * UI e2e coverage for the session-list drag geometry and performance boundary.
 *
 * The sibling spec `session.folders.dragAndDrop.feat.sessions.folders.spec.ts`
 * owns committed drop outcomes. Owner-level component tests cover frozen-list
 * projection. This spec retains only contracts that require a live browser:
 *
 *  - the single viewport-level drop overlay renders its blue line/outline at
 *    the pointer's target row after the real list has scrolled;
 *  - a coarse, intentionally forgiving long-task probe catches a catastrophic
 *    main-thread regression without flaking on slow CI.
 */

const run = createRunDirs({ runLabel: 'ui-e2e-session-folders-drag-geometry' });

const SEEDED_MACHINE_ID = 'seeded-session-drag-geometry-machine';
const IDENTITY_HEADERS = {
  email: `session-drag-geometry-${run.runId}@example.com`,
  issuer: 'happier-ui-e2e-session-drag-geometry',
  fingerprint: `session-drag-geometry-${run.runId}`,
} as const;

const FOLDER_TOP_ID = 'geo_top';
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
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs({
      ...process.env,
      HAPPIER_E2E_UI_WEB_MODE: 'export',
    }));
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

  test('drop indicator tracks the pointer after the virtualized list scrolls', async ({ page }) => {
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

    // The geometry regression requires a real scrollable, virtualized list.
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
    const dragSessionId = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: `geo drag ${run.runId}`,
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
    await expect(page.getByTestId(`session-folder-header-${FOLDER_BOTTOM_ID}`)).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId('session-list-drop-overlay')).toHaveCount(1, { timeout: 60_000 });

    // Scroll the list during a held drag. Before the content-coordinate fix,
    // stale window bounds put the indicator several rows off the pointer.
    const scrolledProbe = await dragSessionWithGeometryProbe(page, {
      sessionId: dragSessionId,
      targetTestId: `session-folder-header-${FOLDER_BOTTOM_ID}`,
      targetEdge: 'top',
      preScroll: 'target-into-view',
    });
    expect(scrolledProbe.ok).toBe(true);
    expect(scrolledProbe.scrollTopBefore).not.toBeNull();
    expect(scrolledProbe.scrollTopAfter).not.toBeNull();
    expect(
      scrolledProbe.scrollTopAfter ?? 0,
      'the geometry assertion must exercise a real list scroll',
    ).toBeGreaterThan(scrolledProbe.scrollTopBefore ?? 0);
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
    await expectOrderMapContainsBefore({
      baseUrl: server.baseUrl,
      token,
      serverId,
      firstKey: sessionOrderKey(serverId, dragSessionId),
      secondKey: folderOrderKey(FOLDER_BOTTOM_ID),
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
