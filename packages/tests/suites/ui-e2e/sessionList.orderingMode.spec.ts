import { test, expect, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createTestAuthMtls } from '../../src/testkit/auth';
import { registerMachineIdentity } from '../../src/testkit/machineIdentity';
import { repoRootDir } from '../../src/testkit/paths';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { createRunDirs } from '../../src/testkit/runDir';
import { startForwardedHeaderProxy } from '../../src/testkit/uiE2e/forwardedHeaderProxy';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { setUiFeatureToggle } from '../../src/testkit/uiE2e/setUiFeatureToggle';
import {
  createPlainSession,
  deriveServerIdFromUrl,
  readSessionFolderDragSettings,
  readVisibleSessionRowOrder,
  sessionOrderKey,
} from '../../src/testkit/uiE2e/sessionFoldersDrag';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e-session-list-ordering-mode' });

const SEEDED_MACHINE_ID = 'seeded-session-list-ordering-machine';
const IDENTITY_HEADERS = {
  email: `session-list-ordering-${run.runId}@example.com`,
  issuer: 'happier-ui-e2e-session-list-ordering',
  fingerprint: `session-list-ordering-${run.runId}`,
} as const;

const SESSION_CREATE_TIMESTAMP_SEPARATION_MS = 35;
const ACCOUNT_SETTINGS_LOGICAL_KEY_PREFIX = 'account-settings:v2:';
const PENDING_ACCOUNT_SETTINGS_LOGICAL_KEY_PREFIX = 'pending-account-settings:v2:';

type PersistedSettingsEnvelope = {
  settings?: Record<string, unknown>;
};

async function pauseForDistinctCreatedAt(): Promise<void> {
  await new Promise((resolvePause) => setTimeout(resolvePause, SESSION_CREATE_TIMESTAMP_SEPARATION_MS));
}

async function readPersistedAccountSettings(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(({ accountSettingsLogicalKeyPrefix }) => {
    const keys: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const rawKey = window.localStorage.key(index);
      if (!rawKey) continue;
      const separatorIndex = rawKey.lastIndexOf('\\');
      if (separatorIndex <= 0) continue;
      const logicalKey = rawKey.slice(separatorIndex + 1);
      if (logicalKey.startsWith(accountSettingsLogicalKeyPrefix)) {
        keys.push(rawKey);
      }
    }
    if (keys.length !== 1) {
      throw new Error(`expected exactly one scoped persisted settings record, found ${keys.length}`);
    }

    const rawSettings = window.localStorage.getItem(keys[0]!);
    if (!rawSettings) throw new Error('missing persisted settings');
    const parsed = JSON.parse(rawSettings) as PersistedSettingsEnvelope;
    return typeof parsed.settings === 'object' && parsed.settings ? parsed.settings : {};
  }, { accountSettingsLogicalKeyPrefix: ACCOUNT_SETTINGS_LOGICAL_KEY_PREFIX });
}

async function mutatePersistedAccountSettings(params: Readonly<{
  page: Page;
  baseUrl: string;
  values: Record<string, unknown>;
}>): Promise<void> {
  await params.page.evaluate(
    ({ accountSettingsLogicalKeyPrefix, pendingAccountSettingsLogicalKeyPrefix, values }) => {
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
        ...values,
      };

      window.localStorage.setItem(settingsKey.fullKey, JSON.stringify(parsed));
      window.localStorage.setItem(
        pendingSettingsKey,
        JSON.stringify({
          ...pending,
          ...values,
        }),
      );
    },
    {
      accountSettingsLogicalKeyPrefix: ACCOUNT_SETTINGS_LOGICAL_KEY_PREFIX,
      pendingAccountSettingsLogicalKeyPrefix: PENDING_ACCOUNT_SETTINGS_LOGICAL_KEY_PREFIX,
      values: params.values,
    },
  );

  await gotoDomContentLoadedWithRetries(params.page, `${params.baseUrl}/?happier_hmr=0`, 120_000);
}

async function expectPersistedOrderingMode(page: Page, mode: 'custom' | 'created' | 'updated'): Promise<void> {
  await expect.poll(async () => {
    const settings = await readPersistedAccountSettings(page);
    return settings.sessionListOrderingModeV1;
  }, { timeout: 60_000 }).toBe(mode);
}

async function selectOrderingMode(page: Page, mode: 'custom' | 'created' | 'updated'): Promise<void> {
  await page.getByTestId('session-list-ordering-menu-trigger').first().click();
  const option = page.getByTestId(`session-list-ordering-mode-${mode}`);
  await expect(option).toHaveCount(1, { timeout: 60_000 });
  await option.click();
  await expectPersistedOrderingMode(page, mode);
}

async function waitForVisibleSessionOrder(page: Page, sessionIds: readonly string[]): Promise<string[]> {
  const expectedIds = new Set(sessionIds);
  await expect.poll(async () => {
    const visible = await readVisibleSessionRowOrder(page);
    return visible.filter((id) => expectedIds.has(id));
  }, { timeout: 120_000 }).toHaveLength(sessionIds.length);

  const visible = await readVisibleSessionRowOrder(page);
  return visible.filter((id) => expectedIds.has(id));
}

async function readFirstProjectGroupKey(page: Page): Promise<string> {
  const testId = await page.locator('[data-testid^="session-list-project-header:"]').first().getAttribute('data-testid');
  const prefix = 'session-list-project-header:';
  if (!testId?.startsWith(prefix)) throw new Error('missing session list project header testID');
  return testId.slice(prefix.length);
}

async function expectVisibleSessionOrder(page: Page, orderedSessionIds: readonly string[]): Promise<void> {
  const expectedIds = new Set(orderedSessionIds);
  await expect.poll(async () => {
    const visible = await readVisibleSessionRowOrder(page);
    return visible.filter((id) => expectedIds.has(id));
  }, { timeout: 120_000 }).toEqual([...orderedSessionIds]);
}

test.describe('ui e2e: session list ordering mode', () => {
  test.describe.configure({ mode: 'serial' });

  const suiteDir = run.testDir('session-list-ordering-mode-suite');
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
      metadata: 'session-list-ordering-machine',
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: proxy.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-session-list-ordering-${run.runId}`,
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

  test('switches updated and custom modes without mutating dormant custom order', async ({ page }) => {
    test.setTimeout(720_000);
    if (!server || !uiBaseUrl || !token || !uiServerUrl) throw new Error('missing server/ui fixtures');

    const rootPath = repoRootDir();
    const oldestSessionId = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: `ordering oldest ${run.runId}`,
      rootPath,
      machineId: SEEDED_MACHINE_ID,
      tagPrefix: 'session-list-ordering',
    });
    await pauseForDistinctCreatedAt();
    const middleSessionId = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: `ordering middle ${run.runId}`,
      rootPath,
      machineId: SEEDED_MACHINE_ID,
      tagPrefix: 'session-list-ordering',
    });
    await pauseForDistinctCreatedAt();
    const newestSessionId = await createPlainSession({
      baseUrl: server.baseUrl,
      token,
      title: `ordering newest ${run.runId}`,
      rootPath,
      machineId: SEEDED_MACHINE_ID,
      tagPrefix: 'session-list-ordering',
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

    await expect(page.getByTestId(`session-list-item-${oldestSessionId}`)).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId(`session-list-item-${middleSessionId}`)).toHaveCount(1, { timeout: 120_000 });
    await expect(page.getByTestId(`session-list-item-${newestSessionId}`)).toHaveCount(1, { timeout: 120_000 });

    const baselineDateOrder = await waitForVisibleSessionOrder(page, [
      oldestSessionId,
      middleSessionId,
      newestSessionId,
    ]);
    const movedSessionId = baselineDateOrder[baselineDateOrder.length - 1]!;
    const customOrder = [
      movedSessionId,
      ...baselineDateOrder.filter((sessionId) => sessionId !== movedSessionId),
    ];

    const projectGroupKey = await readFirstProjectGroupKey(page);
    const serverId = deriveServerIdFromUrl(uiServerUrl);
    const customOrderMap = {
      [projectGroupKey]: customOrder.map((sessionId) => sessionOrderKey(serverId, sessionId)),
    };
    await mutatePersistedAccountSettings({
      page,
      baseUrl: uiBaseUrl,
      values: {
        sessionListGroupOrderV1: customOrderMap,
      },
    });
    await expectVisibleSessionOrder(page, customOrder);

    const customOrderSnapshot = (await readSessionFolderDragSettings(page)).sessionListGroupOrderV1;
    expect(Object.values(customOrderSnapshot).some((keys) => Array.isArray(keys) && keys.length >= 2)).toBe(true);

    await selectOrderingMode(page, 'updated');
    await expectVisibleSessionOrder(page, baselineDateOrder);
    expect((await readSessionFolderDragSettings(page)).sessionListGroupOrderV1).toEqual(customOrderSnapshot);

    await selectOrderingMode(page, 'custom');
    await expectVisibleSessionOrder(page, customOrder);
    expect((await readSessionFolderDragSettings(page)).sessionListGroupOrderV1).toEqual(customOrderSnapshot);
  });
});
