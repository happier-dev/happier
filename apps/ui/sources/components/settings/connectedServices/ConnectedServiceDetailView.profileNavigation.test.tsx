import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const backSpy = vi.fn();
const pushSpy = vi.fn();

vi.mock('expo-router', () => ({
  useRouter: () => ({ back: backSpy, push: pushSpy }),
  useLocalSearchParams: () => ({ serviceId: 'openai-codex' }),
}));

vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } }),
}));

vi.mock('@/modal', () => ({
  Modal: {
    prompt: vi.fn(async () => null),
    alert: vi.fn(async () => {}),
    confirm: vi.fn(async () => false),
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
          serviceId: 'openai-codex',
          profiles: [{ profileId: 'work', status: 'connected', providerEmail: 'me@example.com' }],
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

describe('ConnectedServiceDetailView profile navigation', () => {
  it('opens profile detail when a profile row is pressed', async () => {
    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<ConnectedServiceDetailView />);
    });

    const candidates = tree.root.findAll((n) => n.props?.title === 'work' && typeof n.props?.onPress === 'function');
    expect(candidates).toHaveLength(1);
    const profileItem = candidates[0]!;
    await act(async () => {
      await profileItem.props.onPress?.();
    });

    expect(pushSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        pathname: '/(app)/settings/connected-services/profile',
        params: expect.objectContaining({ serviceId: 'openai-codex', profileId: 'work' }),
      }),
    );
  });
});
