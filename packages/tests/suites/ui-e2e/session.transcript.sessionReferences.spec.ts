import { test, expect } from '@playwright/test';

import { upsertPlainAccountSettingsV2 } from '../../src/testkit/accountSettings';
import { createTestAuthMtls } from '../../src/testkit/auth';
import { fetchJson } from '../../src/testkit/http';
import { registerMachineIdentity } from '../../src/testkit/machineIdentity';
import { repoRootDir } from '../../src/testkit/paths';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { resolveUiWebBeforeAllTimeoutMs, startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { createRunDirs } from '../../src/testkit/runDir';
import { fetchSessionV2, patchSessionMetadataWithRetry } from '../../src/testkit/sessions';
import { appendBrowserDiagnostics, collectBrowserDiagnostics } from '../../src/testkit/uiE2e/browserDiagnostics';
import { startForwardedHeaderProxy } from '../../src/testkit/uiE2e/forwardedHeaderProxy';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';
import { createPlainSession } from '../../src/testkit/uiE2e/sessionFoldersDrag';
import { waitForInitialAppUi } from '../../src/testkit/uiE2e/waitForInitialAppUi';

const run = createRunDirs({ runLabel: 'ui-e2e-session-references' });
const machineId = 'session-reference-machine';
const identity = {
  email: `session-references-${run.runId}@example.com`,
  issuer: 'happier-ui-e2e-session-references',
  fingerprint: `session-references-${run.runId}`,
};
const authoredOption = 'Continue with happier-6e';
const authoredText = `Ask happier-6e and Turing; happier-eb remains unknown.\n\n<options>\n<option>${authoredOption}</option>\n</options>`;

type PlainMessage = { content: { t: 'plain'; v: unknown }; messageRole: string | null };

test.describe('ui e2e: historical native session references', () => {
  const suiteDir = run.testDir('session-references-suite');
  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let proxyStop: (() => Promise<void>) | null = null;
  let token = '';
  let uiBaseUrl = '';

  test.beforeAll(async () => {
    test.setTimeout(resolveUiWebBeforeAllTimeoutMs(process.env));
    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '0',
        HAPPIER_FEATURE_E2EE__KEYLESS_ACCOUNTS_ENABLED: '1',
        HAPPIER_FEATURE_ENCRYPTION__STORAGE_POLICY: 'optional',
        HAPPIER_FEATURE_ENCRYPTION__DEFAULT_ACCOUNT_MODE: 'plain',
        HAPPIER_FEATURE_AUTH_MTLS__ENABLED: '1',
        HAPPIER_FEATURE_AUTH_MTLS__MODE: 'forwarded',
        HAPPIER_FEATURE_AUTH_MTLS__TRUST_FORWARDED_HEADERS: '1',
        HAPPIER_FEATURE_AUTH_MTLS__AUTO_PROVISION: '1',
        HAPPIER_FEATURE_AUTH_MTLS__IDENTITY_SOURCE: 'san_email',
        HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_EMAIL_DOMAINS: 'example.com',
        HAPPIER_FEATURE_AUTH_MTLS__ALLOWED_ISSUERS: identity.issuer,
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
        'x-happier-client-cert-email': identity.email,
        'x-happier-client-cert-issuer': identity.issuer,
        'x-happier-client-cert-sha256': identity.fingerprint,
      },
    });
    proxyStop = proxy.stop;
    token = (await createTestAuthMtls(server.baseUrl, identity)).token;
    await upsertPlainAccountSettingsV2({ baseUrl: server.baseUrl, token, settings: {} });
    await registerMachineIdentity({ baseUrl: server.baseUrl, token, machineId, metadata: 'session-reference-machine' });
    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: proxy.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-session-references-${run.runId}`,
      },
    });
    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await ui?.stop();
    await proxyStop?.();
    await server?.stop();
  });

  test('resolves existing prose and options when evidence arrives without rewriting messages', async ({ page }) => {
    test.setTimeout(180_000);
    if (!server || !ui) throw new Error('missing server/UI fixtures');
    const diagnostics = collectBrowserDiagnostics({ page });
    const baseUrl = server.baseUrl;
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const create = (title: string, metadata: Record<string, unknown> = {}) => createPlainSession({
      baseUrl, token, title, metadata, rootPath: repoRootDir(), machineId, tagPrefix: 'session-references',
    });
    const sourceId = await create('Historical reply source');
    const claudeId = await create('Claude work', { claudeSessionId: 'native-claude-session' });
    const codexId = await create('Codex work', { flavor: 'codex', codexSessionId: 'native-codex-session' });
    const assignedAt = Date.now() - 1_000;
    const posted = await fetchJson<{ didWrite?: boolean }>(`${baseUrl}/v2/sessions/${sourceId}/messages`, {
      method: 'POST', headers,
      body: JSON.stringify({
        localId: 'historical-native-references', messageRole: 'agent',
        content: { t: 'plain', v: { role: 'agent', content: { type: 'output', data: {
          type: 'assistant', uuid: 'historical-native-references',
          message: { content: [{ type: 'text', text: authoredText }] },
        } } } },
      }),
    });
    expect(posted.status).toBe(200);
    expect(posted.data.didWrite).toBe(true);
    const readMessages = async () => {
      const response = await fetchJson<{ messages: PlainMessage[] }>(`${baseUrl}/v1/sessions/${sourceId}/messages`, { headers });
      expect(response.status).toBe(200);
      return response.data.messages;
    };
    const originalMessages = await readMessages();
    const patchMetadata = async (id: string, patch: Record<string, unknown>) => {
      const session = await fetchSessionV2(baseUrl, token, id);
      await patchSessionMetadataWithRetry({
        baseUrl, token, sessionId: id, expectedVersion: session.metadataVersion,
        ciphertext: JSON.stringify({ ...JSON.parse(session.metadata), ...patch }),
      });
    };
    try {
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/?happier_hmr=0`, 120_000);
      await waitForInitialAppUi({ page, timeoutMs: 120_000 });
      await page.getByTestId(`session-list-item-${sourceId}`).click();
      await expect(page.getByText('Ask happier-6e and Turing; happier-eb remains unknown.', { exact: true })).toBeVisible();
      await expect(page.getByRole('link', { name: 'Claude work', exact: true })).toHaveCount(0);

      const observedAt = Date.now();
      for (const [id, providerId, providerSessionId, alias] of [
        [claudeId, 'claude', 'native-claude-session', 'happier-6e'],
        [codexId, 'codex', 'native-codex-session', 'Turing'],
      ]) {
        await patchMetadata(id!, { nativeSessionAliasesV1: { v: 1, assignments: [
          { providerId, providerSessionId, alias, assignedAt, observedAt },
        ] } });
      }
      await expect(page.getByRole('link', { name: 'Claude work', exact: true })).toHaveCount(2);
      await expect(page.getByRole('link', { name: 'Codex work', exact: true })).toHaveCount(1);
      await expect(page.getByRole('link', { name: 'happier-eb', exact: true })).toHaveCount(0);
      await expect(page.getByText(/happier-eb remains unknown/)).toBeVisible();

      await patchMetadata(claudeId, { name: 'Renamed Claude work' });
      const claudeLinks = page.getByRole('link', { name: 'Renamed Claude work', exact: true });
      await expect(claudeLinks).toHaveCount(2);
      await claudeLinks.first().click();
      await expect(page).toHaveURL(new RegExp(`/session/${claudeId}(?:[/?#]|$)`));
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sourceId}?happier_hmr=0`, 120_000);
      await page.getByRole('link', { name: 'Codex work', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/session/${codexId}(?:[/?#]|$)`));
      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sourceId}?happier_hmr=0`, 120_000);
      await page.getByRole('link', { name: 'Renamed Claude work', exact: true }).nth(1).click();
      await expect(page).toHaveURL(new RegExp(`/session/${claudeId}(?:[/?#]|$)`));
      expect(await readMessages()).toEqual(originalMessages);

      await gotoDomContentLoadedWithRetries(page, `${uiBaseUrl}/session/${sourceId}?happier_hmr=0`, 120_000);
      // Inactive sessions can durably enqueue instead of appending immediately.
      // Observe the canonical persisted submission in either supported delivery mode.
      const submitted = page.waitForResponse((response) => response.request().method() === 'POST'
        && new RegExp(`/v2/sessions/${sourceId}/(?:messages|pending)$`).test(new URL(response.url()).pathname));
      await page.getByText('Continue with ', { exact: true }).click();
      const response = await submitted;
      expect(response.ok()).toBe(true);
      expect(response.request().postDataJSON()).toMatchObject({
        content: { t: 'plain', v: { role: 'user', content: { type: 'text', text: authoredOption } } },
      });
      expect((await readMessages())[0]).toEqual(originalMessages[0]);
    } catch (error) {
      throw appendBrowserDiagnostics(error, diagnostics());
    }
  });
});
