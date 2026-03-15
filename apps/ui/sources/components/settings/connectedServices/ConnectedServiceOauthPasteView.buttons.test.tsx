import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const openExternalUrlSpy = vi.fn(async (_url: string) => true);
const alertSpy = vi.fn(async () => {});
const alertAsyncSpy = vi.fn(async () => {});

vi.mock('@/utils/url/openExternalUrl', () => ({
  openExternalUrl: (url: string) => openExternalUrlSpy(url),
}));

vi.mock('@/utils/auth/oauthCore', async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    generateOauthState: () => 'state-1',
    generatePkceCodes: async () => ({ verifier: 'verifier-1', challenge: 'challenge-1' }),
  };
});

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } }),
}));

vi.mock('@/sync/sync', () => ({
  sync: { refreshProfile: vi.fn(async () => {}) },
}));

vi.mock('@/sync/api/account/apiConnectedServicesV2', () => ({
  exchangeConnectedServiceOauthViaProxy: vi.fn(async () => ({ bundle: '' })),
}));

vi.mock('@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount', () => ({
  storeConnectedServiceCredentialForAccount: vi.fn(async () => {}),
}));

vi.mock('@/modal', () => ({
  Modal: {
    prompt: vi.fn(async () => null),
    alert: alertSpy,
    alertAsync: alertAsyncSpy,
  },
}));

describe('ConnectedServiceOauthPasteView button layout', () => {
  it('opens the authorization URL via a primary button', async () => {
    openExternalUrlSpy.mockClear();
    alertSpy.mockClear();
    alertAsyncSpy.mockClear();
    const { ConnectedServiceOauthPasteView } = await import('./ConnectedServiceOauthPasteView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ConnectedServiceOauthPasteView serviceId="openai-codex" profileId="work" onDone={() => {}} />,
      );
    });

    // Flush effects (pkce/state init).
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const openButton = tree.root.find((n) => n.props?.testID === 'connectedServices.oauthPaste.openAuthorizationButton');
    await act(async () => {
      await openButton.props.onPress?.();
    });

    expect(alertAsyncSpy).toHaveBeenCalledTimes(1);
    expect(alertAsyncSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.arrayContaining([expect.objectContaining({ text: 'Open login page' })]),
    );
    expect(openExternalUrlSpy).toHaveBeenCalledTimes(1);
    expect(String(openExternalUrlSpy.mock.calls[0]?.[0] ?? '')).toContain('openai');
  });

  it('uses Claude-specific paste instructions that mention code#state', async () => {
    openExternalUrlSpy.mockClear();
    alertSpy.mockClear();
    alertAsyncSpy.mockClear();
    const { ConnectedServiceOauthPasteView } = await import('./ConnectedServiceOauthPasteView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ConnectedServiceOauthPasteView serviceId="claude-subscription" profileId="work" onDone={() => {}} />,
      );
    });

    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });

    const redirectInput = tree.root.findByProps({ testID: 'connectedServices.oauthPaste.redirectUrlInput' });
    expect(String(redirectInput.props?.placeholder ?? '')).toContain('code#state');

    const openButton = tree.root.find((n) => n.props?.testID === 'connectedServices.oauthPaste.openAuthorizationButton');
    await act(async () => {
      await openButton.props.onPress?.();
    });

    expect(alertAsyncSpy).toHaveBeenCalledTimes(1);
    expect(alertAsyncSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('code#state'),
      expect.any(Array),
    );
  });

  it('disables validate until a redirect URL is provided', async () => {
    const { ConnectedServiceOauthPasteView } = await import('./ConnectedServiceOauthPasteView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ConnectedServiceOauthPasteView serviceId="openai-codex" profileId="work" onDone={() => {}} />,
      );
    });

    const validateButton = tree.root.find((n) => n.props?.testID === 'connectedServices.oauthPaste.validateRedirectButton');
    expect(Boolean(validateButton.props?.disabled)).toBe(true);

    const redirectInput = tree.root.findByProps({ testID: 'connectedServices.oauthPaste.redirectUrlInput' });
    await act(async () => {
      redirectInput.props.onChangeText?.('http://localhost:1455/auth/callback?code=code-1&state=state-1');
    });

    const validateEnabled = tree.root.find((n) => n.props?.testID === 'connectedServices.oauthPaste.validateRedirectButton');
    expect(Boolean(validateEnabled.props?.disabled)).toBe(false);

    await act(async () => {
      tree.unmount();
    });
  });

  it('renders method switch fallback as a button', async () => {
    const { ConnectedServiceOauthPasteView } = await import('./ConnectedServiceOauthPasteView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(
        <ConnectedServiceOauthPasteView
          serviceId="openai-codex"
          profileId="work"
          onDone={() => {}}
          fallbackAction={{ title: 'Try device auth', onPress: () => {} }}
        />,
      );
    });

    const fallbackItem = tree.root.find((n) => n.props?.testID === 'connectedServices.oauthPaste.switchMethodItem');
    expect(fallbackItem.props?.title).toBe('Try device auth');
  });
});
