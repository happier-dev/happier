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

const promptSpy = vi.fn(async () => 'work/bad');
const alertSpy = vi.fn(async () => {});
vi.mock('@/modal', () => ({
  Modal: {
    prompt: promptSpy,
    alert: alertSpy,
    confirm: vi.fn(async () => false),
  },
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => (featureId === 'connectedServices.quotas' ? false : true),
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

vi.mock('@/sync/api/account/apiConnectedServicesV2', () => ({
  deleteConnectedServiceCredential: vi.fn(async () => {}),
  registerConnectedServiceCredentialSealed: vi.fn(async () => {}),
}));

describe('ConnectedServiceDetailView profile id validation', () => {
  it('rejects invalid profile ids before navigating to oauth connect', async () => {
    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');

    let tree!: renderer.ReactTestRenderer;
    await act(async () => {
      tree = renderer.create(<ConnectedServiceDetailView />);
    });

    const add = tree.root.find((n) => n.props?.title === 'Add OAuth profile');
    await act(async () => {
      await add.props.onPress?.();
    });

    expect(alertSpy).toHaveBeenCalled();
    expect(pushSpy).not.toHaveBeenCalled();
  });
});
