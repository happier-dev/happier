import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import {
    connectedServicesModuleState,
    installConnectedServicesCommonModuleMocks,
} from './connectedServicesTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const promptSpy = vi.fn<() => Promise<string | null>>(async () => null);
const alertSpy = vi.fn(async () => {});
const storeCredentialSpy = vi.fn(async () => {});
const applySettingsSpy = vi.fn(async () => {});
const openExternalUrlSpy = vi.fn(async (_url: string) => true);
const activeServiceState = { serviceId: 'claude-subscription' as 'claude-subscription' | 'github' };
installConnectedServicesCommonModuleMocks({
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                prompt: promptSpy,
                alert: alertSpy,
                confirm: vi.fn(async () => false),
            },
        }).module;
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key) =>
                key === 'connectedServices.detail.connectSetupTokenTitle'
                    ? 'Connect setup-token'
                    : key === 'connectedServices.detail.connectAccessTokenTitle'
                        ? 'Connect access token'
                        : key === 'connectedServices.detail.openGithubTokenTemplateTitle'
                            ? 'Create GitHub token'
                        : key,
        });
    },
    searchParams: { serviceId: 'claude-subscription' },
});

vi.mock('@/utils/url/openExternalUrl', () => ({
  openExternalUrl: (url: string) => openExternalUrlSpy(url),
}));

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
          serviceId: activeServiceState.serviceId,
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

vi.mock('@/components/ui/lists/ItemRowActions', () => {
  const React = require('react');
  return {
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props, props.children),
  };
});

describe('ConnectedServiceDetailView token kind copy', () => {
  it('keeps user on detail page after setup-token is saved', async () => {
    activeServiceState.serviceId = 'claude-subscription';
    connectedServicesModuleState.searchParams = { serviceId: 'claude-subscription' };
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

    expect(storeCredentialSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalled();
    expect(connectedServicesModuleState.routerBackSpy).not.toHaveBeenCalled();
  });

  it('uses setup-token copy for claude-subscription', async () => {
    activeServiceState.serviceId = 'claude-subscription';
    connectedServicesModuleState.searchParams = { serviceId: 'claude-subscription' };
    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;

    const tokenItem = tree.find((n) => n.props?.testID === 'connected-services-action:connect-token');
    expect(tokenItem.props.title).toBe('Connect setup-token');
  });

  it('uses access-token copy for github', async () => {
    activeServiceState.serviceId = 'github';
    connectedServicesModuleState.searchParams = { serviceId: 'github' };
    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;

    const tokenItem = tree.find((n) => n.props?.testID === 'connected-services-action:connect-token');
    expect(tokenItem.props.title).toBe('Connect access token');
  });

  it('opens the GitHub fine-grained token template for github', async () => {
    activeServiceState.serviceId = 'github';
    connectedServicesModuleState.searchParams = { serviceId: 'github' };
    openExternalUrlSpy.mockClear();
    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    const { tree } = await renderScreen(<ConnectedServiceDetailView />);

    const tokenTemplateItem = tree.find((n) => n.props?.testID === 'connected-services-action:open-github-token-template');
    expect(tokenTemplateItem.props.title).toBe('Create GitHub token');
    await act(async () => {
      await pressTestInstanceAsync(tokenTemplateItem);
    });

    expect(openExternalUrlSpy).toHaveBeenCalledTimes(1);
    const url = new URL(String(openExternalUrlSpy.mock.calls[0]?.[0] ?? ''));
    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe('/settings/personal-access-tokens/new');
    expect(url.searchParams.get('contents')).toBe('write');
    expect(url.searchParams.get('pull_requests')).toBe('write');
    expect(url.searchParams.get('administration')).toBe('write');
  });

  it('does not show the GitHub token template for non-GitHub token services', async () => {
    activeServiceState.serviceId = 'claude-subscription';
    connectedServicesModuleState.searchParams = { serviceId: 'claude-subscription' };
    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    const { tree } = await renderScreen(<ConnectedServiceDetailView />);

    const tokenTemplateItems = tree.root.findAll((n) => n.props?.testID === 'connected-services-action:open-github-token-template');
    expect(tokenTemplateItems).toHaveLength(0);
  });
});
