import { expect, test } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { AIBackendProfileSchema, openAccountScopedBlobCiphertext } from '@happier-dev/protocol';

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

test.describe('ui e2e: unreadable profile retention', () => {
  const suiteDir = run.testDir('settings-profiles-raw-retention');
  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;

  test.beforeAll(async () => {
    const env = {
      ...process.env,
      EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-profiles-retention-${run.runId}`,
      HAPPIER_E2E_UI_WEB_MODE: 'metro',
    };
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(env));
    await mkdir(suiteDir, { recursive: true });
    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: { HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1' },
    });
    ui = await startUiWeb({ testDir: suiteDir, env: { ...env, EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl } });
    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    try {
      await ui?.stop();
    } finally {
      await server?.stop();
    }
  });

  test('rejects an invalid name and preserves unreadable entries through an encrypted save and reload', async ({ page }) => {
    test.setTimeout(180_000);
    if (!server || !uiBaseUrl) throw new Error('Missing owned server/UI fixture');
    const diagnostics = collectBrowserDiagnostics({ page });
    try {
      await gotoDomContentLoadedWithRetries(page, uiBaseUrl);
      await waitForInitialAppUi({ page, browserDiagnostics: diagnostics });
      await ensureAccountReadyForConnect({ page });

      // Credentials belong only to this fresh test account and stay in memory.
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
      const secret = Buffer.from(credentials.secret, 'base64url');
      const visible = AIBackendProfileSchema.parse({ id: 'visible', name: 'Visible' });
      const unreadable = { id: 'unreadable', name: 'x'.repeat(101), futureField: { keep: true } };
      const bindings = { unreadable: { API_KEY: 'future-secret' } };
      const readRawSettings = async () => {
        const response = await fetchJson<{ content: { t: 'encrypted'; c: string } | { t: 'plain'; v: unknown } | null }>(
          `${server!.baseUrl}/v2/account/settings`, { headers: { Authorization: `Bearer ${credentials.token}` } },
        );
        expect(response.status).toBe(200);
        if (response.data.content?.t !== 'encrypted') throw new Error('Expected encrypted fixture settings');
        const opened = openAccountScopedBlobCiphertext({
          kind: 'account_settings', material: { type: 'legacy', secret }, ciphertext: response.data.content.c,
        });
        if (!opened || !opened.value || typeof opened.value !== 'object') throw new Error('Cannot open fixture settings');
        return opened.value;
      };
      await upsertEncryptedAccountSettingsV2({
        baseUrl: server.baseUrl, token: credentials.token, secret,
        settings: { useProfiles: true, profiles: [visible, unreadable], secretBindingsByProfileId: bindings },
      });
      const editorUrl = `${uiBaseUrl}/new/pick/profile-edit?profileId=visible`;
      await gotoDomContentLoadedWithRetries(page, editorUrl);
      const name = page.getByTestId('profile-name');
      await expect(name).toHaveValue('Visible', { timeout: 60_000 });

      await name.fill('x'.repeat(101));
      await expect(page.getByTestId('profile-save')).toBeEnabled();
      await page.getByTestId('profile-save').click();
      await expect(page.getByTestId('web-modal-button-0')).toBeVisible();
      await expect(name).toHaveValue('x'.repeat(101));
      expect(await readRawSettings()).toMatchObject({ profiles: [visible, unreadable] });
      await page.getByTestId('web-modal-button-0').click();

      // The accepted boundary value must save; a hard input truncation is insufficient.
      const acceptedName = 'v'.repeat(100);
      await name.fill(acceptedName);
      await page.getByTestId('profile-save').click();
      await expect.poll(readRawSettings, { timeout: 60_000 }).toMatchObject({
        profiles: [expect.objectContaining({ id: visible.id, name: acceptedName }), unreadable],
        secretBindingsByProfileId: bindings,
      });
      await gotoDomContentLoadedWithRetries(page, editorUrl);
      await expect(page.getByTestId('profile-name')).toHaveValue(acceptedName, { timeout: 60_000 });
      expect(await readRawSettings()).toMatchObject({
        profiles: [expect.objectContaining({ id: visible.id, name: acceptedName }), unreadable],
        secretBindingsByProfileId: bindings,
      });
    } catch (error) {
      throw appendBrowserDiagnostics(error, diagnostics());
    }
  });
});
