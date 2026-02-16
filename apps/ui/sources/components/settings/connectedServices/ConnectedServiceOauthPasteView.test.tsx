import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { decodeBase64, encodeBase64, sealBoxBundle } from '@happier-dev/protocol';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const promptSpy = vi.fn(async () => 'http://localhost:1455/auth/callback?code=code-1&state=state-1');
const alertSpy = vi.fn(async () => {});
const refreshProfileSpy = vi.fn(async () => {});
const registerSpy = vi.fn(async () => {});

const exchangeSpy = vi.fn(async (_credentials: any, params: any) => {
  const recipientPublicKey = decodeBase64(params.publicKey, 'base64url');
  const plaintextJson = JSON.stringify({
    serviceId: params.serviceId,
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    idToken: 'id-1',
    scope: null,
    tokenType: null,
    providerEmail: null,
    providerAccountId: 'acct-1',
    expiresAt: 123,
    raw: { ok: true },
  });
  const plaintext = new TextEncoder().encode(plaintextJson);
  const bundle = sealBoxBundle({
    plaintext,
    recipientPublicKey,
    randomBytes: (n) => new Uint8Array(n).fill(7),
  });
  return { bundle: encodeBase64(bundle, 'base64url') };
});

const legacySecretB64Url = Buffer.from(new Uint8Array(32).fill(3)).toString('base64url');

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: { token: 't', secret: legacySecretB64Url } }),
}));

vi.mock('@/modal', () => ({
  Modal: {
    prompt: promptSpy,
    alert: alertSpy,
  },
}));

vi.mock('@/sync/sync', () => ({
  sync: { refreshProfile: refreshProfileSpy },
}));

vi.mock('@/sync/api/account/apiConnectedServicesV2', () => ({
  exchangeConnectedServiceOauthViaProxy: exchangeSpy,
  registerConnectedServiceCredentialSealed: registerSpy,
}));

vi.mock('@/utils/auth/oauthCore', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    generateOauthState: () => 'state-1',
    generatePkceCodes: async () => ({ verifier: 'verifier-1', challenge: 'challenge-1' }),
  };
});

describe('ConnectedServiceOauthPasteView', () => {
  it('uses the proxy exchange endpoint and registers a sealed credential', async () => {
    const { ConnectedServiceOauthPasteView } = await import('./ConnectedServiceOauthPasteView');

    const onDone = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<ConnectedServiceOauthPasteView serviceId="openai-codex" profileId="work" onDone={onDone} />);
    });

    const pasteItem = tree.root.find((n) => n.props?.title === 'Paste redirect URL');
    await act(async () => {
      await pasteItem.props.onPress?.();
    });

    expect(exchangeSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        serviceId: 'openai-codex',
        code: 'code-1',
        verifier: 'verifier-1',
        redirectUri: 'http://localhost:1455/auth/callback',
      }),
    );
    expect(registerSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'work',
        sealed: expect.objectContaining({ format: 'account_scoped_v1', ciphertext: expect.any(String) }),
      }),
    );
    expect(refreshProfileSpy).toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });
});
