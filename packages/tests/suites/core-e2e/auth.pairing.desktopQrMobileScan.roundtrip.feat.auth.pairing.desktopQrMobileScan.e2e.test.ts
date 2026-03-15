import { afterAll, describe, expect, it } from 'vitest';
import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';
import { createHash, randomBytes } from 'node:crypto';

import { createRunDirs } from '../../src/testkit/runDir';
import { startServerLight, type StartedServer } from '../../src/testkit/process/serverLight';
import { fetchJson } from '../../src/testkit/http';
import { waitFor } from '../../src/testkit/timing';
import { writeTestManifestForServer } from '../../src/testkit/manifestForServer';
import { FailureArtifacts } from '../../src/testkit/failureArtifacts';
import { envFlag } from '../../src/testkit/env';
import { sealBoxBundle, openBoxBundle } from '@happier-dev/protocol';

const run = createRunDirs({ runLabel: 'core' });

function toPrivacyKitBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(input.byteLength);
  out.set(input);
  return out;
}

function computeSecretHash(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('base64url');
}

async function createTokenFromSecretSeed(baseUrl: string, seed: Uint8Array): Promise<string> {
  const kp = tweetnacl.sign.keyPair.fromSeed(seed);
  const challenge = Uint8Array.from(randomBytes(32));
  const signature = tweetnacl.sign.detached(challenge, kp.secretKey);
  const body = {
    publicKey: privacyKit.encodeBase64(toPrivacyKitBytes(kp.publicKey)),
    challenge: privacyKit.encodeBase64(toPrivacyKitBytes(challenge)),
    signature: privacyKit.encodeBase64(toPrivacyKitBytes(signature)),
  };

  const res = await fetchJson<{ token?: string }>(`${baseUrl}/v1/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    timeoutMs: 15_000,
  });
  if (res.status !== 200 || typeof res.data?.token !== 'string' || res.data.token.length === 0) {
    throw new Error(`Failed to create token from secret (status=${res.status})`);
  }
  return res.data.token;
}

function decryptTokenEncryptedBundle(params: { tokenEncryptedBase64: string; recipientSecretKey: Uint8Array }): string {
  const bundle = privacyKit.decodeBase64(params.tokenEncryptedBase64);
  const ephemeralPublicKey = bundle.slice(0, tweetnacl.box.publicKeyLength);
  const nonce = bundle.slice(
    tweetnacl.box.publicKeyLength,
    tweetnacl.box.publicKeyLength + tweetnacl.box.nonceLength,
  );
  const ciphertext = bundle.slice(tweetnacl.box.publicKeyLength + tweetnacl.box.nonceLength);
  const opened = tweetnacl.box.open(ciphertext, nonce, ephemeralPublicKey, params.recipientSecretKey);
  if (!opened) {
    throw new Error('Failed to decrypt tokenEncrypted bundle');
  }
  return new TextDecoder().decode(opened);
}

describe('core e2e: auth pairing (desktop QR → mobile scan)', () => {
  let server: StartedServer | null = null;

  afterAll(async () => {
    await server?.stop();
  });

  it('restores a logged-out mobile device via desktop pairing QR', async () => {
    const testDir = run.testDir('auth-pairing-desktop-qr-mobile-scan');
    const saveArtifactsOnSuccess = envFlag(['HAPPIER_E2E_SAVE_ARTIFACTS', 'HAPPY_E2E_SAVE_ARTIFACTS'], false);
    const startedAt = new Date().toISOString();

    server = await startServerLight({ testDir });
    const startedServer = server;
    if (!startedServer) throw new Error('missing server fixture');

    writeTestManifestForServer({
      testDir,
      server: startedServer,
      startedAt,
      runId: run.runId,
      testName: 'auth-pairing-desktop-qr-mobile-scan',
      sessionIds: [],
      env: {
        CI: process.env.CI,
        HAPPIER_E2E_SAVE_ARTIFACTS: process.env.HAPPIER_E2E_SAVE_ARTIFACTS ?? process.env.HAPPY_E2E_SAVE_ARTIFACTS,
      },
    });

    const artifacts = new FailureArtifacts();

    let passed = false;
    try {
      const accountSecretSeed = Uint8Array.from(randomBytes(32));
      const desktopToken = await createTokenFromSecretSeed(startedServer.baseUrl, accountSecretSeed);

      const pairingSecret = Buffer.from(randomBytes(24)).toString('base64url');
      const secretHash = computeSecretHash(pairingSecret);

      const startRes = await fetchJson<{ pairId?: string; expiresAt?: string }>(`${startedServer.baseUrl}/v1/auth/pairing/start`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${desktopToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ secretHash }),
        timeoutMs: 15_000,
      });
      expect(startRes.status).toBe(200);
      expect(typeof startRes.data?.pairId).toBe('string');
      expect(typeof startRes.data?.expiresAt).toBe('string');
      const pairId = String(startRes.data.pairId);

      const mobileKp = tweetnacl.box.keyPair();
      const mobilePublicKeyBase64 = privacyKit.encodeBase64(toPrivacyKitBytes(mobileKp.publicKey));

      const requestAuthRes = await fetchJson<{ state?: string }>(`${startedServer.baseUrl}/v1/auth/account/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicKey: mobilePublicKeyBase64 }),
        timeoutMs: 15_000,
      });
      expect(requestAuthRes.status).toBe(200);
      expect(requestAuthRes.data?.state).toBe('requested');

      const requestPairingRes = await fetchJson<{ state?: string; confirmCode?: string }>(`${startedServer.baseUrl}/v1/auth/pairing/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          pairId,
          secret: pairingSecret,
          publicKey: mobilePublicKeyBase64,
          deviceLabel: 'Test Phone',
        }),
        timeoutMs: 15_000,
      });
      expect(requestPairingRes.status).toBe(200);
      expect(requestPairingRes.data?.state).toBe('requested');
      expect(String(requestPairingRes.data?.confirmCode ?? '')).toMatch(/^[0-9]{3} [0-9]{3}$/);

      const statusRes = await fetchJson<any>(`${startedServer.baseUrl}/v1/auth/pairing/status?pairId=${encodeURIComponent(pairId)}`, {
        headers: { Authorization: `Bearer ${desktopToken}` },
        timeoutMs: 15_000,
      });
      expect(statusRes.status).toBe(200);
      expect(statusRes.data?.state).toBe('requested');
      expect(statusRes.data?.requestedPublicKey).toBe(mobilePublicKeyBase64);

      const encryptedResponse = sealBoxBundle({
        plaintext: accountSecretSeed,
        recipientPublicKey: mobileKp.publicKey,
        randomBytes: (n: number) => Uint8Array.from(randomBytes(n)),
      });

      const responseRes = await fetchJson<{ success?: boolean }>(`${startedServer.baseUrl}/v1/auth/account/response`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${desktopToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          publicKey: mobilePublicKeyBase64,
          response: privacyKit.encodeBase64(toPrivacyKitBytes(encryptedResponse)),
        }),
        timeoutMs: 15_000,
      });
      expect(responseRes.status).toBe(200);
      expect(responseRes.data?.success).toBe(true);

      let authorized: any = null;
      await waitFor(async () => {
        const pollRes = await fetchJson<any>(`${startedServer.baseUrl}/v2/auth/account/request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ publicKey: mobilePublicKeyBase64 }),
          timeoutMs: 15_000,
        });
        if (pollRes.status !== 200) return false;
        if (pollRes.data?.state !== 'authorized') return false;
        authorized = pollRes.data;
        return true;
      }, { timeoutMs: 20_000, intervalMs: 500 });
      if (!authorized) {
        throw new Error('Expected authorized payload');
      }

      artifacts.json('authorized.payload.json', () => authorized);

      const mobileToken = decryptTokenEncryptedBundle({
        tokenEncryptedBase64: String(authorized.tokenEncrypted),
        recipientSecretKey: mobileKp.secretKey,
      });
      const responseBundle = privacyKit.decodeBase64(String(authorized.response));
      const decryptedSecret = openBoxBundle({
        bundle: responseBundle,
        recipientSecretKeyOrSeed: mobileKp.secretKey,
      });
      expect(decryptedSecret).not.toBeNull();
      expect(Buffer.from(decryptedSecret!)).toEqual(Buffer.from(accountSecretSeed));

      const profileRes = await fetchJson<any>(`${startedServer.baseUrl}/v1/account/profile`, {
        headers: { Authorization: `Bearer ${mobileToken}` },
        timeoutMs: 15_000,
      });
      expect(profileRes.status).toBe(200);

      passed = true;
    } finally {
      await artifacts.dumpAll(testDir, { onlyIf: saveArtifactsOnSuccess || !passed });
    }
  }, 240_000);
});
