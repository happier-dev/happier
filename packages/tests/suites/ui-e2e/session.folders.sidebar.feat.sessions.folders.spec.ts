import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { collectBrowserDiagnostics, appendBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { createTestAuthMtls } from '../../src/testkit/auth';
import { upsertPlainAccountSettingsV2 } from '../../src/testkit/accountSettings';
import { registerMachineIdentity } from '../../src/testkit/machineIdentity';
import { startForwardedHeaderProxy } from '../../src/testkit/uiE2e/forwardedHeaderProxy';
import {
  createPlainSession,
  ensureSessionFolderTreeView,
  expectFolderAssignment,
  resolveCanonicalServerIdForUi,
} from '../../src/testkit/uiE2e/sessionFoldersDrag';

import {
  buildSessionOrganizationImportRequestFromFolderSettings,
  importSessionOrganization,
  readSessionOrganizationFolderSettingsSnapshot,
} from '../../src/testkit/uiE2e/sessionOrganization';

const run = createRunDirs({ runLabel: 'ui-e2e-session-folders-sidebar' });

const FOLDER_ID = 'lane_j_folder';
const FOLDER_NAME = 'Lane J folder';
const SEEDED_MACHINE_ID = 'seeded-session-folders-machine';
const IDENTITY_HEADERS = {
  email: `session-folders-${run.runId}@example.com`,
  issuer: 'happier-ui-e2e-session-folders',
  fingerprint: `session-folders-${run.runId}`,
} as const;

async function openSessionRowMenu(params: Readonly<{ page: Page; sessionId: string }>): Promise<void> {
  const row = params.page.getByTestId(`session-list-item-${params.sessionId}`);
  await expect(row).toHaveCount(1, { timeout: 120_000 });
  await row.hover();

  const menuTrigger = row.getByTestId('session-item-more-menu');
  await expect(menuTrigger).toHaveCount(1, { timeout: 60_000 });
  await menuTrigger.click();
}

test.describe('ui e2e: session folders sidebar', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-folders-sidebar-suite');
  const cliHomeDir = resolve(join(suiteDir, 'cli-home'));

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;
  let proxyStop: (() => Promise<void>) | null = null;
  let token: string | null = null;
  let seededServerId: string | null = null;
  let seededSessionId: string | null = null;

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

    const auth = await createTestAuthMtls(server.baseUrl, {
      email: IDENTITY_HEADERS.email,
      issuer: IDENTITY_HEADERS.issuer,
      fingerprint: IDENTITY_HEADERS.fingerprint,
    });
    token = auth.token;
    await upsertPlainAccountSettingsV2({
      baseUrl: server.baseUrl,
      token,
      settings: {
        experiments: true,
        featureToggles: { 'sessions.folders': true, 'sessions.direct': true },
        sessionFolderViewModeV1: 'off',
        sessionListActiveGroupingV1: 'project',
        sessionListInactiveGroupingV1: 'project',
        sessionListOrderingModeV1: 'custom',
      },
    });

    const rootPath = repoRootDir();
    seededServerId = await resolveCanonicalServerIdForUi(proxy.baseUrl);
    await registerMachineIdentity({
      baseUrl: server.baseUrl,
      token,
      machineId: SEEDED_MACHINE_ID,
      metadata: 'session-folders-machine',
    });
    seededSessionId = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: 'folder move target ' + run.runId,
      rootPath,
      machineId: SEEDED_MACHINE_ID,
      tagPrefix: 'session-folders',
    });
    await importSessionOrganization({
      baseUrl: server.baseUrl,
      token,
      request: buildSessionOrganizationImportRequestFromFolderSettings({
        serverId: seededServerId,
        sessionFoldersV1: {
          v: 1,
          folders: [{
            id: FOLDER_ID,
            workspace: {
              t: 'workspaceScope',
              serverId: seededServerId,
              machineId: SEEDED_MACHINE_ID,
              rootPath,
            },
            parentId: null,
            name: FOLDER_NAME,
            createdAt: 1,
            updatedAt: 1,
          }],
        },
      }),
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: proxy.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
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

  test('moves a synced session into a seeded folder with folder view off', async ({ page }) => {
    test.setTimeout(180_000);
    if (!server || !uiBaseUrl || !token || !seededServerId || !seededSessionId) {
      throw new Error('missing server/ui fixtures');
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });

    const firstSessionId = seededSessionId;
    await expect(page.getByTestId('session-list-item-' + firstSessionId)).toHaveCount(1, { timeout: 120_000 });

    await expect(page.getByTestId(`session-folder-header-${FOLDER_ID}`)).toHaveCount(0);

    await openSessionRowMenu({ page, sessionId: firstSessionId });
    await expect(page.getByTestId('dropdown-option-ui_session_move-to-folder')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('dropdown-option-ui_session_move-to-folder').click();
    await expect(page.getByTestId('session-list-move-sheet')).toHaveCount(1, { timeout: 60_000 });
    const folderOption = page.getByTestId(`session-list-move-sheet:root:option:folder:${FOLDER_ID}`);
    await expect(folderOption).toHaveCount(1, { timeout: 60_000 });
    await folderOption.click();
    await expectFolderAssignment({
      baseUrl: server.baseUrl,
      token,
      sessionId: firstSessionId,
      folderId: FOLDER_ID,
    });

  });

  test('bulk moves a mixed assignment selection with folder view off', async ({ page }) => {
    test.setTimeout(180_000);
    if (!server || !uiBaseUrl || !token || !seededServerId || !seededSessionId) {
      throw new Error('missing server/ui fixtures');
    }
    const diagnostics = collectBrowserDiagnostics({ page });
    try {
      const secondSessionId = await createPlainSession({
        baseUrl: server.baseUrl, token, title: 'bulk folder target ' + run.runId,
        rootPath: repoRootDir(), machineId: SEEDED_MACHINE_ID, tagPrefix: 'session-folders-bulk',
      });
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
      await waitForInitialAppUi({ page, timeoutMs: 180_000 });
      await expect(page.getByTestId(`session-folder-header-${FOLDER_ID}`)).toHaveCount(0);
      const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
      for (const sessionId of [seededSessionId, secondSessionId]) {
        const row = page.getByTestId(`session-list-item-${sessionId}`);
        await expect(row).toHaveCount(1, { timeout: 120_000 });
        await row.click({ modifiers: [modifier] });
      }
      await expect(page.getByTestId('session-list-selection-count')).toHaveAttribute('data-selected-count', '2');
      await page.getByTestId('session-list-selection-action-session-move-to-folder').click();
      const destination = page.getByTestId(`session-list-move-sheet:root:option:folder:${FOLDER_ID}`);
      await expect(destination).toBeEnabled();
      await destination.click();
      await expect(page.getByTestId('session-list-selection-result')).toHaveAttribute('data-succeeded-count', '2', { timeout: 60_000 });
      for (const sessionId of [seededSessionId, secondSessionId]) {
        await expectFolderAssignment({ baseUrl: server.baseUrl, token, sessionId, folderId: FOLDER_ID });
      }
    } catch (error) {
      throw appendBrowserDiagnostics(error, diagnostics());
    }
  });

  test('moves a Direct session into the shared folder and retains it after reload', async ({ page }) => {
    test.setTimeout(180_000);
    if (!server || !uiBaseUrl || !token || !seededServerId) throw new Error('missing server/ui fixtures');
    const folderScope = { baseUrl: server.baseUrl, token, serverId: seededServerId };
    const diagnostics = collectBrowserDiagnostics({ page });
    try {
      const sessionId = await createPlainSession({
        baseUrl: server.baseUrl, token, title: 'Direct folder target ' + run.runId,
        rootPath: repoRootDir(), machineId: SEEDED_MACHINE_ID, tagPrefix: 'session-folders-direct',
        metadata: {
          flavor: 'codex',
          directSessionV1: {
            v: 1, providerId: 'codex', machineId: SEEDED_MACHINE_ID,
            remoteSessionId: 'folder-fixture-' + run.runId,
            source: { kind: 'codexHome', home: 'user' },
          },
        },
      });
      await page.setViewportSize({ width: 1440, height: 900 });
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
      await waitForInitialAppUi({ page, timeoutMs: 180_000 });
      await page.getByRole('tab', { name: 'Direct', exact: true }).click();
      const folderName = 'Created in Direct';
      const projectHeader = page.locator('[data-testid^="session-list-project-header:"]').first();
      await projectHeader.hover();
      await page.locator('[data-testid^="session-workspace-menu-trigger:"]').first().click();
      await page.getByTestId('dropdown-option-add-folder').click();
      await page.getByTestId('web-prompt-input').fill(folderName);
      await page.getByTestId('web-prompt-confirm').click();
      const readCreatedFolder = async () => {
        const snapshot = await readSessionOrganizationFolderSettingsSnapshot(folderScope);
        return snapshot.sessionFoldersV1.folders.find((folder) => folder.name === folderName);
      };
      await expect.poll(readCreatedFolder).toBeTruthy();
      const createdFolder = await readCreatedFolder();
      if (!createdFolder) throw new Error('Direct folder creation did not persist');
      await openSessionRowMenu({ page, sessionId });
      await page.getByTestId('dropdown-option-ui_session_move-to-folder').click();
      await page.getByTestId(`session-list-move-sheet:root:option:folder:${FOLDER_ID}`).click();
      await expectFolderAssignment({ baseUrl: server.baseUrl, token, sessionId, folderId: FOLDER_ID });
      await ensureSessionFolderTreeView({ page, apiBaseUrl: server.baseUrl, token, firstFolderId: FOLDER_ID });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await waitForInitialAppUi({ page, timeoutMs: 180_000 });
      await page.getByRole('tab', { name: 'Direct', exact: true }).click();
      await expect(page.getByTestId(`session-folder-header-${FOLDER_ID}`)).toBeVisible();
      await expect(page.getByTestId(`session-list-item-${sessionId}`)).toBeVisible();
      await expectFolderAssignment({ baseUrl: server.baseUrl, token, sessionId, folderId: FOLDER_ID });
      await page.getByRole('tab', { name: 'Happier', exact: true }).click();
      await expect(page.getByTestId(`session-folder-header-${createdFolder.id}`)).toBeVisible();
      await expect(page.getByTestId(`session-list-item-${sessionId}`)).toHaveCount(0);
    } catch (error) {
      throw appendBrowserDiagnostics(error, diagnostics());
    }
  });
});
