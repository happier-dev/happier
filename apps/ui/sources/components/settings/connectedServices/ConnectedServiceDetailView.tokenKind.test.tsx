import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { flushHookEffects, pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import {
    connectedServicesModuleState,
    installConnectedServicesCommonModuleMocks,
} from './connectedServicesTestHelpers';
import type { IModal } from '@/modal/types';

type StoreConnectedServiceCredentialForAccount = typeof import('@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount').storeConnectedServiceCredentialForAccount;


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { openExternalUrlSpy } = vi.hoisted(() => ({
    openExternalUrlSpy: vi.fn(async () => true),
}));
const promptSpy = vi.fn<IModal['prompt']>(async () => null);
const alertSpy = vi.fn(async () => {});
const confirmSpy = vi.fn<IModal['confirm']>(async () => false);
const storeCredentialSpy = vi.fn<StoreConnectedServiceCredentialForAccount>(async () => {});
const applySettingsSpy = vi.fn(async () => {});
installConnectedServicesCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                prompt: promptSpy,
                alert: alertSpy,
                confirm: confirmSpy,
            },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key) =>
                key === 'connectedServices.detail.connectSetupTokenTitle'
                    ? 'Connect setup-token'
                    : key === 'connectedServices.tokenPrompts.githubPersonalAccessToken'
                      ? 'Descriptor GitHub PAT title'
                      : key === 'connectedServices.tokenPrompts.bitbucketEmailOrUsername'
                        ? 'Bitbucket email title'
                        : key === 'connectedServices.tokenPrompts.bitbucketApiToken'
                          ? 'Bitbucket token title'
                    : key,
            translateLoose: (key) =>
                key === 'connectedServices.tokenPrompts.githubPersonalAccessToken'
                    ? 'Descriptor GitHub PAT title'
                    : key === 'connectedServices.tokenPrompts.bitbucketEmailOrUsername'
                      ? 'Bitbucket email title'
                      : key === 'connectedServices.tokenPrompts.bitbucketApiToken'
                        ? 'Bitbucket token title'
                    : key,
        });
    },
    searchParams: { serviceId: 'claude-subscription' },
});

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: () => true,
}));

vi.mock('@/sync/store/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/sync/store/hooks')>('@/sync/store/hooks');
  return {
    ...actual,
    useProfile: () => ({
      connectedServicesV2: [
        {
          serviceId: 'claude-subscription',
          profiles: [],
        },
      ],
    }),
    useSettings: () => ({
      connectedServicesDefaultProfileByServiceId: {},
      connectedServicesProfileLabelByKey: {},
      connectedServicesQuotaPinnedMeterIdsByKey: {},
      connectedServicesQuotaSummaryStrategyByKey: {},
    }),
  };
});

vi.mock('@/sync/sync', () => ({
  sync: { refreshProfile: vi.fn(async () => {}), applySettings: vi.fn(async () => {}) },
}));

vi.mock('@/sync/store/settingsWriters', () => ({
  useApplySettings: () => applySettingsSpy,
}));

vi.mock('@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount', () => ({
  storeConnectedServiceCredentialForAccount: storeCredentialSpy,
  deleteConnectedServiceCredentialForAccount: vi.fn(async () => {}),
}));

vi.mock('@/utils/url/openExternalUrl', () => ({
  openExternalUrl: openExternalUrlSpy,
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => {
  const React = require('react');
  return {
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props, props.children),
  };
});

describe('ConnectedServiceDetailView token kind copy', () => {
  it('keeps user on detail page after setup-token is saved', async () => {
    promptSpy.mockReset();
    alertSpy.mockReset();
    connectedServicesModuleState.routerBackSpy.mockReset();
    connectedServicesModuleState.routerPushSpy.mockReset();
    storeCredentialSpy.mockReset();
    promptSpy.mockResolvedValueOnce('work');
    promptSpy.mockResolvedValueOnce('setup-token-1');

    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;

    const tokenItem = tree.find((n) => n.props?.testID === 'connected-services-action:connect-token');
    await act(async () => {
      await pressTestInstanceAsync(tokenItem);
    });
    await flushHookEffects({ cycles: 1, turns: 3 });

    expect(storeCredentialSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalled();
    expect(connectedServicesModuleState.routerBackSpy).not.toHaveBeenCalled();
  });

  it('asks before replacing a connected service credential with a different provider identity', async () => {
    promptSpy.mockReset();
    alertSpy.mockReset();
    confirmSpy.mockReset();
    storeCredentialSpy.mockReset();
    connectedServicesModuleState.routerBackSpy.mockReset();
    promptSpy.mockResolvedValueOnce('work');
    promptSpy.mockResolvedValueOnce('setup-token-1');
    storeCredentialSpy
      .mockRejectedValueOnce(new Error('connect_reconnect_provider_identity_mismatch'))
      .mockResolvedValueOnce(undefined);
    confirmSpy.mockResolvedValueOnce(true);

    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    const tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;
    const tokenItem = tree.find((n) => n.props?.testID === 'connected-services-action:connect-token');
    await act(async () => {
      await pressTestInstanceAsync(tokenItem);
    });
    await flushHookEffects({ cycles: 1, turns: 3 });

    expect(confirmSpy).toHaveBeenCalledTimes(1);
    expect(storeCredentialSpy).toHaveBeenCalledTimes(2);
    expect(storeCredentialSpy.mock.calls[1]?.[2]).toEqual({ allowProviderIdentityChange: true });
    expect(alertSpy).toHaveBeenCalled();
    expect(connectedServicesModuleState.routerBackSpy).not.toHaveBeenCalled();
  });

  it('uses setup-token copy for claude-subscription', async () => {
    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;

    const tokenItem = tree.find((n) => n.props?.testID === 'connected-services-action:connect-token');
    expect(tokenItem.props.title).toBe('Connect setup-token');
  });

  it('opens descriptor token setup URL before prompting for a GitHub PAT', async () => {
    connectedServicesModuleState.searchParams = { serviceId: 'github' };
    openExternalUrlSpy.mockReset();

    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;

    const setupItem = tree.find((n) => n.props?.testID === 'connected-services-action:open-token-setup');
    await act(async () => {
      await pressTestInstanceAsync(setupItem);
    });

    expect(openExternalUrlSpy).toHaveBeenCalledWith(
      expect.stringContaining('https://github.com/settings/personal-access-tokens/new'),
      { platformOS: 'web' },
    );
  });

  it('prompts for GitHub PAT values as secure text', async () => {
    connectedServicesModuleState.searchParams = { serviceId: 'github' };
    promptSpy.mockReset();
    storeCredentialSpy.mockReset();
    promptSpy.mockResolvedValueOnce('work');
    promptSpy.mockResolvedValueOnce('github_pat_ui');

    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;

    const tokenItem = tree.find((n) => n.props?.testID === 'connected-services-action:connect-token');
    await act(async () => {
      await pressTestInstanceAsync(tokenItem);
    });
    await flushHookEffects({ cycles: 1, turns: 3 });

    expect(promptSpy).toHaveBeenCalledTimes(2);
    expect(promptSpy.mock.calls[1]?.[2]).toEqual(expect.objectContaining({
      inputType: 'secure-text',
    }));
    expect(storeCredentialSpy).toHaveBeenCalledTimes(1);
  });

  it('uses descriptor token prompt metadata for GitHub PAT input', async () => {
    connectedServicesModuleState.searchParams = { serviceId: 'github' };
    promptSpy.mockReset();
    promptSpy.mockResolvedValueOnce('work');
    promptSpy.mockResolvedValueOnce('github_pat_descriptor');

    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;

    const tokenItem = tree.find((n) => n.props?.testID === 'connected-services-action:connect-token');
    await act(async () => {
      await pressTestInstanceAsync(tokenItem);
    });
    await flushHookEffects({ cycles: 1, turns: 3 });

    expect(promptSpy.mock.calls[1]?.[0]).toBe('Descriptor GitHub PAT title');
  });

  it('prompts for Bitbucket email before storing API-token credentials', async () => {
    connectedServicesModuleState.searchParams = { serviceId: 'bitbucket' };
    promptSpy.mockReset();
    storeCredentialSpy.mockReset();
    promptSpy.mockResolvedValueOnce('work');
    promptSpy.mockResolvedValueOnce('dev@example.com');
    promptSpy.mockResolvedValueOnce('bb-token');

    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;

    const tokenItem = tree.find((n) => n.props?.testID === 'connected-services-action:connect-token');
    await act(async () => {
      await pressTestInstanceAsync(tokenItem);
    });
    await flushHookEffects({ cycles: 1, turns: 3 });

    expect(promptSpy.mock.calls[1]?.[0]).toBe('Bitbucket email title');
    expect(promptSpy.mock.calls[2]?.[0]).toBe('Bitbucket token title');
    expect(storeCredentialSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      serviceId: 'bitbucket',
      profileId: 'work',
      record: expect.objectContaining({
        serviceId: 'bitbucket',
        token: expect.objectContaining({
          token: 'bb-token',
          providerEmail: 'dev@example.com',
        }),
      }),
    }));
  });
});
