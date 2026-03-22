import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeBase64, encodeBase64, sealBoxBundle } from '@happier-dev/protocol';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const alertSpy = vi.fn(async () => {});
const refreshProfileSpy = vi.fn(async () => {});
const storeCredentialSpy = vi.fn(async () => {});
const clipboardSetSpy = vi.fn(async () => {});

const startSpy = vi.fn(async () => ({
  deviceAuthId: 'dev-1',
  userCode: 'ABCD-EFGH',
  intervalMs: 5000,
  verificationUrl: 'https://auth.openai.com/codex/device',
}));

const pollSpy = vi.fn(async (_credentials: any, params: any) => {
  const recipientPublicKey = decodeBase64(params.publicKey, 'base64url');
  const plaintextJson = JSON.stringify({
    serviceId: 'openai-codex',
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
  return { status: 'success', bundle: encodeBase64(bundle, 'base64url') };
});

const legacySecretB64Url = Buffer.from(new Uint8Array(32).fill(3)).toString('base64url');
const stableAuth = { credentials: { token: 't', secret: legacySecretB64Url } };

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => stableAuth,
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            alert: alertSpy,
        },
    }).module;
});

vi.mock('@/sync/sync', () => ({
  sync: { refreshProfile: refreshProfileSpy },
}));

vi.mock('@/sync/api/account/apiConnectedServicesV2', () => ({
  startOpenAiCodexDeviceAuthViaProxy: startSpy,
  pollOpenAiCodexDeviceAuthViaProxy: pollSpy,
}));

vi.mock('@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount', () => ({
  storeConnectedServiceCredentialForAccount: storeCredentialSpy,
  deleteConnectedServiceCredentialForAccount: vi.fn(async () => {}),
}));

vi.mock('@/utils/timing/time', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return { ...actual, delay: async () => { throw new Error('delay called'); } };
});

vi.mock('expo-clipboard', () => ({
  setStringAsync: clipboardSetSpy,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  alertSpy.mockClear();
  refreshProfileSpy.mockClear();
  storeCredentialSpy.mockClear();
  clipboardSetSpy.mockClear();
  startSpy.mockClear();
  pollSpy.mockClear();
});

describe('OpenAiCodexDeviceAuthView', () => {
  it('starts device auth, polls, and registers a sealed credential', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch should not be called'); }) as unknown as typeof fetch);

    const { OpenAiCodexDeviceAuthView } = await import('./OpenAiCodexDeviceAuthView');

    const onDone = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<OpenAiCodexDeviceAuthView serviceId="openai-codex" profileId="work" onDone={onDone} />)).tree;

    // Flush effects (start).
    await act(async () => {
      await flushHookEffects({ cycles: 1, turns: 1 });
    });
    await act(async () => {
      await flushHookEffects({ cycles: 1, turns: 1 });
    });

    expect(startSpy).toHaveBeenCalled();

    expect(pollSpy).toHaveBeenCalled();
    expect(storeCredentialSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        serviceId: 'openai-codex',
        profileId: 'work',
        record: expect.objectContaining({
          kind: 'oauth',
          oauth: expect.objectContaining({ accessToken: 'access-1', refreshToken: 'refresh-1' }),
        }),
      }),
    );
    expect(refreshProfileSpy).toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();

    await act(async () => {
      tree.unmount();
    });
  });

  it('allows copying the user code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch should not be called'); }) as unknown as typeof fetch);

    const { OpenAiCodexDeviceAuthView } = await import('./OpenAiCodexDeviceAuthView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<OpenAiCodexDeviceAuthView serviceId="openai-codex" profileId="work" onDone={() => {}} />)).tree;

    // Flush effects (start).
    await act(async () => {
      await flushHookEffects({ cycles: 1, turns: 1 });
    });
    await act(async () => {
      await flushHookEffects({ cycles: 1, turns: 1 });
    });

    const copyButton = tree.find((n) => n.props?.testID === 'connectedServices.deviceAuth.copyCodeButton');
    await act(async () => {
      await pressTestInstanceAsync(copyButton);
    });

    expect(clipboardSetSpy).toHaveBeenCalledWith('ABCD-EFGH');

    await act(async () => {
      tree.unmount();
    });
  });

  it('renders method switch fallback as a button', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('fetch should not be called'); }) as unknown as typeof fetch);

    const { OpenAiCodexDeviceAuthView } = await import('./OpenAiCodexDeviceAuthView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<OpenAiCodexDeviceAuthView
          serviceId="openai-codex"
          profileId="work"
          onDone={() => {}}
          fallbackAction={{ title: 'Use paste instead', onPress: () => {} }}
        />)).tree;

    // Flush effects (start).
    await act(async () => {
      await flushHookEffects({ cycles: 1, turns: 1 });
    });
    await act(async () => {
      await flushHookEffects({ cycles: 1, turns: 1 });
    });

    const fallbackItem = tree.find((n) => n.props?.testID === 'connectedServices.deviceAuth.switchMethodItem');
    expect(fallbackItem.props?.title).toBe('Use paste instead');

    await act(async () => {
      tree.unmount();
    });
  });
});
