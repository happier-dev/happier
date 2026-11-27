import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installTokenStorageWebPlatformMocks } from '@/auth/storage/tokenStorage.testHelpers';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { WelcomeAuthenticationMethod } from '@/components/onboarding/preAuth/composeWelcomeEntryModel';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { decodeBase64 } from '@/encryption/base64';
import { prepareAccountEncryptionMigrateToE2eeKey } from '@/sync/ops/account/prepareAccountEncryptionMigrateToE2eeKey';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import { computeAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { executeHomeAuthentication } from './executeHomeAuthentication';

installTokenStorageWebPlatformMocks();
const browserStorage = await vi.hoisted(async () => {
  // Real Home persistence captures its browser backend while the owner loads.
  const { installLocalStorageMock } =
    await import('@/auth/storage/tokenStorage.web.testHelpers');
  return { ...installLocalStorageMock(), backend: globalThis.localStorage };
});
const boundary = vi.hoisted(() => ({ request: vi.fn<RuntimeFetch>() }));
vi.mock('@/utils/system/runtimeFetch', () => {
  // Named first so the getter's `this` is this object, not vi.mock's Partial<unknown> factory type.
  const mocked = {
    runtimeFetch: boundary.request,
    get runtimeFetchManualResponse() {
      return this.runtimeFetch;
    },
  };
  return mocked;
});
vi.mock(
  'expo-router',
  async () =>
    (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module,
);
vi.mock(
  '@/modal',
  async () =>
    (await import('@/dev/testkit/mocks/modal')).createModalModuleMock().module,
);

const homeUrl = 'https://plain-home.example.test';
const homeId = 'srv_plain_home';
const target = {
  kind: 'descriptor' as const,
  authority: 'trusted_enrollment' as const,
  descriptor: {
    v: 1 as const,
    homeServerIdentityId: homeId,
    canonicalServerUrl: homeUrl,
    revision: 1,
    endpoints: [{ kind: 'https' as const, url: homeUrl }],
  },
};
const provision = { id: 'provision', mode: 'keyed' } as const;
const request = {
  method: { id: 'key_challenge', enabledActions: [provision] },
  action: provision,
  execution: { kind: 'generated_key' },
  authority: { purpose: 'home', target },
  intendedHome: target,
} satisfies WelcomeAuthenticationMethod;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

/**
 * The Home is the boundary: it records the signing identity and content-key binding
 * the device registers at `/v1/auth`, and reports the provisioned Account mode.
 */
function installHome(mode: 'plain' | 'e2ee'): {
  registered: () => { publicKey: string; contentPublicKey: string };
} {
  let registered: { publicKey: string; contentPublicKey: string } | null = null;
  boundary.request.mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === '/v1/features') {
      const features = createRootLayoutFeaturesResponse();
      return json({
        ...features,
        capabilities: {
          ...features.capabilities,
          auth: { ...features.capabilities.auth, keyChallenge: { v2: true } },
          serverIdentity: { serverIdentityId: homeId },
        },
      });
    }
    if (path === '/v1/auth/challenge')
      return json({
        challengeId: 'challenge-plain',
        nonce: 'nonce-plain',
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        audience: { origin: homeUrl, serverIdentityId: homeId },
      });
    if (path === '/v1/auth') {
      const body = JSON.parse(String(init?.body)) as {
        publicKey: string;
        contentPublicKey?: string;
      };
      if (!body.contentPublicKey)
        throw new Error('Expected a content-key binding at provisioning');
      registered = {
        publicKey: body.publicKey,
        contentPublicKey: body.contentPublicKey,
      };
      return json({ token: `${mode}-account-token` });
    }
    if (path === '/v1/account/encryption') return json({ mode, updatedAt: 1 });
    return new Response('{}', { status: 404 });
  });
  return {
    registered: () => {
      if (!registered) throw new Error('The device registered no Account keys');
      return registered;
    },
  };
}

/** The fingerprints the Home's currentness reports for those registered bindings. */
function registeredFingerprints(registered: {
  publicKey: string;
  contentPublicKey: string;
}) {
  return {
    expectedSigningKeyFingerprint:
      computeAccountEncryptionMigrateKeyFingerprintV1(
        decodeBase64(registered.publicKey),
      ),
    expectedContentKeyFingerprint:
      computeAccountEncryptionMigrateKeyFingerprintV1(
        decodeBase64(registered.contentPublicKey),
      ),
  };
}

async function provisionAccount(mode: 'plain' | 'e2ee') {
  const home = installHome(mode);
  const loginWithCredentials = vi.fn(async (_credentials: AuthCredentials) => ({
    kind: 'completed' as const,
  }));
  await executeHomeAuthentication({
    request,
    loginWithCredentials: loginWithCredentials as never,
    returnTo: '/',
    keyChallengeV2Available: true,
  });
  expect(loginWithCredentials).toHaveBeenCalledTimes(1);
  return {
    credentials: loginWithCredentials.mock.calls[0]![0],
    registered: home.registered(),
  };
}

describe('generated-key provisioning on a Plain Home', () => {
  beforeEach(() => {
    // Shared UI setup replaces this global; keep the originally captured backend.
    vi.stubGlobal('localStorage', browserStorage.backend);
    browserStorage.store.clear();
    boundary.request.mockReset();
  });

  it('keeps the key it registered as historical material, so a later Plain → E2EE conversion proves it instead of asking to restore', async () => {
    const { credentials, registered } = await provisionAccount('plain');

    // Plain mode stays authoritative: the material is retained, never active.
    expect(credentials).toEqual({
      token: 'plain-account-token',
      secret: expect.any(String),
      custody: 'historical',
    });

    const prepared = await prepareAccountEncryptionMigrateToE2eeKey({
      credentials,
      ...registeredFingerprints(registered),
    });
    // The proof carries the very bindings the Home registered: no replacement keys,
    // and no keyless first-key re-authentication.
    expect(prepared.keyProof.publicKey).toBe(registered.publicKey);
    expect(prepared.keyProof.contentPublicKey).toBe(
      registered.contentPublicKey,
    );
    expect(prepared.requiresExternalAuthProof).toBe(false);
  });

  it('still fails closed with restore_required on a device that lacks the registered material', async () => {
    const { registered } = await provisionAccount('plain');

    // A token-only device (QR-joined, or one that converted to Plain and forgot its key).
    await expect(
      prepareAccountEncryptionMigrateToE2eeKey({
        credentials: { token: 'plain-account-token' },
        ...registeredFingerprints(registered),
      }),
    ).rejects.toMatchObject({ code: 'restore_required' });
  });

  it('keeps E2EE provisioning on active custody', async () => {
    const { credentials } = await provisionAccount('e2ee');

    expect(credentials).toEqual({
      token: 'e2ee-account-token',
      secret: expect.any(String),
    });
  });
});
