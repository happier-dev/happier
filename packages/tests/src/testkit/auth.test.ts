import tweetnacl from 'tweetnacl';
import * as privacyKit from 'privacy-kit';

import {
  computeContentPublicKeyFingerprint,
} from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const httpBoundary = vi.hoisted(() => ({
  requestBody: null as Record<string, unknown> | null,
}));

vi.mock('./http', () => ({
  fetchJson: vi.fn(async (_url: string, init: RequestInit) => {
    httpBoundary.requestBody = JSON.parse(String(init.body)) as Record<string, unknown>;
    return { status: 200, data: { token: 'test-token' } };
  }),
}));

import { createTestAuth } from './auth';

describe('createTestAuth', () => {
  beforeEach(() => {
    httpBoundary.requestBody = null;
  });

  it('registers the canonical public key and fingerprint for its Account machine secret', async () => {
    const auth = await createTestAuth('http://127.0.0.1:3000');
    const canonicalPublicKey = Uint8Array.from(
      tweetnacl.box.keyPair.fromSecretKey(auth.accountMachineKey).publicKey,
    );

    const encodedPublicKey = httpBoundary.requestBody?.contentPublicKey;
    expect(encodedPublicKey).toBe(privacyKit.encodeBase64(canonicalPublicKey));
    expect(
      computeContentPublicKeyFingerprint(
        privacyKit.decodeBase64(String(encodedPublicKey)),
      ),
    ).toBe(computeContentPublicKeyFingerprint(canonicalPublicKey));
  });
});
