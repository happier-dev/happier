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
import { createMachineBoundSessionScopedSocketCollector } from '../../src/testkit/sessionSocketBinding';
import { fetchSessionV2 } from '../../src/testkit/sessions';
import { waitFor } from '../../src/testkit/timing';
import { startForwardedHeaderProxy } from '../../src/testkit/uiE2e/forwardedHeaderProxy';
import { setSessionOrganizationPin } from '../../src/testkit/uiE2e/sessionOrganization';
import {
  createPlainSession,
  dragFolderToTarget,
  dragSessionToTarget,
  expectFolderAssignment,
  expectFolderParent,
  expectOrderMapContainsBefore,
  expectOrderMapStartsWith,
  folderOrderKey,
  readSessionFolderDragSettings,
  readVisibleSessionRowOrder,
  resolveCanonicalServerIdForUi,
  sessionOrderKey,
  setSessionFolderAssignment,
  setSessionFolderDragSettings,
  type SessionFoldersSetting,
} from '../../src/testkit/uiE2e/sessionFoldersDrag';

const run = createRunDirs({ runLabel: 'ui-e2e-session-folders-drag' });

const SEEDED_MACHINE_ID = 'seeded-session-folders-drag-machine';
const IDENTITY_HEADERS = {
  email: `session-folders-drag-${run.runId}@example.com`,
  issuer: 'happier-ui-e2e-session-folders-drag',
  fingerprint: `session-folders-drag-${run.runId}`,
} as const;

const FOLDER_ALPHA_ID = 'drag_alpha';
const FOLDER_BETA_ID = 'drag_beta';
const FOLDER_ALPHA_CHILD_ID = 'drag_alpha_child';
const FOLDER_BOTTOM_ID = 'drag_bottom';

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
      id: FOLDER_ALPHA_ID,
      name: 'Drag Alpha',
      parentId: null,
      sortKey: 'a0',
      workspace: params.workspace,
    }),
    folderSetting({
      id: FOLDER_BETA_ID,
      name: 'Drag Beta',
      parentId: null,
      sortKey: 'b0',
      workspace: params.workspace,
    }),
    folderSetting({
      id: FOLDER_ALPHA_CHILD_ID,
      name: 'Drag Alpha Child',
      parentId: FOLDER_ALPHA_ID,
      sortKey: 'a1',
      workspace: params.workspace,
    }),
    ...Array.from({ length: 18 }, (_, index) => folderSetting({
      id: `drag_filler_${String(index).padStart(2, '0')}`,
      name: `Drag Filler ${String(index + 1).padStart(2, '0')}`,
      parentId: null,
      sortKey: `m${String(index).padStart(2, '0')}`,
      workspace: params.workspace,
    })),
    folderSetting({
      id: FOLDER_BOTTOM_ID,
      name: 'Drag Bottom',
      parentId: null,
      sortKey: 'z0',
      workspace: params.workspace,
    }),
  ];
  return { v: 1, folders };
}

test.describe('ui e2e: session folders drag and drop', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-folders-drag-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let proxyStop: (() => Promise<void>) | null = null;
  let token: string | null = null;
  let uiServerUrl: string | null = null;
  const activePublishers: Array<{ close: () => void }> = [];

  test.beforeAll(async () => {
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(process.env));
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
      metadata: 'session-folders-drag-machine',
    });

    const existingUi = process.env.HAPPIER_E2E_EXISTING_UI_URL?.trim();
    if (existingUi) {
      uiBaseUrl = normalizeLoopbackBaseUrl(existingUi);
      return;
    }
    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: proxy.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-session-folders-drag-${run.runId}`,
        HAPPIER_E2E_UI_WEB_MODE: process.env.HAPPIER_E2E_UI_WEB_MODE ?? 'export',
      },
    });

    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    for (const publisher of activePublishers) publisher.close();
    await ui?.stop().catch(() => {});
    await proxyStop?.().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('session folders drag supports root, nested, blocked, and scrolled drops', async ({ page }) => {
    test.setTimeout(180_000);
    if (!server || !uiBaseUrl || !token || !uiServerUrl) throw new Error('missing server/ui fixtures');

    const serverBaseUrl = server.baseUrl;
    const uiBaseUrlForTest = uiBaseUrl;
    const authToken = token;
    const rootPath = repoRootDir();
    const serverId = await resolveCanonicalServerIdForUi(uiServerUrl);
    const workspace = {
      t: 'workspaceScope' as const,
      serverId,
      machineId: SEEDED_MACHINE_ID,
      rootPath,
    };

    const rootSessionId = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: `drag root ${run.runId}`,
      rootPath,
      machineId: SEEDED_MACHINE_ID,
      tagPrefix: 'session-folders-drag',
    });
    const nestedSessionId = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: `drag nested ${run.runId}`,
      rootPath,
      machineId: SEEDED_MACHINE_ID,
      tagPrefix: 'session-folders-drag',
    });
    const scrollSessionId = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: `drag scroll ${run.runId}`,
      rootPath,
      machineId: SEEDED_MACHINE_ID,
      tagPrefix: 'session-folders-drag',
    });
    const anotherRootSessionId = await createPlainSession({
      baseUrl: server.baseUrl, token, title: `drag another root ${run.runId}`, rootPath,
      machineId: SEEDED_MACHINE_ID, tagPrefix: 'session-folders-drag',
    });

    for (const sessionId of [rootSessionId, scrollSessionId, anotherRootSessionId]) {
      const { socket } = await createMachineBoundSessionScopedSocketCollector({ baseUrl: serverBaseUrl, token: authToken, sessionId });
      activePublishers.push(socket);
      socket.connect();
      await waitFor(async () => socket.isConnected(), { timeoutMs: 20_000, context: `connect ${sessionId}` });
      socket.emit('session-alive', { sid: sessionId, time: Date.now(), thinking: false });
      await waitFor(async () => (await fetchSessionV2(serverBaseUrl, authToken, sessionId)).active === true, { timeoutMs: 20_000, context: `activate ${sessionId}` });
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0&server=${encodeURIComponent(uiServerUrl)}`, 300_000);
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });

    await setUiFeatureToggle({
      page,
      baseUrl: uiBaseUrl,
      featureId: 'sessions.folders',
      enabled: true,
    });

    const seededFolderSettings = buildSessionFolderSettings({ workspace });
    const refreshFolderDragView = async (): Promise<void> => {
      await setSessionFolderDragSettings({
        page,
        baseUrl: uiBaseUrlForTest,
        apiBaseUrl: serverBaseUrl,
        token: authToken,
        serverId,
        sessionFoldersV1: seededFolderSettings,
      });
    };

    await refreshFolderDragView();
    await setSessionFolderAssignment({
      baseUrl: server.baseUrl,
      token,
      sessionId: nestedSessionId,
      folderId: FOLDER_ALPHA_ID,
    });
    await refreshFolderDragView();

    await expect(page.getByTestId(`session-list-item-${rootSessionId}`)).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId(`session-list-item-${nestedSessionId}`)).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId(`session-list-item-${scrollSessionId}`)).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId(`session-list-item-${anotherRootSessionId}`)).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId(`session-folder-header-${FOLDER_ALPHA_ID}`)).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId(`session-folder-header-${FOLDER_BETA_ID}`)).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId('session-list-header:Active')).toHaveCount(1, { timeout: 120_000 });

    // The drag geometry/performance refactor replaced the per-row drop
    // indicators with ONE viewport-level overlay. Assert that single overlay is
    // present (and unique) before exercising drags.
    await expect(page.getByTestId('session-list-drop-overlay')).toHaveCount(1, { timeout: 60_000 });

    const rootIds = new Set([rootSessionId, scrollSessionId, anotherRootSessionId]);
    const rootOrder = async () => (await readVisibleSessionRowOrder(page)).filter((id) => rootIds.has(id));
    const [firstRoot, middleRoot, lastRoot] = await rootOrder();
    if (!firstRoot || !middleRoot || !lastRoot) throw new Error('Expected three visible root sessions');
    await dragSessionToTarget(page, { sessionId: firstRoot, targetTestId: `session-list-item-${lastRoot}`, targetEdge: 'bottom' });
    await expect.poll(rootOrder, { timeout: 60_000 }).toEqual([middleRoot, lastRoot, firstRoot]);
    await dragSessionToTarget(page, { sessionId: firstRoot, targetTestId: `session-list-item-${middleRoot}`, targetEdge: 'top' });
    await expect.poll(rootOrder, { timeout: 60_000 }).toEqual([firstRoot, middleRoot, lastRoot]);
    await dragSessionToTarget(page, { sessionId: middleRoot, targetTestId: `session-list-item-${lastRoot}`, targetEdge: 'bottom' });
    await expect.poll(rootOrder, { timeout: 60_000 }).toEqual([firstRoot, lastRoot, middleRoot]);
    await expect.poll(async () => {
      const settings = await readSessionFolderDragSettings({ baseUrl: serverBaseUrl, token: authToken, serverId });
      const expected = [firstRoot, lastRoot, middleRoot].map((id) => sessionOrderKey(serverId, id));
      return Object.values(settings.sessionListGroupOrderV1).some((keys) => {
        const positions = expected.map((key) => keys.indexOf(key));
        return positions.every((position) => position >= 0) && positions[0]! < positions[1]! && positions[1]! < positions[2]!;
      });
    }, { timeout: 60_000 }).toBe(true);
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0&server=${encodeURIComponent(uiServerUrl)}`, 120_000);
    await expect.poll(rootOrder, { timeout: 120_000 }).toEqual([firstRoot, lastRoot, middleRoot]);

    const otherWorkspaceA = await createPlainSession({ baseUrl: serverBaseUrl, token: authToken, title: `drag other workspace a ${run.runId}`, rootPath: `${rootPath}/other-a`, machineId: SEEDED_MACHINE_ID, tagPrefix: 'session-folders-drag' });
    const otherWorkspaceB = await createPlainSession({ baseUrl: serverBaseUrl, token: authToken, title: `drag other workspace b ${run.runId}`, rootPath: `${rootPath}/other-b`, machineId: SEEDED_MACHINE_ID, tagPrefix: 'session-folders-drag' });
    const pinIds = [firstRoot, otherWorkspaceA, otherWorkspaceB, nestedSessionId];
    const pinIdSet = new Set(pinIds);
    const pinOrder = async () => (await readVisibleSessionRowOrder(page)).filter((id) => pinIdSet.has(id));
    for (const [index, sessionId] of pinIds.entries()) {
      await setSessionOrganizationPin({ baseUrl: serverBaseUrl, token: authToken, sessionId, pinned: true, sortKey: String(index + 1).padStart(8, '0') });
    }
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0&server=${encodeURIComponent(uiServerUrl)}`, 120_000);
    await expect(page.getByTestId('session-list-header:pinned-v1')).toHaveCount(1, { timeout: 120_000 });
    await expect.poll(pinOrder, { timeout: 120_000 }).toEqual(pinIds);
    await dragSessionToTarget(page, { sessionId: nestedSessionId, targetTestId: `session-list-item-${firstRoot}`, targetEdge: 'top' });
    await expect.poll(pinOrder, { timeout: 60_000 }).toEqual([nestedSessionId, firstRoot, otherWorkspaceA, otherWorkspaceB]);
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0&server=${encodeURIComponent(uiServerUrl)}`, 120_000);
    await expect.poll(pinOrder, { timeout: 120_000 }).toEqual([nestedSessionId, firstRoot, otherWorkspaceA, otherWorkspaceB]);
    await dragSessionToTarget(page, { sessionId: otherWorkspaceA, targetTestId: `session-list-item-${firstRoot}`, targetEdge: 'top' });
    await expect.poll(pinOrder, { timeout: 60_000 }).toEqual([nestedSessionId, otherWorkspaceA, firstRoot, otherWorkspaceB]);
    await dragSessionToTarget(page, { sessionId: firstRoot, targetTestId: `session-list-item-${otherWorkspaceB}`, targetEdge: 'bottom' });
    await expect.poll(pinOrder, { timeout: 60_000 }).toEqual([nestedSessionId, otherWorkspaceA, otherWorkspaceB, firstRoot]);
    await expectFolderAssignment({ baseUrl: serverBaseUrl, token: authToken, sessionId: nestedSessionId, folderId: FOLDER_ALPHA_ID });
    if (process.env.HAPPIER_E2E_REORDER_ONLY === '1') return;
    for (const sessionId of pinIds) {
      await setSessionOrganizationPin({ baseUrl: serverBaseUrl, token: authToken, sessionId, pinned: false });
    }
    await refreshFolderDragView();

    await dragSessionToTarget(page, {
      sessionId: rootSessionId,
      targetTestId: `session-folder-header-${FOLDER_ALPHA_ID}`,
      targetEdge: 'top',
    });
    await expectFolderAssignment({
      baseUrl: server.baseUrl,
      token,
      sessionId: rootSessionId,
      folderId: null,
    });
    await expectOrderMapContainsBefore({
      baseUrl: server.baseUrl,
      token,
      serverId,
      firstKey: sessionOrderKey(serverId, rootSessionId),
      secondKey: folderOrderKey(FOLDER_ALPHA_ID),
    });
    await refreshFolderDragView();

    await dragSessionToTarget(page, {
      sessionId: rootSessionId,
      targetTestId: `session-folder-header-${FOLDER_BETA_ID}`,
      targetEdge: 'middle',
    });
    await expectFolderAssignment({
      baseUrl: server.baseUrl,
      token,
      sessionId: rootSessionId,
      folderId: FOLDER_BETA_ID,
    });
    await expectOrderMapStartsWith({
      baseUrl: server.baseUrl,
      token,
      serverId,
      firstKey: sessionOrderKey(serverId, rootSessionId),
    });

    await dragSessionToTarget(page, {
      sessionId: rootSessionId,
      targetTestId: `session-folder-header-${FOLDER_ALPHA_ID}`,
      targetEdge: 'top',
    });
    await expectFolderAssignment({
      baseUrl: server.baseUrl,
      token,
      sessionId: rootSessionId,
      folderId: null,
    });
    await expectOrderMapContainsBefore({
      baseUrl: server.baseUrl,
      token,
      serverId,
      firstKey: sessionOrderKey(serverId, rootSessionId),
      secondKey: folderOrderKey(FOLDER_ALPHA_ID),
    });
    await refreshFolderDragView();

    await dragFolderToTarget(page, {
      sourceFolderId: FOLDER_BETA_ID,
      targetTestId: `session-folder-header-${FOLDER_ALPHA_ID}`,
      targetEdge: 'middle',
    });
    await expectFolderParent({
      baseUrl: server.baseUrl,
      token,
      serverId,
      folderId: FOLDER_BETA_ID,
      parentId: FOLDER_ALPHA_ID,
    });
    await expectOrderMapContainsBefore({
      baseUrl: server.baseUrl,
      token,
      serverId,
      firstKey: folderOrderKey(FOLDER_BETA_ID),
      secondKey: folderOrderKey(FOLDER_ALPHA_CHILD_ID),
    });

    const beforeBlockedMove = await readSessionFolderDragSettings({ baseUrl: server.baseUrl, token, serverId });
    await dragFolderToTarget(page, {
      sourceFolderId: FOLDER_ALPHA_ID,
      targetTestId: `session-folder-header-${FOLDER_BETA_ID}`,
      targetEdge: 'middle',
    });
    await page.waitForTimeout(350);
    const afterBlockedMove = await readSessionFolderDragSettings({ baseUrl: server.baseUrl, token, serverId });
    expect(afterBlockedMove.sessionFoldersV1.folders).toEqual(beforeBlockedMove.sessionFoldersV1.folders);

    const scrollDrag = await dragSessionToTarget(page, {
      sessionId: scrollSessionId,
      targetTestId: `session-folder-header-${FOLDER_BOTTOM_ID}`,
      targetEdge: 'middle',
      scrollDuringDrag: 'target-into-view',
    });
    expect(scrollDrag.ok).toBe(true);
    await expectFolderAssignment({
      baseUrl: server.baseUrl,
      token,
      sessionId: scrollSessionId,
      folderId: FOLDER_BOTTOM_ID,
    });

    await setSessionFolderAssignment({
      baseUrl: server.baseUrl,
      token,
      sessionId: scrollSessionId,
      folderId: null,
    });
    await refreshFolderDragView();
    await expect(page.getByTestId(`session-list-item-${scrollSessionId}`)).toHaveCount(1, { timeout: 120_000 });

    const autoScrollDrag = await dragSessionToTarget(page, {
      sessionId: scrollSessionId,
      targetTestId: `session-folder-header-${FOLDER_BOTTOM_ID}`,
      targetEdge: 'middle',
      scrollDuringDrag: 'autoscroll-bottom',
    });
    expect(autoScrollDrag.ok).toBe(true);
    await expectFolderAssignment({
      baseUrl: server.baseUrl,
      token,
      sessionId: scrollSessionId,
      folderId: FOLDER_BOTTOM_ID,
    });
  });
});
