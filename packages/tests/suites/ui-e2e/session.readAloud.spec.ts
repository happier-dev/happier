import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

import { upsertEncryptedAccountSettingsV2 } from '../../src/testkit/accountSettings';
import { encryptLegacyBase64 } from '../../src/testkit/messageCrypto';
import { createRunDirs } from '../../src/testkit/runDir';
import { createSessionWithCiphertexts } from '../../src/testkit/sessions';
import { postEncryptedUiTextMessage } from '../../src/testkit/uiMessages';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';
import { ensureAccountReadyForConnect } from '../../src/testkit/uiE2e/ensureAccountReadyForConnect';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e' });

async function readMountedSettings(page: Page) {
  return page.evaluate(() => {
    type ModuleEntry = { verboseName?: string; isInitialized?: boolean; publicModule?: { exports?: unknown } };
    const registry = (globalThis as typeof globalThis & {
      __r?: { getModules?: () => Map<number, ModuleEntry> };
    }).__r?.getModules?.();
    const entry = [...(registry?.values() ?? [])].find(candidate => candidate.isInitialized
      && candidate.verboseName?.replaceAll('\\', '/').endsWith('/sync/domains/state/storageStore.ts'));
    const owner = entry?.publicModule?.exports as {
      storage?: { getState(): { settings: Record<string, unknown>; settingsVersion: number | null } };
    } | undefined;
    const state = owner?.storage?.getState();
    return state ? { settings: state.settings, version: state.settingsVersion } : null;
  });
}

test.describe('ui e2e: transcript read aloud', () => {
  const suiteDir = run.testDir('session-read-aloud');
  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;

  test.beforeAll(async () => {
    const uiEnv = { ...process.env, EXPO_PUBLIC_DEBUG: '1',
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-read-aloud-${run.runId}`,
      HAPPIER_E2E_UI_WEB_MODE: 'metro', HAPPIER_E2E_UI_WEB_NO_DEV: '0' };
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(uiEnv));
    await mkdir(suiteDir, { recursive: true });
    server = await startServerLight({ testDir: suiteDir, dbProvider: 'sqlite',
      extraEnv: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1', HAPPIER_FEATURE_VOICE__ENABLED: 'true' } });
    ui = await startUiWeb({ testDir: suiteDir, env: { ...uiEnv, EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl } });
    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('hides unavailable readout and keeps Stop usable after navigating away', async ({ page }) => {
    test.setTimeout(180_000);
    if (!server || !uiBaseUrl) throw new Error('Missing owned server/UI fixture');
    const diagnostics = collectBrowserDiagnostics({ page });
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      // Boundary: the browser speech engine. The actual app, Expo adapter, playback controller,
      // row and global surface remain real. This proves UI ownership, not acoustic output/autoplay.
      await page.addInitScript(() => {
        let current: SpeechSynthesisUtterance | null = null;
        const boundary = { spoken: [] as string[], cancelled: 0 };
        Object.assign(globalThis, { __readAloudSpeechBoundary: boundary });
        Object.defineProperty(window.speechSynthesis, 'speak', { value: (utterance: SpeechSynthesisUtterance) => {
          current = utterance;
          boundary.spoken.push(utterance.text);
          utterance.dispatchEvent(new Event('start'));
        } });
        Object.defineProperty(window.speechSynthesis, 'cancel', { value: () => {
          boundary.cancelled += 1;
          current?.dispatchEvent(new Event('pause'));
          current = null;
        } });
      });
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`);
      await waitForInitialAppUi({ page, browserDiagnostics: diagnostics });
      await ensureAccountReadyForConnect({ page });
      await expect.poll(async () => (await readMountedSettings(page))?.version, { timeout: 60_000 }).toBeGreaterThan(0);
      // Credentials belong only to the account just created by this fixture; never emit them.
      const credentials = await page.evaluate(() => {
        for (let index = 0; index < localStorage.length; index += 1) {
          const key = localStorage.key(index);
          if (!key?.startsWith('auth_credentials')) continue;
          const raw = localStorage.getItem(key);
          if (!raw) continue;
          const candidate = JSON.parse(raw) as { token?: unknown; secret?: unknown };
          if (typeof candidate.token === 'string' && typeof candidate.secret === 'string') {
            return { token: candidate.token, secret: candidate.secret };
          }
        }
        return null;
      });
      if (!credentials) throw new Error('Missing owned account credentials');
      const secret = Buffer.from(credentials.secret, 'base64url');
      const { sessionId } = await createSessionWithCiphertexts({ baseUrl: server.baseUrl, token: credentials.token,
        metadataCiphertextBase64: encryptLegacyBase64({ path: '/tmp/read-aloud-fixture', host: 'read-aloud-fixture' }, secret) });
      const text = 'Read this fixture message aloud.';
      await postEncryptedUiTextMessage({ baseUrl: server.baseUrl, token: credentials.token, secret, sessionId, text });
      const transcriptUrl = `${uiBaseUrl}/session/${sessionId}?happier_hmr=0`;
      await gotoDomContentLoadedWithRetries(page, transcriptUrl);
      await expect(page.getByText(text, { exact: true })).toBeVisible({ timeout: 60_000 });
      const speak = page.locator('[data-testid^="transcript-message-speak:"]');
      await expect(speak).toHaveCount(0);

      const before = await readMountedSettings(page);
      if (!before) throw new Error('Missing mounted settings');
      const voice = before.settings.voice as { adapters: Record<string, unknown>; [key: string]: unknown };
      const local = voice.adapters.local_conversation as Record<string, unknown>;
      const configure = async (tts: Record<string, unknown>) => {
        const priorVersion = (await readMountedSettings(page))?.version ?? 0;
        await upsertEncryptedAccountSettingsV2({ baseUrl: server!.baseUrl, token: credentials.token, secret,
          settings: { ...before.settings, experiments: true, featureToggles: { voice: true }, voice: {
            ...voice, providerId: 'local_conversation', adapters: { ...voice.adapters,
              local_conversation: { ...local, tts } },
          } } });
        await gotoDomContentLoadedWithRetries(page, transcriptUrl);
        await expect(page.getByText(text, { exact: true })).toBeVisible({ timeout: 60_000 });
        await expect.poll(async () => (await readMountedSettings(page))?.version ?? 0, { timeout: 60_000 })
          .toBeGreaterThan(priorVersion);
        await expect.poll(async () => (await readMountedSettings(page))?.settings, { timeout: 60_000 })
          .toMatchObject({ featureToggles: { voice: true }, voice: { providerId: 'local_conversation',
            adapters: { local_conversation: { tts } } } });
      };
      await configure({ provider: 'openai_compat', openaiCompat: { baseUrl: '' } });
      await expect(speak).toHaveCount(0);
      await configure({ provider: 'device', autoSpeakReplies: true });
      await expect(speak).toHaveCount(1);
      await page.getByText(text, { exact: true }).hover();
      await speak.click();
      await expect(speak).toHaveAttribute('aria-label', 'Stop reading aloud');
      await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & {
        __readAloudSpeechBoundary?: { spoken: string[] };
      }).__readAloudSpeechBoundary?.spoken)).toEqual([text]);
      await page.getByTestId('nav-settings').click();
      await expect(page.getByTestId('debug-router-pathname')).toHaveText('/settings');
      const stop = page.getByRole('button', { name: 'Stop reading aloud', exact: true });
      await expect(stop).toBeVisible();
      const cancelledBeforeStop = await page.evaluate(() => (globalThis as typeof globalThis & {
        __readAloudSpeechBoundary?: { cancelled: number };
      }).__readAloudSpeechBoundary?.cancelled ?? 0);
      await stop.click();
      await expect(stop).toHaveCount(0);
      await expect.poll(() => page.evaluate(() => (globalThis as typeof globalThis & {
        __readAloudSpeechBoundary?: { cancelled: number };
      }).__readAloudSpeechBoundary?.cancelled)).toBeGreaterThan(cancelledBeforeStop);
    } catch (error) {
      throw appendBrowserDiagnostics(error, diagnostics());
    }
  });
});
