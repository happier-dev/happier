import { flushHookEffects } from '@/dev/testkit/hooks/flushHookEffects';
import React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { changeTextTestInstance, renderScreen } from '@/dev/testkit';
import { installConnectedServicesCommonModuleMocks } from './connectedServicesTestHelpers';


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

installConnectedServicesCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                prompt: vi.fn(async () => null),
                alert: alertSpy,
                alertAsync: alertAsyncSpy,
            },
        }).module;
    },
});

describe('ConnectedServiceOauthPasteView button layout', () => {
  it('opens the authorization URL via a primary button', async () => {
    openExternalUrlSpy.mockClear();
    alertSpy.mockClear();
    alertAsyncSpy.mockClear();
    const { ConnectedServiceOauthPasteView } = await import('./ConnectedServiceOauthPasteView');

    const screen = await renderScreen(<ConnectedServiceOauthPasteView serviceId="openai-codex" profileId="work" onDone={() => {}} />);

    // Flush effects (pkce/state init).
    await act(async () => {
      await flushHookEffects({ cycles: 1, turns: 1 });
    });
    await act(async () => {
      await flushHookEffects({ cycles: 1, turns: 1 });
    });

    await screen.pressByTestIdAsync('connectedServices.oauthPaste.openAuthorizationButton');

    expect(alertAsyncSpy).toHaveBeenCalledTimes(1);
    expect(alertAsyncSpy).toHaveBeenCalledWith(
      'connectedServices.oauthPaste.connectWebDescription',
      'connectedServices.oauthPaste.pasteRedirectUrlPromptBody',
      expect.arrayContaining([expect.objectContaining({ text: 'connectedServices.oauthPaste.openAuthorizationUrl' })]),
    );
    expect(openExternalUrlSpy).toHaveBeenCalledTimes(1);
    expect(String(openExternalUrlSpy.mock.calls[0]?.[0] ?? '')).toContain('openai');
  });

  it('uses Claude-specific paste instructions that mention code#state', async () => {
    openExternalUrlSpy.mockClear();
    alertSpy.mockClear();
    alertAsyncSpy.mockClear();
    const { ConnectedServiceOauthPasteView } = await import('./ConnectedServiceOauthPasteView');

    const screen = await renderScreen(<ConnectedServiceOauthPasteView serviceId="claude-subscription" profileId="work" onDone={() => {}} />);

    await act(async () => {
      await flushHookEffects({ cycles: 1, turns: 1 });
    });
    await act(async () => {
      await flushHookEffects({ cycles: 1, turns: 1 });
    });

    const redirectInput = screen.findByTestId('connectedServices.oauthPaste.redirectUrlInput');
    expect(redirectInput).not.toBeNull();
    if (!redirectInput) {
        throw new Error('missing redirect input');
    }
    expect(String(redirectInput.props?.placeholder ?? '')).toContain(
      'connectedServices.oauthPaste.providerOverrides.claudeSubscription.pasteRedirectUrlPlaceholder',
    );

    await screen.pressByTestIdAsync('connectedServices.oauthPaste.openAuthorizationButton');

    expect(alertAsyncSpy).toHaveBeenCalledTimes(1);
    expect(alertAsyncSpy).toHaveBeenCalledWith(
      'connectedServices.oauthPaste.providerOverrides.claudeSubscription.connectWebDescription',
      'connectedServices.oauthPaste.providerOverrides.claudeSubscription.pasteRedirectUrlPromptBody',
      expect.any(Array),
    );
  });

  it('disables validate until a redirect URL is provided', async () => {
    const { ConnectedServiceOauthPasteView } = await import('./ConnectedServiceOauthPasteView');

    const screen = await renderScreen(<ConnectedServiceOauthPasteView serviceId="openai-codex" profileId="work" onDone={() => {}} />);

    const validateButton = screen.findByTestId('connectedServices.oauthPaste.validateRedirectButton');
    expect(validateButton).not.toBeNull();
    if (!validateButton) {
        throw new Error('missing validate button');
    }
    expect(Boolean(validateButton.props?.disabled)).toBe(true);

    const redirectInput = screen.findByTestId('connectedServices.oauthPaste.redirectUrlInput');
    expect(redirectInput).not.toBeNull();
    if (!redirectInput) {
        throw new Error('missing redirect input');
    }
    await act(async () => {
      changeTextTestInstance(redirectInput, 'http://localhost:1455/auth/callback?code=code-1&state=state-1');
    });

    const validateEnabled = screen.findByTestId('connectedServices.oauthPaste.validateRedirectButton');
    expect(validateEnabled).not.toBeNull();
    if (!validateEnabled) {
        throw new Error('missing enabled validate button');
    }
    expect(Boolean(validateEnabled.props?.disabled)).toBe(false);
  });

  it('renders method switch fallback as a button', async () => {
    const { ConnectedServiceOauthPasteView } = await import('./ConnectedServiceOauthPasteView');

    const screen = await renderScreen(<ConnectedServiceOauthPasteView
          serviceId="openai-codex"
          profileId="work"
          onDone={() => {}}
          fallbackAction={{ title: 'Try device auth', onPress: () => {} }}
        />);

    const fallbackItem = screen.findByTestId('connectedServices.oauthPaste.switchMethodItem');
    expect(fallbackItem).not.toBeNull();
    if (!fallbackItem) {
        throw new Error('missing fallback item');
    }
    expect(fallbackItem.props?.onPress).toBeTypeOf('function');
  });
});
