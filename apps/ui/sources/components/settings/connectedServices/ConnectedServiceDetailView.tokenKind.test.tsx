import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { pressTestInstanceAsync, renderScreen } from '@/dev/testkit';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const backSpy = vi.fn();
const promptSpy = vi.fn<() => Promise<string | null>>(async () => null);
const alertSpy = vi.fn(async () => {});
const storeCredentialSpy = vi.fn(async () => {});
const applySettingsSpy = vi.fn(async () => {});

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const routerMock = createExpoRouterMock({
        router: { back: backSpy, push: vi.fn() },
        params: { serviceId: 'claude-subscription' },
    });
    return routerMock.module;
});

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } }),
}));

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
        spies: {
            prompt: promptSpy,
            alert: alertSpy,
            confirm: vi.fn(async () => false),
        },
    }).module;
});

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
    backSpy.mockReset();
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
    expect(backSpy).not.toHaveBeenCalled();
  });

  it('uses setup-token copy for claude-subscription', async () => {
    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;

    const tokenItem = tree.find((n) => n.props?.testID === 'connected-services-action:connect-token');
    expect(tokenItem.props.title).toBe('Connect setup-token');
  });
});
