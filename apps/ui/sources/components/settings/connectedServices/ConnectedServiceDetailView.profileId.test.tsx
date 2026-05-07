import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';
import {
    connectedServicesModuleState,
    installConnectedServicesCommonModuleMocks,
} from './connectedServicesTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } }),
}));

const promptSpy = vi.fn(async () => 'work/bad');
const alertSpy = vi.fn(async () => {});
const applySettingsSpy = vi.fn(async () => {});
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
    searchParams: { serviceId: 'openai-codex' },
});

vi.mock('@/sync/store/settingsWriters', () => ({
  useApplySettings: () => applySettingsSpy,
}));

let connectedServicesEnabled = true;
let quotasEnabled = false;
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => {
    if (featureId === 'connectedServices') return connectedServicesEnabled;
    if (featureId === 'connectedServices.quotas') return quotasEnabled;
    return true;
  },
}));

vi.mock('@/sync/store/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/sync/store/hooks')>('@/sync/store/hooks');
  return {
    ...actual,
    useProfile: () => ({
      connectedServicesV2: [
        {
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'work', status: 'connected', providerEmail: null }],
        },
      ],
    }),
    useSettings: () => ({
      connectedServicesDefaultProfileByServiceId: { 'openai-codex': 'work' },
      connectedServicesProfileLabelByKey: {},
      connectedServicesQuotaPinnedMeterIdsByKey: {},
      connectedServicesQuotaSummaryStrategyByKey: {},
    }),
  };
});

vi.mock('@/sync/sync', () => ({
  sync: { refreshProfile: vi.fn(async () => {}), applySettings: vi.fn(async () => {}) },
}));

vi.mock('@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount', () => ({
  storeConnectedServiceCredentialForAccount: vi.fn(async () => {}),
  deleteConnectedServiceCredentialForAccount: vi.fn(async () => {}),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => {
  const React = require('react');
  return {
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props, props.children),
  };
});

describe('ConnectedServiceDetailView profile id validation', () => {
  beforeEach(() => {
    connectedServicesModuleState.routerBackSpy.mockClear();
    connectedServicesModuleState.routerPushSpy.mockClear();
    promptSpy.mockClear();
    alertSpy.mockClear();
    applySettingsSpy.mockClear();
    connectedServicesEnabled = true;
    quotasEnabled = false;
  });

  it('rejects invalid profile ids before navigating to oauth connect', async () => {
    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;

    const add = tree.find((n) => n.props?.testID === 'connected-services-action:add-oauth-profile-device');
    await act(async () => {
      await pressTestInstanceAsync(add);
    });

    expect(alertSpy).toHaveBeenCalled();
    expect(connectedServicesModuleState.routerPushSpy).not.toHaveBeenCalled();
  });

  it('shows a fallback alert when routing to oauth connect fails', async () => {
    promptSpy.mockResolvedValueOnce('work');
    connectedServicesModuleState.routerPushSpy.mockImplementationOnce(() => {
      throw new Error('route failed');
    });

    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;

    const add = tree.find((n) => n.props?.testID === 'connected-services-action:add-oauth-profile-device');
    await act(async () => {
      await pressTestInstanceAsync(add);
    });

    expect(connectedServicesModuleState.routerPushSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/settings/connected-services/oauth',
        params: expect.objectContaining({
          serviceId: 'openai-codex',
          profileId: 'work',
          method: 'device',
        }),
      }),
    );
    expect(alertSpy).toHaveBeenCalled();
  });

  it('does not violate hooks order when feature state changes between renders', async () => {
    connectedServicesEnabled = false;

    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
    const Inner = (ConnectedServiceDetailView as unknown as { type: React.ComponentType<Record<string, never>> }).type;

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<Inner />)).tree;

    connectedServicesEnabled = true;
    await act(async () => {
      tree.update(<Inner />);
    });

    expect(tree.root).toBeDefined();
  });
});
