import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { repoRootDir } from '../../src/testkit/paths';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { setUiFeatureToggle } from '../../src/testkit/uiE2e/setUiFeatureToggle';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';
import { createTestAuthMtls } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { startForwardedHeaderProxy } from '../../src/testkit/uiE2e/forwardedHeaderProxy';

const run = createRunDirs({ runLabel: 'ui-e2e-session-folders-sidebar' });

const FOLDER_ID = 'lane_j_folder';
const FOLDER_NAME = 'Lane J folder';
const SEEDED_MACHINE_ID = 'seeded-session-folders-machine';
const IDENTITY_HEADERS = {
  email: `session-folders-${run.runId}@example.com`,
  issuer: 'happier-ui-e2e-session-folders',
  fingerprint: `session-folders-${run.runId}`,
} as const;
const ACCOUNT_SETTINGS_LOGICAL_KEY_PREFIX = 'account-settings:v2:';
const PENDING_ACCOUNT_SETTINGS_LOGICAL_KEY_PREFIX = 'pending-account-settings:v2:';

type PersistedSettingsEnvelope = {
  settings?: Record<string, unknown>;
};

type SessionFoldersSetting = Readonly<{
  v: 1;
  folders: ReadonlyArray<Readonly<{
    id: string;
    workspace: Readonly<{
      t: 'workspaceScope';
      serverId: string;
      machineId: string;
      rootPath: string;
    }>;
    parentId: string | null;
    name: string;
    createdAt: number;
    updatedAt: number;
  }>>;
}>;

type SessionCreateResponse = {
  session?: {
    id?: string;
  };
};

function deriveServerIdFromUrl(url: string): string {
  const normalized = url.trim();
  const parsed = new URL(normalized);
  const port = parsed.port ? `-${parsed.port}` : '';
  const base = `${parsed.hostname.toLowerCase()}${port}`;
  return base.replace(/[^a-z0-9._-]/g, '_').replace(/_+/g, '_') || 'custom';
}

async function setSessionFolderSidebarSettings(params: Readonly<{
  page: Page;
  baseUrl: string;
  sessionFoldersV1: SessionFoldersSetting;
}>): Promise<void> {
  await params.page.evaluate(
    ({ accountSettingsLogicalKeyPrefix, pendingAccountSettingsLogicalKeyPrefix, sessionFoldersV1 }) => {
      type ParsedScopedSettingsKey = Readonly<{
        fullKey: string;
        logicalKey: string;
        storageNamespace: string;
      }>;

      const parseScopedSettingsKey = (rawKey: string): ParsedScopedSettingsKey | null => {
        const separatorIndex = rawKey.lastIndexOf('\\');
        if (separatorIndex <= 0 || separatorIndex >= rawKey.length - 1) return null;

        const storageNamespace = rawKey.slice(0, separatorIndex);
        const logicalKey = rawKey.slice(separatorIndex + 1);
        if (!logicalKey.startsWith(accountSettingsLogicalKeyPrefix)) return null;

        return {
          fullKey: rawKey,
          logicalKey,
          storageNamespace,
        };
      };

      const scopedSettingsKeys: ParsedScopedSettingsKey[] = [];
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const rawKey = window.localStorage.key(index);
        if (!rawKey) continue;

        const parsedKey = parseScopedSettingsKey(rawKey);
        if (parsedKey) scopedSettingsKeys.push(parsedKey);
      }
      if (scopedSettingsKeys.length !== 1) {
        throw new Error(`expected exactly one scoped persisted settings record, found ${scopedSettingsKeys.length}`);
      }

      const settingsKey = scopedSettingsKeys[0]!;
      const pendingSettingsKey = `${settingsKey.storageNamespace}\\${pendingAccountSettingsLogicalKeyPrefix}${settingsKey.logicalKey.slice(accountSettingsLogicalKeyPrefix.length)}`;
      const rawSettings = window.localStorage.getItem(settingsKey.fullKey);
      if (!rawSettings) throw new Error('missing persisted settings');

      const parsed = JSON.parse(rawSettings) as PersistedSettingsEnvelope;
      const settings = typeof parsed.settings === 'object' && parsed.settings ? parsed.settings : {};
      const rawPending = window.localStorage.getItem(pendingSettingsKey);
      const pending = rawPending && typeof JSON.parse(rawPending) === 'object'
        ? JSON.parse(rawPending) as Record<string, unknown>
        : {};

      parsed.settings = {
        ...settings,
        sessionFoldersV1,
        sessionFolderViewModeV1: 'off',
      };

      window.localStorage.setItem(settingsKey.fullKey, JSON.stringify(parsed));
      window.localStorage.setItem(
        pendingSettingsKey,
        JSON.stringify({
          ...pending,
          sessionFoldersV1,
          sessionFolderViewModeV1: 'off',
        }),
      );
    },
    {
      accountSettingsLogicalKeyPrefix: ACCOUNT_SETTINGS_LOGICAL_KEY_PREFIX,
      pendingAccountSettingsLogicalKeyPrefix: PENDING_ACCOUNT_SETTINGS_LOGICAL_KEY_PREFIX,
      sessionFoldersV1: params.sessionFoldersV1,
    },
  );

  await gotoDomContentLoadedWithRetries(params.page, params.baseUrl, 120_000);
}

async function createPlainSession(params: Readonly<{
  baseUrl: string;
  token: string;
  title: string;
  rootPath: string;
}>): Promise<string> {
  const tag = `session-folders-${randomUUID()}`;
  const res = await fetchJson<SessionCreateResponse>(`${params.baseUrl}/v1/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${params.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      tag,
      metadata: JSON.stringify({
        v: 1,
        name: params.title,
        path: params.rootPath,
        homeDir: params.rootPath.split('/').slice(0, -1).join('/') || '/',
        host: SEEDED_MACHINE_ID,
        machineId: SEEDED_MACHINE_ID,
        version: '0.0.0',
        flavor: 'claude',
      }),
      agentState: null,
      dataEncryptionKey: null,
      encryptionMode: 'plain',
    }),
    timeoutMs: 20_000,
  });

  const sessionId = res.data?.session?.id;
  if (res.status !== 200 || typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error(`Failed to create seeded session (status=${res.status})`);
  }
  return sessionId;
}

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

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: proxy.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}`,
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

  test('moves a synced session into a seeded folder and scopes the sidebar focus to that folder', async ({ page }) => {
    test.setTimeout(720_000);
    if (!server || !uiBaseUrl || !token || !uiServerUrl) throw new Error('missing server/ui fixtures');

    await page.setViewportSize({ width: 1440, height: 900 });
    await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 300_000);
    await waitForInitialAppUi({ page, timeoutMs: 180_000 });

    const rootPath = repoRootDir();
    const firstSessionId = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: `folder move target ${run.runId}`,
      rootPath,
    });

    await setSessionFolderSidebarSettings({
      page,
      baseUrl: uiBaseUrl,
      sessionFoldersV1: {
        v: 1,
        folders: [{
          id: FOLDER_ID,
          workspace: {
            t: 'workspaceScope',
            serverId: deriveServerIdFromUrl(uiServerUrl),
            machineId: SEEDED_MACHINE_ID,
            rootPath,
          },
          parentId: null,
          name: FOLDER_NAME,
          createdAt: 1,
          updatedAt: 1,
        }],
      },
    });

    await setUiFeatureToggle({
      page,
      baseUrl: uiBaseUrl,
      featureId: 'sessions.folders',
      enabled: true,
    });

    await expect(page.getByTestId(`session-list-item-${firstSessionId}`)).toHaveCount(1, { timeout: 120_000 });

    await page.getByTestId('session-list-ordering-menu-trigger').first().click();
    await expect(page.getByTestId('session-folder-view-toggle')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('session-folder-view-toggle').click();

    await expect(page.getByTestId(`session-folder-header-${FOLDER_ID}`)).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId(`session-folder-drop-target-${FOLDER_ID}`)).toHaveCount(1, { timeout: 60_000 });

    await openSessionRowMenu({ page, sessionId: firstSessionId });
    await expect(page.getByTestId(`dropdown-option-move-to-folder_${FOLDER_ID}`)).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId(`dropdown-option-move-to-folder_${FOLDER_ID}`).click();

    await page.getByTestId(`session-folder-header-${FOLDER_ID}`).click();
    await expect(page.getByTestId('session-folder-breadcrumb')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId('session-folder-clear-focus')).toHaveCount(1, { timeout: 60_000 });
    await expect(page.getByTestId(`session-list-item-${firstSessionId}`)).toHaveCount(1, { timeout: 120_000 });

    await page.getByTestId('session-folder-clear-focus').click();
    await expect(page.getByTestId(`session-list-item-${firstSessionId}`)).toHaveCount(1, { timeout: 120_000 });

    await openSessionRowMenu({ page, sessionId: firstSessionId });
    await expect(page.getByTestId('dropdown-option-move-to-folder_null')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('dropdown-option-move-to-folder_null').click();

    await page.getByTestId(`session-folder-header-${FOLDER_ID}`).click();
    await expect(page.getByTestId(`session-list-item-${firstSessionId}`)).toHaveCount(0, { timeout: 120_000 });

    await page.getByTestId('session-folder-clear-focus').click();
    await expect(page.getByTestId(`session-list-item-${firstSessionId}`)).toHaveCount(1, { timeout: 120_000 });
  });
});
