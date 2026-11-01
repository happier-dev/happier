import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import {
  installConnectedServiceDetailShellMocks,
  installConnectedServicesCommonModuleMocks,
} from './connectedServicesTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const {
  alertSpy,
  confirmSpy,
  applySettingsSpy,
  deleteSpy,
  refreshProfileSpy,
  disabledFeatureIds,
} = vi.hoisted(() => ({
  alertSpy: vi.fn(async () => {}),
  confirmSpy: vi.fn(async () => true),
  applySettingsSpy: vi.fn(async () => {}),
  deleteSpy: vi.fn(async () => {
    throw {
      code: 'connect_credential_mutation_superseded',
      status: 409,
    };
  }),
  refreshProfileSpy: vi.fn(async () => {}),
  disabledFeatureIds: new Set(['connectedServices.accountGroups', 'connectedServices.quotas']),
}));

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
installConnectedServiceDetailShellMocks();

vi.mock('@react-navigation/native', () => ({
  useIsFocused: () => true,
}));

vi.mock('@/auth/context/AuthContext', () => {
  // AuthContext retains credentials until the account changes; an object per
  // render spuriously retires and reattaches the real quota subscription.
  const credentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') };
  return { useAuth: () => ({ credentials }) };
});

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => !disabledFeatureIds.has(featureId),
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
      connectedServiceCredentialRevisionsV1: [
        {
          serviceId: 'claude-subscription',
          profileId: 'work',
          credentialRevision: 'csr_0123456789ABCDEFGHJKMNPQRS',
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
  sync: { refreshProfile: refreshProfileSpy, applySettings: vi.fn(async () => {}) },
}));

vi.mock('@/sync/store/settingsWriters', () => ({
  useApplySettings: () => applySettingsSpy,
}));

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
    tree = (await renderScreen(<ConnectedServiceDetailView />)).tree;

    const actionHosts = tree.findAllByType('ItemRowActions' as any);
    expect(actionHosts.length).toBeGreaterThan(0);
    const actions = actionHosts[0]?.props?.actions as Array<any>;
    const disconnect = actions.find((a) => a?.id === 'disconnect');
    expect(typeof disconnect?.onPress).toBe('function');

    await disconnect.onPress();

    expect(confirmSpy).toHaveBeenCalled();
    expect(deleteSpy).toHaveBeenCalled();
    expect(refreshProfileSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalled();
  });
});
