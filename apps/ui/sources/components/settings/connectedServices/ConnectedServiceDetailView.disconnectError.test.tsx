import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const alertSpy = vi.fn(async () => {});
const confirmSpy = vi.fn(async () => true);

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: vi.fn(), push: vi.fn() }),
  useLocalSearchParams: () => ({ serviceId: 'claude-subscription' }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } }),
}));

vi.mock('@/modal', () => ({
  Modal: {
    prompt: vi.fn(async () => null),
    alert: alertSpy,
    alertAsync: vi.fn(async () => {}),
    confirm: confirmSpy,
  },
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
          profiles: [{ profileId: 'work', status: 'connected', providerEmail: null }],
        },
      ],
    }),
    useSettings: () => ({
      connectedServicesDefaultProfileByServiceId: { 'claude-subscription': 'work' },
      connectedServicesProfileLabelByKey: {},
      connectedServicesQuotaPinnedMeterIdsByKey: {},
      connectedServicesQuotaSummaryStrategyByKey: {},
    }),
  };
});

vi.mock('@/sync/sync', () => ({
  sync: { refreshProfile: vi.fn(async () => {}), applySettings: vi.fn(async () => {}) },
}));

const deleteSpy = vi.fn(async () => {
  throw new Error('boom');
});
vi.mock('@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount', () => ({
  storeConnectedServiceCredentialForAccount: vi.fn(async () => {}),
  deleteConnectedServiceCredentialForAccount: deleteSpy,
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => {
  const React = require('react');
  return {
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props, props.children),
  };
});

describe('ConnectedServiceDetailView disconnect error handling', () => {
  it('shows an alert instead of throwing when disconnect fails', async () => {
    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<ConnectedServiceDetailView />);
    });

    const actionHosts = tree.root.findAllByType('ItemRowActions' as any);
    expect(actionHosts.length).toBeGreaterThan(0);
    const actions = actionHosts[0]?.props?.actions as Array<any>;
    const disconnect = actions.find((a) => a?.id === 'disconnect');
    expect(typeof disconnect?.onPress).toBe('function');

    await act(async () => {
      await disconnect.onPress();
    });

    expect(confirmSpy).toHaveBeenCalled();
    expect(deleteSpy).toHaveBeenCalled();
    expect(alertSpy).toHaveBeenCalled();
  });
});

