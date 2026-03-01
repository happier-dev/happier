import { test, expect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { startUiWeb, type StartedUiWeb } from '../../src/testkit/process/uiWeb';
import { gotoDomContentLoadedWithRetries, normalizeLoopbackBaseUrl } from '../../src/testkit/uiE2e/pageNavigation';

const run = createRunDirs({ runLabel: 'ui-e2e' });

function toPrivacyKitBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(input.byteLength);
  out.set(input);
  return out;
}

async function postJson<T>(url: string, body: unknown, timeoutMs = 15_000): Promise<{ status: number; data: T | null }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => '');
  const data = text ? (JSON.parse(text) as T) : null;
  return { status: res.status, data };
}

async function getJson<T>(url: string, headers?: Record<string, string>, timeoutMs = 15_000): Promise<{ status: number; data: T | null }> {
  const res = await fetch(url, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text().catch(() => '');
  const data = text ? (JSON.parse(text) as T) : null;
  return { status: res.status, data };
}

function decryptTokenEncryptedBundle(params: { tokenEncryptedBase64: string; recipientSecretKey: Uint8Array }): string {
  const bundle = privacyKit.decodeBase64(params.tokenEncryptedBase64);
  const ephemeralPublicKey = bundle.slice(0, tweetnacl.box.publicKeyLength);
  const nonce = bundle.slice(tweetnacl.box.publicKeyLength, tweetnacl.box.publicKeyLength + tweetnacl.box.nonceLength);
  const ciphertext = bundle.slice(tweetnacl.box.publicKeyLength + tweetnacl.box.nonceLength);
  const opened = tweetnacl.box.open(ciphertext, nonce, ephemeralPublicKey, params.recipientSecretKey);
  if (!opened) {
    throw new Error('Failed to decrypt tokenEncrypted bundle');
  }
  return new TextDecoder().decode(opened);
}

async function createAccountViaWeb(page: Page, baseUrl: string): Promise<void> {
  await gotoDomContentLoadedWithRetries(page, baseUrl);
  await expect(page.getByTestId('welcome-create-account')).toHaveCount(1, { timeout: 120_000 });
  await page.getByTestId('welcome-create-account').click();
  await expect(page.getByTestId('session-getting-started-kind-connect_machine')).not.toHaveCount(0, { timeout: 120_000 });
}

test.describe('ui e2e: add your phone (desktop QR → mobile scan)', () => {
  test.describe.configure({ mode: 'serial' });
  // Override the default phone-sized viewport for this suite: this flow is desktop/web-first.
  test.use({ viewport: { width: 1280, height: 844 } });

  const suiteDir = run.testDir('auth-pairing-add-phone-suite');

  let server: StartedServer | null = null;
  let ui: StartedUiWeb | null = null;
  let uiBaseUrl: string | null = null;

  test.beforeAll(async () => {
    test.setTimeout(420_000);
    await mkdir(suiteDir, { recursive: true });

    server = await startServerLight({
      testDir: suiteDir,
      dbProvider: 'sqlite',
      extraEnv: {
        // Keep UI web create-account unblocked (see existing ui-e2e suites).
        HAPPIER_BUILD_FEATURES_DENY: 'sharing.contentKeys',
        HAPPIER_FEATURE_AUTH_LOGIN__KEY_CHALLENGE_ENABLED: '1',
      },
    });

    ui = await startUiWeb({
      testDir: suiteDir,
      env: {
        ...process.env,
        CI: '1',
        EXPO_PUBLIC_DEBUG: '1',
        EXPO_PUBLIC_HAPPY_SERVER_URL: server.baseUrl,
        EXPO_PUBLIC_HAPPY_STORAGE_SCOPE: `e2e-${run.runId}-pairing`,
      },
    });
    uiBaseUrl = normalizeLoopbackBaseUrl(ui.baseUrl);
  });

  test.afterAll(async () => {
    test.setTimeout(120_000);
    await ui?.stop().catch(() => {});
    await server?.stop().catch(() => {});
  });

  test('shows pairing QR, accepts pairing request, and approves (mobile receives token)', async ({ page }) => {
    test.setTimeout(420_000);
    if (!server) throw new Error('missing server fixture');
    if (!uiBaseUrl) throw new Error('missing ui base url');
    const startedServer = server;

    const testDir = resolve(join(suiteDir, 't1-add-phone'));
    await mkdir(testDir, { recursive: true });

    await createAccountViaWeb(page, uiBaseUrl);

    await page.goto(`${uiBaseUrl}/settings`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByTestId('settings-add-your-phone-shortcut')).toHaveCount(1, { timeout: 120_000 });
    await page.getByTestId('settings-add-your-phone-shortcut').click();

    await expect(page).toHaveURL(/\/settings\/add-phone/, { timeout: 60_000 });
    await expect(page.getByTestId('add-phone-pairing-link')).toHaveCount(1, { timeout: 120_000 });

    const pairingLinkRaw = (await page.getByTestId('add-phone-pairing-link').innerText()).trim();
    if (!pairingLinkRaw.startsWith('happier:///pair')) {
      throw new Error(`Expected pairing link to start with happier:///pair (got: ${pairingLinkRaw.slice(0, 64)}...)`);
    }

    const pairingUrl = new URL(pairingLinkRaw);
    const pairId = pairingUrl.searchParams.get('pairId') ?? '';
    const secret = pairingUrl.searchParams.get('secret') ?? '';
    const serverUrl = pairingUrl.searchParams.get('server') ?? '';
    if (!pairId || !secret || !serverUrl) {
      throw new Error(`Pairing link missing params (pairId=${pairId.length}, secret=${secret.length}, server=${serverUrl.length})`);
    }

    const phoneKp = tweetnacl.box.keyPair();
    const phonePublicKeyBase64 = privacyKit.encodeBase64(toPrivacyKitBytes(phoneKp.publicKey));
    const deviceLabel = `Playwright Phone (${run.runId})`;

    const startAuth = await postJson<{ state?: string }>(`${startedServer.baseUrl}/v1/auth/account/request`, {
      publicKey: phonePublicKeyBase64,
    });
    expect(startAuth.status).toBe(200);
    expect(startAuth.data?.state).toBe('requested');

    const pairingRequest = await postJson<{ state?: string; confirmCode?: string }>(`${startedServer.baseUrl}/v1/auth/pairing/request`, {
      pairId,
      secret,
      publicKey: phonePublicKeyBase64,
      deviceLabel,
    });
    expect(pairingRequest.status).toBe(200);
    expect(pairingRequest.data?.state).toBe('requested');
    const confirmCode = String(pairingRequest.data?.confirmCode ?? '').trim();
    if (!/^[0-9]{3} [0-9]{3}$/.test(confirmCode)) {
      throw new Error(`Invalid confirmCode: ${confirmCode}`);
    }

    await expect(page.getByTestId('add-phone-request-device-label')).toHaveText(deviceLabel, { timeout: 60_000 });
    await expect(page.getByTestId('add-phone-request-confirm-code')).toHaveText(confirmCode, { timeout: 60_000 });

    await expect(page.getByTestId('add-phone-approve')).toHaveCount(1, { timeout: 60_000 });
    await page.getByTestId('add-phone-approve').click();

    await expect(page.getByTestId('add-phone-request-card')).toHaveCount(0, { timeout: 120_000 });

    let authorizedPayload: any = null;
    await expect
      .poll(
        async () => {
          const pollRes = await postJson<any>(
            `${startedServer.baseUrl}/v2/auth/account/request`,
            { publicKey: phonePublicKeyBase64 },
            15_000,
          );
          if (pollRes.status !== 200) return `http_${pollRes.status}`;
          const state = pollRes.data?.state;
          if (state !== 'authorized') return String(state ?? 'missing_state');
          authorizedPayload = pollRes.data;
          return 'authorized';
        },
        { timeout: 60_000 },
      )
      .toBe('authorized');

    if (!authorizedPayload) {
      throw new Error('Expected authorized payload');
    }

    const payload = authorizedPayload as any;
    const mobileToken = decryptTokenEncryptedBundle({
      tokenEncryptedBase64: String(payload.tokenEncrypted),
      recipientSecretKey: phoneKp.secretKey,
    });

    const profileRes = await getJson<any>(`${startedServer.baseUrl}/v1/account/profile`, { Authorization: `Bearer ${mobileToken}` }, 15_000);
    expect(profileRes.status).toBe(200);
  });
});
