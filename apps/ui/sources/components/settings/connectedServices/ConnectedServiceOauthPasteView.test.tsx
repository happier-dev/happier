import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { decodeBase64, encodeBase64, sealBoxBundle } from '@happier-dev/protocol';
import { changeTextTestInstance, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import { installConnectedServicesCommonModuleMocks } from './connectedServicesTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const alertSpy = vi.fn(async () => {});
const refreshProfileSpy = vi.fn(async () => {});
const storeCredentialSpy = vi.fn(async () => {});

const defaultExchangeImpl = async (_credentials: any, params: any) => {
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
    raw: params.serviceId === 'antigravity'
      ? { antigravity: { clientId: 'native-client', authMethod: 'oauth-personal', projectId: 'managed-project' } }
      : { ok: true },
  });
  const plaintext = new TextEncoder().encode(plaintextJson);
  const bundle = sealBoxBundle({
    plaintext,
    recipientPublicKey,
    randomBytes: (n) => new Uint8Array(n).fill(7),
  });
  return { bundle: encodeBase64(bundle, 'base64url') };
};

const exchangeSpy = vi.fn(defaultExchangeImpl);

const legacySecretB64Url = Buffer.from(new Uint8Array(32).fill(3)).toString('base64url');

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: { token: 't', secret: legacySecretB64Url } }),
}));

installConnectedServicesCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                alert: alertSpy,
                alertAsync: vi.fn(async () => {}),
            },
        }).module;
    },
});

vi.mock('@/sync/sync', () => ({
  sync: { refreshProfile: refreshProfileSpy },
}));

vi.mock('@/sync/api/account/apiConnectedServicesV2', () => ({
  exchangeConnectedServiceOauthViaProxy: exchangeSpy,
}));

vi.mock('@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount', () => ({
  storeConnectedServiceCredentialForAccount: storeCredentialSpy,
  deleteConnectedServiceCredentialForAccount: vi.fn(async () => {}),
}));


function authorizationState(tree: Pick<renderer.ReactTestRenderer, 'find'>): string {
  const node = tree.find((node) => typeof node.props.children === 'string' && node.props.children.includes('code_challenge=') && node.props.children.startsWith('https://'));
  return new URL(node.props.children).searchParams.get('state')!;
}

describe('ConnectedServiceOauthPasteView', () => {
  it('restarts authorization after project discovery fails, preserving the project and replacing the consumed code', async () => {
    resetMocks();
    exchangeSpy.mockRejectedValueOnce(new Error('connect_oauth_project_required'));
    const { ConnectedServiceOauthPasteView } = await import('./ConnectedServiceOauthPasteView');
    const screen = await renderScreen(<ConnectedServiceOauthPasteView serviceId="antigravity" profileId="work" onDone={vi.fn()} />);
    await flushAsyncEffects();
    const firstState = authorizationState(screen.tree);
    await act(async () => { changeTextTestInstance(screen.tree.findByProps({ testID: 'connectedServices.oauthPaste.projectInput' }), 'managed-project'); });
    await act(async () => { changeTextTestInstance(screen.tree.findByProps({ testID: 'connectedServices.oauthPaste.redirectUrlInput' }), `http://localhost:54545/?code=consumed&state=${firstState}`); });
    await pressTestInstanceAsync(screen.tree.findByProps({ testID: 'connectedServices.oauthPaste.validateRedirectButton' }));
    await flushAsyncEffects();
    expect(screen.tree.findByProps({ testID: 'connectedServices.oauthPaste.redirectUrlInput' }).props.value).toBe('');
    expect(screen.tree.findByProps({ testID: 'connectedServices.oauthPaste.projectInput' }).props.value).toBe('managed-project');
    const nextState = authorizationState(screen.tree);
    expect(nextState).not.toBe(firstState);
    await act(async () => { changeTextTestInstance(screen.tree.findByProps({ testID: 'connectedServices.oauthPaste.redirectUrlInput' }), `http://localhost:54545/?code=fresh&state=${nextState}`); });
    await pressTestInstanceAsync(screen.tree.findByProps({ testID: 'connectedServices.oauthPaste.validateRedirectButton' }));
    expect(exchangeSpy.mock.calls.map((call) => call[1].code)).toEqual(['consumed', 'fresh']);
    expect(exchangeSpy.mock.calls[0][1].verifier).not.toBe(exchangeSpy.mock.calls[1][1].verifier);
    expect(storeCredentialSpy).toHaveBeenCalledOnce();
  });
  it('connects Antigravity from a full remote return URL and rejects mismatched state before exchange', async () => {
    resetMocks();
    const { ConnectedServiceOauthPasteView } = await import('./ConnectedServiceOauthPasteView');
    const screen = await renderScreen(<ConnectedServiceOauthPasteView serviceId="antigravity" profileId="work" onDone={vi.fn()} />);
    await flushAsyncEffects();
    const input = screen.tree.findByProps({ testID: 'connectedServices.oauthPaste.redirectUrlInput' });
    const state = authorizationState(screen.tree);
    const projectInput = screen.tree.findByProps({ testID: 'connectedServices.oauthPaste.projectInput' });
    await act(async () => { changeTextTestInstance(projectInput, 'managed-project'); });
    await act(async () => { changeTextTestInstance(input, 'http://localhost:54545/?code=code-1&state=wrong'); });
    await act(async () => { await pressTestInstanceAsync(screen.tree.findByProps({ testID: 'connectedServices.oauthPaste.validateRedirectButton' })); });
    expect(exchangeSpy).not.toHaveBeenCalled();
    await act(async () => { changeTextTestInstance(input, `http://localhost:54545/?code=code-1&state=${state}`); });
    await act(async () => { await pressTestInstanceAsync(screen.tree.findByProps({ testID: 'connectedServices.oauthPaste.validateRedirectButton' })); });
    expect(storeCredentialSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ serviceId: 'antigravity', profileId: 'work' }));
    expect(exchangeSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ projectId: 'managed-project' }));
  });
  async function flushAsyncEffects(): Promise<void> {
    // `ConnectedServiceOauthPasteView` initializes PKCE/state in a fire-and-forget effect.
    // Flush a couple microtasks so the `handlePaste` handler is armed with pkce/state.
    await act(async () => {
      await flushHookEffects({ cycles: 1, turns: 1 });
    });
    await act(async () => {
      await flushHookEffects({ cycles: 1, turns: 1 });
    });
  }

  function resetMocks(): void {
    alertSpy.mockClear();
    refreshProfileSpy.mockClear();
    storeCredentialSpy.mockClear();
    exchangeSpy.mockClear();
    exchangeSpy.mockImplementation(defaultExchangeImpl);
  }

  it('uses the proxy exchange endpoint and registers a sealed credential', async () => {
    resetMocks();
    const { ConnectedServiceOauthPasteView } = await import('./ConnectedServiceOauthPasteView');

    const onDone = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ConnectedServiceOauthPasteView serviceId="openai-codex" profileId="work" onDone={onDone} />)).tree;
    await flushAsyncEffects();

    const redirectInput = tree.findByProps({ testID: 'connectedServices.oauthPaste.redirectUrlInput' });
    await act(async () => {
      changeTextTestInstance(redirectInput, `http://localhost:1455/auth/callback?code=code-1&state=${authorizationState(tree)}`);
    });

    const pasteItem = tree.find((n) => n.props?.testID === 'connectedServices.oauthPaste.validateRedirectButton');
    await act(async () => {
      await pressTestInstanceAsync(pasteItem);
    });

    expect(exchangeSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        serviceId: 'openai-codex',
        code: 'code-1',
        verifier: expect.any(String),
        redirectUri: 'http://localhost:1455/auth/callback',
        state: authorizationState(tree),
      }),
    );
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

  it('renders the callback field in the canonical keyboard-aware list', async () => {
    resetMocks();
    const { ConnectedServiceOauthPasteView } = await import('./ConnectedServiceOauthPasteView');
    const { ItemList } = await import('@/components/ui/lists/ItemList');

    const screen = await renderScreen(
      <ConnectedServiceOauthPasteView serviceId="openai-codex" profileId="work" onDone={() => {}} />,
    );

    const list = screen.findByType(ItemList);
    expect(list.props.keyboardAware).toBe(true);
    expect(list.props.keyboardShouldPersistTaps).toBe('handled');
  });

  it('rejects proxy bundles that claim a different serviceId', async () => {
    resetMocks();
    const { ConnectedServiceOauthPasteView } = await import('./ConnectedServiceOauthPasteView');

    exchangeSpy.mockImplementationOnce(async (_credentials: any, params: any) => {
      const recipientPublicKey = decodeBase64(params.publicKey, 'base64url');
      const plaintextJson = JSON.stringify({
        serviceId: 'gemini',
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

    const onDone = vi.fn();

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ConnectedServiceOauthPasteView serviceId="openai-codex" profileId="work" onDone={onDone} />)).tree;
    await flushAsyncEffects();

    const redirectInput = tree.findByProps({ testID: 'connectedServices.oauthPaste.redirectUrlInput' });
    await act(async () => {
      changeTextTestInstance(redirectInput, `http://localhost:1455/auth/callback?code=code-1&state=${authorizationState(tree)}`);
    });

    const pasteItem = tree.find((n) => n.props?.testID === 'connectedServices.oauthPaste.validateRedirectButton');
    await act(async () => {
      await pressTestInstanceAsync(pasteItem);
    });

    expect(storeCredentialSpy).not.toHaveBeenCalled();
    expect(refreshProfileSpy).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalled();

    await act(async () => {
      tree.unmount();
    });
  });
});
