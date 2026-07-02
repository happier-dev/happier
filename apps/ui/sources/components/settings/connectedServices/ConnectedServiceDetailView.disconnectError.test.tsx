import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installConnectedServicesCommonModuleMocks } from './connectedServicesTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const alertSpy = vi.fn(async () => {});
const confirmSpy = vi.fn(async () => true);
const applySettingsSpy = vi.fn(async () => {});

installConnectedServicesCommonModuleMocks({
    searchParams: { serviceId: 'claude-subscription' },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock({
            spies: {
                prompt: vi.fn(async () => null),
                alert: alertSpy,
                alertAsync: vi.fn(async () => {}),
                confirm: confirmSpy,
            },
        }).module;
    },
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

vi.mock('@/sync/store/settingsWriters', () => ({
  useApplySettings: () => applySettingsSpy,
}));

function createConnectedServiceApiError(code: string): Error & { code: string; status: number } {
  const error = new Error(code) as Error & { code: string; status: number };
  error.code = code;
  error.status = 409;
  return error;
}

const deleteSpy = vi.fn(async () => {});
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
  it('confirms and retries cleanup when the server reports a group reference', async () => {
    const { ConnectedServiceDetailView } = await import('./ConnectedServiceDetailView');
    deleteSpy.mockRejectedValueOnce(createConnectedServiceApiError('connect_credential_referenced_by_group'));

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;

    const actionHosts = tree.findAllByType('ItemRowActions' as any);
    expect(actionHosts.length).toBeGreaterThan(0);
    const actions = actionHosts[0]?.props?.actions as Array<any>;
    const disconnect = actions.find((a) => a?.id === 'disconnect');
    expect(typeof disconnect?.onPress).toBe('function');

    await act(async () => {
      await disconnect.onPress();
    });

    expect(confirmSpy).toHaveBeenCalled();
    expect(confirmSpy).toHaveBeenCalledWith(
      'modals.disconnect',
      'connectedServices.errors.credentialReferencedByGroup',
      expect.objectContaining({ confirmText: 'modals.disconnect' }),
    );
    expect(deleteSpy).toHaveBeenCalledTimes(2);
    expect(deleteSpy).toHaveBeenLastCalledWith(
      expect.objectContaining({ token: 't' }),
      { serviceId: 'claude-subscription', profileId: 'work', cleanupGroupReferences: true },
    );
    expect(alertSpy).not.toHaveBeenCalled();
  });
});
