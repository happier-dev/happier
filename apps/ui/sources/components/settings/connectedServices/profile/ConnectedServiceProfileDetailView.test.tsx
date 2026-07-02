import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { installConnectedServicesCommonModuleMocks } from '../connectedServicesTestHelpers';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const applySettingsSpy = vi.fn(async () => {});
const confirmSpy = vi.fn(async () => true);
const alertSpy = vi.fn(async () => {});
const routeParams = { serviceId: 'openai-codex', profileId: 'work' };
const profileState: { connectedServicesV2: Array<Record<string, unknown>> } = {
  connectedServicesV2: [
    {
      serviceId: 'openai-codex',
      profiles: [{ profileId: 'work', status: 'connected', providerEmail: 'me@example.com', providerAccountId: 'acct-1' }],
      groups: [],
    },
  ],
};

installConnectedServicesCommonModuleMocks({
  searchParams: routeParams,
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
      spies: {
        alert: alertSpy,
        confirm: confirmSpy,
      },
    }).module;
  },
});

const stableCredentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as const;
vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: stableCredentials }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) =>
    featureId === 'connectedServices.quotas'
    || featureId === 'connectedServices.accountGroups'
    || featureId === 'connectedServices',
}));

vi.mock('@/sync/store/hooks', async () => {
  const actual = await vi.importActual<typeof import('@/sync/store/hooks')>('@/sync/store/hooks');
  return {
    ...actual,
    useProfile: () => profileState,
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

vi.mock('@/sync/store/settingsWriters', () => ({
  useApplySettings: () => applySettingsSpy,
}));

const deleteCredentialSpy = vi.fn(async () => {});
vi.mock('@/sync/domains/connectedServices/storeConnectedServiceCredentialForAccount', () => ({
  storeConnectedServiceCredentialForAccount: vi.fn(async () => {}),
  deleteConnectedServiceCredentialForAccount: deleteCredentialSpy,
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
  fetchAccountEncryptionMode: vi.fn(async () => ({ mode: 'e2ee', updatedAt: 0 })),
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({
  getConnectedServiceQuotaSnapshotSealed: vi.fn(async () => null),
  requestConnectedServiceQuotaSnapshotRefresh: vi.fn(async () => true),
}));

vi.mock('@/sync/api/account/apiConnectedServicesQuotasV3', () => ({
  getConnectedServiceQuotaSnapshotPlain: vi.fn(async () => null),
  requestConnectedServiceQuotaSnapshotRefreshV3: vi.fn(async () => true),
}));

vi.mock('@/components/ui/lists/ItemRowActions', () => {
  const React = require('react');
  return {
    ItemRowActions: (props: any) => React.createElement('ItemRowActions', props, props.children),
  };
});

describe('ConnectedServiceProfileDetailView', () => {
  beforeEach(() => {
    routeParams.serviceId = 'openai-codex';
    routeParams.profileId = 'work';
    profileState.connectedServicesV2 = [
      {
        serviceId: 'openai-codex',
        profiles: [{ profileId: 'work', status: 'connected', providerEmail: 'me@example.com', providerAccountId: 'acct-1' }],
        groups: [],
      },
    ];
    applySettingsSpy.mockClear();
    confirmSpy.mockClear();
    alertSpy.mockClear();
    deleteCredentialSpy.mockClear();
  });

    it('renders profile details and quota card when quotas are enabled', async () => {
        const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');
        const { t } = await import('@/text');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ConnectedServiceProfileDetailView />)).tree;

        expect(
            tree.findAll((n) =>
                n.props?.title === t('connectedServices.profile.email') &&
                n.props?.subtitle === 'me@example.com',
            ),
        ).toHaveLength(1);
        expect(
            tree.findAll((n) =>
                n.props?.title === t('connectedServices.profile.quotaTitle') ||
                n.props?.title === 'Refresh',
            ),
        ).not.toHaveLength(0);
    });

    it('renders an unknown-profile guard state for nonexistent profile ids', async () => {
        routeParams.profileId = 'missing';
        const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');
        const { t } = await import('@/text');

        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ConnectedServiceProfileDetailView />)).tree;

    expect(tree.findAll((n) => n.props?.title === t('connectedServices.detail.alerts.unknownProfileTitle'))).toHaveLength(1);
    expect(tree.findAll((n) => n.props?.title === t('connectedServices.detail.actionsGroupTitle'))).toHaveLength(0);
    expect(applySettingsSpy).not.toHaveBeenCalled();
  });

    it('warns before disconnecting a profile that belongs to account groups', async () => {
        profileState.connectedServicesV2 = [
            {
                serviceId: 'openai-codex',
                profiles: [{ profileId: 'work', status: 'connected', providerEmail: 'me@example.com', providerAccountId: 'acct-1' }],
                groups: [
                    {
                        groupId: 'primary',
                        displayName: 'Primary Pool',
                        memberProfileIds: ['work'],
                    },
                ],
            },
        ];
        const { ConnectedServiceProfileDetailView } = await import('./ConnectedServiceProfileDetailView');

        const tree = (await renderScreen(<ConnectedServiceProfileDetailView />)).tree;
        const disconnectItem = tree.root
            .findAll((node) => node.props?.title === 'modals.disconnect')
            .find((node) => typeof node.props?.onPress === 'function');

        await act(async () => {
            disconnectItem?.props.onPress();
        });

        expect(confirmSpy).toHaveBeenCalledWith(
            'modals.disconnect',
            'connectedServices.detail.disconnectGroupCleanupConfirmBody',
            expect.objectContaining({ confirmText: 'modals.disconnect' }),
        );
        expect(deleteCredentialSpy).toHaveBeenCalledWith(
            expect.objectContaining({ token: 't' }),
            { serviceId: 'openai-codex', profileId: 'work', cleanupGroupReferences: true },
        );
    });
});
