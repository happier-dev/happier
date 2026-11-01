import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { upsertEncryptedAccountSettingsV2 } from '../../src/testkit/accountSettings';
import { fetchJson } from '../../src/testkit/http';
import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e' });

type VoiceSnapshot = {
  providerId: string;
  adapters: {
    realtime_elevenlabs: { billingMode: string; [key: string]: unknown };
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

// Observe only factories the real app has initialized. Never require a module:
// doing so would both bypass the mounted owner and contaminate chunk assertions.
async function readMountedState(page: Page) {
  return page.evaluate(() => {
    type ModuleEntry = {
      verboseName?: string;
      isInitialized?: boolean;
      publicModule?: { exports?: unknown };
    };
    // Metro's development registry is an external debugger boundary.
    const registry = (globalThis as typeof globalThis & {
      __r?: { getModules?: () => Map<number, ModuleEntry> };
    }).__r?.getModules?.();
    const initializedExport = (suffix: string): unknown => {
      const entry = [...(registry?.values() ?? [])].find((candidate) =>
        candidate.isInitialized && candidate.verboseName?.replaceAll('\\', '/').endsWith(suffix));
      return entry?.publicModule?.exports;
    };
    const storeModule = initializedExport('/sync/domains/state/storageStore.ts') as {
      storage?: { getState(): {
        settings: Record<string, unknown> & { voice: VoiceSnapshot };
        settingsVersion: number | null;
        settingsScope: { serverId: string; accountId: string } | null;
      } };
    } | undefined;
    const persistence = initializedExport('/sync/domains/state/accountSettingsPersistence.ts') as {
      loadPendingAccountSettings?: (scope: { serverId: string; accountId: string }) => Record<string, unknown>;
    } | undefined;
    const authModule = initializedExport('/auth/context/AuthContext.tsx') as {
      getCurrentAuth?: () => { isAuthenticated: boolean; credentials: { token: string; secret?: string } | null } | null;
    } | undefined;
    const state = storeModule?.storage?.getState();
    const auth = authModule?.getCurrentAuth?.();
    if (!state?.settingsScope || !auth || !persistence?.loadPendingAccountSettings) return null;
    const pending = persistence.loadPendingAccountSettings(state.settingsScope);
    return {
      settings: state.settings,
      version: state.settingsVersion,
      authenticated: auth.isAuthenticated,
      pendingVoice: Object.hasOwn(pending, 'voice'),
    };
  });
}

test.describe('ui e2e: voice settings hydration', () => {
  test.describe.configure({ mode: 'serial' });
  const suiteDir = run.testDir('settings-voice-hydration');
  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;

  test.beforeAll(async () => {
    const uiEnv = {
      ...process.env,
      EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-voice-hydration-${run.runId}`,
      HAPPIER_E2E_UI_WEB_MODE: 'metro',
      // Registry access is read-only observability; production WebKit covers
      // the same behavior independently without development React.
      HAPPIER_E2E_UI_WEB_NO_DEV: '0',
    };
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiEnv));
    await mkdir(suiteDir, { recursive: true });
    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'voice.happierVoice',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
      },
    });
    ui = await startUiWeb({ testDir: suiteDir, env: { ...uiEnv, EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl } });
    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  for (const billingMode of ['happier', 'byo'] as const) {
    test(`handles late ${billingMode} settings without changing authentication`, async ({ page }) => {
      test.setTimeout(180_000);
      if (!server || !uiBaseUrl) throw new Error('Missing owned server/UI fixture');
      const diagnostics = collectBrowserDiagnostics({ page });
      let releaseSettings: (() => void) | undefined;
      try {
        await test.step('create the isolated account through the UI', async () => {
          await gotoDomContentLoadedWithRetries(page, uiBaseUrl!);
          await waitForInitialAppUi({ page, browserDiagnostics: diagnostics });
          await ensureAccountReadyForConnect({ page });
        });
        await test.step('observe authenticated voice off in the mounted store', async () => {
          await expect.poll(async () => {
            const state = await readMountedState(page);
            return { authenticated: state?.authenticated, provider: state?.settings.voice.providerId };
          }, { timeout: 60_000 }).toEqual({ authenticated: true, provider: 'off' });
        });
        // The initial automatic off write must finish before the reload. A
        // persisted pending off delta could otherwise mask the hydration bug.
        await test.step('wait for the initial off write acknowledgement', async () => {
          await expect.poll(async () => {
            const state = await readMountedState(page);
            return state?.pendingVoice === false && typeof state.version === 'number' && state.version > 0;
          }, { timeout: 60_000 }).toBe(true);
        });

        // Keep credentials only in this fresh fixture's memory, never artifacts.
        const credentials = await page.evaluate(() => {
          for (let index = 0; index < localStorage.length; index += 1) {
            const key = localStorage.key(index);
            if (!key?.startsWith('auth_credentials')) continue;
            const raw = localStorage.getItem(key);
            if (!raw) continue;
            const value: unknown = JSON.parse(raw);
            if (!value || typeof value !== 'object') continue;
            const candidate = value as { token?: unknown; secret?: unknown };
            if (typeof candidate.token === 'string' && typeof candidate.secret === 'string') {
              return { token: candidate.token, secret: candidate.secret };
            }
          }
          return null;
        });
        if (!credentials) throw new Error('Missing owned account credentials');

        const release = new Promise<void>((resolve) => { releaseSettings = resolve; });
        let firstGetHeld = false;
        await page.route((url) => url.pathname === '/v2/account/settings', async (route) => {
          if (route.request().method() === 'GET' && !firstGetHeld) {
            firstGetHeld = true;
            await release;
          }
          await route.continue();
        });
        const writerRequests: string[] = [];
        page.on('request', (request) => {
          if (request.resourceType() === 'script' && new URL(request.url()).pathname.includes('settingsWriters')) {
            writerRequests.push(request.url());
          }
        });
        await test.step('reload with the real settings GET held', async () => {
          await gotoDomContentLoadedWithRetries(page, uiBaseUrl!);
          await expect.poll(() => firstGetHeld, { timeout: 60_000 }).toBe(true);
        });
        await expect.poll(async () => {
          const state = await readMountedState(page);
          return { authenticated: state?.authenticated, provider: state?.settings.voice.providerId };
        }, { timeout: 60_000 }).toEqual({ authenticated: true, provider: 'off' });
        expect(writerRequests, 'voice off must not fetch the writer chunk').toEqual([]);
        const before = await readMountedState(page);
        if (!before) throw new Error('Missing mounted settings');
        const voice = before.settings.voice;
        await upsertEncryptedAccountSettingsV2({
          baseUrl: server.baseUrl,
          token: credentials.token,
          secret: Buffer.from(credentials.secret, 'base64url'),
          settings: {
            ...before.settings,
            voice: {
              ...voice,
              providerId: 'realtime_elevenlabs',
              adapters: { ...voice.adapters, realtime_elevenlabs: { ...voice.adapters.realtime_elevenlabs, billingMode } },
            },
          },
        });
        const serverSettings = await fetchJson<{ version: number }>(`${server.baseUrl}/v2/account/settings`, {
          headers: { Authorization: `Bearer ${credentials.token}` },
        });
        expect(serverSettings.status).toBe(200);
        const hydratedVersion = serverSettings.data.version;
        expect(hydratedVersion).toBeGreaterThan(before.version ?? 0);
        const response = page.waitForResponse((candidate) =>
          candidate.request().method() === 'GET' && new URL(candidate.url()).pathname === '/v2/account/settings');
        releaseSettings?.();
        expect((await response).status()).toBe(200);
        await expect.poll(async () => (await readMountedState(page))?.version, { timeout: 60_000 })
          .toBeGreaterThanOrEqual(hydratedVersion);
        await expect.poll(async () => {
          const state = await readMountedState(page);
          return { authenticated: state?.authenticated, provider: state?.settings.voice.providerId };
        }, { timeout: 60_000 }).toEqual({
          authenticated: true,
          provider: billingMode === 'happier' ? 'off' : 'realtime_elevenlabs',
        });
        const features = await fetchJson<{ features: { voice: { happierVoice: { enabled: boolean } } } }>(`${server.baseUrl}/v1/features`);
        expect(features.status).toBe(200);
        expect(features.data.features.voice.happierVoice.enabled).toBe(false);
        await test.step('preserve the selected mode on the real voice settings route', async () => {
          await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/settings/voice`);
          await expect(page.getByTestId('debug-router-pathname')).toHaveText('/settings/voice');
          // This route has no field testIDs; the visible BYO control confirms
          // its actual screen has rendered rather than only the router shell.
          await expect(page.getByText('Use your own ElevenLabs API key and agent', { exact: true })).toBeVisible();
          await expect.poll(async () => {
            const state = await readMountedState(page);
            return {
              authenticated: state?.authenticated,
              provider: state?.settings.voice.providerId,
              billingMode: state?.settings.voice.adapters.realtime_elevenlabs.billingMode,
            };
          }, { timeout: 60_000 }).toEqual({
            authenticated: true,
            provider: billingMode === 'happier' ? 'off' : 'realtime_elevenlabs',
            billingMode,
          });
        });
      } catch (error) {
        throw appendBrowserDiagnostics(error, diagnostics());
      } finally {
        releaseSettings?.();
        await page.unrouteAll({ behavior: 'wait' });
      }
    });
  }
});
