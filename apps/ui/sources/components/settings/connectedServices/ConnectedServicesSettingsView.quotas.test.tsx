import React from 'react';
import renderer from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ConnectedServiceQuotaSnapshotV1Schema,
  ConnectedServicesProviderStateSharingSettingsV1Schema,
} from '@happier-dev/protocol';
import {
  connectedServicesModuleState,
  installConnectedServicesCommonModuleMocks,
} from './connectedServicesTestHelpers';
import { AGENT_IDS, getAgentCore, type AgentId } from '@/agents/catalog/catalog';
import type { fetchAccountEncryptionMode } from '@/sync/api/account/apiAccountEncryptionMode';
import type { getConnectedServiceQuotaSnapshotSealed } from '@/sync/api/account/apiConnectedServicesQuotasV2';
import type { getConnectedServiceQuotaSnapshotPlain } from '@/sync/api/account/apiConnectedServicesQuotasV3';
import { flushHookEffects, renderScreen } from '@/dev/testkit';


(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { modalAlertSpy, modalConfirmSpy } = vi.hoisted(() => ({
  modalAlertSpy: vi.fn(async () => undefined),
  modalConfirmSpy: vi.fn(async () => true),
}));

installConnectedServicesCommonModuleMocks({
  modal: async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({
      spies: {
        alert: modalAlertSpy,
        confirm: modalConfirmSpy,
      },
    }).module;
  },
});

const stableCredentials = { token: 't', secret: Buffer.from(new Uint8Array(32).fill(3)).toString('base64url') } as const;
vi.mock('@/auth/context/AuthContext', () => ({
  useAuth: () => ({ credentials: stableCredentials }),
}));

const useFeatureEnabledSpy = vi.fn((_featureId: string) => true);
vi.mock('@/hooks/server/useFeatureEnabled', () => ({
  useFeatureEnabled: (featureId: string) => useFeatureEnabledSpy(featureId),
}));

vi.mock('@/hooks/server/useActiveServerSnapshot', () => ({
  useActiveServerSnapshot: () => ({
    serverId: 'server-a',
    serverUrl: 'https://server-a.example.test',
    generation: 1,
  }),
}));

vi.mock('@/sync/domains/features/featureDecisionRuntime', () => ({
  useServerFeaturesRuntimeSnapshot: () => ({
    status: 'ready',
    features: {
      capabilities: {
        connectedServices: {
          credentialDelete: { revisionGuard: true },
        },
      },
    },
  }),
}));

vi.mock('@/sync/ops/connectedAccounts/connectedAccountDaemon', () => ({
  runConnectedAccountControlCommand: vi.fn(async () => ({
    status: 'described',
    service: {
      pluginId: 'happier.agent.claude',
      localId: 'anthropic',
    },
    operationTransport: {
      kind: 'legacy',
      peerClass: 'revisioned_v2_v3',
      serviceId: 'anthropic',
    },
  })),
}));

const useSettingsSpy = vi.fn(() => ({
  connectedServicesDefaultProfileByServiceId: { anthropic: 'work' },
  connectedServicesProfileLabelByKey: {},
  connectedServicesQuotaPinnedMeterIdsByKey: { 'anthropic/work': ['weekly'] },
  connectedServicesQuotaSummaryStrategyByKey: {},
}));
const useProfileSpy = vi.fn(() => ({
  connectedAccountsV4: [],
  connectedServicesV2: [
    {
      serviceId: 'anthropic',
      profiles: [{ profileId: 'work', status: 'connected', providerEmail: null }],
    },
  ],
}));
const { setSettingMutableSpy } = vi.hoisted(() => ({
  setSettingMutableSpy: vi.fn(),
}));
const { providerStateSharingSetting } = vi.hoisted(() => ({
  providerStateSharingSetting: {
    current: {
      v: 1,
      defaults: { configMode: 'linked', stateMode: 'isolated' },
      byAgentId: {},
      acknowledgedRisksByAgentId: {},
    },
  },
}));

function buildExpectedSharedStateRiskAcknowledgements(): Partial<Record<AgentId, { sharedStatePrivacy: true }>> {
  const acknowledgements: Partial<Record<AgentId, { sharedStatePrivacy: true }>> = {};
  for (const agentId of AGENT_IDS) {
    const stateCapability = getAgentCore(agentId).connectedServices?.providerStateSharing?.state;
    if (
      stateCapability?.supported === true
      && stateCapability.modes.includes('shared')
      && stateCapability.sharedStatePrivacyRiskAcknowledgementRequired === true
    ) {
      acknowledgements[agentId] = { sharedStatePrivacy: true };
    }
  }
  return acknowledgements;
}

vi.mock('@/sync/store/hooks', () => ({
  useAllMachines: () => [{ id: 'machine-a', active: true }],
  useProfile: () => useProfileSpy(),
  useSettings: () => useSettingsSpy(),
  useLocalSetting: () => 1,
  useSettingMutable: (name: string) => [
    name === 'connectedServicesProviderStateSharingSettingsV1'
      ? providerStateSharingSetting.current
      : undefined,
    setSettingMutableSpy,
  ],
}));

const {
  fetchAccountEncryptionModeSpy,
  getConnectedServiceQuotaSnapshotPlainSpy,
  getConnectedServiceQuotaSnapshotSealedSpy,
} = vi.hoisted(() => ({
  fetchAccountEncryptionModeSpy: vi.fn<
    (...args: Parameters<typeof fetchAccountEncryptionMode>) => ReturnType<typeof fetchAccountEncryptionMode>
  >(async () => ({ mode: 'e2ee' as const, updatedAt: 0 })),
  getConnectedServiceQuotaSnapshotPlainSpy: vi.fn<
    (...args: Parameters<typeof getConnectedServiceQuotaSnapshotPlain>) => ReturnType<typeof getConnectedServiceQuotaSnapshotPlain>
  >(async () => null),
  getConnectedServiceQuotaSnapshotSealedSpy: vi.fn<
    (...args: Parameters<typeof getConnectedServiceQuotaSnapshotSealed>) => ReturnType<typeof getConnectedServiceQuotaSnapshotSealed>
  >(async () => null),
}));
vi.mock('@/sync/api/account/apiAccountEncryptionMode', () => ({
  fetchAccountEncryptionMode: fetchAccountEncryptionModeSpy,
}));
vi.mock('@/sync/api/account/apiConnectedServicesQuotasV2', () => ({
  getConnectedServiceQuotaSnapshotSealed: getConnectedServiceQuotaSnapshotSealedSpy,
}));
vi.mock('@/sync/api/account/apiConnectedServicesQuotasV3', () => ({
  getConnectedServiceQuotaSnapshotPlain: getConnectedServiceQuotaSnapshotPlainSpy,
}));

vi.mock('./ConnectedServicesDefaultAuthRow', () => ({
  ConnectedServicesDefaultAuthRow: (props: any) => React.createElement('ConnectedServicesDefaultAuthRow', props),
}));

describe('ConnectedServicesSettingsView quotas', () => {
  beforeEach(() => {
    setSettingMutableSpy.mockClear();
    modalAlertSpy.mockClear();
    modalConfirmSpy.mockClear();
    connectedServicesModuleState.routerPushSpy.mockClear();
    useProfileSpy.mockReset();
    useProfileSpy.mockReturnValue({
      connectedAccountsV4: [],
      connectedServicesV2: [
        {
          serviceId: 'anthropic',
          profiles: [{ profileId: 'work', status: 'connected', providerEmail: null }],
        },
      ],
    });
    providerStateSharingSetting.current = {
      v: 1,
      defaults: { configMode: 'linked', stateMode: 'isolated' },
      byAgentId: {},
      acknowledgedRisksByAgentId: {},
    };
  });

  it('shows quota badges on service rows when pinned meters exist', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);
    fetchAccountEncryptionModeSpy.mockResolvedValue({ mode: 'plain', updatedAt: 0 });
    const snapshot = ConnectedServiceQuotaSnapshotV1Schema.parse({
      v: 1,
      serviceId: 'anthropic',
      profileId: 'work',
      fetchedAt: 1,
      staleAfterMs: 60_000,
      planLabel: 'Pro',
      accountLabel: null,
      meters: [
        {
          meterId: 'weekly',
          label: 'Weekly',
          used: 82,
          limit: 100,
          unit: 'count',
          utilizationPct: null,
          resetsAt: null,
          status: 'ok',
          details: {},
        },
      ],
    });
    getConnectedServiceQuotaSnapshotPlainSpy.mockResolvedValue(snapshot);

    const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');

    let tree!: renderer.ReactTestRenderer;
    tree = (await renderScreen(<ConnectedServicesSettingsView />)).tree;

    await flushHookEffects({ cycles: 1, turns: 1 });

    expect(tree.findAll((n) => n.props?.testID === 'connected-services-quota-summary-section')).not.toHaveLength(0);
    expect(tree.findAll((n) => n.props?.children === 'Weekly 18%')).not.toHaveLength(0);
  });

  it('updates global provider state sharing settings from connected services controls', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);

    const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');

    const { tree } = await renderScreen(<ConnectedServicesSettingsView />);

    await tree.root.findByProps({ testID: 'connected-services-provider-state-sharing-state-default' }).props.onPress();
    expect(setSettingMutableSpy).toHaveBeenCalledWith({
      v: 1,
      defaults: { configMode: 'linked', stateMode: 'shared' },
      byAgentId: {},
      acknowledgedRisksByAgentId: buildExpectedSharedStateRiskAcknowledgements(),
    });
    expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
  });

  it('selects copied provider config sharing as a distinct mode', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);
    providerStateSharingSetting.current = {
      v: 1,
      defaults: { configMode: 'copied', stateMode: 'isolated' },
      byAgentId: {},
      acknowledgedRisksByAgentId: {},
    };

    const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');

    const { tree } = await renderScreen(<ConnectedServicesSettingsView />);

    const configModeControl = tree.root.findByProps({ selectedId: 'copied' });
    configModeControl.props.onSelect('isolated');

    expect(setSettingMutableSpy).toHaveBeenCalledWith({
      v: 1,
      defaults: { configMode: 'isolated', stateMode: 'isolated' },
      byAgentId: {},
      acknowledgedRisksByAgentId: {},
    });

    configModeControl.props.onSelect('linked');
    expect(setSettingMutableSpy).toHaveBeenCalledWith({
      v: 1,
      defaults: { configMode: 'linked', stateMode: 'isolated' },
      byAgentId: {},
      acknowledgedRisksByAgentId: {},
    });
  });

  it('renders provider state sharing rows from agent capabilities', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);

    const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');

    const { tree } = await renderScreen(<ConnectedServicesSettingsView />);

    expect(tree.root.findByProps({ testID: 'connected-services-provider-state-sharing-backend-overrides' })).toBeTruthy();
    expect(tree.root.findAllByProps({ testID: 'connected-services-provider-state-sharing-agent-codex-state' })).toHaveLength(0);
    expect(tree.root.findAllByProps({ testID: 'connected-services-provider-state-sharing-agent-pi-state' })).toHaveLength(0);
  });

  it('refuses legacy default-auth recovery routing without a projected qualified owner', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);
    useSettingsSpy.mockReturnValue({
      connectedServicesDefaultProfileByServiceId: { anthropic: 'work' },
      connectedServicesProfileLabelByKey: {},
      connectedServicesQuotaPinnedMeterIdsByKey: { 'anthropic/work': [] },
      connectedServicesQuotaSummaryStrategyByKey: {},
    });
    useProfileSpy.mockReturnValue({
      connectedAccountsV4: [],
      connectedServicesV2: [
        {
          serviceId: 'anthropic',
          profiles: [{ profileId: 'work', status: 'needs_reauth', providerEmail: null }],
        },
      ],
    });

    const { ConnectedServicesSettingsView } = await import('./ConnectedServicesSettingsView');
    const { tree } = await renderScreen(<ConnectedServicesSettingsView />);

    await tree.root
      .findAllByType('ConnectedServicesDefaultAuthRow' as any)[0]
      .props.onOpenConnectedServicesSettings('anthropic');

    expect(connectedServicesModuleState.routerPushSpy).not.toHaveBeenCalled();
    expect(modalAlertSpy).toHaveBeenCalledWith(
      'errors.daemonUnavailableTitle',
      'errors.daemonUnavailableBody',
    );
  });

  it('keeps provider state sharing settings available when optional Connected Accounts features are disabled', async () => {
    useFeatureEnabledSpy.mockReturnValue(false);

    const { ConnectedServicesProviderStateSharingSettingsView } = await import('./ConnectedServicesProviderStateSharingSettings');
    const { tree } = await renderScreen(<ConnectedServicesProviderStateSharingSettingsView />);

    expect(tree.toJSON()).not.toBeNull();
    expect(tree.root.findByProps({
      testID: 'connected-services-provider-state-sharing-agent-codex-state',
    })).toBeTruthy();
  });

  it('writes provider state sharing overrides by agent id', async () => {
    useFeatureEnabledSpy.mockReturnValue(true);

    const { ConnectedServicesProviderStateSharingBackendGroups } = await import('./ConnectedServicesProviderStateSharingSettings');

    const { tree } = await renderScreen(
      <ConnectedServicesProviderStateSharingBackendGroups
        settings={ConnectedServicesProviderStateSharingSettingsV1Schema.parse(providerStateSharingSetting.current)}
        setSettings={setSettingMutableSpy}
        agentIds={['codex' as any]}
      />,
    );

    await tree.root
      .findByProps({ testID: 'connected-services-provider-state-sharing-agent-codex-state' })
      .props.onPress();

    expect(setSettingMutableSpy).toHaveBeenCalledWith({
      v: 1,
      defaults: { configMode: 'linked', stateMode: 'isolated' },
      byAgentId: {
        codex: { stateMode: 'shared' },
      },
      acknowledgedRisksByAgentId: {
        codex: { sharedStatePrivacy: true },
      },
    });
    expect(modalConfirmSpy).toHaveBeenCalledTimes(1);
  });
});
